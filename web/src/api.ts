// Typowany klient HTTP API (kontrakt: shared/types.ts). Każde wywołanie przyjmuje AbortSignal.

import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import type {
  ApiError,
  AssistantEvent,
  AssistantRequest,
  AssistantStatus,
  CoolSpot,
  CoolSpotKind,
  DepartureRequest,
  DepartureResponse,
  GeocodeResult,
  HeatMeta,
  LatLon,
  RouteRequest,
  RouteResponse,
  SunInfo,
  WeatherInfo,
} from '../../shared/types.ts';
import { createSseParser } from './sse.ts';

export type ShadowCollection = FeatureCollection<Polygon | MultiPolygon, { kind: 'building' | 'tree' }> & {
  /** true, gdy dla części okna serwer nie ma jeszcze danych mapy — cienie są tam niekompletne. */
  missingData?: boolean;
};

export type ApiErrorCode = ApiError['code'] | 'NETWORK' | 'TIMEOUT';

/** Po tym czasie uznajemy, że serwer nie odpowie na zapytanie o trasę (sam czeka na dane mapy najwyżej 40 s). */
const ROUTE_TIMEOUT_MS = 60_000;
/** „Kiedy wyjść?” liczy trasę dla każdego kroku okna, więc może trwać dłużej niż pojedyncza trasa. */
const DEPARTURE_TIMEOUT_MS = 90_000;

const TIMEOUT_MESSAGE =
  'Serwer nie odpowiedział na czas. Dane mapy mogą się jeszcze pobierać — spróbuj ponownie za chwilę.';

/** Błąd API z komunikatem po polsku, gotowym do pokazania użytkownikowi. */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(message: string, code: ApiErrorCode, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

export const HEAT_OVERLAY_URL = '/api/heat/overlay.png';

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Komunikat po polsku dla dowolnego błędu (nieznane błędy dostają ogólny opis). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Coś poszło nie tak. Spróbuj ponownie.';
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiError).error === 'string' &&
    typeof (value as ApiError).code === 'string'
  );
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError('Nie udało się połączyć z serwerem. Sprawdź połączenie z internetem.', 'NETWORK', 0);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (isApiError(body)) throw new ApiRequestError(body.error, body.code, response.status);
    const message =
      response.status >= 500
        ? 'Serwer jest chwilowo niedostępny. Spróbuj ponownie za moment.'
        : 'Serwer odrzucił zapytanie. Spróbuj ponownie.';
    throw new ApiRequestError(message, 'INTERNAL', response.status);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError('Serwer zwrócił nieczytelną odpowiedź.', 'INTERNAL', response.status);
  }
}

function get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  return request<T>(query ? `${path}?${query}` : path, { signal });
}

/**
 * Zapytanie POST z limitem czasu: `signal` anuluje je po stronie wołającego (AbortError),
 * limit kończy je błędem TIMEOUT z komunikatem dla użytkownika.
 */
async function postWithTimeout<T>(path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    return await request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeout.signal]),
    });
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted) throw new ApiRequestError(TIMEOUT_MESSAGE, 'TIMEOUT', 0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchRoute(body: RouteRequest, signal: AbortSignal): Promise<RouteResponse> {
  return postWithTimeout<RouteResponse>('/api/route', body, signal, ROUTE_TIMEOUT_MS);
}

/** Najlepsza godzina wyjścia w oknie czasu (trasa „zbalansowana” dla każdego kroku). */
export function fetchDeparture(body: DepartureRequest, signal: AbortSignal): Promise<DepartureResponse> {
  return postWithTimeout<DepartureResponse>('/api/departure', body, signal, DEPARTURE_TIMEOUT_MS);
}

function bboxParam(bbox: [number, number, number, number]): string {
  return bbox.map((v) => v.toFixed(6)).join(',');
}

/**
 * Punkty chłodu w oknie mapy (z kafli już pobranych przez serwer).
 * @param bbox [west, south, east, north] w stopniach
 * @param options.time z podaną chwilą serwer uzupełnia pole `shaded`
 */
export function fetchCoolSpots(
  bbox: [number, number, number, number],
  options: { time?: string; kinds?: readonly CoolSpotKind[] } = {},
  signal?: AbortSignal,
): Promise<CoolSpot[]> {
  const params: Record<string, string> = { bbox: bboxParam(bbox) };
  if (options.time) params.time = options.time;
  if (options.kinds && options.kinds.length > 0) params.kinds = options.kinds.join(',');
  return get<CoolSpot[]>('/api/coolspots', params, signal);
}

export function fetchAssistantStatus(signal?: AbortSignal): Promise<AssistantStatus> {
  return get<AssistantStatus>('/api/assistant/status', {}, signal);
}

/**
 * Rozmowa z asystentem AI: wysyła historię i kontekst, a zdarzenia strumienia (tekst, czynności, plan)
 * przekazuje do `onEvent` w kolejności nadejścia. Obietnica spełnia się po zamknięciu strumienia;
 * błąd HTTP (np. 503, gdy asystent jest niedostępny) odrzuca ją jako ApiRequestError.
 */
export async function streamAssistant(
  body: AssistantRequest,
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError('Nie udało się połączyć z serwerem. Sprawdź połączenie z internetem.', 'NETWORK', 0);
  }
  if (!response.ok || !response.body) {
    const payload: unknown = await response.json().catch(() => null);
    if (isApiError(payload)) throw new ApiRequestError(payload.error, payload.code, response.status);
    throw new ApiRequestError('Asystent jest chwilowo niedostępny. Spróbuj ponownie za moment.', 'INTERNAL', response.status);
  }

  const parser = createSseParser<AssistantEvent>(onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.flush();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiRequestError('Połączenie z asystentem zostało przerwane. Spróbuj ponownie.', 'NETWORK', 0);
  }
}

/** @param bbox [west, south, east, north] w stopniach */
export function fetchShadows(
  bbox: [number, number, number, number],
  time: string,
  signal?: AbortSignal,
): Promise<ShadowCollection> {
  return get<ShadowCollection>('/api/shadows', { bbox: bboxParam(bbox), time }, signal);
}

export function fetchSun(time: string, signal?: AbortSignal): Promise<SunInfo> {
  return get<SunInfo>('/api/sun', { time }, signal);
}

export function fetchWeather(time: string, signal?: AbortSignal): Promise<WeatherInfo> {
  return get<WeatherInfo>('/api/weather', { time }, signal);
}

export function geocode(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  return get<GeocodeResult[]>('/api/geocode', { q: query }, signal);
}

export function reverseGeocode(point: LatLon, signal?: AbortSignal): Promise<GeocodeResult | null> {
  return get<GeocodeResult | null>(
    '/api/reverse',
    { lat: point.lat.toFixed(6), lon: point.lon.toFixed(6) },
    signal,
  );
}

export function fetchHeatMeta(signal?: AbortSignal): Promise<HeatMeta> {
  return get<HeatMeta>('/api/heat/meta', {}, signal);
}
