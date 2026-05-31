/**
 * Data Dragon name lookups (items, summoner spells, runes). The data is static
 * per patch, so we fetch each table once and cache it in memory for the process
 * lifetime. All lookups degrade gracefully: if a fetch fails we fall back to the
 * numeric id so enrichment never breaks the tool.
 */

const DDRAGON = "https://ddragon.leagueoflegends.com";
const LOCALE = "en_US";

let versionPromise: Promise<string> | null = null;
let itemsPromise: Promise<Record<number, string>> | null = null;
let spellsPromise: Promise<Record<number, string>> | null = null;
let runesPromise: Promise<Record<number, string>> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Data Dragon ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function latestVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = fetchJson<string[]>(`${DDRAGON}/api/versions.json`)
      .then((v) => v[0])
      .catch((e) => {
        versionPromise = null; // allow retry on a later call
        throw e;
      });
  }
  return versionPromise;
}

async function loadItems(): Promise<Record<number, string>> {
  if (!itemsPromise) {
    // Derive names from the full item table so item.json is fetched only once.
    itemsPromise = loadItemData()
      .then((data) => {
        const map: Record<number, string> = {};
        for (const [id, item] of Object.entries(data)) {
          map[Number(id)] = item.name;
        }
        return map;
      })
      .catch((e) => {
        itemsPromise = null;
        throw e;
      });
  }
  return itemsPromise;
}

async function loadSpells(): Promise<Record<number, string>> {
  if (!spellsPromise) {
    spellsPromise = (async () => {
      const version = await latestVersion();
      const data = await fetchJson<{
        data: Record<string, { key: string; name: string }>;
      }>(`${DDRAGON}/cdn/${version}/data/${LOCALE}/summoner.json`);
      const map: Record<number, string> = {};
      for (const spell of Object.values(data.data)) {
        map[Number(spell.key)] = spell.name;
      }
      return map;
    })().catch((e) => {
      spellsPromise = null;
      throw e;
    });
  }
  return spellsPromise;
}

async function loadRunes(): Promise<Record<number, string>> {
  if (!runesPromise) {
    runesPromise = (async () => {
      const version = await latestVersion();
      const trees = await fetchJson<
        {
          id: number;
          name: string;
          slots: { runes: { id: number; name: string }[] }[];
        }[]
      >(`${DDRAGON}/cdn/${version}/data/${LOCALE}/runesReforged.json`);
      const map: Record<number, string> = {};
      for (const tree of trees) {
        map[tree.id] = tree.name; // style id (e.g. Domination)
        for (const slot of tree.slots) {
          for (const rune of slot.runes) map[rune.id] = rune.name;
        }
      }
      return map;
    })().catch((e) => {
      runesPromise = null;
      throw e;
    });
  }
  return runesPromise;
}

export interface NameTables {
  items: Record<number, string>;
  spells: Record<number, string>;
  runes: Record<number, string>;
}

/** Load all name tables in parallel. Any table that fails resolves to empty. */
export async function loadNameTables(): Promise<NameTables> {
  const [items, spells, runes] = await Promise.all([
    loadItems().catch(() => ({}) as Record<number, string>),
    loadSpells().catch(() => ({}) as Record<number, string>),
    loadRunes().catch(() => ({}) as Record<number, string>),
  ]);
  return { items, spells, runes };
}

export function itemName(tables: NameTables, id: number): string {
  return tables.items[id] ?? `Item#${id}`;
}

export function spellName(tables: NameTables, id: number): string {
  return tables.spells[id] ?? `Spell#${id}`;
}

export function runeName(tables: NameTables, id: number): string {
  return tables.runes[id] ?? `Rune#${id}`;
}

// --- Detailed item / rune lookups (stats, effects). -------------------------
// Match detail only carries names; these let a client pull the actual stats and
// ability text on demand. Full per-patch tables are fetched once and cached.

/** Strip Data Dragon's HTML/markup tags, keeping readable text. */
function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(li|p)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface RawItem {
  name: string;
  plaintext?: string;
  description?: string;
  colloq?: string;
  from?: string[];
  into?: string[];
  gold?: { base: number; total: number; sell: number; purchasable: boolean };
  tags?: string[];
  stats?: Record<string, number>;
}

interface RawRuneTree {
  id: number;
  key: string;
  name: string;
  slots: {
    runes: {
      id: number;
      key: string;
      name: string;
      shortDesc: string;
      longDesc: string;
    }[];
  }[];
}

let itemDataPromise: Promise<Record<string, RawItem>> | null = null;
let runeTreesPromise: Promise<RawRuneTree[]> | null = null;

function loadItemData(): Promise<Record<string, RawItem>> {
  if (!itemDataPromise) {
    itemDataPromise = (async () => {
      const version = await latestVersion();
      const data = await fetchJson<{ data: Record<string, RawItem> }>(
        `${DDRAGON}/cdn/${version}/data/${LOCALE}/item.json`,
      );
      return data.data;
    })().catch((e) => {
      itemDataPromise = null;
      throw e;
    });
  }
  return itemDataPromise;
}

let buildItemsPromise: Promise<Set<number>> | null = null;

/**
 * Ids of "build" items for the current patch — every purchasable item that is
 * not a consumable (potions, wards, elixirs, biscuits) or trinket. Components
 * are kept, so the timeline shows the full build path (e.g. an early anti-heal
 * component) — only wards and potions are filtered out.
 */
export function loadBuildItemIds(): Promise<Set<number>> {
  if (!buildItemsPromise) {
    buildItemsPromise = loadItemData()
      .then((data) => {
        const set = new Set<number>();
        for (const [id, it] of Object.entries(data)) {
          const tags = it.tags ?? [];
          const purchasable = it.gold?.purchasable !== false;
          if (purchasable && !tags.includes("Consumable") && !tags.includes("Trinket")) {
            set.add(Number(id));
          }
        }
        return set;
      })
      .catch((e) => {
        buildItemsPromise = null;
        throw e;
      });
  }
  return buildItemsPromise;
}

function loadRuneTrees(): Promise<RawRuneTree[]> {
  if (!runeTreesPromise) {
    runeTreesPromise = (async () => {
      const version = await latestVersion();
      return fetchJson<RawRuneTree[]>(
        `${DDRAGON}/cdn/${version}/data/${LOCALE}/runesReforged.json`,
      );
    })().catch((e) => {
      runeTreesPromise = null;
      throw e;
    });
  }
  return runeTreesPromise;
}

export interface ItemInfo {
  query: string;
  id: number;
  name: string;
  summary?: string;
  description: string;
  stats: Record<string, number>;
  cost?: { total: number; base: number; sell: number };
  tags?: string[];
  buildsFrom?: string[];
  buildsInto?: string[];
}

export interface RuneInfo {
  query: string;
  id: number;
  name: string;
  tree: string; // e.g. Precision, Domination
  slot: number; // 0 = keystone row, 1..3 = minor rows
  shortDesc: string;
  longDesc: string;
}

/** Look up full item details by name (case-insensitive) or numeric id. */
export async function lookupItems(
  queries: string[],
): Promise<(ItemInfo | { query: string; notFound: true })[]> {
  const data = await loadItemData();
  // name (lowercased) -> id
  const byName = new Map<string, string>();
  for (const [id, item] of Object.entries(data)) {
    // First write wins: base Summoner's Rift items (lower ids) come before
    // Arena/variant duplicates (2xxxxx) that reuse the same display name.
    const key = item.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  const idOf = (q: string): string | null => {
    const t = q.trim();
    if (/^\d+$/.test(t) && data[t]) return t;
    return byName.get(t.toLowerCase()) ?? null;
  };
  return queries.map((query) => {
    const id = idOf(query);
    if (!id) return { query, notFound: true as const };
    const it = data[id];
    return {
      query,
      id: Number(id),
      name: it.name,
      summary: it.plaintext || undefined,
      description: it.description ? stripHtml(it.description) : "",
      stats: it.stats ?? {},
      cost: it.gold
        ? { total: it.gold.total, base: it.gold.base, sell: it.gold.sell }
        : undefined,
      tags: it.tags,
      buildsFrom: it.from?.map((f) => data[f]?.name ?? `Item#${f}`),
      buildsInto: it.into?.map((f) => data[f]?.name ?? `Item#${f}`),
    };
  });
}

/** Look up rune effect text by name (case-insensitive) or numeric id. */
export async function lookupRunes(
  queries: string[],
): Promise<(RuneInfo | { query: string; notFound: true })[]> {
  const trees = await loadRuneTrees();
  // build name/id index with tree + slot context
  type Entry = { info: Omit<RuneInfo, "query">; nameKey: string };
  const entries: Entry[] = [];
  for (const tree of trees) {
    tree.slots.forEach((slot, slotIdx) => {
      for (const rune of slot.runes) {
        entries.push({
          nameKey: rune.name.toLowerCase(),
          info: {
            id: rune.id,
            name: rune.name,
            tree: tree.name,
            slot: slotIdx,
            shortDesc: stripHtml(rune.shortDesc),
            longDesc: stripHtml(rune.longDesc),
          },
        });
      }
    });
  }
  return queries.map((query) => {
    const t = query.trim();
    const hit = /^\d+$/.test(t)
      ? entries.find((e) => e.info.id === Number(t))
      : entries.find((e) => e.nameKey === t.toLowerCase());
    return hit ? { query, ...hit.info } : { query, notFound: true as const };
  });
}

// --- Champion details (abilities, stats). -----------------------------------

interface RawChampSpell {
  name: string;
  description: string;
  cooldownBurn: string; // e.g. "16/14/12/10/8"
  costBurn: string; // e.g. "30" or "70/80/90/100/110"
  rangeBurn: string; // e.g. "300"
}

interface RawChampDetail {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
  partype?: string; // resource: Mana / Energy / ...
  passive: { name: string; description: string };
  spells: RawChampSpell[];
  stats: Record<string, number>;
}

let champListPromise: Promise<Map<string, string>> | null = null;
const champDetailCache = new Map<string, Promise<RawChampDetail>>();

/** name/displayName (lowercased) -> champion id (e.g. "wukong" -> "MonkeyKing"). */
function loadChampList(): Promise<Map<string, string>> {
  if (!champListPromise) {
    champListPromise = (async () => {
      const version = await latestVersion();
      const data = await fetchJson<{
        data: Record<string, { id: string; name: string }>;
      }>(`${DDRAGON}/cdn/${version}/data/${LOCALE}/champion.json`);
      const map = new Map<string, string>();
      for (const champ of Object.values(data.data)) {
        map.set(champ.id.toLowerCase(), champ.id); // internal id, e.g. MonkeyKing
        map.set(champ.name.toLowerCase(), champ.id); // display name, e.g. Wukong
      }
      return map;
    })().catch((e) => {
      champListPromise = null;
      throw e;
    });
  }
  return champListPromise;
}

function loadChampDetail(id: string): Promise<RawChampDetail> {
  let p = champDetailCache.get(id);
  if (!p) {
    p = (async () => {
      const version = await latestVersion();
      const data = await fetchJson<{ data: Record<string, RawChampDetail> }>(
        `${DDRAGON}/cdn/${version}/data/${LOCALE}/champion/${id}.json`,
      );
      return data.data[id];
    })().catch((e) => {
      champDetailCache.delete(id);
      throw e;
    });
    champDetailCache.set(id, p);
  }
  return p;
}

export interface ChampionInfo {
  query: string;
  name: string;
  title: string;
  roles: string[];
  resource?: string;
  passive: { name: string; description: string };
  abilities: {
    slot: "Q" | "W" | "E" | "R";
    name: string;
    description: string;
    cooldown: string;
    cost: string;
    range: string;
  }[];
  baseStats: Record<string, number>;
}

const SPELL_SLOTS = ["Q", "W", "E", "R"] as const;

/** Look up champion abilities/stats by champion id or display name. */
export async function lookupChampions(
  queries: string[],
): Promise<(ChampionInfo | { query: string; notFound: true })[]> {
  const list = await loadChampList();
  return Promise.all(
    queries.map(async (query) => {
      const id = list.get(query.trim().toLowerCase());
      if (!id) return { query, notFound: true as const };
      const c = await loadChampDetail(id);
      return {
        query,
        name: c.name,
        title: c.title,
        roles: c.tags,
        resource: c.partype || undefined,
        passive: {
          name: c.passive.name,
          description: stripHtml(c.passive.description),
        },
        abilities: c.spells.slice(0, 4).map((s, i) => ({
          slot: SPELL_SLOTS[i],
          name: s.name,
          description: stripHtml(s.description),
          cooldown: s.cooldownBurn,
          cost: s.costBurn,
          range: s.rangeBurn,
        })),
        baseStats: c.stats,
      };
    }),
  );
}
