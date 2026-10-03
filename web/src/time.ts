// Czas w aplikacji to zawsze czas ścienny Krakowa (Europe/Warsaw), niezależnie od strefy przeglądarki.
// Moduł zamienia parę (data, minuty od północy) na poprawny moment UTC / ISO z offsetem i odwrotnie.

import { TIMEZONE } from '../../shared/types.ts';

export const SLIDER_STEP_MIN = 15;
export const SLIDER_MAX_MIN = 24 * 60 - SLIDER_STEP_MIN;

const MINUTE_MS = 60_000;
const HALF_DAY_MS = 12 * 60 * MINUTE_MS;

/** Czas ścienny w Krakowie: data kalendarzowa i minuty od północy. */
export interface WallTime {
  /** YYYY-MM-DD */
  date: string;
  /** 0..1439 */
  minutes: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const longDateFormatter = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallParts(instant: Date): WallParts {
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of partsFormatter.formatToParts(instant)) {
    if (part.type in out) out[part.type as keyof WallParts] = Number(part.value);
  }
  return out;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Offset Krakowa względem UTC w minutach (np. 120 latem, 60 zimą) w podanej chwili. */
export function offsetMinutesAt(instant: Date): number {
  const p = wallParts(instant);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - instantSeconds) / MINUTE_MS);
}

export function isValidDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Zamienia czas ścienny Krakowa na moment.
 * Offset bywa różny przed i po zmianie czasu, więc sprawdzamy oba kandydujące offsety (z −12 h i +12 h):
 *  - zwykły dzień: oba są równe, wynik jednoznaczny;
 *  - godzina powtórzona jesienią (02:00–03:00): oba pasują — wybieramy wcześniejszy moment (czas letni);
 *  - godzina nieistniejąca wiosną (02:00–03:00): żaden nie pasuje — liczymy offsetem sprzed zmiany,
 *    co przesuwa czas o godzinę do przodu (02:30 → 03:30), tak jak robią to zegary.
 */
export function wallTimeToInstant(date: string, minutes: number): Date {
  if (!isValidDateString(date)) throw new RangeError(`Nieprawidłowa data: ${date}`);
  const [year, month, day] = date.split('-').map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, minutes);
  const before = offsetMinutesAt(new Date(wallAsUtc - HALF_DAY_MS));
  const after = offsetMinutesAt(new Date(wallAsUtc + HALF_DAY_MS));
  for (const offset of [before, after]) {
    const candidate = new Date(wallAsUtc - offset * MINUTE_MS);
    if (offsetMinutesAt(candidate) === offset) return candidate;
  }
  return new Date(wallAsUtc - before * MINUTE_MS);
}

export function instantToWallTime(instant: Date): WallTime {
  const p = wallParts(instant);
  return {
    date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    minutes: p.hour * 60 + p.minute,
  };
}

/** ISO 8601 z offsetem Krakowa, np. 2026-07-15T13:00:00+02:00. */
export function toIsoWithOffset(instant: Date): string {
  const p = wallParts(instant);
  const offset = offsetMinutesAt(instant);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

export function wallTimeToIso(date: string, minutes: number): string {
  return toIsoWithOffset(wallTimeToInstant(date, minutes));
}

/** Bieżący czas Krakowa zaokrąglony w dół do kroku suwaka. */
export function nowWallTime(now: Date = new Date(), stepMin: number = SLIDER_STEP_MIN): WallTime {
  const wall = instantToWallTime(now);
  return { date: wall.date, minutes: Math.floor(wall.minutes / stepMin) * stepMin };
}

/** Minuty od północy → "HH:MM". */
export function formatClock(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/** "HH:MM" → minuty od północy albo null, gdy zapis jest nieprawidłowy. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/** Godzina w Krakowie ("HH:MM") dla momentu podanego jako ISO lub Date; null dla błędnych danych. */
export function formatKrakowClock(instant: string | Date): string | null {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return null;
  return formatClock(instantToWallTime(date).minutes);
}

/** Minuty od północy w Krakowie dla momentu ISO (np. wschód słońca) albo null. */
export function krakowMinutesOf(iso: string | null): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return instantToWallTime(date).minutes;
}

/** "2026-07-15" → "środa, 15 lipca". */
export function formatLongDate(date: string): string {
  if (!isValidDateString(date)) return date;
  const [year, month, day] = date.split('-').map(Number);
  return longDateFormatter.format(new Date(Date.UTC(year, month - 1, day)));
}
