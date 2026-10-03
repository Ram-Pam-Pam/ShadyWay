import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LatLon, RouteRequest, WeatherInfo } from '../shared/types.ts';
import type { AreaData, BBoxLatLon, CoolSpotXY, IShadeScene, RoutingContext, SunPosition, WalkWay } from '../server/contracts.ts';
import { toLatLon, toXY } from '../server/geo/project.ts';
import { buildGraph } from '../server/graph/build.ts';
import { OutOfAreaError, TooFarError } from '../server/graph/context.ts';
import { NoRouteError } from '../server/graph/route.ts';
import { DataUnavailableError } from '../server/osm/store.ts';
import { coolSpotsIn, heightSourceOf, planDeparture, planRoute, resolveComfort, ServiceError } from '../server/service.ts';
import { shadowBucket, shadowSun, shadowTilesFor } from '../server/shade/tiles.ts';
import {
  BadRequestError,
  parseBBox,
  parseDepartureRequest,
  parseKinds,
  parseRouteRequest,
  parseTime,
} from '../server/validate.ts';
import { shadowWindow, type Bbox } from '../web/src/shadowWindow.ts';

// Serwis jest testowany bez sieci: dane mapy, pogoda, LiDAR i mapa ciepła są podstawiane.
const fakes = vi.hoisted(() => ({
  context: null as unknown,
  contextError: null as Error | null,
  weather: null as unknown,
  area: null as unknown,
}));

vi.mock('../server/graph/context.ts', () => {
  class OutOfAreaError extends Error {}
  class TooFarError extends Error {}
  return {
    OutOfAreaError,
    TooFarError,
    getRoutingContext: async () => {
      if (fakes.contextError) throw fakes.contextError;
      return fakes.context;
    },
  };
});
vi.mock('../server/weather/openmeteo.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/weather/openmeteo.ts')>()),
  getWeather: async (time: Date) => (fakes.weather as (time: Date) => unknown)(time),
}));
vi.mock('../server/lidar/store.ts', () => ({ attachLidar: async () => undefined }));
vi.mock('../server/heat/lst.ts', () => ({
  getHeatField: () => ({ available: false, sampleC: () => null, normalized: () => 0, meta: () => ({ available: false }), overlayPng: () => null }),
}));
vi.mock('../server/osm/store.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/osm/store.ts')>()),
  loadArea: async () => fakes.area,
}));

describe('parseTime', () => {
  it('przyjmuje ISO 8601 z offsetem lub Z', () => {
    expect(parseTime('2026-07-15T15:00:00+02:00').toISOString()).toBe('2026-07-15T13:00:00.000Z');
    expect(parseTime(' 2026-07-15T13:00Z ').toISOString()).toBe('2026-07-15T13:00:00.000Z');
    expect(parseTime('2028-02-29T12:00:00+01:00').toISOString()).toBe('2028-02-29T11:00:00.000Z');
  });

  it('odrzuca daty, których nie ma w kalendarzu, zamiast po cichu liczyć inny dzień', () => {
    for (const value of ['2026-02-30T15:00:00+02:00', '2026-02-29T12:00:00Z', '2026-04-31T15:00:00Z', '2026-13-01T10:00:00Z', '2026-00-10T10:00:00Z']) {
      expect(() => parseTime(value), value).toThrow(BadRequestError);
    }
    expect(() => parseTime('2026-02-30T15:00:00+02:00')).toThrow(/nie istnieje w kalendarzu/);
  });

  it('odrzuca brak czasu, czas bez offsetu i śmieci', () => {
    for (const value of [undefined, '', 'abc', '2026-07-15T15:00:00', '2026-07-15', '2026-07-15T25:00:00Z', 12]) {
      expect(() => parseTime(value), String(value)).toThrow(BadRequestError);
    }
  });
});

describe('kafle warstwy cieni', () => {
  const RAD = Math.PI / 180;
  const sun = (azimuthDeg: number, altitudeDeg: number): SunPosition => ({ azimuth: azimuthDeg * RAD, altitude: altitudeDeg * RAD });
  const view: BBoxLatLon = { west: 19.93, south: 50.06, east: 19.95, north: 50.07 };

  it('siatka nie zależy od okna: przesunięcie okna o kilka metrów daje te same kafle', () => {
    const a = shadowTilesFor(view, sun(180, 60));
    const b = shadowTilesFor({ west: 19.9301, south: 50.0601, east: 19.9501, north: 50.0701 }, sun(180, 60));
    expect(a.length).toBeGreaterThan(10);
    expect(b).toEqual(a);
  });

  it('okno jest poszerzane w stronę słońca o zasięg cienia', () => {
    const count = (s: SunPosition): number => shadowTilesFor(view, s).length;
    expect(count(sun(180, 10))).toBeGreaterThan(count(sun(180, 60)));
    const south = (s: SunPosition): number => Math.min(...shadowTilesFor(view, s).map((t) => t.sy));
    const north = (s: SunPosition): number => Math.max(...shadowTilesFor(view, s).map((t) => t.sy));
    // Słońce z południa: dochodzą kafle na południe od okna, na północy nic się nie zmienia.
    expect(south(sun(180, 10))).toBeLessThan(south(sun(0.001, 10)));
    expect(north(sun(180, 10))).toBeLessThan(north(sun(0.001, 10)));
  });

  it('nocą i poza miastem nie ma kafli', () => {
    expect(shadowTilesFor(view, sun(180, -5))).toEqual([]);
    expect(shadowTilesFor({ west: 21, south: 52, east: 21.01, north: 52.01 }, sun(180, 40))).toEqual([]);
  });

  it('przedział czasu ma 5 minut, a słońce jest jedno dla całego przedziału', () => {
    const a = shadowBucket(new Date('2026-07-15T13:00:00Z'));
    expect(shadowBucket(new Date('2026-07-15T13:04:59Z'))).toBe(a);
    expect(shadowBucket(new Date('2026-07-15T13:05:00Z'))).toBe(a + 1);
    expect(shadowSun(a).altitude).toBeGreaterThan(0.5);
  });
});

describe('shadowWindow (okno zapytania o cienie)', () => {
  const center = { lat: 50.0614, lon: 19.9372 };
  const viewOf = (widthM: number, heightM: number): Bbox => {
    const [x, y] = toXY(center.lat, center.lon);
    const [south, west] = toLatLon(x - widthM / 2, y - heightM / 2);
    const [north, east] = toLatLon(x + widthM / 2, y + heightM / 2);
    return [west, south, east, north];
  };
  const areaKm2 = ([west, south, east, north]: Bbox): number => {
    const [minX, minY] = toXY(south, west);
    const [maxX, maxY] = toXY(north, east);
    return ((maxX - minX) * (maxY - minY)) / 1e6;
  };

  it('widok mieszczący się w limicie jest brany w całości — niezależnie od zoomu', () => {
    // Trasa ok. 1 km dopasowana na ekranie 1440 × 900 (zoom ~15,3): 2,6 × 1,6 km... tu 2,3 × 1,45 km.
    const view = viewOf(2300, 1450);
    expect(shadowWindow(view, center)).toEqual({ kind: 'bbox', bbox: view, partial: false });
  });

  it('widok nieco ponad limit (pochylona mapa 3D) jest zmniejszany do limitu wokół środka mapy', () => {
    const view = viewOf(2395, 1869); // 4,48 km² — przypadek z budynkami 3D na ekranie 1920 × 1080
    const result = shadowWindow(view, center);
    expect(result.kind).toBe('bbox');
    if (result.kind !== 'bbox') return;
    expect(result.partial).toBe(true);
    expect(areaKm2(result.bbox)).toBeLessThanOrEqual(4);
    expect(areaKm2(result.bbox)).toBeGreaterThan(3.7);
    const [west, south, east, north] = result.bbox;
    expect((west + east) / 2).toBeCloseTo(center.lon, 6);
    expect((south + north) / 2).toBeCloseTo(center.lat, 6);
  });

  it('okno nie wychodzi poza widok, gdy środek mapy leży przy jego krawędzi (mapa pochylona)', () => {
    const view = viewOf(2600, 2600);
    const result = shadowWindow(view, { lat: view[1] + 0.001, lon: center.lon });
    expect(result.kind).toBe('bbox');
    if (result.kind !== 'bbox') return;
    expect(result.bbox[1]).toBeCloseTo(view[1], 9);
    expect(result.bbox[3]).toBeLessThan(view[3]);
  });

  it('widok wielokrotnie większy od limitu nie pobiera cieni', () => {
    expect(shadowWindow(viewOf(5900, 3300), center)).toEqual({ kind: 'too-large' });
  });
});

// ═════════════════════════════ v2 ═════════════════════════════

describe('walidacja zapytań v2', () => {
  const from = { lat: 50.06, lon: 19.93 };
  const to = { lat: 50.065, lon: 19.94 };
  const time = '2026-07-15T13:00:00+02:00';

  it('parseRouteRequest: stare zapytanie działa bez zmian, nowe pola mają wartości domyślne', () => {
    const parsed = parseRouteRequest({ from, to, time });
    expect(parsed).toEqual({
      from,
      to,
      departure: new Date(time),
      shadePreference: 0.5,
      walkSpeed: undefined,
      mobility: 'default',
      comfort: 'auto',
      viaCoolSpot: false,
    });
  });

  it('parseRouteRequest: przyjmuje wszystkie nowe pola', () => {
    const parsed = parseRouteRequest({ from, to, time, shadePreference: 1, walkSpeed: 0.9, mobility: 'senior', comfort: 'sun', viaCoolSpot: true });
    expect(parsed).toMatchObject({ shadePreference: 1, walkSpeed: 0.9, mobility: 'senior', comfort: 'sun', viaCoolSpot: true });
  });

  it('parseRouteRequest: błędy mają polskie komunikaty wskazujące pole', () => {
    const bad = (extra: Record<string, unknown>, pattern: RegExp): void => {
      expect(() => parseRouteRequest({ from, to, time, ...extra }), JSON.stringify(extra)).toThrow(BadRequestError);
      expect(() => parseRouteRequest({ from, to, time, ...extra })).toThrow(pattern);
    };
    bad({ mobility: 'bike' }, /„mobility”/);
    bad({ mobility: 5 }, /„mobility”/);
    bad({ comfort: 'warm' }, /„comfort”/);
    bad({ viaCoolSpot: 'yes' }, /„viaCoolSpot”/);
    bad({ walkSpeed: 0.1 }, /„walkSpeed”/);
    bad({ walkSpeed: '1.3' }, /„walkSpeed”/);
    bad({ shadePreference: 2 }, /„shadePreference”/);
    bad({ from: { lat: 'x', lon: 1 } }, /punktu startowego/);
    bad({ to: null }, /punktu docelowego/);
    bad({ time: '2026-07-15' }, /ISO 8601/);
    for (const body of [null, undefined, 'tekst', 7, []]) {
      expect(() => parseRouteRequest(body), String(body)).toThrow(/Brak danych zapytania/);
    }
  });

  it('parseDepartureRequest: wartości domyślne i zakresy', () => {
    expect(parseDepartureRequest({ from, to })).toEqual({
      from,
      to,
      start: undefined,
      windowHours: 6,
      stepMinutes: 30,
      shadePreference: 0.5,
      mobility: 'default',
      comfort: 'auto',
    });
    const full = parseDepartureRequest({ from, to, start: time, windowHours: 16, stepMinutes: 15, mobility: 'accessible', comfort: 'shade', shadePreference: 0 });
    expect(full).toMatchObject({ start: new Date(time), windowHours: 16, stepMinutes: 15, mobility: 'accessible', comfort: 'shade', shadePreference: 0 });
    expect(() => parseDepartureRequest({ from, to, windowHours: 17 })).toThrow(/„windowHours”/);
    expect(() => parseDepartureRequest({ from, to, windowHours: 0 })).toThrow(/„windowHours”/);
    expect(() => parseDepartureRequest({ from, to, stepMinutes: 10 })).toThrow(/„stepMinutes”/);
    expect(() => parseDepartureRequest({ from, to, start: 'jutro' })).toThrow(/„start”/);
    expect(() => parseDepartureRequest({ from, to, start: '2026-02-30T10:00:00Z' })).toThrow(/nie istnieje w kalendarzu/);
    expect(() => parseDepartureRequest({ from })).toThrow(/punktu docelowego/);
  });

  it('parseKinds i parseBBox', () => {
    expect(parseKinds(undefined)).toBeUndefined();
    expect(parseKinds('')).toBeUndefined();
    expect(parseKinds('fountain, drinking_water,fountain')).toEqual(['fountain', 'drinking_water']);
    expect(() => parseKinds('fountain,pub')).toThrow(/„kinds”/);
    expect(() => parseKinds(5)).toThrow(BadRequestError);
    expect(parseBBox('19.93,50.06,19.95,50.07')).toEqual({ west: 19.93, south: 50.06, east: 19.95, north: 50.07 });
    expect(() => parseBBox('19.95,50.06,19.93,50.07')).toThrow(/„bbox”/);
    expect(() => parseBBox('1,2,3')).toThrow(/„bbox”/);
    expect(() => parseBBox(undefined)).toThrow(BadRequestError);
  });
});

describe('service — rozstrzyganie trybu i źródła wysokości', () => {
  const weather = (apparent: number | null, temperature: number | null = apparent): WeatherInfo => ({
    time: '2026-07-15T11:00:00.000Z',
    temperatureC: temperature,
    apparentTemperatureC: apparent,
    cloudCoverPct: 0,
    directRadiationWm2: 700,
    uvIndex: 5,
    source: 'open-meteo',
  });
  const july = new Date('2026-07-15T13:00:00+02:00');
  const january = new Date('2026-01-15T13:00:00+01:00');

  it('jawny tryb wygrywa; „auto” zależy od temperatury odczuwalnej (próg 12 °C)', () => {
    expect(resolveComfort('shade', weather(-5), january)).toBe('shade');
    expect(resolveComfort('sun', weather(35), july)).toBe('sun');
    expect(resolveComfort('auto', weather(11.9), july)).toBe('sun');
    expect(resolveComfort('auto', weather(12), january)).toBe('shade');
    // Brak odczuwalnej → temperatura powietrza.
    expect(resolveComfort('auto', weather(null, 5), july)).toBe('sun');
  });

  it('bez pogody decyduje miesiąc: listopad–marzec to tryb zimowy', () => {
    const unavailable: WeatherInfo = { ...weather(null, null), source: 'unavailable' };
    for (const [iso, expected] of [
      ['2026-01-15T12:00:00+01:00', 'sun'],
      ['2026-03-31T12:00:00+02:00', 'sun'],
      ['2026-04-01T12:00:00+02:00', 'shade'],
      ['2026-10-31T12:00:00+01:00', 'shade'],
      ['2026-11-01T12:00:00+01:00', 'sun'],
      // Sylwester o 23:30 UTC to już styczeń w Krakowie.
      ['2026-12-31T23:30:00Z', 'sun'],
    ] as const) {
      expect(resolveComfort('auto', null, new Date(iso)), iso).toBe(expected);
      expect(resolveComfort('auto', unavailable, new Date(iso)), iso).toBe(expected);
    }
  });

  it('heightSource wynika z pokrycia danymi LiDAR', () => {
    expect(heightSourceOf({})).toBe('osm');
    expect(heightSourceOf({ lidar: null })).toBe('osm');
    expect(heightSourceOf({ lidar: { vegetation: null, terrain: null, coverage: 0 } })).toBe('osm');
    expect(heightSourceOf({ lidar: { vegetation: null, terrain: null, coverage: 0.5 } })).toBe('mixed');
    expect(heightSourceOf({ lidar: { vegetation: null, terrain: null, coverage: 0.95 } })).toBe('lidar');
  });
});

describe('service — planRoute / planDeparture / coolSpotsIn (bez sieci)', () => {
  type ExposureFn = (x: number, y: number, sun: SunPosition) => number;

  function fakeScene(exposure: ExposureFn): IShadeScene {
    return {
      exposureAt: (x, y, sun) => (sun.altitude <= 0 ? 0 : exposure(x, y, sun)),
      polylineExposure(coords, sun) {
        if (sun.altitude <= 0) return 0;
        let sum = 0;
        let count = 0;
        for (let i = 2; i < coords.length; i += 2) {
          const dx = coords[i] - coords[i - 2];
          const dy = coords[i + 1] - coords[i - 1];
          const parts = Math.max(1, Math.round(Math.hypot(dx, dy) / 2));
          for (let k = 0; k < parts; k++) {
            const t = (k + 0.5) / parts;
            sum += exposure(coords[i - 2] + dx * t, coords[i - 1] + dy * t, sun);
            count++;
          }
        }
        return sum / count;
      },
      insideBuilding: () => false,
      shadowPolygons: () => [],
    };
  }

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

  /** Dwie równoległe ulice N–S (x = 0 w słońcu rano i w południe, x = 50 w cieniu) z przecznicami. */
  function context(spots: CoolSpotXY[] = []): RoutingContext {
    const ways = [
      way(1, [[1, 0, 0], [3, 0, 500]]),
      way(2, [[4, 50, 0], [5, 50, 500]]),
      way(3, [[1, 0, 0], [4, 50, 0]]),
      way(4, [[3, 0, 500], [5, 50, 500]]),
    ];
    const area: AreaData = { key: 'test', bboxXY: [-2000, -2000, 2000, 2000], buildings: [], trees: [], canopies: [], ways, blockedNodeIds: [], coolSpots: spots };
    return { area, graph: buildGraph(ways), scene: fakeScene((x) => (Math.abs(x - 50) <= 10 ? 0 : 1)), exposureCache: new Map() };
  }

  const at = (x: number, y: number): LatLon => {
    const [lat, lon] = toLatLon(x, y);
    return { lat, lon };
  };
  const weatherWith = (apparent: number) => (time: Date): WeatherInfo => ({
    time: time.toISOString(),
    temperatureC: apparent - 1,
    apparentTemperatureC: apparent,
    cloudCoverPct: 0,
    directRadiationWm2: 800,
    uvIndex: 6,
    source: 'open-meteo',
  });
  const noWeather = (time: Date): WeatherInfo => ({
    time: time.toISOString(),
    temperatureC: null,
    apparentTemperatureC: null,
    cloudCoverPct: null,
    directRadiationWm2: null,
    uvIndex: null,
    source: 'unavailable',
  });
  const request = (extra: Partial<RouteRequest> = {}): RouteRequest => ({ from: at(0, 0), to: at(0, 500), time: '2026-07-15T12:00:00+02:00', ...extra });

  beforeEach(() => {
    fakes.context = context();
    fakes.contextError = null;
    fakes.weather = weatherWith(31);
    fakes.area = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('planRoute: latem „auto” to tryb cienia; odpowiedź niesie wszystkie pola v2', async () => {
    const response = await planRoute(request());
    expect(response.comfort).toBe('shade');
    expect(response.mobility).toBe('default');
    expect(response.heightSource).toBe('osm');
    expect(response.leafOff).toBe(false);
    expect(response.sun.isDay).toBe(true);
    expect(response.sunFactor).toBe(1);
    expect(response.weather?.apparentTemperatureC).toBe(31);
    expect(response.routes.map((r) => r.label)).toEqual(['Najkrótsza', 'Zbalansowana']);
    expect(response.routes[0].durationS).toBeCloseTo(500 / 1.3, 6);
    for (const route of response.routes) {
      expect(route.steps.length).toBeGreaterThanOrEqual(2);
      expect(route.thermal.feltShadeC).toBe(31);
      expect(route.coolSpots).toEqual([]);
    }
    expect(response.routes[1].thermal.feltMeanC!).toBeLessThan(response.routes[0].thermal.feltMeanC!);
    expect(response.warnings).toEqual(['Brak mapy temperatury powierzchni (LST) — trasy uwzględniają tylko cień.']);
  });

  it('planRoute: gdy jest chłodno, „auto” szuka słońca i mówi o tym użytkownikowi', async () => {
    fakes.weather = weatherWith(6);
    // Scena: w cieniu tylko ulica B — najkrótsza (ulicą A) jest już w pełni nasłoneczniona.
    const response = await planRoute(request({ time: '2026-10-20T12:00:00+02:00' }));
    expect(response.comfort).toBe('sun');
    expect(response.leafOff).toBe(false);
    expect(response.routes).toHaveLength(1);
    expect(response.warnings.some((w) => /tryb zimowy/.test(w) && /odczuwalnie 6°C/.test(w))).toBe(true);
    expect(response.warnings.some((w) => /LST/.test(w))).toBe(false);
    // Jawny tryb cienia mimo chłodu.
    const forced = await planRoute(request({ time: '2026-10-20T12:00:00+02:00', comfort: 'shade' }));
    expect(forced.comfort).toBe('shade');
    expect(forced.routes).toHaveLength(2);
    expect(forced.warnings.some((w) => /tryb zimowy/.test(w))).toBe(false);
  });

  it('planRoute: bez pogody decyduje pora roku, a odpowiedź ma weather = null i ostrzeżenie', async () => {
    fakes.weather = noWeather;
    const winter = await planRoute(request({ time: '2026-01-15T12:00:00+01:00' }));
    expect(winter.comfort).toBe('sun');
    expect(winter.leafOff).toBe(true);
    expect(winter.weather).toBeNull();
    expect(winter.warnings).toContain('Brak danych pogodowych dla tej godziny — przyjmujemy bezchmurne niebo.');
    expect(winter.routes[0].thermal).toEqual({ feltSunC: null, feltShadeC: null, feltMeanC: null, stress: null });
    const summer = await planRoute(request());
    expect(summer.comfort).toBe('shade');
  });

  it('planRoute: profil poruszania się ustawia domyślną prędkość; jawna prędkość ma pierwszeństwo', async () => {
    const accessible = await planRoute(request({ mobility: 'accessible' }));
    expect(accessible.mobility).toBe('accessible');
    expect(accessible.routes[0].durationS).toBeCloseTo(500 / 1.1, 6);
    const senior = await planRoute(request({ mobility: 'senior' }));
    expect(senior.routes[0].durationS).toBeCloseTo(500 / 1.0, 6);
    const fast = await planRoute(request({ mobility: 'senior', walkSpeed: 2 }));
    expect(fast.routes[0].durationS).toBeCloseTo(250, 6);
  });

  it('planRoute: viaCoolSpot i źródło wysokości z LiDAR', async () => {
    const ctx = context([{ id: 'node/7', kind: 'drinking_water', x: 62, y: 250, name: 'Zdrój' }]);
    ctx.area.lidar = { vegetation: null, terrain: null, coverage: 1 };
    fakes.context = ctx;
    const response = await planRoute(request({ viaCoolSpot: true }));
    expect(response.heightSource).toBe('lidar');
    expect(response.routes[1].via).toMatchObject({ id: 'node/7', kind: 'drinking_water', name: 'Zdrój' });
    expect(response.routes[1].coolSpots.map((s) => s.id)).toEqual(['node/7']);
  });

  it('planRoute: nocą zwraca tylko najkrótszą z ostrzeżeniem', async () => {
    const response = await planRoute(request({ time: '2026-07-15T01:00:00+02:00' }));
    expect(response.sunFactor).toBe(0);
    expect(response.routes).toHaveLength(1);
    expect(response.warnings[0]).toMatch(/pod horyzontem/);
    expect(response.routes[0].steps[0].text).not.toMatch(/cieniu|słońcu/);
  });

  it('błędy są zgłaszane jako ServiceError z kodem z kontraktu i polskim komunikatem', async () => {
    const codeOf = async (run: () => Promise<unknown>): Promise<[string, string]> => {
      try {
        await run();
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceError);
        return [(error as ServiceError).code, (error as ServiceError).message];
      }
      throw new Error('oczekiwano błędu');
    };
    expect((await codeOf(() => planRoute({} as RouteRequest)))[0]).toBe('BAD_REQUEST');
    const [code, message] = await codeOf(() => planRoute(request({ mobility: 'rower' as never })));
    expect(code).toBe('BAD_REQUEST');
    expect(message).toMatch(/„mobility”/);
    expect((await codeOf(() => planDeparture({ from: at(0, 0), to: at(0, 500), windowHours: 99 })))[0]).toBe('BAD_REQUEST');

    // Punkt 400 m od sieci pieszej.
    expect((await codeOf(() => planRoute(request({ from: at(-400, 250) }))))[0]).toBe('NO_ROUTE');

    fakes.contextError = new OutOfAreaError('Punkt startowy znajduje się poza obsługiwanym obszarem Krakowa.');
    expect(await codeOf(() => planRoute(request()))).toEqual(['OUT_OF_AREA', 'Punkt startowy znajduje się poza obsługiwanym obszarem Krakowa.']);
    fakes.contextError = new TooFarError('Punkty są zbyt daleko od siebie.');
    expect((await codeOf(() => planDeparture({ from: at(0, 0), to: at(0, 500) })))[0]).toBe('TOO_FAR');
    fakes.contextError = new NoRouteError();
    expect((await codeOf(() => planRoute(request())))[0]).toBe('NO_ROUTE');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakes.contextError = new DataUnavailableError('Nie udało się pobrać danych mapy. Spróbuj ponownie za chwilę. [HTTP 504]');
    expect(await codeOf(() => planRoute(request()))).toEqual(['DATA_UNAVAILABLE', 'Nie udało się pobrać danych mapy. Spróbuj ponownie za chwilę.']);
    expect(warn).toHaveBeenCalled();

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fakes.contextError = new TypeError('boom');
    const [internalCode, internalMessage] = await codeOf(() => planRoute(request()));
    expect(internalCode).toBe('INTERNAL');
    expect(internalMessage).not.toMatch(/boom/);
    expect(error).toHaveBeenCalled();
  });

  it('planDeparture: domyślne okno 6 h co 30 min od podanego początku', async () => {
    const response = await planDeparture({ from: at(0, 0), to: at(0, 500), start: '2026-07-15T09:00:00+02:00' });
    expect(response.options).toHaveLength(13);
    expect(response.options[0].time).toBe('2026-07-15T07:00:00.000Z');
    expect(response.options.at(-1)!.time).toBe('2026-07-15T13:00:00.000Z');
    expect(response.bestIndex).toBeGreaterThanOrEqual(0);
    expect(response.bestIndex).toBeLessThan(13);
    for (const option of response.options) {
      expect(option.score).toBeGreaterThanOrEqual(0);
      expect(option.score).toBeLessThanOrEqual(100);
      expect(option.feltMeanC).not.toBeNull();
      // Trasa zbalansowana idzie zacienioną ulicą B.
      expect(option.distanceM).toBeCloseTo(600, 6);
      expect(option.shadeFraction).toBeGreaterThan(0.8);
    }
    expect(response.summary).toMatch(/^Najlepiej wyjść /);
  });

  it('planDeparture: bez „start” okno zaczyna się teraz; krok i długość okna z zapytania', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T08:10:00Z'));
    const response = await planDeparture({ from: at(0, 0), to: at(0, 500), windowHours: 2, stepMinutes: 60, mobility: 'senior', comfort: 'shade' });
    expect(response.options.map((o) => o.time)).toEqual(['2026-07-15T08:10:00.000Z', '2026-07-15T09:10:00.000Z', '2026-07-15T10:10:00.000Z']);
    // Profil „senior”: 1,0 m/s.
    expect(response.options[0].durationS).toBeCloseTo(response.options[0].distanceM / 1.0, 6);
  });

  it('coolSpotsIn: filtruje po oknie i rodzaju, z „time” uzupełnia cień', async () => {
    const spots: CoolSpotXY[] = [
      { id: 'w1', kind: 'drinking_water', x: 10, y: 10, name: 'Zdrój' },
      { id: 'b1', kind: 'bench', x: 20, y: 20 },
      { id: 'f1', kind: 'fountain', x: 900, y: 900 },
    ];
    fakes.area = { key: 'a', bboxXY: [-1000, -1000, 1000, 1000], buildings: [], trees: [], canopies: [], ways: [], blockedNodeIds: [], coolSpots: spots } satisfies AreaData;
    const [south, west] = toLatLon(-100, -100);
    const [north, east] = toLatLon(100, 100);
    const bbox: BBoxLatLon = { west, south, east, north };

    const all = await coolSpotsIn(bbox);
    expect(all.map((s) => s.id)).toEqual(['w1', 'b1']);
    expect(all[0]).toMatchObject({ kind: 'drinking_water', name: 'Zdrój' });
    expect(all[0]).not.toHaveProperty('shaded');
    const [x, y] = toXY(all[0].lat, all[0].lon);
    expect(x).toBeCloseTo(10, 6);
    expect(y).toBeCloseTo(10, 6);

    expect((await coolSpotsIn(bbox, { kinds: ['bench'] })).map((s) => s.id)).toEqual(['b1']);
    expect(await coolSpotsIn(bbox, { kinds: ['shelter'] })).toEqual([]);

    const timed = await coolSpotsIn(bbox, { time: new Date('2026-07-15T12:00:00+02:00') });
    expect(timed).toHaveLength(2);
    for (const spot of timed) expect(typeof spot.shaded).toBe('boolean');
  });

  it('coolSpotsIn: najwyżej 500 punktów, woda ma pierwszeństwo przed ławkami; obszar bez danych → []', async () => {
    const spots: CoolSpotXY[] = [];
    for (let i = 0; i < 600; i++) spots.push({ id: `b${i}`, kind: 'bench', x: (i % 30) * 5, y: Math.floor(i / 30) * 5 });
    spots.push({ id: 'water', kind: 'water_mist', x: 50, y: 50 });
    fakes.area = { key: 'a', bboxXY: [-1000, -1000, 1000, 1000], buildings: [], trees: [], canopies: [], ways: [], blockedNodeIds: [], coolSpots: spots } satisfies AreaData;
    const [south, west] = toLatLon(-10, -10);
    const [north, east] = toLatLon(500, 500);
    const result = await coolSpotsIn({ west, south, east, north });
    expect(result).toHaveLength(500);
    expect(result[0].id).toBe('water');

    // Kafle sprzed v2 (bez pola coolSpots) nie powodują błędu.
    fakes.area = { key: 'empty', bboxXY: [0, 0, 1, 1], buildings: [], trees: [], canopies: [], ways: [], blockedNodeIds: [] } satisfies AreaData;
    expect(await coolSpotsIn({ west, south, east, north })).toEqual([]);
  });
});
