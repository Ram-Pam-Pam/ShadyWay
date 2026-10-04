// Klient WCS GUGiK (geoportal.gov.pl): numeryczny model terenu (NMT) i pokrycia terenu (NMPT) z lotniczego
// skaningu laserowego, bez klucza. Układ EPSG:2180 (PL-1992): SUBSET=x(...) to współrzędna wschodnia (easting),
// SUBSET=y(...) — północna (northing); sprawdzone na bbox zwracanego GeoTIFF-a.
//
// Ustalenia z usługi (X 2026):
//  - NMT:  .../NMT/GRID1/WCS/DigitalTerrainModelFormatTIFF, pokrycie DTM_PL-KRON86-NH_TIFF, FORMAT=image/tiff
//          → GeoTIFF Float32, 1 m; okno 2300×2300 m wraca w ok. 6 s.
//  - NMPT: .../NMPT/GRID1/WCS/DigitalSurfaceModel, pokrycie DSM_PL-KRON86-NH. Tu FORMAT=image/tiff zwraca
//          OBRAZEK RGB 8-bit (wysokości obcięte do 0–255), więc jedynym formatem z prawdziwymi wartościami jest
//          image/x-aaigrid (tekst, ok. 20 B na komórkę, odpowiedź multipart). Siatka natywna ma 0,5 m —
//          SCALEFACTOR=0.5 daje 1 m (najbliższy sąsiad). Usługa jest wolna: okno 1×1 km to 40–90 s, cały kafel
//          (2,2×2,3 km, ok. 104 MB tekstu) ok. 2,5 min. Dwa zapytania naraz niczego nie przyspieszają
//          (serwer obsługuje je praktycznie po kolei), dlatego kafel idzie jednym zapytaniem, a nie czterema.
//  - Oba pokrycia w tym samym układzie wysokości (PL-KRON86-NH), więc NMPT − NMT nie ma stałego przesunięcia.

import { fromArrayBuffer } from 'geotiff';

export type LidarLayer = 'dtm' | 'dsm';

/** [minE, minN, maxE, maxN] w EPSG:2180. */
export type BBox2180 = [number, number, number, number];

/** Raster w EPSG:2180: wiersz 0 = najbardziej PÓŁNOCNY (jak w GeoTIFF/AAIGrid); NaN = brak danych. */
export interface Raster2180 {
  /** Zachodnia krawędź kolumny 0. */
  west: number;
  /** Północna krawędź wiersza 0. */
  north: number;
  cellM: number;
  cols: number;
  rows: number;
  data: Float32Array;
}

interface LayerSource {
  url: string;
  coverageId: string;
  format: string;
  /** Rozdzielczość natywna (m); wynik zawsze skalujemy do 1 m. */
  nativeCellM: number;
  /** Największy bok okna w jednym zapytaniu (m). */
  maxWindowM: number;
  timeoutMs: number;
}

export const WCS_SOURCES: Record<LidarLayer, LayerSource> = {
  dtm: {
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModelFormatTIFF',
    coverageId: 'DTM_PL-KRON86-NH_TIFF',
    format: 'image/tiff',
    nativeCellM: 1,
    maxWindowM: 2400,
    timeoutMs: 60_000,
  },
  dsm: {
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMPT/GRID1/WCS/DigitalSurfaceModel',
    coverageId: 'DSM_PL-KRON86-NH',
    format: 'image/x-aaigrid',
    nativeCellM: 0.5,
    maxWindowM: 2400,
    timeoutMs: 420_000,
  },
};

export const TARGET_CELL_M = 1;
const USER_AGENT = 'Canopy/2.0 (piesza nawigacja w cieniu, Krakow; projekt niekomercyjny)';
const MAX_CONCURRENCY = 2;
const RETRIES = 2;
const RETRY_DELAY_MS = [3_000, 10_000];
/** Wartości spoza tego zakresu (m n.p.m.) traktujemy jako brak danych — w Polsce teren ma od −2 do 2500 m. */
const MIN_VALID_ELEVATION = -100;
const MAX_VALID_ELEVATION = 5000;

export class WcsError extends Error {}

export function coverageUrl(layer: LidarLayer, bbox: BBox2180): string {
  const source = WCS_SOURCES[layer];
  const params = [
    'SERVICE=WCS',
    'VERSION=2.0.1',
    'REQUEST=GetCoverage',
    `COVERAGEID=${source.coverageId}`,
    `FORMAT=${source.format}`,
    `SUBSET=x(${bbox[0]},${bbox[2]})`,
    `SUBSET=y(${bbox[1]},${bbox[3]})`,
  ];
  if (source.nativeCellM !== TARGET_CELL_M) params.push(`SCALEFACTOR=${source.nativeCellM / TARGET_CELL_M}`);
  return `${source.url}?${params.join('&')}`;
}

/** Zaokrągla bbox na zewnątrz do pełnych metrów (siatka 1 m usług jest wyrównana do całkowitych współrzędnych). */
export function alignBBox(bbox: BBox2180): BBox2180 {
  return [Math.floor(bbox[0]), Math.floor(bbox[1]), Math.ceil(bbox[2]), Math.ceil(bbox[3])];
}

/** Dzieli (wyrównany) bbox na okna o boku ≤ maxWindowM, o możliwie równych rozmiarach w pełnych metrach. */
export function splitWindows(bbox: BBox2180, maxWindowM: number): BBox2180[] {
  const cuts = (from: number, to: number): number[] => {
    const parts = Math.max(1, Math.ceil((to - from) / maxWindowM));
    const edges: number[] = [];
    for (let i = 0; i <= parts; i++) edges.push(i === parts ? to : from + Math.round(((to - from) * i) / parts));
    return edges;
  };
  const xs = cuts(bbox[0], bbox[2]);
  const ys = cuts(bbox[1], bbox[3]);
  const windows: BBox2180[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) windows.push([xs[i], ys[j], xs[i + 1], ys[j + 1]]);
  }
  return windows;
}

function cleanElevations(data: Float32Array, nodata: number | null): void {
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (!(value > MIN_VALID_ELEVATION && value < MAX_VALID_ELEVATION) || value === nodata) data[i] = NaN;
  }
}

const isSpace = (byte: number): boolean => byte === 32 || byte === 10 || byte === 13 || byte === 9;

function indexOfAscii(body: Uint8Array, text: string, from = 0): number {
  outer: for (let i = from; i + text.length <= body.length; i++) {
    for (let k = 0; k < text.length; k++) {
      // Porównanie bez rozróżniania wielkości liter (nagłówki AAIGrid bywają pisane wielkimi literami).
      if ((body[i + k] | 0x20) !== (text.charCodeAt(k) | 0x20)) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Parsuje Arc/Info ASCII Grid — także opakowany w odpowiedź multipart WCS (szuka nagłówka „ncols").
 * Ręczny parser liczb na bajtach: odpowiedź dla okna 1200 m ma ok. 25 MB tekstu.
 */
export function parseAaiGrid(body: Uint8Array): Raster2180 {
  let pos = indexOfAscii(body, 'ncols');
  if (pos < 0) throw new WcsError('Odpowiedź WCS nie zawiera siatki AAIGrid (brak nagłówka ncols).');

  const header: Record<string, number> = {};
  for (;;) {
    while (pos < body.length && isSpace(body[pos])) pos++;
    const letter = body[pos] | 0x20;
    if (!(letter >= 97 && letter <= 122)) break; // linia nie zaczyna się literą → początek danych
    let end = pos;
    while (end < body.length && body[end] !== 10) end++;
    const [name, value] = Buffer.from(body.subarray(pos, end)).toString('latin1').trim().split(/\s+/);
    header[name.toLowerCase()] = Number(value);
    pos = end;
  }

  const cols = header.ncols;
  const rows = header.nrows;
  const cellM = header.cellsize ?? header.dx;
  if (!(cols > 0 && rows > 0 && cellM > 0)) throw new WcsError('Niepoprawny nagłówek AAIGrid.');
  // xllcorner = krawędź; xllcenter = środek skrajnej komórki.
  const west = header.xllcorner ?? header.xllcenter - cellM / 2;
  const south = header.yllcorner ?? header.yllcenter - cellM / 2;
  if (!Number.isFinite(west) || !Number.isFinite(south)) throw new WcsError('Niepoprawny nagłówek AAIGrid (położenie).');

  const total = cols * rows;
  const data = new Float32Array(total);
  let count = 0;
  const length = body.length;
  while (count < total && pos < length) {
    while (pos < length && isSpace(body[pos])) pos++;
    if (pos >= length) break;
    const start = pos;
    let negative = false;
    if (body[pos] === 45) {
      negative = true;
      pos++;
    } else if (body[pos] === 43) pos++;
    let value = 0;
    let digits = 0;
    let byte = body[pos];
    while (byte >= 48 && byte <= 57) {
      value = value * 10 + (byte - 48);
      digits++;
      byte = body[++pos];
    }
    if (byte === 46) {
      byte = body[++pos];
      let scale = 0.1;
      let fractionDigits = 0;
      while (byte >= 48 && byte <= 57) {
        // Float32 i tak ma ~7 cyfr znaczących — dalsze cyfry rozwinięcia pomijamy.
        if (fractionDigits < 9) {
          value += (byte - 48) * scale;
          scale *= 0.1;
          fractionDigits++;
        }
        digits++;
        byte = body[++pos];
      }
    }
    if (digits === 0) break; // nie liczba (np. granica multipart) — koniec danych
    if (byte === 101 || byte === 69) {
      // Notacja wykładnicza — rzadka; oddajemy ją parserowi standardowemu.
      while (pos < length && !isSpace(body[pos])) pos++;
      value = Math.abs(Number(Buffer.from(body.subarray(start, pos)).toString('latin1')));
    }
    data[count++] = negative ? -value : value;
  }
  if (count !== total) throw new WcsError(`Ucięta siatka AAIGrid: ${count} z ${total} wartości.`);

  cleanElevations(data, header.nodata_value ?? null);
  return { west, north: south + rows * cellM, cellM, cols, rows, data };
}

/** Dekoduje jednokanałowy GeoTIFF (Float32) z wysokościami. */
export async function decodeGeoTiff(body: Uint8Array): Promise<Raster2180> {
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  if (image.getSamplesPerPixel() !== 1) {
    throw new WcsError('GeoTIFF z WCS ma więcej niż jeden kanał — to wizualizacja, nie wysokości.');
  }
  const [west, , , north] = image.getBoundingBox();
  const cols = image.getWidth();
  const rows = image.getHeight();
  const rasters = await image.readRasters();
  const band = (Array.isArray(rasters) ? rasters[0] : rasters) as ArrayLike<number>;
  const data = band instanceof Float32Array ? band : Float32Array.from(band);
  cleanElevations(data, image.getGDALNoData());
  return { west, north, cellM: Math.abs(image.getResolution()[0]), cols, rows, data };
}

/** Wkleja okno do mozaiki (najbliższy sąsiad — działa także, gdy okno ma inną rozdzielczość niż mozaika). */
export function pasteWindow(target: Raster2180, source: Raster2180): void {
  const colFrom = Math.max(0, Math.round((source.west - target.west) / target.cellM));
  const colTo = Math.min(target.cols, Math.round((source.west + source.cols * source.cellM - target.west) / target.cellM));
  const rowFrom = Math.max(0, Math.round((target.north - source.north) / target.cellM));
  const rowTo = Math.min(target.rows, Math.round((target.north - (source.north - source.rows * source.cellM)) / target.cellM));
  for (let row = rowFrom; row < rowTo; row++) {
    const north = target.north - (row + 0.5) * target.cellM;
    const srcRow = Math.floor((source.north - north) / source.cellM);
    if (srcRow < 0 || srcRow >= source.rows) continue;
    for (let col = colFrom; col < colTo; col++) {
      const east = target.west + (col + 0.5) * target.cellM;
      const srcCol = Math.floor((east - source.west) / source.cellM);
      if (srcCol < 0 || srcCol >= source.cols) continue;
      target.data[row * target.cols + col] = source.data[srcRow * source.cols + srcCol];
    }
  }
}

export interface WcsClientOptions {
  fetchImpl?: typeof fetch;
  concurrency?: number;
  retries?: number;
  /** Nadpisuje limity czasu z WCS_SOURCES (ms). */
  timeoutMs?: number;
  retryDelayMs?: number[];
  /** Wywoływane po każdym pobranym oknie (do logów postępu). */
  onWindow?: (info: { layer: LidarLayer; bbox: BBox2180; ms: number; bytes: number; attempt: number }) => void;
}

export interface WcsClient {
  /** Jedno okno (bez dzielenia). */
  fetchWindow(layer: LidarLayer, bbox: BBox2180): Promise<Raster2180>;
  /** Dowolny bbox: dzielony na okna, pobierany z limitem równoległości i sklejany w raster 1 m. */
  fetchRaster(layer: LidarLayer, bbox: BBox2180): Promise<Raster2180>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createWcsClient(options: WcsClientOptions = {}): WcsClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, options.concurrency ?? MAX_CONCURRENCY));
  const retries = options.retries ?? RETRIES;
  const retryDelays = options.retryDelayMs ?? RETRY_DELAY_MS;

  // Wspólny semafor dla wszystkich zapytań klienta — usługa publiczna, nie więcej niż 2 naraz.
  let active = 0;
  const waiting: (() => void)[] = [];
  async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  async function requestOnce(layer: LidarLayer, bbox: BBox2180): Promise<{ raster: Raster2180; bytes: number }> {
    const source = WCS_SOURCES[layer];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? source.timeoutMs);
    try {
      const response = await fetchImpl(coverageUrl(layer, bbox), {
        headers: { 'User-Agent': USER_AGENT, Accept: `${source.format}, multipart/related, */*` },
        signal: controller.signal,
      });
      const type = response.headers.get('content-type') ?? '';
      const body = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || /xml|html/i.test(type)) {
        const excerpt = Buffer.from(body.subarray(0, 600)).toString('utf8').replace(/\s+/g, ' ');
        const message = /<ows:ExceptionText>([^<]*)/.exec(excerpt)?.[1] ?? excerpt.slice(0, 200);
        throw new WcsError(`WCS ${layer.toUpperCase()} HTTP ${response.status}: ${message}`);
      }
      const raster = source.format === 'image/tiff' ? await decodeGeoTiff(body) : parseAaiGrid(body);
      return { raster, bytes: body.length };
    } catch (err) {
      if (controller.signal.aborted) throw new WcsError(`WCS ${layer.toUpperCase()}: przekroczony czas oczekiwania.`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchWindow(layer: LidarLayer, bbox: BBox2180): Promise<Raster2180> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 0);
      try {
        // Miejsce w kolejce zajmowane tylko na czas zapytania — przerwa przed ponowieniem nie blokuje innych.
        return await withSlot(async () => {
          const started = Date.now();
          const { raster, bytes } = await requestOnce(layer, bbox);
          options.onWindow?.({ layer, bbox, ms: Date.now() - started, bytes, attempt });
          return raster;
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new WcsError(String(lastError));
  }

  async function fetchRaster(layer: LidarLayer, bbox: BBox2180): Promise<Raster2180> {
    const aligned = alignBBox(bbox);
    const cols = Math.round((aligned[2] - aligned[0]) / TARGET_CELL_M);
    const rows = Math.round((aligned[3] - aligned[1]) / TARGET_CELL_M);
    if (!(cols > 0 && rows > 0)) throw new WcsError('Pusty obszar zapytania WCS.');
    const mosaic: Raster2180 = {
      west: aligned[0],
      north: aligned[3],
      cellM: TARGET_CELL_M,
      cols,
      rows,
      data: new Float32Array(cols * rows).fill(NaN),
    };
    const windows = splitWindows(aligned, WCS_SOURCES[layer].maxWindowM);
    // allSettled: czekamy na wszystkie okna, żeby po błędzie jednego nie zostawały „osierocone" zapytania w tle.
    const results = await Promise.allSettled(
      windows.map(async (window) => pasteWindow(mosaic, await fetchWindow(layer, window))),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason instanceof Error ? failed.reason : new WcsError(String(failed.reason));
    return mosaic;
  }

  return { fetchWindow, fetchRaster };
}
