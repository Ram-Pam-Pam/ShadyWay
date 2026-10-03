// Magazyn danych LiDAR (GUGiK NMT + NMPT): kafle na tej samej siatce co OSM (osm/store.ts), cache na dysku
// w data/lidar/ i w pamięci, pobieranie brakujących kafli przez WCS oraz dołączanie danych do AreaData.
//
// Kafel na dysku (gzip): nDSM = NMPT − NMT w lokalnych metrach, komórki 1 m, Uint16 w decymetrach
// + rzędne terenu w komórkach 10 m, Uint16 w decymetrach n.p.m. Roślinność i wysokości budynków liczone są
// dopiero przy dołączaniu do obszaru (zależą od obrysów z OSM) i trzymane w pamięci per kafel.

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { AreaData, BBoxLatLon, Building, HeightRaster, LidarData } from '../contracts.ts';
import { clampToCity, loadArea, tileKey, tilesForBBox, type TileIndex } from '../osm/store.ts';
import {
  footprintInsideRaster,
  footprintSamples,
  roofHeightFromSamples,
  vegetationRaster,
  type FootprintSamples,
  type GridSpec,
} from './heights.ts';
import {
  bbox2180ForLocalRect,
  createLocalTo2180,
  rectToBBoxLatLon,
  sampleBilinear,
  sampleNearest,
  TERRAIN_CELL_M,
  tileGrid,
  tileNdsmGrid,
  tileTerrainGrid,
  unionGrid,
  VEG_CELL_M,
} from './raster.ts';
import { alignBBox, createWcsClient, type Raster2180, type WcsClient } from './wcs.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Zmiana formatu pliku kafla wymaga podbicia wersji (jest w nazwie pliku — stare pliki są po prostu ignorowane). */
export const LIDAR_TILE_VERSION = 1;
const NODATA_U16 = 0xffff;
const MAGIC = 'CLID';

/** Łączny czas (ms), jaki zapytanie o trasę może czekać na dociągnięcie brakujących kafli LiDAR. */
export const FETCH_BUDGET_MS = 25_000;
/** Początkowe oszacowanie czasu pobrania kafla (NMPT z GUGiK to ok. 100 MB tekstu na kafel). */
const INITIAL_TILE_ESTIMATE_MS = 120_000;
/** Po nieudanym pobraniu kafla nie próbujemy ponownie przez ten czas (usługa zwykle leży dłużej niż chwilę). */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
/** Ile kafli może naraz czekać w kolejce pobierania w tle. */
const MAX_PENDING_TILES = 12;
const PROCESSED_TILE_LIMIT = 40;
/** Margines (m) wokół kafla przy wyborze budynków do maski — bufor obrysu + zapas. */
const BUILDING_SELECT_MARGIN_M = 3;

const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/lidar');

/** Surowy kafel LiDAR w lokalnych metrach. */
export interface LidarTile {
  key: string;
  fetchedAt: string;
  ndsmGrid: GridSpec;
  /** nDSM w decymetrach; 0xFFFF = brak danych. Wiersz 0 = południe. */
  ndsm: Uint16Array;
  terrainGrid: GridSpec;
  /** Rzędna terenu w decymetrach n.p.m.; 0xFFFF = brak danych. */
  terrain: Uint16Array;
}

export function parseTileKey(key: string): TileIndex | null {
  const match = /^(-?\d+)_(-?\d+)$/.exec(key);
  return match ? { ix: Number(match[1]), iy: Number(match[2]) } : null;
}

export function lidarTileFileName(key: string): string {
  return `${key}.v${LIDAR_TILE_VERSION}.bin.gz`;
}

/** Bbox zapytania WCS (EPSG:2180, pełne metry) pokrywający kafel z kilkumetrowym zapasem. */
export function tileRequestBBox(tile: TileIndex): [number, number, number, number] {
  const ndsm = tileNdsmGrid(tile);
  const terrain = tileTerrainGrid(tile);
  const rect: [number, number, number, number] = [
    Math.min(ndsm.x0, terrain.x0),
    Math.min(ndsm.y0, terrain.y0),
    Math.max(ndsm.x0 + ndsm.cols * ndsm.cellM, terrain.x0 + terrain.cols * terrain.cellM),
    Math.max(ndsm.y0 + ndsm.rows * ndsm.cellM, terrain.y0 + terrain.rows * terrain.cellM),
  ];
  return alignBBox(bbox2180ForLocalRect(rect, 3));
}

/**
 * Buduje kafel z rastrów NMT i NMPT (EPSG:2180): nDSM = NMPT − NMT próbkowane metodą najbliższego sąsiada
 * w środkach komórek lokalnej siatki 1 m (oba źródła mają tę samą siatkę, więc różnica pochodzi z tej samej
 * komórki); teren = średnia z NMT w 25 punktach każdej komórki 10 m.
 */
export function buildTile(tile: TileIndex, dtm: Raster2180, dsm: Raster2180, fetchedAt = new Date().toISOString()): LidarTile {
  const ndsmGrid = tileNdsmGrid(tile);
  const terrainGrid = tileTerrainGrid(tile);
  const en = new Float64Array(2);

  const project = createLocalTo2180([
    ndsmGrid.x0,
    ndsmGrid.y0,
    ndsmGrid.x0 + ndsmGrid.cols * ndsmGrid.cellM,
    ndsmGrid.y0 + ndsmGrid.rows * ndsmGrid.cellM,
  ]);
  const ndsm = new Uint16Array(ndsmGrid.cols * ndsmGrid.rows);
  for (let row = 0; row < ndsmGrid.rows; row++) {
    const y = ndsmGrid.y0 + (row + 0.5) * ndsmGrid.cellM;
    for (let col = 0; col < ndsmGrid.cols; col++) {
      project(ndsmGrid.x0 + (col + 0.5) * ndsmGrid.cellM, y, en);
      const height = sampleNearest(dsm, en[0], en[1]) - sampleNearest(dtm, en[0], en[1]);
      ndsm[row * ndsmGrid.cols + col] =
        height === height ? Math.min(NODATA_U16 - 1, Math.max(0, Math.round(height * 10))) : NODATA_U16;
    }
  }

  const projectTerrain = createLocalTo2180([
    terrainGrid.x0,
    terrainGrid.y0,
    terrainGrid.x0 + terrainGrid.cols * terrainGrid.cellM,
    terrainGrid.y0 + terrainGrid.rows * terrainGrid.cellM,
  ]);
  const terrain = new Uint16Array(terrainGrid.cols * terrainGrid.rows);
  const SUB = 5;
  const subStep = terrainGrid.cellM / SUB;
  for (let row = 0; row < terrainGrid.rows; row++) {
    for (let col = 0; col < terrainGrid.cols; col++) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j < SUB; j++) {
        for (let i = 0; i < SUB; i++) {
          projectTerrain(
            terrainGrid.x0 + col * terrainGrid.cellM + (i + 0.5) * subStep,
            terrainGrid.y0 + row * terrainGrid.cellM + (j + 0.5) * subStep,
            en,
          );
          const z = sampleBilinear(dtm, en[0], en[1]);
          if (z === z) {
            sum += z;
            count++;
          }
        }
      }
      terrain[row * terrainGrid.cols + col] =
        count > 0 ? Math.min(NODATA_U16 - 1, Math.max(0, Math.round((sum / count) * 10))) : NODATA_U16;
    }
  }

  return { key: tileKey(tile), fetchedAt, ndsmGrid, ndsm, terrainGrid, terrain };
}

interface TileHeader {
  v: number;
  key: string;
  fetchedAt: string;
  ndsm: GridSpec;
  terrain: GridSpec;
}

/** Serializacja kafla: "CLID" + długość nagłówka (u32 LE) + nagłówek JSON + nDSM (u16 LE) + teren (u16 LE). */
export function encodeTile(tile: LidarTile): Buffer {
  const header: TileHeader = {
    v: LIDAR_TILE_VERSION,
    key: tile.key,
    fetchedAt: tile.fetchedAt,
    ndsm: tile.ndsmGrid,
    terrain: tile.terrainGrid,
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length);
  return Buffer.concat([
    Buffer.from(MAGIC, 'latin1'),
    length,
    json,
    Buffer.from(tile.ndsm.buffer, tile.ndsm.byteOffset, tile.ndsm.byteLength),
    Buffer.from(tile.terrain.buffer, tile.terrain.byteOffset, tile.terrain.byteLength),
  ]);
}

/** Odwrotność encodeTile; null dla danych uszkodzonych, w innej wersji albo dla innego kafla. */
export function decodeTile(raw: Buffer, expectedKey?: string): LidarTile | null {
  if (raw.length < 8 || raw.subarray(0, 4).toString('latin1') !== MAGIC) return null;
  const headerLength = raw.readUInt32LE(4);
  const dataStart = 8 + headerLength;
  if (dataStart > raw.length) return null;
  let header: TileHeader;
  try {
    header = JSON.parse(raw.subarray(8, dataStart).toString('utf8')) as TileHeader;
  } catch {
    return null;
  }
  if (header.v !== LIDAR_TILE_VERSION || (expectedKey !== undefined && header.key !== expectedKey)) return null;
  const ndsmCells = header.ndsm.cols * header.ndsm.rows;
  const terrainCells = header.terrain.cols * header.terrain.rows;
  if (raw.length !== dataStart + 2 * (ndsmCells + terrainCells)) return null;
  // Kopia do wyrównanego bufora (offset w pliku bywa nieparzysty, a Uint16Array wymaga wyrównania do 2 B).
  const body = new Uint8Array(raw.subarray(dataStart)).buffer;
  return {
    key: header.key,
    fetchedAt: header.fetchedAt,
    ndsmGrid: header.ndsm,
    ndsm: new Uint16Array(body, 0, ndsmCells),
    terrainGrid: header.terrain,
    terrain: new Uint16Array(body, 2 * ndsmCells, terrainCells),
  };
}

/** nDSM kafla jako HeightRaster (metry, NaN = brak danych). */
export function tileNdsmRaster(tile: LidarTile): HeightRaster {
  const data = new Float32Array(tile.ndsm.length);
  for (let i = 0; i < data.length; i++) data[i] = tile.ndsm[i] === NODATA_U16 ? NaN : tile.ndsm[i] / 10;
  return { ...tile.ndsmGrid, data };
}

/** Rzędne terenu kafla jako HeightRaster (m n.p.m., NaN = brak danych). */
export function tileTerrainRaster(tile: LidarTile): HeightRaster {
  const data = new Float32Array(tile.terrain.length);
  for (let i = 0; i < data.length; i++) data[i] = tile.terrain[i] === NODATA_U16 ? NaN : tile.terrain[i] / 10;
  return { ...tile.terrainGrid, data };
}

/** Wynik przetworzenia kafla z obrysami budynków. */
interface ProcessedTile {
  signature: string;
  vegGrid: GridSpec;
  /** Wysokość roślinności w decymetrach (0 = brak, 0xFFFF = brak danych). */
  veg: Uint16Array;
  terrainGrid: GridSpec;
  terrain: Uint16Array;
  /** Budynki w całości w kaflu: wysokość dachu albo null (LiDAR niewiarygodny). */
  heights: Map<number, number | null>;
  /** Budynki przecięte krawędzią kafla: próbki z tej części, która leży w kaflu. */
  partial: Map<number, FootprintSamples>;
}

interface BuildingBox {
  building: Building;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function buildingBoxes(buildings: Building[]): BuildingBox[] {
  return buildings.map((building) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const ring = building.ring;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      if (ring[i] < minX) minX = ring[i];
      if (ring[i] > maxX) maxX = ring[i];
      if (ring[i + 1] < minY) minY = ring[i + 1];
      if (ring[i + 1] > maxY) maxY = ring[i + 1];
    }
    return { building, minX, minY, maxX, maxY };
  });
}

function boxesInGrid(boxes: BuildingBox[], grid: GridSpec, marginM: number): Building[] {
  const minX = grid.x0 - marginM;
  const minY = grid.y0 - marginM;
  const maxX = grid.x0 + grid.cols * grid.cellM + marginM;
  const maxY = grid.y0 + grid.rows * grid.cellM + marginM;
  const selected: Building[] = [];
  for (const box of boxes) {
    if (box.maxX >= minX && box.minX <= maxX && box.maxY >= minY && box.minY <= maxY) selected.push(box.building);
  }
  return selected;
}

function buildingsSignature(buildings: Building[]): string {
  let sum = 0;
  for (const building of buildings) sum = (sum + Math.abs(building.id)) % 9007199254740881;
  return `${buildings.length}:${sum}`;
}

function processTile(tile: LidarTile, buildings: Building[], signature: string): ProcessedTile {
  const ndsm = tileNdsmRaster(tile);
  const vegetation = vegetationRaster(ndsm, buildings, { outCellM: VEG_CELL_M });
  const veg = new Uint16Array(vegetation.data.length);
  for (let i = 0; i < veg.length; i++) {
    const value = vegetation.data[i];
    veg[i] = value === value ? Math.round(value * 10) : NODATA_U16;
  }

  const heights = new Map<number, number | null>();
  const partial = new Map<number, FootprintSamples>();
  for (const building of buildings) {
    const samples = footprintSamples(building, ndsm);
    if (footprintInsideRaster(building, ndsm)) heights.set(building.id, roofHeightFromSamples(samples, building.minHeight));
    else if (samples.all.length > 0) partial.set(building.id, samples);
  }

  return {
    signature,
    vegGrid: { x0: vegetation.x0, y0: vegetation.y0, cellM: vegetation.cellM, cols: vegetation.cols, rows: vegetation.rows },
    veg,
    terrainGrid: tile.terrainGrid,
    terrain: tile.terrain,
    heights,
    partial,
  };
}

/** Wkleja kafel (u16 dm) do mozaiki Float32 (m); zwraca liczbę komórek z danymi. */
function pasteU16(target: HeightRaster, grid: GridSpec, values: Uint16Array): number {
  const colOffset = Math.round((grid.x0 - target.x0) / target.cellM);
  const rowOffset = Math.round((grid.y0 - target.y0) / target.cellM);
  let valid = 0;
  for (let row = 0; row < grid.rows; row++) {
    const targetRow = row + rowOffset;
    if (targetRow < 0 || targetRow >= target.rows) continue;
    for (let col = 0; col < grid.cols; col++) {
      const targetCol = col + colOffset;
      if (targetCol < 0 || targetCol >= target.cols) continue;
      const value = values[row * grid.cols + col];
      if (value === NODATA_U16) continue;
      target.data[targetRow * target.cols + targetCol] = value / 10;
      valid++;
    }
  }
  return valid;
}

function emptyRaster(grid: GridSpec): HeightRaster {
  return { ...grid, data: new Float32Array(grid.cols * grid.rows).fill(NaN) };
}

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
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

export interface LidarStoreOptions {
  /** Katalog cache (domyślnie data/lidar w katalogu projektu). */
  dir?: string;
  /** Pobranie jednego kafla; domyślnie WCS GUGiK. */
  fetchTile?: (tile: TileIndex) => Promise<LidarTile>;
  /** Budżet czasu (ms) na dociąganie brakujących kafli w jednym wywołaniu attachLidar/loadLidar. */
  budgetMs?: number;
  /** Początkowe oszacowanie czasu pobrania kafla (ms) — gdy przekracza budżet, wywołanie nie czeka wcale. */
  tileEstimateMs?: number;
  /** Obrysy budynków dla loadLidar(bbox); domyślnie kafle OSM z cache (bez sieci). */
  loadBuildings?: (bbox: BBoxLatLon) => Promise<Building[]>;
}

export interface LidarStore {
  attachLidar(area: AreaData, opts?: { cachedOnly?: boolean }): Promise<void>;
  loadLidar(bbox: BBoxLatLon, opts?: { cachedOnly?: boolean }): Promise<LidarData | null>;
  /** Zapewnia kafel w cache (pobiera, gdy brak). Rzuca przy błędzie pobierania. */
  ensureTile(tile: TileIndex): Promise<{ tile: LidarTile; source: 'disk' | 'network' }>;
  hasTileOnDisk(tile: TileIndex): Promise<boolean>;
  /** Kafel z dysku albo null — nigdy nie sięga do sieci. */
  readTile(tile: TileIndex): Promise<LidarTile | null>;
  /** Czeka na zakończenie pobierań w tle (testy, skrypty). */
  idle(): Promise<void>;
}

/** Pobieranie kafla przez WCS: NMT i NMPT dla bbox kafla, potem przeliczenie do lokalnej siatki. */
export function createWcsTileFetcher(client: WcsClient): (tile: TileIndex) => Promise<LidarTile> {
  return async (tile) => {
    const bbox = tileRequestBBox(tile);
    const [dtm, dsm] = await Promise.all([client.fetchRaster('dtm', bbox), client.fetchRaster('dsm', bbox)]);
    return buildTile(tile, dtm, dsm);
  };
}

const fetchTileFromWcs = createWcsTileFetcher(createWcsClient());

async function cachedOsmBuildings(bbox: BBoxLatLon): Promise<Building[]> {
  return (await loadArea(bbox, { cachedOnly: true })).buildings;
}

export function createLidarStore(options: LidarStoreOptions = {}): LidarStore {
  const dir = options.dir ?? DEFAULT_DATA_DIR;
  const fetchTile = options.fetchTile ?? fetchTileFromWcs;
  const budgetMs = options.budgetMs ?? FETCH_BUDGET_MS;
  const loadBuildings = options.loadBuildings ?? cachedOsmBuildings;

  const processed = new LruMap<ProcessedTile>(PROCESSED_TILE_LIMIT);
  const inFlight = new Map<string, { promise: Promise<LidarTile>; startedAt: number }>();
  const failedUntil = new Map<string, number>();
  /** Kafle, o których wiemy, że są na dysku (oszczędza sprawdzanie pliku przy każdym wywołaniu). */
  const knownOnDisk = new Set<string>();
  const attachState = new WeakMap<AreaData, { tiles: string; buildings: Building[] }>();
  const attaching = new WeakMap<AreaData, Promise<void>>();
  let tileEstimateMs = options.tileEstimateMs ?? INITIAL_TILE_ESTIMATE_MS;

  const filePath = (key: string): string => path.join(dir, lidarTileFileName(key));

  async function hasTileOnDisk(tile: TileIndex): Promise<boolean> {
    const key = tileKey(tile);
    if (knownOnDisk.has(key)) return true;
    try {
      await access(filePath(key));
      knownOnDisk.add(key);
      return true;
    } catch {
      return false;
    }
  }

  async function readFromDisk(key: string): Promise<LidarTile | null> {
    try {
      const tile = decodeTile(await gunzipAsync(await readFile(filePath(key))), key);
      if (tile) knownOnDisk.add(key);
      else knownOnDisk.delete(key);
      return tile;
    } catch {
      knownOnDisk.delete(key);
      return null;
    }
  }

  async function writeToDisk(tile: LidarTile): Promise<void> {
    const target = filePath(tile.key);
    const temp = `${target}.${process.pid}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(temp, await gzipAsync(encodeTile(tile), { level: 6 }));
    await rename(temp, target);
    knownOnDisk.add(tile.key);
  }

  /** Pobiera kafel z sieci i zapisuje; równoległe żądania tego samego kafla współdzielą jedno pobieranie. */
  function fetchAndStore(tile: TileIndex): Promise<LidarTile> {
    const key = tileKey(tile);
    const pending = inFlight.get(key);
    if (pending) return pending.promise;
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const fetched = await fetchTile(tile);
        await writeToDisk(fetched);
        failedUntil.delete(key);
        // Wygładzone oszacowanie czasu pobrania — decyduje, czy kolejne zapytania w ogóle czekają na kafle.
        tileEstimateMs = 0.5 * tileEstimateMs + 0.5 * (Date.now() - startedAt);
        return fetched;
      } catch (err) {
        failedUntil.set(key, Date.now() + FAILURE_COOLDOWN_MS);
        throw err;
      } finally {
        inFlight.delete(key);
      }
    })();
    // Pobieranie może dobiec końca po czasie, gdy nikt już na nie nie czeka — błąd nie może być „nieobsłużony".
    promise.catch(() => undefined);
    inFlight.set(key, { promise, startedAt });
    return promise;
  }

  async function ensureTile(tile: TileIndex): Promise<{ tile: LidarTile; source: 'disk' | 'network' }> {
    const onDisk = await readFromDisk(tileKey(tile));
    if (onDisk) return { tile: onDisk, source: 'disk' };
    return { tile: await fetchAndStore(tile), source: 'network' };
  }

  /**
   * Uruchamia pobieranie brakujących kafli i czeka najwyżej `budgetMs` — ale tylko wtedy, gdy z dotychczasowych
   * czasów wynika, że kafle mają szansę zdążyć. NMPT z GUGiK wraca zwykle po 1–3 minutach na kafel, więc
   * czekanie 25 s byłoby czystą stratą czasu użytkownika: wtedy od razu wracamy z niepełnym pokryciem,
   * a kafle dociągają się w tle na następne zapytanie.
   */
  async function fetchMissing(missing: TileIndex[]): Promise<void> {
    const now = Date.now();
    const started: { promise: Promise<LidarTile>; startedAt: number }[] = [];
    for (const tile of missing) {
      const key = tileKey(tile);
      if ((failedUntil.get(key) ?? 0) > now) continue;
      if (!inFlight.has(key) && inFlight.size >= MAX_PENDING_TILES) continue;
      fetchAndStore(tile);
      const entry = inFlight.get(key);
      if (entry) started.push(entry);
    }
    if (started.length === 0) return;

    // Klient WCS pobiera 2 okna naraz, czyli kafle schodzą praktycznie jeden po drugim.
    const queueAhead = inFlight.size - 1;
    const oldest = Math.min(...started.map((s) => s.startedAt));
    const expectedMs = tileEstimateMs * (1 + queueAhead) - (now - oldest);
    if (expectedMs > budgetMs) return;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    });
    await Promise.race([Promise.allSettled(started.map((s) => s.promise)), timeout]);
    clearTimeout(timer);
  }

  async function processedTile(tile: TileIndex, boxes: BuildingBox[]): Promise<ProcessedTile | null> {
    const key = tileKey(tile);
    const buildings = boxesInGrid(boxes, tileNdsmGrid(tile), BUILDING_SELECT_MARGIN_M);
    const signature = buildingsSignature(buildings);
    const known = processed.get(key);
    if (known && known.signature === signature) return known;
    const raw = await readFromDisk(key);
    if (!raw) {
      processed.delete(key);
      return null;
    }
    const result = processTile(raw, buildings, signature);
    processed.set(key, result);
    return result;
  }

  /** Kafle obszaru: z klucza AreaData (zestaw faktycznie wczytanych kafli OSM), a gdy klucz jest inny — z bbox. */
  function tilesOfArea(area: AreaData): TileIndex[] {
    const fromKey = area.key.split('+').map(parseTileKey);
    if (fromKey.length > 0 && fromKey.every((t): t is TileIndex => t !== null)) return fromKey;
    return tilesForBBox(rectToBBoxLatLon(area.bboxXY));
  }

  async function assemble(
    tiles: TileIndex[],
    buildings: Building[],
    opts: { cachedOnly?: boolean },
    unchanged?: (availableKeys: string) => boolean,
  ): Promise<{ lidar: LidarData | null; availableKeys: string; heights: Map<number, number> } | 'unchanged'> {
    let present = await Promise.all(tiles.map((tile) => hasTileOnDisk(tile)));
    const missing = tiles.filter((_, i) => !present[i]);
    if (missing.length > 0 && !opts.cachedOnly) {
      await fetchMissing(missing);
      present = await Promise.all(tiles.map((tile) => hasTileOnDisk(tile)));
    }
    const available = tiles.filter((_, i) => present[i]);
    const availableKeys = available.map(tileKey).sort().join('+');
    if (unchanged?.(availableKeys)) return 'unchanged';
    if (available.length === 0) return { lidar: null, availableKeys, heights: new Map() };

    const vegGrid = unionGrid(tiles.map((tile) => tileGrid(tile, VEG_CELL_M)), VEG_CELL_M)!;
    const terrainGrid = unionGrid(tiles.map((tile) => tileGrid(tile, TERRAIN_CELL_M)), TERRAIN_CELL_M)!;
    const vegetation = emptyRaster(vegGrid);
    const terrain = emptyRaster(terrainGrid);

    const boxes = buildingBoxes(buildings);
    const heights = new Map<number, number>();
    const rejected = new Set<number>();
    const partial = new Map<number, FootprintSamples>();
    let validCells = 0;
    let loaded = 0;
    for (const tile of available) {
      const result = await processedTile(tile, boxes);
      if (!result) continue; // plik zniknął albo jest uszkodzony
      loaded++;
      validCells += pasteU16(vegetation, result.vegGrid, result.veg);
      pasteU16(terrain, result.terrainGrid, result.terrain);
      for (const [id, height] of result.heights) {
        if (height === null) rejected.add(id);
        else heights.set(id, height);
      }
      for (const [id, samples] of result.partial) {
        const merged = partial.get(id);
        if (merged) {
          merged.inner.push(...samples.inner);
          merged.all.push(...samples.all);
        } else partial.set(id, { inner: [...samples.inner], all: [...samples.all] });
      }
      // Przetwarzanie kafla jest synchroniczne (setki ms) — oddajemy pętlę zdarzeń innym zapytaniom.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (loaded === 0) return { lidar: null, availableKeys: '', heights: new Map() };

    const byId = new Map(buildings.map((b) => [b.id, b]));
    for (const [id, samples] of partial) {
      if (heights.has(id) || rejected.has(id)) continue;
      const height = roofHeightFromSamples(samples, byId.get(id)?.minHeight ?? 0);
      if (height !== null) heights.set(id, height);
    }

    const coverage = Math.min(1, validCells / (vegGrid.cols * vegGrid.rows));
    return { lidar: { vegetation, terrain, coverage }, availableKeys, heights };
  }

  async function attachNow(area: AreaData, opts: { cachedOnly?: boolean }): Promise<void> {
    try {
      const tiles = tilesOfArea(area);
      const result = await assemble(tiles, area.buildings, opts, (availableKeys) => {
        // Idempotencja: ten sam zestaw kafli i te same budynki co poprzednio → nic nie zmieniamy.
        const previous = attachState.get(area);
        return previous !== undefined && previous.tiles === availableKeys && previous.buildings === area.buildings;
      });
      if (result === 'unchanged') return;
      for (const building of area.buildings) {
        const height = result.heights.get(building.id);
        if (height === undefined) continue;
        building.height = height;
        building.heightSource = 'lidar';
      }
      area.lidar = result.lidar;
      attachState.set(area, { tiles: result.availableKeys, buildings: area.buildings });
    } catch {
      area.lidar = null;
    }
  }

  function attachLidar(area: AreaData, opts: { cachedOnly?: boolean } = {}): Promise<void> {
    // Równoległe wywołania dla tego samego obszaru czekają na jedno przetwarzanie.
    const pending = attaching.get(area);
    if (pending) return pending;
    const promise = attachNow(area, opts).finally(() => attaching.delete(area));
    attaching.set(area, promise);
    return promise;
  }

  async function loadLidar(bbox: BBoxLatLon, opts: { cachedOnly?: boolean } = {}): Promise<LidarData | null> {
    try {
      const clamped = clampToCity(bbox);
      const buildings = await loadBuildings(clamped);
      const result = await assemble(tilesForBBox(clamped), buildings, opts);
      return result === 'unchanged' ? null : result.lidar;
    } catch {
      return null;
    }
  }

  async function readTile(tile: TileIndex): Promise<LidarTile | null> {
    return readFromDisk(tileKey(tile));
  }

  async function idle(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
  }

  return { attachLidar, loadLidar, ensureTile, hasTileOnDisk, readTile, idle };
}

/** CIEN_LIDAR=off wyłącza dane LiDAR (model cienia z samych danych OSM) — do porównań i diagnostyki. */
const LIDAR_DISABLED = /^(off|0|false)$/i.test(process.env.CIEN_LIDAR ?? '');

const defaultStore = createLidarStore(
  process.env.CIEN_LIDAR_BUDGET_MS ? { budgetMs: Number(process.env.CIEN_LIDAR_BUDGET_MS) || 0 } : {},
);

/**
 * Dołącza dane LiDAR do obszaru: ustawia area.lidar = { vegetation, terrain, coverage } i w miejscu poprawia
 * wysokości budynków (heightSource = 'lidar'). Idempotentne; nigdy nie rzuca — przy błędzie area.lidar = null.
 * Brakujące kafle są pobierane (z budżetem czasu; reszta dociąga się w tle), chyba że cachedOnly.
 * Komórki rastrów w kaflach, dla których danych jeszcze nie ma, mają NaN, a coverage < 1.
 */
export function attachLidar(area: AreaData, opts?: { cachedOnly?: boolean }): Promise<void> {
  if (LIDAR_DISABLED) {
    area.lidar = null;
    return Promise.resolve();
  }
  return defaultStore.attachLidar(area, opts);
}

/**
 * Dane LiDAR dla bbox (obrysy budynków do maski roślinności bierze z kafli OSM w cache). Nie zmienia wysokości
 * budynków — do tego służy attachLidar. Nigdy nie rzuca; null, gdy danych nie ma.
 */
export function loadLidar(bbox: BBoxLatLon, opts?: { cachedOnly?: boolean }): Promise<LidarData | null> {
  return defaultStore.loadLidar(bbox, opts);
}

export function ensureLidarTile(tile: TileIndex): Promise<{ tile: LidarTile; source: 'disk' | 'network' }> {
  return defaultStore.ensureTile(tile);
}

export function hasLidarTileOnDisk(tile: TileIndex): Promise<boolean> {
  return defaultStore.hasTileOnDisk(tile);
}

export function readLidarTile(tile: TileIndex): Promise<LidarTile | null> {
  return defaultStore.readTile(tile);
}
