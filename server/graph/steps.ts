// Nawigacja „krok po kroku”: zamienia ciąg odcinków trasy (RouteSegment[]) na instrukcje po polsku.
//
// Odcinki są grupowane w kroki (ta sama ulica i strona / przejście / schody), długie grupy są dzielone
// w miejscach wyraźnych skrętów, a manewr wynika ze zmiany kierunku marszu mierzonej na ok. 12 m przed
// i za punktem (drobne załamania linii nie tworzą skrętów). Nazwy ulic zostają w mianowniku, tak jak w OSM
// („Skręć w lewo — ul. Karmelicka”), bez prób odmiany.

import type { LonLat, ManeuverType, RouteSegment, RouteStep, SegmentKind } from '../../shared/types.ts';
import { toXY } from '../geo/project.ts';

export interface StepsOptions {
  /** Indeks w RouteResult.geometry pierwszego punktu każdego odcinka; domyślnie wynika z liczby punktów odcinków. */
  startIndexes?: number[];
  /** false = bez dopisków o cieniu (noc, brak bezpośredniego słońca). Domyślnie true. */
  shadeInfo?: boolean;
}

/** Okno (m), na którym mierzony jest kierunek przed i za punktem manewru. */
const BEARING_WINDOW_M = 12;
/** Grupy „zwykłego marszu” krótsze niż tyle są doklejane do sąsiada (łączniki przy przejściach itp.). */
const TINY_GROUP_M = 8;
/** Skręt wewnątrz jednej drogi tworzy osobny krok dopiero od takiego kąta… */
const INNER_TURN_DEG = 50;
/** …i nie bliżej niż tyle metrów od początku/końca kroku ani od poprzedniego skrętu. */
const INNER_TURN_SPACING_M = 15;
const SLIGHT_DEG = 25;
const NORMAL_DEG = 50;
const SHARP_DEG = 125;
const UTURN_DEG = 165;
const DEPART_WINDOW_M = 25;

const COMPASS = [
  'północ', 'północny wschód', 'wschód', 'południowy wschód',
  'południe', 'południowy zachód', 'zachód', 'północny zachód',
];

/** Nazwy, które same mówią, czym są (aleja, plac, park…) — nie dostają przedrostka „ul.”. */
const SELF_DESCRIBING_NAME =
  /^(ul\.|ulica|al\.|aleja|aleje|plac|pl\.|rynek|mały rynek|rondo|most|bulwar|bulwary|osiedle|os\.|planty|park|skwer|droga|pasaż|kładka|estakada|trakt|ścieżka|wybrzeże|zaułek|dziedziniec|ogród|błonia|tunel|przejście)(\s|$)/i;

const KIND_INSTRUMENTAL: Record<SegmentKind, string> = {
  sidewalk: 'chodnikiem',
  footway: 'chodnikiem',
  path: 'ścieżką',
  pedestrian: 'deptakiem',
  street: 'ulicą',
  cycleway: 'drogą dla rowerów',
  covered: 'zadaszonym przejściem',
  crossing: 'przejściem',
  steps: 'schodami',
};

const KIND_ACCUSATIVE: Record<SegmentKind, string> = {
  sidewalk: 'na chodnik',
  footway: 'na chodnik',
  path: 'na ścieżkę',
  pedestrian: 'na deptak',
  street: 'w ulicę',
  cycleway: 'na drogę dla rowerów',
  covered: 'w zadaszone przejście',
  crossing: 'na przejście',
  steps: 'na schody',
};

const TURN_PHRASE: Partial<Record<ManeuverType, string>> = {
  slight_left: 'Odbij lekko w lewo',
  left: 'Skręć w lewo',
  sharp_left: 'Skręć ostro w lewo',
  slight_right: 'Odbij lekko w prawo',
  right: 'Skręć w prawo',
  sharp_right: 'Skręć ostro w prawo',
  uturn: 'Zawróć',
};

export function streetLabel(name: string): string {
  return SELF_DESCRIBING_NAME.test(name) ? name : `ul. ${name}`;
}

export function formatDistance(meters: number): string {
  if (meters >= 995) return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
  if (meters < 15) return `${Math.max(1, Math.round(meters))} m`;
  return `${Math.round(meters / 10) * 10} m`;
}

/** Kierunek świata (8 stron) dla namiaru w stopniach (0 = północ, zgodnie z zegarem). */
export function compassName(bearingDeg: number): string {
  return COMPASS[((Math.round(bearingDeg / 45) % 8) + 8) % 8];
}

/** Rodzaj manewru dla zmiany kierunku w stopniach (dodatnia = w prawo). */
export function maneuverForAngle(angleDeg: number): ManeuverType {
  const abs = Math.abs(angleDeg);
  if (abs < SLIGHT_DEG) return 'continue';
  if (abs >= UTURN_DEG) return 'uturn';
  const dir = angleDeg > 0 ? 'right' : 'left';
  if (abs < NORMAL_DEG) return `slight_${dir}`;
  if (abs < SHARP_DEG) return dir;
  return `sharp_${dir}`;
}

function shadePhrase(sunFraction: number): string {
  if (sunFraction < 0.25) return ' — w cieniu';
  if (sunFraction <= 0.6) return ' — częściowo w cieniu';
  return ' — w słońcu';
}

type GroupType = 'walk' | 'cross' | 'stairs';

interface Group {
  type: GroupType;
  /** Zakres punktów trasy [from, to] (indeksy we wspólnej polilinii). */
  from: number;
  to: number;
  name?: string;
  side?: 'left' | 'right';
  /** true, gdy krok kontynuuje tę samą drogę co poprzedni (podział na skręcie albo zmiana strony). */
  sameWay?: boolean;
  sideChanged?: boolean;
}

function groupType(kind: SegmentKind): GroupType {
  if (kind === 'crossing') return 'cross';
  if (kind === 'steps') return 'stairs';
  return 'walk';
}

/** Buduje instrukcje dla trasy. `geometry` służy tylko do wskazania punktu, gdy trasa nie ma odcinków. */
export function buildSteps(segments: RouteSegment[], geometry: LonLat[], opts: StepsOptions = {}): RouteStep[] {
  const shadeInfo = opts.shadeInfo ?? true;
  const lastGeometryIndex = Math.max(0, geometry.length - 1);
  if (segments.length === 0) {
    const location = geometry[lastGeometryIndex] ?? [0, 0];
    return [{ maneuver: 'arrive', text: 'Jesteś u celu.', distanceM: 0, geometryIndex: lastGeometryIndex, location, sunFraction: 0 }];
  }

  // Wspólna polilinia trasy (metry lokalne) i położenie odcinków na niej.
  const px: number[] = [];
  const py: number[] = [];
  const lonLat: LonLat[] = [];
  const segFrom: number[] = [];
  const segTo: number[] = [];
  for (const segment of segments) {
    let first = true;
    for (const point of segment.coords) {
      const [x, y] = toXY(point[1], point[0]);
      const n = px.length;
      if (first && n > 0 && px[n - 1] === x && py[n - 1] === y) {
        segFrom.push(n - 1);
      } else {
        if (first) segFrom.push(n);
        px.push(x);
        py.push(y);
        lonLat.push(point);
      }
      first = false;
    }
    segTo.push(px.length - 1);
  }
  const pointCount = px.length;
  const cum = new Float64Array(pointCount);
  for (let i = 1; i < pointCount; i++) cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
  const totalGeomM = cum[pointCount - 1];

  /** Indeks punktu polilinii → indeks w RouteResult.geometry. */
  const geometryIndexOf = (p: number): number => {
    if (!opts.startIndexes) return Math.min(p, lastGeometryIndex);
    let s = 0;
    while (s + 1 < segments.length && segFrom[s + 1] <= p) s++;
    return Math.min(lastGeometryIndex, (opts.startIndexes[s] ?? segFrom[s]) + (p - segFrom[s]));
  };

  const pointAlong = (distanceM: number): [number, number] => {
    const d = Math.min(totalGeomM, Math.max(0, distanceM));
    let lo = 0;
    let hi = pointCount - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const t = span > 0 ? (d - cum[lo]) / span : 0;
    return [px[lo] + (px[hi] - px[lo]) * t, py[lo] + (py[hi] - py[lo]) * t];
  };

  /** Namiar (stopnie, 0 = północ) odcinka trasy między dwiema odległościami; null, gdy punkty się pokrywają. */
  const bearingBetween = (fromM: number, toM: number): number | null => {
    const [ax, ay] = pointAlong(fromM);
    const [bx, by] = pointAlong(toM);
    if (Math.hypot(bx - ax, by - ay) < 0.05) return null;
    return (Math.atan2(bx - ax, by - ay) * 180) / Math.PI;
  };

  /** Zmiana kierunku w punkcie p: dodatnia = w prawo. Okna ograniczone do [minM, maxM]. */
  const turnAt = (p: number, minM: number, maxM: number): number => {
    const before = bearingBetween(Math.max(minM, cum[p] - BEARING_WINDOW_M), cum[p]);
    const after = bearingBetween(cum[p], Math.min(maxM, cum[p] + BEARING_WINDOW_M));
    if (before === null || after === null) return 0;
    let angle = after - before;
    while (angle > 180) angle -= 360;
    while (angle <= -180) angle += 360;
    return angle;
  };

  /** Długość (po osi drogi) i metry w słońcu dla zakresu punktów — z odcinków, proporcjonalnie do pokrycia. */
  const rangeStats = (from: number, to: number): { lengthM: number; sunM: number; kind: SegmentKind; signals: boolean } => {
    let lengthM = 0;
    let sunM = 0;
    let signals = false;
    const byKind = new Map<SegmentKind, number>();
    for (let s = 0; s < segments.length; s++) {
      if (segTo[s] < from || segFrom[s] > to) continue;
      const a = Math.max(cum[from], cum[segFrom[s]]);
      const b = Math.min(cum[to], cum[segTo[s]]);
      const geomM = cum[segTo[s]] - cum[segFrom[s]];
      let fraction: number;
      if (geomM > 0) fraction = Math.max(0, b - a) / geomM;
      else fraction = segFrom[s] >= from && segTo[s] <= to ? 1 : 0;
      if (fraction <= 0) continue;
      const part = segments[s].lengthM * fraction;
      lengthM += part;
      sunM += part * segments[s].sunFraction;
      byKind.set(segments[s].kind, (byKind.get(segments[s].kind) ?? 0) + part);
      if (segments[s].signals) signals = true;
    }
    let kind: SegmentKind = segments[0].kind;
    let best = -1;
    for (const [k, len] of byKind) {
      if (len > best) {
        best = len;
        kind = k;
      }
    }
    return { lengthM, sunM, kind, signals };
  };

  // 1. Grupy kolejnych odcinków tej samej drogi (nazwa + strona), przejść i schodów.
  let groups: Group[] = [];
  segments.forEach((segment, s) => {
    const type = groupType(segment.kind);
    const last = groups[groups.length - 1];
    if (last && last.type === type && (type !== 'walk' || (last.name === segment.name && last.side === segment.side))) {
      last.to = segTo[s];
    } else {
      groups.push({ type, from: segFrom[s], to: segTo[s], name: segment.name, side: segment.side });
    }
  });

  // 2. Krótkie łączniki doklejamy do sąsiedniego kroku marszu, a rozdzielone nimi części tej samej drogi scalamy.
  const merged: Group[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const prev = merged[merged.length - 1];
    const tiny = group.type === 'walk' && cum[group.to] - cum[group.from] < TINY_GROUP_M && groups.length > 1;
    if (tiny && prev && prev.type === 'walk') {
      prev.to = group.to;
    } else if (tiny && groups[i + 1]?.type === 'walk') {
      groups[i + 1].from = group.from;
    } else if (prev && prev.type === 'walk' && group.type === 'walk' && prev.name === group.name && prev.side === group.side) {
      prev.to = group.to;
    } else {
      merged.push({ ...group });
    }
  }
  groups = merged;

  // 3. Podział kroków marszu w miejscach wyraźnych skrętów oraz oznaczenie zmiany strony tej samej ulicy.
  const parts: Group[] = [];
  for (const group of groups) {
    const prev = parts[parts.length - 1];
    const continuesStreet = prev !== undefined && prev.type === 'walk' && group.type === 'walk' && group.name !== undefined && prev.name === group.name;
    const base: Group = { ...group, sameWay: continuesStreet, sideChanged: continuesStreet && prev.side !== group.side };
    if (group.type !== 'walk') {
      parts.push(base);
      continue;
    }
    const startM = cum[group.from];
    const endM = cum[group.to];
    const cuts: number[] = [];
    let lastCutM = startM;
    let p = group.from + 1;
    while (p < group.to) {
      if (cum[p] - lastCutM < INNER_TURN_SPACING_M || endM - cum[p] < INNER_TURN_SPACING_M) {
        p++;
        continue;
      }
      if (Math.abs(turnAt(p, startM, endM)) < INNER_TURN_DEG) {
        p++;
        continue;
      }
      // Ze skupiska kandydatów (kolejne punkty łuku) zostaje ten o największym kącie.
      let best = p;
      let q = p + 1;
      while (q < group.to && cum[q] - cum[p] < INNER_TURN_SPACING_M) {
        if (endM - cum[q] >= INNER_TURN_SPACING_M && Math.abs(turnAt(q, startM, endM)) > Math.abs(turnAt(best, startM, endM))) best = q;
        q++;
      }
      cuts.push(best);
      lastCutM = cum[best];
      p = q;
    }
    let from = group.from;
    cuts.forEach((cut, k) => {
      parts.push(k === 0 ? { ...base, from, to: cut } : { ...group, from, to: cut, sameWay: true });
      from = cut;
    });
    parts.push(cuts.length === 0 ? base : { ...group, from, to: group.to, sameWay: true });
  }

  // 4. Instrukcje.
  const steps: RouteStep[] = [];
  parts.forEach((part, index) => {
    const stats = rangeStats(part.from, part.to);
    const sunFraction = stats.lengthM > 0 ? Math.min(1, Math.max(0, stats.sunM / stats.lengthM)) : 0;
    const prev = parts[index - 1];
    const angle = prev ? turnAt(part.from, cum[prev.from], cum[part.to]) : 0;
    const turn = maneuverForAngle(angle);
    const turnPhrase = TURN_PHRASE[turn];

    let maneuver: ManeuverType;
    let text: string;
    if (part.type === 'cross') {
      maneuver = 'cross';
      const crossing = stats.signals ? 'przejście ze światłami' : 'przejście dla pieszych';
      text = turnPhrase && turn !== 'uturn' ? `${turnPhrase} i przejdź przez ${crossing}.` : `Przejdź przez ${crossing}.`;
    } else if (part.type === 'stairs') {
      maneuver = 'stairs';
      const stairs = `schody (${formatDistance(stats.lengthM)})`;
      text = turnPhrase && turn !== 'uturn' ? `${turnPhrase} i pokonaj ${stairs}.` : `Pokonaj ${stairs}.`;
    } else {
      const named = part.name !== undefined;
      const sideText = part.side ? ` ${part.side === 'left' ? 'lewą' : 'prawą'} stroną ulicy` : '';
      const walk = `Idź ${formatDistance(stats.lengthM)}${sideText}${shadeInfo ? shadePhrase(sunFraction) : ''}.`;
      let lead: string;
      if (index === 0) {
        maneuver = 'depart';
        const bearing = bearingBetween(cum[part.from], Math.min(cum[part.to], cum[part.from] + DEPART_WINDOW_M));
        const direction = bearing === null ? '' : ` na ${compassName(bearing)}`;
        lead = named ? `Ruszaj${direction} — ${streetLabel(part.name!)}.` : `Ruszaj${direction} ${KIND_INSTRUMENTAL[stats.kind]}.`;
      } else {
        maneuver = turn;
        if (part.sideChanged && part.side && turn === 'continue') {
          lead = `Przejdź na ${part.side === 'left' ? 'lewą' : 'prawą'} stronę ulicy.`;
        } else if (part.sameWay) {
          lead = `${turnPhrase ?? 'Dalej prosto'}.`;
        } else if (named) {
          lead = `${turnPhrase ?? 'Dalej prosto'} — ${streetLabel(part.name!)}.`;
        } else if (turnPhrase && turn !== 'uturn') {
          lead = `${turnPhrase} ${KIND_ACCUSATIVE[stats.kind]}.`;
        } else {
          lead = `${turnPhrase ?? 'Dalej prosto'} ${KIND_INSTRUMENTAL[stats.kind]}.`;
        }
      }
      text = `${lead} ${walk}`;
    }

    steps.push({
      maneuver,
      text,
      distanceM: stats.lengthM,
      geometryIndex: geometryIndexOf(part.from),
      location: lonLat[part.from],
      sunFraction,
    });
  });

  steps.push({
    maneuver: 'arrive',
    text: 'Jesteś u celu.',
    distanceM: 0,
    geometryIndex: geometryIndexOf(pointCount - 1),
    location: lonLat[pointCount - 1],
    sunFraction: 0,
  });
  return steps;
}
