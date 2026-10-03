// Pogoda z Open-Meteo: prognoza (−7 … +16 dni) oraz archiwum dla starszych dat.

import { KRAKOW_CENTER } from '../../shared/types.ts';
import type { SunInfo, WeatherInfo } from '../../shared/types.ts';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const LOCATION = `latitude=${KRAKOW_CENTER.lat}&longitude=${KRAKOW_CENTER.lon}`;
const FORECAST_VARS = 'temperature_2m,apparent_temperature,cloud_cover,direct_normal_irradiance,uv_index';
/** Archiwum (ERA5) nie udostępnia indeksu UV. */
const ARCHIVE_VARS = 'temperature_2m,apparent_temperature,cloud_cover,direct_normal_irradiance';

const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 15 * 60 * 1000;
/** Nieudane pobrania pamiętamy krótko, żeby awaria Open-Meteo nie spowalniała każdego zapytania o trasę. */
const FAILURE_TTL_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const FORECAST_PAST_DAYS = 7;
const FORECAST_DAYS = 16;

/** Odpowiedź Open-Meteo (część `hourly`); czasy w UTC bez sufiksu strefy, np. "2026-07-15T11:00". */
export interface OpenMeteoHourly {
  time: string[];
  temperature_2m?: (number | null)[];
  apparent_temperature?: (number | null)[];
  cloud_cover?: (number | null)[];
  direct_normal_irradiance?: (number | null)[];
  uv_index?: (number | null)[];
}

interface CacheEntry {
  expires: number;
  hourly: Promise<OpenMeteoHourly | null>;
}

const cache = new Map<string, CacheEntry>();

function unavailable(time: Date): WeatherInfo {
  return {
    time: time.toISOString(),
    temperatureC: null,
    apparentTemperatureC: null,
    cloudCoverPct: null,
    directRadiationWm2: null,
    uvIndex: null,
    source: 'unavailable',
  };
}

/**
 * Wybiera z odpowiedzi godzinę najbliższą `time`. Zwraca null, gdy `time` leży poza zakresem odpowiedzi
 * (dalej niż godzinę od najbliższego wpisu) albo gdy dla tej godziny nie ma jeszcze żadnych wartości
 * (archiwum jest opóźnione o kilka dni).
 */
export function pickHour(hourly: OpenMeteoHourly, time: Date): WeatherInfo | null {
  const target = time.getTime();
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    const diff = Math.abs(Date.parse(`${hourly.time[i]}Z`) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  if (best < 0 || bestDiff > HOUR_MS) return null;

  const at = (series?: (number | null)[]): number | null => series?.[best] ?? null;
  const info: WeatherInfo = {
    time: new Date(Date.parse(`${hourly.time[best]}Z`)).toISOString(),
    temperatureC: at(hourly.temperature_2m),
    apparentTemperatureC: at(hourly.apparent_temperature),
    cloudCoverPct: at(hourly.cloud_cover),
    directRadiationWm2: at(hourly.direct_normal_irradiance),
    uvIndex: at(hourly.uv_index),
    source: 'open-meteo',
  };
  const hasData =
    info.temperatureC !== null ||
    info.apparentTemperatureC !== null ||
    info.cloudCoverPct !== null ||
    info.directRadiationWm2 !== null;
  return hasData ? info : null;
}

async function fetchHourly(url: string): Promise<OpenMeteoHourly | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { hourly?: OpenMeteoHourly };
    return Array.isArray(body.hourly?.time) ? body.hourly : null;
  } catch {
    return null;
  }
}

function cachedHourly(key: string, url: string): Promise<OpenMeteoHourly | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.hourly;
  for (const [k, entry] of cache) if (entry.expires <= now) cache.delete(k);

  const entry: CacheEntry = { expires: now + CACHE_TTL_MS, hourly: fetchHourly(url) };
  cache.set(key, entry);
  void entry.hourly.then((hourly) => {
    if (hourly === null) entry.expires = Date.now() + FAILURE_TTL_MS;
  });
  return entry.hourly;
}

/** Pogoda dla godziny najbliższej `time`. Nigdy nie rzuca; przy braku danych zwraca source: 'unavailable'. */
export async function getWeather(time: Date): Promise<WeatherInfo> {
  const t = time.getTime();
  if (!Number.isFinite(t)) return unavailable(new Date(0));
  try {
    const now = Date.now();
    const dayMs = 24 * HOUR_MS;
    if (t > now + FORECAST_DAYS * dayMs) return unavailable(time);

    if (t >= now - FORECAST_PAST_DAYS * dayMs) {
      const url =
        `${FORECAST_URL}?${LOCATION}&hourly=${FORECAST_VARS}&timezone=UTC` +
        `&past_days=${FORECAST_PAST_DAYS}&forecast_days=${FORECAST_DAYS}`;
      const hourly = await cachedHourly('forecast', url);
      const picked = hourly && pickHour(hourly, time);
      if (picked) return picked;
    }

    // Dzień (UTC) godziny po zaokrągleniu, żeby np. 23:40 trafiło do odpowiedzi z kolejnego dnia.
    const day = new Date(Math.round(t / HOUR_MS) * HOUR_MS).toISOString().slice(0, 10);
    const url = `${ARCHIVE_URL}?${LOCATION}&hourly=${ARCHIVE_VARS}&timezone=UTC&start_date=${day}&end_date=${day}`;
    const hourly = await cachedHourly(`archive:${day}`, url);
    return (hourly && pickHour(hourly, time)) || unavailable(time);
  } catch {
    return unavailable(time);
  }
}

/** Czyści pamięć podręczną odpowiedzi (do testów). */
export function clearWeatherCache(): void {
  cache.clear();
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Jak mocno bezpośrednie słońce "liczy się" w danej chwili, 0..1:
 *   sunFactor = wysokość × pogoda
 *   wysokość  = 0 w nocy, poza tym clamp(wysokość słońca / 8°, 0, 1) — nisko nad horyzontem słońce grzeje słabo;
 *   pogoda    = clamp(DNI / 600 W/m², 0.15, 1), gdy znamy bezpośrednie promieniowanie,
 *               w przeciwnym razie 1 − 0.8 × (zachmurzenie / 100)², gdy znamy zachmurzenie,
 *               w przeciwnym razie 1 (brak danych = zakładamy pełne słońce).
 */
export function sunFactorFrom(sun: SunInfo, weather: WeatherInfo | null): number {
  if (!sun.isDay) return 0;
  const altitudeFactor = clamp(sun.altitudeDeg / 8, 0, 1);
  let weatherFactor = 1;
  if (weather && weather.directRadiationWm2 !== null) {
    weatherFactor = clamp(weather.directRadiationWm2 / 600, 0.15, 1);
  } else if (weather && weather.cloudCoverPct !== null) {
    weatherFactor = 1 - 0.8 * (clamp(weather.cloudCoverPct, 0, 100) / 100) ** 2;
  }
  return altitudeFactor * weatherFactor;
}
