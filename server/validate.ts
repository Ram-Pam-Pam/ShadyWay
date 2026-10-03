// Walidacja parametrów zapytań HTTP wspólna dla endpointów API.

import type { ComfortMode, CoolSpotKind, LatLon, MobilityProfile } from '../shared/types.ts';
import type { BBoxLatLon } from './contracts.ts';

/** Niepoprawne dane zapytania; komunikat (po polsku) trafia do klienta z kodem BAD_REQUEST. */
export class BadRequestError extends Error {}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Moment w czasie z ISO 8601; wymagany jawny offset albo "Z", żeby godzina nie zależała od strefy serwera.
 * Data musi istnieć w kalendarzu: `new Date` po cichu zamienia np. 30 lutego na 2 marca, co dałoby
 * poprawnie wyglądającą odpowiedź dla innego dnia.
 */
export function parseTime(raw: unknown): Date {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestError('Brak parametru „time” (data i godzina w formacie ISO 8601).');
  }
  const value = raw.trim();
  const match = ISO_TIME.exec(value);
  const date = new Date(value);
  if (!match || Number.isNaN(date.getTime())) {
    throw new BadRequestError('Niepoprawny czas — podaj datę i godzinę w formacie ISO 8601 z offsetem, np. 2026-07-15T13:00:00+02:00.');
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new BadRequestError(`Niepoprawna data — dzień ${match[1]}-${match[2]}-${match[3]} nie istnieje w kalendarzu.`);
  }
  return date;
}

// ───────────────────────── parametry v2 ─────────────────────────

export const DEFAULT_SHADE_PREFERENCE = 0.5;
export const MIN_WALK_SPEED = 0.3;
export const MAX_WALK_SPEED = 3;
export const DEFAULT_WINDOW_HOURS = 6;
export const MAX_WINDOW_HOURS = 16;
export const DEFAULT_STEP_MINUTES = 30;
export const MIN_STEP_MINUTES = 15;
const MAX_STEP_MINUTES = 240;

const MOBILITY_PROFILES: readonly MobilityProfile[] = ['default', 'accessible', 'senior'];
const COMFORT_MODES: readonly ComfortMode[] = ['shade', 'sun', 'auto'];
const COOL_SPOT_KINDS: readonly CoolSpotKind[] = ['drinking_water', 'fountain', 'water_mist', 'bench', 'park', 'shelter'];

export function parsePoint(raw: unknown, label: string): LatLon {
  const point = raw as Partial<LatLon> | null | undefined;
  const lat = point?.lat;
  const lon = point?.lon;
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    throw new BadRequestError(`Niepoprawne współrzędne punktu ${label}.`);
  }
  return { lat, lon };
}

/** Liczba z zakresu [min, max] albo undefined, gdy parametru nie podano (undefined / null). */
export function parseOptionalNumber(raw: unknown, min: number, max: number, message: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) throw new BadRequestError(message);
  return raw;
}

export function parseBBox(raw: unknown): BBoxLatLon {
  const parts = typeof raw === 'string' ? raw.split(',').map((part) => Number(part.trim())) : [];
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new BadRequestError('Niepoprawny parametr „bbox” — oczekiwano: zachód,południe,wschód,północ (stopnie).');
  }
  const [west, south, east, north] = parts;
  if (west >= east || south >= north || Math.abs(south) > 90 || Math.abs(north) > 90) {
    throw new BadRequestError('Niepoprawny parametr „bbox” — zachód musi być mniejszy od wschodu, a południe od północy.');
  }
  return { west, south, east, north };
}

export function parseMobility(raw: unknown): MobilityProfile {
  if (raw === undefined || raw === null) return 'default';
  if (typeof raw !== 'string' || !MOBILITY_PROFILES.includes(raw as MobilityProfile)) {
    throw new BadRequestError('Parametr „mobility” musi mieć wartość „default”, „accessible” albo „senior”.');
  }
  return raw as MobilityProfile;
}

export function parseComfort(raw: unknown): ComfortMode {
  if (raw === undefined || raw === null) return 'auto';
  if (typeof raw !== 'string' || !COMFORT_MODES.includes(raw as ComfortMode)) {
    throw new BadRequestError('Parametr „comfort” musi mieć wartość „shade”, „sun” albo „auto”.');
  }
  return raw as ComfortMode;
}

export function parseOptionalBoolean(raw: unknown, name: string): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw new BadRequestError(`Parametr „${name}” musi mieć wartość true albo false.`);
  return raw;
}

/** Lista rodzajów punktów chłodu z parametru zapytania („a,b,c”); undefined = wszystkie. */
export function parseKinds(raw: unknown): CoolSpotKind[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = typeof raw === 'string' ? raw.split(',').map((part) => part.trim()).filter((part) => part !== '') : null;
  if (!parts || parts.length === 0 || !parts.every((part) => COOL_SPOT_KINDS.includes(part as CoolSpotKind))) {
    throw new BadRequestError(`Niepoprawny parametr „kinds” — dozwolone wartości: ${COOL_SPOT_KINDS.join(', ')}.`);
  }
  return [...new Set(parts)] as CoolSpotKind[];
}

function asBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestError('Brak danych zapytania (JSON).');
  return raw as Record<string, unknown>;
}

function parseShadePreference(raw: unknown): number {
  return parseOptionalNumber(raw, 0, 1, 'Parametr „shadePreference” musi być liczbą od 0 do 1.') ?? DEFAULT_SHADE_PREFERENCE;
}

/** Zapytanie o trasę po walidacji. `walkSpeed` undefined = domyślna prędkość profilu poruszania się. */
export interface ParsedRouteRequest {
  from: LatLon;
  to: LatLon;
  departure: Date;
  shadePreference: number;
  walkSpeed?: number;
  mobility: MobilityProfile;
  comfort: ComfortMode;
  viaCoolSpot: boolean;
}

export function parseRouteRequest(raw: unknown): ParsedRouteRequest {
  const body = asBody(raw);
  return {
    from: parsePoint(body.from, 'startowego'),
    to: parsePoint(body.to, 'docelowego'),
    departure: parseTime(body.time),
    shadePreference: parseShadePreference(body.shadePreference),
    walkSpeed: parseOptionalNumber(
      body.walkSpeed, MIN_WALK_SPEED, MAX_WALK_SPEED,
      `Parametr „walkSpeed” musi być liczbą od ${MIN_WALK_SPEED} do ${MAX_WALK_SPEED} m/s.`,
    ),
    mobility: parseMobility(body.mobility),
    comfort: parseComfort(body.comfort),
    viaCoolSpot: parseOptionalBoolean(body.viaCoolSpot, 'viaCoolSpot'),
  };
}

export interface ParsedDepartureRequest {
  from: LatLon;
  to: LatLon;
  /** Początek okna; undefined = teraz. */
  start?: Date;
  windowHours: number;
  stepMinutes: number;
  shadePreference: number;
  mobility: MobilityProfile;
  comfort: ComfortMode;
}

export function parseDepartureRequest(raw: unknown): ParsedDepartureRequest {
  const body = asBody(raw);
  return {
    from: parsePoint(body.from, 'startowego'),
    to: parsePoint(body.to, 'docelowego'),
    start: body.start === undefined || body.start === null ? undefined : parseStart(body.start),
    windowHours:
      parseOptionalNumber(
        body.windowHours, 0.25, MAX_WINDOW_HOURS,
        `Parametr „windowHours” musi być liczbą od 0,25 do ${MAX_WINDOW_HOURS} (godziny).`,
      ) ?? DEFAULT_WINDOW_HOURS,
    stepMinutes:
      parseOptionalNumber(
        body.stepMinutes, MIN_STEP_MINUTES, MAX_STEP_MINUTES,
        `Parametr „stepMinutes” musi być liczbą od ${MIN_STEP_MINUTES} do ${MAX_STEP_MINUTES} (minuty).`,
      ) ?? DEFAULT_STEP_MINUTES,
    shadePreference: parseShadePreference(body.shadePreference),
    mobility: parseMobility(body.mobility),
    comfort: parseComfort(body.comfort),
  };
}

function parseStart(raw: unknown): Date {
  try {
    return parseTime(raw);
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw new BadRequestError(error.message.replace('Brak parametru „time”', 'Niepoprawny parametr „start”').replace('Niepoprawny czas', 'Niepoprawny parametr „start”'));
    }
    throw error;
  }
}
