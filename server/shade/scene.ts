// Scena cieni: budynki (graniastosłupy), drzewa (elipsoidalne korony) i zwarte zadrzewienia.
// Ekspozycję punktu liczymy promieniem puszczonym z punktu na poziomie gruntu W STRONĘ słońca:
// w odległości poziomej d promień jest na wysokości d·tan(alt). Ściany, drzewa i obrysy są
// w jednorodnej siatce przestrzennej, po której promień idzie algorytmem DDA.
//
// v2 (dane LiDAR, opcjonalne — bez nich scena zachowuje się dokładnie jak w v1):
//  - raster roślinności (wysokość koron nad terenem) ZASTĘPUJE drzewa i zadrzewienia z OSM: promień z wysokości
//    oczu (1,5 m) maszeruje po rastrze, a tłumienie zależy od długości drogi przez warstwę koron (Beer–Lambert),
//  - raster terenu: punkt i podstawy obiektów mają własne rzędne, a sam teren też może zasłonić słońce,
//  - sun.leafOff: korony liściaste przepuszczają większość światła (dotyczy modelu OSM i rastra).
//
// v3:
//  - lidar.crownBase: dolna granica koron per komórka (analiza nDSM — lidar/heights.ts) zamiast stałego ułamka,
//  - drzewa z OSM oznaczone jako zimozielone zachowują pełne tłumienie zimą także w rastrze,
//  - lidar.decks: pomosty mostów. Pieszy NA moście (onBridge) patrzy z poziomu pomostu, więc ani pomost, ani nic
//    poniżej go nie zacienia; punkt pod pomostem (nie na moście) jest w pełnym cieniu,
//  - teren: luki w danych wypełniane najbliższą znaną wartością (bez sztucznych progów), a zasłanianie słońca
//    przez teren liczone tylko tam, gdzie teren jest znany.

import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Polygon, Ring } from 'polygon-clipping';
import type { AreaData, HeightRaster, IShadeScene, ShadowPolygon, SunPosition } from '../contracts.ts';
import { toLonLat } from '../geo/project.ts';
import { CROWN_BASE_UNIT_M, type BridgeDeck } from '../lidar/heights.ts';

declare module '../contracts.ts' {
  interface IShadeScene {
    /** v3: `onBridge` — punkt leży na pomoście mostu (WalkWay.bridge): pomost i to, co pod nim, nie zacienia. */
    exposureAt(x: number, y: number, sun: SunPosition, onBridge?: boolean): number;
    polylineExposure(coords: number[], sun: SunPosition, stepM?: number, onBridge?: boolean): number;
  }
}

const CELL_M = 40;
const MAX_CELLS = 4_000_000;
/** Maksymalna długość promienia (m) — ogranicza koszt przy bardzo niskim słońcu. */
const MAX_RAY_M = 600;
/** Maksymalna długość rysowanego cienia (m). */
export const MAX_SHADOW_M = 400;
const MIN_SHADOW_ALTITUDE = (1 * Math.PI) / 180;
const DEFAULT_STEP_M = 6;

/** Część światła przechodząca przez koronę drzewa po pełnej średnicy. */
const CROWN_TRANSMISSIVITY = 0.25;
const LN_CROWN_TRANSMISSIVITY = Math.log(CROWN_TRANSMISSIVITY);
/** Ekspozycja punktu pod zwartym drzewostanem. */
const CANOPY_INSIDE_EXPOSURE = 0.15;
/** Mnożnik ekspozycji w cieniu rzucanym przez zwarty drzewostan na zewnątrz. */
const CANOPY_CAST_EXPOSURE = 0.3;
/** Dolne ograniczenie ekspozycji w cieniu samej roślinności (nigdy nie jest tak szczelny jak mur). */
const MIN_VEGETATION_EXPOSURE = 0.05;

/** Sezon bezlistny: korona drzewa liściastego po pełnej średnicy / wnętrze i cień zwartego drzewostanu. */
const LN_CROWN_TRANSMISSIVITY_LEAF_OFF = Math.log(0.7);
const CANOPY_INSIDE_EXPOSURE_LEAF_OFF = 0.6;
const CANOPY_CAST_EXPOSURE_LEAF_OFF = 0.75;

/** Wysokość (m nad gruntem), z której patrzymy w stronę słońca przez roślinność z rastra i ponad terenem. */
const EYE_M = 1.5;
/** Współczynniki osłabienia (1/m): 6 m drogi przez koronę przepuszcza 25% światła latem i 70% w sezonie bezlistnym. */
const VEG_K_LEAF_ON = Math.log(4) / 6;
const VEG_K_LEAF_OFF = -Math.log(0.7) / 6;
const EVERGREEN_WEIGHT = VEG_K_LEAF_ON / VEG_K_LEAF_OFF;
/** Dolna granica warstwy koron: max(2 m, 35% wysokości) — pod nią promień biegnie między pniami. */
const CROWN_BASE_MIN_M = 2;
const CROWN_BASE_FRACTION = 0.35;
const VEG_MAX_RAY_M = 200;
const VEG_MAX_STEPS = 128;
/** Największy przyrost wysokości promienia na krok (m) — przy wysokim słońcu krok poziomy jest krótszy od komórki. */
const VEG_RISE_PER_STEP_M = 2;
/** Bloki zgrubnej siatki maksimów (2^n komórek): promień powyżej maksimum bloku i sąsiadów przeskakuje cały blok. */
const VEG_BLOCK_SHIFT = 3;
const TERRAIN_BLOCK_SHIFT = 2;
/** Pod pomostem da się przejść (i jest tam cień), gdy pomost jest co najmniej tyle nad terenem. */
const DECK_MIN_CLEARANCE_M = 2.5;
const DECK_INDEX_CELL_M = 25;

/** Maska cieni do wizualizacji (roślinność z rastra, cień terenu). */
const MASK_CELL_M = 2.5;
const MASK_MAX_CELLS = 160_000;
const MASK_TREE_EXPOSURE = 0.6;
const MASK_MIN_COMPONENT_CELLS = 3;
const MASK_SIMPLIFY_CELLS = 0.75;
const MASK_MAX_VERTICES = 6000;
const MASK_TREE = 1;
const MASK_TERRAIN = 2;

const ELLIPSE_VERTICES = 16;
const SEG_STRIDE = 4; // x1, y1, ex, ey
const TREE_STRIDE = 5; // x, y, promień, przeskalowana wysokość środka korony, skala osi z
const BOX_STRIDE = 4; // minX, minY, maxX, maxY

interface CellIndex {
  /** Początek listy elementów komórki c: items[start[c] .. start[c+1]). */
  start: Int32Array;
  items: Int32Array;
}

/** Raster z prekalkulowaną siatką zgrubną: coarse[blok] = maksimum (rzędnej szczytu) w bloku i 8 sąsiednich. */
interface RasterGrid {
  x0: number;
  y0: number;
  cell: number;
  inv: number;
  cols: number;
  rows: number;
  data: Float32Array;
  /** Maksimum bezwzględne (teren: rzędna; roślinność: rzędna terenu + wysokość korony). */
  max: number;
  shift: number;
  coarseCols: number;
  coarse: Float32Array;
  /** Teren: 1 = rzędna z danych, 0 = wypełniona z sąsiedztwa (taka komórka nie zasłania słońca). */
  known?: Uint8Array;
  /** Roślinność: dolna granica koron (jednostki CROWN_BASE_UNIT_M; 0 = reguła stała). */
  crownBase?: Uint8Array | null;
  /** Roślinność: komórki pod koronami drzew zimozielonych z OSM (null = brak takich). */
  evergreen?: Set<number> | null;
}

/** Indeks pomostów: siatka nad prostokątem otaczającym wszystkie pomosty, w komórce lista pomostów (CSR). */
interface DeckIndex {
  decks: BridgeDeck[];
  boxes: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  inv: number;
  nx: number;
  ny: number;
  start: Int32Array;
  items: Int32Array;
}

type SceneInput = Pick<AreaData, 'buildings' | 'trees' | 'canopies' | 'lidar'>;

export class ShadeScene implements IShadeScene {
  // Właściciele pierścieni: najpierw budynki [0, buildingCount), potem zadrzewienia.
  // Budynek może mieć kilka pierścieni: obrys i dziedzińce; wszystkie są ścianami tego samego właściciela,
  // więc test parzystości (wnętrze) i przecięcia promienia ze ścianami działają dla dziedzińców bez zmian.
  private readonly buildingCount: number;
  private readonly ownerHeight: Float64Array;
  private readonly ownerMinHeight: Float64Array;
  /** Bezwzględne rzędne dolnej krawędzi i dachu (podstawa = teren pod obrysem; 0 bez rastra terenu). */
  private readonly ownerBottom: Float64Array;
  private readonly ownerTop: Float64Array;
  private readonly ownerBox: Float64Array;
  /** Odcinki właściciela o: [ownerSegStart[o], ownerSegStart[o+1]). */
  private readonly ownerSegStart: Int32Array;
  /** Pierścienie właściciela o: [ownerRingStart[o], ownerRingStart[o+1]); odcinki pierścienia r: [ringSegStart[r], ringSegStart[r+1]). */
  private readonly ownerRingStart: Int32Array;
  private readonly ringSegStart: Int32Array;
  private readonly ownerStamp: Int32Array;

  private readonly segs: Float64Array;
  private readonly segOwner: Int32Array;

  private readonly treeCount: number;
  private readonly trees: Float64Array;
  private readonly treeHeight: Float64Array;
  private readonly treeBase: Float64Array;
  private readonly treeEvergreen: Uint8Array;
  private readonly treeStamp: Int32Array;

  private readonly terrain: RasterGrid | null;
  private readonly vegetation: RasterGrid | null;
  private readonly decks: DeckIndex | null;

  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly segIndex: CellIndex;
  private readonly treeIndex: CellIndex;
  private readonly ownerIndex: CellIndex;
  private readonly cellMaxHeight: Float64Array;
  private readonly maxHeight: number;

  private queryId = 0;
  private readonly crossings: number[] = [];

  constructor(area: SceneInput) {
    const terrain = prepareTerrain(area.lidar?.terrain ?? null);
    this.terrain = terrain;
    this.vegetation = prepareVegetation(area.lidar?.vegetation ?? null, terrain, area.lidar?.crownBase ?? null);
    this.decks = buildDeckIndex(area.lidar?.decks ?? []);
    // Raster roślinności zastępuje model drzew z OSM (obejmuje też drzewa niezmapowane). Drzewa i zadrzewienia
    // z OSM zostają tylko tam, gdzie raster nie ma danych (NaN — kafel LiDAR jeszcze niepobrany — lub poza zasięgiem).
    const vegetationRaster = area.lidar?.vegetation ?? null;
    const osmVegetationAt = validRaster(vegetationRaster)
      ? (x: number, y: number) => !rasterHasData(vegetationRaster, x, y)
      : () => true;
    const canopies = area.canopies.filter((c) => {
      const [x, y] = ringCentre(c.ring);
      return osmVegetationAt(x, y);
    });
    const owners = [
      ...area.buildings.map((b) => ({ rings: [b.ring, ...(b.holes ?? [])], height: b.height, minHeight: b.minHeight })),
      ...canopies.map((c) => ({ rings: [c.ring], height: c.height, minHeight: 0 })),
    ];
    const ownerCount = owners.length;
    this.buildingCount = area.buildings.length;
    this.ownerHeight = new Float64Array(ownerCount);
    this.ownerMinHeight = new Float64Array(ownerCount);
    this.ownerBottom = new Float64Array(ownerCount);
    this.ownerTop = new Float64Array(ownerCount);
    this.ownerBox = new Float64Array(ownerCount * BOX_STRIDE);
    this.ownerSegStart = new Int32Array(ownerCount + 1);
    this.ownerRingStart = new Int32Array(ownerCount + 1);
    this.ownerStamp = new Int32Array(ownerCount);

    const segs: number[] = [];
    const segOwner: number[] = [];
    const ringSegStart: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxHeight = 0;

    owners.forEach(({ rings, height, minHeight }, o) => {
      this.ownerHeight[o] = height;
      this.ownerMinHeight[o] = Math.min(Math.max(minHeight, 0), height);
      this.ownerSegStart[o] = segOwner.length;
      this.ownerRingStart[o] = ringSegStart.length;
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      // Podstawa bryły: średnia rzędna terenu w wierzchołkach obrysu zewnętrznego.
      let base = 0;
      if (terrain) {
        const outer = rings[0];
        const count = outer.length >> 1;
        for (let i = 0; i < count; i++) base += terrainAt(terrain, outer[2 * i], outer[2 * i + 1]);
        base = count > 0 ? base / count : 0;
      }
      this.ownerBottom[o] = base + this.ownerMinHeight[o];
      this.ownerTop[o] = base + height;
      for (const ring of rings) {
        ringSegStart.push(segOwner.length);
        const n = ring.length >> 1;
        // Pierścień zamykamy sami (odcinek ostatni→pierwszy); dla już zamkniętego ma on zerową długość.
        for (let i = 0; n >= 3 && i < n; i++) {
          const j = (i + 1) % n;
          const x1 = ring[2 * i];
          const y1 = ring[2 * i + 1];
          const ex = ring[2 * j] - x1;
          const ey = ring[2 * j + 1] - y1;
          if (ex === 0 && ey === 0) continue;
          segs.push(x1, y1, ex, ey);
          segOwner.push(o);
          bx0 = Math.min(bx0, x1);
          by0 = Math.min(by0, y1);
          bx1 = Math.max(bx1, x1);
          by1 = Math.max(by1, y1);
        }
      }
      this.ownerBox.set([bx0, by0, bx1, by1], o * BOX_STRIDE);
      if (bx0 <= bx1) {
        minX = Math.min(minX, bx0);
        minY = Math.min(minY, by0);
        maxX = Math.max(maxX, bx1);
        maxY = Math.max(maxY, by1);
        maxHeight = Math.max(maxHeight, base + height);
      }
    });
    this.ownerSegStart[ownerCount] = segOwner.length;
    this.ownerRingStart[ownerCount] = ringSegStart.length;
    ringSegStart.push(segOwner.length);
    this.ringSegStart = Int32Array.from(ringSegStart);
    this.segs = Float64Array.from(segs);
    this.segOwner = Int32Array.from(segOwner);

    const trees = area.trees.filter((t) => t.crownRadius > 0 && t.height > 0 && osmVegetationAt(t.x, t.y));
    this.treeCount = trees.length;
    this.trees = new Float64Array(trees.length * TREE_STRIDE);
    this.treeHeight = new Float64Array(trees.length);
    this.treeBase = new Float64Array(trees.length);
    this.treeEvergreen = new Uint8Array(trees.length);
    this.treeStamp = new Int32Array(trees.length);
    trees.forEach((t, i) => {
      const base = terrain ? terrainAt(terrain, t.x, t.y) : 0;
      this.treeBase[i] = base;
      this.treeEvergreen[i] = t.evergreen === true ? 1 : 0;
      // Korona: elipsoida o promieniu poziomym r i półosi pionowej v, sięgająca wierzchołka drzewa.
      // Przeskalowanie osi z przez r/v zamienia ją w kulę o promieniu r.
      const r = t.crownRadius;
      const v = Math.min(r, t.height / 2);
      const zScale = r / v;
      this.trees.set([t.x, t.y, r, (t.height - v) * zScale, zScale], i * TREE_STRIDE);
      this.treeHeight[i] = base + t.height;
      minX = Math.min(minX, t.x - r);
      minY = Math.min(minY, t.y - r);
      maxX = Math.max(maxX, t.x + r);
      maxY = Math.max(maxY, t.y + r);
      maxHeight = Math.max(maxHeight, base + t.height);
    });
    this.maxHeight = maxHeight;
    if (this.vegetation) this.vegetation.evergreen = evergreenCells(this.vegetation, area.trees);

    if (minX > maxX) {
      minX = minY = 0;
      maxX = maxY = 0;
    }
    const width = maxX - minX;
    const depth = maxY - minY;
    this.cell = Math.max(CELL_M, Math.sqrt((width * depth) / MAX_CELLS));
    this.minX = minX;
    this.minY = minY;
    this.nx = Math.max(1, Math.ceil(width / this.cell));
    this.ny = Math.max(1, Math.ceil(depth / this.cell));

    const cellCount = this.nx * this.ny;
    this.cellMaxHeight = new Float64Array(cellCount);

    const segCount = this.segOwner.length;
    this.segIndex = this.buildIndex(segCount, (i) => {
      const k = i * SEG_STRIDE;
      const x1 = this.segs[k];
      const y1 = this.segs[k + 1];
      const x2 = x1 + this.segs[k + 2];
      const y2 = y1 + this.segs[k + 3];
      return [
        Math.min(x1, x2),
        Math.min(y1, y2),
        Math.max(x1, x2),
        Math.max(y1, y2),
        this.ownerTop[this.segOwner[i]],
      ];
    });
    this.treeIndex = this.buildIndex(this.treeCount, (i) => {
      const k = i * TREE_STRIDE;
      const r = this.trees[k + 2];
      return [
        this.trees[k] - r,
        this.trees[k + 1] - r,
        this.trees[k] + r,
        this.trees[k + 1] + r,
        this.treeHeight[i],
      ];
    });
    this.ownerIndex = this.buildIndex(ownerCount, (o) => {
      const k = o * BOX_STRIDE;
      const box = this.ownerBox;
      return [box[k], box[k + 1], box[k + 2], box[k + 3], 0];
    });
  }

  private cellX(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
  }

  private cellY(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
  }

  /**
   * Indeks CSR: element trafia do każdej komórki, którą przecina jego prostokąt otaczający.
   * `boxOf` zwraca [minX, minY, maxX, maxY, wysokość]; wysokość podbija maksimum komórki.
   */
  private buildIndex(
    count: number,
    boxOf: (i: number) => [number, number, number, number, number],
  ): CellIndex {
    const ranges = new Int32Array(count * 4);
    const start = new Int32Array(this.nx * this.ny + 1);
    for (let i = 0; i < count; i++) {
      const [x0, y0, x1, y1, height] = boxOf(i);
      if (!(x0 <= x1)) {
        ranges.set([0, 0, -1, -1], i * 4); // pusty zakres: element bez geometrii
        continue;
      }
      const cx0 = this.cellX(x0);
      const cy0 = this.cellY(y0);
      const cx1 = this.cellX(x1);
      const cy1 = this.cellY(y1);
      ranges.set([cx0, cy0, cx1, cy1], i * 4);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * this.nx + cx;
          start[c + 1]++;
          if (height > this.cellMaxHeight[c]) this.cellMaxHeight[c] = height;
        }
      }
    }
    for (let c = 0; c < start.length - 1; c++) start[c + 1] += start[c];
    const items = new Int32Array(start[start.length - 1]);
    const fill = start.slice(0, -1);
    for (let i = 0; i < count; i++) {
      const k = i * 4;
      for (let cy = ranges[k + 1]; cy <= ranges[k + 3]; cy++) {
        for (let cx = ranges[k]; cx <= ranges[k + 2]; cx++) {
          items[fill[cy * this.nx + cx]++] = i;
        }
      }
    }
    return { start, items };
  }

  private ownerContains(o: number, x: number, y: number): boolean {
    const segs = this.segs;
    let inside = false;
    for (let s = this.ownerSegStart[o], end = this.ownerSegStart[o + 1]; s < end; s++) {
      const k = s * SEG_STRIDE;
      const y1 = segs[k + 1];
      const ey = segs[k + 3];
      if (y1 > y !== y1 + ey > y && x < segs[k] + (segs[k + 2] * (y - y1)) / ey) inside = !inside;
    }
    return inside;
  }

  /**
   * Budynek z min_height > 0 (bryła zawieszona nad gruntem), punkt startu poza obrysem.
   * Promień przecina obrys w posortowanych odległościach d0<d1<d2<…; pary (d0,d1), (d2,d3)…
   * to odcinki nad rzutem bryły. Jest zasłonięty, gdy na którymś z nich jego wysokość
   * [d_we·tan, d_wy·tan] zachodzi na [minHeight, height) — także gdy wchodzi w bryłę od spodu.
   */
  private elevatedBlocks(o: number, x: number, y: number, dx: number, dy: number, tanAlt: number, z0: number) {
    const segs = this.segs;
    const crossings = this.crossings;
    crossings.length = 0;
    for (let s = this.ownerSegStart[o], end = this.ownerSegStart[o + 1]; s < end; s++) {
      const k = s * SEG_STRIDE;
      const ex = segs[k + 2];
      const ey = segs[k + 3];
      const denom = dx * ey - dy * ex;
      if (denom === 0) continue;
      const wx = segs[k] - x;
      const wy = segs[k + 1] - y;
      const d = (wx * ey - wy * ex) / denom;
      const u = (wx * dy - wy * dx) / denom;
      if (d >= 0 && u >= 0 && u < 1) crossings.push(d);
    }
    crossings.sort((a, b) => a - b);
    const height = this.ownerTop[o];
    const minHeight = this.ownerBottom[o];
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      if (z0 + crossings[i] * tanAlt < height && z0 + crossings[i + 1] * tanAlt >= minHeight) return true;
    }
    return false;
  }

  insideBuilding(x: number, y: number): boolean {
    const { minX, minY, cell, nx, ny } = this;
    if (x < minX || x > minX + nx * cell || y < minY || y > minY + ny * cell) return false;
    const c = this.cellY(y) * nx + this.cellX(x);
    const { start, items } = this.ownerIndex;
    const box = this.ownerBox;
    for (let i = start[c], end = start[c + 1]; i < end; i++) {
      const o = items[i];
      if (o >= this.buildingCount || this.ownerMinHeight[o] > 0) continue;
      const k = o * BOX_STRIDE;
      if (x < box[k] || x > box[k + 2] || y < box[k + 1] || y > box[k + 3]) continue;
      if (this.ownerContains(o, x, y)) return true;
    }
    return false;
  }

  /**
   * Pomost zawierający punkt wraz z jego wysokością nad terenem w tym punkcie albo null.
   * (Z rastrem terenu: rzędna wierzchu pomostu minus rzędna terenu; bez niego: mediana wysokości pomostu.)
   */
  private deckAt(x: number, y: number, ground: number): number | null {
    const index = this.decks;
    if (index === null || x < index.minX || x >= index.maxX || y < index.minY || y >= index.maxY) return null;
    const c = ((y - index.minY) * index.inv | 0) * index.nx + ((x - index.minX) * index.inv | 0);
    let best: number | null = null;
    for (let i = index.start[c], end = index.start[c + 1]; i < end; i++) {
      const d = index.items[i];
      const k = d * BOX_STRIDE;
      const box = index.boxes;
      if (x < box[k] || x > box[k + 2] || y < box[k + 1] || y > box[k + 3]) continue;
      const deck = index.decks[d];
      if (!ringContainsPoint(deck.ring, x, y)) continue;
      const height = this.terrain ? deck.topZ - ground : deck.heightM;
      if (best === null || height > best) best = height;
    }
    return best;
  }

  exposureAt(x: number, y: number, sun: SunPosition, onBridge = false): number {
    if (!(sun.altitude > 0)) return 0;
    const tanAlt = Math.tan(sun.altitude);
    const dx = Math.sin(sun.azimuth);
    const dy = Math.cos(sun.azimuth);
    const leafOff = sun.leafOff === true;
    const { terrain, vegetation } = this;
    if (terrain === null && vegetation === null && this.decks === null) {
      return this.castObjects(x, y, dx, dy, tanAlt, 0, leafOff);
    }

    // Budynki (i drzewa z OSM): promień z poziomu gruntu, jak w v1, ale z rzędnymi terenu.
    let ground = terrain ? terrainAt(terrain, x, y) : 0;
    if (this.decks !== null) {
      const deckHeight = this.deckAt(x, y, ground);
      if (deckHeight !== null) {
        // Pieszy na moście stoi na pomoście: promień startuje z jego poziomu, więc pomost i wszystko poniżej
        // (także resztki pomostu w rastrze roślinności i skarpy pod mostem) go nie zacienia.
        if (onBridge) ground += Math.max(0, deckHeight);
        // Punkt pod pomostem (droga, która nie jest mostem): pełny cień, o ile pod pomostem jest prześwit.
        else if (deckHeight >= DECK_MIN_CLEARANCE_M) return 0;
      }
    }
    let exposure = this.castObjects(x, y, dx, dy, tanAlt, ground, leafOff);
    if (exposure === 0) return 0;
    const eye = ground + EYE_M;
    if (terrain && this.terrainBlocks(x, y, dx, dy, tanAlt, eye)) return 0;
    if (vegetation) {
      const transmission = this.vegetationTransmission(x, y, dx, dy, tanAlt, Math.sin(sun.altitude), eye, leafOff);
      if (transmission < 1) {
        exposure *= transmission;
        if (exposure < MIN_VEGETATION_EXPOSURE) exposure = MIN_VEGETATION_EXPOSURE;
      }
    }
    return exposure;
  }

  /** Czy rzeźba terenu zasłania słońce: promień z wysokości z0 schodzi poniżej terenu (interpolacja dwuliniowa). */
  private terrainBlocks(x: number, y: number, dx: number, dy: number, tanAlt: number, z0: number): boolean {
    const t = this.terrain!;
    const rise = t.max - z0;
    if (rise <= 0) return false;
    const maxD = Math.min(rise / tanAlt, MAX_RAY_M);
    const { x0, y0, inv, cols, rows, shift, coarse, coarseCols, known } = t;
    const step = t.cell;
    // Skok o blok minus komórkę: interpolacja sięga o jedną komórkę poza punkt.
    const jump = Math.max(step, ((1 << shift) - 1) * step);
    for (let d = step * 0.5; d <= maxD; ) {
      const px = x + dx * d;
      const py = y + dy * d;
      const z = z0 + d * tanAlt;
      let col = Math.floor((px - x0) * inv);
      let row = Math.floor((py - y0) * inv);
      if (col < 0) col = 0;
      else if (col >= cols) col = cols - 1;
      if (row < 0) row = 0;
      else if (row >= rows) row = rows - 1;
      if (z >= coarse[(row >> shift) * coarseCols + (col >> shift)]) {
        d += jump;
        continue;
      }
      if (z < terrainAt(t, px, py) && (known === undefined || known[row * cols + col] === 1)) return true;
      d += step;
    }
    return false;
  }

  /**
   * Część światła przechodząca przez roślinność z rastra na drodze promienia z wysokości z0 (bezwzględnej).
   * W każdym kroku [d, d+krok] promień pokonuje przedział wysokości; jego część wspólna z warstwą koron
   * komórki [podstawa, szczyt] podzielona przez sin(alt) to długość drogi przez koronę. Dzięki temu punkt
   * pod koroną (promień startuje pod podstawą korony i w nią wchodzi) jest zacieniony także przy słońcu w zenicie.
   */
  private vegetationTransmission(
    x: number,
    y: number,
    dx: number,
    dy: number,
    tanAlt: number,
    sinAlt: number,
    z0: number,
    leafOff: boolean,
  ): number {
    const v = this.vegetation!;
    const rise = v.max - z0;
    if (rise <= 0) return 1;
    const { x0, y0, inv, cols, rows, data, shift, coarse, coarseCols } = v;
    const terrain = this.terrain;
    const bases = v.crownBase ?? null;
    // Zimą korony drzew zimozielonych tłumią jak latem: droga przez nie liczy się z wagą k_lato / k_zima.
    const evergreen = leafOff ? (v.evergreen ?? null) : null;

    // Obcięcie do zasięgu rastra.
    let dStart = 0;
    let dEnd = Math.min(rise / tanAlt, VEG_MAX_RAY_M);
    const maxD = dEnd;
    if (dx !== 0) {
      const a = (x0 - x) / dx;
      const b = (x0 + cols * v.cell - x) / dx;
      dStart = Math.max(dStart, Math.min(a, b));
      dEnd = Math.min(dEnd, Math.max(a, b));
    } else if (x < x0 || x >= x0 + cols * v.cell) {
      return 1;
    }
    if (dy !== 0) {
      const a = (y0 - y) / dy;
      const b = (y0 + rows * v.cell - y) / dy;
      dStart = Math.max(dStart, Math.min(a, b));
      dEnd = Math.min(dEnd, Math.max(a, b));
    } else if (y < y0 || y >= y0 + rows * v.cell) {
      return 1;
    }
    if (!(dStart < dEnd)) return 1;

    let step = v.cell;
    const riseStep = VEG_RISE_PER_STEP_M / tanAlt;
    if (riseStep < step) step = riseStep;
    const minStep = maxD / VEG_MAX_STEPS;
    if (step < minStep) step = minStep;
    const half = step * 0.5;
    const stepRise = step * tanAlt;
    const jump = Math.max(step, ((1 << shift) - 1) * v.cell);
    const kOverSin = (leafOff ? VEG_K_LEAF_OFF : VEG_K_LEAF_ON) / sinAlt;
    // Powyżej tej sumy przedziałów wysokości i tak obowiązuje dolne ograniczenie ekspozycji.
    const opaque = -Math.log(MIN_VEGETATION_EXPOSURE) / kOverSin;
    let through = 0;

    for (let d = dStart; d < dEnd; ) {
      const px = x + dx * (d + half);
      const py = y + dy * (d + half);
      const fx = (px - x0) * inv;
      const fy = (py - y0) * inv;
      if (fx < 0 || fy < 0) {
        d += step;
        continue;
      }
      const col = fx | 0;
      const row = fy | 0;
      if (col >= cols || row >= rows) {
        d += step;
        continue;
      }
      const zLow = z0 + d * tanAlt;
      if (zLow >= coarse[(row >> shift) * coarseCols + (col >> shift)]) {
        d += jump;
        continue;
      }
      const h = data[row * cols + col];
      if (h > CROWN_BASE_MIN_M) {
        const groundZ = terrain ? terrainAt(terrain, px, py) : 0;
        const top = groundZ + h;
        const stored = bases !== null ? bases[row * cols + col] : 0;
        const crownBase =
          groundZ + (stored > 0 ? stored * CROWN_BASE_UNIT_M : Math.max(CROWN_BASE_MIN_M, CROWN_BASE_FRACTION * h));
        const zHigh = zLow + stepRise;
        const overlap = (zHigh < top ? zHigh : top) - (zLow > crownBase ? zLow : crownBase);
        if (overlap > 0) {
          through += evergreen !== null && evergreen.has(row * cols + col) ? overlap * EVERGREEN_WEIGHT : overlap;
          if (through >= opaque) return MIN_VEGETATION_EXPOSURE;
        }
      }
      d += step;
    }
    return through > 0 ? Math.exp(-kOverSin * through) : 1;
  }

  /**
   * Budynki oraz drzewa i zadrzewienia z OSM (model v1). `z0` — rzędna, z której startuje promień
   * (0 bez rastra terenu; wtedy wynik jest identyczny jak w v1).
   */
  private castObjects(
    x: number,
    y: number,
    dx: number,
    dy: number,
    tanAlt: number,
    z0: number,
    leafOff: boolean,
  ): number {
    const { minX, minY, cell, nx, ny, segs, segOwner, trees, buildingCount } = this;
    const { ownerStamp, treeStamp, cellMaxHeight, treeBase, treeEvergreen } = this;
    const ownerHeight = this.ownerTop;
    const ownerMinHeight = this.ownerBottom;
    const canopyInside = leafOff ? CANOPY_INSIDE_EXPOSURE_LEAF_OFF : CANOPY_INSIDE_EXPOSURE;
    const canopyCast = leafOff ? CANOPY_CAST_EXPOSURE_LEAF_OFF : CANOPY_CAST_EXPOSURE;
    const gridMaxX = minX + nx * cell;
    const gridMaxY = minY + ny * cell;
    const query = ++this.queryId;
    let exposure = 1;

    // 1. Punkt wewnątrz obrysu: budynek (pasaż, brama) = pełny cień; zadrzewienie = mocny półcień.
    if (x >= minX && x <= gridMaxX && y >= minY && y <= gridMaxY) {
      const c = this.cellY(y) * nx + this.cellX(x);
      const { start, items } = this.ownerIndex;
      const box = this.ownerBox;
      for (let i = start[c], end = start[c + 1]; i < end; i++) {
        const o = items[i];
        const k = o * BOX_STRIDE;
        if (x < box[k] || x > box[k + 2] || y < box[k + 1] || y > box[k + 3]) continue;
        if (!this.ownerContains(o, x, y)) continue;
        if (o < buildingCount) return 0;
        if (ownerStamp[o] !== query) {
          ownerStamp[o] = query;
          exposure *= canopyInside;
        }
      }
    }

    // 2. Obcięcie promienia do siatki: [sStart, sEnd] w metrach wzdłuż rzutu poziomego.
    let sStart = 0;
    let sEnd = Math.min((this.maxHeight - z0) / tanAlt, MAX_RAY_M);
    if (dx !== 0) {
      const a = (minX - x) / dx;
      const b = (gridMaxX - x) / dx;
      sStart = Math.max(sStart, Math.min(a, b));
      sEnd = Math.min(sEnd, Math.max(a, b));
    } else if (x < minX || x > gridMaxX) {
      return exposure;
    }
    if (dy !== 0) {
      const a = (minY - y) / dy;
      const b = (gridMaxY - y) / dy;
      sStart = Math.max(sStart, Math.min(a, b));
      sEnd = Math.min(sEnd, Math.max(a, b));
    } else if (y < minY || y > gridMaxY) {
      return exposure;
    }

    // 3. Przejście po komórkach (Amanatides–Woo).
    let cx = this.cellX(x + dx * sStart);
    let cy = this.cellY(y + dy * sStart);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const deltaX = dx !== 0 ? cell / Math.abs(dx) : Infinity;
    const deltaY = dy !== 0 ? cell / Math.abs(dy) : Infinity;
    let nextX = dx !== 0 ? (minX + (dx > 0 ? cx + 1 : cx) * cell - x) / dx : Infinity;
    let nextY = dy !== 0 ? (minY + (dy > 0 ? cy + 1 : cy) * cell - y) / dy : Infinity;
    const segStart = this.segIndex.start;
    const segItems = this.segIndex.items;
    const treeStart = this.treeIndex.start;
    const treeItems = this.treeIndex.items;

    for (let s = sStart; s <= sEnd; ) {
      const c = cy * nx + cx;
      // Promień tylko się wznosi: jeśli już przy wejściu jest ponad wszystkim w komórce, pomijamy ją.
      if (z0 + s * tanAlt < cellMaxHeight[c]) {
        for (let i = segStart[c], end = segStart[c + 1]; i < end; i++) {
          const seg = segItems[i];
          const k = seg * SEG_STRIDE;
          const ex = segs[k + 2];
          const ey = segs[k + 3];
          const denom = dx * ey - dy * ex;
          if (denom === 0) continue;
          const wx = segs[k] - x;
          const wy = segs[k + 1] - y;
          const d = (wx * ey - wy * ex) / denom;
          if (d < 0 || d > sEnd) continue;
          const u = (wx * dy - wy * dx) / denom;
          if (u < 0 || u > 1) continue;
          const o = segOwner[seg];
          const h = z0 + d * tanAlt;
          if (h >= ownerHeight[o]) continue;
          if (o >= buildingCount) {
            if (ownerStamp[o] !== query) {
              ownerStamp[o] = query;
              exposure *= canopyCast;
            }
          } else if (h >= ownerMinHeight[o] || this.elevatedBlocks(o, x, y, dx, dy, tanAlt, z0)) {
            return 0;
          }
        }
        for (let i = treeStart[c], end = treeStart[c + 1]; i < end; i++) {
          const tree = treeItems[i];
          if (treeStamp[tree] === query) continue;
          treeStamp[tree] = query;
          // Przecięcie promienia z kulą w przestrzeni przeskalowanej w osi z (patrz konstruktor).
          const k = tree * TREE_STRIDE;
          const r = trees[k + 2];
          const ox = x - trees[k];
          const oy = y - trees[k + 1];
          const oz = (z0 - treeBase[tree]) * trees[k + 4] - trees[k + 3];
          const dz = tanAlt * trees[k + 4];
          const a = 1 + dz * dz;
          const b = ox * dx + oy * dy + oz * dz;
          const disc = b * b - a * (ox * ox + oy * oy + oz * oz - r * r);
          if (disc <= 0) continue;
          const root = Math.sqrt(disc);
          const far = (root - b) / a;
          if (far <= 0) continue;
          const near = Math.max((-root - b) / a, 0);
          // Tłumienie wykładnicze względem długości cięciwy: pełna średnica → CROWN_TRANSMISSIVITY.
          const chordFraction = ((far - near) * Math.sqrt(a)) / (2 * r);
          const lnCrown =
            leafOff && treeEvergreen[tree] === 0 ? LN_CROWN_TRANSMISSIVITY_LEAF_OFF : LN_CROWN_TRANSMISSIVITY;
          exposure *= Math.exp(lnCrown * chordFraction);
        }
      }
      if (nextX < nextY) {
        s = nextX;
        nextX += deltaX;
        cx += stepX;
        if (cx < 0 || cx >= nx) break;
      } else {
        s = nextY;
        nextY += deltaY;
        cy += stepY;
        if (cy < 0 || cy >= ny) break;
      }
    }
    return exposure < MIN_VEGETATION_EXPOSURE ? MIN_VEGETATION_EXPOSURE : exposure;
  }

  polylineExposure(coords: number[], sun: SunPosition, stepM: number = DEFAULT_STEP_M, onBridge = false): number {
    const pointCount = coords.length >> 1;
    if (pointCount === 0 || !(sun.altitude > 0)) return 0;
    let total = 0;
    for (let i = 1; i < pointCount; i++) {
      total += Math.hypot(coords[2 * i] - coords[2 * i - 2], coords[2 * i + 1] - coords[2 * i - 1]);
    }
    if (total === 0) return this.exposureAt(coords[0], coords[1], sun, onBridge);

    // Próbki w środkach równych odcinków długości łuku — końce polilinii (często tuż przy
    // ścianie lub na skrzyżowaniu) nie zawyżają ani nie zaniżają średniej.
    const samples = Math.max(2, Math.ceil(total / stepM));
    const spacing = total / samples;
    let sum = 0;
    let seg = 1;
    let segStartLen = 0;
    let segLen = Math.hypot(coords[2] - coords[0], coords[3] - coords[1]);
    for (let i = 0; i < samples; i++) {
      const target = (i + 0.5) * spacing;
      while (seg < pointCount - 1 && segStartLen + segLen < target) {
        segStartLen += segLen;
        seg++;
        segLen = Math.hypot(
          coords[2 * seg] - coords[2 * seg - 2],
          coords[2 * seg + 1] - coords[2 * seg - 1],
        );
      }
      const f = segLen > 0 ? Math.min(1, (target - segStartLen) / segLen) : 0;
      const x0 = coords[2 * seg - 2];
      const y0 = coords[2 * seg - 1];
      sum += this.exposureAt(
        x0 + (coords[2 * seg] - x0) * f,
        y0 + (coords[2 * seg + 1] - y0) * f,
        sun,
        onBridge,
      );
    }
    return sum / samples;
  }

  shadowPolygons(bboxXY: [number, number, number, number], sun: SunPosition): ShadowPolygon[] {
    if (!(sun.altitude > MIN_SHADOW_ALTITUDE)) return [];
    const tanAlt = Math.tan(sun.altitude);
    // Cień pada w kierunku przeciwnym do słońca.
    const ux = -Math.sin(sun.azimuth);
    const uy = -Math.cos(sun.azimuth);
    const [qx0, qy0, qx1, qy1] = bboxXY;
    const anchoredInQuery = (x: number, y: number) => x >= qx0 && x < qx1 && y >= qy0 && y < qy1;

    const leafOff = sun.leafOff === true;
    const terrain = this.terrain;
    const buildingShadows: Polygon[] = [];
    const vegetationShadows: Polygon[] = [];
    const ownerCount = this.ownerHeight.length;
    for (let o = 0; o < ownerCount; o++) {
      const k = o * BOX_STRIDE;
      const box = this.ownerBox;
      if (!(box[k] <= box[k + 2])) continue;
      const centreX = (box[k] + box[k + 2]) / 2;
      const centreY = (box[k + 1] + box[k + 3]) / 2;
      if (!anchoredInQuery(centreX, centreY)) continue;
      let far = Math.min(this.ownerHeight[o] / tanAlt, MAX_SHADOW_M);
      let near = Math.min(this.ownerMinHeight[o] / tanAlt, far);
      if (terrain) {
        // Przybliżenie: cień pada na płaszczyznę o rzędnej terenu w miejscu, gdzie kończyłby się na płaskim
        // (jedna iteracja) — cały obrys przesuwamy o tak poprawioną długość.
        const farGround = terrainAt(terrain, centreX + ux * far, centreY + uy * far);
        const nearGround = terrainAt(terrain, centreX + ux * near, centreY + uy * near);
        far = Math.min(Math.max((this.ownerTop[o] - farGround) / tanAlt, 0), MAX_SHADOW_M);
        near =
          this.ownerMinHeight[o] > 0 ? Math.min(Math.max((this.ownerBottom[o] - nearGround) / tanAlt, 0), far) : 0;
      }
      const fx = ux * far;
      const fy = uy * far;
      const target = o < this.buildingCount ? buildingShadows : vegetationShadows;
      target.push(...this.prismShadow(o, ux * near, uy * near, fx, fy));
    }

    for (let t = 0; t < this.treeCount; t++) {
      const k = t * TREE_STRIDE;
      if (!anchoredInQuery(this.trees[k], this.trees[k + 1])) continue;
      // Bezlistna korona przepuszcza ~70% światła — to nie jest cień wart rysowania.
      if (leafOff && this.treeEvergreen[t] === 0) continue;
      const r = this.trees[k + 2];
      const zScale = this.trees[k + 4];
      const centreHeight = this.trees[k + 3] / zScale;
      const shift = Math.min(centreHeight / tanAlt, MAX_SHADOW_M);
      // Rzut elipsoidy (r, r, v) wzdłuż promieni słońca: elipsa o półosi r w poprzek
      // i sqrt(r² + (v/tan)²) wzdłuż kierunku cienia (dla kuli: r / sin(alt)).
      const along = Math.min(Math.hypot(r, r / zScale / tanAlt), MAX_SHADOW_M);
      const cx = this.trees[k] + ux * shift;
      const cy = this.trees[k + 1] + uy * shift;
      const ring: Ring = [];
      for (let i = 0; i < ELLIPSE_VERTICES; i++) {
        const angle = (2 * Math.PI * i) / ELLIPSE_VERTICES;
        const a = along * Math.cos(angle);
        const b = r * Math.sin(angle);
        ring.push([roundMm(cx + ux * a - uy * b), roundMm(cy + uy * a + ux * b)]);
      }
      ring.push(ring[0]);
      vegetationShadows.push([ring]);
    }

    const result = [
      ...toShadowPolygons('building', unionOrPieces(buildingShadows)),
      ...toShadowPolygons('tree', unionOrPieces(vegetationShadows)),
    ];
    if (terrain === null && this.vegetation === null) return result;
    const mask = this.shadeMask(bboxXY, sun);
    if (mask) {
      result.push(...toShadowPolygons('building', vectoriseMask(mask, MASK_TERRAIN)));
      result.push(...toShadowPolygons('tree', vectoriseMask(mask, MASK_TREE)));
    }
    return result;
  }

  /**
   * Maska cieni dla danych LiDAR na globalnej siatce ~2,5 m (komórka należy do okna, gdy jej środek leży
   * w [minX,maxX) × [minY,maxY) — sąsiednie okna stykają się bez nakładania): MASK_TERRAIN = słońce zasłonięte
   * rzeźbą terenu, MASK_TREE = ekspozycja przez roślinność z rastra < 0,6. Komórki w cieniu budynków
   * (i w obrysach budynków) są pomijane — te rysują wielokąty budynków.
   */
  private shadeMask(bboxXY: [number, number, number, number], sun: SunPosition): ShadeMask | null {
    const { terrain, vegetation } = this;
    const [qx0, qy0, qx1, qy1] = bboxXY;
    if (!(qx1 > qx0 && qy1 > qy0)) return null;
    let cell = MASK_CELL_M;
    while (((qx1 - qx0) / cell) * ((qy1 - qy0) / cell) > MASK_MAX_CELLS) cell *= 2;
    const i0 = Math.ceil(qx0 / cell - 0.5);
    const j0 = Math.ceil(qy0 / cell - 0.5);
    const cols = Math.ceil(qx1 / cell - 0.5) - i0;
    const rows = Math.ceil(qy1 / cell - 0.5) - j0;
    if (cols <= 0 || rows <= 0) return null;

    const tanAlt = Math.tan(sun.altitude);
    const sinAlt = Math.sin(sun.altitude);
    const dx = Math.sin(sun.azimuth);
    const dy = Math.cos(sun.azimuth);
    const leafOff = sun.leafOff === true;
    const cells = new Uint8Array(cols * rows);
    let any = false;
    for (let j = 0; j < rows; j++) {
      const y = (j0 + j + 0.5) * cell;
      for (let i = 0; i < cols; i++) {
        const x = (i0 + i + 0.5) * cell;
        const ground = terrain ? terrainAt(terrain, x, y) : 0;
        // Mapa pokazuje wierzch pomostu, a maska liczy cień na poziomie terenu pod nim — na mostach jej nie rysujemy.
        if (this.decks !== null && this.deckAt(x, y, ground) !== null) continue;
        const eye = ground + EYE_M;
        let value = 0;
        if (terrain && this.terrainBlocks(x, y, dx, dy, tanAlt, eye)) value = MASK_TERRAIN;
        else if (
          vegetation &&
          this.vegetationTransmission(x, y, dx, dy, tanAlt, sinAlt, eye, leafOff) < MASK_TREE_EXPOSURE
        ) {
          value = MASK_TREE;
        }
        if (value === 0 || this.castObjects(x, y, dx, dy, tanAlt, ground, leafOff) === 0) continue;
        cells[j * cols + i] = value;
        any = true;
      }
    }
    return any ? { cells, cols, rows, cell, originX: i0 * cell, originY: j0 * cell } : null;
  }

  /**
   * Cień graniastosłupa na gruncie: rzut bryły (obrys z dziedzińcami) przesunięty o wektor `near` (dolna
   * krawędź bryły), o wektor `far` (krawędź dachu) oraz czworokąty zakreślone przez każdą ścianę między nimi —
   * także ściany dziedzińców, więc dziedziniec jest w cieniu tylko tam, dokąd sięga cień jego murów.
   */
  private prismShadow(o: number, nearX: number, nearY: number, farX: number, farY: number) {
    const segs = this.segs;
    const sweepX = farX - nearX;
    const sweepY = farY - nearY;
    const nearPolygon: Polygon = [];
    const farPolygon: Polygon = [];
    const pieces: Polygon[] = [];
    const firstRing = this.ownerRingStart[o];
    for (let r = firstRing, lastRing = this.ownerRingStart[o + 1]; r < lastRing; r++) {
      const nearRing: Ring = [];
      const farRing: Ring = [];
      for (let s = this.ringSegStart[r], end = this.ringSegStart[r + 1]; s < end; s++) {
        const k = s * SEG_STRIDE;
        const x1 = segs[k];
        const y1 = segs[k + 1];
        const ex = segs[k + 2];
        const ey = segs[k + 3];
        const a: [number, number] = [roundMm(x1 + nearX), roundMm(y1 + nearY)];
        const d: [number, number] = [roundMm(x1 + farX), roundMm(y1 + farY)];
        nearRing.push(a);
        farRing.push(d);
        // Ściana równoległa do kierunku cienia zakreśla czworokąt o zerowym polu — pomijamy.
        if (Math.abs(ex * sweepY - ey * sweepX) < 1e-3) continue;
        const b: [number, number] = [roundMm(x1 + ex + nearX), roundMm(y1 + ey + nearY)];
        const c: [number, number] = [roundMm(x1 + ex + farX), roundMm(y1 + ey + farY)];
        pieces.push([[a, b, c, d, a]]);
      }
      if (nearRing.length < 3) {
        if (r === firstRing) return []; // zdegenerowany obrys zewnętrzny
        continue;
      }
      nearRing.push(nearRing[0]);
      farRing.push(farRing[0]);
      nearPolygon.push(nearRing);
      farPolygon.push(farRing);
    }
    pieces.push(nearPolygon);
    if (pieces.length > 1) pieces.push(farPolygon);
    return unionOrPieces(pieces);
  }
}

/** 6 miejsc po przecinku ≈ 0,1 m — wystarcza do rysowania, a wyraźnie skraca odpowiedź JSON. */
function roundLonLat([lon, lat]: [number, number]): [number, number] {
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Suma wielokątów; polygon-clipping potrafi rzucić na zdegenerowanej geometrii — wtedy zwracamy kawałki. */
function unionOrPieces(pieces: Polygon[]): MultiPolygon {
  if (pieces.length < 2) return pieces;
  try {
    return polygonClipping.union(pieces[0], ...pieces.slice(1));
  } catch {
    return pieces;
  }
}

function toShadowPolygons(kind: ShadowPolygon['kind'], polygons: MultiPolygon): ShadowPolygon[] {
  return polygons.map((polygon) => ({
    kind,
    rings: polygon.map((ring) => ring.map(([x, y]) => roundLonLat(toLonLat(x, y)))),
  }));
}

// ───────────────────────── rastry LiDAR ─────────────────────────

function validRaster(raster: HeightRaster | null): raster is HeightRaster {
  return (
    raster !== null &&
    raster.cols > 0 &&
    raster.rows > 0 &&
    raster.cellM > 0 &&
    raster.data.length >= raster.cols * raster.rows
  );
}

/** Czy raster ma dane (wartość inną niż NaN) w komórce zawierającej punkt. */
function rasterHasData(raster: HeightRaster, x: number, y: number): boolean {
  const col = Math.floor((x - raster.x0) / raster.cellM);
  const row = Math.floor((y - raster.y0) / raster.cellM);
  if (col < 0 || col >= raster.cols || row < 0 || row >= raster.rows) return false;
  return !Number.isNaN(raster.data[row * raster.cols + col]);
}

/** Środek prostokąta otaczającego pierścień. */
function ringCentre(ring: number[]): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]);
    maxY = Math.max(maxY, ring[i + 1]);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Siatka zgrubna: maksimum `valueAt` w bloku 2^shift komórek, rozszerzone o 8 sąsiednich bloków. */
function buildCoarse(
  cols: number,
  rows: number,
  shift: number,
  valueAt: (index: number, col: number, row: number) => number,
): { coarse: Float32Array; coarseCols: number; max: number } {
  const coarseCols = ((cols - 1) >> shift) + 1;
  const coarseRows = ((rows - 1) >> shift) + 1;
  const blockMax = new Float32Array(coarseCols * coarseRows).fill(-Infinity);
  let max = -Infinity;
  for (let row = 0; row < rows; row++) {
    const blockRow = (row >> shift) * coarseCols;
    for (let col = 0; col < cols; col++) {
      const value = valueAt(row * cols + col, col, row);
      const b = blockRow + (col >> shift);
      if (value > blockMax[b]) blockMax[b] = value;
      if (value > max) max = value;
    }
  }
  const coarse = new Float32Array(blockMax.length);
  for (let br = 0; br < coarseRows; br++) {
    for (let bc = 0; bc < coarseCols; bc++) {
      let m = -Infinity;
      for (let r = Math.max(0, br - 1); r <= Math.min(coarseRows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(coarseCols - 1, bc + 1); c++) {
          const value = blockMax[r * coarseCols + c];
          if (value > m) m = value;
        }
      }
      coarse[br * coarseCols + bc] = m;
    }
  }
  return { coarse, coarseCols, max };
}

/**
 * Raster terenu bez dziur: każda komórka NaN (np. cały kafel LiDAR jeszcze niepobrany) dostaje rzędną NAJBLIŻSZEJ
 * znanej komórki (przeszukiwanie wszerz od wszystkich znanych naraz), więc na granicy danych nie powstaje sztuczny
 * próg. Rzędna jest określona wszędzie (poza rastrem: wartość z najbliższej krawędzi), ale komórki wypełnione
 * są oznaczone jako nieznane (known = 0) i nie zasłaniają słońca.
 */
function prepareTerrain(raster: HeightRaster | null): RasterGrid | null {
  if (!validRaster(raster)) return null;
  const { cols, rows } = raster;
  const count = cols * rows;
  const data = Float32Array.from(raster.data.subarray(0, count));
  const known = new Uint8Array(count);
  const queue = new Int32Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) {
    if (Number.isFinite(data[i])) {
      known[i] = 1;
      queue[tail++] = i;
    }
  }
  if (tail === 0) return null;
  const complete = tail === count;
  if (!complete) {
    const filled = Uint8Array.from(known);
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const col = i % cols;
      const value = data[i];
      if (col > 0 && !filled[i - 1]) (filled[i - 1] = 1), (data[i - 1] = value), (queue[tail++] = i - 1);
      if (col < cols - 1 && !filled[i + 1]) (filled[i + 1] = 1), (data[i + 1] = value), (queue[tail++] = i + 1);
      if (i >= cols && !filled[i - cols]) (filled[i - cols] = 1), (data[i - cols] = value), (queue[tail++] = i - cols);
      if (i + cols < count && !filled[i + cols]) (filled[i + cols] = 1), (data[i + cols] = value), (queue[tail++] = i + cols);
    }
  }

  const shift = TERRAIN_BLOCK_SHIFT;
  const { coarse, coarseCols, max } = buildCoarse(cols, rows, shift, (i) => data[i]);
  return {
    x0: raster.x0,
    y0: raster.y0,
    cell: raster.cellM,
    inv: 1 / raster.cellM,
    cols,
    rows,
    data,
    max,
    shift,
    coarse,
    coarseCols,
    ...(complete ? {} : { known }),
  };
}

/** Raster roślinności; siatka zgrubna i maksimum liczone dla rzędnych szczytów koron (teren + wysokość). */
function prepareVegetation(
  raster: HeightRaster | null,
  terrain: RasterGrid | null,
  crownBase: Uint8Array | null,
): RasterGrid | null {
  if (!validRaster(raster)) return null;
  const { cols, rows, data, x0, y0, cellM } = raster;
  const shift = VEG_BLOCK_SHIFT;
  const { coarse, coarseCols, max } = buildCoarse(cols, rows, shift, (i, col, row) => {
    const h = data[i];
    if (!(h > CROWN_BASE_MIN_M)) return -Infinity;
    if (!terrain) return h;
    // Zapas 0,5 m: w marszu rzędna terenu jest próbkowana w punkcie promienia, nie w środku komórki.
    return h + terrainAt(terrain, x0 + (col + 0.5) * cellM, y0 + (row + 0.5) * cellM) + 0.5;
  });
  // Raster bez żadnej roślinności nadal zastępuje drzewa z OSM (tam, gdzie ma dane), ale nie wymaga marszu.
  if (max === -Infinity) return null;
  const bases = crownBase !== null && crownBase.length >= cols * rows ? crownBase : null;
  return { x0, y0, cell: cellM, inv: 1 / cellM, cols, rows, data, max, shift, coarse, coarseCols, crownBase: bases };
}

/** Komórki rastra roślinności pod koronami drzew z OSM oznaczonych jako zimozielone (null, gdy takich nie ma). */
function evergreenCells(v: RasterGrid, trees: AreaData['trees']): Set<number> | null {
  let cells: Set<number> | null = null;
  for (const tree of trees) {
    if (tree.evergreen !== true || !(tree.crownRadius > 0)) continue;
    const r = tree.crownRadius;
    const colFrom = Math.max(0, Math.floor((tree.x - r - v.x0) * v.inv));
    const colTo = Math.min(v.cols - 1, Math.floor((tree.x + r - v.x0) * v.inv));
    const rowFrom = Math.max(0, Math.floor((tree.y - r - v.y0) * v.inv));
    const rowTo = Math.min(v.rows - 1, Math.floor((tree.y + r - v.y0) * v.inv));
    for (let row = rowFrom; row <= rowTo; row++) {
      for (let col = colFrom; col <= colTo; col++) {
        const cx = v.x0 + (col + 0.5) * v.cell - tree.x;
        const cy = v.y0 + (row + 0.5) * v.cell - tree.y;
        if (cx * cx + cy * cy > (r + v.cell * 0.5) ** 2 || !(v.data[row * v.cols + col] > 0)) continue;
        (cells ??= new Set()).add(row * v.cols + col);
      }
    }
  }
  return cells;
}

function ringContainsPoint(ring: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i + 1];
    const yj = ring[j + 1];
    if (yi > y !== yj > y && x < ring[i] + ((ring[j] - ring[i]) * (y - yi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

function buildDeckIndex(decks: BridgeDeck[]): DeckIndex | null {
  const usable = decks.filter((deck) => deck.ring.length >= 8);
  if (usable.length === 0) return null;
  const boxes = new Float64Array(usable.length * BOX_STRIDE);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  usable.forEach((deck, d) => {
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (let i = 0; i + 1 < deck.ring.length; i += 2) {
      bx0 = Math.min(bx0, deck.ring[i]);
      bx1 = Math.max(bx1, deck.ring[i]);
      by0 = Math.min(by0, deck.ring[i + 1]);
      by1 = Math.max(by1, deck.ring[i + 1]);
    }
    boxes.set([bx0, by0, bx1, by1], d * BOX_STRIDE);
    minX = Math.min(minX, bx0);
    minY = Math.min(minY, by0);
    maxX = Math.max(maxX, bx1);
    maxY = Math.max(maxY, by1);
  });
  maxX += 1e-6;
  maxY += 1e-6;
  const cell = Math.max(DECK_INDEX_CELL_M, Math.sqrt(((maxX - minX) * (maxY - minY)) / 1_000_000));
  const inv = 1 / cell;
  const nx = Math.max(1, Math.ceil((maxX - minX) * inv));
  const ny = Math.max(1, Math.ceil((maxY - minY) * inv));
  const cellOf = (v: number, min: number, n: number): number => Math.min(n - 1, Math.max(0, ((v - min) * inv) | 0));
  const start = new Int32Array(nx * ny + 1);
  const each = (visit: (c: number, d: number) => void): void => {
    for (let d = 0; d < usable.length; d++) {
      const k = d * BOX_STRIDE;
      const cx1 = cellOf(boxes[k + 2], minX, nx);
      const cy1 = cellOf(boxes[k + 3], minY, ny);
      for (let cy = cellOf(boxes[k + 1], minY, ny); cy <= cy1; cy++) {
        for (let cx = cellOf(boxes[k], minX, nx); cx <= cx1; cx++) visit(cy * nx + cx, d);
      }
    }
  };
  each((c) => start[c + 1]++);
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[nx * ny]);
  const fill = start.slice(0, -1);
  each((c, d) => (items[fill[c]++] = d));
  return { decks: usable, boxes, minX, minY, maxX, maxY, inv, nx, ny, start, items };
}

/** Rzędna terenu: interpolacja dwuliniowa między środkami komórek, poza rastrem wartość z krawędzi. */
function terrainAt(t: RasterGrid, x: number, y: number): number {
  const maxCol = t.cols - 1;
  const maxRow = t.rows - 1;
  let fx = (x - t.x0) * t.inv - 0.5;
  let fy = (y - t.y0) * t.inv - 0.5;
  if (!(fx > 0)) fx = 0;
  else if (fx > maxCol) fx = maxCol;
  if (!(fy > 0)) fy = 0;
  else if (fy > maxRow) fy = maxRow;
  const col = fx | 0;
  const row = fy | 0;
  const tx = fx - col;
  const ty = fy - row;
  const data = t.data;
  const k = row * t.cols + col;
  const right = col < maxCol ? 1 : 0;
  const up = row < maxRow ? t.cols : 0;
  const south = data[k] + (data[k + right] - data[k]) * tx;
  const north = data[k + up] + (data[k + up + right] - data[k + up]) * tx;
  return south + (north - south) * ty;
}

// ───────────────────────── wektoryzacja maski cieni ─────────────────────────

interface ShadeMask {
  cells: Uint8Array;
  cols: number;
  rows: number;
  cell: number;
  originX: number;
  originY: number;
}

// Kierunki krawędzi: 0 = wschód, 1 = północ, 2 = zachód, 3 = południe.
const DIR_X = [1, 0, -1, 0];
const DIR_Y = [0, 1, 0, -1];

/**
 * Zamienia komórki maski o wartości `value` w wielokąty (metry lokalne): obrysy spójnych (4-sąsiedztwo) plam
 * z dziurami, uproszczone algorytmem Douglasa–Peuckera; drobne plamy (< 3 komórek) są pomijane.
 */
function vectoriseMask(mask: ShadeMask, value: number): MultiPolygon {
  const { cells, cols, rows } = mask;
  // 1. Etykiety spójnych składowych.
  const labels = new Int32Array(cols * rows);
  const stack: number[] = [];
  const kept: boolean[] = [false];
  let any = false;
  const visit = (i: number, label: number): void => {
    if (cells[i] === value && labels[i] === 0) {
      labels[i] = label;
      stack.push(i);
    }
  };
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== value || labels[start] !== 0) continue;
    const label = kept.length;
    let size = 0;
    visit(start, label);
    while (stack.length > 0) {
      const i = stack.pop()!;
      size++;
      const col = i % cols;
      if (col > 0) visit(i - 1, label);
      if (col < cols - 1) visit(i + 1, label);
      if (i >= cols) visit(i - cols, label);
      if (i + cols < cells.length) visit(i + cols, label);
    }
    kept.push(size >= MASK_MIN_COMPONENT_CELLS);
    if (size >= MASK_MIN_COMPONENT_CELLS) any = true;
  }
  if (!any) return [];
  const inside = (col: number, row: number): boolean =>
    col >= 0 && col < cols && row >= 0 && row < rows && kept[labels[row * cols + col]];

  // 2. Krawędzie graniczne skierowane tak, by plama była po lewej (obrys zewnętrzny przeciwnie do zegara).
  const vcols = cols + 1;
  const out = new Uint8Array(vcols * (rows + 1));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!inside(col, row)) continue;
      if (!inside(col, row - 1)) out[row * vcols + col] |= 1; // dolna: na wschód
      if (!inside(col + 1, row)) out[row * vcols + col + 1] |= 2; // prawa: na północ
      if (!inside(col, row + 1)) out[(row + 1) * vcols + col + 1] |= 4; // górna: na zachód
      if (!inside(col - 1, row)) out[(row + 1) * vcols + col] |= 8; // lewa: na południe
    }
  }

  // 3. Śledzenie pierścieni; w wierzchołku, gdzie plamy stykają się rogami, skręt w lewo trzyma się tej samej plamy.
  const rings: { points: [number, number][]; label: number }[] = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0] !== 0) {
      let startDir = 0;
      while ((out[v0] & (1 << startDir)) === 0) startDir++;
      const vx0 = v0 % vcols;
      const vy0 = (v0 / vcols) | 0;
      // Komórka po lewej stronie krawędzi startowej wyznacza składową.
      const cellCol = startDir === 0 || startDir === 3 ? vx0 : vx0 - 1;
      const cellRow = startDir === 0 || startDir === 1 ? vy0 : vy0 - 1;
      const label = labels[cellRow * cols + cellCol];
      const points: [number, number][] = [];
      let vx = vx0;
      let vy = vy0;
      let dir = startDir;
      let previousDir = -1;
      let closed = false;
      for (;;) {
        if (dir !== previousDir) points.push([vx, vy]);
        // Krawędź startową zdejmujemy dopiero na końcu — po niej rozpoznajemy zamknięcie pierścienia.
        if (previousDir !== -1) out[vy * vcols + vx] &= ~(1 << dir);
        previousDir = dir;
        vx += DIR_X[dir];
        vy += DIR_Y[dir];
        const next = out[vy * vcols + vx];
        const left = (dir + 1) & 3;
        const right = (dir + 3) & 3;
        let chosen: number;
        if (next & (1 << left)) chosen = left;
        else if (next & (1 << dir)) chosen = dir;
        else if (next & (1 << right)) chosen = right;
        else break; // niespójna maska — nie powinno się zdarzyć
        if (vx === vx0 && vy === vy0 && chosen === startDir) {
          if (dir === startDir) points.shift(); // punkt startowy leżał w środku prostej krawędzi
          closed = true;
          break;
        }
        dir = chosen;
      }
      out[v0] &= ~(1 << startDir);
      if (closed && points.length >= 4) rings.push({ points, label });
    }
  }

  // 4. Uproszczenie i złożenie wielokątów (obrys + dziury) wg składowych; limit liczby wierzchołków.
  for (let tolerance = MASK_SIMPLIFY_CELLS; ; tolerance *= 2) {
    const outer = new Map<number, Ring>();
    const holes = new Map<number, Ring[]>();
    let vertices = 0;
    for (const { points, label } of rings) {
      const area = signedArea(points);
      if (Math.abs(area) < MASK_MIN_COMPONENT_CELLS) continue;
      const simplified = simplifyRing(points, tolerance);
      if (simplified.length < 3) continue;
      const ring: Ring = simplified.map(([vx, vy]) => [
        roundMm(mask.originX + vx * mask.cell),
        roundMm(mask.originY + vy * mask.cell),
      ]);
      ring.push(ring[0]);
      vertices += ring.length;
      if (area > 0) outer.set(label, ring);
      else {
        const list = holes.get(label);
        if (list) list.push(ring);
        else holes.set(label, [ring]);
      }
    }
    if (vertices > MASK_MAX_VERTICES && tolerance < 8) continue;
    const polygons: MultiPolygon = [];
    for (const [label, ring] of outer) polygons.push([ring, ...(holes.get(label) ?? [])]);
    return polygons;
  }
}

function signedArea(points: [number, number][]): number {
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    twice += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return twice / 2;
}

/** Douglas–Peucker dla pierścienia zamkniętego (bez powtórzonego punktu): dwa łańcuchy między skrajnymi punktami. */
function simplifyRing(points: [number, number][], tolerance: number): [number, number][] {
  const n = points.length;
  if (n <= 4) return points;
  let farthest = 0;
  let farthestDistance = -1;
  for (let i = 1; i < n; i++) {
    const distance = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[farthest] = keep[n] = 1;
  const at = (i: number): [number, number] => points[i === n ? 0 : i];
  const stack: number[] = [0, farthest, farthest, n];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last - first < 2) continue;
    const [ax, ay] = at(first);
    const [bx, by] = at(last);
    const ex = bx - ax;
    const ey = by - ay;
    const length = Math.hypot(ex, ey);
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = at(i);
      const distance =
        length > 0 ? Math.abs((px - ax) * ey - (py - ay) * ex) / length : Math.hypot(px - ax, py - ay);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const result: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) result.push(points[i]);
  return result;
}
