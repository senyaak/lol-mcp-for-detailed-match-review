#!/usr/bin/env node
/**
 * lol-mcp — an MCP server that fetches detailed League of Legends match data
 * from the Riot API so Claude can analyze it. Served over Streamable HTTP so it
 * can be exposed publicly through a cloudflare tunnel.
 *
 * Tools:
 *   get_recent_matches — list a player's recent games (one-line summaries)
 *   get_match_detail   — full distilled detail of one match (last by default)
 *
 * Requires env RIOT_API_KEY (https://developer.riotgames.com).
 * Listens on PORT (default 3849) at /mcp; health check at /health.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load .env (Node >=20.6) from the project root, regardless of the cwd we are
// launched with. Env vars already set by the host still take priority.
try {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (!process.env.RIOT_API_KEY) process.loadEnvFile(join(projectRoot, ".env"));
} catch {
  /* no .env file — rely on the ambient environment */
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

import {
  getAccountByRiotId,
  getChampionMastery,
  getLeagueEntriesByPuuid,
  getMatch,
  getMatchIds,
  getMatchTimeline,
  REGIONS,
  RiotApiError,
  type RawMatch,
  type Region,
} from "./riot.js";
import {
  computeLaning,
  distillMastery,
  distillMatch,
  distillRank,
  distillTimeline,
  roughForm,
  summarizeForTarget,
  type DistilledMatch,
} from "./format.js";
import { loadNameTables, type NameTables } from "./ddragon.js";
import { cacheStats, initDiskCache } from "./cache.js";
import { getLpForMatch, recordPoll } from "./lptracker.js";

/** Ranked queue id -> the rank queue label we track. */
const RANKED_QUEUES: Record<number, "Solo" | "Flex"> = {
  420: "Solo",
  440: "Flex",
};

const PORT = Number(process.env.PORT) || 3849;

// Client result-size cap advertised on get_match_detail via _meta. Per-minute
// timeline snapshots make the payload large, so raise it from the client default.
const MAX_RESULT_SIZE = Number(process.env.MCP_MAX_RESULT_SIZE) || 500000;

// Defaults from the environment so the player/region aren't hardcoded.
const DEFAULT_RIOT_ID = process.env.DEFAULT_RIOT_ID?.trim() || undefined;
const DEFAULT_REGION: Region = (REGIONS as string[]).includes(
  process.env.DEFAULT_REGION ?? "",
)
  ? (process.env.DEFAULT_REGION as Region)
  : "europe";

/**
 * Resolve the Riot ID to use: the explicit argument, else DEFAULT_RIOT_ID env.
 * Throws a helpful error if neither is available.
 */
function resolveRiotId(provided?: string): { gameName: string; tagLine: string } {
  const riotId = provided?.trim() || DEFAULT_RIOT_ID;
  if (!riotId) {
    throw new Error(
      "No Riot ID provided and DEFAULT_RIOT_ID env is not set. Pass riotId as \"GameName#TAG\".",
    );
  }
  const hash = riotId.lastIndexOf("#");
  if (hash <= 0 || hash === riotId.length - 1) {
    throw new Error(
      `Invalid Riot ID "${riotId}". Expected format "GameName#TAG", e.g. "Faker#KR1".`,
    );
  }
  return {
    gameName: riotId.slice(0, hash).trim(),
    tagLine: riotId.slice(hash + 1).trim(),
  };
}

const regionSchema = z
  .enum(REGIONS as [Region, ...Region[]])
  .default(DEFAULT_REGION)
  .describe(
    "Regional routing cluster. EUW/EUNE/RU/TR -> europe; NA/BR/LAN/LAS -> americas; KR/JP -> asia; OCE/SEA -> sea.",
  );

const riotIdSchema = z
  .string()
  .optional()
  .describe(
    'Riot ID in "GameName#TAG" form, e.g. "Faker#KR1". Optional — falls back to the DEFAULT_RIOT_ID env var.',
  );

function asText(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function asError(err: unknown) {
  const message =
    err instanceof RiotApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

interface EnrichOptions {
  names: boolean;
  ranks: boolean;
  mastery: boolean;
  timeline: boolean;
  /** How many recent games of rough form (champ/score/W-L) to attach per player. 0 = off. */
  history: number;
}

/**
 * Distill a match and optionally enrich it with Data Dragon names, per-player
 * ranks + champion mastery, and a timeline. Every enrichment is best-effort:
 * a failing sub-request (rate limit, missing data) is recorded in `_warnings`
 * rather than failing the whole tool.
 */
async function buildMatchDetail(
  region: Region,
  match: RawMatch,
  targetPuuid: string,
  opts: EnrichOptions,
  isLatest: boolean,
): Promise<DistilledMatch & { _warnings?: string[] }> {
  const warnings: string[] = [];
  const platformId = match.info.platformId;

  let tables: NameTables | null = null;
  if (opts.names) {
    try {
      tables = await loadNameTables();
    } catch {
      warnings.push("name lookup (Data Dragon) unavailable; using numeric ids");
    }
  }

  const detail = distillMatch(match, targetPuuid, tables);
  const allPlayers = detail.teams.flatMap((t) => t.players);

  // Ranks for all players (League-V4, platform routing).
  if (opts.ranks) {
    const results = await Promise.allSettled(
      allPlayers.map((p) => getLeagueEntriesByPuuid(platformId, p.puuid)),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const ranked = r.value
          .filter(
            (e) =>
              e.queueType === "RANKED_SOLO_5x5" ||
              e.queueType === "RANKED_FLEX_SR",
          )
          .map(distillRank);
        allPlayers[i].ranks = ranked.length ? ranked : [];
      }
    });
    if (results.some((r) => r.status === "rejected")) {
      warnings.push("some ranks could not be fetched");
    }

    // Per-match LP. Recorded by the background poller, but when viewing the
    // latest ranked game we also do a live observation right now so a
    // just-finished game shows its LP immediately (no waiting for the next poll).
    const queue = RANKED_QUEUES[match.info.queueId];
    if (detail.target && queue) {
      if (isLatest && !getLpForMatch(match.metadata.matchId)) {
        try {
          const fresh = await getLeagueEntriesByPuuid(
            platformId,
            targetPuuid,
            true,
          );
          const qType = queue === "Solo" ? "RANKED_SOLO_5x5" : "RANKED_FLEX_SR";
          const e = fresh.find((x) => x.queueType === qType);
          if (e) {
            recordPoll(
              targetPuuid,
              queue,
              e.tier,
              e.rank,
              e.leaguePoints,
              e.wins,
              e.losses,
              match.metadata.matchId,
            );
          }
        } catch {
          /* live LP refresh is best-effort */
        }
      }
      const rec = getLpForMatch(match.metadata.matchId);
      if (rec) {
        detail.target.lpChange = {
          delta: rec.delta,
          sinceGames: rec.sinceGames,
          tier: rec.tier,
          rank: rec.rank,
          lp: rec.lp,
        };
      }
    }
  }

  // Champion mastery for each player on the champ they played.
  if (opts.mastery) {
    const champIdByPuuid = new Map(
      match.info.participants.map((p) => [p.puuid, p.championId]),
    );
    const results = await Promise.allSettled(
      allPlayers.map((p) =>
        getChampionMastery(platformId, p.puuid, champIdByPuuid.get(p.puuid)!),
      ),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        allPlayers[i].championMastery = distillMastery(r.value);
      }
    });
    // Mastery 404s for never-played champs are expected — only warn on others.
    if (
      results.some(
        (r) =>
          r.status === "rejected" &&
          !String((r as PromiseRejectedResult).reason?.message).includes("404"),
      )
    ) {
      warnings.push("some champion mastery could not be fetched");
    }
  }

  // Timeline (Match-V5, regional routing). Also yields the laning score, which
  // needs the per-minute frames.
  if (opts.timeline) {
    try {
      const tl = await getMatchTimeline(region, match.metadata.matchId);
      detail.timeline = distillTimeline(tl, match);
      if (detail.target) {
        const laning = computeLaning(tl, match, targetPuuid);
        if (laning) detail.target.laning = laning;
      }
    } catch {
      warnings.push("timeline unavailable");
    }
  }

  // Rough recent form for each player: last N games as champ / score / W-L.
  // Match-id lists are always fresh; the matches themselves come from cache.
  if (opts.history > 0) {
    const results = await Promise.allSettled(
      allPlayers.map(async (p) => {
        const ids = await getMatchIds(region, p.puuid, { count: opts.history });
        const games = await Promise.all(
          ids.map((id) =>
            getMatch(region, id)
              .then((m) => roughForm(m, p.puuid))
              .catch(() => null),
          ),
        );
        return games.filter((g) => g != null);
      }),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") allPlayers[i].recentForm = r.value;
    });
    if (results.some((r) => r.status === "rejected")) {
      warnings.push("some player histories could not be fetched");
    }
  }

  return warnings.length ? { ...detail, _warnings: warnings } : detail;
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "get_recent_matches",
    {
      title: "List recent matches",
      description:
        "List a player's most recent ranked/normal games as compact one-line summaries " +
        "(champion, role, win/loss, KDA, CS/min, date). Use this to pick a match, then " +
        "call get_match_detail for the full breakdown.",
      inputSchema: {
        riotId: riotIdSchema,
        region: regionSchema,
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("How many recent matches to list per page (1-20)."),
        start: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Pagination offset: index of the first match to return (0 = most recent). Use start += count to page back through history.",
          ),
        queue: z
          .number()
          .int()
          .optional()
          .describe(
            "Optional queue filter, e.g. 420 (ranked solo), 450 (ARAM).",
          ),
      },
    },
    async ({ riotId, region, count, start, queue }) => {
      try {
        const { gameName, tagLine } = resolveRiotId(riotId);
        const account = await getAccountByRiotId(region, gameName, tagLine);
        const ids = await getMatchIds(region, account.puuid, {
          start,
          count,
          queue,
        });
        const matches = await Promise.all(ids.map((id) => getMatch(region, id)));
        const summaries = matches
          .map((m) => summarizeForTarget(m, account.puuid))
          .filter((s) => s != null);
        return asText({
          player: `${account.gameName}#${account.tagLine}`,
          region,
          page: { start, count, returned: summaries.length },
          // Hint for paging back through history.
          nextStart: summaries.length === count ? start + count : null,
          matches: summaries,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_match_detail",
    {
      title: "Get detailed match data",
      // Per-minute timeline snapshots make this payload large; raise the client
      // result-size cap so full matches aren't truncated (MCP_MAX_RESULT_SIZE).
      _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_SIZE },
      description:
        "Fetch the full distilled detail of one match for analysis: both teams, every " +
        "player's champion/role/KDA/CS/gold/damage/vision/items, team objectives, and the " +
        "target player highlighted. Enriched (all on by default) with readable item/rune/spell " +
        "names, every player's ranked tier + champion mastery, and a per-minute timeline " +
        "(gold/xp/cs snapshots + kill/objective/tower events). By default returns the player's " +
        "most recent match. Pass `matchId` for a specific match, or `index` for the Nth most recent. " +
        "Disable enrichments to save Riot API rate limit if needed.",
      inputSchema: {
        riotId: riotIdSchema,
        region: regionSchema,
        matchId: z
          .string()
          .optional()
          .describe(
            "Specific match ID (e.g. 'EUW1_1234567890'). If omitted, uses the player's recent matches.",
          ),
        index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Which recent match to fetch when matchId is omitted. 0 = most recent (default).",
          ),
        names: z
          .boolean()
          .default(true)
          .describe("Resolve item/rune/spell ids to readable names (Data Dragon)."),
        ranks: z
          .boolean()
          .default(true)
          .describe("Include each player's ranked tier/LP/winrate (~10 extra calls)."),
        mastery: z
          .boolean()
          .default(true)
          .describe("Include each player's mastery on the champ they played (~10 extra calls)."),
        timeline: z
          .boolean()
          .default(true)
          .describe("Include per-minute gold/xp/cs snapshots and kill/objective/tower events."),
        history: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(5)
          .describe(
            "Recent games of rough form (champ/score/win-loss) to attach per player, all 10 players. 0 = off. Heavier on a cold cache.",
          ),
      },
    },
    async ({
      riotId,
      region,
      matchId,
      index,
      names,
      ranks,
      mastery,
      timeline,
      history,
    }) => {
      try {
        const { gameName, tagLine } = resolveRiotId(riotId);
        const account = await getAccountByRiotId(region, gameName, tagLine);

        let id = matchId;
        if (!id) {
          const ids = await getMatchIds(region, account.puuid, {
            start: index,
            count: 1,
          });
          if (ids.length === 0) {
            throw new Error(
              `No match found at index ${index} for ${account.gameName}#${account.tagLine}.`,
            );
          }
          id = ids[0];
        }

        const isLatest = !matchId && index === 0;
        const match = await getMatch(region, id);
        const detail = await buildMatchDetail(
          region,
          match,
          account.puuid,
          { names, ranks, mastery, timeline, history },
          isLatest,
        );
        return asText(detail);
      } catch (err) {
        return asError(err);
      }
    },
  );
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "lol-mcp", version: "0.1.0" },
    {
      instructions:
        "MCP server for analyzing League of Legends matches via the Riot API. " +
        "Use get_recent_matches to list a player's games, and get_match_detail for a " +
        "full per-player/per-team breakdown of one match. Player is always a Riot ID " +
        '("GameName#TAG"); region defaults to europe.',
    },
  );
  registerTools(server);
  return server;
}

// --- HTTP transport, stateless Streamable HTTP. -----------------------------
// One fresh transport + server per request, no session id. This is what the
// claude.ai web connector reliably accepts (the stateful/session variant trips
// its OAuth registration flow). Our tools keep no per-session state — the cache
// is module-level and shared — so stateless is a clean fit.

const app = express();
app.use(express.json());

// Log every incoming request (method, path, key headers) so we can see exactly
// what the claude.ai connector probes during connection (oauth discovery, DCR…).
app.use((req, _res, next) => {
  const ua = req.headers["user-agent"] ?? "";
  const auth = req.headers["authorization"] ? " auth" : "";
  console.error(`[req] ${req.method} ${req.originalUrl}${auth} ua="${ua}"`);
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.RIOT_API_KEY),
    cache: cacheStats(),
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createServer();
    await server.connect(transport);
    res.on("close", () => {
      void server.close();
      void transport.close();
    });
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[error]", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "SSE not supported in stateless mode" });
});

app.delete("/mcp", (_req, res) => {
  res.status(200).json({ message: "ok" });
});

// --- Background LP poller ---------------------------------------------------
// Samples tracked players' standing every few minutes and attributes each LP
// delta to the newest ranked match (see lptracker). Runs inside this 24/7
// server — no separate service. Polls faster than a game lasts, so each poll
// almost always sees exactly one new ranked game → exact per-game LP.

const RANKED_QUEUE_TYPES: { id: number; label: "Solo" | "Flex"; type: string }[] =
  [
    { id: 420, label: "Solo", type: "RANKED_SOLO_5x5" },
    { id: 440, label: "Flex", type: "RANKED_FLEX_SR" },
  ];

async function pollLpOnce(region: Region, riotId: string): Promise<void> {
  const { gameName, tagLine } = resolveRiotId(riotId);
  const account = await getAccountByRiotId(region, gameName, tagLine);

  // Latest ranked match id per queue (also gives us the platform for League-V4).
  const latestByQueue: Record<string, string | null> = {};
  let platformId: string | null = null;
  for (const q of RANKED_QUEUE_TYPES) {
    const ids = await getMatchIds(region, account.puuid, {
      queue: q.id,
      count: 1,
    });
    latestByQueue[q.label] = ids[0] ?? null;
    if (!platformId && ids[0]) {
      platformId = (await getMatch(region, ids[0])).info.platformId;
    }
  }
  if (!platformId) return; // no ranked games at all yet

  const entries = await getLeagueEntriesByPuuid(platformId, account.puuid, true);
  for (const q of RANKED_QUEUE_TYPES) {
    const entry = entries.find((e) => e.queueType === q.type);
    if (!entry) continue;
    recordPoll(
      account.puuid,
      q.label,
      entry.tier,
      entry.rank,
      entry.leaguePoints,
      entry.wins,
      entry.losses,
      latestByQueue[q.label],
    );
  }
}

const LP_POLL_MINUTES = Number(process.env.LP_POLL_MINUTES) || 10;
const LP_TRACK = (process.env.LP_TRACK || DEFAULT_RIOT_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function pollAllLp(): Promise<void> {
  for (const rid of LP_TRACK) {
    try {
      await pollLpOnce(DEFAULT_REGION, rid);
    } catch (err) {
      console.error(
        `[lp-poll] ${rid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const { loaded } = initDiskCache();

app.listen(PORT, () => {
  console.error(`lol-mcp server running on http://localhost:${PORT}/mcp`);
  console.error(`Health check: http://localhost:${PORT}/health`);
  console.error(`Disk cache: ${loaded} entries preloaded`);
  if (DEFAULT_RIOT_ID) console.error(`Default Riot ID: ${DEFAULT_RIOT_ID}`);
  if (LP_TRACK.length) {
    console.error(
      `LP poller: every ${LP_POLL_MINUTES}m for ${LP_TRACK.join(", ")}`,
    );
    void pollAllLp(); // baseline now
    setInterval(() => void pollAllLp(), LP_POLL_MINUTES * 60_000);
  }
  if (!process.env.RIOT_API_KEY) {
    console.error("WARNING: RIOT_API_KEY is not set — tool calls will fail.");
  }
});
