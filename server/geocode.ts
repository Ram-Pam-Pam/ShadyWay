// Geokodowanie adresów i miejsc w Krakowie: Photon (komoot), z zapasowym Nominatim.

import { KRAKOW_BBOX } from '../shared/types.ts';
import type { GeocodeResult } from '../shared/types.ts';

const PHOTON_URL = 'https://photon.komoot.io';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'cien-smartcity/0.1 (nawigacja piesza po Krakowie)';
const TIMEOUT_MS = 5000;
const RESULT_LIMIT = 6;
const CACHE_MAX_ENTRIES = 500;
const MIN_QUERY_LENGTH = 2;

/** Składniki adresu wspólne dla obu dostawców. */
export interface AddressParts {
  name?: string;
  street?: string;
  housenumber?: string;
  district?: string;
  city?: string;
}

interface PhotonFeature {
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    locality?: string;
    city?: string;
  };
  geometry: { coordinates: [number, number] };
}

interface NominatimPlace {
  lat: string;
  lon: string;
  name?: string;
  address?: {
    road?: string;
    pedestrian?: string;
    house_number?: string;
    city_district?: string;
    suburb?: string;
    quarter?: string;
    city?: string;
    town?: string;
    village?: string;
  };
}

/**
 * Etykieta w polskim stylu: „Nazwa, Ulica 12, Dzielnica, Miasto” — bez powtórzeń
 * (np. gdy nazwa obiektu jest nazwą ulicy albo dzielnica nazywa się jak miasto).
 */
export function buildLabel(parts: AddressParts): string {
  const address = parts.street
    ? [parts.street, parts.housenumber].filter(Boolean).join(' ')
    : parts.name && parts.housenumber
      ? `${parts.name} ${parts.housenumber}`
      : undefined;
  const name = address && !parts.street ? undefined : parts.name;
  const out: string[] = [];
  for (const part of [name, address, parts.district, parts.city]) {
    const text = part?.trim();
    if (text && !out.some((p) => p.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out.join(', ');
}

function inArea(lat: number, lon: number): boolean {
  return lon >= KRAKOW_BBOX.west && lon <= KRAKOW_BBOX.east && lat >= KRAKOW_BBOX.south && lat <= KRAKOW_BBOX.north;
}

/** Odrzuca wyniki spoza obszaru, bez etykiety oraz powtórzenia tej samej etykiety (np. odcinki jednej ulicy). */
function finalize(candidates: GeocodeResult[]): GeocodeResult[] {
  const seen = new Set<string>();
  const out: GeocodeResult[] = [];
  for (const c of candidates) {
    if (!c.label || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !inArea(c.lat, c.lon)) continue;
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    out.push(c);
  }
  return out.slice(0, RESULT_LIMIT);
}

export function parsePhoton(body: unknown): GeocodeResult[] {
  const features = (body as { features?: PhotonFeature[] }).features ?? [];
  return finalize(
    features.map((f) => {
      const p = f.properties;
      const [lon, lat] = f.geometry.coordinates;
      return { label: buildLabel({ ...p, district: p.district ?? p.locality }), lat, lon };
    }),
  );
}

export function parseNominatim(body: unknown): GeocodeResult[] {
  const places = Array.isArray(body) ? (body as NominatimPlace[]) : [body as NominatimPlace];
  return finalize(
    places
      .filter((p) => p && p.lat !== undefined)
      .map((p) => {
        const a = p.address ?? {};
        const label = buildLabel({
          name: p.name || undefined,
          street: a.road ?? a.pedestrian,
          housenumber: a.house_number,
          district: a.city_district ?? a.suburb ?? a.quarter,
          city: a.city ?? a.town ?? a.village,
        });
        return { label, lat: Number(p.lat), lon: Number(p.lon) };
      }),
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const searchCache = new Map<string, GeocodeResult[]>();
const reverseCache = new Map<string, GeocodeResult | null>();

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

/** Obaj dostawcy geokodowania zawiedli (awaria, limit zapytań) — to co innego niż „nic nie znaleziono”. */
export class GeocoderUnavailableError extends Error {
  constructor() {
    super('Wyszukiwarka adresów jest chwilowo niedostępna — wskaż punkt na mapie albo spróbuj ponownie za chwilę.');
    this.name = 'GeocoderUnavailableError';
  }
}

/** Wyszukuje miejsca w obszarze Krakowa ([] = brak trafień). Przy błędzie obu dostawców rzuca GeocoderUnavailableError. */
export async function geocode(q: string): Promise<GeocodeResult[]> {
  const query = q.trim();
  if (query.length < MIN_QUERY_LENGTH) return [];
  const key = query.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;

  const { west, south, east, north } = KRAKOW_BBOX;
  const encoded = encodeURIComponent(query);
  try {
    const body = await fetchJson(
      `${PHOTON_URL}/api/?q=${encoded}&limit=${RESULT_LIMIT}&lang=default&bbox=${west},${south},${east},${north}`,
    );
    return remember(searchCache, key, parsePhoton(body));
  } catch {
    // Photon niedostępny — próbujemy Nominatim.
  }
  try {
    const body = await fetchJson(
      `${NOMINATIM_URL}/search?format=jsonv2&q=${encoded}&limit=${RESULT_LIMIT}&addressdetails=1` +
        `&accept-language=pl&viewbox=${west},${north},${east},${south}&bounded=1`,
    );
    return remember(searchCache, key, parseNominatim(body));
  } catch {
    throw new GeocoderUnavailableError();
  }
}

/** Najbliższy adres/miejsce dla punktu albo null (poza obszarem, brak wyniku, błąd sieci). */
export async function reverseGeocode(lat: number, lon: number): Promise<GeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inArea(lat, lon)) return null;
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (reverseCache.has(key)) return reverseCache.get(key) ?? null;

  try {
    const body = await fetchJson(`${PHOTON_URL}/reverse?lat=${lat}&lon=${lon}&lang=default`);
    return remember(reverseCache, key, parsePhoton(body)[0] ?? null);
  } catch {
    // Photon niedostępny — próbujemy Nominatim.
  }
  try {
    const body = await fetchJson(
      `${NOMINATIM_URL}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=pl`,
    );
    return remember(reverseCache, key, parseNominatim(body)[0] ?? null);
  } catch {
    return null;
  }
}

/** Czyści pamięć podręczną (do testów). */
export function clearGeocodeCache(): void {
  searchCache.clear();
  reverseCache.clear();
}
