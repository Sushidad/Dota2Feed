/**
 * Dota Social Feed - Match Checker
 * ----------------------------------
 * Lightweight script to detect if any friend has a new match.
 * If new matches are found, sets RUN_UPDATE=true for GitHub Actions.
 */

const fs = require("fs");
const fetch = require("node-fetch");

const IDS = [39984287, 50423134, 53635813, 86890516, 26467713, 81305221, 27081071];
const API_BASE = "https://api.opendota.com/api";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeFetch(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      return await res.json();
    } catch (e) {
      if (i < 2) {
        console.warn(`Retry ${i + 1}/3: ${url}`);
        await sleep(1000);
      } else {
        console.warn(`Failed ${url}: ${e.message}`);
        return null;
      }
    }
  }
}

(async () => {
  console.log("🔎 Checking for new matches...");
  const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  const stored = new Map(data.players.map(p => [p.id, p.matches?.[0]?.match_id || 0]));

  let changed = false;
  for (const id of IDS) {
    const latest = stored.get(id) || 0;
    const recent = await safeFetch(`${API_BASE}/players/${id}/recentMatches?limit=1`);
    if (!recent || !recent.length) continue;

    const remoteMatch = recent[0]?.match_id || 0;
    if (remoteMatch && remoteMatch !== latest) {
      console.log(`🆕 Player ${id} has a new match: ${remoteMatch} (was ${latest})`);
      changed = true;
    }
    await sleep(500);
  }

  if (changed) {
    console.log("✅ New matches detected — will trigger data update workflow.");
    fs.appendFileSync(process.env.GITHUB_ENV, "RUN_UPDATE=true\n");
  } else {
    console.log("🟢 No new matches, skipping update.");
  }
})();
