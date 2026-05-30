/**
 * Distills a raw Match-V5 payload into a compact, analysis-friendly object.
 * The raw response is enormous (hundreds of fields per player); Claude only
 * needs the signal: who played what, how they did, and how the game flowed.
 *
 * Item / spell / rune ids are resolved to readable names when Data Dragon name
 * tables are supplied; otherwise they fall back to numeric ids.
 */

import type {
  ChampionMastery,
  LeagueEntry,
  RawMatch,
  RawParticipant,
  RawTimeline,
} from "./riot.js";
import { itemName, runeName, spellName, type NameTables } from "./ddragon.js";

const FALLBACK_SPELLS: Record<number, string> = {
  1: "Cleanse",
  3: "Exhaust",
  4: "Flash",
  6: "Ghost",
  7: "Heal",
  11: "Smite",
  12: "Teleport",
  13: "Clarity",
  14: "Ignite",
  21: "Barrier",
  32: "Mark",
};

const QUEUES: Record<number, string> = {
  400: "Normal Draft",
  420: "Ranked Solo/Duo",
  430: "Normal Blind",
  440: "Ranked Flex",
  450: "ARAM",
  490: "Quickplay",
  700: "Clash",
  720: "ARAM Clash",
  830: "Co-op vs AI Intro",
  840: "Co-op vs AI Beginner",
  850: "Co-op vs AI Intermediate",
  900: "URF",
  1020: "One for All",
  1700: "Arena",
  1900: "URF",
};

const OBJECTIVE_KEYS = [
  "champion",
  "tower",
  "inhibitor",
  "baron",
  "dragon",
  "riftHerald",
  "horde",
  "atakhan",
] as const;

function resolveSpell(tables: NameTables | null, id: number): string {
  if (tables && tables.spells[id]) return spellName(tables, id);
  return FALLBACK_SPELLS[id] ?? `Spell#${id}`;
}

function kda(p: RawParticipant): string {
  const ratio =
    p.deaths === 0 ? "Perfect" : ((p.kills + p.assists) / p.deaths).toFixed(2);
  return `${p.kills}/${p.deaths}/${p.assists} (${ratio})`;
}

function rawItems(p: RawParticipant): number[] {
  return [
    p.item0,
    p.item1,
    p.item2,
    p.item3,
    p.item4,
    p.item5,
    p.item6,
  ].filter((i) => i > 0);
}

function cs(p: RawParticipant): number {
  return p.totalMinionsKilled + p.neutralMinionsKilled;
}

function role(p: RawParticipant): string {
  return p.teamPosition || p.individualPosition || "UNKNOWN";
}

function riotId(p: RawParticipant): string {
  if (p.riotIdGameName) {
    return p.riotIdTagline
      ? `${p.riotIdGameName}#${p.riotIdTagline}`
      : p.riotIdGameName;
  }
  return p.summonerName || "Unknown";
}

interface RuneSummary {
  primaryStyle: string;
  keystone: string;
  primary: string[];
  secondaryStyle: string;
  secondary: string[];
}

function distillRunes(
  p: RawParticipant,
  tables: NameTables | null,
): RuneSummary | undefined {
  if (!p.perks || !tables) return undefined;
  const name = (id: number) => runeName(tables, id);
  const [primary, secondary] = p.perks.styles;
  if (!primary) return undefined;
  return {
    primaryStyle: name(primary.style),
    keystone: primary.selections[0] ? name(primary.selections[0].perk) : "",
    primary: primary.selections.map((s) => name(s.perk)),
    secondaryStyle: secondary ? name(secondary.style) : "",
    secondary: secondary ? secondary.selections.map((s) => name(s.perk)) : [],
  };
}

export interface PlayerRank {
  queue: string; // "Solo" | "Flex"
  tier: string;
  rank: string;
  lp: number;
  wins: number;
  losses: number;
  winrate: number; // percent
  hotStreak?: boolean;
}

export interface PlayerMastery {
  level: number;
  points: number;
}

export interface DistilledParticipant {
  puuid: string;
  player: string;
  champion: string;
  level: number;
  role: string;
  win: boolean;
  kda: string;
  cs: number;
  csPerMin: number;
  gold: number;
  damageToChampions: number;
  damageTaken: number;
  damageToObjectives: number;
  visionScore: number;
  wardsPlaced: number;
  wardsKilled: number;
  controlWards: number;
  ccScore: { timeCCingOthers: number; totalTimeCCDealt: number };
  summonerSpells: [string, string];
  items: string[];
  runes?: RuneSummary;
  ranks?: PlayerRank[];
  championMastery?: PlayerMastery;
  recentForm?: RoughGame[];
  laning?: Laning;
  /** LP gained/lost — only on target's most recent ranked game (forward-tracked). */
  lpChange?: {
    delta: number;
    sinceGames: number;
    tier: string;
    rank: string;
    lp: number;
  };
  isTarget: boolean;
}

export interface Laning {
  opponent: string; // champion of the same-role enemy
  role: string;
  atMinute: number; // minute the snapshot was taken (14, or last frame if shorter)
  goldDiff: number;
  csDiff: number;
  xpDiff: number;
  killsVsOpp: number; // times target last-hit the lane opponent
  assistsVsOpp: number; // times target assisted in killing the lane opponent (key for supports)
  deathsToOpp: number; // times the lane opponent killed target (direct)
  platesTaken: number; // turret plates target last-hit before atMinute
  /**
   * 0-100, 50 = even lane. Based on gold + xp lead (which already integrate CS,
   * kills and plates economically — so no double counting). Role-agnostic: works
   * for supports/junglers too, where CS is reported raw but not scored.
   */
  score: number;
  /**
   * OP.GG-style head-to-head split "you:opponent" summing to 100 (e.g. "52:48").
   * The opponent's half is exactly 100 - score, so it always totals 100.
   */
  split: string;
}

export interface RoughGame {
  champion: string;
  kda: string;
  result: "WIN" | "LOSS";
  /** Present and true for remakes (early surrender) — exclude from winrate signal. */
  remake?: boolean;
}

/** Minimal "what did this player do" line for a match, from their perspective. */
export function roughForm(match: RawMatch, puuid: string): RoughGame | null {
  const me = match.info.participants.find((p) => p.puuid === puuid);
  if (!me) return null;
  const game: RoughGame = {
    champion: me.championName,
    kda: kda(me),
    result: me.win ? "WIN" : "LOSS",
  };
  if (me.gameEndedInEarlySurrender) game.remake = true;
  return game;
}

function distillParticipant(
  p: RawParticipant,
  durationMin: number,
  targetPuuid: string | null,
  tables: NameTables | null,
): DistilledParticipant {
  return {
    puuid: p.puuid,
    player: riotId(p),
    champion: p.championName,
    level: p.champLevel,
    role: role(p),
    win: p.win,
    kda: kda(p),
    cs: cs(p),
    csPerMin: Number((cs(p) / durationMin).toFixed(1)),
    gold: p.goldEarned,
    damageToChampions: p.totalDamageDealtToChampions,
    damageTaken: p.totalDamageTaken,
    damageToObjectives: p.damageDealtToObjectives,
    visionScore: p.visionScore,
    wardsPlaced: p.wardsPlaced,
    wardsKilled: p.wardsKilled,
    controlWards: p.visionWardsBoughtInGame,
    ccScore: {
      timeCCingOthers: p.timeCCingOthers,
      totalTimeCCDealt: p.totalTimeCCDealt,
    },
    summonerSpells: [
      resolveSpell(tables, p.summoner1Id),
      resolveSpell(tables, p.summoner2Id),
    ],
    items: tables
      ? rawItems(p).map((id) => itemName(tables, id))
      : rawItems(p).map((id) => `Item#${id}`),
    runes: distillRunes(p, tables),
    isTarget: targetPuuid != null && p.puuid === targetPuuid,
  };
}

/** Map a raw League entry into the compact rank shape. */
export function distillRank(entry: LeagueEntry): PlayerRank {
  const games = entry.wins + entry.losses;
  const queue =
    entry.queueType === "RANKED_SOLO_5x5"
      ? "Solo"
      : entry.queueType === "RANKED_FLEX_SR"
        ? "Flex"
        : entry.queueType;
  return {
    queue,
    tier: entry.tier,
    rank: entry.rank,
    lp: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
    winrate: games ? Number(((entry.wins / games) * 100).toFixed(1)) : 0,
    hotStreak: entry.hotStreak,
  };
}

export function distillMastery(m: ChampionMastery): PlayerMastery {
  return { level: m.championLevel, points: m.championPoints };
}

/** Compact one-line summary for a match list entry. */
export function summarizeForTarget(
  match: RawMatch,
  targetPuuid: string,
): {
  matchId: string;
  queue: string;
  date: string;
  durationMin: number;
  champion: string;
  role: string;
  result: "WIN" | "LOSS";
  kda: string;
  csPerMin: number;
} | null {
  const me = match.info.participants.find((p) => p.puuid === targetPuuid);
  if (!me) return null;
  const durationMin = Math.max(1, match.info.gameDuration / 60);
  return {
    matchId: match.metadata.matchId,
    queue: QUEUES[match.info.queueId] ?? `Queue#${match.info.queueId}`,
    date: new Date(match.info.gameStartTimestamp).toISOString(),
    durationMin: Number(durationMin.toFixed(1)),
    champion: me.championName,
    role: role(me),
    result: me.win ? "WIN" : "LOSS",
    kda: kda(me),
    csPerMin: Number((cs(me) / durationMin).toFixed(1)),
  };
}

export interface DistilledTeam {
  teamId: number;
  side: "Blue" | "Red";
  result: "WIN" | "LOSS";
  objectives: Record<string, { first: boolean; kills: number }>;
  kills: number;
  gold: number;
  players: DistilledParticipant[];
}

export interface DistilledMatch {
  matchId: string;
  queue: string;
  gameMode: string;
  patch: string;
  date: string;
  durationMin: number;
  target?: DistilledParticipant;
  teams: DistilledTeam[];
  timeline?: DistilledTimeline;
}

/** Distill a full match into the structure handed to Claude for analysis. */
export function distillMatch(
  match: RawMatch,
  targetPuuid: string | null,
  tables: NameTables | null = null,
): DistilledMatch {
  const info = match.info;
  const durationMin = Math.max(1, info.gameDuration / 60);

  const teams: DistilledTeam[] = info.teams.map((team) => {
    const raw = info.participants.filter((p) => p.teamId === team.teamId);
    const players = raw.map((p) =>
      distillParticipant(p, durationMin, targetPuuid, tables),
    );

    const objectives: Record<string, { first: boolean; kills: number }> = {};
    for (const key of OBJECTIVE_KEYS) {
      const o = team.objectives[key];
      if (o) objectives[key] = { first: o.first, kills: o.kills };
    }

    return {
      teamId: team.teamId,
      side: team.teamId === 100 ? ("Blue" as const) : ("Red" as const),
      result: team.win ? ("WIN" as const) : ("LOSS" as const),
      objectives,
      kills: raw.reduce((s, p) => s + p.kills, 0),
      gold: raw.reduce((s, p) => s + p.goldEarned, 0),
      players,
    };
  });

  const target =
    targetPuuid != null
      ? teams.flatMap((t) => t.players).find((p) => p.isTarget)
      : undefined;

  return {
    matchId: match.metadata.matchId,
    queue: QUEUES[info.queueId] ?? `Queue#${info.queueId}`,
    gameMode: info.gameMode,
    patch: info.gameVersion,
    date: new Date(info.gameStartTimestamp).toISOString(),
    durationMin: Number(durationMin.toFixed(1)),
    target,
    teams,
  };
}

// --- Timeline distillation. -------------------------------------------------

export interface TimelineSnapshot {
  minute: number;
  players: {
    champion: string;
    team: "Blue" | "Red";
    gold: number;
    xp: number;
    cs: number;
    level: number;
    dmgChamps: number; // cumulative damage to champions by this minute
    dmgTaken: number; // cumulative damage taken by this minute
  }[];
}

export interface TimelineEvent {
  minute: number;
  type: string;
  detail: string;
  /** Structured fields (champion names) so callers can filter without parsing `detail`. */
  killer?: string;
  victim?: string;
  assists?: string[];
  /** For objectives: which team secured it. */
  team?: "Blue" | "Red";
}

export interface DistilledTimeline {
  snapshots: TimelineSnapshot[];
  events: TimelineEvent[];
}

/** Minute marks at which we snapshot the game state. */
const SNAPSHOT_MINUTES = [10, 15, 20, 25, 30];

/**
 * Distill a timeline: per-minute snapshots at key marks (gold/xp/cs/level per
 * player) plus a compact log of impactful events (kills, objectives, towers).
 */
export function distillTimeline(
  timeline: RawTimeline,
  match: RawMatch,
): DistilledTimeline {
  // participantId (1-10) -> { champion, team }
  const byParticipantId = new Map<
    number,
    { champion: string; team: "Blue" | "Red" }
  >();
  const idToPuuid = new Map<number, string>();
  for (const pp of timeline.info.participants) {
    idToPuuid.set(pp.participantId, pp.puuid);
  }
  match.info.participants.forEach((p) => {
    // match the puuid to a participantId
    for (const [pid, puuid] of idToPuuid) {
      if (puuid === p.puuid) {
        byParticipantId.set(pid, {
          champion: p.championName,
          team: p.teamId === 100 ? "Blue" : "Red",
        });
      }
    }
  });

  // participantId 0 = non-champion source (minions / turret / execution).
  const champOf = (id?: number): string => {
    if (id == null) return "?";
    if (id === 0) return "minions/turret";
    return byParticipantId.get(id)?.champion ?? `P${id}`;
  };

  const frames = timeline.info.frames;
  const lastMinute = Math.floor((frames.at(-1)?.timestamp ?? 0) / 60000);

  const snapshots: TimelineSnapshot[] = [];
  for (const minute of SNAPSHOT_MINUTES) {
    if (minute > lastMinute) break;
    const frame = frames[minute]; // frames are ~1/min, index ≈ minute
    if (!frame) continue;
    const players = Object.values(frame.participantFrames).map((pf) => {
      const meta = byParticipantId.get(pf.participantId);
      return {
        champion: meta?.champion ?? `P${pf.participantId}`,
        team: meta?.team ?? "Blue",
        gold: pf.totalGold,
        xp: pf.xp,
        cs: pf.minionsKilled + pf.jungleMinionsKilled,
        level: pf.level,
        dmgChamps: pf.damageStats?.totalDamageDoneToChampions ?? 0,
        dmgTaken: pf.damageStats?.totalDamageTaken ?? 0,
      };
    });
    snapshots.push({ minute, players });
  }

  const events: TimelineEvent[] = [];
  for (const frame of frames) {
    for (const e of frame.events) {
      const minute = Number((e.timestamp / 60000).toFixed(1));
      switch (e.type) {
        case "CHAMPION_KILL": {
          const killer = champOf(e.killerId);
          const victim = champOf(e.victimId);
          const assists = (e.assistingParticipantIds ?? []).map((id) =>
            champOf(id),
          );
          events.push({
            minute,
            type: "KILL",
            detail: `${killer} killed ${victim}${
              assists.length ? ` (assists: ${assists.join(", ")})` : ""
            }`,
            killer,
            victim,
            assists,
          });
          break;
        }
        case "ELITE_MONSTER_KILL": {
          const monster = e.monsterSubType
            ? `${e.monsterSubType} ${e.monsterType}`
            : (e.monsterType ?? "monster");
          const killer = champOf(e.killerId);
          const assists = (e.assistingParticipantIds ?? []).map((id) =>
            champOf(id),
          );
          const team =
            e.killerTeamId === 100
              ? ("Blue" as const)
              : e.killerTeamId === 200
                ? ("Red" as const)
                : undefined;
          events.push({
            minute,
            type: "OBJECTIVE",
            detail: `${killer} took ${monster}${
              assists.length ? ` (with: ${assists.join(", ")})` : ""
            }`,
            killer,
            assists,
            team,
          });
          break;
        }
        case "BUILDING_KILL": {
          const what = e.towerType ?? e.buildingType ?? "building";
          const lane = e.laneType ? ` (${e.laneType})` : "";
          const killer = champOf(e.killerId);
          events.push({
            minute,
            type: "BUILDING",
            detail: `${killer} destroyed ${what}${lane}`,
            killer,
          });
          break;
        }
        default:
          break;
      }
    }
  }

  return { snapshots, events };
}

/**
 * Compute an OP.GG-style laning score for the target vs their same-role lane
 * opponent at ~14 minutes. Returns null when there's no clear opponent (ARAM,
 * missing role data, etc.) or no timeline frame to read.
 */
export function computeLaning(
  timeline: RawTimeline,
  match: RawMatch,
  targetPuuid: string,
): Laning | null {
  const me = match.info.participants.find((p) => p.puuid === targetPuuid);
  if (!me) return null;
  const role = me.teamPosition || me.individualPosition || "";
  if (!role || role === "UNKNOWN" || role === "Invalid") return null;

  // Same-role enemy.
  const opp = match.info.participants.find(
    (p) =>
      p.teamId !== me.teamId &&
      (p.teamPosition || p.individualPosition) === role,
  );
  if (!opp) return null;

  // puuid -> participantId (1-10)
  const pid = new Map<string, number>();
  for (const pp of timeline.info.participants) pid.set(pp.puuid, pp.participantId);
  const myId = pid.get(me.puuid);
  const oppId = pid.get(opp.puuid);
  if (myId == null || oppId == null) return null;

  const frames = timeline.info.frames;
  if (frames.length === 0) return null;
  // frames are ~1/min, index ≈ minute. Use minute 14, or the last frame if shorter.
  const idx = Math.min(14, frames.length - 1);
  const frame = frames[idx];
  const atMinute = Math.round((frame.timestamp ?? idx * 60000) / 60000);

  const mf = frame.participantFrames[String(myId)];
  const of = frame.participantFrames[String(oppId)];
  if (!mf || !of) return null;

  const csOf = (f: typeof mf) => f.minionsKilled + f.jungleMinionsKilled;
  const goldDiff = mf.totalGold - of.totalGold;
  const xpDiff = mf.xp - of.xp;
  const csDiff = csOf(mf) - csOf(of);

  let killsVsOpp = 0;
  let assistsVsOpp = 0;
  let deathsToOpp = 0;
  let platesTaken = 0;
  const cutoff = atMinute * 60000;
  for (const fr of frames) {
    for (const e of fr.events) {
      if (e.timestamp > cutoff) continue;
      if (e.type === "CHAMPION_KILL") {
        if (e.killerId === myId && e.victimId === oppId) killsVsOpp++;
        else if (e.killerId === oppId && e.victimId === myId) deathsToOpp++;
        else if (
          e.victimId === oppId &&
          (e.assistingParticipantIds ?? []).includes(myId)
        ) {
          assistsVsOpp++;
        }
      } else if (e.type === "TURRET_PLATE_DESTROYED" && e.killerId === myId) {
        platesTaken++;
      }
    }
  }

  // Gold-equivalent lead. Gold already includes CS/kills/plates; xp adds the
  // level lead at ~0.5g/xp. Squashed to 0-100 with tanh so 50 = even.
  // LANE_SCALE calibrated against OP.GG datapoints: Quinn laneAdv 2404 -> 66:34
  // and DrMundo laneAdv 1393 -> 60:40 both land with ~7050.
  const LANE_SCALE = 7050;
  const laneAdvantage = goldDiff + 0.5 * xpDiff;
  const score = Math.max(
    0,
    Math.min(100, Math.round(50 + 50 * Math.tanh(laneAdvantage / LANE_SCALE))),
  );

  return {
    opponent: opp.championName,
    role,
    atMinute,
    goldDiff,
    csDiff,
    xpDiff,
    killsVsOpp,
    assistsVsOpp,
    deathsToOpp,
    platesTaken,
    score,
    split: `${score}:${100 - score}`,
  };
}
