// data-fetcher.js
/**
 * Dota Social Feed – data.json updater (for GitHub Actions or local use)
 * - Uses Node 18+ native fetch (no deps)
 * - Mirrors your frontend’s logic: profiles, recent matches, recent28, heroStats
 * - Computes the same “facts” your UI shows so render is instant
 * - Builds an Immortal meta snapshot (top high-MMR picks) from heroStats
 * - Skips a player cleanly if OpenDota returns 404/empty
 */

const fs = require("fs");
const path = require("path");

// ---------- Config (matches your HTML) ----------
const IDS = [39984287, 50423134, 53635813, 86890516, 26467713, 81305221, 27081071];
const VALID_GAME_MODES = [1, 2, 3, 4, 22];
const VALID_LOBBY_TYPES = [0, 7];
const IMMORTAL_HIGHLIGHT_MIN_MATCHES = 200;

// throttle / retry similar to your page
const RATE_DELAY_OK = 260;
const RATE_DELAY_429 = 1500;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const API = {
  heroes: () => j(`${BASE}/heroStats`),
  profile: (id) => j(`${BASE}/players/${id}`),
  recent: (id) => j(`${BASE}/players/${id}/recentMatches?limit=30`),
  recent28: (id) => j(`${BASE}/players/${id}/matches?date=28`),
  heroesAllTime: (id) => j(`${BASE}/players/${id}/heroes`)
};

const BASE = "https://api.opendota.com/api";
const OUT = path.resolve("./data.json");

// ---------- tiny throttle ----------
function createThrottle(interval) {
  let last = 0;
  let chain = Promise.resolve();
  return (task) => {
    const run = chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, last + interval - now);
      if (wait) await sleep(wait);
      const res = await task();
      last = Date.now();
      return res;
    });
    chain = run.catch(() => {});
    return run;
  };
}
const schedule = createThrottle(70);

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(url, { retries = 3 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const attemptNo = attempt + 1;
      console.log(`[fetch] ${url} (attempt ${attemptNo})`);
      const res = await schedule(() => fetch(url));
      const rateRemaining =
        res.headers.get("x-ratelimit-remaining") ||
        res.headers.get("x-rate-limit-remaining");
      const rateReset =
        res.headers.get("x-ratelimit-reset") || res.headers.get("x-rate-limit-reset");
      if (!res.ok) {
        const { status } = res;
        if (attempt < retries && (RETRY_STATUSES.has(status) || status === 408)) {
          if (status === 429) {
            console.warn(
              `[fetch] ${url} -> 429 (rate limited). Remaining=${rateRemaining ?? "?"} reset=${rateReset ?? "?"}`
            );
          } else {
            console.warn(`[fetch] ${url} -> ${status}. Retrying soon…`);
          }
          await sleep(status === 429 ? RATE_DELAY_429 : RATE_DELAY_OK);
          attempt++;
          continue;
        }
        if (status === 404) {
          console.warn(`[fetch] ${url} -> 404 (not found). Skipping.`);
          return null; // treat missing as “skip”
        }
        const bodyPreview = await res.text().catch(() => "<no body>");
        console.error(
          `[fetch] ${url} failed with status ${status}. Remaining=${rateRemaining ?? "?"} reset=${rateReset ?? "?"}. Body: ${bodyPreview.slice(
            0,
            200
          )}`
        );
        throw new Error(`Bad status ${status} for ${url}`);
      }
      const json = await res.json();
      if (rateRemaining !== null) {
        console.log(`[fetch] ${url} ✓ remaining=${rateRemaining} reset=${rateReset ?? "?"}`);
      }
      return json;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[fetch] ${url} error: ${err.message}. Retrying (${attempt + 1}/${retries})…`);
        await sleep(RATE_DELAY_OK);
        attempt++;
        continue;
      }
      console.error(`[fetch] ${url} failed after ${attempt + 1} attempts:`, err);
      throw err;
    }
  }
}

const isWin = (m) =>
  (m.player_slot < 128 && m.radiant_win) || (m.player_slot >= 128 && !m.radiant_win);

function filterRealGames(list) {
  return (list || []).filter(
    (m) =>
      VALID_GAME_MODES.includes(m.game_mode) &&
      VALID_LOBBY_TYPES.includes(m.lobby_type) &&
      (m.duration || 0) > 300 &&
      (m.leaver_status || 0) === 0
  );
}

function buildFacts(matches = [], recent28 = []) {
  const games = filterRealGames(matches);
  const total = games.length;
  const wins = games.filter(isWin).length;
  const kills = games.reduce((a, m) => a + (m.kills || 0), 0);
  const deaths = games.reduce((a, m) => a + (m.deaths || 0), 0);
  const assists = games.reduce((a, m) => a + (m.assists || 0), 0);
  const kda = (kills + assists) / Math.max(1, deaths);
  const gpm = total ? games.reduce((a, m) => a + (m.gold_per_min || 0), 0) / total : 0;
  const xpm = total ? games.reduce((a, m) => a + (m.xp_per_min || 0), 0) / total : 0;

  const pingSamples = games
    .map((m) => Number(m.pings))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const avgPings =
    pingSamples.length > 0
      ? pingSamples.reduce((s, v) => s + v, 0) / pingSamples.length
      : null;

  const heroCount = new Map();
  games.forEach((m) => heroCount.set(m.hero_id, (heroCount.get(m.hero_id) || 0) + 1));
  const topHeroes = [...heroCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id, count]) => ({ id, count }));

  return {
    wins,
    total,
    winRate: total ? wins / total : 0,
    kills,
    deaths,
    assists,
    kda,
    gpm,
    xpm,
    avgPings,
    uniqueHeroes: heroCount.size,
    recentCount: filterRealGames(recent28).length,
    topHeroes
  };
}

function buildRecentHeroStats(matches, limit = 20) {
  const ordered = filterRealGames(matches)
    .slice()
    .sort((a, b) => (b.start_time || 0) - (a.start_time || 0))
    .slice(0, limit);
  const stats = new Map();
  for (const m of ordered) {
    const id = Number(m.hero_id);
    if (!Number.isFinite(id)) continue;
    const entry = stats.get(id) || { hero_id: id, games: 0, win: 0, last_played: 0 };
    entry.games += 1;
    entry.win += isWin(m) ? 1 : 0;
    entry.last_played = Math.max(entry.last_played, m.start_time || 0);
    stats.set(id, entry);
  }
  return [...stats.values()];
}

function buildProMetaSnapshot(heroStats) {
  const heroes = (heroStats || [])
    .map((h) => {
      const id = Number(h.id);
      const immortal_pick = Number(h["8_pick"]) || 0;
      const immortal_win = Number(h["8_win"]) || 0;
      if (!Number.isFinite(id) || immortal_pick <= 0) return null;
      return { hero_id: id, immortal_pick, immortal_win, source: "immortal" };
    })
    .filter(Boolean)
    .sort((a, b) => (b.immortal_pick || 0) - (a.immortal_pick || 0))
    .slice(0, 30);

  const pickTotal = heroes.reduce((s, x) => s + (x.immortal_pick || 0), 0);
  const winTotal = heroes.reduce((s, x) => s + (x.immortal_win || 0), 0);

  const highlight =
    heroes
      .filter((x) => (x.immortal_pick || 0) >= IMMORTAL_HIGHLIGHT_MIN_MATCHES)
      .sort((a, b) =>
        (b.immortal_pick ? (b.immortal_win || 0) / b.immortal_pick : 0) -
        (a.immortal_pick ? (a.immortal_win || 0) / a.immortal_pick : 0)
      )[0] ||
    heroes.find((x) => (x.immortal_pick || 0) > 0) ||
    null;

  return {
    timestamp: Date.now(),
    heroes,
    highlight: highlight
      ? {
          hero_id: highlight.hero_id,
          immortal_pick: highlight.immortal_pick,
          immortal_win: highlight.immortal_win,
          winRate: highlight.immortal_pick
            ? (highlight.immortal_win || 0) / highlight.immortal_pick
            : 0,
          source: highlight.source
        }
      : null,
    summary: { pickTotal, winTotal }
  };
}

// ---------- main ----------
(async function run() {
  const started = Date.now();
  let apiCalls = 0;

  let previous = null;
  try {
    if (fs.existsSync(OUT)) {
      previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
    }
  } catch (err) {
    console.warn(`⚠️  Failed to read existing data.json: ${err.message}`);
    previous = null;
  }

  const previousPlayers = new Map();
  if (previous && Array.isArray(previous.players)) {
    for (const player of previous.players) {
      if (player && Number.isFinite(player.id)) {
        previousPlayers.set(Number(player.id), player);
      }
    }
  }

  const out = {
    lastUpdated: Date.now(),
    players: [],
    heroStats: [],
    proMeta: { timestamp: 0, heroes: [], highlight: null, summary: { pickTotal: 0, winTotal: 0 } },
    proRoster: { timestamp: 0, players: [] },     // placeholder for future speedups
    similarCache: { timestamp: 0, players: {} },  // placeholder (client can still compute)
    fetchInfo: { runtimeMs: 0, apiCalls: 0, status: "running" }
  };

  // heroStats first (used both directly and for proMeta)
  console.log("Fetching heroStats…");
  let heroStats = null;
  try {
    heroStats = await API.heroes();
  } catch (e) {
    console.warn("heroStats failed:", e.message);
  }
  apiCalls += 1;
  if (!Array.isArray(heroStats)) {
    if (Array.isArray(previous?.heroStats)) {
      console.warn("Using previous heroStats due to fetch failure.");
      heroStats = previous.heroStats;
    } else {
      heroStats = [];
    }
  }
  out.heroStats = heroStats;

  // players
  const skippedPlayers = [];
  for (const id of IDS) {
    console.log(`Fetching player ${id}…`);
    const prevPlayer = previousPlayers.get(id) || null;
    let profile = null;
    try {
      profile = await API.profile(id);
    } catch (err) {
      console.warn(`[player ${id}] profile fetch failed: ${err.message}`);
    }
    await sleep(RATE_DELAY_OK);
    let matches = null;
    try {
      matches = await API.recent(id);
    } catch (err) {
      console.warn(`[player ${id}] recent matches failed: ${err.message}`);
    }
    await sleep(RATE_DELAY_OK);
    let recent28 = null;
    try {
      recent28 = await API.recent28(id);
    } catch (err) {
      console.warn(`[player ${id}] last-28d matches failed: ${err.message}`);
    }
    await sleep(RATE_DELAY_OK);
    let heroesAllTime = null;
    try {
      heroesAllTime = await API.heroesAllTime(id);
    } catch (err) {
      console.warn(`[player ${id}] heroes (all time) failed: ${err.message}`);
    }
    await sleep(RATE_DELAY_OK);
    apiCalls += 4;

    if (!profile) {
      if (prevPlayer?.profile) {
        console.warn(`[player ${id}] using previous profile due to fetch failure.`);
        profile = prevPlayer.profile;
      } else {
        console.warn(`Skipping ${id}: profile not found or 404`);
        skippedPlayers.push(id);
        continue;
      }
    }

    if (!Array.isArray(matches)) {
      if (Array.isArray(prevPlayer?.matches)) {
        console.warn(`[player ${id}] using previous recent matches due to fetch failure.`);
        matches = prevPlayer.matches;
      } else {
        matches = [];
      }
    }

    if (!Array.isArray(recent28)) {
      if (Array.isArray(prevPlayer?.recent28)) {
        console.warn(`[player ${id}] using previous last-28d matches due to fetch failure.`);
        recent28 = prevPlayer.recent28;
      } else {
        recent28 = [];
      }
    }

    if (!Array.isArray(heroesAllTime)) {
      if (Array.isArray(prevPlayer?.heroesAllTime)) {
        console.warn(`[player ${id}] using previous heroes (all time) due to fetch failure.`);
        heroesAllTime = prevPlayer.heroesAllTime;
      } else {
        heroesAllTime = [];
      }
    }

    const facts = buildFacts(matches, recent28);
    const recentHeroes = buildRecentHeroStats(matches, 20);

    console.log(
      `[player ${id}] processed. realMatches=${facts.total} recent28=${facts.recentCount} heroesAllTime=${heroesAllTime.length}`
    );

    const topAllTime = Array.isArray(heroesAllTime)
      ? heroesAllTime
          .slice()
          .sort((a, b) => (Number(b.games) || 0) - (Number(a.games) || 0))
          .slice(0, 20)
          .map((hero) => ({
            hero_id: Number(hero.hero_id),
            games: Number(hero.games) || 0,
            win: Number(hero.win) || 0
          }))
      : [];

    out.players.push({
      id,
      profile,
      matches: Array.isArray(matches) ? matches : [],
      recent28: Array.isArray(recent28) ? recent28 : [],
      facts,
      recentHeroes,
      heroesAllTime: topAllTime,
      metaMatches: [],
      similar: {
        pro: null,
        overlap: { score: 0, weight: 0, shared: [] },
        playerTop: [],
        proTop: []
      }
    });
  }

  // pro meta snapshot
  console.log("Building pro meta snapshot…");
  out.proMeta = buildProMetaSnapshot(out.heroStats);

  console.log(
    `Players processed: ${out.players.length}/${IDS.length}. Skipped: ${
      skippedPlayers.length ? skippedPlayers.join(", ") : "none"
    }.`
  );

  if (out.proMeta && Array.isArray(out.proMeta.heroes)) {
    const metaHeroSet = new Set(out.proMeta.heroes.map((h) => Number(h.hero_id)));
    for (const player of out.players) {
      const pool = Array.isArray(player.heroesAllTime) ? player.heroesAllTime : [];
      const matches = [];
      for (const hero of pool) {
        if (!Number.isFinite(hero.hero_id)) continue;
        if (metaHeroSet.has(hero.hero_id)) {
          matches.push(hero);
        }
        if (matches.length >= 3) break;
      }
      player.metaMatches = matches;
    }
  }

  // finalize
  out.fetchInfo = {
    runtimeMs: Date.now() - started,
    apiCalls,
    status: "complete"
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`✅ Wrote ${OUT}`);
  console.log(`⏱  ${(out.fetchInfo.runtimeMs / 1000).toFixed(1)}s • ${apiCalls} API calls`);
})().catch((err) => {
  console.error("❌ Fetcher failed:", err);
  process.exit(1);
});
