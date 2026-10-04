// Teksty interfejsu zależne od danych (profil, tryb komfortu, obciążenie cieplne, światła, schody).
// Same czyste funkcje — bez DOM — żeby dało się je testować.

import type { MobilityProfile, RouteResult, ThermalInfo, WeatherInfo } from '../../shared/types.ts';
import { formatDistance, formatDuration, formatPercent, formatTemperature } from './format.ts';

export type AppliedComfort = 'shade' | 'sun';

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Dłuższy opis (podpowiedź / czytnik ekranu). */
  hint: string;
}

export const MOBILITY_CHOICES: ReadonlyArray<Choice<MobilityProfile>> = [
  { value: 'default', label: 'Pieszo', hint: 'Zwykły marsz, schody dozwolone' },
  { value: 'accessible', label: 'Bez schodów', hint: 'Bez schodów, z dala od złej nawierzchni i wysokich krawężników' },
  { value: 'senior', label: 'Senior', hint: 'Wolniejszy marsz, unikanie schodów, trasy przy ławkach' },
];

/** Polska odmiana rzeczownika przy liczebniku: plural(3, 'światło', 'światła', 'świateł') → 'światła'. */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.round(count));
  if (n === 1) return one;
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

// ───────────── tryb komfortu ─────────────

export interface ComfortTexts {
  /** Podpis prawego końca suwaka preferencji. */
  sliderMax: string;
  /** Dopisek przy udziale procentowym na karcie trasy. */
  shareSuffix: string;
  idleSummary: string;
}

const COMFORT_TEXTS: Record<AppliedComfort, ComfortTexts> = {
  shade: { sliderMax: 'Najwięcej cienia', shareSuffix: 'w cieniu', idleSummary: 'Zaplanuj trasę w cieniu' },
  sun: { sliderMax: 'Najwięcej słońca', shareSuffix: 'w słońcu', idleSummary: 'Zaplanuj trasę w słońcu' },
};

export function comfortTexts(comfort: AppliedComfort): ComfortTexts {
  return COMFORT_TEXTS[comfort];
}

export function preferenceLabel(preference: number, comfort: AppliedComfort = 'shade'): string {
  const what = comfort === 'sun' ? 'słońca' : 'cienia';
  if (preference <= 0.02) return 'liczy się tylko dystans';
  if (preference < 0.35) return `trochę ${what}`;
  if (preference <= 0.65) return 'równowaga';
  if (preference < 0.98) return `dużo ${what}`;
  return `maksimum ${what}`;
}

/** Udział trasy „po dobrej stronie”: w cieniu latem, w słońcu w trybie zimowym. */
export function comfortShare(shadeFraction: number, comfort: AppliedComfort): number {
  const shade = Math.max(0, Math.min(1, shadeFraction));
  return comfort === 'sun' ? 1 - shade : shade;
}

/** Jedna krótka linia pogody, np. „22°C · odczuwalna 24°C”; null, gdy brak danych. */
export function weatherLine(
  weather: Pick<WeatherInfo, 'source' | 'temperatureC' | 'apparentTemperatureC'> | null | undefined,
): string | null {
  if (!weather || weather.source === 'unavailable') return null;
  const parts: string[] = [];
  if (weather.temperatureC !== null) parts.push(formatTemperature(weather.temperatureC));
  if (weather.apparentTemperatureC !== null) parts.push(`odczuwalna ${formatTemperature(weather.apparentTemperatureC)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ───────────── komfort cieplny ─────────────

export type StressLevel = NonNullable<ThermalInfo['stress']>;

const STRESS_LABELS: Record<StressLevel, string> = {
  cold: 'Chłodno',
  none: 'Komfort cieplny',
  moderate: 'Umiarkowany stres cieplny',
  strong: 'Silny stres cieplny',
  very_strong: 'Bardzo silny stres cieplny',
  extreme: 'Skrajny stres cieplny',
};

export function stressLabel(stress: ThermalInfo['stress'] | undefined): string | null {
  return stress ? (STRESS_LABELS[stress] ?? null) : null;
}

/** „Odczuwalna 34°C w słońcu · 28°C w cieniu”; null, gdy serwer nie ma pogody. */
export function thermalText(thermal: ThermalInfo | null | undefined): string | null {
  if (!thermal) return null;
  const { feltSunC, feltShadeC, feltMeanC } = thermal;
  const parts: string[] = [];
  if (typeof feltSunC === 'number') parts.push(`${formatTemperature(feltSunC)} w słońcu`);
  if (typeof feltShadeC === 'number') parts.push(`${formatTemperature(feltShadeC)} w cieniu`);
  if (parts.length > 0) return `Odczuwalna ${parts.join(' · ')}`;
  return typeof feltMeanC === 'number' ? `Odczuwalna średnio ${formatTemperature(feltMeanC)}` : null;
}

// ───────────── światła i schody ─────────────

/** „3 światła”; null, gdy na trasie nie ma przejść z sygnalizacją. */
export function signalsText(signalCrossings: number | undefined): string | null {
  const count = Math.round(signalCrossings ?? 0);
  if (!(count > 0)) return null;
  return `${count} ${plural(count, 'światło', 'światła', 'świateł')}`;
}

/** „bez schodów” / „2 odcinki schodów”. */
export function stairsText(stairsCount: number | undefined): string | null {
  if (stairsCount === undefined || !Number.isFinite(stairsCount)) return null;
  const count = Math.round(stairsCount);
  if (count <= 0) return 'bez schodów';
  return `${count} ${plural(count, 'odcinek', 'odcinki', 'odcinków')} schodów`;
}

/** Krótka druga linia karty wybranej trasy, np. „2 światła · bez schodów”. */
export function routeFactsLine(route: Pick<RouteResult, 'signalCrossings' | 'stairsCount'>): string {
  return [signalsText(route.signalCrossings), stairsText(route.stairsCount)].filter(Boolean).join(' · ');
}

// ───────────── podsumowania ─────────────

/** Jednowierszowe podsumowanie wybranej trasy (uchwyt arkusza na telefonie). */
export function routeSummary(
  route: Pick<RouteResult, 'label' | 'distanceM' | 'durationS' | 'shadeFraction'>,
  comfort: AppliedComfort,
): string {
  return [
    route.label,
    formatDistance(route.distanceM),
    formatDuration(route.durationS),
    `${formatPercent(comfortShare(route.shadeFraction, comfort))} ${comfortTexts(comfort).shareSuffix}`,
  ].join(' · ');
}

// ───────────── upał ─────────────

const HEAT_STRESS: ReadonlySet<StressLevel> = new Set(['strong', 'very_strong', 'extreme']);

/** „Upał — weź wodę, 34°C odczuwalna w słońcu” przy silnym (lub większym) obciążeniu cieplnym; inaczej null. */
export function heatAdvice(thermal: ThermalInfo | null | undefined): string | null {
  if (!thermal?.stress || !HEAT_STRESS.has(thermal.stress)) return null;
  if (typeof thermal.feltSunC === 'number') return `Upał — weź wodę, ${formatTemperature(thermal.feltSunC)} odczuwalna w słońcu`;
  if (typeof thermal.feltMeanC === 'number') return `Upał — weź wodę, ${formatTemperature(thermal.feltMeanC)} odczuwalna`;
  return 'Upał — weź wodę';
}
