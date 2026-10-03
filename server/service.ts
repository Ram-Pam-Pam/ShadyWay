// Logika endpointów API wydzielona z index.ts — korzysta z niej serwer HTTP i asystent AI.
// Każda funkcja sama waliduje dane wejściowe i zgłasza błędy jako ServiceError z komunikatem po polsku.

import { MAX_SHADOW_AREA_KM2, TIMEZONE } from '../shared/types.ts';
import type {
  ApiError,
  ComfortMode,
  CoolSpot,
  CoolSpotKind,
  DepartureRequest,
  DepartureResponse,
  RouteRequest,
  RouteResponse,
  SunInfo,
  WeatherInfo,
} from '../shared/types.ts';
import type { AreaData, BBoxLatLon, SunPosition } from './contracts.ts';
import { toLatLon, toXY } from './geo/project.ts';
import { isLeafOff, sunInfo, sunPosition } from './geo/sun.ts';
import { getRoutingContext, OutOfAreaError as PointOutOfAreaError, TooFarError } from './graph/context.ts';
import { departureTimes, evaluateDepartures } from './graph/departure.ts';
import { computeRoutesDetailed, defaultWalkSpeed, NoRouteError } from './graph/route.ts';
import { getHeatField } from './heat/lst.ts';
import { attachLidar } from './lidar/store.ts';
import { DataUnavailableError, loadArea, OutOfAreaError as BBoxOutOfAreaError } from './osm/store.ts';
import { sceneForArea } from './shade/cache.ts';
import { BadRequestError, parseDepartureRequest, parseRouteRequest } from './validate.ts';
import { getWeather, sunFactorFrom } from './weather/openmeteo.ts';

type ErrorCode = ApiError['code'];

/** Błąd logiki endpointu: kod z kontraktu API i komunikat po polsku, gotowy do pokazania użytkownikowi. */
export class ServiceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

/** Zamienia błędy modułów na ServiceError; nieznane błędy trafiają do logu i stają się INTERNAL. */
export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof BadRequestError) return new ServiceError('BAD_REQUEST', error.message);
  if (error instanceof PointOutOfAreaError || error instanceof BBoxOutOfAreaError) return new ServiceError('OUT_OF_AREA', error.message);
  if (error instanceof TooFarError) return new ServiceError('TOO_FAR', error.message);
  if (error instanceof NoRouteError) return new ServiceError('NO_ROUTE', error.message);
  if (error instanceof DataUnavailableError) {
    console.warn(`[osm] ${error.message}`);
    // Szczegóły techniczne w nawiasie kwadratowym zostają w logu, użytkownik dostaje sam komunikat.
    return new ServiceError('DATA_UNAVAILABLE', error.message.replace(/\s*\[[^\]]*\]\s*$/, ''));
  }
  console.error(error);
  return new ServiceError('INTERNAL', 'Wewnętrzny błąd serwera. Spróbuj ponownie za chwilę.');
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toServiceError(error);
  }
}

const OVERCAST_CLOUD_PCT = 85;
const WEAK_SUN_FACTOR = 0.3;
/** Poniżej tej temperatury odczuwalnej tryb 'auto' szuka słońca zamiast cienia. */
const SUN_SEEKING_BELOW_C = 12;
/** Miesiące (1–12), w których bez danych pogodowych zakładamy tryb zimowy. */
const COLD_MONTHS = new Set([11, 12, 1, 2, 3]);
/** Pokrycie danymi LiDAR, od którego uznajemy okolicę za opisaną w całości. */
const FULL_LIDAR_COVERAGE = 0.95;
const MAX_COOL_SPOTS = 500;
/** `shaded` dla punktów chłodu liczymy tylko dla okien do tej wielkości (większe wymagałyby sceny dla pół miasta). */
const MAX_SHADED_AREA_M2 = MAX_SHADOW_AREA_KM2 * 2.5e6;

const monthFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, month: 'numeric' });

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function usable(weather: WeatherInfo): WeatherInfo | null {
  return weather.source === 'unavailable' ? null : weather;
}

/**
 * Rozstrzyga tryb komfortu: 'auto' → 'sun', gdy temperatura odczuwalna jest poniżej ok. 12 °C, inaczej 'shade';
 * bez danych pogodowych decyduje miesiąc (listopad–marzec → 'sun').
 */
export function resolveComfort(mode: ComfortMode, weather: WeatherInfo | null, date: Date): 'shade' | 'sun' {
  if (mode !== 'auto') return mode;
  const felt = weather && weather.source !== 'unavailable' ? (weather.apparentTemperatureC ?? weather.temperatureC) : null;
  if (felt !== null) return felt < SUN_SEEKING_BELOW_C ? 'sun' : 'shade';
  return COLD_MONTHS.has(Number(monthFormat.format(date))) ? 'sun' : 'shade';
}

export function heightSourceOf(area: Pick<AreaData, 'lidar'>): RouteResponse['heightSource'] {
  const coverage = area.lidar?.coverage ?? 0;
  if (coverage >= FULL_LIDAR_COVERAGE) return 'lidar';
  return coverage > 0 ? 'mixed' : 'osm';
}

function routeWarnings(
  sun: SunInfo,
  weather: WeatherInfo,
  sunFactor: number,
  heatAvailable: boolean,
  comfort: 'shade' | 'sun',
  requested: ComfortMode,
): string[] {
  const warnings: string[] = [];
  const weatherKnown = weather.source !== 'unavailable';
  const subject = comfort === 'sun' ? 'nasłonecznienie' : 'cień';
  if (!sun.isDay) {
    warnings.push(`Słońce jest pod horyzontem — o tej porze ${subject} nie ma znaczenia, pokazujemy trasę najkrótszą.`);
  } else if (weatherKnown && weather.cloudCoverPct !== null && weather.cloudCoverPct >= OVERCAST_CLOUD_PCT && sunFactor < WEAK_SUN_FACTOR) {
    warnings.push(
      `Duże zachmurzenie (${Math.round(weather.cloudCoverPct)}%) — bezpośredniego słońca jest mało, więc ${subject} ma mniejszy wpływ na wybór trasy.`,
    );
  } else if (sunFactor < WEAK_SUN_FACTOR) {
    warnings.push(`Słońce jest teraz słabe (nisko nad horyzontem lub za chmurami) — ${subject} ma mniejszy wpływ na wybór trasy.`);
  }
  if (comfort === 'sun' && requested === 'auto' && sun.isDay) {
    const felt = weatherKnown ? (weather.apparentTemperatureC ?? weather.temperatureC) : null;
    warnings.push(
      felt !== null
        ? `Jest chłodno (odczuwalnie ${Math.round(felt)}°C) — tryb zimowy: trasy prowadzą przez miejsca nasłonecznione.`
        : 'Chłodna pora roku — tryb zimowy: trasy prowadzą przez miejsca nasłonecznione.',
    );
  }
  if (!weatherKnown) {
    warnings.push('Brak danych pogodowych dla tej godziny — przyjmujemy bezchmurne niebo.');
  }
  if (!heatAvailable && comfort === 'shade') {
    warnings.push('Brak mapy temperatury powierzchni (LST) — trasy uwzględniają tylko cień.');
  }
  return warnings;
}

/** Trasy A → B dla chwili wyjścia (logika POST /api/route). */
export function planRoute(req: RouteRequest): Promise<RouteResponse> {
  return guarded(async () => {
    const { from, to, departure, shadePreference, mobility, viaCoolSpot, ...parsed } = parseRouteRequest(req);
    const walkSpeed = parsed.walkSpeed ?? defaultWalkSpeed(mobility);

    // Pogoda pobiera się równolegle z danymi mapy; getWeather nigdy nie rzuca.
    const weatherPromise = getWeather(departure);
    const ctx = await getRoutingContext(from, to);
    const weather = await weatherPromise;

    const sun = sunInfo(departure, (from.lat + to.lat) / 2, (from.lon + to.lon) / 2);
    const sunFactor = sunFactorFrom(sun, weather);
    const comfort = resolveComfort(parsed.comfort, weather, departure);
    const heat = getHeatField();
    const { routes, warnings } = computeRoutesDetailed(ctx, {
      from,
      to,
      departure,
      shadePreference,
      walkSpeed,
      sunFactor,
      heat,
      mobility,
      comfort,
      viaCoolSpot,
      weather: usable(weather),
    });

    return {
      routes,
      sun,
      weather: usable(weather),
      sunFactor,
      warnings: [...warnings, ...routeWarnings(sun, weather, sunFactor, heat.available, comfort, parsed.comfort)],
      comfort,
      mobility,
      heightSource: heightSourceOf(ctx.area),
      leafOff: isLeafOff(departure),
    };
  });
}

/** Porównanie godzin wyjścia w oknie czasu (logika POST /api/departure). */
export function planDeparture(req: DepartureRequest): Promise<DepartureResponse> {
  return guarded(async () => {
    const { from, to, shadePreference, mobility, ...parsed } = parseDepartureRequest(req);
    const start = parsed.start ?? new Date();
    const times = departureTimes(start, parsed.windowHours, parsed.stepMinutes);

    // Wszystkie godziny okna pochodzą z jednej (zapamiętanej) odpowiedzi serwisu pogodowego.
    const weatherPromise = Promise.all(times.map((time) => getWeather(time)));
    const ctx = await getRoutingContext(from, to);
    const weathers = await weatherPromise;

    // Tryb 'auto' rozstrzygamy raz, dla początku okna — wyniki kolejnych godzin muszą być porównywalne.
    const comfort = resolveComfort(parsed.comfort, weathers[0] ?? null, start);
    const lat = (from.lat + to.lat) / 2;
    const lon = (from.lon + to.lon) / 2;
    return evaluateDepartures(
      ctx,
      { from, to, shadePreference, walkSpeed: defaultWalkSpeed(mobility), heat: getHeatField(), mobility, comfort },
      times,
      (time, i) => ({ weather: usable(weathers[i]), sunFactor: sunFactorFrom(sunInfo(time, lat, lon), weathers[i]) }),
      yieldToEventLoop,
    );
  });
}

const WATER_KINDS: ReadonlySet<CoolSpotKind> = new Set(['drinking_water', 'fountain', 'water_mist']);

/**
 * Punkty chłodu w oknie mapy (logika GET /api/coolspots). Korzysta wyłącznie z już pobranych kafli OSM.
 * Najwyżej MAX_COOL_SPOTS punktów — gdy jest ich więcej, pierwszeństwo ma woda, potem parki i wiaty, na końcu ławki.
 * Z `time` uzupełnia `shaded` (dla okien do ok. 10 km²; przy większych pole pozostaje puste).
 */
export function coolSpotsIn(bbox: BBoxLatLon, opts: { time?: Date; kinds?: CoolSpotKind[] } = {}): Promise<CoolSpot[]> {
  return guarded(async () => {
    const area = await loadArea(bbox, { cachedOnly: true });
    const [minX, minY] = toXY(bbox.south, bbox.west);
    const [maxX, maxY] = toXY(bbox.north, bbox.east);
    const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
    let spots = (area.coolSpots ?? []).filter(
      (spot) => spot.x >= minX && spot.x <= maxX && spot.y >= minY && spot.y <= maxY && (!kinds || kinds.has(spot.kind)),
    );
    if (spots.length > MAX_COOL_SPOTS) {
      const rank = (kind: CoolSpotKind): number => (WATER_KINDS.has(kind) ? 0 : kind === 'bench' ? 2 : 1);
      spots = spots
        .map((spot, order) => ({ spot, order }))
        .sort((a, b) => rank(a.spot.kind) - rank(b.spot.kind) || a.order - b.order)
        .slice(0, MAX_COOL_SPOTS)
        .map((entry) => entry.spot);
    }

    let shadedAt: ((x: number, y: number) => boolean) | null = null;
    if (opts.time && spots.length > 0 && (maxX - minX) * (maxY - minY) <= MAX_SHADED_AREA_M2) {
      const [lat, lon] = toLatLon((minX + maxX) / 2, (minY + maxY) / 2);
      const sun: SunPosition = { ...sunPosition(opts.time, lat, lon), leafOff: isLeafOff(opts.time) };
      // Jak warstwa cieni: tylko dane LiDAR już zapisane lokalnie (bez pobierania).
      try {
        await attachLidar(area, { cachedOnly: true });
      } catch (error) {
        console.warn('[lidar]', error instanceof Error ? error.message : String(error));
      }
      const scene = sceneForArea(area);
      shadedAt = (x, y) => scene.exposureAt(x, y, sun) < 0.5;
    }

    return spots.map((spot) => {
      const [lat, lon] = toLatLon(spot.x, spot.y);
      const out: CoolSpot = { id: spot.id, kind: spot.kind, lat, lon };
      if (spot.name !== undefined) out.name = spot.name;
      if (shadedAt) out.shaded = shadedAt(spot.x, spot.y);
      return out;
    });
  });
}
