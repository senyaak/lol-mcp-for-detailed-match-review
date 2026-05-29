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
    itemsPromise = (async () => {
      const version = await latestVersion();
      const data = await fetchJson<{ data: Record<string, { name: string }> }>(
        `${DDRAGON}/cdn/${version}/data/${LOCALE}/item.json`,
      );
      const map: Record<number, string> = {};
      for (const [id, item] of Object.entries(data.data)) {
        map[Number(id)] = item.name;
      }
      return map;
    })().catch((e) => {
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
