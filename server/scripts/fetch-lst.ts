// Buduje siatkę temperatury powierzchni (LST) dla Krakowa z Landsat 8/9 Collection 2 Level-2 (ST_B10)
// pobieranych z Microsoft Planetary Computer. Uruchomienie: npx tsx server/scripts/fetch-lst.ts
//
// Wynik: data/lst/krakow_lst.bin (Float32, wierszami, północ → południe, NaN = brak danych)
//        data/lst/krakow_lst.json (LstGridMeta — patrz server/heat/lst.ts)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import { KRAKOW_BBOX } from '../../shared/types.ts';
import type { LstGridMeta } from '../heat/lst.ts';

const STAC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const SAS_TOKEN_URL = 'https://planetarycomputer.microsoft.com/api/sas/v1/token';
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/lst');

/** Rozmiar komórki ≈ 30 m na szerokości geograficznej Krakowa. */
const CELL_LAT_DEG = 0.00027;
const CELL_LON_DEG = 0.00042;

const YEARS_BACK = 3;
const MAX_CLOUD_COVER_PCT = 15;
const TARGET_SCENES = 5;
const MAX_CANDIDATES = 12;
/** Scena jest używana, jeśli po maskowaniu chmur ma dane dla co najmniej takiej części bbox. */
const MIN_VALID_FRACTION = 0.85;

/** Wartości domyślne Collection 2 ST; nadpisywane metadanymi raster:bands zasobu. */
const DEFAULT_SCALE = 0.00341802;
const DEFAULT_OFFSET_K = 149.0;

/** Bity QA_PIXEL: 0 fill, 1 rozszerzona chmura, 2 cirrus, 3 chmura, 4 cień chmury. */
const QA_REJECT_MASK = 0b11111;

interface StacAsset {
  href: string;
  'raster:bands'?: { scale?: number; offset?: number; nodata?: number }[];
}

interface StacItem {
  id: string;
  geometry: { type: string; coordinates: number[][][] };
  properties: {
    datetime: string;
    platform: string;
    'eo:cloud_cover': number;
    'proj:epsg'?: number;
    'proj:code'?: string;
  };
  assets: Record<string, StacAsset>;
}

interface SceneGrid {
  item: StacItem;
  /** °C na siatce docelowej, NaN = brak danych. */
  values: Float32Array;
  medianC: number;
  validFraction: number;
}

function log(msg: string): void {
  console.log(`[fetch-lst] ${msg}`);
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log(`${label}: próba ${i} nieudana (${(err as Error).message}), ponawiam…`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url.split('?')[0]}`);
  return (await res.json()) as T;
}

async function searchSummerScenes(): Promise<StacItem[]> {
  const { west, south, east, north } = KRAKOW_BBOX;
  const thisYear = new Date().getUTCFullYear();
  const items: StacItem[] = [];
  for (let year = thisYear - YEARS_BACK; year <= thisYear; year++) {
    const body = {
      collections: ['landsat-c2-l2'],
      bbox: [west, south, east, north],
      datetime: `${year}-06-01T00:00:00Z/${year}-08-31T23:59:59Z`,
      query: {
        'eo:cloud_cover': { lt: MAX_CLOUD_COVER_PCT },
        platform: { in: ['landsat-8', 'landsat-9'] },
      },
      limit: 100,
    };
    const page = await withRetry(`STAC ${year}`, () =>
      fetchJson<{ features: StacItem[] }>(STAC_SEARCH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    log(`STAC ${year}: ${page.features.length} scen z zachmurzeniem < ${MAX_CLOUD_COVER_PCT}%`);
    items.push(...page.features);
  }
  return items;
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ślad sceny Landsat jest ukośnym czworokątem — bbox elementu STAC nie wystarcza do oceny pokrycia. */
function coversBbox(item: StacItem): boolean {
  if (item.geometry.type !== 'Polygon') return false;
  const ring = item.geometry.coordinates[0];
  const { west, south, east, north } = KRAKOW_BBOX;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ].every(([lon, lat]) => pointInRing(lon, lat, ring));
}

function projDefinition(item: StacItem): string {
  const epsg = item.properties['proj:epsg'] ?? Number(item.properties['proj:code']?.split(':')[1]);
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  throw new Error(`Nieobsługiwany układ współrzędnych sceny ${item.id}: EPSG ${epsg}`);
}

const sasTokens = new Map<string, Promise<string>>();

/**
 * Dopisuje do adresu zasobu token SAS. Token dotyczy całego kontenera Azure Blob, więc pobieramy go raz
 * (endpoint podpisujący pojedyncze adresy szybko zwraca HTTP 429).
 */
async function signHref(href: string): Promise<string> {
  const url = new URL(href);
  const account = url.hostname.split('.')[0];
  const container = url.pathname.split('/')[1];
  const key = `${account}/${container}`;
  let token = sasTokens.get(key);
  if (!token) {
    token = withRetry(`token SAS ${key}`, () => fetchJson<{ token: string }>(`${SAS_TOKEN_URL}/${key}`)).then(
      (t) => t.token,
    );
    sasTokens.set(key, token);
  }
  return `${href}?${await token}`;
}

interface RasterWindow {
  data: ArrayLike<number>;
  /** Współrzędne (w układzie sceny) lewego górnego rogu okna oraz rozmiar piksela. */
  originX: number;
  originY: number;
  pixelW: number;
  pixelH: number;
  width: number;
  height: number;
}

/** Czyta z COG-a tylko okno pokrywające zadany prostokąt (w układzie sceny), żądaniami HTTP Range. */
async function readWindow(
  href: string,
  extent: { minX: number; minY: number; maxX: number; maxY: number },
): Promise<RasterWindow> {
  const tiff = await fromUrl(await signHref(href));
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution(); // ry < 0 (obraz północ → południe)
  const pixelH = Math.abs(ry);
  const margin = 2;
  const left = Math.max(0, Math.floor((extent.minX - ox) / rx) - margin);
  const right = Math.min(image.getWidth(), Math.ceil((extent.maxX - ox) / rx) + margin);
  const top = Math.max(0, Math.floor((oy - extent.maxY) / pixelH) - margin);
  const bottom = Math.min(image.getHeight(), Math.ceil((oy - extent.minY) / pixelH) + margin);
  if (right <= left || bottom <= top) throw new Error('okno poza zasięgiem sceny');
  const data = (await image.readRasters({
    window: [left, top, right, bottom],
    samples: [0],
    interleave: true,
  })) as unknown as ArrayLike<number>;
  return {
    data,
    originX: ox + left * rx,
    originY: oy - top * pixelH,
    pixelW: rx,
    pixelH,
    width: right - left,
    height: bottom - top,
  };
}

function median(values: number[] | Float32Array): number {
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted: Float32Array, p: number): number {
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function loadScene(item: StacItem, width: number, height: number): Promise<SceneGrid> {
  const { west, north } = KRAKOW_BBOX;
  const toScene = proj4('WGS84', projDefinition(item));

  // Środki komórek siatki docelowej w układzie sceny (UTM).
  const sx = new Float64Array(width * height);
  const sy = new Float64Array(width * height);
  const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let r = 0; r < height; r++) {
    const lat = north - (r + 0.5) * CELL_LAT_DEG;
    for (let c = 0; c < width; c++) {
      const [x, y] = toScene.forward([west + (c + 0.5) * CELL_LON_DEG, lat]);
      const i = r * width + c;
      sx[i] = x;
      sy[i] = y;
      if (x < extent.minX) extent.minX = x;
      if (x > extent.maxX) extent.maxX = x;
      if (y < extent.minY) extent.minY = y;
      if (y > extent.maxY) extent.maxY = y;
    }
  }

  const stAsset = item.assets.lwir11;
  const band = stAsset['raster:bands']?.[0];
  const scale = band?.scale ?? DEFAULT_SCALE;
  const offsetK = band?.offset ?? DEFAULT_OFFSET_K;
  const nodata = band?.nodata ?? 0;

  const [st, qa] = await Promise.all([
    withRetry(`${item.id} ST_B10`, () => readWindow(stAsset.href, extent)),
    withRetry(`${item.id} QA_PIXEL`, () => readWindow(item.assets.qa_pixel.href, extent)),
  ]);
  if (st.width !== qa.width || st.height !== qa.height || st.originX !== qa.originX || st.originY !== qa.originY) {
    throw new Error('siatki ST_B10 i QA_PIXEL nie pokrywają się');
  }

  const pixelC = (px: number, py: number): number => {
    if (px < 0 || py < 0 || px >= st.width || py >= st.height) return NaN;
    const i = py * st.width + px;
    const dn = st.data[i];
    if (dn === nodata || (qa.data[i] & QA_REJECT_MASK) !== 0) return NaN;
    return dn * scale + offsetK - 273.15;
  };

  const values = new Float32Array(width * height);
  const valid: number[] = [];
  for (let i = 0; i < values.length; i++) {
    // Interpolacja dwuliniowa między środkami pikseli, z pominięciem pikseli zamaskowanych.
    const fx = (sx[i] - st.originX) / st.pixelW - 0.5;
    const fy = (st.originY - sy[i]) / st.pixelH - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    let sum = 0;
    let weight = 0;
    for (const [dx, dy, w] of [
      [0, 0, (1 - tx) * (1 - ty)],
      [1, 0, tx * (1 - ty)],
      [0, 1, (1 - tx) * ty],
      [1, 1, tx * ty],
    ]) {
      const v = pixelC(x0 + dx, y0 + dy);
      if (!Number.isNaN(v)) {
        sum += v * w;
        weight += w;
      }
    }
    if (weight >= 0.5) {
      values[i] = sum / weight;
      valid.push(values[i]);
    } else {
      values[i] = NaN;
    }
  }

  return {
    item,
    values,
    medianC: valid.length ? median(valid) : NaN,
    validFraction: valid.length / values.length,
  };
}

/**
 * Kompozyt: mediana anomalii (wartość − mediana sceny) po scenach + średnia median scen.
 * Dzięki temu sceny z chłodniejszych i cieplejszych dni są porównywalne, a resztki chmur odpadają.
 */
function composite(scenes: SceneGrid[], cellCount: number): Float32Array {
  const baseC = scenes.reduce((s, sc) => s + sc.medianC, 0) / scenes.length;
  const out = new Float32Array(cellCount);
  const anomalies: number[] = [];
  for (let i = 0; i < cellCount; i++) {
    anomalies.length = 0;
    for (const sc of scenes) {
      const v = sc.values[i];
      if (!Number.isNaN(v)) anomalies.push(v - sc.medianC);
    }
    out[i] = anomalies.length ? baseC + median(anomalies) : NaN;
  }
  return out;
}

async function main(): Promise<void> {
  const { west, south, east, north } = KRAKOW_BBOX;
  const width = Math.round((east - west) / CELL_LON_DEG);
  const height = Math.round((north - south) / CELL_LAT_DEG);
  log(`siatka docelowa ${width} × ${height} komórek`);

  const candidates = (await searchSummerScenes())
    .filter(coversBbox)
    .sort((a, b) => a.properties['eo:cloud_cover'] - b.properties['eo:cloud_cover'])
    .slice(0, MAX_CANDIDATES);
  log(`${candidates.length} kandydatów pokrywa cały obszar`);
  if (candidates.length === 0) throw new Error('Brak scen Landsat pokrywających Kraków');

  const scenes: SceneGrid[] = [];
  for (const item of candidates) {
    if (scenes.length >= TARGET_SCENES) break;
    const date = item.properties.datetime.slice(0, 10);
    try {
      const scene = await loadScene(item, width, height);
      const pct = (scene.validFraction * 100).toFixed(1);
      if (scene.validFraction < MIN_VALID_FRACTION) {
        log(`pomijam ${item.id} (${date}): tylko ${pct}% pikseli bez chmur`);
        continue;
      }
      log(`użyto ${item.id} (${date}): ${pct}% ważnych, mediana ${scene.medianC.toFixed(1)} °C`);
      scenes.push(scene);
    } catch (err) {
      log(`pomijam ${item.id} (${date}): ${(err as Error).message}`);
    }
  }
  if (scenes.length === 0) throw new Error('Nie udało się wczytać żadnej sceny');

  const grid = composite(scenes, width * height);
  const sorted = grid.filter((v) => !Number.isNaN(v)).sort();
  if (sorted.length === 0) throw new Error('Kompozyt nie zawiera ważnych danych');

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  const sceneList = scenes
    .map((s) => `${s.item.id} (${s.item.properties.platform}, ${s.item.properties.datetime.slice(0, 10)})`)
    .join('; ');
  const meta: LstGridMeta = {
    bounds: [west, round6(north - height * CELL_LAT_DEG), round6(west + width * CELL_LON_DEG), north],
    width,
    height,
    p5: round2(percentile(sorted, 5)),
    p50: round2(percentile(sorted, 50)),
    p95: round2(percentile(sorted, 95)),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    source:
      `Landsat 8/9 Collection 2 Level-2, temperatura powierzchni (ST_B10), ` +
      `kompozyt medianowy ${scenes.length} letnich scen: ${sceneList}. ` +
      `Źródło: USGS / Microsoft Planetary Computer.`,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'krakow_lst.bin'), Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength));
  await writeFile(path.join(OUT_DIR, 'krakow_lst.json'), JSON.stringify(meta, null, 2));
  const coverage = ((sorted.length / grid.length) * 100).toFixed(1);
  log(`zapisano ${OUT_DIR} — pokrycie ${coverage}%, p5 ${meta.p5} / p50 ${meta.p50} / p95 ${meta.p95} °C`);
}

main().catch((err) => {
  console.error(`[fetch-lst] BŁĄD: ${(err as Error).message}`);
  process.exitCode = 1;
});
