// Najlepsza godzina wyjścia: próbkowanie okna czasu, ocena trasy „zbalansowanej” dla każdej próbki
// i wybór pory o najwyższym komforcie (cień albo — w trybie zimowym — słońce, temperatura odczuwalna, długość).

import { TIMEZONE } from '../../shared/types.ts';
import type { DepartureOption, DepartureResponse, WeatherInfo } from '../../shared/types.ts';
import type { RouteOptions, RoutingContext } from '../contracts.ts';
import { DEFAULT_STEP_MINUTES, DEFAULT_WINDOW_HOURS } from '../validate.ts';
import { computeBalancedSummary } from './route.ts';

/** Najwięcej tyle godzin wyjścia oceniamy w jednym zapytaniu. */
export const MAX_DEPARTURE_SAMPLES = 33;

const MINUTE_MS = 60_000;

/** Wagi składników wyniku komfortu (sumują się do 1). */
const WEIGHT_SUN = 0.5;
const WEIGHT_THERMAL = 0.35;
const WEIGHT_DISTANCE = 0.15;

/** Zakres temperatury odczuwalnej uznawany za w pełni komfortowy oraz punkty, w których komfort spada do zera. */
const COMFORT_LOW_C = 15;
const COMFORT_HIGH_C = 24;
const ZERO_COMFORT_HOT_C = 40;
const ZERO_COMFORT_COLD_C = -10;

/**
 * Chwile wyjścia: od `start` co `stepMinutes` przez `windowHours`. Gdy próbek byłoby więcej niż
 * MAX_DEPARTURE_SAMPLES, krok jest wydłużany (do wielokrotności 15 min).
 */
export function departureTimes(start: Date, windowHours = DEFAULT_WINDOW_HOURS, stepMinutes = DEFAULT_STEP_MINUTES): Date[] {
  const windowMin = Math.max(0, windowHours) * 60;
  let step = Math.max(1, stepMinutes);
  if (Math.floor(windowMin / step) + 1 > MAX_DEPARTURE_SAMPLES) {
    step = Math.ceil(windowMin / (MAX_DEPARTURE_SAMPLES - 1) / 15) * 15;
  }
  const times: Date[] = [];
  for (let offset = 0; offset <= windowMin + 1e-9 && times.length < MAX_DEPARTURE_SAMPLES; offset += step) {
    times.push(new Date(start.getTime() + offset * MINUTE_MS));
  }
  return times;
}

/** Komfort cieplny 0..1 dla temperatury odczuwalnej. */
export function thermalComfort(feltC: number): number {
  if (feltC > COMFORT_HIGH_C) return Math.max(0, 1 - (feltC - COMFORT_HIGH_C) / (ZERO_COMFORT_HOT_C - COMFORT_HIGH_C));
  if (feltC < COMFORT_LOW_C) return Math.max(0, 1 - (COMFORT_LOW_C - feltC) / (COMFORT_LOW_C - ZERO_COMFORT_COLD_C));
  return 1;
}

type Unscored = Omit<DepartureOption, 'score'>;

/**
 * Wynik 0..100 dla każdej opcji:
 *   50% — słońce: w trybie 'shade' 1 − (udział trasy w słońcu × sunFactor), w trybie 'sun' sam ten iloczyn,
 *   35% — komfort cieplny średniej temperatury odczuwalnej (pomijany, gdy choć jedna opcja nie ma pogody),
 *   15% — długość trasy względem najkrótszej z opcji.
 */
export function scoreDepartures(options: Unscored[], comfort: 'shade' | 'sun'): number[] {
  if (options.length === 0) return [];
  const withThermal = options.every((option) => option.feltMeanC !== null);
  const minDistance = Math.min(...options.map((option) => option.distanceM));
  const totalWeight = WEIGHT_SUN + WEIGHT_DISTANCE + (withThermal ? WEIGHT_THERMAL : 0);
  return options.map((option) => {
    const sunBurden = Math.min(1, Math.max(0, (1 - option.shadeFraction) * option.sunFactor));
    const sunPart = comfort === 'sun' ? sunBurden : 1 - sunBurden;
    const distancePart = option.distanceM > 0 ? minDistance / option.distanceM : 1;
    let sum = WEIGHT_SUN * sunPart + WEIGHT_DISTANCE * distancePart;
    if (withThermal) sum += WEIGHT_THERMAL * thermalComfort(option.feltMeanC as number);
    return Math.round((100 * sum) / totalWeight);
  });
}

const clockFormat = new Intl.DateTimeFormat('pl-PL', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function clock(iso: string): string {
  return clockFormat.format(new Date(iso));
}

function percent(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** Jedno zdanie po polsku porównujące najlepszą porę z pierwszą opcją okna. */
export function departureSummary(options: DepartureOption[], bestIndex: number, comfort: 'shade' | 'sun'): string {
  const first = options[0];
  const best = options[bestIndex];
  if (!first || !best) return 'Brak danych do porównania godzin wyjścia.';
  if (options.every((option) => option.sunFactor <= 0)) {
    return 'W tym czasie słońce jest pod horyzontem albo za chmurami — pora wyjścia nie wpływa na cień na trasie.';
  }

  const share = (option: DepartureOption): number => percent(comfort === 'sun' ? 1 - option.shadeFraction : option.shadeFraction);
  const what = comfort === 'sun' ? 'w słońcu' : 'w cieniu';
  const shareText = `${share(best)}% trasy ${what}`;
  // W trybie cienia lepsza pora nie musi oznaczać większego udziału cienia — bywa, że słońce jest po prostu słabsze
  // (chmury, niska pozycja); wtedy to ono jest powodem, a nie procent cienia.
  let describe = shareText;
  if (comfort === 'shade') {
    if (best.sunFactor <= 0) describe = 'słońce nie będzie już grzało';
    else if (share(best) < share(first) && best.sunFactor < first.sunFactor - 0.15) describe = 'słońce będzie wyraźnie słabsze';
  }

  if (bestIndex === 0) {
    return `Najlepiej wyjść od razu (o ${clock(best.time)}) — ${describe}, później nie będzie lepiej.`;
  }
  const nextDay = dayFormat.format(new Date(best.time)) !== dayFormat.format(new Date(first.time));
  const when = `${nextDay ? 'następnego dnia ' : ''}o ${clock(best.time)}`;
  const firstClock = clock(first.time);
  if (best.feltMeanC !== null && first.feltMeanC !== null) {
    const delta = Math.round(comfort === 'sun' ? best.feltMeanC - first.feltMeanC : first.feltMeanC - best.feltMeanC);
    if (delta >= 1) {
      return `Najlepiej wyjść ${when} — ${describe} i o ${delta}°C ${comfort === 'sun' ? 'cieplej' : 'chłodniej'} niż o ${firstClock}.`;
    }
  }
  // Porównanie procentów ma sens tylko wtedy, gdy przemawia na korzyść wybranej pory.
  if (describe === shareText && share(best) > share(first)) {
    return `Najlepiej wyjść ${when} — ${describe} (o ${firstClock}: ${share(first)}%).`;
  }
  return `Najlepiej wyjść ${when} — ${describe}.`;
}

/** Składa odpowiedź z ocenionych próbek: wynik, najlepsza pora (przy remisie wcześniejsza) i podsumowanie. */
export function buildDepartureResponse(unscored: Unscored[], comfort: 'shade' | 'sun'): DepartureResponse {
  const scores = scoreDepartures(unscored, comfort);
  const options: DepartureOption[] = unscored.map((option, i) => ({ ...option, score: scores[i] }));
  let bestIndex = 0;
  for (let i = 1; i < options.length; i++) if (options[i].score > options[bestIndex].score) bestIndex = i;
  return { options, bestIndex, summary: departureSummary(options, bestIndex, comfort) };
}

export interface DepartureConditions {
  weather: WeatherInfo | null;
  sunFactor: number;
}

/**
 * Ocenia trasę zbalansowaną dla każdej chwili wyjścia. Kontekst routingu i cache ekspozycji są wspólne dla
 * wszystkich próbek. `pause` (np. oddanie sterowania pętli zdarzeń) jest wołane między próbkami.
 */
export async function evaluateDepartures(
  ctx: RoutingContext,
  base: Omit<RouteOptions, 'departure' | 'sunFactor' | 'weather' | 'viaCoolSpot'>,
  times: Date[],
  conditions: (time: Date, index: number) => DepartureConditions,
  pause?: () => Promise<void>,
): Promise<DepartureResponse> {
  const unscored: Unscored[] = [];
  for (let i = 0; i < times.length; i++) {
    const { weather, sunFactor } = conditions(times[i], i);
    const summary = computeBalancedSummary(ctx, { ...base, departure: times[i], sunFactor, weather, viaCoolSpot: false });
    unscored.push({
      time: times[i].toISOString(),
      distanceM: summary.distanceM,
      durationS: summary.durationS,
      shadeFraction: summary.shadeFraction,
      sunDistanceM: summary.sunDistanceM,
      sunFactor,
      feltMeanC: summary.thermal.feltMeanC,
    });
    if (pause && i + 1 < times.length) await pause();
  }
  return buildDepartureResponse(unscored, base.comfort ?? 'shade');
}
