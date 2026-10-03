import { describe, expect, it } from 'vitest';
import type { WeatherInfo } from '../shared/types.ts';
import { stressCategory, sunDeltaC, thermalInfo } from '../server/graph/thermal.ts';

const RAD = Math.PI / 180;

function weather(extra: Partial<WeatherInfo> = {}): WeatherInfo {
  return {
    time: '2026-07-15T12:00:00.000Z',
    temperatureC: 30,
    apparentTemperatureC: 31,
    cloudCoverPct: 0,
    directRadiationWm2: 800,
    uvIndex: 7,
    source: 'open-meteo',
    ...extra,
  };
}

describe('thermalInfo', () => {
  it('bez pogody zwraca same null', () => {
    const empty = { feltSunC: null, feltShadeC: null, feltMeanC: null, stress: null };
    expect(thermalInfo(null, 1, 0.5)).toEqual(empty);
    expect(thermalInfo(undefined, 1, 0.5)).toEqual(empty);
    expect(thermalInfo(weather({ source: 'unavailable' }), 1, 0.5)).toEqual(empty);
    expect(thermalInfo(weather({ temperatureC: null, apparentTemperatureC: null }), 1, 0.5)).toEqual(empty);
  });

  it('w cieniu odczuwalna to temperatura odczuwalna z pogody, w słońcu o kilka–kilkanaście stopni więcej', () => {
    // Bezchmurne letnie popołudnie: DNI 800 W/m², słońce 55° nad horyzontem.
    const info = thermalInfo(weather(), 55 * RAD, 1);
    expect(info.feltShadeC).toBe(31);
    const delta = info.feltSunC! - info.feltShadeC!;
    expect(delta).toBeGreaterThanOrEqual(4);
    expect(delta).toBeLessThanOrEqual(12);
    expect(info.feltMeanC).toBe(info.feltSunC);
    // Nisko stojące słońce świeci na sylwetkę bardziej „z boku” — przyrost nie maleje do zera.
    expect(sunDeltaC(weather({ directRadiationWm2: 700 }), 25 * RAD)).toBeGreaterThan(4);
  });

  it('średnia trasy jest ważona ekspozycją', () => {
    const shade = thermalInfo(weather(), 55 * RAD, 0);
    const half = thermalInfo(weather(), 55 * RAD, 0.5);
    const sun = thermalInfo(weather(), 55 * RAD, 1);
    expect(shade.feltMeanC).toBe(shade.feltShadeC);
    expect(half.feltMeanC!).toBeCloseTo((sun.feltSunC! + sun.feltShadeC!) / 2, 0);
    expect(thermalInfo(weather(), 55 * RAD, 7).feltMeanC).toBe(sun.feltMeanC); // ekspozycja obcinana do 0..1
  });

  it('nocą i bez bezpośredniego promieniowania słońce nic nie dodaje', () => {
    expect(sunDeltaC(weather(), -0.1)).toBe(0);
    expect(sunDeltaC(weather(), 0)).toBe(0);
    expect(sunDeltaC(weather({ directRadiationWm2: 0 }), 55 * RAD)).toBe(0);
    const night = thermalInfo(weather(), -0.2, 1);
    expect(night.feltSunC).toBe(night.feltShadeC);
  });

  it('przyrost rośnie z promieniowaniem i nie przekracza 12 °C', () => {
    const weak = sunDeltaC(weather({ directRadiationWm2: 200 }), 40 * RAD);
    const strong = sunDeltaC(weather({ directRadiationWm2: 900 }), 40 * RAD);
    expect(weak).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(weak * 2);
    expect(sunDeltaC(weather({ directRadiationWm2: 5000 }), 20 * RAD)).toBe(12);
  });

  it('bez DNI szacuje promieniowanie z zachmurzenia; bez obu przyjmuje czyste niebo', () => {
    const clear = sunDeltaC(weather({ directRadiationWm2: null, cloudCoverPct: 0 }), 50 * RAD);
    const cloudy = sunDeltaC(weather({ directRadiationWm2: null, cloudCoverPct: 95 }), 50 * RAD);
    const unknown = sunDeltaC(weather({ directRadiationWm2: null, cloudCoverPct: null }), 50 * RAD);
    expect(clear).toBeGreaterThan(4);
    expect(cloudy).toBeLessThan(clear / 3);
    expect(unknown).toBeCloseTo(clear, 9);
  });

  it('gdy brak temperatury odczuwalnej, bazą jest temperatura powietrza', () => {
    expect(thermalInfo(weather({ apparentTemperatureC: null }), 55 * RAD, 0).feltShadeC).toBe(30);
  });

  it('kategorie obciążenia cieplnego wg progów UTCI', () => {
    expect(stressCategory(null)).toBeNull();
    expect(stressCategory(-3)).toBe('cold');
    expect(stressCategory(8.9)).toBe('cold');
    expect(stressCategory(9)).toBe('none');
    expect(stressCategory(26)).toBe('none');
    expect(stressCategory(26.1)).toBe('moderate');
    expect(stressCategory(32.1)).toBe('strong');
    expect(stressCategory(38.1)).toBe('very_strong');
    expect(stressCategory(46.1)).toBe('extreme');
    expect(thermalInfo(weather({ temperatureC: 2, apparentTemperatureC: -2 }), 15 * RAD, 0).stress).toBe('cold');
    expect(thermalInfo(weather(), 55 * RAD, 1).stress).toBe('strong');
    expect(thermalInfo(weather(), 55 * RAD, 0).stress).toBe('moderate');
  });
});
