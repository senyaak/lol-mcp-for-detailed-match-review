/**
 * Thin Riot API client.
 *
 * Two routing layers:
 *   - "regional" clusters (americas / asia / europe / sea): Account-V1, Match-V5.
 *   - "platform" hosts (euw1 / na1 / kr / ...): League-V4, Champion-Mastery-V4.
 * Match-V5 returns `info.platformId` (e.g. "EUW1"), which we lowercase to derive
 * the platform host for the per-player enrichment calls.
 */

import { cached, TTL } from "./cache.js";

export type Region = "americas" | "asia" | "europe" | "sea";

export const REGIONS: Region[] = ["americas", "asia", "europe", "sea"];

class RiotApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    message: string,
  ) {
    super(message);
    this.name = "RiotApiError";
  }
}

function regionalHost(region: Region): string {
  return `https://${region}.api.riotgames.com`;
}

/** Platform host from a Match-V5 platformId like "EUW1" -> euw1.api.riotgames.com */
function platformHost(platformId: string): string {
  return `https://${platformId.toLowerCase()}.api.riotgames.com`;
}

// --- Concurrency limiter -----------------------------------------------------
// Keep a lid on in-flight requests so we stay well under Riot's dev-key limits
// (20 req/s, 100 req/2min). 429s are still possible under bursts, so request()
// also honours Retry-After; this just smooths the load.

const MAX_CONCURRENT = 8;
let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
}

function release(): void {
  active--;
  waiters.shift()?.();
}

const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: ~0.5s, 1s, 2s, 4s (capped at 8s). */
function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base + Math.random() * 250;
}

async function request<T>(
  baseHost: string,
  path: string,
  attempt = 0,
): Promise<T> {
  const apiKey = process.env.RIOT_API_KEY ?? "";
  if (!apiKey) {
    throw new RiotApiError(
      0,
      path,
      "RIOT_API_KEY is not set. Add it to the MCP server environment.",
    );
  }

  const url = `${baseHost}${path}`;

  let res: Response;
  await acquire();
  try {
    res = await fetch(url, { headers: { "X-Riot-Token": apiKey } });
  } catch (networkErr) {
    // Transient network failure — retry with backoff.
    if (attempt < MAX_RETRIES) {
      await sleep(backoff(attempt));
      return request<T>(baseHost, path, attempt + 1);
    }
    throw new RiotApiError(0, url, `network error: ${String(networkErr)}`);
  } finally {
    release();
  }

  if (res.ok) return (await res.json()) as T;

  // Rate limited: wait the server-provided delay, then retry.
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after")) || 1;
    await sleep(retryAfter * 1000 + 100);
    return request<T>(baseHost, path, attempt + 1);
  }

  // Server-side errors: retry with backoff.
  if (res.status >= 500 && attempt < MAX_RETRIES) {
    await sleep(backoff(attempt));
    return request<T>(baseHost, path, attempt + 1);
  }

  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " (check that RIOT_API_KEY is valid and not expired)"
      : res.status === 404
        ? " (not found)"
        : res.status === 429
          ? " (rate limited; retries exhausted)"
          : "";
  throw new RiotApiError(
    res.status,
    url,
    `Riot API ${res.status}${hint}: ${detail.slice(0, 300)}`,
  );
}

function get<T>(region: Region, path: string): Promise<T> {
  return request<T>(regionalHost(region), path);
}

function getPlatform<T>(platformId: string, path: string): Promise<T> {
  return request<T>(platformHost(platformId), path);
}

export interface Account {
  puuid: string;
  gameName: string;
  tagLine: string;
}

/** Resolve a Riot ID like "Faker#KR1" to an account (incl. PUUID). Cached. */
export async function getAccountByRiotId(
  region: Region,
  gameName: string,
  tagLine: string,
): Promise<Account> {
  return cached(
    `account:${region}:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`,
    TTL.account,
    () =>
      get<Account>(
        region,
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
          gameName,
        )}/${encodeURIComponent(tagLine)}`,
      ),
  );
}

export interface MatchListOptions {
  start?: number;
  count?: number;
  /** Filter by queue id (e.g. 420 ranked solo). */
  queue?: number;
  /** Filter by match type: ranked | normal | tourney | tutorial. */
  type?: string;
}

/**
 * List recent match IDs for a PUUID, most recent first.
 * NOT cached on purpose — this is "match history" and must stay fresh.
 */
export async function getMatchIds(
  region: Region,
  puuid: string,
  opts: MatchListOptions = {},
): Promise<string[]> {
  const params = new URLSearchParams();
  params.set("start", String(opts.start ?? 0));
  params.set("count", String(opts.count ?? 20));
  if (opts.queue != null) params.set("queue", String(opts.queue));
  if (opts.type) params.set("type", opts.type);
  return get<string[]>(
    region,
    `/lol/match/v5/matches/by-puuid/${puuid}/ids?${params.toString()}`,
  );
}

/** Full raw match detail. Cached — a finished match never changes. */
export async function getMatch(
  region: Region,
  matchId: string,
): Promise<RawMatch> {
  return cached(
    `match:${matchId}`,
    TTL.immutable,
    () => get<RawMatch>(region, `/lol/match/v5/matches/${matchId}`),
    true, // persist to disk — finished matches are immutable
  );
}

// --- Minimal shape of the Match-V5 response we rely on. ---------------------
// The real payload is much larger; we only declare fields we read.

export interface RawMatch {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    gameStartTimestamp: number;
    gameDuration: number; // seconds
    gameMode: string;
    gameType: string;
    queueId: number;
    mapId: number;
    platformId: string;
    gameVersion: string;
    participants: RawParticipant[];
    teams: RawTeam[];
  };
}

export interface RawParticipant {
  puuid: string;
  riotIdGameName?: string;
  riotIdTagline?: string;
  summonerName?: string;
  teamId: number;
  championId: number;
  championName: string;
  champLevel: number;
  teamPosition?: string;
  individualPosition?: string;
  win: boolean;
  gameEndedInEarlySurrender?: boolean; // true for remakes
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  goldEarned: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  damageDealtToObjectives: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  visionWardsBoughtInGame: number;
  timeCCingOthers: number; // seconds of CC applied to enemies
  totalTimeCCDealt: number; // weighted CC score (Riot raw)
  summoner1Id: number;
  summoner2Id: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  perks?: RawPerks;
  // a few common challenge metrics, when present
  challenges?: Record<string, number>;
}

export interface RawPerks {
  styles: {
    description: string;
    style: number;
    selections: { perk: number }[];
  }[];
  statPerks: { defense: number; flex: number; offense: number };
}

export interface RawTeam {
  teamId: number;
  win: boolean;
  objectives: Record<string, { first: boolean; kills: number }>;
  bans: { championId: number; pickTurn: number }[];
}

// --- Per-player enrichment (platform routing). ------------------------------

export interface LeagueEntry {
  queueType: string; // RANKED_SOLO_5x5 | RANKED_FLEX_SR | ...
  tier: string; // IRON..CHALLENGER
  rank: string; // I..IV
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak?: boolean;
}

/**
 * Ranked entries (solo + flex) for a PUUID. League-V4, platform routing.
 * Cached by default; pass `fresh` to bypass the cache (the LP poller needs the
 * live value, not a value up to TTL.ranks old).
 */
export function getLeagueEntriesByPuuid(
  platformId: string,
  puuid: string,
  fresh = false,
): Promise<LeagueEntry[]> {
  const call = () =>
    getPlatform<LeagueEntry[]>(
      platformId,
      `/lol/league/v4/entries/by-puuid/${puuid}`,
    );
  return fresh ? call() : cached(`ranks:${platformId}:${puuid}`, TTL.ranks, call);
}

export interface ChampionMastery {
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
}

/** Mastery of one champion for a PUUID. Champion-Mastery-V4, platform routing. Cached. */
export function getChampionMastery(
  platformId: string,
  puuid: string,
  championId: number,
): Promise<ChampionMastery> {
  return cached(
    `mastery:${platformId}:${puuid}:${championId}`,
    TTL.mastery,
    () =>
      getPlatform<ChampionMastery>(
        platformId,
        `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/by-champion/${championId}`,
      ),
  );
}

// --- Match timeline (regional routing). -------------------------------------

export interface RawTimeline {
  metadata: { matchId: string; participants: string[] };
  info: {
    frameInterval: number; // ms, usually 60000
    participants: { participantId: number; puuid: string }[];
    frames: RawTimelineFrame[];
  };
}

export interface RawTimelineFrame {
  timestamp: number; // ms since game start
  participantFrames: Record<string, RawParticipantFrame>;
  events: RawTimelineEvent[];
}

export interface RawParticipantFrame {
  participantId: number;
  totalGold: number;
  currentGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  position?: { x: number; y: number };
  // Cumulative damage up to this frame.
  damageStats?: {
    totalDamageDoneToChampions: number;
    totalDamageTaken: number;
  };
}

export interface RawTimelineEvent {
  type: string;
  timestamp: number;
  // type-specific fields (loosely typed)
  participantId?: number;
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  position?: { x: number; y: number };
  killerTeamId?: number;
  monsterType?: string;
  monsterSubType?: string;
  buildingType?: string;
  towerType?: string;
  laneType?: string;
  teamId?: number;
  killType?: string;
  level?: number;
  // ITEM_PURCHASED / ITEM_SOLD / ITEM_DESTROYED carry itemId; ITEM_UNDO carries
  // beforeId (what was bought) and afterId (what it reverted to, usually 0).
  itemId?: number;
  beforeId?: number;
  afterId?: number;
}

/** Full match timeline. Match-V5, regional routing. Cached (immutable). */
export function getMatchTimeline(
  region: Region,
  matchId: string,
): Promise<RawTimeline> {
  return cached(
    `timeline:${matchId}`,
    TTL.immutable,
    () => get<RawTimeline>(region, `/lol/match/v5/matches/${matchId}/timeline`),
    true, // persist to disk — timelines are immutable
  );
}

export { RiotApiError };
