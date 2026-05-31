# 🎮 lol-mcp-for-detailed-match-review

Self-hosted **Model Context Protocol** server that gives Claude (or any MCP
client) **detailed League of Legends match data** to analyze — full per-player
breakdowns, ranked context for the whole lobby, match timelines, an OP.GG-style
laning score, crowd-control contribution, and per-game LP tracking — straight
from the official Riot API. 🐉

Run it yourself with your own Riot API key, point your MCP client at it, and ask
things like *"analyze my last game — how did I play the lane and how much LP did
I gain?"* 🧠

## 🛠️ Tools

| Tool | What it does |
| --- | --- |
| `get_recent_matches` | Lists a player's recent games as compact one-line summaries (champion, role, win/loss, KDA, CS/min, date). Paginated via `start` + `count`; the response includes `nextStart` to page further back. |
| `get_match_detail` | Full distilled detail of one match: both teams, every player's champion/role/KDA/CS/gold/damage/vision/items, team objectives, target player highlighted. Defaults to the most recent match; pass `matchId` for any match or `index` for the Nth most recent. |

### ✨ `get_match_detail` enrichments (all on by default)

| Flag | Adds | Cost |
| --- | --- | --- |
| `names` | Item/rune/spell ids resolved to readable names via Data Dragon. | cached static |
| `ranks` | Each of the 10 players' ranked tier/division/LP + split winrate & hot streak (League-V4). | ~10 calls |
| `mastery` | Each player's mastery level + points on the champion they played (Champion-Mastery-V4). | ~10 calls |
| `timeline` | Per-minute gold/xp/cs/level/damage snapshots (one per game minute) + a log of kill/objective/tower events, **and** the target's `laning` score. | 1 call |
| `history` | Rough recent form for **all 10** players: last N games as champion / score / win-loss (remakes flagged). Default 5, max 10, 0 = off. | ~N+1 calls/player |

All enrichments are best-effort: a failing sub-request is noted in `_warnings`
rather than failing the call. Set a flag to `false` (or `history: 0`) to save
Riot API rate limit.

### 🔍 Notable fields

**Every player** carries `ccScore` — `{ timeCCingOthers, totalTimeCCDealt }`
(raw Riot fields, no extra calls): `timeCCingOthers` = seconds of real hard-CC
lockdown; `totalTimeCCDealt` = Riot's weighted total (inflated by slows — read
the first for "how much I locked enemies down").

**Timeline events** carry structured fields next to the human-readable `detail`:
`killer` / `victim` / `assists[]` for kills, `killer` / `assists[]` / `team` for
objectives — so you can filter (e.g. "when did I die") without parsing strings.
`killerId 0` (minions/turret/execution) is labelled `minions/turret`.

**The target** additionally gets:

- 📊 `laning` — OP.GG-style lane score vs the same-role opponent at ~14 min:
  `goldDiff / csDiff / xpDiff`, `killsVsOpp / assistsVsOpp / deathsToOpp`,
  `platesTaken`, and a `score` (0-100, 50 = even) + `split` (e.g. `"66:34"`).
  Score is `50 + 50·tanh((goldDiff + 0.5·xpDiff) / 7050)` — gold+xp based
  (CS/kills/plates already live in gold, so no double-count) and role-agnostic
  (works for supports/junglers; CS is reported raw but not scored).
- 💎 `lpChange` — LP gained/lost for that specific ranked game
  (`{ delta, sinceGames, tier, rank, lp }`), filled by the LP poller (below).

### 🛡️ Reliability

- **Rate limiting:** in-process concurrency cap (8) keeps load under the dev-key
  limits (20 req/s, 100 req/2min).
- **Retries:** 429s honour `Retry-After`; 5xx / network errors retry with
  exponential backoff + jitter (up to 4 attempts). 401/403/404 fail fast.
- **Cache (cache-first):** finished matches & timelines (immutable), Riot ID →
  PUUID (1d), ranks (10m), mastery (30m), Data Dragon (process lifetime).
  In-flight identical requests are de-duplicated. **Match history (id lists) is
  never cached** — always fresh. Cache size is reported at `/health`.
- **Disk persistence:** immutable matches & timelines are written to
  `<project>/.cache` (override with `CACHE_DIR`) and preloaded on startup, so
  they survive restarts. Expired/corrupt files are pruned on load.

### 💎 LP tracker (per-game)

Riot exposes no per-match LP, only a current snapshot. A poller **inside the
server process** (no separate service) samples League-V4 every `LP_POLL_MINUTES`
(default 10) for the players in `LP_TRACK` (default = `DEFAULT_RIOT_ID`, comma-
separated for several) and attributes each LP delta to the newest ranked match
id. Polling faster than a game lasts means each poll usually sees exactly one new
game, so `target.lpChange` is **per-game** (`sinceGames: 1`), not a running
total. Promotions are handled via a continuous ladder value (Bronze I 98 →
Silver IV 56 reads +58, not −42). Snapshots persist to `.cache/lp-history.json`.
Forward-only — there's no LP history before the poller first runs.

## ⚙️ Setup

```bash
npm install
npm run build
```

Get a Riot API key at <https://developer.riotgames.com> and set it as
`RIOT_API_KEY` (copy `.env.example` to `.env`). Personal/dev keys expire every
24h; request a production key for persistent use. 🔑

### 🌱 Environment

| Var | Purpose |
| --- | --- |
| `RIOT_API_KEY` | Riot API key (required). |
| `DEFAULT_RIOT_ID` | Player used when a tool gets no `riotId`. **Quote it** (`"Name#TAG"`) — `#` is a comment in `.env`. |
| `DEFAULT_REGION` | Regional routing cluster: `europe` (default) / `americas` / `asia` / `sea`. |
| `PORT` | HTTP port (default 3849). |
| `CACHE_DIR` | On-disk cache directory (default `<project>/.cache`). |
| `MCP_MAX_RESULT_SIZE` | Client result-size cap (chars) advertised on `get_match_detail` via `_meta` so per-minute timelines aren't truncated (default 500000). |
| `LP_POLL_MINUTES` | LP poll interval in minutes (default 10). |
| `LP_TRACK` | Riot IDs to track LP for, comma-separated (default = `DEFAULT_RIOT_ID`). |

A player is passed to the tools as a **Riot ID** (`GameName#TAG`, e.g.
`Faker#KR1`), or omitted to fall back to `DEFAULT_RIOT_ID`.

## ▶️ Run

The server speaks **stateless Streamable HTTP** (a fresh transport per request,
no session id), which is what MCP clients — including the claude.ai custom
connector — accept most reliably.

```bash
npm start          # listens on http://localhost:3849/mcp  (set PORT to override)
```

Endpoints: `POST/GET/DELETE /mcp` (MCP protocol; also served on `/` as a
fallback), `GET /health`.

### 🔌 Connecting an MCP client

- **Local clients:** point them at `http://localhost:3849/mcp`.
- **Remote (e.g. claude.ai custom connector):** expose the server over HTTPS with
  any tunnel or reverse proxy (Cloudflare Tunnel, ngrok, Caddy, nginx…) and use
  `https://<your-host>/mcp`.

> ⚠️ Always include the **`/mcp` path** in the connector URL. Pointed at the bare
> host, the claude.ai connector posts to `/`, the 404 makes it assume auth is
> required, and it fails with *"Couldn't register with … sign-in service"*.

### ♻️ Keeping it running

For the LP poller to capture games continuously, keep the process alive with a
process manager (systemd, pm2, Docker, …). Restarting the server does not require
restarting your tunnel — tunnels reconnect to the origin on their own.

## 💬 Example prompts

- "Analyze my last game." (uses `DEFAULT_RIOT_ID`)
- "How did I play the lane in my last match, and how much LP did I gain?"
- "Show the last 5 ranked games for `Faker#KR1` (queue 420)."
- "Break down match `EUW1_1234567890` — draft, objectives, and timeline timings."
- "Compare my crowd-control contribution to the enemy support."

## 📄 License

MIT
