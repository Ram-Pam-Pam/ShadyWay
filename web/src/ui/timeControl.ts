// Wybór daty i godziny (czas Krakowa) z paskiem dnia (noc/dzień, łuk słońca) i jedną linią pogody.

import type { SunInfo } from '../../../shared/types.ts';
import { weatherLine } from '../labels.ts';
import type { AppState } from '../store.ts';
import {
  SLIDER_MAX_MIN,
  formatClock,
  formatLongDate,
  isValidDateString,
  krakowMinutesOf,
} from '../time.ts';
import { byId } from '../util.ts';

const ARC_WIDTH = 100;
const ARC_HEIGHT = 40;
const ARC_TOP_MARGIN = 6;
const ARC_SAMPLES = 24;

export interface TimeControlOptions {
  onChange(time: { date: string; minutes: number }): void;
  onNow(): void;
}

type TimeViewState = Pick<AppState, 'date' | 'minutes' | 'followNow' | 'sun' | 'weather'>;

/** Wysokość słońca na łuku (0..1) w danej minucie; przybliżenie półsinusoidą między wschodem a zachodem. */
function arcHeight(minutes: number, sunrise: number, sunset: number): number {
  if (minutes <= sunrise || minutes >= sunset) return 0;
  return Math.sin((Math.PI * (minutes - sunrise)) / (sunset - sunrise));
}

export class TimeControl {
  private readonly dateInput = byId<HTMLInputElement>('date-input');
  private readonly slider = byId<HTMLInputElement>('time-slider');
  private readonly readout = byId<HTMLOutputElement>('time-readout');
  private readonly nowButton = byId<HTMLButtonElement>('now-button');
  private readonly band = byId<HTMLElement>('day-band');
  private readonly arc = byId<HTMLElement>('sun-arc');
  private readonly sunDot = byId<HTMLElement>('sun-dot');
  private readonly weather = byId<HTMLElement>('weather');

  constructor(options: TimeControlOptions) {
    this.slider.max = String(SLIDER_MAX_MIN);
    this.slider.addEventListener('input', () => {
      options.onChange({ date: this.dateInput.value, minutes: Number(this.slider.value) });
    });
    this.dateInput.addEventListener('change', () => {
      // Puste lub niepełne pole daty ignorujemy — zostaje poprzednia poprawna data.
      if (!isValidDateString(this.dateInput.value)) return;
      options.onChange({ date: this.dateInput.value, minutes: Number(this.slider.value) });
    });
    this.nowButton.addEventListener('click', () => options.onNow());
  }

  render(state: TimeViewState): void {
    if (document.activeElement !== this.dateInput) this.dateInput.value = state.date;
    this.slider.value = String(state.minutes);
    const clock = formatClock(state.minutes);
    this.readout.textContent = clock;
    this.slider.setAttribute('aria-valuetext', `${clock}, ${formatLongDate(state.date)}`);
    this.nowButton.setAttribute('aria-pressed', String(state.followNow));

    this.renderDay(state.minutes, state.sun);
    const weather = weatherLine(state.weather);
    this.weather.hidden = weather === null;
    this.weather.textContent = weather ?? '';
  }

  private renderDay(minutes: number, sun: SunInfo | null): void {
    const sunrise = krakowMinutesOf(sun?.sunrise ?? null);
    const sunset = krakowMinutesOf(sun?.sunset ?? null);
    const hasDay = sunrise !== null && sunset !== null && sunset > sunrise;
    const percent = (value: number): number => (Math.min(value, SLIDER_MAX_MIN) / SLIDER_MAX_MIN) * 100;

    this.band.classList.toggle('day__band--known', hasDay);
    this.sunDot.hidden = !hasDay;
    if (!hasDay) {
      this.arc.setAttribute('d', '');
      return;
    }
    this.band.style.setProperty('--sunrise', `${percent(sunrise)}%`);
    this.band.style.setProperty('--sunset', `${percent(sunset)}%`);

    const usable = ARC_HEIGHT - ARC_TOP_MARGIN;
    const points: string[] = [];
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      const t = sunrise + ((sunset - sunrise) * i) / ARC_SAMPLES;
      const x = (percent(t) / 100) * ARC_WIDTH;
      const y = ARC_HEIGHT - arcHeight(t, sunrise, sunset) * usable;
      points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    this.arc.setAttribute('d', points.join(' '));

    const height = arcHeight(minutes, sunrise, sunset);
    this.sunDot.style.left = `${percent(minutes)}%`;
    this.sunDot.style.bottom = `${((height * usable) / ARC_HEIGHT) * 100}%`;
    this.sunDot.classList.toggle('day__sun--night', height === 0);
  }
}
