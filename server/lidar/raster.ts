// Geometria rastrów LiDAR: przeliczenia EPSG:2180 ↔ lokalne metry aplikacji, siatki kafli i przepróbkowanie.
//
// Lokalny układ aplikacji (geo/project.ts) to rzut równoodległościowy wokół centrum Krakowa, a dane GUGiK są
// w PL-1992 (Transverse Mercator, południk osiowy 19°E). W Krakowie osie obu układów są skręcone o ok. 0,7°
// (zbieżność południków) i różnią się skalą o ułamek promila — na szerokości kafla (2,1 km) daje to ~27 m,
// więc rastra nie można po prostu przesunąć: każdą komórkę lokalną przeliczamy na (E, N) i próbkujemy źródło.

import proj4 from 'proj4';

import type { BBoxLatLon, HeightRaster } from '../contracts.ts';
import { toLatLon, toXY } from '../geo/project.ts';
import { tileBBox, type TileIndex } from '../osm/store.ts';
import type { GridSpec } from './heights.ts';
import type { BBox2180, Raster2180 } from './wcs.ts';

const EPSG_2180 =
  '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const converter = proj4('EPSG:4326', EPSG_2180);

/** WGS84 → EPSG:2180; zwraca [E, N] (wschodnia, północna). */
export function wgs84To2180(lat: number, lon: number): [number, number] {
  const [e, n] = converter.forward([lon, lat]);
  return [e, n];
}

/** EPSG:2180 → WGS84; zwraca [lat, lon]. */
export function epsg2180ToWgs84(e: number, n: number): [number, number] {
  const [lon, lat] = converter.inverse([e, n]);
  return [lat, lon];
}

export function localTo2180(x: number, y: number): [number, number] {
  const [lat, lon] = toLatLon(x, y);
  return wgs84To2180(lat, lon);
}

export function epsg2180ToLocal(e: number, n: number): [number, number] {
  const [lat, lon] = epsg2180ToWgs84(e, n);
  return toXY(lat, lon);
}

/** Bbox w EPSG:2180 obejmujący lokalny prostokąt (z marginesem) — prostokąt jest lekko obrócony, stąd 4 narożniki. */
export function bbox2180ForLocalRect(rect: [number, number, number, number], marginM = 0): BBox2180 {
  const [minX, minY, maxX, maxY] = rect;
  const corners = [
    localTo2180(minX, minY),
    localTo2180(maxX, minY),
    localTo2180(minX, maxY),
    localTo2180(maxX, maxY),
  ];
  return [
    Math.min(...corners.map((c) => c[0])) - marginM,
    Math.min(...corners.map((c) => c[1])) - marginM,
    Math.max(...corners.map((c) => c[0])) + marginM,
    Math.max(...corners.map((c) => c[1])) + marginM,
  ];
}

/** Odstęp węzłów siatki kontrolnej (m); między węzłami (E, N) interpolujemy dwuliniowo — błąd poniżej 1 mm. */
const LATTICE_STEP_M = 128;

/**
 * Szybkie przeliczenie lokalne metry → EPSG:2180 w obrębie prostokąta: dokładne proj4 tylko w węzłach rzadkiej
 * siatki, w środku interpolacja dwuliniowa (proj4 dla każdej z milionów komórek trwałoby wielokrotnie dłużej).
 * Zwracana funkcja zapisuje wynik w `out` ([E, N]).
 */
export function createLocalTo2180(rect: [number, number, number, number]): (x: number, y: number, out: Float64Array) => void {
  const [minX, minY, maxX, maxY] = rect;
  const nx = Math.max(1, Math.ceil((maxX - minX) / LATTICE_STEP_M));
  const ny = Math.max(1, Math.ceil((maxY - minY) / LATTICE_STEP_M));
  const stepX = (maxX - minX) / nx || 1;
  const stepY = (maxY - minY) / ny || 1;
  const es = new Float64Array((nx + 1) * (ny + 1));
  const ns = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const [e, n] = localTo2180(minX + i * stepX, minY + j * stepY);
      es[j * (nx + 1) + i] = e;
      ns[j * (nx + 1) + i] = n;
    }
  }
  return (x, y, out) => {
    const fx = (x - minX) / stepX;
    const fy = (y - minY) / stepY;
    const i = Math.min(nx - 1, Math.max(0, Math.floor(fx)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor(fy)));
    const tx = fx - i;
    const ty = fy - j;
    const a = j * (nx + 1) + i;
    const b = a + nx + 1;
    out[0] = (es[a] * (1 - tx) + es[a + 1] * tx) * (1 - ty) + (es[b] * (1 - tx) + es[b + 1] * tx) * ty;
    out[1] = (ns[a] * (1 - tx) + ns[a + 1] * tx) * (1 - ty) + (ns[b] * (1 - tx) + ns[b + 1] * tx) * ty;
  };
}

/** Wartość komórki zawierającej punkt (E, N) albo NaN poza rastrem. */
export function sampleNearest(raster: Raster2180, e: number, n: number): number {
  const col = Math.floor((e - raster.west) / raster.cellM);
  const row = Math.floor((raster.north - n) / raster.cellM);
  if (col < 0 || row < 0 || col >= raster.cols || row >= raster.rows) return NaN;
  return raster.data[row * raster.cols + col];
}

/** Interpolacja dwuliniowa między środkami komórek; przy krawędzi lub sąsiedzie bez danych — najbliższa komórka. */
export function sampleBilinear(raster: Raster2180, e: number, n: number): number {
  const fx = (e - raster.west) / raster.cellM - 0.5;
  const fy = (raster.north - n) / raster.cellM - 0.5;
  const col = Math.floor(fx);
  const row = Math.floor(fy);
  if (col < 0 || row < 0 || col + 1 >= raster.cols || row + 1 >= raster.rows) return sampleNearest(raster, e, n);
  const tx = fx - col;
  const ty = fy - row;
  const i = row * raster.cols + col;
  const v00 = raster.data[i];
  const v10 = raster.data[i + 1];
  const v01 = raster.data[i + raster.cols];
  const v11 = raster.data[i + raster.cols + 1];
  const value = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  return value === value ? value : sampleNearest(raster, e, n);
}

/**
 * Przepróbkowuje raster EPSG:2180 do siatki w lokalnych metrach (wiersz 0 = południe, jak HeightRaster).
 * 'nearest' zachowuje ostre krawędzie (nDSM, dachy), 'bilinear' nadaje się do gładkich pól (teren).
 */
export function resampleToLocal(source: Raster2180, grid: GridSpec, mode: 'nearest' | 'bilinear' = 'nearest'): HeightRaster {
  const { x0, y0, cellM, cols, rows } = grid;
  const project = createLocalTo2180([x0, y0, x0 + cols * cellM, y0 + rows * cellM]);
  const sample = mode === 'nearest' ? sampleNearest : sampleBilinear;
  const data = new Float32Array(cols * rows);
  const en = new Float64Array(2);
  for (let row = 0; row < rows; row++) {
    const y = y0 + (row + 0.5) * cellM;
    for (let col = 0; col < cols; col++) {
      project(x0 + (col + 0.5) * cellM, y, en);
      data[row * cols + col] = sample(source, en[0], en[1]);
    }
  }
  return { x0, y0, cellM, cols, rows, data };
}

// ───────────────────────── siatki kafli ─────────────────────────
// Kafle LiDAR mają te same indeksy co kafle OSM (osm/store.ts: 0,03° × 0,02°). W lokalnych metrach kafel jest
// prostokątem równoległym do osi, ale o niecałkowitych krawędziach — dlatego komórki rastra leżą na GLOBALNEJ
// siatce (krawędzie w wielokrotnościach rozmiaru komórki), a kafel „posiada" te komórki, których środek leży
// w jego prostokącie [min, max). Sąsiednie kafle nie mają więc ani dziur, ani nakładek i sklejają się 1:1.

export const NDSM_CELL_M = 1;
export const VEG_CELL_M = 2;
export const TERRAIN_CELL_M = 10;

/** Prostokąt kafla w lokalnych metrach [minX, minY, maxX, maxY]. */
export function tileRectXY(tile: TileIndex): [number, number, number, number] {
  const bbox = tileBBox(tile);
  const [minX, minY] = toXY(bbox.south, bbox.west);
  const [maxX, maxY] = toXY(bbox.north, bbox.east);
  return [minX, minY, maxX, maxY];
}

/** Zakres [od, do) indeksów komórek globalnej siatki o boku cellM, których środek leży w [min, max). */
export function ownedCells(min: number, max: number, cellM: number): [number, number] {
  // "+ 0" zamienia -0 na 0 (Math.ceil(-0.5) === -0).
  return [Math.ceil(min / cellM - 0.5) + 0, Math.ceil(max / cellM - 0.5) + 0];
}

/** Siatka kafla na globalnej siatce o boku cellM. */
export function tileGrid(tile: TileIndex, cellM: number): GridSpec {
  const [minX, minY, maxX, maxY] = tileRectXY(tile);
  const [i0, i1] = ownedCells(minX, maxX, cellM);
  const [j0, j1] = ownedCells(minY, maxY, cellM);
  return { x0: i0 * cellM, y0: j0 * cellM, cellM, cols: i1 - i0, rows: j1 - j0 };
}

/**
 * Siatka nDSM kafla (1 m): dokładnie komórki 1 m zagnieżdżone w komórkach 2 m należących do kafla,
 * żeby raster roślinności 2 m powstawał z pełnych bloków 2×2.
 */
export function tileNdsmGrid(tile: TileIndex): GridSpec {
  const coarse = tileGrid(tile, VEG_CELL_M);
  const factor = VEG_CELL_M / NDSM_CELL_M;
  return { x0: coarse.x0, y0: coarse.y0, cellM: NDSM_CELL_M, cols: coarse.cols * factor, rows: coarse.rows * factor };
}

export function tileTerrainGrid(tile: TileIndex): GridSpec {
  return tileGrid(tile, TERRAIN_CELL_M);
}

/** Bbox (WGS84) lokalnego prostokąta — do wyznaczenia kafli pokrywających AreaData.bboxXY. */
export function rectToBBoxLatLon(rect: [number, number, number, number]): BBoxLatLon {
  const [south, west] = toLatLon(rect[0], rect[1]);
  const [north, east] = toLatLon(rect[2], rect[3]);
  return { west, south, east, north };
}

/** Najmniejsza siatka (o boku cellM) obejmująca siatki składowe; null dla pustej listy. */
export function unionGrid(grids: GridSpec[], cellM: number): GridSpec | null {
  if (grids.length === 0) return null;
  const minX = Math.min(...grids.map((g) => g.x0));
  const minY = Math.min(...grids.map((g) => g.y0));
  const maxX = Math.max(...grids.map((g) => g.x0 + g.cols * g.cellM));
  const maxY = Math.max(...grids.map((g) => g.y0 + g.rows * g.cellM));
  return { x0: minX, y0: minY, cellM, cols: Math.round((maxX - minX) / cellM), rows: Math.round((maxY - minY) / cellM) };
}
