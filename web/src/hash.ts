// Zapis i odczyt stanu trasy w hashu adresu URL
// (#a=lat,lon&an=nazwa&b=…&d=YYYY-MM-DD&t=HH:MM&p=0.5&m=accessible),
// dzięki czemu trasę można udostępnić linkiem i odtworzyć po odświeżeniu strony.
// Dawne pola linków (c= tryb komfortu, v= punkt chłodu) są ignorowane.

import { KRAKOW_BBOX, type MobilityProfile } from '../../shared/types.ts';
import { formatCoordinates } from './format.ts';
import type { AppState, Place } from './store.ts';
import { formatClock, isValidDateString, parseClock } from './time.ts';

export type ShareableState = Pick<
  AppState,
  'from' | 'to' | 'date' | 'minutes' | 'followNow' | 'shadePreference' | 'mobility'
>;

export interface ParsedHash {
  from: Place | null;
  to: Place | null;
  /** Obecne tylko wtedy, gdy link zawiera poprawną datę i godzinę. */
  time: { date: string; minutes: number } | null;
  shadePreference: number | null;
  /** null = link nie podaje wartości (wartości domyślne nie są zapisywane w linku). */
  mobility: MobilityProfile | null;
}

const MOBILITY_VALUES: readonly MobilityProfile[] = ['default', 'accessible', 'senior'];

export function parseMobility(value: unknown): MobilityProfile | null {
  return MOBILITY_VALUES.includes(value as MobilityProfile) ? (value as MobilityProfile) : null;
}

function parsePlace(coords: string | null, name: string | null): Place | null {
  if (!coords) return null;
  const parts = coords.split(',').map(Number);
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) return null;
  const [lat, lon] = parts;
  const inArea =
    lat >= KRAKOW_BBOX.south && lat <= KRAKOW_BBOX.north && lon >= KRAKOW_BBOX.west && lon <= KRAKOW_BBOX.east;
  if (!inArea) return null;
  return { lat, lon, label: name?.trim() || formatCoordinates({ lat, lon }) };
}

export function parseHash(hash: string): ParsedHash {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const date = params.get('d');
  const minutes = parseClock(params.get('t') ?? '');
  const preference = params.has('p') ? Number(params.get('p')) : Number.NaN;
  return {
    from: parsePlace(params.get('a'), params.get('an')),
    to: parsePlace(params.get('b'), params.get('bn')),
    time: date && isValidDateString(date) && minutes !== null ? { date, minutes } : null,
    shadePreference: Number.isFinite(preference) ? Math.min(1, Math.max(0, preference)) : null,
    mobility: parseMobility(params.get('m')),
  };
}

export function serializeHash(state: ShareableState): string {
  const params = new URLSearchParams();
  const addPlace = (key: string, place: Place | null): void => {
    if (!place) return;
    params.set(key, `${place.lat.toFixed(5)},${place.lon.toFixed(5)}`);
    params.set(`${key}n`, place.label);
  };
  addPlace('a', state.from);
  addPlace('b', state.to);
  if (!state.followNow) {
    params.set('d', state.date);
    params.set('t', formatClock(state.minutes));
  }
  params.set('p', state.shadePreference.toFixed(2));
  // Wartości domyślne pomijamy — link zostaje krótki, a stare linki znaczą to samo co dawniej.
  if (state.mobility !== 'default') params.set('m', state.mobility);
  // Przecinki i dwukropki są w hashu bezpieczne — zostawiamy je czytelne.
  return params.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}
