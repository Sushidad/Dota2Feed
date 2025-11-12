// data-fetcher.js
/**
 * Dota Social Feed – data.json updater (for GitHub Actions or local use)
 * - Uses Node 18+ native fetch (no deps)
 * - Mirrors your frontend’s logic: profiles, recent matches, recent28, heroStats
 * - Computes the same “facts” your UI shows so render is instant
 * - Builds a pro meta snapshot (top contested heroes) from heroStats
 * - Skips a player cleanly if OpenDota returns 404/empty
 */

const fs = require("fs");
const path = require("path");

// ---------- Config (matches your HTML) ----------
const IDS = [39984287, 50423134, 53635813, 86890516, 26467713, 81305221, 27081071];
const VALID_GAME_MODES = [1, 2, 3, 4, 22];
const VALID_LOBBY_TYPES = [0, 7];

// throttle / retry similar to your page
const RATE_DELAY_OK = 260;
const RATE_DELAY_429 = 1500;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const API = {
  heroes: () => j(`${BASE}/heroStats`),
  profile: (id) => j(`${BASE}/players/${id}`),
  recent: (id) => j(`${BASE}/players/${id}/recentMatches?limit=30`),
  recent28: (id) => j(`${BASE}/players/${id}/matches?date=28`)
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
      const res = await schedule(() => fetch(url));
      if (!res.ok) {
        const { status } = res;
        if (attempt < retries && (RETRY_STATUSES.has(status) || status === 408)) {
          await sleep(status === 429 ? RATE_DELAY_429 : RATE_DELAY_OK);
          attempt++;
          continue;
        }
        if (status === 404) return null; // treat missing as “skip”
        throw new Error(`Bad status ${status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        await sleep(RATE_DELAY_OK);
        attempt++;
        continue;
      }
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
      const pro_pick = Number(h.pro_pick) || 0;
      const pro_ban = Number(h.pro_ban) || 0;
      const pro_win = Number(h.pro_win) || 0;
      const contested = pro_pick + pro_ban;
      if (!Number.isFinite(id) || contested <= 0) return null;
      return { hero_id: id, contested, pro_pick, pro_ban, pro_win };
    })
    .filter(Boolean)
    .sort((a, b) => (b.contested || 0) - (a.contested || 0))
    .slice(0, 30);

  const contestedTotal = heroes.reduce((s, x) => s + x.contested, 0);
  const pickTotal = heroes.reduce((s, x) => s + x.pro_pick, 0);
  const banTotal = heroes.reduce((s, x) => s + x.pro_ban, 0);

  // highlight: most successful among reasonably picked heroes (>=15 picks) else top contested
  const highlight =
    heroes
      .filter((x) => (x.pro_pick || 0) >= 15)
      .sort((a, b) => (b.pro_pick ? b.pro_win / b.pro_pick : 0) - (a.pro_pick ? a.pro_win / a.pro_pick : 0))[0] ||
    heroes.find((x) => (x.pro_pick || 0) > 0) ||
    null;

  return {
    timestamp: Date.now(),
    heroes,
    highlight: highlight
      ? {
          hero_id: highlight.hero_id,
          pro_pick: highlight.pro_pick,
          pro_win: highlight.pro_win,
          winRate: highlight.pro_pick ? highlight.pro_win / highlight.pro_pick : 0
        }
      : null,
    summary: { contestedTotal, pickTotal, banTotal }
  };
}

// ---------- main ----------
(async function run() {
  const started = Date.now();
  let apiCalls = 0;

  const out = {
    lastUpdated: Date.now(),
    players: [],
    heroStats: [],
    proMeta: { timestamp: 0, heroes: [], highlight: null, summary: { contestedTotal: 0, pickTotal: 0, banTotal: 0 } },
    proRoster: { timestamp: 0, players: [] },     // placeholder for future speedups
    similarCache: { timestamp: 0, players: {} },  // placeholder (client can still compute)
    fetchInfo: { runtimeMs: 0, apiCalls: 0, status: "running" }
  };

  // heroStats first (used both directly and for proMeta)
  console.log("Fetching heroStats…");
  const heroStats = await API.heroes().catch((e) => {
    console.warn("heroStats failed:", e.message);
    return [];
  });
  apiCalls += 1;
  out.heroStats = Array.isArray(heroStats) ? heroStats : [];

  // players
  for (const id of IDS) {
    console.log(`Fetching player ${id}…`);
    const profile = await API.profile(id).catch(() => null);
    await sleep(RATE_DELAY_OK);
    const matches = (await API.recent(id).catch(() => null)) || [];
    await sleep(RATE_DELAY_OK);
    const recent28 = (await API.recent28(id).catch(() => null)) || [];
    await sleep(RATE_DELAY_OK);
    apiCalls += 3;

    if (!profile) {
      console.warn(`Skipping ${id}: profile not found or 404`);
      continue;
    }

    const facts = buildFacts(matches, recent28);
    const recentHeroes = buildRecentHeroStats(matches, 20);

    out.players.push({
      id,
      profile,
      matches: Array.isArray(matches) ? matches : [],
      recent28: Array.isArray(recent28) ? recent28 : [],
      facts,
      recentHeroes,
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
