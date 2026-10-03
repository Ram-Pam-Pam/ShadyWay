// Komfort cieplny: szacunkowa temperatura odczuwalna w słońcu i w cieniu.
//
// UWAGA — to PRZYBLIŻENIE, nie pełny model UTCI. Pełne UTCI wymaga temperatury powietrza, wilgotności,
// wiatru na 10 m i średniej temperatury promieniowania (Tmrt), a WeatherInfo niesie tylko temperaturę,
// temperaturę odczuwalną, zachmurzenie i bezpośrednie promieniowanie (DNI). Dlatego:
//
//   1. Cień:  odczuwalna ≈ `apparentTemperatureC` z Open-Meteo (uwzględnia już wilgotność i wiatr);
//      gdy jej brak — temperatura powietrza.
//   2. Słońce: do wartości w cieniu dodajemy przyrost wynikający ze wzrostu Tmrt pod bezpośrednim słońcem.
//      Strumień pochłaniany przez stojącego człowieka (VDI 3787 / Jendritzky):
//          S = a_k · f_p(γ) · DNI · K_otoczenia
//      a_k = 0,7 (pochłanianie krótkofalowe ciała i ubrania), f_p = 0,308·cos(γ·(1 − γ²/48402)) — rzut sylwetki
//      na kierunek słońca (γ = wysokość słońca w stopniach), K_otoczenia = 1,3 — narzut na promieniowanie odbite
//      od nasłonecznionej nawierzchni i jej wyższą temperaturę (w cieniu obu składników praktycznie nie ma).
//          Tmrt_słońce = (Tmrt_cień⁴ + S / (ε·σ))^¼,  Tmrt_cień ≈ temperatura powietrza,  ε = 0,97.
//      UTCI rośnie o ok. 0,3 °C na każdy 1 °C Tmrt (Bröde i in. 2012, przy słabym wietrze), stąd
//          Δodczuwalna = 0,3 · (Tmrt_słońce − Tmrt_cień),  ograniczona do 12 °C.
//      W bezchmurne letnie popołudnie daje to ok. +5…+8 °C, co zgadza się z pomiarami UTCI słońce/cień w miastach.
//   3. Kategorie obciążenia wg progów UTCI: > 46 skrajne, > 38 bardzo silne, > 32 silne, > 26 umiarkowane,
//      < 9 chłód (stres zimna), pomiędzy — brak obciążenia.

import type { ThermalInfo, WeatherInfo } from '../../shared/types.ts';

const STEFAN_BOLTZMANN = 5.670374e-8;
const BODY_SHORTWAVE_ABSORPTION = 0.7;
const BODY_EMISSIVITY = 0.97;
const SURROUNDINGS_GAIN = 1.3;
const UTCI_PER_TMRT = 0.3;
const MAX_SUN_DELTA_C = 12;
/** DNI przyjmowane przy bezchmurnym niebie, gdy pogoda nie podaje promieniowania (W/m²). */
const CLEAR_SKY_DNI = 750;
const RAD_TO_DEG = 180 / Math.PI;

export const NO_THERMAL: ThermalInfo = { feltSunC: null, feltShadeC: null, feltMeanC: null, stress: null };

/** DNI z pogody; gdy brak — oszacowanie z zachmurzenia (albo niebo bezchmurne, gdy i tego nie znamy). */
function directIrradiance(weather: WeatherInfo): number {
  if (weather.directRadiationWm2 !== null) return Math.max(0, weather.directRadiationWm2);
  if (weather.cloudCoverPct !== null) {
    const cloud = Math.min(100, Math.max(0, weather.cloudCoverPct)) / 100;
    return CLEAR_SKY_DNI * (1 - 0.9 * cloud * cloud);
  }
  return CLEAR_SKY_DNI;
}

/** O ile °C cieplej odczuwa się w pełnym słońcu niż w cieniu (0 w nocy i przy braku bezpośredniego słońca). */
export function sunDeltaC(weather: WeatherInfo, sunAltitudeRad: number): number {
  if (!(sunAltitudeRad > 0)) return 0;
  const airC = weather.temperatureC ?? weather.apparentTemperatureC;
  if (airC === null) return 0;
  const gamma = Math.min(90, sunAltitudeRad * RAD_TO_DEG);
  const projection = 0.308 * Math.cos((gamma * (1 - (gamma * gamma) / 48402)) / RAD_TO_DEG);
  const absorbed = BODY_SHORTWAVE_ABSORPTION * projection * directIrradiance(weather) * SURROUNDINGS_GAIN;
  const shadeK = airC + 273.15;
  const sunK = (shadeK ** 4 + absorbed / (BODY_EMISSIVITY * STEFAN_BOLTZMANN)) ** 0.25;
  return Math.min(MAX_SUN_DELTA_C, Math.max(0, UTCI_PER_TMRT * (sunK - shadeK)));
}

export function stressCategory(feltC: number | null): ThermalInfo['stress'] {
  if (feltC === null) return null;
  if (feltC > 46) return 'extreme';
  if (feltC > 38) return 'very_strong';
  if (feltC > 32) return 'strong';
  if (feltC > 26) return 'moderate';
  if (feltC < 9) return 'cold';
  return 'none';
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Komfort cieplny trasy.
 * @param weather pogoda dla chwili wyjścia (null / 'unavailable' → same null)
 * @param sunAltitudeRad wysokość słońca w czasie marszu (radiany)
 * @param meanExposure średnia ekspozycja trasy 0..1 (udział drogi w słońcu)
 */
export function thermalInfo(weather: WeatherInfo | null | undefined, sunAltitudeRad: number, meanExposure: number): ThermalInfo {
  if (!weather || weather.source === 'unavailable') return { ...NO_THERMAL };
  const shade = weather.apparentTemperatureC ?? weather.temperatureC;
  if (shade === null) return { ...NO_THERMAL };
  const delta = sunDeltaC(weather, sunAltitudeRad);
  const exposure = Math.min(1, Math.max(0, Number.isFinite(meanExposure) ? meanExposure : 0));
  const mean = shade + delta * exposure;
  return {
    feltSunC: round1(shade + delta),
    feltShadeC: round1(shade),
    feltMeanC: round1(mean),
    stress: stressCategory(mean),
  };
}
