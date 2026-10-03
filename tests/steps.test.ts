import { describe, expect, it } from 'vitest';
import type { LonLat, RouteSegment } from '../shared/types.ts';
import { toLonLat } from '../server/geo/project.ts';
import { buildSteps, compassName, formatDistance, maneuverForAngle, streetLabel } from '../server/graph/steps.ts';

/** Odcinek trasy z punktów w metrach lokalnych; długość liczona z geometrii. */
function seg(points: [number, number][], extra: Partial<RouteSegment> = {}): RouteSegment {
  let lengthM = 0;
  for (let i = 1; i < points.length; i++) lengthM += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return {
    coords: points.map(([x, y]) => toLonLat(x, y)),
    lengthM,
    sunFraction: 0,
    lstC: null,
    kind: 'footway',
    ...extra,
  };
}

function geometryOf(segments: RouteSegment[]): LonLat[] {
  const out: LonLat[] = [];
  for (const segment of segments) {
    segment.coords.forEach((point, i) => {
      const last = out[out.length - 1];
      if (i === 0 && last && last[0] === point[0] && last[1] === point[1]) return;
      out.push(point);
    });
  }
  return out;
}

function steps(segments: RouteSegment[], shadeInfo = true) {
  return buildSteps(segments, geometryOf(segments), { shadeInfo });
}

describe('funkcje pomocnicze instrukcji', () => {
  it('rodzaj manewru z kąta (dodatni = w prawo)', () => {
    expect(maneuverForAngle(0)).toBe('continue');
    expect(maneuverForAngle(-20)).toBe('continue');
    expect(maneuverForAngle(35)).toBe('slight_right');
    expect(maneuverForAngle(-35)).toBe('slight_left');
    expect(maneuverForAngle(90)).toBe('right');
    expect(maneuverForAngle(-90)).toBe('left');
    expect(maneuverForAngle(140)).toBe('sharp_right');
    expect(maneuverForAngle(-150)).toBe('sharp_left');
    expect(maneuverForAngle(175)).toBe('uturn');
    expect(maneuverForAngle(-180)).toBe('uturn');
  });

  it('strony świata', () => {
    expect(compassName(0)).toBe('północ');
    expect(compassName(44)).toBe('północny wschód');
    expect(compassName(90)).toBe('wschód');
    expect(compassName(-90)).toBe('zachód');
    expect(compassName(220)).toBe('południowy zachód');
    expect(compassName(359)).toBe('północ');
  });

  it('nazwy ulic zostają w mianowniku; „ul.” tylko tam, gdzie nazwa sama nie mówi, czym jest', () => {
    expect(streetLabel('Karmelicka')).toBe('ul. Karmelicka');
    expect(streetLabel('Aleja Adama Mickiewicza')).toBe('Aleja Adama Mickiewicza');
    expect(streetLabel('Rynek Główny')).toBe('Rynek Główny');
    expect(streetLabel('Planty')).toBe('Planty');
    expect(streetLabel('plac Szczepański')).toBe('plac Szczepański');
    expect(streetLabel('Parkowa')).toBe('ul. Parkowa');
  });

  it('odległości: metry zaokrąglone do 10, kilometry z przecinkiem', () => {
    expect(formatDistance(7.4)).toBe('7 m');
    expect(formatDistance(0.2)).toBe('1 m');
    expect(formatDistance(244)).toBe('240 m');
    expect(formatDistance(996)).toBe('1,0 km');
    expect(formatDistance(1240)).toBe('1,2 km');
  });
});

describe('buildSteps', () => {
  it('trasa bez odcinków to samo „u celu”', () => {
    const geometry: LonLat[] = [toLonLat(0, 0), toLonLat(0, 0)];
    const result = buildSteps([], geometry);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ maneuver: 'arrive', distanceM: 0, geometryIndex: 1, text: 'Jesteś u celu.' });
  });

  it('ruszaj → skręt w nazwaną ulicę → cel, ze stroną ulicy i informacją o cieniu', () => {
    const segments = [
      seg([[0, 0], [0, 60]], { kind: 'street', name: 'Karmelicka', side: 'left', sunFraction: 0 }),
      seg([[0, 60], [0, 120]], { kind: 'street', name: 'Karmelicka', side: 'left', sunFraction: 0.2 }),
      seg([[0, 120], [0, 240]], { kind: 'street', name: 'Karmelicka', side: 'left', sunFraction: 0.1 }),
      seg([[0, 240], [60, 240]], { kind: 'street', name: 'Aleja Adama Mickiewicza', side: 'right', sunFraction: 1 }),
      seg([[60, 240], [100, 240]], { kind: 'street', name: 'Aleja Adama Mickiewicza', side: 'right', sunFraction: 0.9 }),
    ];
    const result = steps(segments);
    expect(result.map((s) => s.maneuver)).toEqual(['depart', 'right', 'arrive']);
    expect(result[0].text).toBe('Ruszaj na północ — ul. Karmelicka. Idź 240 m lewą stroną ulicy — w cieniu.');
    expect(result[0].distanceM).toBeCloseTo(240, 6);
    expect(result[0].geometryIndex).toBe(0);
    expect(result[0].sunFraction).toBeCloseTo((0.2 * 60 + 0.1 * 120) / 240, 6);
    expect(result[1].text).toBe('Skręć w prawo — Aleja Adama Mickiewicza. Idź 100 m prawą stroną ulicy — w słońcu.');
    expect(result[1].geometryIndex).toBe(3);
    expect(result[1].location).toEqual(toLonLat(0, 240));
    expect(result[1].sunFraction).toBeCloseTo(0.96, 6);
    expect(result[2]).toMatchObject({ maneuver: 'arrive', geometryIndex: 5, distanceM: 0 });
    expect(result[2].location).toEqual(toLonLat(100, 240));
  });

  it('suma długości kroków równa się długości trasy, a punkty kroków leżą na geometrii', () => {
    const segments = [
      seg([[0, 0], [40, 40]], { name: 'Długa' }),
      seg([[40, 40], [40, 48]], { kind: 'crossing', signals: true }),
      seg([[40, 48], [-20, 48]], { kind: 'path' }),
      seg([[-20, 48], [-20, 60]], { kind: 'steps' }),
      seg([[-20, 60], [-20, 160]], { kind: 'pedestrian', name: 'Rynek Główny' }),
    ];
    const geometry = geometryOf(segments);
    const result = buildSteps(segments, geometry);
    const total = segments.reduce((sum, s) => sum + s.lengthM, 0);
    expect(result.reduce((sum, s) => sum + s.distanceM, 0)).toBeCloseTo(total, 6);
    for (const step of result) expect(geometry[step.geometryIndex]).toEqual(step.location);
    expect(result.map((s) => s.maneuver)).toEqual(['depart', 'cross', 'left', 'stairs', 'continue', 'arrive']);
    expect(result[0].text).toBe('Ruszaj na północny wschód — ul. Długa. Idź 60 m — w cieniu.');
    expect(result[1].text).toBe('Odbij lekko w lewo i przejdź przez przejście ze światłami.');
    expect(result[2].text).toBe('Skręć w lewo na ścieżkę. Idź 60 m — w cieniu.');
    expect(result[3].text).toBe('Skręć w prawo i pokonaj schody (12 m).');
    expect(result[4].text).toBe('Dalej prosto — Rynek Główny. Idź 100 m — w cieniu.');
  });

  it('przejście bez świateł i bez skrętu', () => {
    const result = steps([
      seg([[0, 0], [0, 50]], { kind: 'sidewalk' }),
      seg([[0, 50], [0, 60]], { kind: 'crossing', signals: false }),
      seg([[0, 60], [0, 90]], { kind: 'sidewalk' }),
    ]);
    expect(result.map((s) => s.maneuver)).toEqual(['depart', 'cross', 'continue', 'arrive']);
    expect(result[0].text).toBe('Ruszaj na północ chodnikiem. Idź 50 m — w cieniu.');
    expect(result[1].text).toBe('Przejdź przez przejście dla pieszych.');
    expect(result[2].text).toBe('Dalej prosto chodnikiem. Idź 30 m — w cieniu.');
  });

  it('drobne załamania linii nie tworzą skrętów, wyraźny zakręt tej samej ścieżki — tak', () => {
    // Zygzak ±1 m co 10 m na 120 m ścieżki: jeden krok.
    const wiggle: [number, number][] = [];
    for (let i = 0; i <= 12; i++) wiggle.push([i % 2 === 0 ? 0 : 1, i * 10]);
    const straight = steps([seg(wiggle, { kind: 'path' })]);
    expect(straight.map((s) => s.maneuver)).toEqual(['depart', 'arrive']);

    // Ta sama ścieżka skręca o 90° w lewo po 80 m.
    const bend = steps([seg([[0, 0], [0, 40], [0, 80], [-40, 80], [-90, 80]], { kind: 'path' })]);
    expect(bend.map((s) => s.maneuver)).toEqual(['depart', 'left', 'arrive']);
    expect(bend[0].distanceM).toBeCloseTo(80, 6);
    expect(bend[1].distanceM).toBeCloseTo(90, 6);
    expect(bend[1].text).toBe('Skręć w lewo. Idź 90 m — w cieniu.');
    expect(bend[1].geometryIndex).toBe(2);
    expect(bend[1].location).toEqual(toLonLat(0, 80));
  });

  it('łagodny łuk nie jest skrętem', () => {
    // Ćwierć okręgu o promieniu 60 m, punkty co 10°.
    const arc: [number, number][] = [];
    for (let deg = 0; deg <= 90; deg += 10) arc.push([60 - 60 * Math.cos((deg * Math.PI) / 180), 60 * Math.sin((deg * Math.PI) / 180)]);
    expect(steps([seg(arc, { kind: 'path' })]).map((s) => s.maneuver)).toEqual(['depart', 'arrive']);
  });

  it('krótki łącznik jest doklejany do sąsiedniego kroku, a rozdzielone nim części tej samej ulicy scalane', () => {
    const result = steps([
      seg([[0, 0], [0, 100]], { name: 'Floriańska', kind: 'pedestrian' }),
      seg([[0, 100], [0, 104]], { kind: 'footway' }),
      seg([[0, 104], [0, 200]], { name: 'Floriańska', kind: 'pedestrian' }),
    ]);
    expect(result.map((s) => s.maneuver)).toEqual(['depart', 'arrive']);
    expect(result[0].distanceM).toBeCloseTo(200, 6);
    expect(result[0].text).toBe('Ruszaj na północ — ul. Floriańska. Idź 200 m — w cieniu.');
  });

  it('zmiana strony tej samej ulicy to osobny krok', () => {
    const result = steps([
      seg([[-6, 0], [-6, 100]], { kind: 'street', name: 'Aleja Testowa', side: 'left', sunFraction: 0 }),
      seg([[-6, 100], [6, 100], [6, 200]], { kind: 'street', name: 'Aleja Testowa', side: 'right', sunFraction: 0.5 }),
    ]);
    expect(result).toHaveLength(3);
    expect(result[1].text).toMatch(/prawą stroną ulicy — częściowo w cieniu\.$/);
    expect(result[1].location).toEqual(toLonLat(-6, 100));
  });

  it('bez informacji o cieniu (noc) instrukcje nie wspominają o słońcu', () => {
    const result = steps([seg([[0, 0], [0, 100]], { name: 'Karmelicka', sunFraction: 0 })], false);
    expect(result[0].text).toBe('Ruszaj na północ — ul. Karmelicka. Idź 100 m.');
  });

  it('zawracanie i ostry skręt', () => {
    const back = steps([
      seg([[0, 0], [0, 100]], { name: 'Pierwsza' }),
      seg([[0, 100], [0, 20]], { name: 'Druga' }),
    ]);
    expect(back[1].maneuver).toBe('uturn');
    expect(back[1].text).toBe('Zawróć — ul. Druga. Idź 80 m — w cieniu.');
    const sharp = steps([
      seg([[0, 0], [0, 100]], { name: 'Pierwsza' }),
      seg([[0, 100], [40, 40]], { kind: 'path' }),
    ]);
    expect(sharp[1].maneuver).toBe('sharp_right');
    expect(sharp[1].text).toMatch(/^Skręć ostro w prawo na ścieżkę\./);
  });

  it('startIndexes pozwala wskazać indeksy w geometrii trasy niezależnie od liczby punktów odcinków', () => {
    const segments = [seg([[0, 0], [0, 100]], { name: 'A' }), seg([[0, 100], [80, 100]], { name: 'B' })];
    const geometry = geometryOf(segments);
    const result = buildSteps(segments, geometry, { startIndexes: [0, 1] });
    expect(result.map((s) => s.geometryIndex)).toEqual([0, 1, 2]);
  });
});
