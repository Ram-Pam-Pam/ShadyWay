// Narzędzia „Asystenta Cienia”: definicje dla modelu, walidacja wejścia i wykonanie po stronie serwera.
//
// Zasady:
//  - wejście od modelu jest niezaufane — każde pole jest sprawdzane przed użyciem (schemat w deklaracji
//    funkcji jest dla modelu wskazówką, nie gwarancją),
//  - wyniki są ZWARTE: model nigdy nie dostaje geometrii tras, tylko podsumowania liczbowe,
//  - błędy wracają do modelu jako wynik funkcji z polem „error” (komunikat po polsku, bez stosu wywołań).

import { KRAKOW_BBOX } from '../../shared/types.ts';
import type {
  AssistantContext,
  AssistantEvent,
  AssistantPlan,
  ComfortMode,
  CoolSpot,
  CoolSpotKind,
  DepartureRequest,
  DepartureResponse,
  LatLon,
  MobilityProfile,
  RouteProfile,
  RouteRequest,
  RouteResponse,
  RouteResult,
} from '../../shared/types.ts';
import type { BBoxLatLon } from '../contracts.ts';
import { sunInfo } from '../geo/sun.ts';
import { geocode, GeocoderUnavailableError } from '../geocode.ts';
import { coolSpotsIn, planDeparture, planRoute, ServiceError } from '../service.ts';
import { getWeather, sunFactorFrom } from '../weather/openmeteo.ts';
import { formatKrakowClock, formatKrakowLocal, parseAssistantTime, sanitizeLabel, toKrakowIso } from './prompt.ts';

// ───────────────────────── definicje narzędzi ─────────────────────────

const POINT_SCHEMA = {
  type: 'object',
  description: 'Punkt w Krakowie (WGS84).',
  properties: {
    lat: { type: 'number', description: 'Szerokość geograficzna, np. 50.0614' },
    lon: { type: 'number', description: 'Długość geograficzna, np. 19.9372' },
    label: { type: 'string', description: 'Krótka nazwa miejsca do pokazania użytkownikowi' },
  },
  required: ['lat', 'lon'],
} as const;

const TIME_DESCRIPTION =
  'Czas krakowski w formacie YYYY-MM-DDTHH:mm (np. 2026-07-15T15:00). Pominięcie oznacza „teraz”.';
const MOBILITY_SCHEMA = {
  type: 'string',
  enum: ['default', 'accessible', 'senior'],
  description: 'Profil poruszania się: accessible = wózek (bez schodów), senior = wolniej, unikaj schodów.',
} as const;
const COMFORT_SCHEMA = {
  type: 'string',
  enum: ['shade', 'sun', 'auto'],
  description: 'shade = unikaj słońca, sun = szukaj słońca (zima), auto = wg temperatury odczuwalnej (domyślnie).',
} as const;
const SHADE_PREFERENCE_SCHEMA = {
  type: 'number',
  description: '0 = ignoruj słońce (najkrótsza), 1 = maksymalnie unikaj słońca; steruje wariantem „balanced”. Domyślnie 0.5.',
} as const;
const COOL_KINDS: readonly CoolSpotKind[] = ['drinking_water', 'fountain', 'water_mist', 'bench', 'park', 'shelter'];
/** Bez podanych rodzajów szukamy wody i schronienia — ławek jest zbyt wiele, żeby były użyteczną odpowiedzią. */
const DEFAULT_COOL_KINDS: CoolSpotKind[] = ['drinking_water', 'fountain', 'water_mist', 'shelter'];

/**
 * Definicja narzędzia niezależna od dostawcy modelu. `parameters` to zwykły JSON Schema ograniczony do słów
 * kluczowych, które przyjmują deklaracje funkcji Gemini: type, properties, required, description, enum, items
 * (https://ai.google.dev/gemini-api/docs/function-calling). Nie dodawaj tu innych słów kluczowych.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

/**
 * Definicje narzędzi w stałej kolejności (kolejność i treść są częścią stałego prefiksu zapytania, który
 * dostawca modelu może cache'ować — nie buduj tej listy dynamicznie).
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'geocode_place',
    description:
      'Wyszukuje miejsce lub adres w Krakowie i zwraca kandydatów ze współrzędnymi. Wywołaj dla każdego miejsca, ' +
      'które użytkownik nazwał słownie (np. „AGH”, „Wawel”, „dworzec”, „ul. Karmelicka 20”), zanim policzysz trasę. ' +
      'Nie używaj dla punktów, które masz już ze współrzędnymi w kontekście aplikacji.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Nazwa miejsca lub adres, bez dopisku „Kraków”' } },
      required: ['query'],
    },
  },
  {
    name: 'plan_route',
    description:
      'Wyznacza pieszą trasę z A do B dla podanej chwili i zwraca zwarte podsumowanie każdego wariantu ' +
      '(shortest / balanced / shadiest): długość, czas, udział cienia, metry w słońcu, temperaturę odczuwalną, ' +
      'światła, schody, punkty chłodu, pierwsze kroki, główne odcinki i ostrzeżenia. Wywołaj zawsze, gdy użytkownik ' +
      'chce dojść z miejsca do miejsca albo pyta, dlaczego trasa prowadzi tak, a nie inaczej.',
    parameters: {
      type: 'object',
      properties: {
        from: POINT_SCHEMA,
        to: POINT_SCHEMA,
        time: { type: 'string', description: TIME_DESCRIPTION },
        shadePreference: SHADE_PREFERENCE_SCHEMA,
        mobility: MOBILITY_SCHEMA,
        comfort: COMFORT_SCHEMA,
        viaCoolSpot: {
          type: 'boolean',
          description: 'Poprowadź trasę przez punkt z wodą (kran, fontanna), jeśli nadkłada niewiele drogi.',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'best_departure',
    description:
      'Porównuje godziny wyjścia w podanym oknie czasu dla trasy z A do B i wskazuje najlepszą (cień, pogoda, długość). ' +
      'Wywołaj, gdy użytkownik pyta „kiedy najlepiej wyjść”, ma elastyczną porę albo planuje wyjście w upale.',
    parameters: {
      type: 'object',
      properties: {
        from: POINT_SCHEMA,
        to: POINT_SCHEMA,
        start: { type: 'string', description: `Początek okna. ${TIME_DESCRIPTION}` },
        windowHours: { type: 'number', description: 'Długość okna w godzinach, 1–16 (domyślnie 6).' },
        stepMinutes: { type: 'number', description: 'Krok w minutach, 15–120 (domyślnie 30).' },
        shadePreference: SHADE_PREFERENCE_SCHEMA,
        mobility: MOBILITY_SCHEMA,
        comfort: COMFORT_SCHEMA,
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'find_cool_spots',
    description:
      'Szuka punktów chłodu: woda pitna, fontanny, zamgławiacze, ławki, parki, zadaszenia — w pobliżu punktu („near”) ' +
      'albo w prostokącie („bbox”). Wywołaj, gdy użytkownik pyta o wodę, miejsce na odpoczynek lub ochłodę. ' +
      'Zna tylko okolice, dla których aplikacja ma już pobrane dane mapy (np. po wyznaczeniu trasy).',
    parameters: {
      type: 'object',
      properties: {
        near: POINT_SCHEMA,
        radiusM: { type: 'number', description: 'Promień wokół „near” w metrach, 50–1500 (domyślnie 400).' },
        bbox: {
          type: 'object',
          description: 'Alternatywa dla „near”: prostokąt w stopniach.',
          properties: {
            west: { type: 'number' },
            south: { type: 'number' },
            east: { type: 'number' },
            north: { type: 'number' },
          },
          required: ['west', 'south', 'east', 'north'],
        },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...COOL_KINDS] },
          description: 'Rodzaje punktów; domyślnie woda pitna, fontanny, zamgławiacze i zadaszenia.',
        },
        time: { type: 'string', description: `Chwila, dla której sprawdzić, czy punkt jest w cieniu. ${TIME_DESCRIPTION}` },
      },
    },
  },
  {
    name: 'get_conditions',
    description:
      'Zwraca położenie słońca (wysokość, azymut, wschód i zachód) oraz pogodę w Krakowie dla podanej chwili: ' +
      'temperaturę, temperaturę odczuwalną, zachmurzenie, promieniowanie i indeks UV. Wywołaj przy pytaniach o upał, ' +
      'słońce lub pogodę, gdy nie liczysz trasy (plan_route zwraca te dane sam).',
    parameters: {
      type: 'object',
      properties: { time: { type: 'string', description: TIME_DESCRIPTION } },
    },
  },
  {
    name: 'show_on_map',
    description:
      'Pokazuje ustalony plan na mapie użytkownika: ustawia start, cel, godzinę i opcje, przelicza trasę i zaznacza wariant. ' +
      'Wywołaj za każdym razem, gdy zdecydujesz się na konkretną trasę (po plan_route), z tymi samymi parametrami. ' +
      'Pola pominięte pozostają w aplikacji bez zmian.',
    parameters: {
      type: 'object',
      properties: {
        from: { ...POINT_SCHEMA, required: ['lat', 'lon', 'label'] },
        to: { ...POINT_SCHEMA, required: ['lat', 'lon', 'label'] },
        time: { type: 'string', description: 'Czas krakowski w formacie YYYY-MM-DDTHH:mm.' },
        shadePreference: SHADE_PREFERENCE_SCHEMA,
        mobility: MOBILITY_SCHEMA,
        comfort: COMFORT_SCHEMA,
        viaCoolSpot: { type: 'boolean' },
        selectProfile: {
          type: 'string',
          enum: ['shortest', 'balanced', 'shadiest'],
          description: 'Wariant trasy do zaznaczenia.',
        },
      },
    },
  },
];

// ───────────────────────── etykiety dla UI ─────────────────────────

const MAX_LABEL_QUERY = 60;

/** Przyjazny opis czynności po polsku dla zdarzenia {type:'tool'}. */
export function toolLabel(name: string, input: unknown): string {
  switch (name) {
    case 'geocode_place': {
      const query = sanitizeLabel((input as { query?: unknown } | null)?.query);
      return query ? `Szukam miejsca: ${query.slice(0, MAX_LABEL_QUERY)}…` : 'Szukam miejsca…';
    }
    case 'plan_route':
      return 'Wyznaczam trasę i liczę cień…';
    case 'best_departure':
      return 'Sprawdzam najlepszą godzinę wyjścia…';
    case 'find_cool_spots':
      return 'Szukam wody i miejsc do ochłody…';
    case 'get_conditions':
      return 'Sprawdzam słońce i pogodę…';
    case 'show_on_map':
      return 'Pokazuję trasę na mapie…';
    default:
      return 'Pracuję…';
  }
}

// ───────────────────────── walidacja wejścia ─────────────────────────

/** Niepoprawne wejście narzędzia — komunikat wraca do modelu jako błąd, żeby mógł poprawić wywołanie. */
export class ToolInputError extends Error {}

type Raw = Record<string, unknown>;

function asObject(raw: unknown, what: string): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ToolInputError(`Niepoprawne wejście: ${what} musi być obiektem.`);
  }
  return raw as Raw;
}

function inKrakow(lat: number, lon: number): boolean {
  return lat >= KRAKOW_BBOX.south && lat <= KRAKOW_BBOX.north && lon >= KRAKOW_BBOX.west && lon <= KRAKOW_BBOX.east;
}

function parsePoint(raw: unknown, name: string): LatLon & { label?: string } {
  const point = asObject(raw, `„${name}”`);
  const { lat, lon } = point;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new ToolInputError(`Punkt „${name}” wymaga liczbowych pól lat i lon.`);
  }
  if (!inKrakow(lat, lon)) {
    throw new ToolInputError(
      `Punkt „${name}” (${lat.toFixed(4)}, ${lon.toFixed(4)}) leży poza obszarem aplikacji (Kraków). Sprawdź, czy lat i lon nie są zamienione.`,
    );
  }
  const label = sanitizeLabel(point.label);
  return label ? { lat, lon, label } : { lat, lon };
}

function parseOptionalTime(raw: unknown, name: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new ToolInputError(`Pole „${name}” musi być tekstem w formacie YYYY-MM-DDTHH:mm.`);
  try {
    return parseAssistantTime(raw);
  } catch {
    throw new ToolInputError(`Pole „${name}”: niepoprawny czas „${raw.slice(0, 40)}” — użyj formatu YYYY-MM-DDTHH:mm (czas krakowski).`);
  }
}

function parseOptionalNumber(raw: unknown, name: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new ToolInputError(`Pole „${name}” musi być liczbą z zakresu ${min}–${max}.`);
  }
  return raw;
}

function parseOptionalEnum<T extends string>(raw: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new ToolInputError(`Pole „${name}” musi być jedną z wartości: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

function parseOptionalBoolean(raw: unknown, name: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') throw new ToolInputError(`Pole „${name}” musi być wartością true/false.`);
  return raw;
}

const MOBILITY: readonly MobilityProfile[] = ['default', 'accessible', 'senior'];
const COMFORT: readonly ComfortMode[] = ['shade', 'sun', 'auto'];
const PROFILES: readonly RouteProfile[] = ['shortest', 'balanced', 'shadiest'];

// ───────────────────────── zwarte podsumowania ─────────────────────────

const MAX_STEPS = 5;
const MAX_STEP_CHARS = 140;
const MAX_STREETS = 6;
const MAX_ROUTE_COOL_SPOTS = 4;
const MAX_WARNINGS = 5;
const MAX_WARNING_CHARS = 200;
const MAX_DEPARTURE_OPTIONS = 16;
const MAX_COOL_SPOTS = 12;
const MAX_GEOCODE_RESULTS = 5;

const round = (value: number, digits = 0): number => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const roundOrNull = (value: number | null | undefined, digits = 0): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? round(value, digits) : null;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function coolSpotBrief(spot: CoolSpot): Record<string, unknown> {
  const name = sanitizeLabel(spot.name);
  return { kind: spot.kind, ...(name ? { name: clip(name, 60) } : {}), ...(spot.shaded !== undefined ? { shaded: spot.shaded } : {}) };
}

/** Najdłuższe nazwane odcinki trasy z udziałem cienia — materiał do odpowiedzi „dlaczego tędy?”. */
function mainStreets(route: RouteResult): Array<Record<string, unknown>> {
  const byName = new Map<string, { m: number; sunM: number }>();
  for (const segment of route.segments ?? []) {
    const name = sanitizeLabel(segment.name);
    if (!name) continue;
    const entry = byName.get(name) ?? { m: 0, sunM: 0 };
    entry.m += segment.lengthM;
    entry.sunM += segment.lengthM * segment.sunFraction;
    byName.set(name, entry);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].m - a[1].m)
    .slice(0, MAX_STREETS)
    .map(([name, v]) => ({ name: clip(name, 50), m: round(v.m), shadePct: v.m > 0 ? round(100 * (1 - v.sunM / v.m)) : null }));
}

function summarizeRoute(route: RouteResult): Record<string, unknown> {
  const coolSpots = route.coolSpots ?? [];
  const steps = route.steps ?? [];
  const thermal = route.thermal;
  return {
    profile: route.profile,
    label: route.label,
    distanceM: round(route.distanceM),
    minutes: round(route.durationS / 60),
    shadePct: round(route.shadeFraction * 100),
    sunM: round(route.sunDistanceM),
    signalCrossings: route.signalCrossings ?? null,
    waitS: roundOrNull(route.waitS),
    stairs: route.stairsCount ?? null,
    feltMeanC: roundOrNull(thermal?.feltMeanC, 1),
    stress: thermal?.stress ?? null,
    surfaceLstC: roundOrNull(route.meanLstC, 1),
    coolSpotsNearby: coolSpots.length,
    coolSpots: coolSpots.slice(0, MAX_ROUTE_COOL_SPOTS).map(coolSpotBrief),
    ...(route.via ? { via: coolSpotBrief(route.via) } : {}),
    mainStreets: mainStreets(route),
    firstSteps: steps.slice(0, MAX_STEPS).map((step) => clip(step.text, MAX_STEP_CHARS)),
    stepsTotal: steps.length,
  };
}

/**
 * Zwarte podsumowanie odpowiedzi /api/route dla modelu: bez geometrii i bez listy segmentów.
 * Rozmiar jest ograniczony stałymi powyżej niezależnie od długości trasy (patrz test).
 */
export function summarizeRouteResponse(response: RouteResponse, departure: Date): Record<string, unknown> {
  const first = response.routes[0];
  const weather = response.weather;
  return {
    departure: formatKrakowLocal(departure),
    comfort: response.comfort ?? null,
    mobility: response.mobility ?? null,
    heightSource: response.heightSource ?? null,
    leafOff: response.leafOff ?? null,
    sunFactor: round(response.sunFactor, 2),
    sun: { altitudeDeg: round(response.sun.altitudeDeg), isDay: response.sun.isDay },
    weather:
      weather && weather.source !== 'unavailable'
        ? {
            temperatureC: roundOrNull(weather.temperatureC, 1),
            apparentC: roundOrNull(weather.apparentTemperatureC, 1),
            cloudPct: roundOrNull(weather.cloudCoverPct),
            uvIndex: roundOrNull(weather.uvIndex, 1),
          }
        : null,
    feltInSunC: roundOrNull(first?.thermal?.feltSunC, 1),
    feltInShadeC: roundOrNull(first?.thermal?.feltShadeC, 1),
    routes: response.routes.slice(0, 3).map(summarizeRoute),
    warnings: (response.warnings ?? []).slice(0, MAX_WARNINGS).map((w) => clip(w, MAX_WARNING_CHARS)),
  };
}

/** Zwarte podsumowanie /api/departure: najwyżej MAX_DEPARTURE_OPTIONS opcji (równomiernie + najlepsza). */
export function summarizeDeparture(response: DepartureResponse): Record<string, unknown> {
  const options = response.options ?? [];
  const keep = new Set<number>();
  if (options.length <= MAX_DEPARTURE_OPTIONS) {
    options.forEach((_, i) => keep.add(i));
  } else {
    for (let k = 0; k < MAX_DEPARTURE_OPTIONS - 1; k++) keep.add(Math.round((k * (options.length - 1)) / (MAX_DEPARTURE_OPTIONS - 2)));
    keep.add(response.bestIndex);
  }
  const brief = (index: number): Record<string, unknown> => {
    const option = options[index];
    const time = new Date(option.time);
    return {
      time: formatKrakowClock(time),
      date: formatKrakowLocal(time).slice(0, 10),
      minutes: round(option.durationS / 60),
      distanceM: round(option.distanceM),
      shadePct: round(option.shadeFraction * 100),
      sunM: round(option.sunDistanceM),
      sunFactor: round(option.sunFactor, 2),
      feltMeanC: roundOrNull(option.feltMeanC, 1),
      score: round(option.score),
    };
  };
  const best = options[response.bestIndex] ? brief(response.bestIndex) : null;
  return {
    best,
    summary: clip(response.summary ?? '', 300),
    options: [...keep].filter((i) => i >= 0 && i < options.length).sort((a, b) => a - b).map(brief),
  };
}

// ───────────────────────── wykonanie ─────────────────────────

export interface ToolContext {
  /** Chwila zapytania („teraz”). */
  now: Date;
  /** Wysyła zdarzenie do UI (używane przez show_on_map). */
  emit: (event: AssistantEvent) => void;
  context?: AssistantContext;
  /** Zgłoszenie nieoczekiwanego wyjątku narzędzia (do logu serwera; model dostaje tylko ogólny komunikat). */
  onInternalError?: (tool: string, err: unknown) => void;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const SERVICE_CODES = new Set(['OUT_OF_AREA', 'NO_ROUTE', 'BAD_REQUEST', 'DATA_UNAVAILABLE', 'TOO_FAR', 'INTERNAL']);

/** ServiceError rozpoznajemy też po kształcie — w testach moduł service.ts jest atrapą. */
function serviceErrorOf(err: unknown): { code: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (err instanceof ServiceError || (typeof code === 'string' && SERVICE_CODES.has(code))) {
    return { code: String(code), message: err.message };
  }
  return null;
}

function distanceM(a: LatLon, b: LatLon): number {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371008.8;
}

function bboxAround(center: LatLon, radiusM: number): BBoxLatLon {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180));
  return { west: center.lon - dLon, south: center.lat - dLat, east: center.lon + dLon, north: center.lat + dLat };
}

async function runGeocode(input: Raw): Promise<unknown> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (query.length < 2 || query.length > 120) throw new ToolInputError('Pole „query” musi mieć od 2 do 120 znaków.');
  const results = await geocode(query);
  return {
    query,
    results: results.slice(0, MAX_GEOCODE_RESULTS).map((r) => ({
      label: clip(sanitizeLabel(r.label) ?? '', 100),
      lat: round(r.lat, 5),
      lon: round(r.lon, 5),
    })),
    ...(results.length === 0 ? { note: 'Brak wyników w Krakowie — spróbuj innej nazwy albo dopytaj użytkownika.' } : {}),
  };
}

async function runPlanRoute(input: Raw, ctx: ToolContext): Promise<unknown> {
  const departure = parseOptionalTime(input.time, 'time') ?? ctx.now;
  const request: RouteRequest = {
    from: parsePoint(input.from, 'from'),
    to: parsePoint(input.to, 'to'),
    time: toKrakowIso(departure),
  };
  const shadePreference = parseOptionalNumber(input.shadePreference, 'shadePreference', 0, 1);
  const mobility = parseOptionalEnum(input.mobility, 'mobility', MOBILITY);
  const comfort = parseOptionalEnum(input.comfort, 'comfort', COMFORT);
  const viaCoolSpot = parseOptionalBoolean(input.viaCoolSpot, 'viaCoolSpot');
  if (shadePreference !== undefined) request.shadePreference = shadePreference;
  if (mobility) request.mobility = mobility;
  if (comfort) request.comfort = comfort;
  if (viaCoolSpot !== undefined) request.viaCoolSpot = viaCoolSpot;
  // Do serwisu idą same współrzędne — etykieta od modelu nie jest częścią RouteRequest.
  request.from = { lat: request.from.lat, lon: request.from.lon };
  request.to = { lat: request.to.lat, lon: request.to.lon };
  return summarizeRouteResponse(await planRoute(request), departure);
}

async function runBestDeparture(input: Raw, ctx: ToolContext): Promise<unknown> {
  const from = parsePoint(input.from, 'from');
  const to = parsePoint(input.to, 'to');
  const request: DepartureRequest = {
    from: { lat: from.lat, lon: from.lon },
    to: { lat: to.lat, lon: to.lon },
    start: toKrakowIso(parseOptionalTime(input.start, 'start') ?? ctx.now),
  };
  const windowHours = parseOptionalNumber(input.windowHours, 'windowHours', 1, 16);
  const stepMinutes = parseOptionalNumber(input.stepMinutes, 'stepMinutes', 15, 120);
  const shadePreference = parseOptionalNumber(input.shadePreference, 'shadePreference', 0, 1);
  const mobility = parseOptionalEnum(input.mobility, 'mobility', MOBILITY);
  const comfort = parseOptionalEnum(input.comfort, 'comfort', COMFORT);
  if (windowHours !== undefined) request.windowHours = windowHours;
  if (stepMinutes !== undefined) request.stepMinutes = stepMinutes;
  if (shadePreference !== undefined) request.shadePreference = shadePreference;
  if (mobility) request.mobility = mobility;
  if (comfort) request.comfort = comfort;
  return summarizeDeparture(await planDeparture(request));
}

async function runFindCoolSpots(input: Raw): Promise<unknown> {
  const time = parseOptionalTime(input.time, 'time');
  let kinds: CoolSpotKind[] = DEFAULT_COOL_KINDS;
  if (input.kinds !== undefined && input.kinds !== null) {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0 || !input.kinds.every((k) => COOL_KINDS.includes(k as CoolSpotKind))) {
      throw new ToolInputError(`Pole „kinds” musi być niepustą listą wartości: ${COOL_KINDS.join(', ')}.`);
    }
    kinds = [...new Set(input.kinds as CoolSpotKind[])];
  }
  let bbox: BBoxLatLon;
  let center: LatLon;
  if (input.near !== undefined && input.near !== null) {
    center = parsePoint(input.near, 'near');
    bbox = bboxAround(center, parseOptionalNumber(input.radiusM, 'radiusM', 50, 1500) ?? 400);
  } else if (input.bbox !== undefined && input.bbox !== null) {
    const raw = asObject(input.bbox, '„bbox”');
    const { west, south, east, north } = raw;
    if (![west, south, east, north].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new ToolInputError('Pole „bbox” wymaga liczb west, south, east, north.');
    }
    bbox = { west: west as number, south: south as number, east: east as number, north: north as number };
    if (bbox.west >= bbox.east || bbox.south >= bbox.north || bbox.east - bbox.west > 0.06 || bbox.north - bbox.south > 0.04) {
      throw new ToolInputError('Pole „bbox” jest niepoprawne albo za duże (najwyżej ok. 4 × 4 km).');
    }
    center = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
    if (!inKrakow(center.lat, center.lon)) throw new ToolInputError('Pole „bbox” leży poza obszarem aplikacji (Kraków).');
  } else {
    throw new ToolInputError('Podaj „near” (punkt) albo „bbox” (prostokąt).');
  }
  const spots: CoolSpot[] = await coolSpotsIn(bbox, time ? { time, kinds } : { kinds });
  const ranked = spots
    .map((spot) => ({ spot, d: distanceM(center, spot) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_COOL_SPOTS);
  return {
    found: spots.length,
    spots: ranked.map(({ spot, d }) => ({ ...coolSpotBrief(spot), lat: round(spot.lat, 5), lon: round(spot.lon, 5), distanceM: round(d) })),
    ...(spots.length === 0
      ? { note: 'Brak punktów w tej okolicy albo dane mapy dla niej nie są jeszcze pobrane (pobiera je wyznaczenie trasy).' }
      : {}),
  };
}

async function runGetConditions(input: Raw, ctx: ToolContext): Promise<unknown> {
  const time = parseOptionalTime(input.time, 'time') ?? ctx.now;
  const sun = sunInfo(time);
  const weather = await getWeather(time);
  const known = weather.source !== 'unavailable';
  const clock = (iso: string | null): string | null => (iso ? formatKrakowClock(new Date(iso)) : null);
  return {
    time: formatKrakowLocal(time),
    sun: {
      altitudeDeg: round(sun.altitudeDeg, 1),
      azimuthDeg: round(sun.azimuthDeg),
      isDay: sun.isDay,
      sunrise: clock(sun.sunrise),
      sunset: clock(sun.sunset),
    },
    sunFactor: round(sunFactorFrom(sun, known ? weather : null), 2),
    weather: known
      ? {
          temperatureC: roundOrNull(weather.temperatureC, 1),
          apparentC: roundOrNull(weather.apparentTemperatureC, 1),
          cloudPct: roundOrNull(weather.cloudCoverPct),
          directRadiationWm2: roundOrNull(weather.directRadiationWm2),
          uvIndex: roundOrNull(weather.uvIndex, 1),
        }
      : null,
    ...(known ? {} : { note: 'Brak danych pogodowych dla tej godziny.' }),
  };
}

/** Waliduje plan od modelu i zamienia go na AssistantPlan (czas → ISO z offsetem krakowskim). */
export function parsePlan(raw: unknown): AssistantPlan {
  const input = asObject(raw, 'plan');
  const plan: AssistantPlan = {};
  for (const key of ['from', 'to'] as const) {
    if (input[key] === undefined || input[key] === null) continue;
    const point = parsePoint(input[key], key);
    if (!point.label) throw new ToolInputError(`Punkt „${key}” wymaga pola label (nazwa pokazywana użytkownikowi).`);
    plan[key] = { lat: point.lat, lon: point.lon, label: point.label };
  }
  const time = parseOptionalTime(input.time, 'time');
  if (time) plan.time = toKrakowIso(time);
  const shadePreference = parseOptionalNumber(input.shadePreference, 'shadePreference', 0, 1);
  if (shadePreference !== undefined) plan.shadePreference = shadePreference;
  const mobility = parseOptionalEnum(input.mobility, 'mobility', MOBILITY);
  if (mobility) plan.mobility = mobility;
  const comfort = parseOptionalEnum(input.comfort, 'comfort', COMFORT);
  if (comfort) plan.comfort = comfort;
  const viaCoolSpot = parseOptionalBoolean(input.viaCoolSpot, 'viaCoolSpot');
  if (viaCoolSpot !== undefined) plan.viaCoolSpot = viaCoolSpot;
  const selectProfile = parseOptionalEnum(input.selectProfile, 'selectProfile', PROFILES);
  if (selectProfile) plan.selectProfile = selectProfile;
  if (Object.keys(plan).length === 0) throw new ToolInputError('Plan jest pusty — podaj przynajmniej jedno pole.');
  return plan;
}

function runShowOnMap(input: Raw, ctx: ToolContext): unknown {
  const plan = parsePlan(input);
  ctx.emit({ type: 'plan', plan });
  return { shown: true, applied: Object.keys(plan) };
}

/**
 * Wykonuje narzędzie. Nigdy nie rzuca: błąd wejścia, błąd serwisu i nieoczekiwany wyjątek wracają jako
 * { isError: true } z komunikatem bezpiecznym do pokazania modelowi (bez stosu wywołań i szczegółów wewnętrznych).
 */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const raw = asObject(input ?? {}, 'wejście narzędzia');
    let result: unknown;
    switch (name) {
      case 'geocode_place':
        result = await runGeocode(raw);
        break;
      case 'plan_route':
        result = await runPlanRoute(raw, ctx);
        break;
      case 'best_departure':
        result = await runBestDeparture(raw, ctx);
        break;
      case 'find_cool_spots':
        result = await runFindCoolSpots(raw);
        break;
      case 'get_conditions':
        result = await runGetConditions(raw, ctx);
        break;
      case 'show_on_map':
        result = runShowOnMap(raw, ctx);
        break;
      default:
        return { content: `Nieznane narzędzie: ${clip(String(name), 60)}.`, isError: true };
    }
    return { content: JSON.stringify(result) };
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, isError: true };
    const service = serviceErrorOf(err);
    if (service) return { content: `Błąd (${service.code}): ${clip(service.message, 300)}`, isError: true };
    if (err instanceof GeocoderUnavailableError) {
      return { content: 'Usługa wyszukiwania miejsc jest chwilowo niedostępna — spróbuj ponownie za chwilę.', isError: true };
    }
    ctx.onInternalError?.(name, err);
    return { content: 'Narzędzie nie zadziałało z powodu błędu wewnętrznego. Spróbuj ponownie albo zaproponuj inne rozwiązanie.', isError: true };
  }
}
