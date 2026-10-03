// Ostatnia wyznaczona trasa zapisana w pamięci urządzenia — do obejrzenia bez połączenia z siecią.
// Zapytania POST nie przechodzą przez pamięć podręczną service workera, więc trasę zapisuje sama strona.

import type { RouteProfile, RouteResponse } from '../../shared/types.ts';
import { parseMobility } from './hash.ts';
import { inServiceArea } from './plan.ts';
import type { AppState, Place } from './store.ts';
import { isValidDateString } from './time.ts';

export const LAST_ROUTE_KEY = 'cien:last-route:v1';
/** Punkty uznajemy za te same, gdy różnią się o mniej niż ok. 1 m. */
const SAME_POINT_DEG = 1e-5;

export interface SavedRoute {
  /** Moment zapisu, ISO. */
  savedAt: string;
  from: Place;
  to: Place;
  date: string;
  minutes: number;
  shadePreference: number;
  mobility: AppState['mobility'];
  selectedProfile: RouteProfile;
  response: RouteResponse;
}

type SaveableState = Pick<
  AppState,
  'from' | 'to' | 'date' | 'minutes' | 'shadePreference' | 'mobility' | 'selectedProfile' | 'response'
>;

export function toSavedRoute(state: SaveableState, now: Date = new Date()): SavedRoute | null {
  if (!state.from || !state.to || !state.response || state.response.routes.length === 0) return null;
  return {
    savedAt: now.toISOString(),
    from: state.from,
    to: state.to,
    date: state.date,
    minutes: state.minutes,
    shadePreference: state.shadePreference,
    mobility: state.mobility,
    selectedProfile: state.selectedProfile,
    response: state.response,
  };
}

function parsePlace(value: unknown): Place | null {
  if (typeof value !== 'object' || value === null) return null;
  const { lat, lon, label } = value as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !inServiceArea({ lat, lon })) return null;
  return { lat, lon, label: typeof label === 'string' && label.trim() ? label : 'Punkt' };
}

function isRouteResponse(value: unknown): value is RouteResponse {
  if (typeof value !== 'object' || value === null) return false;
  const { routes, sun } = value as Record<string, unknown>;
  if (!Array.isArray(routes) || routes.length === 0 || typeof sun !== 'object' || sun === null) return false;
  return routes.every((route: unknown) => {
    if (typeof route !== 'object' || route === null) return false;
    const { profile, geometry, segments, distanceM } = route as Record<string, unknown>;
    return typeof profile === 'string' && Array.isArray(geometry) && Array.isArray(segments) && typeof distanceM === 'number';
  });
}

/** Odczyt zapisu; uszkodzony albo niekompletny zapis daje null. */
export function parseSavedRoute(raw: string | null | undefined): SavedRoute | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const from = parsePlace(record.from);
  const to = parsePlace(record.to);
  if (!from || !to || !isRouteResponse(record.response)) return null;
  if (typeof record.date !== 'string' || !isValidDateString(record.date)) return null;
  const minutes = Number(record.minutes);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  const preference = Number(record.shadePreference);
  const profile = record.selectedProfile;
  return {
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    from,
    to,
    date: record.date,
    minutes,
    shadePreference: Number.isFinite(preference) ? Math.min(1, Math.max(0, preference)) : 0.5,
    mobility: parseMobility(record.mobility) ?? 'default',
    selectedProfile: profile === 'shortest' || profile === 'shadiest' ? profile : 'balanced',
    response: record.response,
  };
}

function near(a: Place, b: Place): boolean {
  return Math.abs(a.lat - b.lat) < SAME_POINT_DEG && Math.abs(a.lon - b.lon) < SAME_POINT_DEG;
}

/** Zapis pasuje do bieżącego zapytania, gdy dotyczy tych samych punktów startu i celu. */
export function cachedRouteFor(state: Pick<AppState, 'from' | 'to'>, saved: SavedRoute | null): SavedRoute | null {
  if (!saved || !state.from || !state.to) return null;
  return near(state.from, saved.from) && near(state.to, saved.to) ? saved : null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function saveLastRoute(state: SaveableState, storage: StorageLike | null = defaultStorage()): void {
  const saved = toSavedRoute(state);
  if (!saved || !storage) return;
  try {
    storage.setItem(LAST_ROUTE_KEY, JSON.stringify(saved));
  } catch {
    // Brak miejsca: zapisujemy przynajmniej wybrany wariant trasy.
    try {
      const selected = saved.response.routes.find((route) => route.profile === saved.selectedProfile) ?? saved.response.routes[0];
      storage.setItem(LAST_ROUTE_KEY, JSON.stringify({ ...saved, response: { ...saved.response, routes: [selected] } }));
    } catch {
      // Pamięć niedostępna — aplikacja działa dalej, tylko bez trasy offline.
    }
  }
}

export function loadLastRoute(storage: StorageLike | null = defaultStorage()): SavedRoute | null {
  if (!storage) return null;
  try {
    return parseSavedRoute(storage.getItem(LAST_ROUTE_KEY));
  } catch {
    return null;
  }
}
