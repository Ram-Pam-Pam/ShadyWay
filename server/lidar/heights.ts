// Wysokości z LiDAR-u: wysokość dachu budynku z nDSM (NMPT − NMT) w obrysie oraz raster roślinności i terenu.
//
// Znane ograniczenie klasyfikacji: „roślinność" to wszystko, co ma ≥ 2,5 m i NIE leży w obrysie budynku z OSM
// (z buforem). Trafiają tu więc także wysokie obiekty niebędące ani budynkiem, ani zielenią: mosty i wiadukty,
// mury, wiaty i budowle nieskatalogowane w OSM, pojazdy wyższe niż 2,5 m (tramwaje, ciężarówki stojące w chwili
// nalotu), rusztowania. Filtr drobin usuwa tylko obiekty cienkie (latarnie, przewody, pojedyncze piksele szumu).

import type { Building, HeightRaster } from '../contracts.ts';

/** Percentyl komórek nDSM w obrysie przyjmowany za wysokość dachu (odporny na kominy/wieżyczki i na dziedzińce). */
export const ROOF_PERCENTILE = 0.85;
/** Komórki bliżej niż tyle od obrysu są pomijane (przesunięcie obrysu OSM względem LiDAR-u, okapy, ściany). */
export const EDGE_MARGIN_M = 1;
/** Minimalna liczba ważnych komórek w obrysie, żeby zaufać wysokości z LiDAR-u. */
export const MIN_ROOF_CELLS = 8;
export const MIN_ROOF_HEIGHT_M = 2;
export const MAX_ROOF_HEIGHT_M = 150;

export const VEGETATION_MIN_HEIGHT_M = 2.5;
export const BUILDING_BUFFER_M = 1.5;
export const VEGETATION_CELL_M = 2;
/** Wyższe „drzewa" to niemal na pewno budowle spoza OSM — wysokość jest przycinana. */
export const VEGETATION_MAX_HEIGHT_M = 40;
/** Komórka zostaje, gdy w jej otoczeniu 3×3 (wraz z nią) jest co najmniej tyle komórek-kandydatów. */
export const SPECK_MIN_NEIGHBOURS = 4;
export const TERRAIN_CELL_M = 10;

export interface GridSpec {
  x0: number;
  y0: number;
  cellM: number;
  cols: number;
  rows: number;
}

/** Percentyl (0..1) z interpolacją liniową; `values` nie musi być posortowane (nie jest modyfikowane). */
export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float64Array.from(values).sort();
  if (sorted.length === 0) return NaN;
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Wypełnianie wielokąta liniami poziomymi (reguła parzystości — pierścienie wewnętrzne wycinają dziury).
 * Woła `span(row, colFrom, colTo)` (colTo wyłącznie) dla komórek siatki, których ŚRODEK leży w wielokącie.
 */
export function scanPolygon(
  rings: number[][],
  grid: GridSpec,
  span: (row: number, colFrom: number, colTo: number) => void,
): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] < minY) minY = ring[i];
      if (ring[i] > maxY) maxY = ring[i];
    }
  }
  if (!(minY <= maxY)) return;
  const { x0, y0, cellM, cols, rows } = grid;
  const rowFrom = Math.max(0, Math.ceil((minY - y0) / cellM - 0.5));
  const rowTo = Math.min(rows - 1, Math.floor((maxY - y0) / cellM - 0.5));
  const xs: number[] = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    const y = y0 + (row + 0.5) * cellM;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        const ay = ring[i + 1];
        const by = ring[i + 3];
        // Półotwarty przedział w y: wierzchołek leżący dokładnie na linii liczony jest raz.
        if (ay <= y === by <= y) continue;
        xs.push(ring[i] + ((y - ay) / (by - ay)) * (ring[i + 2] - ring[i]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const colFrom = Math.max(0, Math.ceil((xs[k] - x0) / cellM - 0.5));
      const colTo = Math.min(cols, Math.floor((xs[k + 1] - x0) / cellM - 0.5) + 1);
      if (colTo > colFrom) span(row, colFrom, colTo);
    }
  }
}

function buildingRings(building: Pick<Building, 'ring' | 'holes'>): number[][] {
  return building.holes && building.holes.length > 0 ? [building.ring, ...building.holes] : [building.ring];
}

function ringBounds(ring: number[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < ring.length; i += 2) {
    if (ring[i] < minX) minX = ring[i];
    if (ring[i] > maxX) maxX = ring[i];
    if (ring[i + 1] < minY) minY = ring[i + 1];
    if (ring[i + 1] > maxY) maxY = ring[i + 1];
  }
  return [minX, minY, maxX, maxY];
}

/** Czy obrys (bbox pierścienia zewnętrznego) mieści się w całości w rastrze. */
export function footprintInsideRaster(building: Pick<Building, 'ring'>, raster: GridSpec): boolean {
  const [minX, minY, maxX, maxY] = ringBounds(building.ring);
  return (
    minX >= raster.x0 &&
    minY >= raster.y0 &&
    maxX <= raster.x0 + raster.cols * raster.cellM &&
    maxY <= raster.y0 + raster.rows * raster.cellM
  );
}

export interface FootprintSamples {
  /** Wartości nDSM w komórkach odsuniętych od obrysu o EDGE_MARGIN_M. */
  inner: number[];
  /** Wartości we wszystkich komórkach obrysu (zapas dla wąskich budynków, w których po odsunięciu nic nie zostaje). */
  all: number[];
}

/**
 * Próbki nDSM z wnętrza obrysu (pierścień zewnętrzny minus dziedzińce). Komórki bez danych (NaN) i leżące poza
 * rastrem są pomijane — obrys przecięty krawędzią rastra daje próbki tylko z części wspólnej.
 */
export function footprintSamples(
  building: Pick<Building, 'ring' | 'holes'>,
  ndsm: HeightRaster,
  marginM: number = EDGE_MARGIN_M,
): FootprintSamples {
  const { cellM } = ndsm;
  const [minX, minY, maxX, maxY] = ringBounds(building.ring);
  const samples: FootprintSamples = { inner: [], all: [] };
  if (!(minX <= maxX)) return samples;

  // Lokalna maska na siatce zgodnej z rastrem, obejmująca cały obrys (także poza rastrem) + 1 komórka zapasu,
  // żeby odsunięcie od krawędzi nie zależało od tego, gdzie raster się kończy.
  const colMin = Math.floor((minX - ndsm.x0) / cellM) - 1;
  const rowMin = Math.floor((minY - ndsm.y0) / cellM) - 1;
  const cols = Math.floor((maxX - ndsm.x0) / cellM) + 2 - colMin;
  const rows = Math.floor((maxY - ndsm.y0) / cellM) + 2 - rowMin;
  if (cols <= 0 || rows <= 0 || cols * rows > 25_000_000) return samples;
  // Obrys w całości poza rastrem.
  if (colMin >= ndsm.cols || rowMin >= ndsm.rows || colMin + cols <= 0 || rowMin + rows <= 0) return samples;

  const local: GridSpec = { x0: ndsm.x0 + colMin * cellM, y0: ndsm.y0 + rowMin * cellM, cellM, cols, rows };
  const mask = new Uint8Array(cols * rows);
  scanPolygon(buildingRings(building), local, (row, from, to) => mask.fill(1, row * cols + from, row * cols + to));

  const radius = Math.max(0, Math.round(marginM / cellM));
  for (let row = 0; row < rows; row++) {
    const srcRow = row + rowMin;
    if (srcRow < 0 || srcRow >= ndsm.rows) continue;
    for (let col = 0; col < cols; col++) {
      if (!mask[row * cols + col]) continue;
      const srcCol = col + colMin;
      if (srcCol < 0 || srcCol >= ndsm.cols) continue;
      const value = ndsm.data[srcRow * ndsm.cols + srcCol];
      if (!Number.isFinite(value)) continue;
      samples.all.push(value);
      let interior = true;
      for (let dr = -radius; dr <= radius && interior; dr++) {
        const r = row + dr;
        for (let dc = -radius; dc <= radius; dc++) {
          const c = col + dc;
          if (r < 0 || r >= rows || c < 0 || c >= cols || !mask[r * cols + c]) {
            interior = false;
            break;
          }
        }
      }
      if (interior) samples.inner.push(value);
    }
  }
  return samples;
}

/**
 * Wysokość dachu z próbek albo null, gdy próbek jest za mało lub wynik jest niewiarygodny
 * (poza 2–150 m, np. budynek powstał po nalocie albo obrys nie pokrywa się z niczym wysokim).
 */
export function roofHeightFromSamples(samples: FootprintSamples, minHeight = 0): number | null {
  const values = samples.inner.length >= MIN_ROOF_CELLS ? samples.inner : samples.all;
  if (values.length < MIN_ROOF_CELLS) return null;
  const height = Math.round(percentile(values, ROOF_PERCENTILE) * 10) / 10;
  if (!(height >= MIN_ROOF_HEIGHT_M && height <= MAX_ROOF_HEIGHT_M)) return null;
  // Bryła „wisząca" (min_height > 0) nie może mieć dachu poniżej własnej dolnej krawędzi.
  if (height <= minHeight + 0.5) return null;
  return height;
}

export function lidarRoofHeight(building: Building, ndsm: HeightRaster): number | null {
  return roofHeightFromSamples(footprintSamples(building, ndsm), building.minHeight);
}

/**
 * Ustawia building.height na wysokość dachu z nDSM (85. percentyl komórek w obrysie) i heightSource = 'lidar'.
 * Budynki bez danych LiDAR lub z niewiarygodnym wynikiem zachowują dotychczasową wysokość. Zwraca liczbę zmienionych.
 */
export function applyLidarHeights(buildings: Building[], ndsm: HeightRaster): number {
  let changed = 0;
  for (const building of buildings) {
    const height = lidarRoofHeight(building, ndsm);
    if (height === null) continue;
    building.height = height;
    building.heightSource = 'lidar';
    changed++;
  }
  return changed;
}

/** Maska obrysów budynków (1 = komórka, której środek leży w budynku; dziedzińce = 0). */
export function rasterizeFootprints(buildings: Pick<Building, 'ring' | 'holes'>[], grid: GridSpec): Uint8Array {
  const mask = new Uint8Array(grid.cols * grid.rows);
  const { cols } = grid;
  for (const building of buildings) {
    scanPolygon(buildingRings(building), grid, (row, from, to) => mask.fill(1, row * cols + from, row * cols + to));
  }
  return mask;
}

/** Dylatacja maski kwadratem (2r+1)×(2r+1) — rozdzielnie w wierszach i kolumnach. */
export function dilateMask(mask: Uint8Array, cols: number, rows: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const horizontal = new Uint8Array(mask.length);
  for (let row = 0; row < rows; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      if (!mask[base + col]) continue;
      const from = Math.max(0, col - radius);
      const to = Math.min(cols - 1, col + radius);
      for (let c = from; c <= to; c++) horizontal[base + c] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let row = 0; row < rows; row++) {
    const base = row * cols;
    const from = Math.max(0, row - radius);
    const to = Math.min(rows - 1, row + radius);
    for (let col = 0; col < cols; col++) {
      if (!horizontal[base + col]) continue;
      for (let r = from; r <= to; r++) out[r * cols + col] = 1;
    }
  }
  return out;
}

/**
 * Filtr drobin: usuwa komórki, które w otoczeniu 3×3 (wraz z sobą) mają mniej niż `minNeighbours` komórek maski.
 * Pojedyncze piksele, latarnie (1–2 komórki) i przewody (linie o szerokości 1 komórki — 3 w otoczeniu) znikają,
 * zwarte plamy ≥ 2×2 zostają.
 */
export function removeSpecks(
  mask: Uint8Array,
  cols: number,
  rows: number,
  minNeighbours: number = SPECK_MIN_NEIGHBOURS,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let row = 0; row < rows; row++) {
    const rFrom = Math.max(0, row - 1);
    const rTo = Math.min(rows - 1, row + 1);
    for (let col = 0; col < cols; col++) {
      if (!mask[row * cols + col]) continue;
      const cFrom = Math.max(0, col - 1);
      const cTo = Math.min(cols - 1, col + 1);
      let count = 0;
      for (let r = rFrom; r <= rTo; r++) {
        const base = r * cols;
        for (let c = cFrom; c <= cTo; c++) count += mask[base + c];
      }
      if (count >= minNeighbours) out[row * cols + col] = 1;
    }
  }
  return out;
}

export interface VegetationOptions {
  minHeightM?: number;
  bufferM?: number;
  outCellM?: number;
  maxHeightM?: number;
  minNeighbours?: number;
}

/**
 * Raster roślinności: maksymalna wysokość koron w komórkach ~2 m. Kandydat = komórka nDSM ≥ 2,5 m poza obrysami
 * budynków poszerzonymi o ~1,5 m; po odfiltrowaniu drobin. 0 = brak roślinności, NaN = brak danych w całej komórce.
 * (Co poza drzewami trafia do tego rastra — patrz komentarz na górze pliku.)
 */
export function vegetationRaster(
  ndsm: HeightRaster,
  buildings: Pick<Building, 'ring' | 'holes'>[],
  options: VegetationOptions = {},
): HeightRaster {
  const minHeight = options.minHeightM ?? VEGETATION_MIN_HEIGHT_M;
  const maxHeight = options.maxHeightM ?? VEGETATION_MAX_HEIGHT_M;
  const { cols, rows, cellM, data } = ndsm;
  const bufferCells = Math.floor((options.bufferM ?? BUILDING_BUFFER_M) / cellM);
  const built = dilateMask(rasterizeFootprints(buildings, ndsm), cols, rows, bufferCells);

  const candidates = new Uint8Array(cols * rows);
  for (let i = 0; i < candidates.length; i++) {
    if (!built[i] && data[i] >= minHeight) candidates[i] = 1;
  }
  const kept = removeSpecks(candidates, cols, rows, options.minNeighbours ?? SPECK_MIN_NEIGHBOURS);

  const factor = Math.max(1, Math.round((options.outCellM ?? VEGETATION_CELL_M) / cellM));
  const outCols = Math.ceil(cols / factor);
  const outRows = Math.ceil(rows / factor);
  const out = new Float32Array(outCols * outRows);
  for (let outRow = 0; outRow < outRows; outRow++) {
    for (let outCol = 0; outCol < outCols; outCol++) {
      let max = 0;
      let known = false;
      const rEnd = Math.min(rows, (outRow + 1) * factor);
      const cEnd = Math.min(cols, (outCol + 1) * factor);
      for (let r = outRow * factor; r < rEnd; r++) {
        for (let c = outCol * factor; c < cEnd; c++) {
          const i = r * cols + c;
          const value = data[i];
          if (value !== value) continue; // NaN
          known = true;
          if (kept[i] && value > max) max = value;
        }
      }
      out[outRow * outCols + outCol] = known ? Math.min(max, maxHeight) : NaN;
    }
  }
  return { x0: ndsm.x0, y0: ndsm.y0, cellM: cellM * factor, cols: outCols, rows: outRows, data: out };
}

/** Zmniejsza rozdzielczość rastra uśredniając bloki komórek (NaN pomijane; blok bez danych → NaN). Do rastra terenu ~10 m. */
export function terrainRaster(dtm: HeightRaster, outCellM: number = TERRAIN_CELL_M): HeightRaster {
  const factor = Math.max(1, Math.round(outCellM / dtm.cellM));
  const outCols = Math.ceil(dtm.cols / factor);
  const outRows = Math.ceil(dtm.rows / factor);
  const out = new Float32Array(outCols * outRows);
  for (let outRow = 0; outRow < outRows; outRow++) {
    for (let outCol = 0; outCol < outCols; outCol++) {
      let sum = 0;
      let count = 0;
      const rEnd = Math.min(dtm.rows, (outRow + 1) * factor);
      const cEnd = Math.min(dtm.cols, (outCol + 1) * factor);
      for (let r = outRow * factor; r < rEnd; r++) {
        for (let c = outCol * factor; c < cEnd; c++) {
          const value = dtm.data[r * dtm.cols + c];
          if (value !== value) continue;
          sum += value;
          count++;
        }
      }
      out[outRow * outCols + outCol] = count > 0 ? sum / count : NaN;
    }
  }
  return { x0: dtm.x0, y0: dtm.y0, cellM: dtm.cellM * factor, cols: outCols, rows: outRows, data: out };
}
