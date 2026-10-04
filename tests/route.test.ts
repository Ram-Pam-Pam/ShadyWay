import { describe, expect, it } from 'vitest';
import type { LatLon, MobilityProfile, RouteResult, WeatherInfo } from '../shared/types.ts';
import type {
  CoolSpotXY,
  Graph,
  IHeatField,
  IShadeScene,
  RouteOptions,
  RoutingContext,
  SunPosition,
  WalkWay,
} from '../server/contracts.ts';
import { toLatLon, toXY } from '../server/geo/project.ts';
import { buildGraph } from '../server/graph/build.ts';
import {
  computeBalancedSummary,
  computeRoutes,
  computeRoutesDetailed,
  defaultWalkSpeed,
  NoRouteError,
  searchCost,
} from '../server/graph/route.ts';

type ExposureFn = (x: number, y: number, sun: SunPosition) => number;

/** Scena-atrapa: ekspozycja zadana funkcją, polilinia próbkowana co ~2 m. */
function fakeScene(exposure: ExposureFn, insideBuilding: (x: number, y: number) => boolean): IShadeScene {
  return {
    exposureAt: (x, y, sun) => (sun.altitude <= 0 ? 0 : exposure(x, y, sun)),
    polylineExposure(coords, sun) {
      if (sun.altitude <= 0) return 0;
      let sum = 0;
      let count = 0;
      for (let i = 2; i < coords.length; i += 2) {
        const dx = coords[i] - coords[i - 2];
        const dy = coords[i + 1] - coords[i - 1];
        const steps = Math.max(1, Math.round(Math.hypot(dx, dy) / 2));
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          sum += exposure(coords[i - 2] + dx * t, coords[i - 1] + dy * t, sun);
          count++;
        }
      }
      return sum / count;
    },
    insideBuilding,
    shadowPolygons: () => [],
  };
}

const NO_HEAT: IHeatField = {
  available: false,
  sampleC: () => null,
  normalized: () => 0,
  meta: () => ({ available: false }),
  overlayPng: () => null,
};

function way(id: number, nodes: [id: number, x: number, y: number][], extra: Partial<WalkWay> = {}): WalkWay {
  return {
    id,
    nodeIds: nodes.map((n) => n[0]),
    coords: nodes.flatMap((n) => [n[1], n[2]]),
    kind: 'footway',
    highway: 'footway',
    covered: false,
    sidewalk: 'unknown',
    sideOffsetM: 0,
    penalty: 1,
    speedFactor: 1,
    ...extra,
  };
}

function contextFor(
  ways: WalkWay[],
  exposure: ExposureFn,
  graph: Graph = buildGraph(ways),
  insideBuilding: (x: number, y: number) => boolean = () => false,
): RoutingContext {
  return {
    area: { key: 'test', bboxXY: [-2000, -2000, 2000, 2000], buildings: [], trees: [], canopies: [], ways, blockedNodeIds: [] },
    graph,
    scene: fakeScene(exposure, insideBuilding),
    exposureCache: new Map(),
  };
}

function at(x: number, y: number): LatLon {
  const [lat, lon] = toLatLon(x, y);
  return { lat, lon };
}

/** Lipcowe południe w Krakowie — słońce wysoko. */
const NOON = new Date('2026-07-15T12:00:00+02:00');

function options(from: LatLon, to: LatLon, extra: Partial<RouteOptions> = {}): RouteOptions {
  return { from, to, departure: NOON, shadePreference: 0.5, walkSpeed: 1.3, sunFactor: 1, heat: NO_HEAT, ...extra };
}

function xyOf(route: RouteResult): [number, number][] {
  return route.geometry.map(([lon, lat]) => toXY(lat, lon));
}

function expectWellFormed(route: RouteResult): void {
  const segmentSum = route.segments.reduce((sum, s) => sum + s.lengthM, 0);
  expect(segmentSum).toBeCloseTo(route.distanceM, 6);
  const sunSum = route.segments.reduce((sum, s) => sum + s.lengthM * s.sunFraction, 0);
  expect(sunSum).toBeCloseTo(route.sunDistanceM, 6);
  expect(route.shadeFraction).toBeCloseTo(1 - route.sunDistanceM / route.distanceM, 9);
  for (const segment of route.segments) {
    expect(segment.lengthM).toBeLessThanOrEqual(60 + 1e-9);
    expect(segment.sunFraction).toBeGreaterThanOrEqual(0);
    expect(segment.sunFraction).toBeLessThanOrEqual(1);
    expect(segment.coords.length).toBeGreaterThanOrEqual(2);
  }
  for (let i = 1; i < route.geometry.length; i++) {
    expect(route.geometry[i]).not.toEqual(route.geometry[i - 1]);
  }
  for (let i = 1; i < route.segments.length; i++) {
    expect(route.segments[i].coords[0]).toEqual(route.segments[i - 1].coords.at(-1));
  }
}

/**
 * Dwie równoległe ulice N–S: A (x = 0) i B (x = bX), połączone przecznicami na y = 0 i y = 500.
 * Węzeł pośredni A w y = 250 jest tylko punktem geometrii.
 */
function twoStreetCity(bX: number): WalkWay[] {
  return [
    way(1, [
      [1, 0, 0],
      [2, 0, 250],
      [3, 0, 500],
    ]),
    way(2, [
      [4, bX, 0],
      [5, bX, 500],
    ]),
    way(3, [
      [1, 0, 0],
      [4, bX, 0],
    ]),
    way(4, [
      [3, 0, 500],
      [5, bX, 500],
    ]),
  ];
}

/** Cień tylko w pasie wokół ulicy B. */
const shadeNear =
  (bX: number): ExposureFn =>
  (x) =>
    Math.abs(x - bX) <= 10 ? 0 : 1;

describe('computeRoutes — profile', () => {
  it('najkrótsza ignoruje słońce, zacieniona wybiera równoległą ulicę w cieniu', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500)));

    const shortest = routes[0];
    expect(shortest.profile).toBe('shortest');
    expect(shortest.label).toBe('Najkrótsza');
    expect(shortest.distanceM).toBeCloseTo(500, 6);
    expect(shortest.shadeFraction).toBeCloseTo(0, 6);
    expect(shortest.durationS).toBeCloseTo(500 / 1.3, 6);
    expect(shortest.meanLstC).toBeNull();
    expectWellFormed(shortest);

    // Obie trasy "cieniste" idą tędy samo, więc zostaje tylko pierwsza z nich.
    expect(routes).toHaveLength(2);
    const shady = routes[1];
    expect(shady.profile).toBe('balanced');
    expect(shady.label).toBe('Zbalansowana');
    expect(shady.distanceM).toBeCloseTo(600, 6);
    expect(shady.sunDistanceM).toBeCloseTo(80, 0);
    expect(shady.shadeFraction).toBeGreaterThan(0.85);
    expect(xyOf(shady).some(([x]) => Math.abs(x - 50) < 1e-6)).toBe(true);
    expectWellFormed(shady);
    // Kolorowanie: odcinki wzdłuż B w cieniu, początek przecznicy w słońcu.
    expect(shady.segments[0].sunFraction).toBeGreaterThan(0.5);
    expect(shady.segments.filter((s) => s.sunFraction === 0).length).toBeGreaterThanOrEqual(8);
  });

  it('przy małej preferencji cienia "zbalansowana" zostaje na krótkiej trasie, a "najbardziej zacieniona" nadkłada drogi', () => {
    // B w odległości 150 m: objazd 800 m zamiast 500 m. Cień obejmuje też przecznice dla x >= 20.
    const ctx = contextFor(twoStreetCity(150), (x) => (x >= 20 ? 0 : 1));
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500), { shadePreference: 0 }));
    expect(routes.map((r) => r.profile)).toEqual(['shortest', 'shadiest']);
    expect(routes[1].label).toBe('Najbardziej zacieniona');
    expect(routes[1].distanceM).toBeCloseTo(800, 6);
    expect(routes[1].sunDistanceM).toBeCloseTo(40, 0);
  });

  it('limit wydłużenia to czysty stosunek do najkrótszej — także na krótkich trasach', () => {
    // Trasa 100 m, objazd w cieniu 210 m: 2,1× przekracza limit 2× (dawniej przechodził dzięki stałemu zapasowi 150 m).
    const short = (bX: number): WalkWay[] => [
      way(1, [[1, 0, 0], [3, 0, 100]]),
      way(2, [[4, bX, 0], [5, bX, 100]]),
      way(3, [[1, 0, 0], [4, bX, 0]]),
      way(4, [[3, 0, 100], [5, bX, 100]]),
    ];
    const shaded: ExposureFn = (x) => (x >= 3 ? 0 : 1);
    const tooLong = computeRoutes(contextFor(short(55), shaded), options(at(0, 0), at(0, 100), { shadePreference: 1 }));
    expect(tooLong.map((r) => r.profile)).toEqual(['shortest']);
    // Objazd 190 m (1,9×) mieści się w limicie „najbardziej zacienionej”, ale nie „zbalansowanej” (1,35×).
    const allowed = computeRoutes(contextFor(short(45), shaded), options(at(0, 0), at(0, 100), { shadePreference: 1 }));
    expect(allowed.map((r) => r.profile)).toEqual(['shortest', 'shadiest']);
    expect(allowed[1].distanceM).toBeCloseTo(190, 6);
    for (const route of allowed) expect(route.distanceM).toBeLessThanOrEqual(2 * allowed[0].distanceM + 1e-9);
  });

  it('odrzuca objazd przekraczający limit wydłużenia trasy', () => {
    // Objazd przez B to 2500 m wobec limitu 2 × 500 m.
    const ctx = contextFor(twoStreetCity(1000), shadeNear(1000));
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500), { shadePreference: 1 }));
    expect(routes).toHaveLength(1);
    expect(routes[0].profile).toBe('shortest');
    expect(routes[0].distanceM).toBeCloseTo(500, 6);
  });

  it('zwraca tylko najkrótszą, gdy słońce się nie liczy (sunFactor = 0)', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500), { sunFactor: 0 }));
    expect(routes.map((r) => r.profile)).toEqual(['shortest']);
  });

  it('nocą ekspozycja wynosi 0 niezależnie od sceny', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    const night = new Date('2026-07-15T01:00:00+02:00');
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500), { departure: night }));
    expect(routes).toHaveLength(1);
    expect(routes[0].sunDistanceM).toBe(0);
    expect(routes[0].shadeFraction).toBe(1);
  });

  it('uwzględnia mapę ciepła w koszcie i raportuje LST', () => {
    const heat: IHeatField = {
      ...NO_HEAT,
      available: true,
      // Ulica A (x < 25) rozgrzana, B chłodna.
      sampleC: (lat, lon) => (toXY(lat, lon)[0] < 25 ? 40 : 30),
      normalized: (lat, lon) => (toXY(lat, lon)[0] < 25 ? 1 : 0),
    };
    // Wszędzie pełny cień — o wyborze trasy decyduje wyłącznie temperatura.
    const ctx = contextFor(twoStreetCity(50), () => 0);
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500), { heat, shadePreference: 1 }));
    expect(routes).toHaveLength(2);
    expect(routes[0].meanLstC).toBeCloseTo(40, 6);
    expect(routes[0].segments[0].lstC).toBe(40);
    const cool = routes[1];
    expect(cool.distanceM).toBeCloseTo(600, 6);
    expect(cool.meanLstC).toBeLessThan(33);
  });
});

describe('computeRoutes — strona ulicy', () => {
  const street = (sidewalk: WalkWay['sidewalk']): WalkWay[] => [
    way(
      1,
      [
        [1, 0, 0],
        [2, 0, 150],
        [3, 0, 300],
      ],
      { kind: 'street', highway: 'residential', name: 'Aleja Testowa', sideOffsetM: 6, sidewalk },
    ),
  ];
  const westShaded: ExposureFn = (x) => (x < 0 ? 0 : 1);

  it('idąc na północ wybiera lewą (zachodnią, zacienioną) stronę', () => {
    const routes = computeRoutes(contextFor(street('both'), westShaded), options(at(0, 10), at(0, 290)));
    expect(routes).toHaveLength(1);
    const [route] = routes;
    expect(route.distanceM).toBeCloseTo(280, 6);
    expect(route.shadeFraction).toBeCloseTo(1, 6);
    for (const segment of route.segments) {
      expect(segment.kind).toBe('street');
      expect(segment.name).toBe('Aleja Testowa');
      expect(segment.side).toBe('left');
      expect(segment.sunFraction).toBe(0);
    }
    const xy = xyOf(route);
    for (const [x] of xy) expect(x).toBeCloseTo(-6, 3);
    expect(xy[0][1]).toBeCloseTo(10, 3);
    expect(xy.at(-1)![1]).toBeCloseTo(290, 3);
    expectWellFormed(route);
  });

  it('chodnik nie wchodzi w budynek: na wąskiej ulicy tor wraca przed ścianę i dostaje jej prawdziwe nasłonecznienie', () => {
    // Zabudowa po zachodniej stronie zaczyna się 2 m od osi (dla y w 100..200), a model odsuwa pieszego o 6 m.
    // Scena, jak prawdziwa, zwraca 0 dla punktu w budynku; poza budynkami wszędzie jest pełne słońce.
    const insideBuilding = (x: number, y: number): boolean => x < -2 && x > -30 && y > 100 && y < 200;
    const exposure: ExposureFn = (x, y) => (insideBuilding(x, y) ? 0 : 1);
    const ctx = contextFor(street('left'), exposure, undefined, insideBuilding);
    const [route] = computeRoutes(ctx, options(at(0, 10), at(0, 290)));
    expect(route.shadeFraction).toBeCloseTo(0, 6);
    for (const segment of route.segments) expect(segment.sunFraction).toBe(1);
    const xy = xyOf(route);
    for (const [x, y] of xy) expect(insideBuilding(x, y)).toBe(false);
    // Przy budynku pieszy idzie ok. 0,6 m przed ścianą, poza nim — w pełnym odsunięciu 6 m.
    const alongWall = xy.filter(([, y]) => y > 110 && y < 190);
    expect(alongWall.length).toBeGreaterThan(10);
    for (const [x] of alongWall) {
      expect(x).toBeLessThan(-1);
      expect(x).toBeGreaterThanOrEqual(-2);
    }
    expect(xy.filter(([, y]) => y < 90 || y > 210).every(([x]) => Math.abs(x + 6) < 1e-3)).toBe(true);
    expectWellFormed(route);
  });

  it('strona, której tor wypadłby w budynku, nie wygrywa jako „zacieniona”', () => {
    // Zachodnia strona: budynek 2 m od osi na całej długości (naprawdę pełne słońce); wschodnia: 30% cienia drzew.
    const insideBuilding = (x: number): boolean => x < -2 && x > -30;
    const exposure: ExposureFn = (x) => (insideBuilding(x) ? 0 : x > 0 ? 0.7 : 1);
    const ctx = contextFor(street('both'), exposure, undefined, insideBuilding);
    const [route] = computeRoutes(ctx, options(at(0, 10), at(0, 290)));
    for (const segment of route.segments) expect(segment.side).toBe('right');
    expect(route.shadeFraction).toBeCloseTo(0.3, 6);
  });

  it('oś ulicy biegnąca przez budynek (przejście) zachowuje pełny cień także dla stron', () => {
    const insideBuilding = (x: number, y: number): boolean => Math.abs(x) < 30 && y > 100 && y < 200;
    const exposure: ExposureFn = (x, y) => (insideBuilding(x, y) ? 0 : 1);
    const ctx = contextFor(street('both'), exposure, undefined, insideBuilding);
    const [route] = computeRoutes(ctx, options(at(0, 10), at(0, 290)));
    // 100 m z 280 m prowadzi przez budynek.
    expect(route.shadeFraction).toBeCloseTo(100 / 280, 1);
  });

  it('idąc na południe ta sama strona jest prawą', () => {
    const [route] = computeRoutes(contextFor(street('both'), westShaded), options(at(0, 290), at(0, 10)));
    for (const segment of route.segments) expect(segment.side).toBe('right');
    const xy = xyOf(route);
    for (const [x] of xy) expect(x).toBeCloseTo(-6, 3);
    expect(xy[0][1]).toBeCloseTo(290, 3);
    expect(route.shadeFraction).toBeCloseTo(1, 6);
  });

  it('respektuje sidewalk=right (względem kierunku drogi), nawet gdy ta strona jest w słońcu', () => {
    const ctx = contextFor(street('right'), westShaded);
    const [north] = computeRoutes(ctx, options(at(0, 10), at(0, 290)));
    for (const segment of north.segments) expect(segment.side).toBe('right');
    for (const [x] of xyOf(north)) expect(x).toBeCloseTo(6, 3);
    expect(north.shadeFraction).toBeCloseTo(0, 6);

    const [south] = computeRoutes(ctx, options(at(0, 290), at(0, 10)));
    for (const segment of south.segments) expect(segment.side).toBe('left');
    for (const [x] of xyOf(south)) expect(x).toBeCloseTo(6, 3);
  });

  it('nie przeskakuje przez jezdnię dla niewielkiego zysku, ale zmienia stronę dla dużego', () => {
    // Dwie drogi tej samej ulicy; na północnej połowie zachodnia strona jest minimalnie gorsza.
    const ways = [
      way(
        1,
        [
          [1, 0, 0],
          [2, 0, 100],
        ],
        { kind: 'street', name: 'Aleja Testowa', sideOffsetM: 6 },
      ),
      way(
        2,
        [
          [2, 0, 100],
          [3, 0, 200],
        ],
        { kind: 'street', name: 'Aleja Testowa', sideOffsetM: 6 },
      ),
    ];
    const slightGain: ExposureFn = (x, y) => (y < 100 ? (x < 0 ? 0 : 1) : x < 0 ? 0.5 : 0.45);
    const [steady] = computeRoutes(contextFor(ways, slightGain), options(at(0, 0), at(0, 200)));
    expect(new Set(steady.segments.map((s) => s.side))).toEqual(new Set(['left']));

    const bigGain: ExposureFn = (x, y) => (y < 100 ? (x < 0 ? 0 : 1) : x < 0 ? 1 : 0);
    const [switching] = computeRoutes(contextFor(ways, bigGain), options(at(0, 0), at(0, 200)));
    expect(switching.segments[0].side).toBe('left');
    expect(switching.segments.at(-1)!.side).toBe('right');
    expect(switching.shadeFraction).toBeCloseTo(1, 6);
    expectWellFormed(switching);
  });
});

describe('computeRoutes — ścieżka przy samej fasadzie', () => {
  const path = [way(1, [[1, 0, 0], [2, 0, 300]])];

  it('oś leżąca na ścianie lub tuż za nią jest odsuwana przed fasadę, a nie liczona jako wnętrze budynku', () => {
    // Fasada wzdłuż x = 0,4: linia ścieżki (x = 0) leży 0,4 m w głębi budynku zajmującego x < 0,4.
    const insideBuilding = (x: number): boolean => x < 0.4 && x > -40;
    const exposure: ExposureFn = (x) => (insideBuilding(x) ? 0 : 1);
    const [route] = computeRoutes(contextFor(path, exposure, undefined, insideBuilding), options(at(0, 10), at(0, 290)));
    expect(route.shadeFraction).toBeCloseTo(0, 6);
    for (const [x] of xyOf(route)) {
      expect(x).toBeGreaterThan(0.4);
      expect(x).toBeLessThan(2);
    }
    expectWellFormed(route);
  });

  it('ścieżka otoczona budynkiem z obu stron to przejście — zostaje pełny cień', () => {
    const insideBuilding = (x: number): boolean => Math.abs(x) < 20;
    const exposure: ExposureFn = (x) => (insideBuilding(x) ? 0 : 1);
    const [route] = computeRoutes(contextFor(path, exposure, undefined, insideBuilding), options(at(0, 10), at(0, 290)));
    expect(route.shadeFraction).toBeCloseTo(1, 6);
    for (const [x] of xyOf(route)) expect(x).toBeCloseTo(0, 6);
  });
});

describe('computeRoutes — zależność od czasu', () => {
  // Rano (słońce na wschodzie, azymut < π) ulica A jest w słońcu, a B w cieniu; po południu odwrotnie.
  const byTimeOfDay: ExposureFn = (x, _y, sun) => {
    const morning = sun.azimuth < Math.PI;
    return (x < 25) === morning ? 1 : 0;
  };

  it('ta sama para punktów daje inne trasy rano i po południu', () => {
    const ctx = contextFor(twoStreetCity(50), byTimeOfDay);
    const morning = computeRoutes(
      ctx,
      options(at(0, 0), at(0, 500), { departure: new Date('2026-07-15T08:30:00+02:00') }),
    );
    expect(morning).toHaveLength(2);
    expect(morning[0].shadeFraction).toBeCloseTo(0, 6);
    expect(morning[1].distanceM).toBeCloseTo(600, 6);

    const afternoon = computeRoutes(
      ctx,
      options(at(0, 0), at(0, 500), { departure: new Date('2026-07-15T17:00:00+02:00') }),
    );
    expect(afternoon).toHaveLength(1);
    expect(afternoon[0].shadeFraction).toBeCloseTo(1, 6);
  });

  it('ekspozycja jest liczona dla chwili dojścia do krawędzi (kolejne przedziały 10-minutowe)', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    // Wyjście 2 min przed granicą przedziału; 600 m marszu trwa ~7,7 min.
    computeRoutes(ctx, options(at(0, 0), at(0, 500), { departure: new Date('2026-07-15T12:08:00+02:00') }));
    const buckets = new Set([...ctx.exposureCache.keys()].map((key) => key.split(':')[0]));
    expect(buckets.size).toBe(2);
    for (const key of ctx.exposureCache.keys()) expect(key).toMatch(/^\d+:\d+:[CLR]$/);
  });

  it('statystyki trasy używają słońca z chwili przejścia danego odcinka', () => {
    // Jedna długa ścieżka; scena "gasi" słońce po zmianie przedziału czasu.
    const ways = [
      way(1, [
        [1, 0, 0],
        [2, 0, 1560],
      ]),
    ];
    const departure = new Date('2026-07-15T12:00:00+02:00');
    const firstBucketSun: number[] = [];
    const ctx = contextFor(ways, (_x, _y, sun) => {
      if (firstBucketSun.length === 0) firstBucketSun.push(sun.azimuth);
      return sun.azimuth === firstBucketSun[0] ? 1 : 0;
    });
    // 1560 m przy 1,3 m/s = 20 min: pierwsze 10 min w słońcu, kolejne 10 min w "cieniu".
    const [route] = computeRoutes(ctx, options(at(0, 0), at(0, 1560), { departure }));
    expect(route.durationS).toBeCloseTo(1200, 6);
    expect(route.sunDistanceM).toBeCloseTo(780, 6);
    expect(route.segments[0].sunFraction).toBe(1);
    expect(route.segments.at(-1)!.sunFraction).toBe(0);
  });
});

describe('computeRoutes — dociąganie punktów', () => {
  it('dociąga start i cel do najbliższego punktu w środku krawędzi', () => {
    const ctx = contextFor(twoStreetCity(50), () => 1);
    const edgesBefore = ctx.graph.edges.length;
    const [route] = computeRoutes(ctx, options(at(-7, 100), at(57, 420)));
    // A od y=100 do y=0 (100 m) + przecznica (50 m) + B do y=420 (420 m) = 570 m;
    // przez północną przecznicę: 400 + 50 + 80 = 530 m.
    expect(route.distanceM).toBeCloseTo(530, 6);
    const xy = xyOf(route);
    expect(xy[0][0]).toBeCloseTo(0, 6);
    expect(xy[0][1]).toBeCloseTo(100, 6);
    expect(xy.at(-1)![0]).toBeCloseTo(50, 6);
    expect(xy.at(-1)![1]).toBeCloseTo(420, 6);
    expectWellFormed(route);
    // Graf współdzielony między żądaniami nie może zostać zmodyfikowany.
    expect(ctx.graph.edges).toHaveLength(edgesBefore);
    expect(ctx.graph.nodeCount).toBe(4);
  });

  it('obsługuje start i cel na tej samej krawędzi w obu kierunkach', () => {
    const ctx = contextFor(twoStreetCity(50), () => 1);
    const [up] = computeRoutes(ctx, options(at(3, 60), at(-2, 310)));
    expect(up.distanceM).toBeCloseTo(250, 6);
    expect(xyOf(up)[0][1]).toBeCloseTo(60, 6);
    expect(xyOf(up).at(-1)![1]).toBeCloseTo(310, 6);
    expectWellFormed(up);

    const [down] = computeRoutes(ctx, options(at(-2, 310), at(3, 60)));
    expect(down.distanceM).toBeCloseTo(250, 6);
    expect(xyOf(down)[0][1]).toBeCloseTo(310, 6);
    expect(xyOf(down).at(-1)![1]).toBeCloseTo(60, 6);
  });

  it('zwraca trasę zerowej długości, gdy start i cel to ten sam punkt', () => {
    const ctx = contextFor(twoStreetCity(50), () => 1);
    const [route] = computeRoutes(ctx, options(at(0, 100), at(0, 100)));
    expect(route.distanceM).toBe(0);
    expect(route.shadeFraction).toBe(1);
    expect(route.geometry).toHaveLength(2);
    expect(route.segments).toHaveLength(0);
  });

  it('woli zwykłą ścieżkę od nieco bliższego przejścia zadaszonego lub schodów', () => {
    const ways = [
      way(1, [
        [1, 0, 0],
        [2, 0, 200],
      ]),
      way(
        2,
        [
          [1, 0, 0],
          [3, 8, 100],
          [2, 0, 200],
        ],
        { kind: 'covered', covered: true },
      ),
    ];
    const ctx = contextFor(ways, () => 1);
    // Punkt (6, 100): 2 m od pasażu, 6 m od ścieżki.
    const [route] = computeRoutes(ctx, options(at(6, 100), at(0, 200)));
    expect(xyOf(route)[0][0]).toBeCloseTo(0, 6);
    expect(route.segments.every((s) => s.kind === 'footway')).toBe(true);
  });

  it('przejście zadaszone liczy się jako pełny cień', () => {
    const ways = [
      way(
        1,
        [
          [1, 0, 0],
          [2, 0, 100],
        ],
        { kind: 'covered', covered: true },
      ),
    ];
    const [route] = computeRoutes(contextFor(ways, () => 1), options(at(0, 0), at(0, 100)));
    expect(route.sunDistanceM).toBe(0);
    expect(route.segments[0].kind).toBe('covered');
  });

  it('rzuca NoRouteError z polskim komunikatem, gdy w pobliżu punktu nie ma ścieżek', () => {
    const ctx = contextFor(twoStreetCity(50), () => 1);
    expect(() => computeRoutes(ctx, options(at(-400, 250), at(0, 500)))).toThrow(NoRouteError);
    expect(() => computeRoutes(ctx, options(at(0, 0), at(50, 900)))).toThrow(/punktu docelowego/);
    // 240 m od sieci — jeszcze w zasięgu dociągania.
    expect(computeRoutes(ctx, options(at(-240, 250), at(0, 500)))[0].distanceM).toBeCloseTo(250, 6);
  });

  it('rzuca NoRouteError, gdy start i cel leżą w rozłącznych częściach grafu', () => {
    const ways = [
      way(1, [
        [1, 0, 0],
        [2, 0, 100],
      ]),
      way(2, [
        [3, 300, 0],
        [4, 300, 100],
      ]),
    ];
    const graph: Graph = {
      nodeCount: 4,
      nodeX: Float64Array.from([0, 0, 300, 300]),
      nodeY: Float64Array.from([0, 100, 0, 100]),
      edges: [
        { id: 0, from: 0, to: 1, coords: [0, 0, 0, 100], lengthM: 100, way: ways[0] },
        { id: 1, from: 2, to: 3, coords: [300, 0, 300, 100], lengthM: 100, way: ways[1] },
      ],
      adjacency: [[0], [0], [1], [1]],
    };
    const ctx = contextFor(ways, () => 1, graph);
    expect(() => computeRoutes(ctx, options(at(0, 50), at(300, 50)))).toThrow(NoRouteError);
  });
});

describe('computeRoutes — wydajność', () => {
  it('liczy trzy profile dla ~3 km trasy w gęstej siatce ulic poniżej 2 s', () => {
    // Siatka 60×60 skrzyżowań co 60 m (3,5 × 3,5 km), "cień" w szachownicę kwartałów.
    const size = 60;
    const spacing = 60;
    const origin = -(size - 1) * spacing * 0.5;
    const ways: WalkWay[] = [];
    for (let line = 0; line < size; line++) {
      const horizontal: [number, number, number][] = [];
      const vertical: [number, number, number][] = [];
      for (let k = 0; k < size; k++) {
        horizontal.push([k * 1000 + line, origin + k * spacing, origin + line * spacing]);
        vertical.push([line * 1000 + k, origin + line * spacing, origin + k * spacing]);
      }
      ways.push(way(line, horizontal), way(100 + line, vertical, { kind: 'street', sideOffsetM: 5 }));
    }
    const checker: ExposureFn = (x, y) => ((Math.floor(x / 90) + Math.floor(y / 130)) % 2 === 0 ? 1 : 0.1);
    const ctx = contextFor(ways, checker);

    const started = performance.now();
    const routes = computeRoutes(ctx, options(at(origin + 400, origin + 300), at(origin + 2500, origin + 2400)));
    const elapsedMs = performance.now() - started;

    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].distanceM).toBeGreaterThan(2900);
    for (const route of routes) {
      expectWellFormed(route);
      expect(route.distanceM).toBeLessThanOrEqual(2 * routes[0].distanceM + 150);
      expect(route.shadeFraction).toBeGreaterThanOrEqual(routes[0].shadeFraction - 1e-9);
    }
    expect(elapsedMs).toBeLessThan(2000);
  });
});

// ═════════════════════════════ v2 ═════════════════════════════

const SUMMER_WEATHER: WeatherInfo = {
  time: '2026-07-15T10:00:00.000Z',
  temperatureC: 30,
  apparentTemperatureC: 31,
  cloudCoverPct: 5,
  directRadiationWm2: 800,
  uvIndex: 7,
  source: 'open-meteo',
};

describe('computeRoutes v2 — nowe pola wyniku', () => {
  it('każda trasa ma instrukcje, komfort cieplny i liczniki; bez pogody pola cieplne są puste', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500)));
    for (const route of routes) {
      expect(route.steps[0].maneuver).toBe('depart');
      expect(route.steps.at(-1)!.maneuver).toBe('arrive');
      expect(route.steps.reduce((sum, step) => sum + step.distanceM, 0)).toBeCloseTo(route.distanceM, 6);
      for (const step of route.steps) {
        expect(step.geometryIndex).toBeGreaterThanOrEqual(0);
        expect(step.geometryIndex).toBeLessThan(route.geometry.length);
        expect(route.geometry[step.geometryIndex]).toEqual(step.location);
      }
      expect(route.waitS).toBe(0);
      expect(route.signalCrossings).toBe(0);
      expect(route.stairsCount).toBe(0);
      expect(route.coolSpots).toEqual([]);
      expect(route.via).toBeUndefined();
      expect(route.thermal).toEqual({ feltSunC: null, feltShadeC: null, feltMeanC: null, stress: null });
    }
    // Zacieniona trasa: przecznicą na wschód, w lewo w ulicę B i w lewo w północną przecznicę.
    expect(routes[1].steps.map((step) => step.maneuver)).toEqual(['depart', 'left', 'left', 'arrive']);
  });

  it('z pogodą: trasa w słońcu jest odczuwalnie cieplejsza niż zacieniona', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    const [sunny, shady] = computeRoutes(ctx, options(at(0, 0), at(0, 500), { weather: SUMMER_WEATHER }));
    expect(sunny.thermal.feltShadeC).toBe(31);
    expect(sunny.thermal.feltSunC! - sunny.thermal.feltShadeC!).toBeGreaterThan(4);
    expect(sunny.thermal.feltSunC! - sunny.thermal.feltShadeC!).toBeLessThanOrEqual(12);
    expect(sunny.thermal.feltMeanC).toBeCloseTo(sunny.thermal.feltSunC!, 1);
    expect(shady.thermal.feltMeanC!).toBeLessThan(sunny.thermal.feltMeanC! - 3);
    expect(sunny.thermal.stress).toBe('strong');
  });

  it('przekazuje scenie sezon bezlistny wynikający z daty (leafOff)', () => {
    const seen: (boolean | undefined)[] = [];
    const ctx = contextFor(twoStreetCity(50), (_x, _y, sun) => {
      seen.push(sun.leafOff);
      return 1;
    });
    computeRoutes(ctx, options(at(0, 0), at(0, 500)));
    expect(new Set(seen)).toEqual(new Set([false]));
    seen.length = 0;
    computeRoutes(ctx, options(at(0, 0), at(0, 500), { departure: new Date('2026-01-15T12:00:00+01:00') }));
    expect(new Set(seen)).toEqual(new Set([true]));
  });

  it('computeBalancedSummary zwraca statystyki trasy zbalansowanej', () => {
    const ctx = contextFor(twoStreetCity(50), shadeNear(50));
    const opts = options(at(0, 0), at(0, 500), { weather: SUMMER_WEATHER });
    const balanced = computeRoutes(ctx, opts)[1];
    const summary = computeBalancedSummary(ctx, opts);
    expect(summary.distanceM).toBeCloseTo(balanced.distanceM, 6);
    expect(summary.durationS).toBeCloseTo(balanced.durationS, 6);
    expect(summary.sunDistanceM).toBeCloseTo(balanced.sunDistanceM, 6);
    expect(summary.shadeFraction).toBeCloseTo(balanced.shadeFraction, 9);
    expect(summary.thermal).toEqual(balanced.thermal);
    // Gdy słońce się nie liczy — statystyki trasy najkrótszej.
    expect(computeBalancedSummary(ctx, { ...opts, sunFactor: 0 }).distanceM).toBeCloseTo(500, 6);
  });
});

describe('computeRoutes v2 — światła', () => {
  /** Prosta droga 200 m z przejściem (y = 90..110) i — opcjonalnie — objazd bez przejścia łukiem przez x = detourX. */
  const withCrossing = (signals: boolean, detourX: number | null, splitCrossing = false): WalkWay[] => {
    const ways = [
      way(1, [[1, 0, 0], [2, 0, 90]]),
      way(
        2,
        splitCrossing ? [[2, 0, 90], [9, 0, 100], [3, 0, 110]] : [[2, 0, 90], [3, 0, 110]],
        { kind: 'crossing', signals },
      ),
      way(3, [[3, 0, 110], [4, 0, 200]]),
    ];
    // Wysepka w połowie przejścia z krótką odnogą — przejście staje się dwiema krawędziami grafu.
    if (splitCrossing) ways.push(way(5, [[9, 0, 100], [8, -3, 100]]));
    if (detourX !== null) ways.push(way(4, [[1, 0, 0], [10, detourX, 100], [4, 0, 200]]));
    return ways;
  };

  it('dolicza czekanie na światłach do czasu i oznacza odcinek przejścia', () => {
    const [route] = computeRoutes(contextFor(withCrossing(true, null), () => 1), options(at(0, 0), at(0, 200)));
    expect(route.distanceM).toBeCloseTo(200, 6);
    expect(route.waitS).toBeCloseTo(25, 6);
    expect(route.signalCrossings).toBe(1);
    expect(route.durationS).toBeCloseTo(200 / 1.3 + 25, 6);
    const crossing = route.segments.filter((s) => s.kind === 'crossing');
    expect(crossing).toHaveLength(1);
    expect(crossing[0].signals).toBe(true);
    expect(route.segments.filter((s) => s.kind !== 'crossing').every((s) => s.signals === undefined)).toBe(true);
    expect(route.steps.map((s) => s.maneuver)).toEqual(['depart', 'cross', 'continue', 'arrive']);
    expect(route.steps[1].text).toBe('Przejdź przez przejście ze światłami.');
    expectWellFormed(route);
  });

  it('przejście bez sygnalizacji: krótkie czekanie i brak licznika świateł', () => {
    const [route] = computeRoutes(contextFor(withCrossing(false, null), () => 1), options(at(0, 0), at(0, 200)));
    expect(route.waitS).toBeCloseTo(5, 6);
    expect(route.signalCrossings).toBe(0);
    expect(route.segments.find((s) => s.kind === 'crossing')!.signals).toBe(false);
    expect(route.steps[1].text).toBe('Przejdź przez przejście dla pieszych.');
  });

  it('przejście pocięte na dwie krawędzie to nadal jedno czekanie i jedne światła', () => {
    const [route] = computeRoutes(contextFor(withCrossing(true, null, true), () => 1), options(at(0, 0), at(0, 200)));
    expect(route.waitS).toBeCloseTo(25, 6);
    expect(route.signalCrossings).toBe(1);
  });

  it('światła zniechęcają: objazd 8,8 m dłuższy wygrywa ze światłami, ale nie ze zwykłym przejściem', () => {
    // Objazd: 2 × hypot(30, 100) = 208,8 m. Światła: 25 s × 1,3 m/s = 32,5 m; zwykłe przejście: 6,5 m.
    const detourM = 2 * Math.hypot(30, 100);
    const [avoiding] = computeRoutes(contextFor(withCrossing(true, 30), () => 1), options(at(0, 0), at(0, 200)));
    expect(avoiding.distanceM).toBeCloseTo(detourM, 6);
    expect(avoiding.signalCrossings).toBe(0);
    expect(avoiding.waitS).toBe(0);
    const [direct] = computeRoutes(contextFor(withCrossing(false, 30), () => 1), options(at(0, 0), at(0, 200)));
    expect(direct.distanceM).toBeCloseTo(200, 6);
  });
});

describe('computeRoutes v2 — profile poruszania się', () => {
  /** Krótka droga ze schodami (y = 40..60) albo o 60 m dłuższa pochylnia łukiem przez x = 30. */
  const stairsOrRamp = (stairs: Partial<WalkWay> = {}, ramp: Partial<WalkWay> | null = {}, rampX = 30): WalkWay[] => {
    const ways = [
      way(1, [[1, 0, 0], [2, 0, 40]]),
      way(2, [[2, 0, 40], [3, 0, 60]], { kind: 'steps', highway: 'steps', speedFactor: 0.5, ...stairs }),
      way(3, [[3, 0, 60], [4, 0, 100]]),
    ];
    if (ramp) ways.push(way(4, [[2, 0, 40], [5, rampX, 40], [6, rampX, 60], [3, 0, 60]], ramp));
    return ways;
  };
  const go = (ways: WalkWay[], mobility: MobilityProfile, graph?: Graph) =>
    computeRoutesDetailed(
      contextFor(ways, () => 1, graph),
      options(at(0, 0), at(0, 100), { mobility, walkSpeed: defaultWalkSpeed(mobility) }),
    );

  it('domyślne prędkości profili', () => {
    expect(defaultWalkSpeed()).toBe(1.3);
    expect(defaultWalkSpeed('accessible')).toBe(1.1);
    expect(defaultWalkSpeed('senior')).toBe(1.0);
  });

  it('profil domyślny idzie schodami, „accessible” i „senior” wybierają pochylnię', () => {
    const normal = go(stairsOrRamp(), 'default');
    expect(normal.routes[0].distanceM).toBeCloseTo(100, 6);
    expect(normal.routes[0].stairsCount).toBe(1);
    expect(normal.routes[0].steps.some((s) => s.maneuver === 'stairs')).toBe(true);
    expect(normal.warnings).toEqual([]);

    const accessible = go(stairsOrRamp(), 'accessible');
    expect(accessible.routes[0].distanceM).toBeCloseTo(160, 6);
    expect(accessible.routes[0].stairsCount).toBe(0);
    expect(accessible.routes[0].durationS).toBeCloseTo(160 / 1.1, 6);
    expect(accessible.warnings).toEqual([]);

    // Senior: schody kosztują 3× — 20 m schodów „waży” 60 m, więc objazd +30 m się opłaca, a +60 m już nie.
    const senior = go(stairsOrRamp({}, {}, 15), 'senior');
    expect(senior.routes[0].distanceM).toBeCloseTo(130, 6);
    expect(senior.routes[0].stairsCount).toBe(0);
    expect(senior.routes[0].durationS).toBeCloseTo(130 / 1.0, 6);
    expect(go(stairsOrRamp(), 'senior').routes[0].stairsCount).toBe(1);
  });

  it('„senior” idzie schodami, gdy nie ma innej drogi — wolniej niż po płaskim i bez ostrzeżenia', () => {
    // 20 m schodów: 20 / (1,0 m/s × 0,5 × 0,7).
    const { routes, warnings } = go(stairsOrRamp({}, null), 'senior');
    expect(warnings).toEqual([]);
    expect(routes[0].stairsCount).toBe(1);
    expect(routes[0].durationS).toBeCloseTo(80 / 1.0 + 20 / 0.35, 6);
  });

  it('„accessible”: schody są zakazane nawet z tagiem ramp (to zwykle rynna, nie podjazd), wheelchair=no i nachylenie > 10% — zakazane', () => {
    expect(go(stairsOrRamp({ ramp: true }, null), 'accessible').warnings).toHaveLength(1);
    // Pochylnia oznaczona jako niedostępna albo zbyt stroma: nie ma trasy w pełni dostępnej → ostrzeżenie.
    for (const ramp of [{ wheelchair: 'no' as const }, { inclinePct: 12 }]) {
      const { routes, warnings } = go(stairsOrRamp({}, ramp), 'accessible');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/dostępnej dla wózka/);
      expect(routes[0].distanceM).toBeGreaterThan(0);
    }
    // Nachylenie 8% jest dozwolone (z karą) — bez ostrzeżenia, pochylnią.
    const steep = go(stairsOrRamp({}, { inclinePct: 8 }), 'accessible');
    expect(steep.warnings).toEqual([]);
    expect(steep.routes[0].stairsCount).toBe(0);
  });

  it('gdy cel jest osiągalny tylko schodami, „accessible” zwraca trasę zastępczą z ostrzeżeniem zamiast błędu', () => {
    const { routes, warnings } = go(stairsOrRamp({}, null), 'accessible');
    expect(routes[0].distanceM).toBeCloseTo(100, 6);
    expect(routes[0].stairsCount).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/schody/);
    // computeRoutes (bez ostrzeżeń) też nie rzuca.
    const plain = computeRoutes(contextFor(stairsOrRamp({}, null), () => 1), options(at(0, 0), at(0, 100), { mobility: 'accessible' }));
    expect(plain).toHaveLength(1);
  });

  it('„accessible” nie dociąga startu do schodów, tylko do najbliższej dostępnej drogi', () => {
    const ctx = contextFor(stairsOrRamp(), () => 1);
    // Punkt (2, 45): 2 m od schodów, 5 m od końca drogi nr 1 i od początku pochylni.
    const [route] = computeRoutes(ctx, options(at(2, 45), at(0, 100), { mobility: 'accessible' }));
    const [x, y] = xyOf(route)[0];
    expect(Math.hypot(x - 0, y - 40)).toBeLessThan(2.1);
    expect(route.stairsCount).toBe(0);
    const [normal] = computeRoutes(ctx, options(at(2, 45), at(0, 100)));
    expect(normal.stairsCount).toBe(1);
  });

  it('zła nawierzchnia: „accessible” nadkłada drogi asfaltem, „senior” tylko przy naprawdę złej', () => {
    const cityWith = (surface: string): WalkWay[] => [
      way(1, [[1, 0, 0], [2, 0, 100]], { surface }),
      way(2, [[1, 0, 0], [3, 40, 50], [2, 0, 100]], { surface: 'asphalt' }),
    ];
    const ways = cityWith('cobblestone');
    expect(go(ways, 'default').routes[0].distanceM).toBeCloseTo(100, 6);
    const accessible = go(ways, 'accessible').routes[0];
    expect(accessible.distanceM).toBeCloseTo(2 * Math.hypot(40, 50), 6);
    expect(accessible.segments.every((s) => s.surface === 'asphalt')).toBe(true);
    // Kocie łby: senior (kara ×1,525) też woli 128 m asfaltu. Kostka (sett): accessible ×1,6 → objazd,
    // senior ×1,21 → zostaje na krótszej drodze.
    expect(go(ways, 'senior').routes[0].distanceM).toBeCloseTo(2 * Math.hypot(40, 50), 6);
    expect(go(cityWith('sett'), 'accessible').routes[0].distanceM).toBeCloseTo(2 * Math.hypot(40, 50), 6);
    expect(go(cityWith('sett'), 'senior').routes[0].distanceM).toBeCloseTo(100, 6);
  });

  it('wysoki krawężnik: „accessible” wybiera dojście bez niego', () => {
    // Dwa równoległe dojścia; krótsze ma w środku węzeł kerb=raised (id 9).
    const ways = [
      way(1, [[1, 0, 0], [9, 0, 50], [2, 0, 100]]),
      way(2, [[1, 0, 0], [3, 40, 50], [2, 0, 100]]),
    ];
    const graph = buildGraph(ways, [], [9]);
    expect(go(ways, 'default', graph).routes[0].distanceM).toBeCloseTo(100, 6);
    expect(go(ways, 'senior', graph).routes[0].distanceM).toBeCloseTo(100, 6);
    const accessible = go(ways, 'accessible', graph);
    expect(accessible.routes[0].distanceM).toBeCloseTo(2 * Math.hypot(40, 50), 6);
    expect(accessible.warnings).toEqual([]);
  });

  it('„senior” woli drogę z ławkami, gdy jest tylko nieznacznie dłuższa', () => {
    // Dwie drogi: ok. 208,8 m bez ławek i ok. 210,9 m (+1%) z ławkami.
    const ways = [
      way(1, [[1, 0, 0], [2, -30, 100], [3, 0, 200]]),
      way(2, [[1, 0, 0], [4, 33.5, 100], [3, 0, 200]]),
    ];
    const lengths = [2 * Math.hypot(30, 100), 2 * Math.hypot(33.5, 100)];
    expect(lengths[1] / lengths[0]).toBeGreaterThan(1.005);
    expect(lengths[1] / lengths[0]).toBeLessThan(1.05);
    const benches: CoolSpotXY[] = [
      { id: 'b1', kind: 'bench', x: 20, y: 50 },
      { id: 'b2', kind: 'bench', x: 36, y: 100 },
    ];
    const run = (mobility: MobilityProfile): RouteResult => {
      const ctx = contextFor(ways, () => 1);
      ctx.area.coolSpots = benches;
      return computeRoutes(ctx, options(at(0, 0), at(0, 200), { mobility }))[0];
    };
    expect(run('default').distanceM).toBeCloseTo(lengths[0], 6);
    const senior = run('senior');
    expect(senior.distanceM).toBeCloseTo(lengths[1], 6);
    expect(senior.coolSpots.map((spot) => spot.id)).toEqual(['b1', 'b2']);
  });
});

describe('computeRoutes v2 — tryb zimowy (szukaj słońca)', () => {
  /** Słońce tylko w pasie wokół ulicy B. */
  const sunNear =
    (bX: number): ExposureFn =>
    (x) =>
      Math.abs(x - bX) <= 10 ? 1 : 0;

  it('trasa „słoneczna” nadkłada drogi do nasłonecznionej ulicy, etykiety są zimowe', () => {
    const ctx = contextFor(twoStreetCity(150), (x) => (x >= 20 ? 1 : 0));
    const routes = computeRoutes(ctx, options(at(0, 0), at(0, 500), { comfort: 'sun', shadePreference: 0 }));
    expect(routes.map((r) => r.label)).toEqual(['Najkrótsza', 'Najbardziej słoneczna']);
    expect(routes.map((r) => r.profile)).toEqual(['shortest', 'shadiest']);
    expect(routes[0].shadeFraction).toBeCloseTo(1, 6);
    expect(routes[1].distanceM).toBeCloseTo(800, 6);
    // shadeFraction zachowuje znaczenie: to nadal udział cienia.
    expect(routes[1].shadeFraction).toBeLessThan(0.1);
  });

  it('ta sama sceneria w trybie cienia nie daje objazdu (najkrótsza już jest w cieniu)', () => {
    const ctx = contextFor(twoStreetCity(50), sunNear(50));
    expect(computeRoutes(ctx, options(at(0, 0), at(0, 500), { comfort: 'shade' }))).toHaveLength(1);
    const sunny = computeRoutes(ctx, options(at(0, 0), at(0, 500), { comfort: 'sun' }));
    expect(sunny).toHaveLength(2);
    expect(sunny[1].label).toBe('Zbalansowana');
    expect(sunny[1].distanceM).toBeCloseTo(600, 6);
  });

  it('w trybie zimowym wybierana jest nasłoneczniona strona ulicy', () => {
    const street = [
      way(1, [[1, 0, 0], [2, 0, 300]], { kind: 'street', highway: 'residential', name: 'Aleja Testowa', sideOffsetM: 6, sidewalk: 'both' }),
    ];
    const westShaded: ExposureFn = (x) => (x < 0 ? 0 : 1);
    const [summer] = computeRoutes(contextFor(street, westShaded), options(at(0, 10), at(0, 290)));
    expect(summer.segments[0].side).toBe('left');
    const [winter] = computeRoutes(contextFor(street, westShaded), options(at(0, 10), at(0, 290), { comfort: 'sun' }));
    expect(winter.segments[0].side).toBe('right');
    expect(winter.shadeFraction).toBeCloseTo(0, 6);
    expect(winter.steps[0].text).toMatch(/prawą stroną ulicy — w słońcu/);
  });
});

describe('computeRoutes v2 — punkty chłodu', () => {
  /** Jak twoStreetCity(50), ale z odnogą od ulicy B (y = 250) w stronę fontanny. */
  const cityWithSpur = (spurEndX: number): WalkWay[] => [
    way(1, [[1, 0, 0], [2, 0, 250], [3, 0, 500]]),
    way(2, [[4, 50, 0], [6, 50, 250], [5, 50, 500]]),
    way(3, [[1, 0, 0], [4, 50, 0]]),
    way(4, [[3, 0, 500], [5, 50, 500]]),
    way(5, [[6, 50, 250], [7, spurEndX, 250]]),
  ];
  const fountain = (x: number): CoolSpotXY => ({ id: 'node/1', kind: 'fountain', x, y: 250, name: 'Fontanna' });
  const ctxWith = (ways: WalkWay[], spots: CoolSpotXY[], exposure: ExposureFn = shadeNear(50)): RoutingContext => {
    const ctx = contextFor(ways, exposure);
    ctx.area.coolSpots = spots;
    return ctx;
  };

  it('bez viaCoolSpot trasa nie zbacza, ale wymienia punkty chłodu w pobliżu (z informacją o cieniu)', () => {
    const routes = computeRoutes(ctxWith(cityWithSpur(75), [fountain(78)]), options(at(0, 0), at(0, 500)));
    expect(routes[1].distanceM).toBeCloseTo(600, 6);
    expect(routes[1].via).toBeUndefined();
    expect(routes[1].coolSpots).toHaveLength(1);
    const [spot] = routes[1].coolSpots;
    expect(spot).toMatchObject({ id: 'node/1', kind: 'fountain', name: 'Fontanna', shaded: false });
    const [x, y] = toXY(spot.lat, spot.lon);
    expect(x).toBeCloseTo(78, 6);
    expect(y).toBeCloseTo(250, 6);
    // Najkrótsza (ulicą A, 78 m od fontanny) jej nie wymienia.
    expect(routes[0].coolSpots).toEqual([]);
  });

  it('viaCoolSpot prowadzi trasę przez fontannę, gdy mieści się to w limicie wydłużenia', () => {
    const routes = computeRoutes(ctxWith(cityWithSpur(75), [fountain(78)]), options(at(0, 0), at(0, 500), { viaCoolSpot: true }));
    expect(routes[0].via).toBeUndefined();
    const balanced = routes[1];
    expect(balanced.profile).toBe('balanced');
    expect(balanced.via).toMatchObject({ id: 'node/1', kind: 'fountain' });
    // 600 m + odnoga 25 m tam i z powrotem = 650 m <= 1,35 × 500 m.
    expect(balanced.distanceM).toBeCloseTo(650, 6);
    expect(xyOf(balanced).some(([x, y]) => Math.abs(x - 75) < 1e-6 && Math.abs(y - 250) < 1e-6)).toBe(true);
    expectWellFormed(balanced);
  });

  it('zbyt daleka fontanna: „zbalansowana” jej nie odwiedza, „najbardziej zacieniona” (limit 2×) — tak', () => {
    // Odnoga 100 m: 600 + 200 = 800 m > 675 m, ale <= 1000 m.
    const routes = computeRoutes(ctxWith(cityWithSpur(150), [fountain(152)]), options(at(0, 0), at(0, 500), { viaCoolSpot: true }));
    expect(routes.map((r) => r.profile)).toEqual(['shortest', 'balanced', 'shadiest']);
    expect(routes[1].via).toBeUndefined();
    expect(routes[1].distanceM).toBeCloseTo(600, 6);
    expect(routes[2].via?.id).toBe('node/1');
    expect(routes[2].distanceM).toBeCloseTo(800, 6);
  });

  it('punkt tuż przy trasie jest wskazywany bez zmiany przebiegu; ławka nie jest celem objazdu', () => {
    const near = computeRoutes(ctxWith(cityWithSpur(75), [fountain(60)]), options(at(0, 0), at(0, 500), { viaCoolSpot: true }));
    expect(near[1].via?.id).toBe('node/1');
    expect(near[1].distanceM).toBeCloseTo(600, 6);
    const bench: CoolSpotXY = { id: 'b', kind: 'bench', x: 78, y: 250 };
    const benchOnly = computeRoutes(ctxWith(cityWithSpur(75), [bench]), options(at(0, 0), at(0, 500), { viaCoolSpot: true }));
    expect(benchOnly[1].via).toBeUndefined();
    expect(benchOnly[1].distanceM).toBeCloseTo(600, 6);
  });

  it('lista punktów przy trasie: najwyżej 12, woda przed ławkami, w kolejności mijania, cień z chwili przejścia', () => {
    const spots: CoolSpotXY[] = [];
    for (let i = 0; i < 20; i++) spots.push({ id: `bench-${i}`, kind: 'bench', x: 5, y: 20 + i * 24 });
    spots.push({ id: 'water-a', kind: 'drinking_water', x: -40, y: 400 }, { id: 'mist', kind: 'water_mist', x: 30, y: 100 });
    spots.push({ id: 'far', kind: 'fountain', x: 90, y: 250 });
    // Cień na zachód od osi: woda po zachodniej stronie jest zacieniona.
    const [route] = computeRoutes(ctxWith(twoStreetCity(1000), spots, (x) => (x < 0 ? 0 : 1)), options(at(0, 0), at(0, 500)));
    expect(route.coolSpots).toHaveLength(12);
    const ids = route.coolSpots.map((spot) => spot.id);
    expect(ids).toContain('water-a');
    expect(ids).toContain('mist');
    expect(ids).not.toContain('far');
    const ys = route.coolSpots.map((spot) => toXY(spot.lat, spot.lon)[1]);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(route.coolSpots.find((spot) => spot.id === 'water-a')!.shaded).toBe(true);
    expect(route.coolSpots.find((spot) => spot.id === 'mist')!.shaded).toBe(false);
  });
});

describe('A* a Dijkstra — dopuszczalność heurystyki we wszystkich trybach', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Losowa siatka ulic z przejściami, schodami, różnymi nawierzchniami, nachyleniami, krawężnikami i ławkami. */
  function randomCity(seed: number): { ctx: RoutingContext; from: LatLon; to: LatLon } {
    const random = mulberry32(seed);
    const size = 7;
    const grid: [number, number, number][][] = [];
    for (let ix = 0; ix < size; ix++) {
      grid.push([]);
      for (let iy = 0; iy < size; iy++) {
        grid[ix].push([ix * 100 + iy + 1, ix * 70 + (random() - 0.5) * 30, iy * 70 + (random() - 0.5) * 30]);
      }
    }
    const surfaces = [undefined, 'asphalt', 'cobblestone', 'sett', 'gravel', 'grass', 'sand'];
    const smoothness = [undefined, undefined, 'good', 'bad', 'very_bad', 'horrible'];
    const ways: WalkWay[] = [];
    let id = 1;
    const addWay = (a: [number, number, number], b: [number, number, number]): void => {
      if (random() < 0.12) return; // dziury w siatce
      const r = random();
      const extra: Partial<WalkWay> = {
        surface: surfaces[Math.floor(random() * surfaces.length)],
        smoothness: smoothness[Math.floor(random() * smoothness.length)],
        penalty: 1 + (random() < 0.2 ? random() : 0),
      };
      if (r < 0.15) Object.assign(extra, { kind: 'crossing', signals: random() < 0.5 });
      else if (r < 0.25) Object.assign(extra, { kind: 'steps', speedFactor: 0.5, ramp: random() < 0.3 });
      else if (r < 0.4) Object.assign(extra, { kind: 'street', sideOffsetM: 4, sidewalk: 'both', name: `Ulica ${id % 5}` });
      if (random() < 0.2) extra.inclinePct = random() * 14;
      if (random() < 0.08) extra.wheelchair = random() < 0.5 ? 'no' : 'limited';
      // Punkt pośredni (id >= 10000) bywa krawężnikiem.
      const mid: [number, number, number] = [10_000 + id, (a[1] + b[1]) / 2 + (random() - 0.5) * 8, (a[2] + b[2]) / 2 + (random() - 0.5) * 8];
      ways.push(way(id++, [a, mid, b], extra));
    };
    for (let ix = 0; ix < size; ix++) {
      for (let iy = 0; iy < size; iy++) {
        if (ix + 1 < size) addWay(grid[ix][iy], grid[ix + 1][iy]);
        if (iy + 1 < size) addWay(grid[ix][iy], grid[ix][iy + 1]);
      }
    }
    const kerbs = ways.filter(() => random() < 0.15).map((w) => w.nodeIds[1]);
    const graph = buildGraph(ways, [], kerbs);
    // Ekspozycja stała w czasie (zależna tylko od miejsca) — koszty krawędzi są wtedy statyczne.
    const exposure: ExposureFn = (x, y) => (Math.sin(x / 37) * Math.cos(y / 53) + 1) / 2;
    const ctx = contextFor(ways, exposure, graph);
    ctx.area.coolSpots = Array.from({ length: 25 }, (_, i) => ({
      id: `bench-${i}`,
      kind: 'bench' as const,
      x: random() * 420,
      y: random() * 420,
    }));
    const pick = (): LatLon => at(random() * 420, random() * 420);
    return { ctx, from: pick(), to: pick() };
  }

  const heat: IHeatField = {
    ...NO_HEAT,
    available: true,
    normalized: (lat, lon) => {
      const [x, y] = toXY(lat, lon);
      return (Math.sin(x / 91) * Math.sin(y / 67) + 1) / 2;
    },
  };

  it('A* zwraca ten sam koszt co Dijkstra na losowych grafach (profile × tryby komfortu)', () => {
    let compared = 0;
    let unreachable = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { ctx, from, to } = randomCity(seed);
      for (const mobility of ['default', 'accessible', 'senior'] as const) {
        for (const comfort of ['shade', 'sun'] as const) {
          for (const weights of [{ wSun: 0, wHeat: 0 }, { wSun: 4, wHeat: 0.5 }, { wSun: 10, wHeat: 1 }]) {
            const opts = options(from, to, { mobility, comfort, heat, walkSpeed: defaultWalkSpeed(mobility) });
            let dijkstra: number;
            try {
              dijkstra = searchCost(ctx, opts, weights, false);
            } catch (error) {
              expect(error).toBeInstanceOf(NoRouteError);
              expect(() => searchCost(ctx, opts, weights, true)).toThrow(NoRouteError);
              unreachable++;
              continue;
            }
            const aStar = searchCost(ctx, opts, weights, true);
            const label = `seed ${seed} ${mobility} ${comfort} wSun=${weights.wSun}`;
            expect(Math.abs(aStar - dijkstra), label).toBeLessThan(1e-6 * Math.max(1, dijkstra));
            compared++;
          }
        }
      }
    }
    // Test ma sens tylko wtedy, gdy większość par jest połączona.
    expect(compared).toBeGreaterThan(400);
    expect(unreachable).toBeLessThan(compared / 2);
  });
});

describe('v3: krawędzie na mostach', () => {
  it('ekspozycja krawędzi na moście liczona jest z poziomu pomostu (onBridge), poza mostem — zwykle', () => {
    // Prosta droga 300 m: środkowe 100 m to most. Scena-atrapa: „pod pomostem" pełny cień, na pomoście słońce.
    const ways = [
      way(1, [[1, 0, 0], [2, 100, 0]]),
      way(2, [[2, 100, 0], [3, 200, 0]], { bridge: true }),
      way(3, [[3, 200, 0], [4, 300, 0]]),
    ];
    const ctx = contextFor(ways, () => 0.5);
    const calls: boolean[] = [];
    ctx.scene = {
      ...ctx.scene,
      polylineExposure: (coords: number[], sun: SunPosition, _stepM?: number, onBridge?: boolean) => {
        if (sun.altitude <= 0) return 0;
        calls.push(onBridge === true);
        const onDeckSpan = coords[0] >= 100 && coords[coords.length - 2] <= 200;
        return onDeckSpan ? (onBridge ? 1 : 0) : 0.5;
      },
    };
    const [route] = computeRoutes(ctx, options(at(0, 0), at(300, 0), { shadePreference: 0 }));
    expectWellFormed(route);
    expect(calls).toContain(true);
    expect(calls).toContain(false);
    // 100 m w pełnym słońcu (most) + 200 m w półcieniu = 200 m „w słońcu" z 300 m.
    expect(route.sunDistanceM).toBeCloseTo(200, 0);
    const bridgeSegments = route.segments.filter((segment) => {
      const [x] = toXY(segment.coords[0][1], segment.coords[0][0]);
      const [x2] = toXY(segment.coords[segment.coords.length - 1][1], segment.coords[segment.coords.length - 1][0]);
      return Math.min(x, x2) >= 99 && Math.max(x, x2) <= 201;
    });
    expect(bridgeSegments.length).toBeGreaterThan(0);
    for (const segment of bridgeSegments) expect(segment.sunFraction).toBe(1);
  });
});
