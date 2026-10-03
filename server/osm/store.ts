// Magazyn danych OSM: stała siatka kafli, cache sparsowanych kafli na dysku (gzip) i w pamięci (LRU),
// pobieranie brakujących kafli z Overpass oraz scalanie kafli w AreaData z deduplikacją po id.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { AreaData, BBoxLatLon } from '../contracts.ts';
import { KRAKOW_BBOX } from '../../shared/types.ts';
import { toXY } from '../geo/project.ts';
import { overpassQuery } from './overpass.ts';
import { parseOverpass, type ParsedTile } from './parse.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const TILE_LAT_DEG = 0.02;
export const TILE_LON_DEG = 0.03;

/** Zmiana formatu kafla lub reguł parsowania wymaga podbicia wersji — stare pliki zostaną pobrane ponownie. */
const TILE_FORMAT_VERSION = 3;
const MEMORY_TILE_LIMIT = 48;
const MERGED_AREA_LIMIT = 12;
/**
 * Ochrona Overpass przed lawiną zapytań z jednego wywołania loadArea. Limit musi pokrywać największy obszar
 * routingu (8 km po przekątnej + margines z graph/context.ts: do 6 × 5 kafli), inaczej długie trasy poza
 * pobranym wcześniej obszarem byłyby odrzucane na stałe.
 */
export const MAX_TILES_FETCHED_PER_CALL = 36;
/** Tolerancja na błędy zmiennoprzecinkowe przy dzieleniu przez rozmiar kafla (≈ 0,1 mm w terenie). */
const GRID_EPS = 1e-9;

const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/osm');

export class DataUnavailableError extends Error {}

/** Klucz AreaData, gdy dla obszaru nie ma żadnego kafla (możliwe tylko przy cachedOnly). */
export const EMPTY_AREA_KEY = 'empty';

/** Żądany obszar leży poza Krakowem (KRAKOW_BBOX) albo bbox jest niepoprawny. */
export class OutOfAreaError extends Error {}

export interface TileIndex {
  ix: number;
  iy: number;
}

export function tileKey(tile: TileIndex): string {
  return `${tile.ix}_${tile.iy}`;
}

export function tileAt(lat: number, lon: number): TileIndex {
  return { ix: Math.floor(lon / TILE_LON_DEG + GRID_EPS), iy: Math.floor(lat / TILE_LAT_DEG + GRID_EPS) };
}

const roundDeg = (deg: number): number => Math.round(deg * 1e6) / 1e6;

export function tileBBox(tile: TileIndex): BBoxLatLon {
  return {
    west: roundDeg(tile.ix * TILE_LON_DEG),
    south: roundDeg(tile.iy * TILE_LAT_DEG),
    east: roundDeg((tile.ix + 1) * TILE_LON_DEG),
    north: roundDeg((tile.iy + 1) * TILE_LAT_DEG),
  };
}

/** Kafle przecinające bbox (wierszami od południa, w wierszu od zachodu). Krawędź leżąca na linii siatki nie dobiera sąsiada. */
export function tilesForBBox(bbox: BBoxLatLon): TileIndex[] {
  const first = tileAt(bbox.south, bbox.west);
  const lastIx = Math.max(first.ix, Math.ceil(bbox.east / TILE_LON_DEG - GRID_EPS) - 1);
  const lastIy = Math.max(first.iy, Math.ceil(bbox.north / TILE_LAT_DEG - GRID_EPS) - 1);
  const tiles: TileIndex[] = [];
  for (let iy = first.iy; iy <= lastIy; iy++) {
    for (let ix = first.ix; ix <= lastIx; ix++) tiles.push({ ix, iy });
  }
  return tiles;
}

/**
 * Zapytanie Overpass dla kafla. Osobne instrukcje "out": obrysy budynków i zieleń bez list węzłów (mniejsza
 * odpowiedź); drogi z "body" (lista węzłów potrzebna do budowy grafu); relacje też z "body", bo "out tags geom"
 * nie zwraca członków relacji, a z nich składamy pierścienie. Obiekty przecinające granicę kafla wracają w całości.
 * Po drogach: ich węzły z barierą (bramy, furtki) — potrzebne do wykrycia przejść zamkniętych dla pieszych —
 * oraz węzły przejść/sygnalizacji i krawężników (same tagi, bez współrzędnych: wystarczy id węzła na drodze).
 * v2: parki i ogrody (obrysy), fontanny/wiaty/ławki jako obszary oraz węzły punktów chłodu (woda pitna,
 * fontanny, ławki, wiaty, kurtyny wodne rozpoznawane po nazwie).
 */
export function buildTileQuery(bbox: BBoxLatLon): string {
  return [
    `[out:json][timeout:25][bbox:${bbox.south},${bbox.west},${bbox.north},${bbox.east}];`,
    '(way["building"];way["building:part"];way["natural"="tree_row"];way["natural"="wood"];way["landuse"="forest"];' +
      'way["leisure"~"^(park|garden)$"];way["amenity"~"^(fountain|shelter|bench)$"];);',
    'out tags geom qt;',
    '(relation["building"];relation["natural"="wood"];relation["landuse"="forest"];relation["leisure"~"^(park|garden)$"];);',
    'out body geom qt;',
    'way["highway"]->.roads;',
    '.roads out body geom qt;',
    'node(w.roads)["barrier"];',
    'out body qt;',
    '(node(w.roads)["highway"~"^(crossing|traffic_signals)$"];node(w.roads)["crossing"];node(w.roads)["crossing:signals"];' +
      'node(w.roads)["kerb"];node(w.roads)["kerb:height"];);',
    'out tags qt;',
    'node["natural"="tree"];',
    'out body qt;',
    '(node["amenity"~"^(drinking_water|water_point|fountain|bench|shelter)$"];' +
      'node["man_made"~"^(water_tap|drinking_fountain)$"];node["name"~"[Kk]urtyn[ay] wodn"];);',
    'out body qt;',
  ].join('\n');
}

/** Obcina bbox do KRAKOW_BBOX; rzuca OutOfAreaError, gdy bbox jest niepoprawny lub w całości poza miastem. */
export function clampToCity(bbox: BBoxLatLon): BBoxLatLon {
  const values = [bbox.west, bbox.south, bbox.east, bbox.north];
  if (!values.every(Number.isFinite) || bbox.west > bbox.east || bbox.south > bbox.north) {
    throw new OutOfAreaError('Niepoprawny obszar (bbox).');
  }
  const clamped = {
    west: Math.max(bbox.west, KRAKOW_BBOX.west),
    south: Math.max(bbox.south, KRAKOW_BBOX.south),
    east: Math.min(bbox.east, KRAKOW_BBOX.east),
    north: Math.min(bbox.north, KRAKOW_BBOX.north),
  };
  if (clamped.west > clamped.east || clamped.south > clamped.north) {
    throw new OutOfAreaError('Żądany obszar leży poza Krakowem — aplikacja obsługuje tylko Kraków i najbliższe okolice.');
  }
  return clamped;
}

/** Łączy kafle w jeden zestaw; obiekty powtarzające się w sąsiednich kaflach (ten sam id) trafiają do wyniku raz. */
export function mergeTiles(key: string, bboxXY: AreaData['bboxXY'], tiles: ParsedTile[]): AreaData {
  // `?? []`: kafel dostarczony przez własne fetchTile może nie mieć kolekcji dodanych w v2.
  const dedupe = <K, T extends { id: K }>(pick: (tile: ParsedTile) => T[] | undefined): Map<K, T> => {
    const byId = new Map<K, T>();
    for (const tile of tiles) {
      for (const item of pick(tile) ?? []) if (!byId.has(item.id)) byId.set(item.id, item);
    }
    return byId;
  };
  const union = (pick: (tile: ParsedTile) => number[] | undefined): number[] => {
    const ids = new Set<number>();
    for (const tile of tiles) for (const id of pick(tile) ?? []) ids.add(id);
    return [...ids];
  };

  const ways = dedupe((t) => t.ways);
  // Węzły z tagami przychodzą tylko z wnętrza kafla: przejście przecinające granicę może mieć sygnalizację
  // rozpoznaną w jednym kaflu, a w drugim nie — wygrywa informacja pozytywna (kopia; kafle w cache bez zmian).
  for (const tile of tiles) {
    for (const way of tile.ways) {
      const kept = ways.get(way.id);
      if (way.signals && kept && !kept.signals) ways.set(way.id, { ...kept, signals: true });
    }
  }
  return {
    key,
    bboxXY,
    buildings: [...dedupe((t) => t.buildings).values()],
    trees: [...dedupe((t) => t.trees).values()],
    canopies: [...dedupe((t) => t.canopies).values()],
    ways: [...ways.values()],
    blockedNodeIds: union((t) => t.blockedNodeIds),
    coolSpots: [...dedupe((t) => t.coolSpots).values()],
    raisedKerbNodeIds: union((t) => t.raisedKerbNodeIds),
  };
}

interface TileFile {
  v: number;
  key: string;
  fetchedAt: string;
  tile: ParsedTile;
}

export interface OsmStoreOptions {
  /** Katalog cache (domyślnie data/osm w katalogu projektu). */
  dir?: string;
  /** Pobranie i sparsowanie jednego kafla; domyślnie zapytanie do Overpass. */
  fetchTile?: (bbox: BBoxLatLon) => Promise<ParsedTile>;
}

export interface OsmStore {
  loadArea(bbox: BBoxLatLon, opts?: { cachedOnly?: boolean }): Promise<AreaData>;
  /** Zapewnia kafel w cache (pobiera, gdy brak lub w starym formacie). Zwraca informację, skąd pochodzi. */
  ensureTile(tile: TileIndex): Promise<{ tile: ParsedTile; source: 'memory' | 'disk' | 'network' }>;
  hasTileOnDisk(tile: TileIndex): Promise<boolean>;
}

async function fetchTileFromOverpass(bbox: BBoxLatLon): Promise<ParsedTile> {
  const response = await overpassQuery(buildTileQuery(bbox));
  return parseOverpass(response.elements);
}

/** Mapa o ograniczonym rozmiarze; odczyt odświeża pozycję wpisu (LRU). */
class LruMap<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
}

export function createOsmStore(options: OsmStoreOptions = {}): OsmStore {
  const dir = options.dir ?? DEFAULT_DATA_DIR;
  const fetchTile = options.fetchTile ?? fetchTileFromOverpass;
  const memory = new LruMap<ParsedTile>(MEMORY_TILE_LIMIT);
  const merged = new LruMap<AreaData>(MERGED_AREA_LIMIT);
  const inFlight = new Map<string, Promise<ParsedTile>>();

  const filePath = (key: string): string => path.join(dir, `${key}.json.gz`);

  /** Plik w starszej wersji formatu liczy się jak brak kafla (zostanie pobrany od nowa). */
  async function hasTileOnDisk(tile: TileIndex): Promise<boolean> {
    return (await readFromDisk(tileKey(tile))) !== null;
  }

  /** Kafel z dysku albo null (brak pliku, uszkodzony plik lub inna wersja formatu). */
  async function readFromDisk(key: string): Promise<ParsedTile | null> {
    try {
      const raw = await gunzipAsync(await readFile(filePath(key)));
      const file = JSON.parse(raw.toString('utf8')) as TileFile;
      return file.v === TILE_FORMAT_VERSION && file.key === key ? file.tile : null;
    } catch {
      return null;
    }
  }

  async function writeToDisk(key: string, tile: ParsedTile): Promise<void> {
    const file: TileFile = { v: TILE_FORMAT_VERSION, key, fetchedAt: new Date().toISOString(), tile };
    const target = filePath(key);
    // Zapis przez plik tymczasowy + rename, żeby przerwany proces nie zostawił uciętego kafla.
    const temp = `${target}.${process.pid}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(temp, await gzipAsync(JSON.stringify(file)));
    await rename(temp, target);
  }

  async function cachedTile(key: string): Promise<{ tile: ParsedTile; source: 'memory' | 'disk' } | null> {
    const inMemory = memory.get(key);
    if (inMemory) return { tile: inMemory, source: 'memory' };
    const onDisk = await readFromDisk(key);
    if (!onDisk) return null;
    memory.set(key, onDisk);
    return { tile: onDisk, source: 'disk' };
  }

  /** Pobiera kafel z sieci; równoległe żądania tego samego kafla współdzielą jedno zapytanie. */
  function fetchAndStore(tile: TileIndex): Promise<ParsedTile> {
    const key = tileKey(tile);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const parsed = await fetchTile(tileBBox(tile));
        memory.set(key, parsed);
        await writeToDisk(key, parsed);
        return parsed;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new DataUnavailableError(
          `Nie udało się pobrać danych mapy (OpenStreetMap) dla tego obszaru. Spróbuj ponownie za chwilę. [${reason}]`,
        );
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  }

  async function ensureTile(tile: TileIndex): Promise<{ tile: ParsedTile; source: 'memory' | 'disk' | 'network' }> {
    const cached = await cachedTile(tileKey(tile));
    if (cached) return cached;
    return { tile: await fetchAndStore(tile), source: 'network' };
  }

  async function loadArea(bbox: BBoxLatLon, opts: { cachedOnly?: boolean } = {}): Promise<AreaData> {
    const indices = tilesForBBox(clampToCity(bbox));
    const cached = await Promise.all(indices.map((tile) => cachedTile(tileKey(tile))));

    const present: { index: TileIndex; tile: ParsedTile }[] = [];
    const missing: TileIndex[] = [];
    indices.forEach((index, i) => {
      const hit = cached[i];
      if (hit) present.push({ index, tile: hit.tile });
      else missing.push(index);
    });

    if (!opts.cachedOnly && missing.length > 0) {
      if (missing.length > MAX_TILES_FETCHED_PER_CALL) {
        throw new DataUnavailableError(
          `Obszar obejmuje ${missing.length} niepobranych kafli mapy — to więcej, niż pobieramy jednym zapytaniem (${MAX_TILES_FETCHED_PER_CALL}).`,
        );
      }
      // Limit równoległości (2) egzekwuje klient Overpass. allSettled: udane kafle zostają w cache mimo błędu innych.
      const results = await Promise.allSettled(missing.map((tile) => fetchAndStore(tile)));
      results.forEach((result, i) => {
        if (result.status === 'rejected') throw result.reason;
        present.push({ index: missing[i], tile: result.value });
      });
    }

    // Klucz i bbox zależą wyłącznie od zestawu faktycznie wczytanych kafli (przy cachedOnly może być niepełny).
    const loaded = present.length > 0 ? present.map((p) => p.index) : indices;
    const key = present.length > 0 ? loaded.map(tileKey).sort().join('+') : EMPTY_AREA_KEY;
    const known = merged.get(key);
    if (known && present.length > 0) return known;

    const boxes = loaded.map(tileBBox);
    const [minX, minY] = toXY(Math.min(...boxes.map((b) => b.south)), Math.min(...boxes.map((b) => b.west)));
    const [maxX, maxY] = toXY(Math.max(...boxes.map((b) => b.north)), Math.max(...boxes.map((b) => b.east)));
    const area = mergeTiles(key, [minX, minY, maxX, maxY], present.map((p) => p.tile));
    if (present.length > 0) merged.set(key, area);
    return area;
  }

  return { loadArea, ensureTile, hasTileOnDisk };
}

const defaultStore = createOsmStore();

/**
 * Dane OSM dla obszaru: kafle z cache, brakujące pobierane z Overpass (chyba że cachedOnly — wtedy są pomijane).
 * Bbox wystający poza KRAKOW_BBOX jest do niego przycinany; leżący w całości poza miastem → OutOfAreaError.
 */
export function loadArea(bbox: BBoxLatLon, opts?: { cachedOnly?: boolean }): Promise<AreaData> {
  return defaultStore.loadArea(bbox, opts);
}

export function ensureTile(tile: TileIndex): Promise<{ tile: ParsedTile; source: 'memory' | 'disk' | 'network' }> {
  return defaultStore.ensureTile(tile);
}

export function hasTileOnDisk(tile: TileIndex): Promise<boolean> {
  return defaultStore.hasTileOnDisk(tile);
}
