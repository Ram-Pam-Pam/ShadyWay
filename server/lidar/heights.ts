// Wysokości z LiDAR-u: wysokość dachu budynku z nDSM (NMPT − NMT) w obrysie oraz raster roślinności i terenu.
//
// Klasyfikacja: „roślinność" to wszystko, co ma ≥ 2,5 m i NIE leży w obrysie budynku z OSM (z buforem) ani na
// pomoście mostu (v3: obrysy mostów z OSM potwierdzone w nDSM — patrz detectDecks). Nadal trafiają tu wysokie
// obiekty niebędące ani budynkiem, ani zielenią: mury, wiaty i budowle nieskatalogowane w OSM, pojazdy wyższe
// niż 2,5 m (tramwaje, ciężarówki stojące w chwili nalotu), rusztowania, mosty niezmapowane w OSM.
// Filtr drobin usuwa tylko obiekty cienkie (latarnie, przewody, pojedyncze piksele szumu).
//
// v3 — analiza wysokości drzew z nDSM:
//  - dolna granica koron (vegetationLayers): z wysokości drzewa w otoczeniu i z wysokości „rąbka" korony,
//  - budynki pod koronami (isCanopyContaminated): mały obrys, którego „dach" w nDSM to w rzeczywistości korona.

import type { Building, HeightRaster } from '../contracts.ts';

declare module '../contracts.ts' {
  interface LidarData {
    /**
     * v3: dolna granica warstwy koron nad terenem dla komórek rastra `vegetation` (ta sama siatka), w jednostkach
     * CROWN_BASE_UNIT_M; 0 = brak oszacowania (scena stosuje wtedy stałą regułę max(2 m, 35% wysokości)).
     */
    crownBase?: Uint8Array | null;
    /** v3: pomosty mostów/wiaduktów (obrysy z OSM potwierdzone w nDSM) — wycięte z rastra roślinności. */
    decks?: BridgeDeck[];
  }
}

/** Pomost potwierdzony w danych LiDAR. */
export interface BridgeDeck {
  /** Zamknięty pierścień w metrach lokalnych (z AreaData.bridgeAreas). */
  ring: number[];
  /** Mediana wysokości pomostu nad terenem (m). */
  heightM: number;
  /** Mediana rzędnej wierzchu pomostu (m n.p.m.; bez rastra terenu = heightM). */
  topZ: number;
}

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

/** Jednostka zapisu dolnej granicy koron (LidarData.crownBase). */
export const CROWN_BASE_UNIT_M = 0.1;
/** Otoczenie (w komórkach rastra roślinności, ±) do wyznaczenia wysokości drzewa i wysokości rąbka korony. */
const CROWN_WINDOW_CELLS = 2;
/** Poniżej tej wysokości drzewa w otoczeniu roślinność to krzewy/żywopłoty/młode drzewka — ulistnione niemal od ziemi. */
export const SHRUB_MAX_HEIGHT_M = 5;
const SHRUB_CROWN_BASE_M = 0.8;
/** Granice podstawy korony jako ułamek wysokości drzewa (drzewa miejskie: ok. 0,2–0,4). */
const CROWN_BASE_MIN_FRACTION = 0.2;
const CROWN_BASE_MAX_FRACTION = 0.4;
/** Zwarty drzewostan bez widocznego brzegu koron w otoczeniu — wartość typowa. */
const CROWN_BASE_CLOSED_FRACTION = 0.3;
/**
 * Podstawa korony leży poniżej rąbka (brzegu korony widzianego z góry): model powierzchni widzi wierzch liści
 * na brzegu, a nie ich spód. W centrum Krakowa średni rąbek to ok. 0,5–0,6 wysokości drzewa → podstawa ok. 0,3–0,36.
 */
const CROWN_SKIRT_FACTOR = 0.6;
const CROWN_BASE_FLOOR_M = 2;
const CROWN_MIN_SKIRT_CELLS = 3;
/**
 * Minimalna grubość warstwy korony w komórce: max(1,5 m, 45% wysokości komórki). Komórka wyraźnie niższa od drzewa
 * w otoczeniu to brzeg korony albo niższe drzewo obok — w obu przypadkach liście są tuż pod jej szczytem.
 */
const CROWN_MIN_THICKNESS_M = 1.5;
const CROWN_MIN_THICKNESS_FRACTION = 0.45;

/** Pomost: co najmniej tyle wysokich komórek w obrysie i chropowatość (mediana |Δ| sąsiednich komórek) do progu. */
const DECK_MIN_HIGH_CELLS = 12;
const DECK_MAX_ROUGHNESS_M = 0.35;

/** Budynek pod koronami: obrys do tylu komórek 1 m, „dach" co najmniej tej wysokości… */
export const CANOPY_MAX_FOOTPRINT_CELLS = 200;
export const CANOPY_MIN_ROOF_M = 6;
/** …otoczony (pierścień 2–4 m od obrysu, poza budynkami) w tej części roślinnością o medianie ≥ tej części wysokości „dachu"… */
export const CANOPY_RING_FRACTION = 0.6;
export const CANOPY_RING_HEIGHT_RATIO = 0.6;
const CANOPY_MIN_RING_CELLS = 12;
/** …i bez gładkiej połaci: mediana |Δ| wysokości sąsiednich komórek obrysu co najmniej tyle. */
export const CANOPY_MIN_ROUGHNESS_M = 0.6;
/** Dach to nie korona, gdy 15. percentyl wysokości w obrysie przekracza 75% „dachu" (wieża, płaski dach). */
const CANOPY_LOW_PERCENTILE = 0.15;
const CANOPY_MAX_FLATNESS = 0.75;
const CANOPY_DENSE_RING_FRACTION = 0.9;
/** Prześwity w koronie odsłaniają niski dach, gdy 15. percentyl jest najwyżej połową „dachu" — wtedy to on jest wysokością. */
const CANOPY_REVEALED_ROOF_RATIO = 0.5;
const CANOPY_RING_INNER = 2;
const CANOPY_RING_OUTER = 4;

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
  /**
   * v3, tylko dla małych obrysów o wysokim „dachu": nDSM w pierścieniu 2–4 m wokół obrysu (poza budynkami) oraz |Δ| wysokości
   * sąsiednich komórek obrysu — do wykrywania budynków przykrytych koronami drzew.
   */
  ring?: number[];
  diffs?: number[];
}

export interface FootprintContext {
  /** Maska wszystkich budynków na siatce nDSM (rasterizeFootprints) — komórki sąsiednich budynków nie są „otoczeniem". */
  built?: Uint8Array;
}

/**
 * Próbki nDSM z wnętrza obrysu (pierścień zewnętrzny minus dziedzińce). Komórki bez danych (NaN) i leżące poza
 * rastrem są pomijane — obrys przecięty krawędzią rastra daje próbki tylko z części wspólnej.
 */
export function footprintSamples(
  building: Pick<Building, 'ring' | 'holes'>,
  ndsm: HeightRaster,
  marginM: number = EDGE_MARGIN_M,
  context: FootprintContext = {},
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
  // Otoczenie zbieramy tylko dla kandydatów na „budynek pod koroną" (mały obrys, „dach" 6–40 m).
  if (mayBeCanopy(samples)) collectCanopyEvidence(samples, ndsm, mask, { colMin, rowMin, cols, rows }, context.built);
  return samples;
}

/** Wartości, z których liczony jest dach: komórki odsunięte od obrysu, a gdy jest ich za mało — wszystkie. */
function roofValues(samples: FootprintSamples): number[] {
  return samples.inner.length >= MIN_ROOF_CELLS ? samples.inner : samples.all;
}

/** Tanie warunki wstępne isCanopyContaminated (bez otoczenia): rozmiar obrysu i wysokość „dachu". */
function mayBeCanopy(samples: FootprintSamples): boolean {
  const count = samples.all.length;
  if (count < MIN_ROOF_CELLS || count > CANOPY_MAX_FOOTPRINT_CELLS) return false;
  const roof = percentile(roofValues(samples), ROOF_PERCENTILE);
  return roof >= CANOPY_MIN_ROOF_M - 0.05 && roof <= VEGETATION_MAX_HEIGHT_M + 0.05;
}

/** Uzupełnia próbki małego obrysu o otoczenie (pierścień poza budynkami) i chropowatość „dachu". */
function collectCanopyEvidence(
  samples: FootprintSamples,
  ndsm: HeightRaster,
  mask: Uint8Array,
  local: { colMin: number; rowMin: number; cols: number; rows: number },
  built: Uint8Array | undefined,
): void {
  const { colMin, rowMin, cols, rows } = local;
  const value = (row: number, col: number): number => {
    const r = row + rowMin;
    const c = col + colMin;
    return r < 0 || r >= ndsm.rows || c < 0 || c >= ndsm.cols ? NaN : ndsm.data[r * ndsm.cols + c];
  };
  const diffs: number[] = [];
  let minRow = rows;
  let maxRow = -1;
  let minCol = cols;
  let maxCol = -1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!mask[row * cols + col]) continue;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      const v = value(row, col);
      if (v !== v) continue;
      if (col + 1 < cols && mask[row * cols + col + 1]) {
        const d = Math.abs(v - value(row, col + 1));
        if (d === d) diffs.push(d);
      }
      if (row + 1 < rows && mask[(row + 1) * cols + col]) {
        const d = Math.abs(v - value(row + 1, col));
        if (d === d) diffs.push(d);
      }
    }
  }
  // Pierścień: komórki w odległości (Czebyszewa) 2–4 od obrysu, poza jakimkolwiek budynkiem.
  const ring: number[] = [];
  const near = (row: number, col: number, radius: number): boolean => {
    for (let r = Math.max(0, row - radius); r <= Math.min(rows - 1, row + radius); r++) {
      for (let c = Math.max(0, col - radius); c <= Math.min(cols - 1, col + radius); c++) {
        if (mask[r * cols + c]) return true;
      }
    }
    return false;
  };
  for (let row = minRow - CANOPY_RING_OUTER; row <= maxRow + CANOPY_RING_OUTER; row++) {
    const srcRow = row + rowMin;
    if (srcRow < 0 || srcRow >= ndsm.rows) continue;
    for (let col = minCol - CANOPY_RING_OUTER; col <= maxCol + CANOPY_RING_OUTER; col++) {
      const srcCol = col + colMin;
      if (srcCol < 0 || srcCol >= ndsm.cols) continue;
      if (built && built[srcRow * ndsm.cols + srcCol]) continue;
      if (near(row, col, CANOPY_RING_INNER - 1) || !near(row, col, CANOPY_RING_OUTER)) continue;
      const v = ndsm.data[srcRow * ndsm.cols + srcCol];
      if (v === v) ring.push(v);
    }
  }
  samples.ring = ring;
  samples.diffs = diffs;
}

export interface CanopyEvidence {
  /** Udział komórek pierścienia z roślinnością (≥ 2,5 m). */
  ringFraction: number;
  /** Mediana wysokości roślinności w pierścieniu (m); NaN, gdy jej nie ma. */
  ringMedianM: number;
  /** Mediana |Δ| wysokości sąsiednich komórek obrysu (m). */
  roughnessM: number;
}

/** Dane do oceny, czy „dach" małego obrysu to korona drzewa; null, gdy obrys jest duży albo brak otoczenia. */
export function canopyEvidence(samples: FootprintSamples): CanopyEvidence | null {
  const { ring, diffs } = samples;
  if (!ring || !diffs || ring.length < CANOPY_MIN_RING_CELLS || diffs.length < 4) return null;
  const vegetation = ring.filter((v) => v >= VEGETATION_MIN_HEIGHT_M);
  return {
    ringFraction: vegetation.length / ring.length,
    ringMedianM: vegetation.length > 0 ? percentile(vegetation, 0.5) : NaN,
    roughnessM: percentile(diffs, 0.5),
  };
}

/**
 * Budynek „skażony" koroną: mały obrys (≤ 200 m²), którego 85. percentyl nDSM jest wysoki (6–40 m), otoczony
 * roślinnością podobnej wysokości i bez płaskiego ani gładkiego dachu (chropowata powierzchnia oraz duży rozrzut
 * wysokości w obrysie — 15. percentyl ≤ 75% „dachu" — albo otoczenie niemal w całości zadrzewione). Taki budynek (garaż, kiosk, altana pod drzewami)
 * dostałby wysokość korony i stał się nieprzezroczystym graniastosłupem 10–20 m.
 * Wieże i kominy (jednolita wysokość w obrysie albo > 40 m) nie spełniają tych warunków.
 */
export function isCanopyContaminated(samples: FootprintSamples, roofHeightM: number): boolean {
  if (!(roofHeightM >= CANOPY_MIN_ROOF_M && roofHeightM <= VEGETATION_MAX_HEIGHT_M)) return false;
  if (samples.all.length > CANOPY_MAX_FOOTPRINT_CELLS) return false;
  const evidence = canopyEvidence(samples);
  if (!evidence) return false;
  // Jednolita wysokość w obrysie to dach albo wieża — chyba że obrys jest niemal w całości otoczony drzewami
  // (zwarta korona nad budynkiem też bywa „równa").
  const flat = percentile(samples.all, CANOPY_LOW_PERCENTILE) > CANOPY_MAX_FLATNESS * roofHeightM;
  if (flat && evidence.ringFraction < CANOPY_DENSE_RING_FRACTION) return false;
  return (
    evidence.ringFraction >= CANOPY_RING_FRACTION &&
    evidence.ringMedianM >= CANOPY_RING_HEIGHT_RATIO * roofHeightM &&
    evidence.roughnessM >= CANOPY_MIN_ROUGHNESS_M
  );
}

/**
 * Wysokość dachu z próbek albo null, gdy próbek jest za mało lub wynik jest niewiarygodny
 * (poza 2–150 m, np. budynek powstał po nalocie albo obrys nie pokrywa się z niczym wysokim).
 */
export function roofHeightFromSamples(samples: FootprintSamples, minHeight = 0): number | null {
  const values = roofValues(samples);
  if (values.length < MIN_ROOF_CELLS) return null;
  const height = Math.round(percentile(values, ROOF_PERCENTILE) * 10) / 10;
  if (!(height >= MIN_ROOF_HEIGHT_M && height <= MAX_ROOF_HEIGHT_M)) return null;
  // Bryła „wisząca" (min_height > 0) nie może mieć dachu poniżej własnej dolnej krawędzi.
  if (height <= minHeight + 0.5) return null;
  // v3: „dach" to korona drzewa nad małym budynkiem. Jeśli przez prześwity widać dużo niższą powierzchnię
  // (15. percentyl ≤ połowa „dachu"), to ona jest dachem; inaczej LiDAR nic nie mówi i zostaje wysokość z OSM.
  if (isCanopyContaminated(samples, height)) {
    const low = Math.round(percentile(samples.all, CANOPY_LOW_PERCENTILE) * 10) / 10;
    const revealed = low >= MIN_ROOF_HEIGHT_M && low <= CANOPY_REVEALED_ROOF_RATIO * height && low > minHeight + 0.5;
    return revealed ? low : null;
  }
  return height;
}

export function lidarRoofHeight(building: Building, ndsm: HeightRaster, context: FootprintContext = {}): number | null {
  return roofHeightFromSamples(footprintSamples(building, ndsm, EDGE_MARGIN_M, context), building.minHeight);
}

/**
 * Ustawia building.height na wysokość dachu z nDSM (85. percentyl komórek w obrysie) i heightSource = 'lidar'.
 * Budynki bez danych LiDAR lub z niewiarygodnym wynikiem (w tym małe budynki pod koronami drzew — patrz
 * isCanopyContaminated) zachowują dotychczasową wysokość. Zwraca liczbę zmienionych.
 */
export function applyLidarHeights(buildings: Building[], ndsm: HeightRaster): number {
  let changed = 0;
  const context: FootprintContext = { built: rasterizeFootprints(buildings, ndsm) };
  for (const building of buildings) {
    const height = lidarRoofHeight(building, ndsm, context);
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
  /** Gotowa maska obrysów budynków na siatce nDSM (rasterizeFootprints) — żeby nie rasteryzować dwa razy. */
  built?: Uint8Array;
  /** Maska komórek nDSM wykluczonych z roślinności (pomosty mostów — detectDecks). */
  exclude?: Uint8Array;
}

export interface VegetationLayers {
  /** Szczyt koron (jak vegetationRaster). */
  top: HeightRaster;
  /** Dolna granica koron na siatce `top`, w jednostkach CROWN_BASE_UNIT_M (0 = brak roślinności). */
  crownBase: Uint8Array;
}

export interface DeckDetection {
  /** Maska komórek nDSM leżących na potwierdzonych pomostach (poszerzona o 1 komórkę). */
  mask: Uint8Array;
  decks: BridgeDeck[];
}

/**
 * Które obrysy mostów z OSM faktycznie są pomostami w nDSM: w obrysie jest co najmniej kilkanaście komórek
 * ≥ 2,5 m i tworzą one gładką powierzchnię (mediana |Δ| sąsiednich komórek ≤ 0,35 m; korony drzew mają > 0,5 m).
 * Niska kładka pod drzewami nie jest więc „pomostem" — korony nad nią zostają roślinnością.
 * `terrain` (rzędne terenu) pozwala podać rzędną wierzchu pomostu; bez niego topZ = wysokość nad terenem.
 */
export function detectDecks(
  ndsm: HeightRaster,
  rings: number[][],
  terrain?: HeightRaster | null,
  minHeightM: number = VEGETATION_MIN_HEIGHT_M,
): DeckDetection {
  const { cols, rows, data } = ndsm;
  const mask = new Uint8Array(cols * rows);
  const decks: BridgeDeck[] = [];
  if (rings.length === 0) return { mask, decks };
  const inRing = new Uint8Array(cols * rows);
  const maxX = ndsm.x0 + cols * ndsm.cellM;
  const maxY = ndsm.y0 + rows * ndsm.cellM;
  const spans: number[] = [];
  for (const ring of rings) {
    const [rx0, ry0, rx1, ry1] = ringBounds(ring);
    if (!(rx0 <= rx1) || rx1 < ndsm.x0 || rx0 > maxX || ry1 < ndsm.y0 || ry0 > maxY) continue;
    spans.length = 0;
    scanPolygon([ring], ndsm, (row, from, to) => {
      spans.push(row, from, to);
      inRing.fill(1, row * cols + from, row * cols + to);
    });
    const heights: number[] = [];
    const tops: number[] = [];
    const diffs: number[] = [];
    for (let k = 0; k < spans.length; k += 3) {
      const row = spans[k];
      for (let col = spans[k + 1]; col < spans[k + 2]; col++) {
        const i = row * cols + col;
        const v = data[i];
        if (!(v >= minHeightM)) continue;
        heights.push(v);
        if (terrain) {
          const z = rasterValueAt(terrain, ndsm.x0 + (col + 0.5) * ndsm.cellM, ndsm.y0 + (row + 0.5) * ndsm.cellM);
          if (z === z) tops.push(z + v);
        }
        if (col + 1 < cols && inRing[i + 1] && data[i + 1] >= minHeightM) diffs.push(Math.abs(v - data[i + 1]));
        if (row + 1 < rows && inRing[i + cols] && data[i + cols] >= minHeightM) diffs.push(Math.abs(v - data[i + cols]));
      }
    }
    const isDeck =
      heights.length >= DECK_MIN_HIGH_CELLS &&
      diffs.length >= DECK_MIN_HIGH_CELLS &&
      percentile(diffs, 0.5) <= DECK_MAX_ROUGHNESS_M;
    for (let k = 0; k < spans.length; k += 3) {
      const base = spans[k] * cols;
      inRing.fill(0, base + spans[k + 1], base + spans[k + 2]);
      if (isDeck) mask.fill(1, base + spans[k + 1], base + spans[k + 2]);
    }
    if (isDeck) {
      const heightM = Math.round(percentile(heights, 0.5) * 10) / 10;
      decks.push({ ring, heightM, topZ: tops.length > 0 ? Math.round(percentile(tops, 0.5) * 10) / 10 : heightM });
    }
  }
  return { mask: decks.length > 0 ? dilateMask(mask, cols, rows, 1) : mask, decks };
}

/** Wartość komórki rastra zawierającej punkt (NaN poza rastrem). */
function rasterValueAt(raster: HeightRaster, x: number, y: number): number {
  const col = Math.floor((x - raster.x0) / raster.cellM);
  const row = Math.floor((y - raster.y0) / raster.cellM);
  if (col < 0 || col >= raster.cols || row < 0 || row >= raster.rows) return NaN;
  return raster.data[row * raster.cols + col];
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
  return vegetationLayers(ndsm, buildings, options).top;
}

/**
 * Raster roślinności wraz z dolną granicą koron (v3). Dolna granica nie jest widoczna w modelu powierzchni wprost,
 * więc szacujemy ją z kształtu koron w nDSM 1 m:
 *  - wysokość drzewa H = maksimum szczytów w otoczeniu ±4 m (komórka na brzegu korony należy do wysokiego drzewa),
 *  - rąbek S = średnia wysokość komórek roślinności 1 m graniczących z otwartym terenem w otoczeniu ±4 m: brzeg
 *    korony widziany z góry leży mniej więcej na wysokości jej najszerszego miejsca, tuż nad podstawą
 *    (w centrum Krakowa mediana S/H ≈ 0,44; średnia, nie minimum — piksele brzegowe bywają mieszane),
 *  - H < 5 m (krzewy, żywopłoty, młode drzewka): ulistnienie od ok. 0,8 m,
 *  - drzewo z widocznym rąbkiem (pojedyncze, szpaler, aleja): podstawa = 0,6·S w granicach 0,2–0,4·H (min. 2 m) —
 *    wysokie drzewa alejowe o stromych brzegach koron mają więc korony wysoko i niskie słońce przechodzi POD nimi,
 *    a drzewa o nisko zwieszonych koronach zacieniają już od ok. 2 m,
 *  - zwarty drzewostan bez rąbka w pobliżu: 0,3·H,
 *  - warstwa w komórce ma co najmniej max(1,5 m, 45% jej wysokości) grubości (brzeg korony, niższe drzewo obok).
 */
export function vegetationLayers(
  ndsm: HeightRaster,
  buildings: Pick<Building, 'ring' | 'holes'>[],
  options: VegetationOptions = {},
): VegetationLayers {
  const minHeight = options.minHeightM ?? VEGETATION_MIN_HEIGHT_M;
  const maxHeight = options.maxHeightM ?? VEGETATION_MAX_HEIGHT_M;
  const { cols, rows, cellM, data } = ndsm;
  const bufferCells = Math.floor((options.bufferM ?? BUILDING_BUFFER_M) / cellM);
  const built = dilateMask(options.built ?? rasterizeFootprints(buildings, ndsm), cols, rows, bufferCells);
  const exclude = options.exclude;

  const candidates = new Uint8Array(cols * rows);
  for (let i = 0; i < candidates.length; i++) {
    if (!built[i] && data[i] >= minHeight && !(exclude && exclude[i])) candidates[i] = 1;
  }
  const kept = removeSpecks(candidates, cols, rows, options.minNeighbours ?? SPECK_MIN_NEIGHBOURS);

  const factor = Math.max(1, Math.round((options.outCellM ?? VEGETATION_CELL_M) / cellM));
  const outCols = Math.ceil(cols / factor);
  const outRows = Math.ceil(rows / factor);
  const out = new Float32Array(outCols * outRows);
  /** Rąbek: suma wysokości i liczba komórek roślinności 1 m w komórce wyjściowej, które graniczą z otwartym terenem. */
  const skirtSum = new Float32Array(outCols * outRows);
  const skirtCount = new Uint8Array(outCols * outRows);
  let anyVegetation = false;
  for (let outRow = 0; outRow < outRows; outRow++) {
    for (let outCol = 0; outCol < outCols; outCol++) {
      let max = 0;
      let edgeSum = 0;
      let edgeCount = 0;
      let known = false;
      const rEnd = Math.min(rows, (outRow + 1) * factor);
      const cEnd = Math.min(cols, (outCol + 1) * factor);
      for (let r = outRow * factor; r < rEnd; r++) {
        for (let c = outCol * factor; c < cEnd; c++) {
          const i = r * cols + c;
          const value = data[i];
          if (value !== value) continue; // NaN
          known = true;
          if (!kept[i]) continue;
          if (value > max) max = value;
          if (
            (c > 0 && data[i - 1] < minHeight) ||
            (c + 1 < cols && data[i + 1] < minHeight) ||
            (r > 0 && data[i - cols] < minHeight) ||
            (r + 1 < rows && data[i + cols] < minHeight)
          ) {
            edgeSum += value < maxHeight ? value : maxHeight;
            edgeCount++;
          }
        }
      }
      const o = outRow * outCols + outCol;
      out[o] = known ? Math.min(max, maxHeight) : NaN;
      skirtSum[o] = edgeSum;
      skirtCount[o] = edgeCount > 255 ? 255 : edgeCount;
      if (max > 0) anyVegetation = true;
    }
  }
  const top: HeightRaster = { x0: ndsm.x0, y0: ndsm.y0, cellM: cellM * factor, cols: outCols, rows: outRows, data: out };
  return { top, crownBase: anyVegetation ? crownBases(top, skirtSum, skirtCount) : new Uint8Array(outCols * outRows) };
}

/**
 * Dolna granica korony (m nad terenem) dla komórki o szczycie `top`, drzewa o wysokości `tree` i rąbku `skirt`
 * (Infinity = w otoczeniu nie widać brzegu korony).
 */
export function crownBaseM(top: number, tree: number, skirt: number): number {
  let base: number;
  if (tree < SHRUB_MAX_HEIGHT_M) base = SHRUB_CROWN_BASE_M;
  else {
    const low = Math.max(CROWN_BASE_FLOOR_M, CROWN_BASE_MIN_FRACTION * tree);
    const high = Math.max(low, CROWN_BASE_MAX_FRACTION * tree);
    base =
      skirt < Infinity
        ? Math.min(high, Math.max(low, CROWN_SKIRT_FACTOR * skirt))
        : Math.max(low, CROWN_BASE_CLOSED_FRACTION * tree);
  }
  const thinnest = top - Math.max(CROWN_MIN_THICKNESS_M, CROWN_MIN_THICKNESS_FRACTION * top);
  return Math.max(0.5, Math.min(base, thinnest));
}

/** Dolne granice koron dla rastra szczytów i rąbków (ta sama siatka); wynik w jednostkach CROWN_BASE_UNIT_M. */
function crownBases(top: HeightRaster, skirtSum: Float32Array, skirtCount: Uint8Array): Uint8Array {
  const { cols, rows, data } = top;
  const result = new Uint8Array(cols * rows);
  const w = CROWN_WINDOW_CELLS;
  // Maksimum szczytów oraz suma i liczba komórek rąbka w oknie (2w+1)² — rozdzielnie: najpierw wiersze, potem kolumny.
  const rowMax = new Float32Array(cols * rows);
  const rowSum = new Float32Array(cols * rows);
  const rowCount = new Uint16Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      let max = 0;
      let sum = 0;
      let count = 0;
      for (let c = Math.max(0, col - w), end = Math.min(cols - 1, col + w); c <= end; c++) {
        const v = data[base + c];
        if (v > max) max = v;
        sum += skirtSum[base + c];
        count += skirtCount[base + c];
      }
      rowMax[base + col] = max;
      rowSum[base + col] = sum;
      rowCount[base + col] = count;
    }
  }
  for (let row = 0; row < rows; row++) {
    const rFrom = Math.max(0, row - w);
    const rTo = Math.min(rows - 1, row + w);
    for (let col = 0; col < cols; col++) {
      const t = data[row * cols + col];
      if (!(t > 0)) continue;
      let tree = 0;
      let sum = 0;
      let count = 0;
      for (let r = rFrom; r <= rTo; r++) {
        const i = r * cols + col;
        if (rowMax[i] > tree) tree = rowMax[i];
        sum += rowSum[i];
        count += rowCount[i];
      }
      // Rąbek liczy się, gdy w otoczeniu widać kawałek brzegu korony (≥ 3 komórki 1 m), nie pojedynczą lukę.
      const skirt = count >= CROWN_MIN_SKIRT_CELLS ? sum / count : Infinity;
      result[row * cols + col] = Math.max(1, Math.min(255, Math.round(crownBaseM(t, tree, skirt) / CROWN_BASE_UNIT_M)));
    }
  }
  return result;
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
