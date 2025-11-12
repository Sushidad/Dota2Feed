/**
 * Dota Social Feed Data Fetcher
 * ------------------------------------
 * Runs on GitHub Actions or locally.
 * Fetches data from OpenDota and writes data.json
 */

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// === CONFIG ===
const IDS = [
  39984287, // Example players
  86745912,
  13234532
];
const OUTPUT = path.resolve("./data.json");
const API_BASE = "https://api.opendota.com/api";
const RATE_DELAY = 1000; // ms between API calls to respect rate limits

// === HELPER ===
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeFetch(url) {
  let tries = 0;
  while (tries < 3) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      tries++;
      console.warn(`Retry ${tries}/3: ${url} (${e.message})`);
      await sleep(2000);
    }
  }
  throw new Error(`Failed after 3 retries: ${url}`);
}

// === MAIN ===
async function main() {
  const start = Date.now();
  const data = {
    lastUpdated: Date.now(),
    players: [],
    heroStats: [],
    proMeta: { timestamp: Date.now(), heroes: [], highlight: {}, summary: {} },
    proRoster: { timestamp: Date.now(), players: [] },
    similarCache: { timestamp: Date.now(), players: {} },
    fetchInfo: { runtimeMs: 0, apiCalls: 0, status: "running" }
  };

  let apiCalls = 0;

  // --- Fetch Hero Stats ---
  console.log("Fetching heroStats...");
  const heroStats = await safeFetch(`${API_BASE}/heroStats`);
  data.heroStats = heroStats;
  apiCalls++;

  // --- Fetch Players ---
  for (const id of IDS) {
    console.log(`Fetching data for player ${id}...`);
    const profile = await safeFetch(`${API_BASE}/players/${id}`);
    await sleep(RATE_DELAY);
    const matches = await safeFetch(`${API_BASE}/players/${id}/recentMatches`);
    await sleep(RATE_DELAY);
    const recent28 = await safeFetch(`${API_BASE}/players/${id}/matches?date=28`);
    await sleep(RATE_DELAY);
    apiCalls += 3;

    const playerData = {
      id,
      profile,
      matches,
      recent28,
      facts: {
        wins: 0,
        total: matches.length,
        winRate: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        kda: 0,
        gpm: 0,
        xpm: 0,
        uniqueHeroes: 0,
        topHeroes: []
      },
      recentHeroes: [],
      similar: {
        pro: null,
        overlap: { score: 0, weight: 0, shared: [] },
        playerTop: [],
        proTop: []
      }
    };

    // Basic fact calc example
    if (matches.length > 0) {
      const wins = matches.filter(
        (m) =>
          (m.player_slot < 128 && m.radiant_win) ||
          (m.player_slot >= 128 && !m.radiant_win)
      ).length;
      playerData.facts.wins = wins;
      playerData.facts.winRate = Math.round((wins / matches.length) * 100);
    }

    data.players.push(playerData);
  }

  // --- Fetch Pro Meta ---
  console.log("Fetching pro matches meta...");
  const proMetaRaw = await safeFetch(`${API_BASE}/heroStats`);
  apiCalls++;
  const proHeroes = proMetaRaw.map((h) => ({
    hero_id: h.id,
    contested: (h.pro_pick || 0) + (h.pro_ban || 0),
    pro_pick: h.pro_pick || 0,
    pro_ban: h.pro_ban || 0,
    pro_win: h.pro_win || 0
  }));
  data.proMeta.heroes = proHeroes;
  data.proMeta.summary = {
    contestedTotal: proHeroes.reduce((a, b) => a + b.contested, 0),
    pickTotal: proHeroes.reduce((a, b) => a + b.pro_pick, 0),
    banTotal: proHeroes.reduce((a, b) => a + b.pro_ban, 0)
  };
  data.proMeta.highlight = proHeroes.sort(
    (a, b) => b.contested - a.contested
  )[0];

  // --- Fetch Pro Roster ---
  console.log("Fetching pro players list...");
  const proRoster = await safeFetch(`${API_BASE}/proPlayers`);
  apiCalls++;
  data.proRoster.players = proRoster.slice(0, 500).map((p) => ({
    account_id: p.account_id,
    name: p.name || p.personaname || "",
    team_name: p.team_name || "",
    fantasy_role: p.fantasy_role || 0,
    loccountrycode: p.loccountrycode || "",
    last_played: p.last_played || 0,
    avatarfull: p.avatarfull || ""
  }));

  // --- Wrap up ---
  data.fetchInfo = {
    runtimeMs: Date.now() - start,
    apiCalls,
    status: "complete"
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 2));
  console.log(`✅ Data written to ${OUTPUT}`);
  console.log(`🕐 Runtime: ${(data.fetchInfo.runtimeMs / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("❌ Fetch failed:", err);
  process.exit(1);
});
