// Cicha podpowiedź pory wyjścia: jedna linia pod kartami tras, tylko gdy późniejsze wyjście jest wyraźnie lepsze.
// Czysta logika — pobieranie i rysowanie żyją w features/departureHint.ts.

import type { DepartureOption, DepartureResponse } from '../../shared/types.ts';
import { bestOptionIndex } from './departureChart.ts';
import { formatDuration, formatPercent } from './format.ts';
import { comfortShare, type AppliedComfort } from './labels.ts';
import { instantToWallTime, wallTimeToInstant, type WallTime } from './time.ts';

export const HINT_WINDOW_HOURS = 3;
export const HINT_STEP_MINUTES = 30;
/** O tyle punktów procentowych cienia (zimą: słońca) musi być więcej, żeby podpowiedź w ogóle się pojawiła. */
export const HINT_MIN_GAIN = 0.15;
/** Albo: najlepsza pora według serwera ma ocenę wyższą o tyle punktów (i choć trochę więcej cienia). */
export const HINT_MIN_SCORE_GAIN = 15;
const HINT_MIN_GAIN_WITH_SCORE = 0.05;

export interface DepartureHint {
  /** Moment wyjścia do ustawienia (ISO). */
  time: string;
  /** „Za 40 min będzie 82% cienia — przestaw godzinę”. */
  text: string;
}

/**
 * Podpowiedź ma sens tylko dla wyjścia „teraz”: wybrany moment jest dzisiaj i nie leży w przeszłości
 * (z zapasem jednego kroku suwaka) ani dalej niż godzinę w przód.
 */
export function hintApplies(selected: WallTime, now: Date): boolean {
  if (selected.date !== instantToWallTime(now).date) return false;
  const aheadMin = (wallTimeToInstant(selected.date, selected.minutes).getTime() - now.getTime()) / 60_000;
  return aheadMin >= -20 && aheadMin <= 60;
}

function qualifies(option: DepartureOption, first: DepartureOption, comfort: AppliedComfort): boolean {
  const gain = comfortShare(option.shadeFraction, comfort) - comfortShare(first.shadeFraction, comfort);
  if (option.score < first.score) return false;
  return gain >= HINT_MIN_GAIN || (gain >= HINT_MIN_GAIN_WITH_SCORE && option.score - first.score >= HINT_MIN_SCORE_GAIN);
}

/** Wybiera późniejszą, wyraźnie lepszą porę wyjścia albo null (wtedy interfejs nie pokazuje nic). */
export function pickDepartureHint(
  response: Pick<DepartureResponse, 'options' | 'bestIndex'> | null | undefined,
  comfort: AppliedComfort,
): DepartureHint | null {
  const options = response?.options;
  if (!Array.isArray(options) || options.length < 2) return null;
  const first = options[0];
  const start = new Date(first.time).getTime();
  if (Number.isNaN(start)) return null;

  const best = bestOptionIndex({ options, bestIndex: response?.bestIndex ?? -1 });
  let pick: DepartureOption | null = best > 0 && qualifies(options[best], first, comfort) ? options[best] : null;
  if (!pick) {
    for (const option of options.slice(1)) {
      if (qualifies(option, first, comfort) && (!pick || option.score > pick.score)) pick = option;
    }
  }
  if (!pick) return null;
  const delayS = (new Date(pick.time).getTime() - start) / 1000;
  if (!Number.isFinite(delayS) || delayS < 60) return null;

  const share = formatPercent(comfortShare(pick.shadeFraction, comfort));
  const what = comfort === 'sun' ? 'słońca' : 'cienia';
  return { time: pick.time, text: `Za ${formatDuration(delayS)} będzie ${share} ${what} — przestaw godzinę` };
}
