import { describe, expect, it } from 'vitest';
import type { DepartureOption, LatLon, WeatherInfo } from '../shared/types.ts';
import type { IHeatField, IShadeScene, RoutingContext, SunPosition, WalkWay } from '../server/contracts.ts';
import { toLatLon } from '../server/geo/project.ts';
import { sunInfo } from '../server/geo/sun.ts';
import { buildGraph } from '../server/graph/build.ts';
import {
  buildDepartureResponse,
  departureSummary,
  departureTimes,
  evaluateDepartures,
  MAX_DEPARTURE_SAMPLES,
  scoreDepartures,
  thermalComfort,
} from '../server/graph/departure.ts';
import { sunFactorFrom } from '../server/weather/openmeteo.ts';

type ExposureFn = (x: number, y: number, sun: SunPosition) => number;

function fakeScene(exposure: ExposureFn): IShadeScene {
  return {
    exposureAt: (x, y, sun) => (sun.altitude <= 0 ? 0 : exposure(x, y, sun)),
    polylineExposure(coords, sun) {
      if (sun.altitude <= 0) return 0;
      let sum = 0;
      let count = 0;
      for (let i = 2; i < coords.length; i += 2) {
        sum += exposure((coords[i] + coords[i - 2]) / 2, (coords[i + 1] + coords[i - 1]) / 2, sun);
        count++;
      }
      return sum / count;
    },
    insideBuilding: () => false,
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

function contextFor(ways: WalkWay[], exposure: ExposureFn): RoutingContext {
  return {
    area: { key: 'test', bboxXY: [-2000, -2000, 2000, 2000], buildings: [], trees: [], canopies: [], ways, blockedNodeIds: [] },
    graph: buildGraph(ways),
    scene: fakeScene(exposure),
    exposureCache: new Map(),
  };
}

function at(x: number, y: number): LatLon {
  const [lat, lon] = toLatLon(x, y);
  return { lat, lon };
}

function option(extra: Partial<DepartureOption> & { time: string }): Omit<DepartureOption, 'score'> {
  return { distanceM: 1000, durationS: 770, shadeFraction: 0.5, sunDistanceM: 500, sunFactor: 1, feltMeanC: 25, ...extra };
}

describe('departureTimes', () => {
  const start = new Date('2026-07-15T12:00:00+02:00');

  it('domyślnie 6 godzin co 30 minut = 13 chwil, pierwsza to początek okna', () => {
    const times = departureTimes(start);
    expect(times).toHaveLength(13);
    expect(times[0].getTime()).toBe(start.getTime());
    expect(times[1].getTime() - times[0].getTime()).toBe(30 * 60_000);
    expect(times.at(-1)!.toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });

  it(`nigdy nie zwraca więcej niż ${MAX_DEPARTURE_SAMPLES} chwil — przy gęstym kroku krok jest wydłużany`, () => {
    const dense = departureTimes(start, 16, 15);
    expect(dense).toHaveLength(33);
    expect(dense[1].getTime() - dense[0].getTime()).toBe(30 * 60_000);
    expect(dense.at(-1)!.getTime() - start.getTime()).toBe(16 * 3600_000);
    expect(departureTimes(start, 8, 15)).toHaveLength(33);
    expect(departureTimes(start, 1, 15)).toHaveLength(5);
    expect(departureTimes(start, 0.25, 30)).toHaveLength(1);
  });
});

describe('ocena godzin wyjścia', () => {
  it('komfort cieplny: pełny w 15–24 °C, zerowy przy 40 °C i −10 °C', () => {
    expect(thermalComfort(20)).toBe(1);
    expect(thermalComfort(15)).toBe(1);
    expect(thermalComfort(24)).toBe(1);
    expect(thermalComfort(32)).toBeCloseTo(0.5, 9);
    expect(thermalComfort(45)).toBe(0);
    expect(thermalComfort(2.5)).toBeCloseTo(0.5, 9);
    expect(thermalComfort(-20)).toBe(0);
  });

  it('wynik mieści się w 0..100 i rośnie z cieniem, chłodem i krótszą trasą', () => {
    const base = option({ time: '2026-07-15T10:00:00Z' });
    const scores = scoreDepartures(
      [
        base,
        { ...base, shadeFraction: 0.9 },
        { ...base, feltMeanC: 36 },
        { ...base, distanceM: 1300 },
        { ...base, sunFactor: 0 },
        { ...base, shadeFraction: 1, feltMeanC: 20 },
      ],
      'shade',
    );
    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[2]).toBeLessThan(scores[0]);
    expect(scores[3]).toBeLessThan(scores[0]);
    expect(scores[4]).toBeGreaterThan(scores[0]);
    expect(scores[5]).toBe(100);
  });

  it('w trybie zimowym punktowane jest słońce, nie cień', () => {
    const cold = { feltMeanC: 4 };
    const [shady, sunny, night] = scoreDepartures(
      [
        option({ time: 'a', shadeFraction: 0.9, ...cold }),
        option({ time: 'b', shadeFraction: 0.1, ...cold }),
        option({ time: 'c', shadeFraction: 1, sunFactor: 0, ...cold }),
      ],
      'sun',
    );
    expect(sunny).toBeGreaterThan(shady);
    expect(shady).toBeGreaterThan(night);
  });

  it('bez pogody choć dla jednej opcji składnik cieplny jest pomijany dla wszystkich', () => {
    const scores = scoreDepartures(
      [option({ time: 'a', feltMeanC: 39, shadeFraction: 1 }), option({ time: 'b', feltMeanC: null, shadeFraction: 1 })],
      'shade',
    );
    expect(scores).toEqual([100, 100]);
  });

  it('wybiera najlepszą porę (przy remisie wcześniejszą) i opisuje ją jednym zdaniem', () => {
    const response = buildDepartureResponse(
      [
        option({ time: '2026-07-15T12:00:00.000Z', shadeFraction: 0.4, feltMeanC: 34 }),
        option({ time: '2026-07-15T14:00:00.000Z', shadeFraction: 0.5, feltMeanC: 33 }),
        option({ time: '2026-07-15T16:30:00.000Z', shadeFraction: 0.82, feltMeanC: 28 }),
        option({ time: '2026-07-15T17:00:00.000Z', shadeFraction: 0.82, feltMeanC: 28 }),
      ],
      'shade',
    );
    expect(response.options).toHaveLength(4);
    expect(response.bestIndex).toBe(2);
    expect(response.options[2].score).toBe(response.options[3].score);
    // Godziny w czasie lokalnym Krakowa (UTC+2 latem).
    expect(response.summary).toBe('Najlepiej wyjść o 18:30 — 82% trasy w cieniu i o 6°C chłodniej niż o 14:00.');
  });

  it('podsumowania: wyjście od razu, brak różnicy temperatur, tryb zimowy, noc', () => {
    const now = buildDepartureResponse(
      [option({ time: '2026-07-15T06:00:00.000Z', shadeFraction: 0.9, feltMeanC: 20 }), option({ time: '2026-07-15T08:00:00.000Z', shadeFraction: 0.3, feltMeanC: 27 })],
      'shade',
    );
    expect(now.bestIndex).toBe(0);
    expect(now.summary).toBe('Najlepiej wyjść od razu (o 08:00) — 90% trasy w cieniu, później nie będzie lepiej.');

    const noWeather = buildDepartureResponse(
      [option({ time: '2026-07-15T10:00:00.000Z', shadeFraction: 0.3, feltMeanC: null }), option({ time: '2026-07-15T15:00:00.000Z', shadeFraction: 0.7, feltMeanC: null })],
      'shade',
    );
    expect(noWeather.summary).toBe('Najlepiej wyjść o 17:00 — 70% trasy w cieniu (o 12:00: 30%).');

    // Lepsza pora dzięki chmurom, a nie większemu udziałowi cienia — podsumowanie nie zestawia wtedy procentów.
    const cloudy = buildDepartureResponse(
      [
        option({ time: '2026-06-20T06:00:00.000Z', shadeFraction: 0.85, sunFactor: 0.77, feltMeanC: 21.2, distanceM: 2015 }),
        option({ time: '2026-06-20T07:00:00.000Z', shadeFraction: 0.61, sunFactor: 0.15, feltMeanC: 21, distanceM: 1797 }),
      ],
      'shade',
    );
    expect(cloudy.bestIndex).toBe(1);
    expect(cloudy.summary).toBe('Najlepiej wyjść o 09:00 — słońce będzie wyraźnie słabsze.');

    const winter = buildDepartureResponse(
      [option({ time: '2026-01-15T08:00:00.000Z', shadeFraction: 0.8, feltMeanC: -3 }), option({ time: '2026-01-15T11:00:00.000Z', shadeFraction: 0.35, feltMeanC: 2 })],
      'sun',
    );
    expect(winter.bestIndex).toBe(1);
    expect(winter.summary).toBe('Najlepiej wyjść o 12:00 — 65% trasy w słońcu i o 5°C cieplej niż o 09:00.');

    const options: DepartureOption[] = [
      { ...option({ time: '2026-07-15T21:00:00.000Z', sunFactor: 0, shadeFraction: 1 }), score: 90 },
      { ...option({ time: '2026-07-15T22:00:00.000Z', sunFactor: 0, shadeFraction: 1 }), score: 91 },
    ];
    expect(departureSummary(options, 1, 'shade')).toMatch(/pod horyzontem/);
    expect(departureSummary([], 0, 'shade')).toMatch(/Brak danych/);

    const evening = buildDepartureResponse(
      [option({ time: '2026-07-15T16:00:00.000Z', shadeFraction: 0.2, feltMeanC: 33 }), option({ time: '2026-07-15T19:30:00.000Z', shadeFraction: 1, sunFactor: 0, feltMeanC: 24 })],
      'shade',
    );
    expect(evening.summary).toBe('Najlepiej wyjść o 21:30 — słońce nie będzie już grzało i o 9°C chłodniej niż o 18:00.');
  });
});

describe('evaluateDepartures', () => {
  // Jedna ulica N–S; rano (słońce na wschodzie) w pełnym słońcu, po południu w cieniu zabudowy.
  const ways = [way(1, [[1, 0, 0], [2, 0, 400], [3, 0, 800]])];
  const exposure: ExposureFn = (_x, _y, sun) => (sun.azimuth < Math.PI ? 1 : 0);
  const weatherAt = (time: Date): WeatherInfo => ({
    time: time.toISOString(),
    temperatureC: 28,
    apparentTemperatureC: 29,
    cloudCoverPct: 0,
    directRadiationWm2: 800,
    uvIndex: 6,
    source: 'open-meteo',
  });

  it('ocenia każdą chwilę okna i wskazuje porę, gdy trasa jest w cieniu', async () => {
    const ctx = contextFor(ways, exposure);
    const times = departureTimes(new Date('2026-07-15T10:00:00+02:00'), 6, 60);
    let pauses = 0;
    const response = await evaluateDepartures(
      ctx,
      { from: at(0, 0), to: at(0, 800), shadePreference: 0.5, walkSpeed: 1.3, heat: NO_HEAT, comfort: 'shade' },
      times,
      (time) => ({ weather: weatherAt(time), sunFactor: sunFactorFrom(sunInfo(time), weatherAt(time)) }),
      async () => {
        pauses++;
      },
    );
    expect(response.options).toHaveLength(7);
    expect(pauses).toBe(6);
    expect(response.options.map((o) => o.time)).toEqual(times.map((t) => t.toISOString()));
    for (const o of response.options) {
      expect(o.distanceM).toBeCloseTo(800, 6);
      expect(o.durationS).toBeCloseTo(800 / 1.3, 6);
      expect(o.sunFactor).toBeGreaterThan(0.9);
      expect(o.sunDistanceM).toBeCloseTo(o.distanceM * (1 - o.shadeFraction), 6);
    }
    // 10:00–12:00 słońce na wschodzie (pełna ekspozycja), od 13:00 czasu letniego — za południkiem.
    expect(response.options[0].shadeFraction).toBeCloseTo(0, 6);
    expect(response.options.at(-1)!.shadeFraction).toBeCloseTo(1, 6);
    const best = response.options[response.bestIndex];
    expect(best.shadeFraction).toBeCloseTo(1, 6);
    expect(best.score).toBeGreaterThan(response.options[0].score + 30);
    expect(best.feltMeanC!).toBeLessThan(response.options[0].feltMeanC! - 4);
    expect(response.summary).toMatch(/^Najlepiej wyjść o 1[3-6]:00 — 100% trasy w cieniu i o \d+°C chłodniej niż o 10:00\.$/);
    // Wszystkie próbki korzystają z jednego cache ekspozycji kontekstu.
    expect(ctx.exposureCache.size).toBeGreaterThan(0);
  });

  it('33 chwile wyjścia dla ~1,5 km trasy w gęstej siatce ulic liczy się w rozsądnym czasie', async () => {
    const size = 40;
    const spacing = 60;
    const grid: WalkWay[] = [];
    for (let line = 0; line < size; line++) {
      const horizontal: [number, number, number][] = [];
      const vertical: [number, number, number][] = [];
      for (let k = 0; k < size; k++) {
        horizontal.push([k * 1000 + line, k * spacing, line * spacing]);
        vertical.push([line * 1000 + k, line * spacing, k * spacing]);
      }
      grid.push(way(line, horizontal), way(100 + line, vertical, { kind: 'street', sideOffsetM: 5 }));
    }
    const checker: ExposureFn = (x, y, sun) => ((Math.floor(x / 90) + Math.floor(y / 130) + (sun.azimuth < Math.PI ? 0 : 1)) % 2 === 0 ? 1 : 0.1);
    const ctx = contextFor(grid, checker);
    const times = departureTimes(new Date('2026-07-15T06:00:00+02:00'), 16, 30);
    expect(times).toHaveLength(33);

    const started = performance.now();
    const response = await evaluateDepartures(
      ctx,
      { from: at(300, 300), to: at(1380, 1320), shadePreference: 0.5, walkSpeed: 1.3, heat: NO_HEAT, comfort: 'shade' },
      times,
      (time) => ({ weather: null, sunFactor: sunFactorFrom(sunInfo(time), null) }),
    );
    const elapsedMs = performance.now() - started;

    expect(response.options).toHaveLength(33);
    expect(response.options[0].distanceM).toBeGreaterThan(1400);
    expect(response.options.every((o) => o.feltMeanC === null)).toBe(true);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
