/**
 * Cache with per-entry TTL, in-flight de-duplication, and optional disk
 * persistence for immutable data (finished matches / timelines) so it survives
 * restarts.
 *
 * We cache the *promise*, not just the resolved value, so concurrent callers
 * asking for the same key (e.g. the same match needed by several players'
 * histories) share a single network request. A rejected promise is evicted so
 * the next call retries instead of caching the failure.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Entry {
  promise: Promise<unknown>;
  expires: number;
}

const store = new Map<string, Entry>();

const NEVER = Number.MAX_SAFE_INTEGER;

export const TTL = {
  /** Finished matches / timelines never change. */
  immutable: 7 * 24 * 60 * 60 * 1000,
  /** Riot ID -> PUUID is effectively stable. */
  account: 24 * 60 * 60 * 1000,
  /** Ranked standings move game to game. */
  ranks: 10 * 60 * 1000,
  /** Mastery only changes when the player replays the champ. */
  mastery: 30 * 60 * 1000,
} as const;

/** Cache directory. Read lazily so a CACHE_DIR set via .env is honoured. */
function cacheDir(): string {
  return (
    process.env.CACHE_DIR ??
    join(dirname(fileURLToPath(import.meta.url)), "..", ".cache")
  );
}

function keyToFile(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

interface DiskRecord {
  key: string;
  expires: number;
  value: unknown;
}

function persistToDisk(key: string, expires: number, value: unknown): void {
  const file = join(cacheDir(), keyToFile(key));
  // Fire-and-forget; a failed write just means a cache miss next time.
  void writeFile(
    file,
    JSON.stringify({ key, expires, value } satisfies DiskRecord),
  ).catch(() => {});
}

/** Load all non-expired persisted entries into memory. Call once at startup. */
export function initDiskCache(): { loaded: number } {
  const dir = cacheDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return { loaded: 0 };
  }

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return { loaded: 0 };
  }

  const now = Date.now();
  let loaded = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const rec = JSON.parse(readFileSync(path, "utf8")) as DiskRecord;
      if (rec.expires <= now) {
        rmSync(path, { force: true });
        continue;
      }
      store.set(rec.key, {
        promise: Promise.resolve(rec.value),
        expires: rec.expires,
      });
      loaded++;
    } catch {
      // corrupt / partial file — drop it
      rmSync(path, { force: true });
    }
  }
  return { loaded };
}

export function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  persist = false,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise as Promise<T>;

  const expires = ttlMs >= NEVER ? NEVER : Date.now() + ttlMs;

  const promise = fn()
    .then((value) => {
      if (persist) persistToDisk(key, expires, value);
      return value;
    })
    .catch((err) => {
      // Evict on failure so the next caller retries rather than reusing the error.
      if (store.get(key)?.promise === promise) store.delete(key);
      throw err;
    });

  store.set(key, { promise, expires });
  return promise;
}

export function cacheStats(): { entries: number } {
  return { entries: store.size };
}
