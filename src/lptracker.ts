/**
 * Per-match LP tracker. Riot exposes no per-match LP, only a current snapshot
 * (League-V4). So an internal poller (see index.ts) samples the player's
 * standing every few minutes; whenever the ranked game count ticks up we
 * attribute the LP delta to the newest ranked match id. `getLpForMatch` then
 * returns the exact LP for that specific game — not a summed "since last check".
 *
 * LP is NOT linear across divisions (promotions reset it), so we map rank to a
 * continuous "ladder" value — tier*400 + division*100 + lp — and diff that.
 * Forward-only: nothing before the poller's first observation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIER_INDEX: Record<string, number> = {
  IRON: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4,
  EMERALD: 5,
  DIAMOND: 6,
  MASTER: 7,
  GRANDMASTER: 7,
  CHALLENGER: 7, // master+ share one continuous LP scale (no divisions)
};

const DIVISION: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };

/** Continuous ladder position in LP units. */
function ladderLp(tier: string, rank: string, lp: number): number {
  const t = TIER_INDEX[tier?.toUpperCase()] ?? 0;
  if (t >= 7) return 7 * 400 + lp; // master+: no divisions
  const d = DIVISION[rank?.toUpperCase()] ?? 4; // I..IV
  return t * 400 + (4 - d) * 100 + lp;
}

interface Standing {
  games: number;
  ladder: number;
  ts: number;
}

export interface LpRecord {
  delta: number; // LP gained (+) / lost (-) for this match
  sinceGames: number; // games covered (1 = exact per-game; >1 = combined)
  queue: string; // "Solo" | "Flex"
  tier: string;
  rank: string;
  lp: number;
  ts: number;
}

interface Store {
  standings: Record<string, Standing>; // key: `${puuid}:${queue}`
  byMatch: Record<string, LpRecord>; // key: matchId
}

const MAX_BY_MATCH = 300; // prune old per-match records

function cacheDir(): string {
  return (
    process.env.CACHE_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), "..", ".cache")
  );
}

function storeFile(): string {
  return join(cacheDir(), "lp-history.json");
}

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    const raw = JSON.parse(readFileSync(storeFile(), "utf8"));
    store = {
      standings: raw.standings ?? {},
      byMatch: raw.byMatch ?? {},
    };
  } catch {
    store = { standings: {}, byMatch: {} };
  }
  return store;
}

function persist(): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(store));
  } catch {
    /* best-effort */
  }
}

/** Exact LP for a specific match, if the poller has recorded it. */
export function getLpForMatch(matchId: string): LpRecord | null {
  return load().byMatch[matchId] ?? null;
}

/**
 * Called by the poller with a fresh standing observation for (puuid, queue) plus
 * the player's latest ranked match id in that queue. When the game count has
 * advanced, the LP delta is attributed to that latest match id.
 */
export function recordPoll(
  puuid: string,
  queue: string,
  tier: string,
  rank: string,
  lp: number,
  wins: number,
  losses: number,
  latestMatchId: string | null,
): void {
  const s = load();
  const key = `${puuid}:${queue}`;
  const games = wins + losses;
  const ladder = ladderLp(tier, rank, lp);
  const prev = s.standings[key];

  if (
    prev &&
    latestMatchId &&
    games > prev.games &&
    !s.byMatch[latestMatchId] // don't overwrite an already-attributed match
  ) {
    s.byMatch[latestMatchId] = {
      delta: ladder - prev.ladder,
      sinceGames: games - prev.games,
      queue,
      tier,
      rank,
      lp,
      ts: Date.now(),
    };
    pruneByMatch(s);
  }

  s.standings[key] = { games, ladder, ts: Date.now() };
  persist();
}

function pruneByMatch(s: Store): void {
  const ids = Object.keys(s.byMatch);
  if (ids.length <= MAX_BY_MATCH) return;
  ids
    .map((id) => [id, s.byMatch[id].ts] as const)
    .sort((a, b) => a[1] - b[1])
    .slice(0, ids.length - MAX_BY_MATCH)
    .forEach(([id]) => delete s.byMatch[id]);
}
