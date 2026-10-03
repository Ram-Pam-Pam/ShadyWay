import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SunInfo, WeatherInfo } from '../shared/types.ts';
import { clearWeatherCache, getWeather, pickHour, sunFactorFrom, type OpenMeteoHourly } from '../server/weather/openmeteo.ts';
import {
  buildLabel,
  clearGeocodeCache,
  geocode,
  GeocoderUnavailableError,
  parseNominatim,
  parsePhoton,
  reverseGeocode,
} from '../server/geocode.ts';

const NOW = new Date('2026-07-15T10:20:00Z');

const hourly: OpenMeteoHourly = {
  time: ['2026-07-15T10:00', '2026-07-15T11:00', '2026-07-15T12:00', '2026-07-15T13:00'],
  temperature_2m: [24.1, 25.6, 27.0, null],
  apparent_temperature: [25.0, 27.2, 29.1, null],
  cloud_cover: [10, 35, 80, null],
  direct_normal_irradiance: [710.5, 540.0, 120.0, null],
  uv_index: [5.1, 6.3, 6.9, null],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const sun = (altitudeDeg: number, isDay = altitudeDeg > 0): SunInfo => ({
  azimuthDeg: 180,
  altitudeDeg,
  sunrise: null,
  sunset: null,
  isDay,
});

const weather = (over: Partial<WeatherInfo>): WeatherInfo => ({
  time: NOW.toISOString(),
  temperatureC: 25,
  apparentTemperatureC: 26,
  cloudCoverPct: null,
  directRadiationWm2: null,
  uvIndex: null,
  source: 'open-meteo',
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  clearWeatherCache();
  clearGeocodeCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pickHour', () => {
  it('wybiera godzinę najbliższą żądanej chwili (czasy odpowiedzi są w UTC)', () => {
    const info = pickHour(hourly, new Date('2026-07-15T13:20:00+02:00'));
    expect(info).toEqual({
      time: '2026-07-15T11:00:00.000Z',
      temperatureC: 25.6,
      apparentTemperatureC: 27.2,
      cloudCoverPct: 35,
      directRadiationWm2: 540,
      uvIndex: 6.3,
      source: 'open-meteo',
    });
    expect(pickHour(hourly, new Date('2026-07-15T11:40:00Z'))?.time).toBe('2026-07-15T12:00:00.000Z');
  });

  it('zwraca null poza zakresem odpowiedzi i dla godzin bez wartości', () => {
    expect(pickHour(hourly, new Date('2026-07-15T08:30:00Z'))).toBeNull();
    expect(pickHour(hourly, new Date('2026-07-16T13:00:00Z'))).toBeNull();
    expect(pickHour(hourly, new Date('2026-07-15T13:00:00Z'))).toBeNull();
    expect(pickHour({ time: [] }, NOW)).toBeNull();
  });

  it('uzupełnia brakujące serie wartością null', () => {
    const info = pickHour({ time: ['2026-07-15T10:00'], temperature_2m: [20] }, NOW);
    expect(info).toMatchObject({ temperatureC: 20, uvIndex: null, cloudCoverPct: null });
  });
});

describe('getWeather', () => {
  it('korzysta z prognozy i pamięta odpowiedź', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ hourly }));
    vi.stubGlobal('fetch', fetchMock);

    const a = await getWeather(new Date('2026-07-15T11:10:00Z'));
    const b = await getWeather(new Date('2026-07-15T12:05:00Z'));
    expect(a).toMatchObject({ source: 'open-meteo', temperatureC: 25.6, time: '2026-07-15T11:00:00.000Z' });
    expect(b.temperatureC).toBe(27);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('api.open-meteo.com/v1/forecast');
    expect(url).toContain('timezone=UTC');
    expect(url).toContain('past_days=7');
  });

  it('dla starszych dat sięga do archiwum', async () => {
    const archive: OpenMeteoHourly = { time: ['2025-08-01T12:00'], temperature_2m: [31.5], cloud_cover: [5] };
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ hourly: archive }));
    vi.stubGlobal('fetch', fetchMock);

    const info = await getWeather(new Date('2025-08-01T12:10:00Z'));
    expect(info).toMatchObject({ source: 'open-meteo', temperatureC: 31.5, uvIndex: null });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('archive-api.open-meteo.com/v1/archive');
    expect(url).toContain('start_date=2025-08-01&end_date=2025-08-01');
  });

  it('zwraca "unavailable" dla dat zbyt odległych, bez pytania sieci', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const info = await getWeather(new Date('2026-09-15T12:00:00Z'));
    expect(info).toMatchObject({ source: 'unavailable', temperatureC: null, directRadiationWm2: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('nie rzuca przy błędzie sieci, błędzie HTTP ani złej dacie', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect((await getWeather(NOW)).source).toBe('unavailable');

    clearWeatherCache();
    vi.stubGlobal('fetch', vi.fn(async (_url: string) => jsonResponse({ error: true }, 500)));
    expect((await getWeather(NOW)).source).toBe('unavailable');

    expect((await getWeather(new Date('nonsense'))).source).toBe('unavailable');
  });
});

describe('sunFactorFrom', () => {
  it.each([
    ['noc', sun(-5), null, 0],
    ['isDay=false mimo dodatniej wysokości', sun(3, false), null, 0],
    ['wysokie słońce, brak pogody', sun(40), null, 1],
    ['niskie słońce 4°', sun(4), null, 0.5],
    ['pogoda bez danych', sun(40), weather({ source: 'unavailable' }), 1],
    ['DNI 300 W/m²', sun(40), weather({ directRadiationWm2: 300 }), 0.5],
    ['DNI 900 W/m² (przycięte do 1)', sun(40), weather({ directRadiationWm2: 900 }), 1],
    ['DNI 0 (dolna granica 0.15)', sun(40), weather({ directRadiationWm2: 0, cloudCoverPct: 100 }), 0.15],
    ['DNI ma pierwszeństwo przed zachmurzeniem', sun(40), weather({ directRadiationWm2: 600, cloudCoverPct: 100 }), 1],
    ['zachmurzenie 100%', sun(40), weather({ cloudCoverPct: 100 }), 0.2],
    ['zachmurzenie 50%', sun(40), weather({ cloudCoverPct: 50 }), 0.8],
    ['zachmurzenie 0%', sun(40), weather({ cloudCoverPct: 0 }), 1],
    ['niskie słońce × DNI', sun(4), weather({ directRadiationWm2: 300 }), 0.25],
  ] as [string, SunInfo, WeatherInfo | null, number][])('%s', (_name, s, w, expected) => {
    expect(sunFactorFrom(s, w)).toBeCloseTo(expected, 6);
  });
});

describe('geokodowanie', () => {
  const photonBody = {
    features: [
      {
        properties: { name: 'Sukiennice', street: 'Rynek Główny', housenumber: '3', district: 'Stare Miasto', city: 'Kraków' },
        geometry: { coordinates: [19.9373511, 50.0617012] },
      },
      {
        properties: { name: 'Floriańska', locality: 'Stare Miasto', city: 'Kraków' },
        geometry: { coordinates: [19.9414333, 50.0650454] },
      },
      {
        // Kolejny odcinek tej samej ulicy — ta sama etykieta, do odrzucenia.
        properties: { name: 'Floriańska', locality: 'Stare Miasto', city: 'Kraków' },
        geometry: { coordinates: [19.941353, 50.0648565] },
      },
      {
        properties: { name: 'Rynek', city: 'Warszawa' },
        geometry: { coordinates: [21.0122, 52.2497] },
      },
    ],
  };

  it('buduje czytelne etykiety bez powtórzeń', () => {
    expect(buildLabel({ name: 'Sukiennice', street: 'Rynek Główny', housenumber: '3', district: 'Stare Miasto', city: 'Kraków' })).toBe(
      'Sukiennice, Rynek Główny 3, Stare Miasto, Kraków',
    );
    expect(buildLabel({ street: 'Floriańska', housenumber: '12', district: 'Stare Miasto', city: 'Kraków' })).toBe(
      'Floriańska 12, Stare Miasto, Kraków',
    );
    expect(buildLabel({ name: 'Floriańska', street: 'Floriańska', city: 'Kraków' })).toBe('Floriańska, Kraków');
    expect(buildLabel({ name: 'Kraków', city: 'Kraków' })).toBe('Kraków');
    expect(buildLabel({ name: 'Zesławice', housenumber: '7', city: 'Kraków' })).toBe('Zesławice 7, Kraków');
    expect(buildLabel({})).toBe('');
  });

  it('parsuje Photon: etykiety, filtr obszaru, deduplikacja', () => {
    expect(parsePhoton(photonBody)).toEqual([
      { label: 'Sukiennice, Rynek Główny 3, Stare Miasto, Kraków', lat: 50.0617012, lon: 19.9373511 },
      { label: 'Floriańska, Stare Miasto, Kraków', lat: 50.0650454, lon: 19.9414333 },
    ]);
    expect(parsePhoton({})).toEqual([]);
  });

  it('parsuje Nominatim (lista i pojedynczy obiekt)', () => {
    const place = {
      lat: '50.0539422',
      lon: '19.9351513',
      name: 'Zamek Wawel',
      address: { road: 'Droga do Zamku', suburb: 'Stare Miasto', city: 'Kraków' },
    };
    const expected = { label: 'Zamek Wawel, Droga do Zamku, Stare Miasto, Kraków', lat: 50.0539422, lon: 19.9351513 };
    expect(parseNominatim([place])).toEqual([expected]);
    expect(parseNominatim(place)).toEqual([expected]);
    expect(parseNominatim({ error: 'Unable to geocode' })).toEqual([]);
  });

  it('geocode: pyta Photon z bbox Krakowa i pamięta wynik', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(photonBody));
    vi.stubGlobal('fetch', fetchMock);
    const first = await geocode('  Sukiennice ');
    const second = await geocode('sukiennice');
    expect(first).toHaveLength(2);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('photon.komoot.io/api/?q=Sukiennice');
    expect(url).toContain('bbox=19.78,49.96,20.22,50.13');
  });

  it('geocode: przechodzi na Nominatim, gdy Photon zawiedzie; błąd (nie „brak wyników”), gdy oba zawiodą', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('photon')
        ? jsonResponse({}, 503)
        : jsonResponse([{ lat: '50.054', lon: '19.936', name: 'Wawel', address: { city: 'Kraków' } }]),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await geocode('Wawel')).toEqual([{ label: 'Wawel, Kraków', lat: 50.054, lon: 19.936 }]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('nominatim.openstreetmap.org/search');
    expect(String(fetchMock.mock.calls[1][0])).toContain('bounded=1');

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    await expect(geocode('Kazimierz')).rejects.toBeInstanceOf(GeocoderUnavailableError);
    await expect(geocode('Kazimierz')).rejects.toThrow(/chwilowo niedostępna/);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 429)));
    await expect(geocode('Kazimierz')).rejects.toBeInstanceOf(GeocoderUnavailableError);
    expect(await geocode('a')).toEqual([]);
    // Awaria nie jest zapamiętywana, a prawdziwy brak trafień to nadal pusta lista.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ features: [] })));
    expect(await geocode('Kazimierz')).toEqual([]);
  });

  it('reverseGeocode: wynik z Photon, null poza obszarem i przy błędzie', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ features: [photonBody.features[0]] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await reverseGeocode(50.0617, 19.9373)).toEqual({
      label: 'Sukiennice, Rynek Główny 3, Stare Miasto, Kraków',
      lat: 50.0617012,
      lon: 19.9373511,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('photon.komoot.io/reverse?lat=50.0617&lon=19.9373');
    expect(await reverseGeocode(52.23, 21.01)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    expect(await reverseGeocode(50.05, 19.95)).toBeNull();
  });
});
