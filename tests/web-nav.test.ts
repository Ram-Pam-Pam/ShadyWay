// Geometria i logika nawigacji krok po kroku (web/src/nav/progress.ts) oraz teksty dla syntezatora mowy.

import { describe, expect, it } from 'vitest';
import type { LonLat, RouteResult, RouteSegment, RouteStep } from '../shared/types.ts';
import {
  ARRIVAL_RADIUS_M,
  OFF_ROUTE_FIXES,
  buildRouteIndex,
  distanceM,
  dueAnnouncement,
  hasArrived,
  navProgress,
  pointAlong,
  prepareRoute,
  segmentRanges,
  shadeHint,
  snapToRoute,
  splitInstruction,
  spokenDistance,
  stepIndexAt,
  stepStarts,
  trackOffRoute,
} from '../web/src/nav/progress.ts';
import { toSpeech } from '../web/src/nav/speech.ts';

const LAT0 = 50.06;
const LON0 = 19.93;
const M_LAT = 110_540;
const M_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** Punkt o przesunięciu (wschód, północ) w metrach od początku układu testowego. */
function at(eastM: number, northM: number): LonLat {
  return [LON0 + eastM / M_LON, LAT0 + northM / M_LAT];
}

function pos(eastM: number, northM: number): { lat: number; lon: number } {
  const [lon, lat] = at(eastM, northM);
  return { lat, lon };
}

// Trasa w kształcie litery L: 200 m na wschód, potem 100 m na północ.
const L_GEOMETRY: LonLat[] = [at(0, 0), at(100, 0), at(200, 0), at(200, 100)];

function segment(coords: LonLat[], lengthM: number, sunFraction: number, extra: Partial<RouteSegment> = {}): RouteSegment {
  return { coords, lengthM, sunFraction, lstC: null, kind: 'sidewalk', ...extra };
}

function step(maneuver: RouteStep['maneuver'], text: string, geometryIndex: number, distance: number): RouteStep {
  return { maneuver, text, distanceM: distance, geometryIndex, location: L_GEOMETRY[geometryIndex], sunFraction: 0.5 };
}

function route(segments: RouteSegment[], steps: RouteStep[] = []): RouteResult {
  return {
    profile: 'balanced',
    label: 'Zbalansowana',
    distanceM: 300,
    durationS: 300,
    sunDistanceM: 150,
    shadeFraction: 0.5,
    meanLstC: null,
    geometry: L_GEOMETRY,
    segments,
    steps,
    waitS: 0,
    signalCrossings: 0,
    stairsCount: 0,
    thermal: { feltSunC: null, feltShadeC: null, feltMeanC: null, stress: null },
    coolSpots: [],
  };
}

const STEPS: RouteStep[] = [
  step('depart', 'Ruszaj na wschód — ul. Karmelicka. Idź 200 m prawą stroną ulicy (w słońcu).', 0, 200),
  step('left', 'Skręć w lewo — ul. Szewska. Idź 100 m (w cieniu).', 2, 100),
  step('arrive', 'Jesteś u celu.', 3, 0),
];

const L_ROUTE = route(
  [
    segment([L_GEOMETRY[0], L_GEOMETRY[1]], 100, 0.9),
    segment([L_GEOMETRY[1], L_GEOMETRY[2]], 100, 0.9),
    segment([L_GEOMETRY[2], L_GEOMETRY[3]], 100, 0.1),
  ],
  STEPS,
);

describe('buildRouteIndex / snapToRoute', () => {
  const index = buildRouteIndex(L_GEOMETRY);

  it('liczy długość narastająco w metrach', () => {
    expect(index.totalM).toBeCloseTo(300, 0);
    expect(index.cum[2]).toBeCloseTo(200, 0);
  });

  it('dociąga punkt obok trasy do najbliższego miejsca na linii', () => {
    const snap = snapToRoute(index, pos(50, 12))!;
    expect(snap.alongM).toBeCloseTo(50, 0);
    expect(snap.offsetM).toBeCloseTo(12, 0);
    expect(snap.segment).toBe(0);
    expect(snap.bearingDeg).toBeCloseTo(90, 0);
    expect(distanceM({ lon: snap.point[0], lat: snap.point[1] }, pos(50, 0))).toBeLessThan(0.5);
  });

  it('obsługuje punkt przed startem i za końcem (przycięcie do końców linii)', () => {
    expect(snapToRoute(index, pos(-30, 0))!.alongM).toBeCloseTo(0, 5);
    const beyond = snapToRoute(index, pos(200, 140))!;
    expect(beyond.alongM).toBeCloseTo(300, 0);
    expect(beyond.offsetM).toBeCloseTo(40, 0);
    expect(beyond.bearingDeg).toBeCloseTo(0, 0);
  });

  it('zwraca null dla trasy bez odcinków', () => {
    expect(snapToRoute(buildRouteIndex([at(0, 0)]), pos(0, 0))).toBeNull();
    expect(snapToRoute(buildRouteIndex([]), pos(0, 0))).toBeNull();
  });

  it('z podpowiedzią postępu wybiera właściwy przebieg na trasie, która wraca tą samą ulicą', () => {
    // Tam i z powrotem: 0 → 200 m na wschód → powrót do 0 równoległym chodnikiem 6 m obok.
    const loop = buildRouteIndex([at(0, 0), at(200, 0), at(200, 6), at(0, 6)]);
    const place = pos(100, 4); // bliżej chodnika powrotnego (2 m) niż pierwszego (4 m)
    expect(snapToRoute(loop, place)!.alongM).toBeGreaterThan(200);
    expect(snapToRoute(loop, place, { hintAlongM: 90 })!.alongM).toBeCloseTo(100, 0);
    expect(snapToRoute(loop, place, { hintAlongM: 300 })!.alongM).toBeCloseTo(306, 0);
  });

  it('podpowiedź nie trzyma pozycji przy starym miejscu, gdy pieszy jest wyraźnie gdzie indziej', () => {
    const snap = snapToRoute(index, pos(200, 90), { hintAlongM: 20 })!;
    expect(snap.alongM).toBeCloseTo(290, 0);
    expect(snap.offsetM).toBeLessThan(1);
  });

  it('pointAlong zwraca punkt i kierunek marszu', () => {
    const middle = pointAlong(index, 250)!;
    expect(distanceM({ lon: middle.point[0], lat: middle.point[1] }, pos(200, 50))).toBeLessThan(0.5);
    expect(middle.bearingDeg).toBeCloseTo(0, 0);
    expect(pointAlong(index, -10)!.bearingDeg).toBeCloseTo(90, 0);
    const end = pointAlong(index, 9999)!;
    expect(distanceM({ lon: end.point[0], lat: end.point[1] }, pos(200, 100))).toBeLessThan(0.5);
  });
});

describe('kroki i postęp', () => {
  const nav = prepareRoute(L_ROUTE);

  it('wyznacza początek każdego kroku wzdłuż trasy', () => {
    expect(nav.starts.map(Math.round)).toEqual([0, 200, 300]);
    // Indeks spoza geometrii jest przycinany, a kolejność niemalejąca.
    expect(stepStarts(nav.index, [{ geometryIndex: 2 }, { geometryIndex: 1 }, { geometryIndex: 99 }]).map(Math.round)).toEqual([200, 200, 300]);
  });

  it('wskazuje bieżący krok; krok „arrive” nie staje się bieżący', () => {
    expect(stepIndexAt(nav.starts, 0)).toBe(0);
    expect(stepIndexAt(nav.starts, 150)).toBe(0);
    expect(stepIndexAt(nav.starts, 199)).toBe(1); // 2 m tolerancji przed manewrem
    expect(stepIndexAt(nav.starts, 250)).toBe(1);
    expect(stepIndexAt(nav.starts, 300)).toBe(1);
    expect(stepIndexAt([], 10)).toBe(-1);
  });

  it('liczy dystans do manewru, pozostałą drogę, czas i cień przed pieszym', () => {
    const progress = navProgress(nav, 150);
    expect(progress.stepIndex).toBe(0);
    expect(progress.nextStepIndex).toBe(1);
    expect(progress.distanceToNextM).toBeCloseTo(50, 0);
    expect(progress.remainingM).toBeCloseTo(150, 0);
    expect(progress.remainingS).toBeCloseTo(150, 0);
    // Przed pieszym: 50 m przy słońcu 0.9 i 100 m przy słońcu 0.1 → cień (5 + 90) / 150.
    expect(progress.shadeAhead).toBeCloseTo(95 / 150, 2);
  });

  it('na ostatnim kroku następnym manewrem jest dotarcie', () => {
    const progress = navProgress(nav, 260);
    expect(progress.stepIndex).toBe(1);
    expect(progress.nextStepIndex).toBe(2);
    expect(progress.distanceToNextM).toBeCloseTo(40, 0);
    expect(navProgress(nav, 300).shadeAhead).toBeNull();
  });

  it('działa dla trasy bez kroków (starszy serwer)', () => {
    const plain = prepareRoute({ ...L_ROUTE, steps: undefined as unknown as RouteStep[] });
    const progress = navProgress(plain, 100);
    expect(progress.stepIndex).toBe(-1);
    expect(progress.nextStepIndex).toBe(-1);
    expect(progress.distanceToNextM).toBeCloseTo(200, 0);
  });

  it('skaluje długości odcinków do długości geometrii', () => {
    const ranges = segmentRanges({ segments: [segment([], 50, 0), segment([], 150, 1)] }, 400);
    expect(ranges).toEqual([
      { startM: 0, endM: 100 },
      { startM: 100, endM: 400 },
    ]);
  });
});

describe('zejście z trasy i dotarcie', () => {
  it('zgłasza zejście dopiero po kilku kolejnych odczytach poza trasą', () => {
    let strikes = 0;
    for (let i = 1; i < OFF_ROUTE_FIXES; i++) {
      const result = trackOffRoute(strikes, 50, 10);
      expect(result.offRoute).toBe(false);
      strikes = result.strikes;
    }
    expect(trackOffRoute(strikes, 50, 10)).toEqual({ strikes: OFF_ROUTE_FIXES, offRoute: true });
  });

  it('odczyt przy trasie zeruje licznik', () => {
    expect(trackOffRoute(2, 12, 10)).toEqual({ strikes: 0, offRoute: false });
    expect(trackOffRoute(2, 35, 5)).toEqual({ strikes: 0, offRoute: false }); // próg jest ostry: > 35 m
  });

  it('nie liczy odczytów, których niepewność jest większa niż odległość od trasy', () => {
    expect(trackOffRoute(1, 50, 60)).toEqual({ strikes: 0, offRoute: false });
    // Bardzo niedokładny odczyt niczego nie rozstrzyga — licznik bez zmian.
    expect(trackOffRoute(2, 400, 250)).toEqual({ strikes: 2, offRoute: false });
    expect(trackOffRoute(2, 80, null)).toEqual({ strikes: 3, offRoute: true });
  });

  it('rozpoznaje dotarcie do celu', () => {
    expect(hasArrived(ARRIVAL_RADIUS_M - 1, 4, 14)).toBe(true);
    expect(hasArrived(60, 4, 60)).toBe(false);
    // Koniec linii trasy jest blisko, ale pieszy jest daleko od trasy — to nie jest dotarcie.
    expect(hasArrived(5, 80, 80)).toBe(false);
    // Stoi przy samym celu, choć dociągnięcie do trasy wskazuje wcześniejszy fragment.
    expect(hasArrived(120, 10, 10)).toBe(true);
  });
});

describe('instrukcje i zapowiedzi', () => {
  it('dzieli instrukcję na manewr i opis marszu (kropka w „ul.” nie myli podziału)', () => {
    expect(splitInstruction('Skręć w lewo — ul. Karmelicka. Idź 240 m lewą stroną ulicy (w cieniu).')).toEqual({
      lead: 'Skręć w lewo — ul. Karmelicka.',
      rest: 'Idź 240 m lewą stroną ulicy (w cieniu).',
    });
    expect(splitInstruction('Przejdź przez przejście ze światłami.')).toEqual({ lead: 'Przejdź przez przejście ze światłami.', rest: '' });
  });

  it('podaje dystans słownie', () => {
    expect(spokenDistance(48)).toBe('50 metrów');
    expect(spokenDistance(8)).toBe('10 metrów');
    expect(spokenDistance(130)).toBe('150 metrów');
    expect(spokenDistance(1240)).toBe('1,2 kilometra');
    expect(spokenDistance(2000)).toBe('2 kilometra');
  });

  it('na starcie zapowiada pierwszą instrukcję, a każdą zapowiedź tylko raz', () => {
    const spoken = new Set<string>();
    const start = dueAnnouncement(STEPS, { stepIndex: 0, nextStepIndex: 1, distanceToNextM: 200 }, spoken)!;
    expect(start).toEqual({ key: 'start', text: STEPS[0].text });
    spoken.add(start.key);
    expect(dueAnnouncement(STEPS, { stepIndex: 0, nextStepIndex: 1, distanceToNextM: 180 }, spoken)).toBeNull();
  });

  it('zapowiada manewr z wyprzedzeniem i tuż przed nim', () => {
    const spoken = new Set<string>(['start']);
    const ahead = dueAnnouncement(STEPS, { stepIndex: 0, nextStepIndex: 1, distanceToNextM: 100 }, spoken)!;
    expect(ahead.key).toBe('ahead:1');
    expect(ahead.text).toBe('Za 100 metrów: skręć w lewo — ul. Szewska.');
    spoken.add(ahead.key);
    expect(dueAnnouncement(STEPS, { stepIndex: 0, nextStepIndex: 1, distanceToNextM: 60 }, spoken)).toBeNull();
    const now = dueAnnouncement(STEPS, { stepIndex: 0, nextStepIndex: 1, distanceToNextM: 15 }, spoken)!;
    expect(now).toEqual({ key: 'now:1', text: 'Skręć w lewo — ul. Szewska.' });
    spoken.add(now.key);
    expect(dueAnnouncement(STEPS, { stepIndex: 0, nextStepIndex: 1, distanceToNextM: 5 }, spoken)).toBeNull();
  });

  it('przed celem zapowiada odległość do celu, a samo dotarcie zostawia trybowi nawigacji', () => {
    const spoken = new Set<string>(['start']);
    expect(dueAnnouncement(STEPS, { stepIndex: 1, nextStepIndex: 2, distanceToNextM: 80 }, spoken)!.text).toBe('Za 80 metrów: cel.');
    expect(dueAnnouncement(STEPS, { stepIndex: 1, nextStepIndex: 2, distanceToNextM: 10 }, spoken)).toBeNull();
    expect(dueAnnouncement([], { stepIndex: -1, nextStepIndex: -1, distanceToNextM: 10 }, spoken)).toBeNull();
  });

  it('rozwija skróty dla syntezatora mowy', () => {
    expect(toSpeech('Skręć w lewo — ul. Karmelicka. Idź 240 m lewą stroną ulicy (w cieniu).')).toBe(
      'Skręć w lewo, ulica Karmelicka. Idź 240 metrów lewą stroną ulicy (w cieniu).',
    );
    expect(toSpeech('Idź 1,2 km al. Mickiewicza')).toBe('Idź 1,2 kilometra aleja Mickiewicza');
    expect(toSpeech('Pokonaj schody (15 m).')).toBe('Pokonaj schody (15 metrów).');
    // Litera „m” na początku słowa po liczbie nie jest jednostką.
    expect(toSpeech('Miń 3 mosty')).toBe('Miń 3 mosty');
  });
});

describe('podpowiedzi o cieniu', () => {
  const coords: LonLat[] = [L_GEOMETRY[0], L_GEOMETRY[1]];

  it('zapowiada wejście w cień, gdy pieszy idzie w słońcu', () => {
    const nav = prepareRoute(L_ROUTE);
    const tip = shadeHint(nav, 120, 'shade')!;
    expect(tip.text).toBe('Za 80 m wejdziesz w cień');
    expect(tip.tone).toBe('good');
    expect(tip.key).toBe('exp:2');
  });

  it('w trybie zimowym ta sama zmiana jest ostrzeżeniem o odcinku w cieniu', () => {
    const nav = prepareRoute(L_ROUTE);
    const tip = shadeHint(nav, 120, 'sun')!;
    expect(tip.text).toBe('Za 80 m odcinek w cieniu (100 m)');
    expect(tip.tone).toBe('bad');
  });

  it('milczy, gdy zmiana jest dalej niż ok. 150 m albo tuż przed pieszym', () => {
    const nav = prepareRoute(L_ROUTE);
    expect(shadeHint(nav, 10, 'shade')).toBeNull();
    expect(shadeHint(nav, 195, 'shade')).toBeNull();
    expect(shadeHint(nav, 250, 'shade')).toBeNull(); // do końca trasy nic się nie zmienia
  });

  it('pomija krótkie plamy słońca i odcinki mieszane', () => {
    const nav = prepareRoute(
      route([segment(coords, 100, 0.1), segment(coords, 20, 0.95), segment(coords, 80, 0.5), segment(coords, 100, 0.1)]),
    );
    expect(shadeHint(nav, 40, 'shade')).toBeNull();
  });

  it('podpowiada przejście na drugą stronę ulicy z uzasadnieniem', () => {
    const nav = prepareRoute(
      route([
        segment(coords, 100, 0.8, { kind: 'street', side: 'right' }),
        segment(coords, 100, 0.1, { kind: 'street', side: 'left' }),
        segment(coords, 100, 0.1),
      ]),
    );
    const tip = shadeHint(nav, 50, 'shade')!;
    expect(tip.text).toBe('Za 50 m przejdź na lewą stronę ulicy — tam jest cień');
    expect(tip.key).toBe('side:1');
    // Po zmianie strony podpowiedź znika.
    expect(shadeHint(nav, 150, 'shade')).toBeNull();
  });

  it('w trybie zimowym uzasadnia zmianę strony słońcem', () => {
    const nav = prepareRoute(
      route([
        segment(coords, 150, 0.2, { kind: 'street', side: 'left' }),
        segment(coords, 150, 0.9, { kind: 'street', side: 'right' }),
      ]),
    );
    expect(shadeHint(nav, 100, 'sun')!.text).toBe('Za 50 m przejdź na prawą stronę ulicy — tam jest słońce');
  });
});
