// Wyznaczanie tras pieszych minimalizujących nasłonecznienie: dociąganie punktów do grafu,
// A* z leniwą, zależną od czasu ekspozycją krawędzi, wybór strony ulicy i składanie wyniku.

import type {
  CoolSpot,
  CoolSpotKind,
  LonLat,
  MobilityProfile,
  RouteProfile,
  RouteResult,
  RouteSegment,
  SegmentKind,
  ThermalInfo,
} from '../../shared/types.ts';
import type {
  AreaData,
  CoolSpotXY,
  Graph,
  GraphEdge,
  IShadeScene,
  RouteOptions,
  RoutingContext,
  SunPosition,
  WalkWay,
} from '../contracts.ts';
import { toLatLon, toLonLat, toXY } from '../geo/project.ts';
import { isLeafOff, sunPosition } from '../geo/sun.ts';
import { raisedKerbsOf } from './build.ts';
import { buildSteps } from './steps.ts';
import { thermalInfo } from './thermal.ts';

export class NoRouteError extends Error {
  constructor(message = 'Nie znaleziono połączenia pieszego między wskazanymi punktami.') {
    super(message);
    this.name = 'NoRouteError';
  }
}

const BUCKET_MS = 10 * 60 * 1000;
const MAX_SNAP_M = 250;
/** Krawędź "zwykła" wygrywa z bliższą zadaszoną/schodami, jeśli jest dalej najwyżej o tyle metrów. */
const SNAP_PREFERENCE_SLACK_M = 8;
const SNAP_SEARCH_RADII_M = [60, 130, MAX_SNAP_M + SNAP_PREFERENCE_SLACK_M];
const GRID_CELL_M = 50;
const MAX_SEGMENT_M = 60;
/** Zmiana strony ulicy w trakcie marszu tylko wtedy, gdy druga strona jest wyraźnie bardziej zacieniona. */
const SIDE_SWITCH_GAIN = 0.15;
const DETOUR_BISECTIONS = 5;
/** Co ile metrów wzdłuż krawędzi sprawdzamy, czy tor pieszego nie wchodzi w budynek. */
const CLEARANCE_STEP_M = 3;
/** Krok sondowania w poprzek ulicy (od osi w stronę chodnika) przy szukaniu ściany. */
const SIDE_PROBE_STEP_M = 1.25;
/** Odległość pieszego od ściany, do której dosunął go model. */
const WALL_CLEARANCE_M = 0.6;
/** Oś drogi bliżej ściany niż tyle traktujemy jak przyklejoną do niej (np. obrys placu wspólny z fasadą). */
const WALL_PROBE_M = 0.3;
/** Jak daleko w bok szukamy wyjścia, gdy oś drogi leży w obrysie budynku (dalej = prawdziwe przejście przez budynek). */
const WALL_ESCAPE_M = 1.5;
const WALL_BISECTIONS = 4;
const MIN_EDGE_M = 1e-6;
const MAX_CACHED_EXPOSURES = 500_000;

interface ProfileSpec {
  profile: RouteProfile;
  label: string;
  wSun: number;
  wHeat: number;
  /** Maksymalny stosunek długości do trasy „Najkrótsza” (bez żadnego stałego zapasu — także na krótkich trasach). */
  detourCap: number;
}

/**
 * Profile „komfortowe”. W trybie 'sun' (zimowym) waga słońca działa odwrotnie — koszt rośnie z brakiem słońca:
 * długość × kara × (1 + wSun × sunFactor × (1 − ekspozycja)) — a mapa ciepła (LST) nie jest karana.
 */
function profileSpecs(shadePreference: number, comfort: 'shade' | 'sun'): ProfileSpec[] {
  const pref = Math.min(1, Math.max(0, shadePreference));
  if (comfort === 'sun') {
    return [
      { profile: 'balanced', label: 'Zbalansowana', wSun: 0.5 + 3.5 * pref, wHeat: 0, detourCap: 1.35 },
      { profile: 'shadiest', label: 'Najbardziej słoneczna', wSun: 10, wHeat: 0, detourCap: 2.0 },
    ];
  }
  return [
    { profile: 'balanced', label: 'Zbalansowana', wSun: 0.5 + 3.5 * pref, wHeat: 0.5 * pref, detourCap: 1.35 },
    { profile: 'shadiest', label: 'Najbardziej zacieniona', wSun: 10, wHeat: 1, detourCap: 2.0 },
  ];
}

// ───────────────────────── geometria polilinii ─────────────────────────

function polylineLength(coords: number[]): number {
  let total = 0;
  for (let i = 2; i < coords.length; i += 2) {
    total += Math.hypot(coords[i] - coords[i - 2], coords[i + 1] - coords[i - 1]);
  }
  return total;
}

function reversePolyline(coords: number[]): number[] {
  const out = new Array<number>(coords.length);
  for (let i = 0; i < coords.length; i += 2) {
    out[coords.length - 2 - i] = coords[i];
    out[coords.length - 1 - i] = coords[i + 1];
  }
  return out;
}

function pointAtDistance(coords: number[], distanceM: number): [number, number] {
  let acc = 0;
  for (let i = 2; i < coords.length; i += 2) {
    const segLen = Math.hypot(coords[i] - coords[i - 2], coords[i + 1] - coords[i - 1]);
    if (acc + segLen >= distanceM && segLen > 0) {
      const t = (distanceM - acc) / segLen;
      return [coords[i - 2] + (coords[i] - coords[i - 2]) * t, coords[i - 1] + (coords[i + 1] - coords[i - 1]) * t];
    }
    acc += segLen;
  }
  return [coords[coords.length - 2], coords[coords.length - 1]];
}

/** Fragment polilinii między odległościami startM..endM (mierzonymi od jej początku); zawsze >= 2 punkty. */
function slicePolyline(coords: number[], startM: number, endM: number): number[] {
  const out: number[] = [];
  const push = (x: number, y: number): void => {
    const n = out.length;
    if (n === 0 || out[n - 2] !== x || out[n - 1] !== y) out.push(x, y);
  };
  let acc = 0;
  for (let i = 2; i < coords.length; i += 2) {
    const x0 = coords[i - 2];
    const y0 = coords[i - 1];
    const dx = coords[i] - x0;
    const dy = coords[i + 1] - y0;
    const segLen = Math.hypot(dx, dy);
    if (acc + segLen >= startM && acc <= endM && segLen > 0) {
      const t0 = Math.min(1, Math.max(0, (startM - acc) / segLen));
      const t1 = Math.min(1, Math.max(0, (endM - acc) / segLen));
      push(x0 + dx * t0, y0 + dy * t0);
      push(x0 + dx * t1, y0 + dy * t1);
    }
    acc += segLen;
  }
  if (out.length === 0) out.push(...pointAtDistance(coords, startM));
  if (out.length === 2) out.push(out[0], out[1]);
  return out;
}

/**
 * Przesuwa polilinię o offsetM w lewo względem jej kierunku (ujemny offset = w prawo).
 * W wierzchołkach wewnętrznych złącze ukośne (miter) z ograniczeniem do 2× offsetu.
 */
function offsetPolyline(coords: number[], offsetM: number): number[] {
  const pointCount = coords.length / 2;
  const normalX = new Array<number>(pointCount - 1);
  const normalY = new Array<number>(pointCount - 1);
  let anyValid = false;
  for (let i = 0; i < pointCount - 1; i++) {
    const dx = coords[2 * i + 2] - coords[2 * i];
    const dy = coords[2 * i + 3] - coords[2 * i + 1];
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      normalX[i] = -dy / len;
      normalY[i] = dx / len;
      anyValid = true;
    } else {
      normalX[i] = NaN;
      normalY[i] = NaN;
    }
  }
  if (!anyValid) return coords.slice();
  // Odcinki zerowej długości dziedziczą normalną sąsiada.
  for (let i = 1; i < pointCount - 1; i++) {
    if (Number.isNaN(normalX[i])) {
      normalX[i] = normalX[i - 1];
      normalY[i] = normalY[i - 1];
    }
  }
  for (let i = pointCount - 3; i >= 0; i--) {
    if (Number.isNaN(normalX[i])) {
      normalX[i] = normalX[i + 1];
      normalY[i] = normalY[i + 1];
    }
  }

  const out = new Array<number>(coords.length);
  for (let i = 0; i < pointCount; i++) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(pointCount - 2, i);
    let mx = normalX[prev] + normalX[next];
    let my = normalY[prev] + normalY[next];
    const len2 = mx * mx + my * my;
    if (len2 < 1e-9) {
      // Zawrócenie o 180° — brak sensownego złącza, zostaje normalna odcinka wchodzącego.
      mx = normalX[prev];
      my = normalY[prev];
    } else {
      // Dla normalnych jednostkowych wektor złącza to (n1+n2)·2/|n1+n2|², długość ograniczona do 2.
      const scale = Math.min(2 / len2, 2 / Math.sqrt(len2));
      mx *= scale;
      my *= scale;
    }
    out[2 * i] = coords[2 * i] + mx * offsetM;
    out[2 * i + 1] = coords[2 * i + 1] + my * offsetM;
  }
  return out;
}

/** Dogęszcza polilinię tak, by żaden odcinek nie był dłuższy niż stepM (wierzchołki oryginalne zostają). */
function densify(coords: number[], stepM: number): number[] {
  const out = [coords[0], coords[1]];
  for (let i = 2; i < coords.length; i += 2) {
    const x0 = coords[i - 2];
    const y0 = coords[i - 1];
    const dx = coords[i] - x0;
    const dy = coords[i + 1] - y0;
    const parts = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepM));
    for (let k = 1; k <= parts; k++) out.push(x0 + (dx * k) / parts, y0 + (dy * k) / parts);
  }
  return out;
}

// ───────────────────────── tor pieszego a budynki ─────────────────────────
// Ekspozycja punktu w obrysie budynku to z definicji pełny cień (przejście, brama). To prawda dla osi drogi,
// która faktycznie biegnie przez budynek, ale nie dla punktów, które w budynek "wpadły" tylko dlatego, że
// model odsunął pieszego od osi jezdni o typową szerokość ulicy albo że linia w OSM leży na samej fasadzie.
// Dlatego tor pieszego jest tu dosuwany do wolnej przestrzeni, zanim policzymy dla niego cień.

/**
 * Najdalsza odległość od punktu (ax, ay) w kierunku jednostkowym (ux, uy), nie większa niż reachM, w której
 * pieszy mieści się przed pierwszą napotkaną ścianą. 0, gdy już punkt wyjścia leży w budynku.
 */
function freeReach(scene: IShadeScene, ax: number, ay: number, ux: number, uy: number, reachM: number): number {
  if (scene.insideBuilding(ax, ay)) return 0;
  const steps = Math.ceil(reachM / SIDE_PROBE_STEP_M);
  let free = 0;
  for (let i = 1; i <= steps; i++) {
    const d = (reachM * i) / steps;
    if (scene.insideBuilding(ax + ux * d, ay + uy * d)) {
      return Math.max(0, wallDistance(scene, ax, ay, ux, uy, free, d, false) - WALL_CLEARANCE_M);
    }
    free = d;
  }
  return reachM;
}

/**
 * Bisekcja położenia ściany na odcinku [fromM, toM] wzdłuż kierunku (ux, uy): jeden koniec leży w budynku,
 * drugi poza nim (`fromInside` mówi, który). Zwraca odległość ostatniego punktu poza budynkiem.
 */
function wallDistance(
  scene: IShadeScene, ax: number, ay: number, ux: number, uy: number, fromM: number, toM: number, fromInside: boolean,
): number {
  let lo = fromM;
  let hi = toM;
  for (let k = 0; k < WALL_BISECTIONS; k++) {
    const mid = (lo + hi) / 2;
    if (scene.insideBuilding(ax + ux * mid, ay + uy * mid) === fromInside) lo = mid;
    else hi = mid;
  }
  return fromInside ? hi : lo;
}

/**
 * Linia chodnika: oś jezdni odsunięta o offsetM (dodatni = w lewo). Tam, gdzie ulica jest węższa od przyjętej
 * szerokości i odsunięty punkt wypadłby w budynku, tor wraca w stronę osi — do WALL_CLEARANCE_M przed ścianą.
 */
function sideWalkLine(scene: IShadeScene, axis: number[], offsetM: number): number[] {
  const dense = densify(axis, CLEARANCE_STEP_M);
  const shifted = offsetPolyline(dense, offsetM);
  const pointCount = dense.length / 2;
  // Dla każdego punktu: jaką część pełnego odsunięcia da się wykorzystać.
  const usable = new Float64Array(pointCount).fill(1);
  let clamped = false;
  for (let i = 0; i < pointCount; i++) {
    const dx = shifted[2 * i] - dense[2 * i];
    const dy = shifted[2 * i + 1] - dense[2 * i + 1];
    const reach = Math.hypot(dx, dy);
    if (reach < MIN_EDGE_M) continue;
    const free = freeReach(scene, dense[2 * i], dense[2 * i + 1], dx / reach, dy / reach, reach);
    if (free < reach) {
      usable[i] = free / reach;
      clamped = true;
    }
  }
  // Bez kolizji wystarczy linia o oryginalnych wierzchołkach (krótsza geometria w odpowiedzi).
  if (!clamped) return offsetPolyline(axis, offsetM);

  for (let i = 0; i < pointCount; i++) {
    // Zwężenie zaczyna się punkt wcześniej i kończy punkt później — inaczej skośny odcinek między
    // punktem dosuniętym a sąsiednim, nieograniczonym, ścinałby narożnik budynku.
    const fraction = Math.min(usable[Math.max(0, i - 1)], usable[i], usable[Math.min(pointCount - 1, i + 1)]);
    shifted[2 * i] = dense[2 * i] + (shifted[2 * i] - dense[2 * i]) * fraction;
    shifted[2 * i + 1] = dense[2 * i + 1] + (shifted[2 * i + 1] - dense[2 * i + 1]) * fraction;
  }
  return shifted;
}

/**
 * Tor pieszego na drodze, którą idzie się osią. Punkty osi leżące w budynku, ale tuż przy jego ścianie
 * (wyjście na zewnątrz w zasięgu WALL_ESCAPE_M po dokładnie jednej stronie), oraz punkty na samej ścianie
 * są odsuwane na zewnątrz. Oś otoczona budynkiem z obu stron zostaje: to przejście przez budynek.
 */
function axisWalkLine(scene: IShadeScene, axis: number[]): number[] {
  const dense = densify(axis, CLEARANCE_STEP_M);
  const normals = offsetPolyline(dense, 1);
  const out = dense.slice();
  let moved = false;
  for (let i = 0; i < dense.length; i += 2) {
    const ax = dense[i];
    const ay = dense[i + 1];
    let nx = normals[i] - ax;
    let ny = normals[i + 1] - ay;
    const norm = Math.hypot(nx, ny);
    if (norm < MIN_EDGE_M) continue;
    nx /= norm;
    ny /= norm;
    const inside = scene.insideBuilding(ax, ay);
    const probe = inside ? WALL_ESCAPE_M : WALL_PROBE_M;
    const leftBlocked = scene.insideBuilding(ax + nx * probe, ay + ny * probe);
    const rightBlocked = scene.insideBuilding(ax - nx * probe, ay - ny * probe);
    if (leftBlocked === rightBlocked) continue;
    const sign = leftBlocked ? -1 : 1;
    const wall = inside ? wallDistance(scene, ax, ay, sign * nx, sign * ny, 0, probe, true) : 0;
    const shift = sign * (wall + WALL_CLEARANCE_M);
    out[i] = ax + nx * shift;
    out[i + 1] = ay + ny * shift;
    moved = true;
  }
  return moved ? out : axis;
}


// ───────────────────────── profile poruszania się (v2) ─────────────────────────

interface MobilitySpec {
  /** Prędkość marszu (m/s), gdy zapytanie jej nie podaje. */
  defaultWalkSpeed: number;
  /** Mnożnik kosztu drogi (>= 1); Infinity = droga niedostępna dla profilu. */
  wayFactor(way: WalkWay): number;
  /** Dodatkowy mnożnik prędkości (<= 1) na danej drodze. */
  speedFactor(way: WalkWay): number;
  /** Koszt (m) pokonania jednego wysokiego krawężnika. */
  kerbPenaltyM: number;
  /**
   * Mnożnik bazowy krawędzi BEZ ławki w pobliżu (>= 1). „Premia” za ławki to brak tego narzutu —
   * dzięki temu każdy mnożnik pozostaje >= 1 i heurystyka A* (odległość w linii prostej) jest dopuszczalna.
   */
  noBenchFactor: number;
}

/** Nawierzchnie uciążliwe dla wózka (mnożnik kosztu profilu „accessible”). */
const SURFACE_FACTOR: Record<string, number> = {
  sand: 3,
  mud: 3,
  grass: 2.5,
  woodchips: 2.5,
  cobblestone: 2.5,
  unhewn_cobblestone: 2.5,
  pebblestone: 2.2,
  gravel: 2.2,
  unpaved: 2,
  ground: 2,
  dirt: 2,
  earth: 2,
  grass_paver: 1.8,
  'cobblestone:flattened': 1.8,
  sett: 1.6,
  fine_gravel: 1.4,
  compacted: 1.3,
  wood: 1.2,
  metal: 1.2,
};
const SMOOTHNESS_FACTOR: Record<string, number> = {
  intermediate: 1.15,
  bad: 1.8,
  very_bad: 3,
  horrible: Infinity,
  very_horrible: Infinity,
  impassable: Infinity,
};
const SMOOTH_ENOUGH = new Set(['excellent', 'good']);
/** Tyle „kosztuje” zakazany odcinek, gdy trasy w pełni dostępnej nie ma i szukamy najmniej złej. */
const RELAXED_FORBIDDEN_FACTOR = 25;
const SENIOR_SOFTENING = 0.35;

function surfaceFactor(way: WalkWay): number {
  let factor = (way.surface !== undefined && SURFACE_FACTOR[way.surface]) || 1;
  // Jawnie dobra gładkość (np. równy bruk klinkierowy) ważniejsza niż sam rodzaj nawierzchni.
  if (way.smoothness !== undefined && SMOOTH_ENOUGH.has(way.smoothness)) factor = Math.min(factor, 1.2);
  return factor;
}

const MOBILITY: Record<MobilityProfile, MobilitySpec> = {
  default: {
    defaultWalkSpeed: 1.3,
    wayFactor: () => 1,
    speedFactor: () => 1,
    kerbPenaltyM: 0,
    noBenchFactor: 1,
  },
  accessible: {
    defaultWalkSpeed: 1.1,
    wayFactor(way) {
      if (way.wheelchair === 'no') return Infinity;
      if (way.inclinePct !== undefined && way.inclinePct > 10) return Infinity;
      let factor = 1;
      if (way.highway === 'steps') {
        // ramp=yes/ramp:stroller to zwykle rynna przy schodach, nie podjazd dla wózka — schody zawsze wykluczone.
        return Infinity;
      }
      if (way.wheelchair === 'limited') factor *= 1.5;
      factor *= surfaceFactor(way);
      factor *= (way.smoothness !== undefined && SMOOTHNESS_FACTOR[way.smoothness]) || 1;
      if (way.inclinePct !== undefined) {
        if (way.inclinePct > 6) factor *= 3;
        else if (way.inclinePct > 3) factor *= 1.4;
      }
      return factor;
    },
    speedFactor: () => 1,
    kerbPenaltyM: 150,
    noBenchFactor: 1,
  },
  senior: {
    defaultWalkSpeed: 1.0,
    wayFactor(way) {
      let factor = 1;
      if (way.highway === 'steps') factor *= way.ramp ? 1.5 : 3;
      factor *= 1 + (surfaceFactor(way) - 1) * SENIOR_SOFTENING;
      const smoothness = (way.smoothness !== undefined && SMOOTHNESS_FACTOR[way.smoothness]) || 1;
      factor *= 1 + (Math.min(smoothness, 5) - 1) * SENIOR_SOFTENING;
      if (way.inclinePct !== undefined) {
        if (way.inclinePct > 10) factor *= 1.8;
        else if (way.inclinePct > 6) factor *= 1.4;
      }
      return factor;
    },
    speedFactor: (way) => (way.highway === 'steps' ? 0.7 : 1),
    kerbPenaltyM: 0,
    noBenchFactor: 1.06,
  },
};

/** Domyślna prędkość marszu (m/s) dla profilu poruszania się. */
export function defaultWalkSpeed(mobility: MobilityProfile = 'default'): number {
  return MOBILITY[mobility].defaultWalkSpeed;
}

const wayFactors: Record<MobilityProfile, WeakMap<WalkWay, number>> = {
  default: new WeakMap(),
  accessible: new WeakMap(),
  senior: new WeakMap(),
};

function wayFactorFor(mobility: MobilityProfile, way: WalkWay): number {
  if (mobility === 'default') return 1;
  const cache = wayFactors[mobility];
  let factor = cache.get(way);
  if (factor === undefined) {
    factor = MOBILITY[mobility].wayFactor(way);
    cache.set(way, factor);
  }
  return factor;
}

// ───────────────────────── światła i przejścia (v2) ─────────────────────────

/** Oczekiwany czas czekania na przejściu z sygnalizacją / bez niej (s). */
const SIGNAL_WAIT_S = 25;
const CROSSING_WAIT_S = 5;

const wayLengths = new WeakMap<WalkWay, number>();

/**
 * Czas oczekiwania przypisany krawędzi. Przejście (droga OSM) bywa pocięte na kilka krawędzi grafu, więc czekanie
 * rozkładamy proporcjonalnie do długości — przejście w całości kosztuje dokładnie jedno czekanie, a koszt krawędzi
 * nie zależy od poprzedniej krawędzi (ważne dla poprawności A*).
 */
function edgeWaitS(edge: GraphEdge): number {
  const { way } = edge;
  if (way.kind !== 'crossing') return 0;
  let wayLength = wayLengths.get(way);
  if (wayLength === undefined) {
    wayLength = polylineLength(way.coords);
    wayLengths.set(way, wayLength);
  }
  const share = wayLength > MIN_EDGE_M ? Math.min(1, edge.lengthM / wayLength) : 0;
  return (way.signals ? SIGNAL_WAIT_S : CROSSING_WAIT_S) * share;
}

// ───────────────────────── punkty chłodu (v2) ─────────────────────────

const SPOT_CELL_M = 60;
/** Punkty chłodu pokazywane przy trasie: do tylu metrów od niej i najwyżej tyle sztuk. */
const ROUTE_SPOT_RADIUS_M = 60;
const MAX_ROUTE_SPOTS = 12;
/** viaCoolSpot: jak daleko od trasy szukamy wody i jak blisko sieci pieszej musi leżeć punkt. */
const VIA_CORRIDOR_M = 150;
const VIA_SNAP_M = 40;
const VIA_ON_ROUTE_M = 15;
const VIA_CANDIDATES = 3;
const BENCH_RADIUS_M = 30;

const WATER_KINDS: ReadonlySet<CoolSpotKind> = new Set(['drinking_water', 'fountain', 'water_mist']);

function spotPriority(kind: CoolSpotKind): number {
  if (WATER_KINDS.has(kind)) return 0;
  return kind === 'bench' ? 2 : 1;
}

interface SpotIndex {
  spots: CoolSpotXY[];
  cells: Map<number, number[]>;
}

const spotIndexes = new WeakMap<AreaData, SpotIndex>();

function spotCell(v: number): number {
  return Math.floor(v / SPOT_CELL_M);
}

function spotIndexFor(area: AreaData): SpotIndex {
  let index = spotIndexes.get(area);
  if (!index) {
    const spots = area.coolSpots ?? [];
    const cells = new Map<number, number[]>();
    spots.forEach((spot, i) => {
      const key = cellKey(spotCell(spot.x), spotCell(spot.y));
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
    });
    index = { spots, cells };
    spotIndexes.set(area, index);
  }
  return index;
}

interface SpotHit {
  spot: CoolSpotXY;
  distanceM: number;
  /** Odległość wzdłuż polilinii do punktu najbliższego punktowi chłodu. */
  alongM: number;
}

/** Punkty chłodu leżące najwyżej `radiusM` od polilinii (płaskie [x,y,...]), z najbliższym miejscem na niej. */
function spotsNearPolyline(index: SpotIndex, coords: number[], radiusM: number, accept: (spot: CoolSpotXY) => boolean): SpotHit[] {
  if (index.spots.length === 0) return [];
  const hits = new Map<number, SpotHit>();
  let acc = 0;
  for (let i = 2; i < coords.length; i += 2) {
    const x0 = coords[i - 2];
    const y0 = coords[i - 1];
    const dx = coords[i] - x0;
    const dy = coords[i + 1] - y0;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    const cx0 = spotCell(Math.min(x0, coords[i]) - radiusM);
    const cx1 = spotCell(Math.max(x0, coords[i]) + radiusM);
    const cy0 = spotCell(Math.min(y0, coords[i + 1]) - radiusM);
    const cy1 = spotCell(Math.max(y0, coords[i + 1]) + radiusM);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (const s of index.cells.get(cellKey(cx, cy)) ?? []) {
          const spot = index.spots[s];
          if (!accept(spot)) continue;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((spot.x - x0) * dx + (spot.y - y0) * dy) / len2)) : 0;
          const distanceM = Math.hypot(spot.x - (x0 + dx * t), spot.y - (y0 + dy * t));
          if (distanceM > radiusM) continue;
          const known = hits.get(s);
          if (!known || distanceM < known.distanceM) hits.set(s, { spot, distanceM, alongM: acc + segLen * t });
        }
      }
    }
    acc += segLen;
  }
  return [...hits.values()];
}

function toCoolSpot(spot: CoolSpotXY, shaded?: boolean): CoolSpot {
  const [lat, lon] = toLatLon(spot.x, spot.y);
  const out: CoolSpot = { id: spot.id, kind: spot.kind, lat, lon };
  if (spot.name !== undefined) out.name = spot.name;
  if (shaded !== undefined) out.shaded = shaded;
  return out;
}

// ───────────────────────── dociąganie do grafu ─────────────────────────

type EdgeGrid = Map<number, number[]>;
const edgeGrids = new WeakMap<Graph, EdgeGrid>();

function cellKey(cx: number, cy: number): number {
  return (cx + 0x8000) * 0x10000 + (cy + 0x8000);
}

function edgeGridFor(graph: Graph): EdgeGrid {
  let grid = edgeGrids.get(graph);
  if (grid) return grid;
  grid = new Map();
  for (let e = 0; e < graph.edges.length; e++) {
    const c = graph.edges[e].coords;
    for (let i = 2; i < c.length; i += 2) {
      const cx0 = Math.floor(Math.min(c[i - 2], c[i]) / GRID_CELL_M);
      const cx1 = Math.floor(Math.max(c[i - 2], c[i]) / GRID_CELL_M);
      const cy0 = Math.floor(Math.min(c[i - 1], c[i + 1]) / GRID_CELL_M);
      const cy1 = Math.floor(Math.max(c[i - 1], c[i + 1]) / GRID_CELL_M);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = cellKey(cx, cy);
          const list = grid.get(key);
          if (!list) grid.set(key, [e]);
          else if (list[list.length - 1] !== e) list.push(e);
        }
      }
    }
  }
  edgeGrids.set(graph, grid);
  return grid;
}

interface Snap {
  edgeIndex: number;
  /** Odległość punktu dociągnięcia od początku krawędzi, wzdłuż jej geometrii. */
  alongM: number;
  x: number;
  y: number;
  distanceM: number;
}

function projectOnEdge(edgeIndex: number, coords: number[], x: number, y: number): Snap {
  const best: Snap = { edgeIndex, alongM: 0, x: coords[0], y: coords[1], distanceM: Infinity };
  let acc = 0;
  for (let i = 2; i < coords.length; i += 2) {
    const x0 = coords[i - 2];
    const y0 = coords[i - 1];
    const dx = coords[i] - x0;
    const dy = coords[i + 1] - y0;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0;
    const px = x0 + dx * t;
    const py = y0 + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best.distanceM) {
      best.distanceM = d;
      best.alongM = acc + segLen * t;
      best.x = px;
      best.y = py;
    }
    acc += segLen;
  }
  return best;
}

function isAwkwardForSnapping(way: WalkWay): boolean {
  return way.covered || way.kind === 'covered' || way.highway === 'steps';
}

/**
 * Najbliższy punkt sieci pieszej w zasięgu `maxM` albo null. `allowed` odfiltrowuje drogi niedostępne
 * dla profilu poruszania się (np. schody dla wózka) — do takich nie dociągamy.
 */
function findSnap(graph: Graph, x: number, y: number, maxM: number, allowed?: (way: WalkWay) => boolean): Snap | null {
  const grid = edgeGridFor(graph);
  let nearest: Snap | null = null;
  let nearestPreferred: Snap | null = null;
  for (const radius of SNAP_SEARCH_RADII_M) {
    const candidates = new Set<number>();
    const cx0 = Math.floor((x - radius) / GRID_CELL_M);
    const cx1 = Math.floor((x + radius) / GRID_CELL_M);
    const cy0 = Math.floor((y - radius) / GRID_CELL_M);
    const cy1 = Math.floor((y + radius) / GRID_CELL_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (const e of grid.get(cellKey(cx, cy)) ?? []) candidates.add(e);
      }
    }
    nearest = null;
    nearestPreferred = null;
    for (const e of candidates) {
      const edge = graph.edges[e];
      if (allowed && !allowed(edge.way)) continue;
      const snap = projectOnEdge(e, edge.coords, x, y);
      if (!nearest || snap.distanceM < nearest.distanceM) nearest = snap;
      if (!isAwkwardForSnapping(edge.way) && (!nearestPreferred || snap.distanceM < nearestPreferred.distanceM)) {
        nearestPreferred = snap;
      }
    }
    // Wynik jest pewny dopiero, gdy cały krąg o promieniu (najbliższa + zapas) mieści się w przeszukanym oknie.
    if (nearest && nearest.distanceM + SNAP_PREFERENCE_SLACK_M <= radius) break;
    if (radius >= maxM + SNAP_PREFERENCE_SLACK_M) break;
  }
  if (!nearest || nearest.distanceM > maxM) return null;
  if (nearestPreferred && nearestPreferred.distanceM <= nearest.distanceM + SNAP_PREFERENCE_SLACK_M) {
    return nearestPreferred;
  }
  return nearest;
}

function snapToGraph(graph: Graph, x: number, y: number, pointLabel: string, allowed?: (way: WalkWay) => boolean): Snap {
  const snap = findSnap(graph, x, y, MAX_SNAP_M, allowed);
  if (!snap) throw new NoRouteError(`Nie znaleziono ścieżki pieszej w pobliżu punktu ${pointLabel}.`);
  return snap;
}

// ───────────────────────── kopiec ─────────────────────────

class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** Zdejmuje element o najmniejszym kluczu i zwraca jego wartość. */
  pop(): number {
    const { keys, values } = this;
    const top = values[0];
    const key = keys.pop() as number;
    const value = values.pop() as number;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return top;
  }
}

// ───────────────────────── strony ulicy ─────────────────────────

/** Strona względem kierunku geometrii krawędzi (= kierunku drogi OSM). */
type EdgeSide = 'L' | 'R';
type WalkSide = 'left' | 'right';

const NO_SIDES: EdgeSide[] = [];
const LEFT_ONLY: EdgeSide[] = ['L'];
const RIGHT_ONLY: EdgeSide[] = ['R'];
const BOTH_SIDES: EdgeSide[] = ['L', 'R'];

/** Strony, którymi można iść wzdłuż drogi; pusta lista = idziemy osią (droga sama jest przestrzenią pieszą). */
function walkableSides(way: WalkWay): EdgeSide[] {
  if (way.kind !== 'street' || way.sideOffsetM <= 0) return NO_SIDES;
  if (way.sidewalk === 'left') return LEFT_ONLY;
  if (way.sidewalk === 'right') return RIGHT_ONLY;
  return BOTH_SIDES;
}

function toWalkSide(side: EdgeSide, forward: boolean): WalkSide {
  return (side === 'L') === forward ? 'left' : 'right';
}

function toEdgeSide(side: WalkSide, forward: boolean): EdgeSide {
  return (side === 'left') === forward ? 'L' : 'R';
}

// ───────────────────────── sesja wyznaczania tras ─────────────────────────

interface Step {
  edge: GraphEdge;
  /** true = marsz zgodnie z geometrią krawędzi (from → to). */
  forward: boolean;
}

/** Wynik jednego przeszukania: ścieżka między dwoma punktami zaczepienia. */
interface Path {
  steps: Step[];
  lengthM: number;
  /** Czas (s od wyjścia) dojścia do końca ścieżki — razem z czekaniem na przejściach. */
  elapsedS: number;
  /** Koszt uogólniony ścieżki (metry „równoważne”). */
  cost: number;
}

interface Piece {
  coords: number[];
  lengthM: number;
  exposure: number;
  way: WalkWay;
  side?: WalkSide;
}

interface SegmentDraft {
  coords: number[];
  lengthM: number;
  sunM: number;
  kind: SegmentKind;
  name?: string;
  side?: WalkSide;
  signals?: boolean;
  surface?: string;
}

interface Walked {
  pieces: Piece[];
  durationS: number;
  waitS: number;
  signalCrossings: number;
  stairsCount: number;
}

/** Statystyki trasy bez geometrii — do porównywania godzin wyjścia. */
export interface RouteSummary {
  distanceM: number;
  durationS: number;
  sunDistanceM: number;
  shadeFraction: number;
  thermal: ThermalInfo;
}

function appendCoords(target: number[], coords: number[]): void {
  const n = target.length;
  const skipFirst = n >= 2 && target[n - 2] === coords[0] && target[n - 1] === coords[1];
  for (let i = skipFirst ? 2 : 0; i < coords.length; i++) target.push(coords[i]);
}

/** Tory pieszego dla krawędzi (zależą tylko od geometrii, nie od czasu) — żyją tak długo jak krawędź. */
const walkLines = new WeakMap<GraphEdge, Partial<Record<EdgeSide | 'C', number[]>>>();

class RouteSession {
  private readonly graph: Graph;
  /** Węzły wirtualne punktów zaczepienia (start, ewentualny punkt pośredni, cel): nodeCount + indeks. */
  private readonly anchorXY: [number, number][];
  /** Krawędzie wirtualne (fragmenty krawędzi, do których dociągnięto punkty); id ujemne = -(indeks+1). */
  private readonly virtualEdges: GraphEdge[] = [];
  /** Dla krawędzi wirtualnej: liczba wysokich krawężników przypadająca na ten fragment. */
  private readonly virtualKerbs: number[] = [];
  private readonly virtualAdjacency = new Map<number, number[]>();
  private readonly virtualExposures = new Map<string, number>();
  private readonly sunByBucket = new Map<number, SunPosition>();
  private readonly heatByEdge = new Map<number, number>();
  /** Mnożnik profilu poruszania się i stały koszt (m) krawędzi — liczone raz na sesję. */
  private readonly mobilityByEdge = new Map<number, number>();
  private readonly fixedCostByEdge = new Map<number, number>();
  private readonly sunLat: number;
  private readonly sunLon: number;
  private readonly departureMs: number;
  private readonly mobility: MobilityProfile;
  private readonly mobilitySpec: MobilitySpec;
  private readonly seekSun: boolean;
  private readonly kerbs: Float32Array | undefined;
  private readonly spots: SpotIndex;
  private readonly hasBenches: boolean;

  constructor(
    private readonly ctx: RoutingContext,
    private readonly opts: RouteOptions,
    anchors: Snap[],
    /** true = odcinki zakazane dla profilu są tylko bardzo drogie (gdy trasy w pełni dostępnej nie ma). */
    private readonly relaxed: boolean,
  ) {
    this.graph = ctx.graph;
    this.departureMs = opts.departure.getTime();
    this.mobility = opts.mobility ?? 'default';
    this.mobilitySpec = MOBILITY[this.mobility];
    this.seekSun = opts.comfort === 'sun';
    this.kerbs = this.mobilitySpec.kerbPenaltyM > 0 ? raisedKerbsOf(this.graph) : undefined;
    this.spots = spotIndexFor(ctx.area);
    this.hasBenches = this.mobilitySpec.noBenchFactor > 1 && this.spots.spots.some((spot) => spot.kind === 'bench');

    const [minX, minY, maxX, maxY] = ctx.area.bboxXY;
    [this.sunLat, this.sunLon] = toLatLon((minX + maxX) / 2, (minY + maxY) / 2);

    this.anchorXY = anchors.map((anchor) => [anchor.x, anchor.y]);
    // Krawędź, do której dociągnięto jeden lub więcej punktów, rozcinamy w nakładce na łańcuch fragmentów
    // (graf współdzielony między żądaniami pozostaje nietknięty).
    const byEdge = new Map<number, { alongM: number; node: number }[]>();
    anchors.forEach((anchor, i) => {
      const list = byEdge.get(anchor.edgeIndex) ?? [];
      list.push({ alongM: anchor.alongM, node: this.graph.nodeCount + i });
      byEdge.set(anchor.edgeIndex, list);
    });
    for (const [edgeIndex, cuts] of byEdge) {
      const edge = this.graph.edges[edgeIndex];
      cuts.sort((a, b) => a.alongM - b.alongM);
      let prevNode = edge.from;
      let prevM = 0;
      for (const cut of cuts) {
        this.addVirtualEdge(edge, prevNode, cut.node, prevM, cut.alongM);
        prevNode = cut.node;
        prevM = cut.alongM;
      }
      this.addVirtualEdge(edge, prevNode, edge.to, prevM, Infinity);
    }
  }

  /** Fragment krawędzi `base` między odległościami fromM..toM, zorientowany tak jak ona. */
  private addVirtualEdge(base: GraphEdge, from: number, to: number, fromM: number, toM: number): void {
    const coords = slicePolyline(base.coords, fromM, toM);
    const ref = -(this.virtualEdges.length + 1);
    const lengthM = polylineLength(coords);
    this.virtualEdges.push({ id: ref, from, to, coords, lengthM, way: base.way });
    const baseKerbs = this.kerbs?.[base.id] ?? 0;
    this.virtualKerbs.push(baseKerbs > 0 && base.lengthM > MIN_EDGE_M ? (baseKerbs * lengthM) / base.lengthM : 0);
    for (const node of from === to ? [from] : [from, to]) {
      const list = this.virtualAdjacency.get(node);
      if (list) list.push(ref);
      else this.virtualAdjacency.set(node, [ref]);
    }
  }

  private edgeByRef(ref: number): GraphEdge {
    return ref >= 0 ? this.graph.edges[ref] : this.virtualEdges[-ref - 1];
  }

  private bucketAt(elapsedS: number): number {
    return Math.floor((this.departureMs + elapsedS * 1000) / BUCKET_MS);
  }

  /** Słońce dla przedziału czasu; niesie też informację o sezonie bezlistnym (wynika z daty, więc i z przedziału). */
  private sunAt(bucket: number): SunPosition {
    let sun = this.sunByBucket.get(bucket);
    if (!sun) {
      const moment = new Date((bucket + 0.5) * BUCKET_MS);
      sun = { ...sunPosition(moment, this.sunLat, this.sunLon), leafOff: isLeafOff(moment) };
      this.sunByBucket.set(bucket, sun);
    }
    return sun;
  }

  private rawExposure(way: WalkWay, line: number[], lengthM: number, bucket: number): number {
    if (way.covered || way.kind === 'covered' || lengthM < MIN_EDGE_M) return 0;
    const sun = this.sunAt(bucket);
    if (sun.altitude <= 0) return 0;
    // v3: na moście pieszy stoi na pomoście — pomost (i to, co pod nim) go nie zacienia.
    return Math.min(1, Math.max(0, this.ctx.scene.polylineExposure(line, sun, undefined, way.bridge === true)));
  }

  /** Ekspozycja krawędzi po danej stronie ('C' = oś) w danym przedziale czasu; wynik trafia do cache. */
  private sideExposure(edge: GraphEdge, bucket: number, side: EdgeSide | 'C'): number {
    const cache = edge.id >= 0 ? this.ctx.exposureCache : this.virtualExposures;
    const key = `${bucket}:${edge.id}:${side}`;
    let value = cache.get(key);
    if (value === undefined) {
      value = this.rawExposure(edge.way, this.walkLine(edge, side), edge.lengthM, bucket);
      cache.set(key, value);
    }
    return value;
  }

  /** Tor pieszego wzdłuż krawędzi po danej stronie ('C' = oś), dosunięty do wolnej przestrzeni między budynkami. */
  private walkLine(edge: GraphEdge, side: EdgeSide | 'C'): number[] {
    let lines = walkLines.get(edge);
    if (!lines) {
      lines = {};
      walkLines.set(edge, lines);
    }
    let line = lines[side];
    if (!line) {
      const { scene } = this.ctx;
      const { way } = edge;
      if (way.covered || way.kind === 'covered' || edge.lengthM < MIN_EDGE_M) line = edge.coords;
      else if (side === 'C') line = axisWalkLine(scene, edge.coords);
      else line = sideWalkLine(scene, edge.coords, side === 'L' ? way.sideOffsetM : -way.sideOffsetM);
      lines[side] = line;
    }
    return line;
  }

  /** „Niewygoda” ekspozycji: w trybie cienia to ekspozycja, w trybie zimowym (szukaj słońca) — jej brak. */
  private discomfort(exposure: number): number {
    return this.seekSun ? 1 - exposure : exposure;
  }

  /**
   * Wybiera wygodniejszą stronę ulicy (mniej słońca, a w trybie zimowym — więcej). `preferred` (strona, którą
   * już idziemy) wygrywa, dopóki druga nie jest lepsza o więcej niż SIDE_SWITCH_GAIN — bez tego trasa
   * skakałaby przez jezdnię.
   */
  private pickSide(edge: GraphEdge, bucket: number, sides: EdgeSide[], preferred?: EdgeSide): EdgeSide {
    let best = sides[0];
    let bestDiscomfort = this.discomfort(this.sideExposure(edge, bucket, best));
    for (let i = 1; i < sides.length; i++) {
      const value = this.discomfort(this.sideExposure(edge, bucket, sides[i]));
      if (value < bestDiscomfort) {
        best = sides[i];
        bestDiscomfort = value;
      }
    }
    if (
      preferred !== undefined &&
      sides.includes(preferred) &&
      this.discomfort(this.sideExposure(edge, bucket, preferred)) <= bestDiscomfort + SIDE_SWITCH_GAIN
    ) {
      return preferred;
    }
    return best;
  }

  private searchExposure(edge: GraphEdge, bucket: number): number {
    const sides = walkableSides(edge.way);
    if (sides.length === 0) return this.sideExposure(edge, bucket, 'C');
    return this.sideExposure(edge, bucket, this.pickSide(edge, bucket, sides));
  }

  private heatOf(edge: GraphEdge): number {
    let value = this.heatByEdge.get(edge.id);
    if (value === undefined) {
      const [x, y] = pointAtDistance(edge.coords, edge.lengthM / 2);
      const [lat, lon] = toLatLon(x, y);
      value = this.opts.heat.normalized(lat, lon);
      this.heatByEdge.set(edge.id, value);
    }
    return value;
  }

  /** Mnożnik kosztu krawędzi wynikający z profilu poruszania się (>= 1 albo Infinity = nie do przejścia). */
  private mobilityFactor(edge: GraphEdge): number {
    if (this.mobility === 'default') return 1;
    let factor = this.mobilityByEdge.get(edge.id);
    if (factor === undefined) {
      factor = wayFactorFor(this.mobility, edge.way);
      if (factor === Infinity && (this.relaxed || edge.lengthM < MIN_EDGE_M)) factor = RELAXED_FORBIDDEN_FACTOR;
      if (this.hasBenches && factor !== Infinity && !this.benchNear(edge)) factor *= this.mobilitySpec.noBenchFactor;
      this.mobilityByEdge.set(edge.id, factor);
    }
    return factor;
  }

  private benchNear(edge: GraphEdge): boolean {
    const [x, y] = pointAtDistance(edge.coords, edge.lengthM / 2);
    const reach = BENCH_RADIUS_M + edge.lengthM / 2;
    for (let cx = spotCell(x - reach); cx <= spotCell(x + reach); cx++) {
      for (let cy = spotCell(y - reach); cy <= spotCell(y + reach); cy++) {
        for (const s of this.spots.cells.get(cellKey(cx, cy)) ?? []) {
          const spot = this.spots.spots[s];
          if (spot.kind === 'bench' && projectOnEdge(0, edge.coords, spot.x, spot.y).distanceM <= BENCH_RADIUS_M) return true;
        }
      }
    }
    return false;
  }

  /** Stały (niezależny od słońca) koszt krawędzi w metrach: czekanie na przejściu i wysokie krawężniki. */
  private fixedCostM(edge: GraphEdge): number {
    if (edge.way.kind !== 'crossing' && !this.kerbs) return 0;
    let value = this.fixedCostByEdge.get(edge.id);
    if (value === undefined) {
      value = edgeWaitS(edge) * this.opts.walkSpeed;
      if (this.kerbs) {
        const kerbs = edge.id >= 0 ? this.kerbs[edge.id] : this.virtualKerbs[-edge.id - 1];
        value += kerbs * this.mobilitySpec.kerbPenaltyM;
      }
      this.fixedCostByEdge.set(edge.id, value);
    }
    return value;
  }

  /** Czas przejścia krawędzi (s) razem z czekaniem na przejściu. */
  private edgeTimeS(edge: GraphEdge): number {
    const speed = this.opts.walkSpeed * edge.way.speedFactor * this.mobilitySpec.speedFactor(edge.way);
    return edge.lengthM / speed + edgeWaitS(edge);
  }

  /**
   * A* między dwoma punktami zaczepienia. Heurystyka = odległość euklidesowa: dopuszczalna i spójna, bo każdy
   * mnożnik kosztu jest >= 1, a składniki stałe (czekanie, krawężniki) są nieujemne. Ekspozycja krawędzi liczona
   * dla chwili dojścia do jej początku. `useHeuristic = false` daje zwykłego Dijkstrę (do testów).
   */
  search(fromAnchor: number, toAnchor: number, wSun: number, wHeat: number, startElapsedS = 0, useHeuristic = true): Path {
    const { graph } = this;
    const startNode = graph.nodeCount + fromAnchor;
    const endNode = graph.nodeCount + toAnchor;
    const total = graph.nodeCount + this.anchorXY.length;
    const sunWeight = wSun * this.opts.sunFactor;
    const useHeat = wHeat > 0 && this.opts.heat.available;
    const [endX, endY] = this.anchorXY[toAnchor];

    const cost = new Float64Array(total).fill(Infinity);
    const elapsed = new Float64Array(total);
    const prevNode = new Int32Array(total).fill(-1);
    const prevEdge = new Int32Array(total);
    const closed = new Uint8Array(total);

    const heuristic = (node: number): number => {
      if (!useHeuristic || node === endNode) return 0;
      const anchor = node >= graph.nodeCount ? this.anchorXY[node - graph.nodeCount] : undefined;
      const x = anchor ? anchor[0] : graph.nodeX[node];
      const y = anchor ? anchor[1] : graph.nodeY[node];
      return Math.hypot(x - endX, y - endY);
    };

    const heap = new MinHeap();
    cost[startNode] = 0;
    elapsed[startNode] = startElapsedS;
    heap.push(heuristic(startNode), startNode);

    while (heap.size > 0) {
      const u = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === endNode) break;

      const relax = (ref: number): void => {
        const edge = this.edgeByRef(ref);
        const v = edge.from === u ? edge.to : edge.from;
        if (closed[v]) return;
        const mobility = this.mobilityFactor(edge);
        if (mobility === Infinity) return;
        let multiplier = 1;
        if (sunWeight > 0) {
          multiplier += sunWeight * this.discomfort(this.searchExposure(edge, this.bucketAt(elapsed[u])));
        }
        if (useHeat) multiplier += wHeat * this.heatOf(edge);
        const candidate = cost[u] + edge.lengthM * edge.way.penalty * mobility * multiplier + this.fixedCostM(edge);
        if (candidate < cost[v]) {
          cost[v] = candidate;
          elapsed[v] = elapsed[u] + this.edgeTimeS(edge);
          prevNode[v] = u;
          prevEdge[v] = ref;
          heap.push(candidate + heuristic(v), v);
        }
      };
      if (u < graph.nodeCount) for (const ref of graph.adjacency[u]) relax(ref);
      for (const ref of this.virtualAdjacency.get(u) ?? []) relax(ref);
    }

    if (!closed[endNode]) throw new NoRouteError();
    const steps: Step[] = [];
    let lengthM = 0;
    for (let node = endNode; node !== startNode; node = prevNode[node]) {
      const edge = this.edgeByRef(prevEdge[node]);
      steps.push({ edge, forward: edge.to === node });
      lengthM += edge.lengthM;
    }
    return { steps: steps.reverse(), lengthM, elapsedS: elapsed[endNode], cost: cost[endNode] };
  }

  /**
   * Szuka trasy dla profilu; gdy przekracza dopuszczalną długość, zmniejsza wagi (bisekcja skali 0..1),
   * aż trasa zmieści się w limicie. Skala 0 odpowiada trasie najkrótszej (`fallback`).
   */
  searchWithinCap(spec: ProfileSpec, maxDistanceM: number, fallback: Path, toAnchor: number): { path: Path; scale: number } {
    const full = this.search(0, toAnchor, spec.wSun, spec.wHeat);
    if (full.lengthM <= maxDistanceM) return { path: full, scale: 1 };
    let best = fallback;
    let bestScale = 0;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < DETOUR_BISECTIONS; i++) {
      const scale = (lo + hi) / 2;
      const path = this.search(0, toAnchor, spec.wSun * scale, spec.wHeat * scale);
      if (path.lengthM <= maxDistanceM) {
        best = path;
        bestScale = scale;
        lo = scale;
      } else {
        hi = scale;
      }
    }
    return { path: best, scale: bestScale };
  }

  /** Przechodzi finalną ścieżkę z rzeczywistym upływem czasu i tnie ją na kawałki <= MAX_SEGMENT_M. */
  private walk(steps: Step[]): Walked {
    const pieces: Piece[] = [];
    let elapsedS = 0;
    let waitS = 0;
    let signalCrossings = 0;
    let stairsCount = 0;
    let previousWay: WalkWay | null = null;
    let previousStreet: { way: WalkWay; side: WalkSide } | null = null;

    for (const { edge, forward } of steps) {
      if (edge.lengthM < MIN_EDGE_M) continue;
      const way = edge.way;
      if (way.kind === 'crossing' && way.signals && previousWay?.id !== way.id) signalCrossings++;
      if (way.highway === 'steps' && previousWay?.highway !== 'steps') stairsCount++;
      previousWay = way;
      // Czekanie na zielone poprzedza wejście na przejście.
      const wait = edgeWaitS(edge);
      waitS += wait;
      elapsedS += wait;

      const sides = walkableSides(way);
      const entryBucket = this.bucketAt(elapsedS);

      let side: WalkSide | undefined;
      let edgeSide: EdgeSide | 'C' = 'C';
      if (sides.length > 0) {
        const preferred =
          previousStreet !== null &&
          (previousStreet.way.id === way.id || (way.name !== undefined && previousStreet.way.name === way.name))
            ? toEdgeSide(previousStreet.side, forward)
            : undefined;
        edgeSide = this.pickSide(edge, entryBucket, sides, preferred);
        side = toWalkSide(edgeSide, forward);
        previousStreet = { way, side };
      } else {
        previousStreet = null;
      }
      const walked = this.walkLine(edge, edgeSide);
      const line = forward ? walked : reversePolyline(walked);

      const pieceCount = Math.ceil(edge.lengthM / MAX_SEGMENT_M);
      const lineLength = polylineLength(line);
      const lengthM = edge.lengthM / pieceCount;
      const speed = this.opts.walkSpeed * way.speedFactor * this.mobilitySpec.speedFactor(way);
      for (let k = 0; k < pieceCount; k++) {
        let coords = line;
        let exposure: number;
        if (pieceCount === 1) {
          exposure = this.sideExposure(edge, entryBucket, edgeSide);
        } else {
          coords = slicePolyline(line, (lineLength * k) / pieceCount, (lineLength * (k + 1)) / pieceCount);
          exposure = this.rawExposure(way, coords, lengthM, this.bucketAt(elapsedS));
        }
        pieces.push({ coords, lengthM, exposure, way, side });
        elapsedS += lengthM / speed;
      }
    }
    return { pieces, durationS: elapsedS, waitS, signalCrossings, stairsCount };
  }

  private thermal(distanceM: number, sunDistanceM: number, durationS: number): ThermalInfo {
    const altitude = this.sunAt(this.bucketAt(durationS / 2)).altitude;
    return thermalInfo(this.opts.weather, altitude, distanceM > 0 ? sunDistanceM / distanceM : 0);
  }

  /** Same statystyki trasy (bez geometrii i instrukcji). */
  summarize(steps: Step[]): RouteSummary {
    const { pieces, durationS } = this.walk(steps);
    let distanceM = 0;
    let sunDistanceM = 0;
    for (const piece of pieces) {
      distanceM += piece.lengthM;
      sunDistanceM += piece.lengthM * piece.exposure;
    }
    return {
      distanceM,
      durationS,
      sunDistanceM,
      shadeFraction: distanceM > 0 ? 1 - sunDistanceM / distanceM : 1,
      thermal: this.thermal(distanceM, sunDistanceM, durationS),
    };
  }

  /** Punkty chłodu przy trasie, w kolejności mijania; `shaded` dla chwili, w której pieszy je mija. */
  private coolSpotsAlong(geometryXY: number[], durationS: number): CoolSpot[] {
    const hits = spotsNearPolyline(this.spots, geometryXY, ROUTE_SPOT_RADIUS_M, () => true);
    if (hits.length === 0) return [];
    hits.sort((a, b) => spotPriority(a.spot.kind) - spotPriority(b.spot.kind) || a.distanceM - b.distanceM);
    const kept = hits.slice(0, MAX_ROUTE_SPOTS).sort((a, b) => a.alongM - b.alongM);
    const totalM = polylineLength(geometryXY);
    return kept.map(({ spot, alongM }) => {
      const sun = this.sunAt(this.bucketAt(totalM > 0 ? (durationS * alongM) / totalM : 0));
      return toCoolSpot(spot, this.ctx.scene.exposureAt(spot.x, spot.y, sun) < 0.5);
    });
  }

  assemble(spec: Pick<ProfileSpec, 'profile' | 'label'>, steps: Step[], via?: CoolSpotXY): RouteResult {
    const { pieces, durationS, waitS, signalCrossings, stairsCount } = this.walk(steps);
    const { heat } = this.opts;

    const drafts: SegmentDraft[] = [];
    for (const piece of pieces) {
      const last = drafts[drafts.length - 1];
      const signals = piece.way.kind === 'crossing' ? Boolean(piece.way.signals) : undefined;
      if (
        last &&
        last.kind === piece.way.kind &&
        last.name === piece.way.name &&
        last.side === piece.side &&
        last.signals === signals &&
        last.surface === piece.way.surface &&
        last.lengthM + piece.lengthM <= MAX_SEGMENT_M
      ) {
        appendCoords(last.coords, piece.coords);
        last.lengthM += piece.lengthM;
        last.sunM += piece.lengthM * piece.exposure;
        continue;
      }
      // Nowy odcinek zaczyna się tam, gdzie skończył się poprzedni (np. przejście z osi na stronę ulicy),
      // żeby linia trasy była ciągła.
      const coords = last ? last.coords.slice(-2) : [];
      appendCoords(coords, piece.coords);
      drafts.push({
        coords,
        lengthM: piece.lengthM,
        sunM: piece.lengthM * piece.exposure,
        kind: piece.way.kind,
        name: piece.way.name,
        side: piece.side,
        signals,
        surface: piece.way.surface,
      });
    }

    const segments: RouteSegment[] = [];
    const startIndexes: number[] = [];
    const geometryXY: number[] = [];
    let distanceM = 0;
    let sunDistanceM = 0;
    let lstWeighted = 0;
    let lstLengthM = 0;
    for (const draft of drafts) {
      let lstC: number | null = null;
      if (heat.available) {
        const [mx, my] = pointAtDistance(draft.coords, polylineLength(draft.coords) / 2);
        const [lat, lon] = toLatLon(mx, my);
        lstC = heat.sampleC(lat, lon);
      }
      if (lstC !== null) {
        lstWeighted += lstC * draft.lengthM;
        lstLengthM += draft.lengthM;
      }
      distanceM += draft.lengthM;
      sunDistanceM += draft.sunM;
      startIndexes.push(Math.max(0, geometryXY.length / 2 - 1));
      appendCoords(geometryXY, draft.coords);
      const segment: RouteSegment = {
        coords: toLonLatList(draft.coords),
        lengthM: draft.lengthM,
        sunFraction: draft.sunM / draft.lengthM,
        lstC,
        kind: draft.kind,
      };
      if (draft.name !== undefined) segment.name = draft.name;
      if (draft.side !== undefined) segment.side = draft.side;
      if (draft.signals !== undefined) segment.signals = draft.signals;
      if (draft.surface !== undefined) segment.surface = draft.surface;
      segments.push(segment);
    }
    // Start i cel w tym samym miejscu: trasa zerowej długości, ale geometria musi być poprawną linią.
    if (geometryXY.length === 0) geometryXY.push(...this.anchorXY[0], ...this.anchorXY[this.anchorXY.length - 1]);

    const geometry = toLonLatList(geometryXY);
    const result: RouteResult = {
      profile: spec.profile,
      label: spec.label,
      distanceM,
      durationS,
      sunDistanceM,
      shadeFraction: distanceM > 0 ? 1 - sunDistanceM / distanceM : 1,
      meanLstC: lstLengthM > 0 ? lstWeighted / lstLengthM : null,
      geometry,
      segments,
      steps: buildSteps(segments, geometry, { startIndexes, shadeInfo: this.opts.sunFactor > 0 }),
      // Przejście przebyte tylko w części (dojście z boku) daje ułamek czekania — w wyniku pełne sekundy.
      waitS: Math.round(waitS),
      signalCrossings,
      stairsCount,
      thermal: this.thermal(distanceM, sunDistanceM, durationS),
      coolSpots: this.coolSpotsAlong(geometryXY, durationS),
    };
    if (via) {
      const sun = this.sunAt(this.bucketAt(durationS / 2));
      result.via = toCoolSpot(via, this.ctx.scene.exposureAt(via.x, via.y, sun) < 0.5);
    }
    return result;
  }
}

function toLonLatList(coords: number[]): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i < coords.length; i += 2) out.push(toLonLat(coords[i], coords[i + 1]));
  return out;
}

function pathKey(steps: Step[]): string {
  return steps
    .filter((step) => step.edge.lengthM >= MIN_EDGE_M)
    .map((step) => (step.edge.id >= 0 ? `${step.edge.id}` : `v${step.edge.from}_${step.edge.to}_${Math.round(step.edge.lengthM * 100)}`))
    .join(',');
}

function axisCoords(steps: Step[]): number[] {
  const out: number[] = [];
  for (const { edge, forward } of steps) appendCoords(out, forward ? edge.coords : reversePolyline(edge.coords));
  return out;
}

// ───────────────────────── planowanie ─────────────────────────

interface Endpoints {
  start: Snap;
  end: Snap;
}

function snapEndpoints(ctx: RoutingContext, opts: RouteOptions, relaxed: boolean): Endpoints {
  const mobility = opts.mobility ?? 'default';
  const allowed = relaxed || mobility === 'default' ? undefined : (way: WalkWay): boolean => wayFactorFor(mobility, way) !== Infinity;
  const [fromX, fromY] = toXY(opts.from.lat, opts.from.lon);
  const [toX, toY] = toXY(opts.to.lat, opts.to.lon);
  return {
    start: snapToGraph(ctx.graph, fromX, fromY, 'startowego', allowed),
    end: snapToGraph(ctx.graph, toX, toY, 'docelowego', allowed),
  };
}

interface ViaPlan {
  session: RouteSession;
  steps: Step[];
  via: CoolSpotXY;
}

/**
 * Próbuje poprowadzić trasę profilu przez punkt z wodą (woda pitna / fontanna / kurtyna wodna) leżący w pobliżu
 * trasy bezpośredniej. Zwraca null, gdy takiego punktu nie ma albo objazd nie mieści się w limicie długości.
 */
function planVia(
  ctx: RoutingContext,
  opts: RouteOptions,
  relaxed: boolean,
  ends: Endpoints,
  direct: { session: RouteSession; path: Path },
  weights: { wSun: number; wHeat: number },
  maxDistanceM: number,
): ViaPlan | null {
  const mobility = opts.mobility ?? 'default';
  const allowed = relaxed || mobility === 'default' ? undefined : (way: WalkWay): boolean => wayFactorFor(mobility, way) !== Infinity;
  const candidates = spotsNearPolyline(spotIndexFor(ctx.area), axisCoords(direct.path.steps), VIA_CORRIDOR_M, (spot) =>
    WATER_KINDS.has(spot.kind),
  )
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, VIA_CANDIDATES);

  for (const { spot, distanceM } of candidates) {
    // Punkt tuż przy trasie: nie trzeba nic zmieniać, wystarczy go wskazać.
    if (distanceM <= VIA_ON_ROUTE_M) return { session: direct.session, steps: direct.path.steps, via: spot };
    const snap = findSnap(ctx.graph, spot.x, spot.y, VIA_SNAP_M, allowed);
    if (!snap) continue;
    try {
      const session = new RouteSession(ctx, opts, [ends.start, snap, ends.end], relaxed);
      const first = session.search(0, 1, weights.wSun, weights.wHeat);
      const second = session.search(1, 2, weights.wSun, weights.wHeat, first.elapsedS);
      if (first.lengthM + second.lengthM <= maxDistanceM) {
        return { session, steps: [...first.steps, ...second.steps], via: spot };
      }
    } catch (error) {
      if (!(error instanceof NoRouteError)) throw error;
    }
  }
  return null;
}

function planRoutes(ctx: RoutingContext, opts: RouteOptions, relaxed: boolean): RouteResult[] {
  const ends = snapEndpoints(ctx, opts, relaxed);
  const session = new RouteSession(ctx, opts, [ends.start, ends.end], relaxed);
  const shortest = session.search(0, 1, 0, 0);
  const routes = [session.assemble({ profile: 'shortest', label: 'Najkrótsza' }, shortest.steps)];
  if (opts.sunFactor <= 0) return routes;

  const seen = new Set([pathKey(shortest.steps)]);
  for (const spec of profileSpecs(opts.shadePreference, opts.comfort ?? 'shade')) {
    const maxDistanceM = spec.detourCap * shortest.lengthM;
    const { path, scale } = session.searchWithinCap(spec, maxDistanceM, shortest, 1);
    let plan: { session: RouteSession; steps: Step[]; via?: CoolSpotXY } = { session, steps: path.steps };
    if (opts.viaCoolSpot) {
      const weights = { wSun: spec.wSun * scale, wHeat: spec.wHeat * scale };
      plan = planVia(ctx, opts, relaxed, ends, { session, path }, weights, maxDistanceM) ?? plan;
    }
    const key = pathKey(plan.steps);
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(plan.session.assemble(spec, plan.steps, plan.via));
  }
  return routes;
}

const NOT_FULLY_ACCESSIBLE =
  'Nie ma trasy w pełni dostępnej dla wózka między tymi punktami — pokazana trasa zawiera przeszkody ' +
  '(schody albo odcinki oznaczone jako niedostępne). Sprawdź przebieg przed wyjściem.';

/**
 * Uruchamia planowanie w trybie ścisłym; gdy profil poruszania się odcina cel (np. jedyne dojście to schody),
 * powtarza je w trybie złagodzonym, w którym odcinki zakazane są tylko bardzo kosztowne.
 */
function withMobilityFallback<T>(opts: RouteOptions, run: (relaxed: boolean) => T): { value: T; relaxed: boolean } {
  try {
    return { value: run(false), relaxed: false };
  } catch (error) {
    if (!(error instanceof NoRouteError) || (opts.mobility ?? 'default') !== 'accessible') throw error;
    return { value: run(true), relaxed: true };
  }
}

export interface RoutesOutcome {
  routes: RouteResult[];
  /** Ostrzeżenia po polsku wynikające z samego wyznaczania (np. brak trasy w pełni dostępnej). */
  warnings: string[];
}

/** Jak computeRoutes, ale razem z ostrzeżeniami dla użytkownika. */
export function computeRoutesDetailed(ctx: RoutingContext, opts: RouteOptions): RoutesOutcome {
  if (ctx.exposureCache.size > MAX_CACHED_EXPOSURES) ctx.exposureCache.clear();
  const { value, relaxed } = withMobilityFallback(opts, (isRelaxed) => planRoutes(ctx, opts, isRelaxed));
  return { routes: value, warnings: relaxed ? [NOT_FULLY_ACCESSIBLE] : [] };
}

/**
 * Zwraca do trzech tras: najkrótszą, zbalansowaną i najbardziej zacienioną (w trybie zimowym — najbardziej
 * słoneczną), bez powtórzeń geometrii. Rzuca NoRouteError, gdy punktów nie da się dociągnąć do sieci pieszej
 * albo nie ma między nimi połączenia.
 */
export function computeRoutes(ctx: RoutingContext, opts: RouteOptions): RouteResult[] {
  return computeRoutesDetailed(ctx, opts).routes;
}

/**
 * Statystyki samej trasy „zbalansowanej” (bez geometrii, instrukcji i punktów chłodu) — szybka ścieżka
 * dla porównywania godzin wyjścia. Gdy słońce się nie liczy, zwraca statystyki trasy najkrótszej.
 */
export function computeBalancedSummary(ctx: RoutingContext, opts: RouteOptions): RouteSummary {
  if (ctx.exposureCache.size > MAX_CACHED_EXPOSURES) ctx.exposureCache.clear();
  return withMobilityFallback(opts, (relaxed) => {
    const ends = snapEndpoints(ctx, opts, relaxed);
    const session = new RouteSession(ctx, opts, [ends.start, ends.end], relaxed);
    const shortest = session.search(0, 1, 0, 0);
    if (opts.sunFactor <= 0) return session.summarize(shortest.steps);
    const spec = profileSpecs(opts.shadePreference, opts.comfort ?? 'shade')[0];
    return session.summarize(session.searchWithinCap(spec, spec.detourCap * shortest.lengthM, shortest, 1).path.steps);
  }).value;
}

/**
 * Koszt uogólniony optymalnej ścieżki start → cel dla podanych wag — z heurystyką A* albo bez niej (Dijkstra).
 * Służy testom dopuszczalności heurystyki: oba warianty muszą dać ten sam koszt.
 */
export function searchCost(
  ctx: RoutingContext,
  opts: RouteOptions,
  weights: { wSun: number; wHeat: number },
  useHeuristic: boolean,
): number {
  const ends = snapEndpoints(ctx, opts, false);
  const session = new RouteSession(ctx, opts, [ends.start, ends.end], false);
  return session.search(0, 1, weights.wSun, weights.wHeat, 0, useHeuristic).cost;
}
