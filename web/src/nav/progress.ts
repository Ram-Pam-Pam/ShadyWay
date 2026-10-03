// Czysta geometria nawigacji krok po kroku: dociąganie pozycji do linii trasy, postęp, bieżący krok,
// zejście z trasy, dotarcie do celu, zapowiedzi i podpowiedzi o cieniu. Bez DOM i bez mapy — testowane jednostkowo.

import type { LatLon, LonLat, RouteResult, RouteStep } from '../../../shared/types.ts';

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

/** Po ilu metrach od linii trasy pozycję uznajemy za „poza trasą”. */
export const OFF_ROUTE_THRESHOLD_M = 35;
/** Tyle kolejnych odczytów poza trasą uruchamia wyznaczenie nowej trasy. */
export const OFF_ROUTE_FIXES = 3;
/** Odczyty o gorszej dokładności nie rozstrzygają o zejściu z trasy. */
export const MAX_USABLE_ACCURACY_M = 100;
export const ARRIVAL_RADIUS_M = 15;

type XY = readonly [number, number];

export interface RouteIndex {
  coords: LonLat[];
  /** Punkty trasy w lokalnych metrach (rzut równoodległościowy wokół pierwszego punktu). */
  xy: XY[];
  /** Długość narastająco do każdego punktu geometrii (m). */
  cum: number[];
  totalM: number;
  origin: LonLat;
  cosLat: number;
}

export interface Snap {
  /** Odległość wzdłuż trasy od startu (m). */
  alongM: number;
  /** Odległość pozycji od linii trasy (m). */
  offsetM: number;
  /** Punkt na trasie [lon, lat]. */
  point: LonLat;
  /** Indeks odcinka geometrii (między punktami i oraz i+1). */
  segment: number;
  /** Kierunek marszu w tym miejscu, 0 = północ, zgodnie z ruchem wskazówek zegara. */
  bearingDeg: number;
}

export function buildRouteIndex(geometry: readonly LonLat[]): RouteIndex {
  const coords = geometry.map(([lon, lat]) => [lon, lat] as LonLat);
  const origin: LonLat = coords[0] ?? [0, 0];
  const cosLat = Math.cos((origin[1] * Math.PI) / 180);
  const xy = coords.map(([lon, lat]) => [(lon - origin[0]) * M_PER_DEG_LON * cosLat, (lat - origin[1]) * M_PER_DEG_LAT] as XY);
  const cum: number[] = [];
  let total = 0;
  xy.forEach((point, index) => {
    if (index > 0) total += Math.hypot(point[0] - xy[index - 1][0], point[1] - xy[index - 1][1]);
    cum.push(total);
  });
  return { coords, xy, cum, totalM: total, origin, cosLat };
}

function toXY(index: RouteIndex, point: LonLat): XY {
  return [(point[0] - index.origin[0]) * M_PER_DEG_LON * index.cosLat, (point[1] - index.origin[1]) * M_PER_DEG_LAT];
}

function toLonLat(index: RouteIndex, xy: XY): LonLat {
  return [index.origin[0] + xy[0] / (M_PER_DEG_LON * index.cosLat), index.origin[1] + xy[1] / M_PER_DEG_LAT];
}

function bearingOf(dx: number, dy: number): number {
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

/** Odległość w metrach między dwoma punktami (dokładność wystarczająca w skali miasta). */
export function distanceM(a: LatLon, b: LatLon): number {
  const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * M_PER_DEG_LON * cosLat, (a.lat - b.lat) * M_PER_DEG_LAT);
}

/** Najbliższy punkt na odcinkach first..last; `minAlongM`/`maxAlongM` ograniczają wynik do fragmentu trasy. */
function snapInRange(
  index: RouteIndex,
  p: XY,
  first: number,
  last: number,
  minAlongM = -Infinity,
  maxAlongM = Infinity,
): Snap | null {
  let best: Snap | null = null;
  let bearing = 0;
  for (let i = first; i <= last; i++) {
    const a = index.xy[i];
    const b = index.xy[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    const length = Math.sqrt(lengthSq);
    // Dozwolony zakres parametru t na tym odcinku (okno postępu może obejmować tylko jego część).
    const tMin = length === 0 ? 0 : Math.min(1, Math.max(0, (minAlongM - index.cum[i]) / length));
    const tMax = length === 0 ? 0 : Math.min(1, Math.max(0, (maxAlongM - index.cum[i]) / length));
    const t = lengthSq === 0 ? 0 : Math.min(tMax, Math.max(tMin, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
    const q: XY = [a[0] + dx * t, a[1] + dy * t];
    const offset = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (lengthSq > 0) bearing = bearingOf(dx, dy);
    if (best && offset >= best.offsetM) continue;
    best = {
      alongM: index.cum[i] + length * t,
      offsetM: offset,
      point: toLonLat(index, q),
      segment: i,
      bearingDeg: bearing,
    };
  }
  return best;
}

export interface SnapOptions {
  /** Ostatni znany postęp (m): przy trasie, która zawraca lub przecina samą siebie, wybieramy miejsce blisko niego. */
  hintAlongM?: number;
  /** Jak daleko wstecz i w przód od podpowiedzi szukać w pierwszej kolejności. */
  backM?: number;
  aheadM?: number;
}

/**
 * Najbliższy punkt trasy. Z podpowiedzią postępu preferowane jest okno wokół niej; wynik spoza okna wygrywa
 * dopiero wtedy, gdy jest wyraźnie bliżej (pieszy poszedł skrótem albo wrócił na wcześniejszy fragment).
 */
export function snapToRoute(index: RouteIndex, position: LatLon, options: SnapOptions = {}): Snap | null {
  const segments = index.xy.length - 1;
  if (segments < 1) return null;
  const p = toXY(index, [position.lon, position.lat]);
  const global = snapInRange(index, p, 0, segments - 1);
  if (!global || options.hintAlongM === undefined) return global;

  const from = options.hintAlongM - (options.backM ?? 30);
  const to = options.hintAlongM + (options.aheadM ?? 150);
  let first = -1;
  let last = -1;
  for (let i = 0; i < segments; i++) {
    if (index.cum[i + 1] < from || index.cum[i] > to) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return global;
  const local = snapInRange(index, p, first, last, from, to);
  if (!local) return global;
  return local.offsetM <= global.offsetM + 15 ? local : global;
}

/** Punkt i kierunek marszu w odległości `alongM` od startu (do symulacji przejścia i ustawiania kamery). */
export function pointAlong(index: RouteIndex, alongM: number): { point: LonLat; bearingDeg: number } | null {
  const segments = index.xy.length - 1;
  if (segments < 1) return null;
  const along = Math.min(index.totalM, Math.max(0, alongM));
  let i = 0;
  while (i < segments - 1 && index.cum[i + 1] < along) i++;
  // Kierunek bierzemy z najbliższego odcinka o niezerowej długości.
  let j = i;
  while (j < segments - 1 && index.cum[j + 1] === index.cum[j]) j++;
  const a = index.xy[i];
  const b = index.xy[i + 1];
  const length = index.cum[i + 1] - index.cum[i];
  const t = length === 0 ? 0 : (along - index.cum[i]) / length;
  const dir: XY = [index.xy[j + 1][0] - index.xy[j][0], index.xy[j + 1][1] - index.xy[j][1]];
  return {
    point: toLonLat(index, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]),
    bearingDeg: bearingOf(dir[0], dir[1]),
  };
}

// ───────────── kroki ─────────────

/** Odległość od startu (m), w której zaczyna się każdy krok. */
export function stepStarts(index: RouteIndex, steps: readonly Pick<RouteStep, 'geometryIndex'>[]): number[] {
  const last = index.cum.length - 1;
  let previous = 0;
  return steps.map((step) => {
    const at = last < 0 ? 0 : index.cum[Math.min(last, Math.max(0, Math.round(step.geometryIndex)))];
    previous = Math.max(previous, at);
    return previous;
  });
}

/** Indeks kroku, w którym jest pieszy; krok „arrive” na końcu nie staje się bieżący przed dotarciem. */
export function stepIndexAt(starts: readonly number[], alongM: number): number {
  if (starts.length === 0) return -1;
  let current = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= alongM + 2) current = i;
  }
  return Math.min(current, Math.max(0, starts.length - 2));
}

export interface SegmentRange {
  startM: number;
  endM: number;
}

/** Zakresy odcinków trasy wzdłuż geometrii (długości odcinków przeskalowane do długości linii). */
export function segmentRanges(route: Pick<RouteResult, 'segments'>, totalM: number): SegmentRange[] {
  const sum = route.segments.reduce((acc, segment) => acc + Math.max(0, segment.lengthM), 0);
  const scale = sum > 0 ? totalM / sum : 0;
  let at = 0;
  return route.segments.map((segment) => {
    const startM = at;
    at += Math.max(0, segment.lengthM) * scale;
    return { startM, endM: at };
  });
}

export interface NavProgress {
  alongM: number;
  remainingM: number;
  remainingS: number;
  /** Bieżący krok (-1, gdy trasa nie ma kroków). */
  stepIndex: number;
  /** Krok z najbliższym manewrem (-1, gdy brak). */
  nextStepIndex: number;
  distanceToNextM: number;
  /** Udział cienia na pozostałej części trasy, 0..1 (null, gdy brak odcinków). */
  shadeAhead: number | null;
}

export interface NavRoute {
  route: RouteResult;
  index: RouteIndex;
  starts: number[];
  ranges: SegmentRange[];
}

export function prepareRoute(route: RouteResult): NavRoute {
  const index = buildRouteIndex(route.geometry);
  return { route, index, starts: stepStarts(index, route.steps ?? []), ranges: segmentRanges(route, index.totalM) };
}

export function shadeAheadFraction(nav: Pick<NavRoute, 'route' | 'ranges'>, alongM: number): number | null {
  let length = 0;
  let shade = 0;
  nav.ranges.forEach((range, i) => {
    const part = range.endM - Math.max(range.startM, alongM);
    if (part <= 1e-6) return; // sam koniec trasy: błąd zaokrągleń to nie „pozostała droga”
    length += part;
    shade += part * (1 - Math.min(1, Math.max(0, nav.route.segments[i].sunFraction)));
  });
  return length > 0 ? shade / length : null;
}

export function navProgress(nav: NavRoute, alongM: number): NavProgress {
  const total = nav.index.totalM;
  const along = Math.min(total, Math.max(0, alongM));
  const remainingM = total - along;
  const stepIndex = stepIndexAt(nav.starts, along);
  const nextStepIndex = stepIndex >= 0 && stepIndex + 1 < nav.starts.length ? stepIndex + 1 : -1;
  return {
    alongM: along,
    remainingM,
    remainingS: total > 0 ? nav.route.durationS * (remainingM / total) : 0,
    stepIndex,
    nextStepIndex,
    distanceToNextM: nextStepIndex >= 0 ? Math.max(0, nav.starts[nextStepIndex] - along) : remainingM,
    shadeAhead: shadeAheadFraction(nav, along),
  };
}

// ───────────── zejście z trasy i dotarcie ─────────────

export interface OffRouteResult {
  /** Liczba kolejnych odczytów poza trasą. */
  strikes: number;
  offRoute: boolean;
}

/**
 * Aktualizuje licznik odczytów poza trasą. Odczyt liczy się, gdy pozycja jest dalej od trasy niż próg
 * i niż własna niepewność; odczyty bardzo niedokładne są pomijane (licznik bez zmian).
 */
export function trackOffRoute(
  strikes: number,
  offsetM: number,
  accuracyM: number | null,
  thresholdM: number = OFF_ROUTE_THRESHOLD_M,
  fixes: number = OFF_ROUTE_FIXES,
): OffRouteResult {
  const accuracy = accuracyM !== null && Number.isFinite(accuracyM) ? Math.max(0, accuracyM) : 0;
  if (accuracy > MAX_USABLE_ACCURACY_M) return { strikes, offRoute: false };
  const next = offsetM > Math.max(thresholdM, accuracy) ? strikes + 1 : 0;
  return { strikes: next, offRoute: next >= fixes };
}

/** U celu: koniec trasy jest tuż-tuż, a pieszy faktycznie idzie trasą albo stoi przy punkcie docelowym. */
export function hasArrived(remainingM: number, offsetM: number, directToDestinationM: number): boolean {
  if (directToDestinationM <= ARRIVAL_RADIUS_M) return true;
  return remainingM <= ARRIVAL_RADIUS_M && offsetM <= OFF_ROUTE_THRESHOLD_M;
}

// ───────────── teksty: instrukcje i zapowiedzi ─────────────

/** Dzieli instrukcję serwera na manewr („Skręć w lewo — ul. Karmelicka.”) i opis marszu („Idź 240 m…”). */
export function splitInstruction(text: string): { lead: string; rest: string } {
  const match = /^(.*?[.!])\s+(Idź\s.*)$/s.exec(text.trim());
  return match ? { lead: match[1], rest: match[2] } : { lead: text.trim(), rest: '' };
}

function roundForSpeech(metres: number): number {
  if (metres < 100) return Math.max(10, Math.round(metres / 10) * 10);
  return Math.round(metres / 50) * 50;
}

/** Dystans słownie dla syntezatora mowy: „50 metrów”, „1,2 kilometra”. */
export function spokenDistance(metres: number): string {
  if (metres >= 950) return `${(Math.round(metres / 100) / 10).toFixed(1).replace('.', ',').replace(',0', '')} kilometra`;
  return `${roundForSpeech(metres)} metrów`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase('pl-PL') + text.slice(1);
}

export interface Announcement {
  /** Klucz zapowiedzi — każdą wypowiadamy tylko raz. */
  key: string;
  text: string;
}

const ANNOUNCE_NOW_M = 20;
const ANNOUNCE_AHEAD_MAX_M = 130;
const ANNOUNCE_AHEAD_MIN_M = 45;

/**
 * Zapowiedź głosowa należna w danym miejscu trasy: instrukcja startowa, „za 100 metrów…” przed manewrem
 * i sam manewr tuż przed nim. `spoken` to klucze już wypowiedziane.
 */
export function dueAnnouncement(
  steps: readonly Pick<RouteStep, 'text' | 'maneuver'>[],
  progress: Pick<NavProgress, 'stepIndex' | 'nextStepIndex' | 'distanceToNextM'>,
  spoken: ReadonlySet<string>,
): Announcement | null {
  const current = steps[progress.stepIndex];
  if (current && progress.stepIndex === 0 && !spoken.has('start')) return { key: 'start', text: current.text };

  const next = steps[progress.nextStepIndex];
  if (!next) return null;
  const { lead } = splitInstruction(next.text);
  const arriving = next.maneuver === 'arrive';
  const distance = progress.distanceToNextM;

  if (distance <= ANNOUNCE_NOW_M) {
    const key = `now:${progress.nextStepIndex}`;
    if (arriving || spoken.has(key)) return null; // dotarcie ogłasza osobno tryb nawigacji
    return { key, text: lead };
  }
  if (distance <= ANNOUNCE_AHEAD_MAX_M && distance >= ANNOUNCE_AHEAD_MIN_M) {
    const key = `ahead:${progress.nextStepIndex}`;
    if (spoken.has(key)) return null;
    const what = arriving ? 'cel' : lowerFirst(lead.replace(/[.!]$/, ''));
    return { key, text: `Za ${spokenDistance(distance)}: ${what}.` };
  }
  return null;
}

// ───────────── podpowiedzi o cieniu ─────────────

export interface ShadeHint {
  key: string;
  text: string;
  /** Czy przed pieszym jest zmiana na lepsze (cień latem, słońce zimą). */
  tone: 'good' | 'bad';
}

const HINT_LOOKAHEAD_M = 150;
const HINT_MIN_RUN_M = 40;
const HINT_MIN_DISTANCE_M = 10;

function hintDistance(metres: number): string {
  const rounded = metres < 100 ? Math.max(10, Math.round(metres / 10) * 10) : Math.round(metres / 50) * 50;
  return `${rounded} m`;
}

type Exposure = 'shade' | 'sun' | 'mixed';

function exposureOf(sunFraction: number): Exposure {
  if (sunFraction <= 0.35) return 'shade';
  if (sunFraction >= 0.65) return 'sun';
  return 'mixed';
}

/**
 * Podpowiedź o tym, co czeka pieszego w najbliższych ~150 m: zmiana strony ulicy
 * („Za 50 m przejdź na lewą stronę — cień”) albo wejście w cień / wyjście na słońce.
 */
export function shadeHint(
  nav: Pick<NavRoute, 'route' | 'ranges'>,
  alongM: number,
  comfort: 'shade' | 'sun',
): ShadeHint | null {
  const { segments } = nav.route;
  const current = nav.ranges.findIndex((range) => alongM < range.endM);
  if (current < 0) return null;
  const good: Exposure = comfort === 'sun' ? 'sun' : 'shade';

  // 1. Zmiana zalecanej strony ulicy.
  const side = segments[current].side;
  if (side) {
    for (let i = current + 1; i < segments.length; i++) {
      const distance = nav.ranges[i].startM - alongM;
      if (distance > HINT_LOOKAHEAD_M) break;
      const nextSide = segments[i].side;
      if (!nextSide) continue;
      if (nextSide === side) continue;
      if (distance < HINT_MIN_DISTANCE_M) break;
      const exposure = exposureOf(segments[i].sunFraction);
      const why = exposure === good ? (good === 'shade' ? ' — tam jest cień' : ' — tam jest słońce') : '';
      return {
        key: `side:${i}`,
        text: `Za ${hintDistance(distance)} przejdź na ${nextSide === 'left' ? 'lewą' : 'prawą'} stronę ulicy${why}`,
        tone: 'good',
      };
    }
  }

  // 2. Zmiana nasłonecznienia: pierwszy dłuższy fragment o innym charakterze niż miejsce, w którym jesteśmy.
  const here = exposureOf(segments[current].sunFraction);
  if (here === 'mixed') return null;
  for (let i = current + 1; i < segments.length; i++) {
    const distance = nav.ranges[i].startM - alongM;
    if (distance > HINT_LOOKAHEAD_M) break;
    const exposure = exposureOf(segments[i].sunFraction);
    if (exposure === here || exposure === 'mixed') continue;
    let runEnd = i;
    while (runEnd + 1 < segments.length && exposureOf(segments[runEnd + 1].sunFraction) === exposure) runEnd++;
    const runM = nav.ranges[runEnd].endM - nav.ranges[i].startM;
    if (runM < HINT_MIN_RUN_M) continue;
    if (distance < HINT_MIN_DISTANCE_M) return null;
    const where = hintDistance(distance);
    if (exposure === good) {
      return {
        key: `exp:${i}`,
        text: good === 'shade' ? `Za ${where} wejdziesz w cień` : `Za ${where} wyjdziesz na słońce`,
        tone: 'good',
      };
    }
    return {
      key: `exp:${i}`,
      text: `Za ${where} odcinek ${good === 'shade' ? 'w słońcu' : 'w cieniu'} (${hintDistance(runM)})`,
      tone: 'bad',
    };
  }
  return null;
}
