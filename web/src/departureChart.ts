// Wykres „Kiedy wyjść?” — przeliczenie odpowiedzi serwera na słupki (czysta logika, bez DOM).

import type { DepartureOption, DepartureResponse } from '../../shared/types.ts';
import { formatDuration, formatPercent, formatTemperature } from './format.ts';
import { comfortShare, comfortTexts, type AppliedComfort } from './labels.ts';
import { formatKrakowClock, krakowMinutesOf } from './time.ts';

/** Najniższy słupek (wynik bliski 0) zostaje widoczny i klikalny. */
export const MIN_BAR_PCT = 6;
/** Powyżej tylu podpisanych godzin opisujemy tylko co drugą. */
const MAX_HOUR_TICKS = 7;

/** Jednobarwna rampa udziału cienia: jasne indygo = mało cienia, ciemne = dużo. */
const SHADE_RAMP_LIGHT: readonly [number, number, number] = [0xc9, 0xc7, 0xee];
const SHADE_RAMP_DARK: readonly [number, number, number] = [0x27, 0x24, 0x62];

export interface ChartBar {
  index: number;
  /** ISO momentu wyjścia. */
  time: string;
  /** „18:30” */
  clock: string;
  /** Wysokość słupka w % wysokości wykresu (skala od zera). */
  heightPct: number;
  color: string;
  isBest: boolean;
  /** Podpis osi pod słupkiem (pełne godziny) albo null. */
  tick: string | null;
  /** Pełny opis słupka: odczyt pod wykresem i etykieta dla czytnika ekranu. */
  readout: string;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Wynik 0..100 → wysokość słupka w %; oś zaczyna się w zerze, żeby proporcje były uczciwe. */
export function barHeightPct(score: number): number {
  const pct = clamp01(score / 100) * 100;
  return Math.max(MIN_BAR_PCT, Math.round(pct * 10) / 10);
}

/** Kolor słupka dla udziału cienia 0..1 (interpolacja liniowa w RGB między końcami rampy). */
export function shadeColor(shadeFraction: number): string {
  const t = clamp01(shadeFraction);
  const channel = (i: 0 | 1 | 2): string =>
    Math.round(SHADE_RAMP_LIGHT[i] + (SHADE_RAMP_DARK[i] - SHADE_RAMP_LIGHT[i]) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** Indeks najlepszej opcji: wskazany przez serwer, a gdy jest nieprawidłowy — opcja z najwyższym wynikiem. */
export function bestOptionIndex(response: Pick<DepartureResponse, 'options' | 'bestIndex'>): number {
  const { options, bestIndex } = response;
  if (options.length === 0) return -1;
  if (Number.isInteger(bestIndex) && bestIndex >= 0 && bestIndex < options.length) return bestIndex;
  let best = 0;
  for (let i = 1; i < options.length; i++) if (options[i].score > options[best].score) best = i;
  return best;
}

/** „18:30 · 82% w cieniu · odczuwalna 26°C · 14 min · ocena 78/100”. */
export function departureReadout(option: DepartureOption, comfort: AppliedComfort): string {
  const parts = [
    formatKrakowClock(option.time) ?? '—',
    `${formatPercent(comfortShare(option.shadeFraction, comfort))} ${comfortTexts(comfort).shareSuffix}`,
  ];
  if (typeof option.feltMeanC === 'number') parts.push(`odczuwalna ${formatTemperature(option.feltMeanC)}`);
  parts.push(formatDuration(option.durationS), `ocena ${Math.round(clamp01(option.score / 100) * 100)}/100`);
  return parts.join(' · ');
}

export function buildChart(response: Pick<DepartureResponse, 'options' | 'bestIndex'>, comfort: AppliedComfort): ChartBar[] {
  const best = bestOptionIndex(response);
  const minutes = response.options.map((option) => krakowMinutesOf(option.time));
  const fullHours = minutes.filter((value) => value !== null && value % 60 === 0).length;
  const everyOtherHour = fullHours > MAX_HOUR_TICKS;
  return response.options.map((option, index) => {
    const minute = minutes[index];
    const onHour = minute !== null && minute % 60 === 0;
    const showTick = onHour && (!everyOtherHour || (minute / 60) % 2 === 0);
    return {
      index,
      time: option.time,
      clock: formatKrakowClock(option.time) ?? '—',
      heightPct: barHeightPct(option.score),
      color: shadeColor(option.shadeFraction),
      isBest: index === best,
      tick: showTick ? String(minute / 60) : null,
      readout: departureReadout(option, comfort),
    };
  });
}

/** Indeks opcji odpowiadającej wybranemu momentowi wyjścia (z dokładnością do minuty) albo -1. */
export function optionIndexAt(options: readonly DepartureOption[], iso: string): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return -1;
  return options.findIndex((option) => Math.abs(new Date(option.time).getTime() - target) < 60_000);
}
