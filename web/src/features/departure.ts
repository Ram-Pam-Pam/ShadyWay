// „Kiedy wyjść?” — pyta serwer o ocenę trasy dla kolejnych godzin i rysuje słupkowy wykres komfortu.
// Kliknięcie słupka ustawia godzinę wyjścia (trasę przelicza zwykły obieg stanu aplikacji).

import type { DepartureRequest, DepartureResponse } from '../../../shared/types.ts';
import { errorMessage, fetchDeparture, isAbortError } from '../api.ts';
import { bestOptionIndex, buildChart, optionIndexAt, type ChartBar } from '../departureChart.ts';
import type { AppliedComfort } from '../labels.ts';
import { byId, debounce, el } from '../util.ts';
import { icon } from '../ui/icons.ts';

const WINDOW_CHOICES = [6, 12] as const;
const STEP_MINUTES = 30;
const RELOAD_DEBOUNCE_MS = 600;

export interface DepartureFeatureOptions {
  /** Zapytanie dla bieżących ustawień (bez okna i kroku) albo null, gdy brakuje startu lub celu. */
  getRequest(): Omit<DepartureRequest, 'windowHours' | 'stepMinutes'> | null;
  getComfort(): AppliedComfort;
  /** Aktualnie wybrany moment wyjścia (ISO) — do zaznaczenia słupka. */
  getSelectedTime(): string;
  onPickTime(iso: string): void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; response: DepartureResponse };

export class DepartureFeature {
  private readonly button = byId<HTMLButtonElement>('departure-button');
  private readonly body = byId<HTMLElement>('departure-body');
  private readonly options: DepartureFeatureOptions;
  private open = false;
  private status: Status = { kind: 'idle' };
  private windowHours: number = WINDOW_CHOICES[0];
  private request: AbortController | null = null;
  private readonly reloadSoon = debounce(() => void this.load(), RELOAD_DEBOUNCE_MS);

  constructor(options: DepartureFeatureOptions) {
    this.options = options;
    this.button.addEventListener('click', () => this.setOpen(!this.open));
    this.render();
  }

  /** Zmieniły się punkty lub preferencje trasy: wynik jest nieaktualny (otwarty panel przelicza się sam). */
  invalidate(): void {
    this.request?.abort();
    this.request = null;
    this.reloadSoon.cancel();
    if (this.open && this.options.getRequest()) {
      this.status = { kind: 'loading' };
      this.reloadSoon();
    } else {
      this.status = { kind: 'idle' };
    }
    this.render();
  }

  /** Zmieniła się wybrana godzina albo tryb komfortu — odświeża zaznaczenie i opisy bez pytania serwera. */
  refresh(): void {
    if (this.open) this.render();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open && this.status.kind === 'idle') void this.load();
    else this.render();
    if (!open) {
      this.request?.abort();
      this.request = null;
      this.reloadSoon.cancel();
      if (this.status.kind === 'loading') this.status = { kind: 'idle' };
    }
  }

  private async load(): Promise<void> {
    this.request?.abort();
    const base = this.options.getRequest();
    if (!base) {
      this.status = { kind: 'idle' };
      this.render();
      return;
    }
    const controller = new AbortController();
    this.request = controller;
    this.status = { kind: 'loading' };
    this.render();
    try {
      const response = await fetchDeparture(
        { ...base, windowHours: this.windowHours, stepMinutes: STEP_MINUTES },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      this.status =
        Array.isArray(response?.options) && response.options.length > 0
          ? { kind: 'ready', response }
          : { kind: 'error', message: 'Serwer nie zwrócił żadnej godziny wyjścia dla tego okna.' };
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      this.status = { kind: 'error', message: errorMessage(error) };
    }
    this.render();
  }

  private render(): void {
    this.body.hidden = !this.open;
    if (!this.open) return;
    const status = this.status;
    const children: (HTMLElement | null)[] = [this.windowControl()];

    if (!this.options.getRequest()) {
      // Bez startu i celu przycisk „Kiedy wyjść?” jest ukryty — nie ma czego pokazać.
    } else if (status.kind === 'loading' || status.kind === 'idle') {
      children.push(
        el(
          'div',
          'status status--loading',
          el('span', 'spinner'),
          el('p', '', 'Sprawdzam kolejne godziny…'),
        ),
      );
    } else if (status.kind === 'error') {
      const retry = el('button', 'chip-button', 'Spróbuj ponownie');
      retry.type = 'button';
      retry.addEventListener('click', () => void this.load());
      const notice = el('p', 'notice notice--error', status.message);
      notice.setAttribute('role', 'alert');
      children.push(notice, retry);
    } else {
      children.push(...this.chart(status.response));
    }
    // Słupki są budowane od nowa — fokus klawiatury wraca na słupek o tym samym numerze.
    const slots = (): HTMLElement[] => [...this.body.querySelectorAll<HTMLElement>('.dchart__slot')];
    const focusedSlot = slots().indexOf(document.activeElement as HTMLElement);
    this.body.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
    if (focusedSlot >= 0) slots()[focusedSlot]?.focus();
  }

  private windowControl(): HTMLElement {
    const chips = el('div', 'departure__chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Okno czasu od wybranej godziny');
    for (const hours of WINDOW_CHOICES) {
      const chip = el('button', 'chip-button chip-button--small', `${hours} h`);
      chip.type = 'button';
      chip.setAttribute('aria-label', `Najbliższe ${hours} godzin`);
      chip.setAttribute('aria-pressed', String(hours === this.windowHours));
      chip.addEventListener('click', () => {
        if (hours === this.windowHours) return;
        this.windowHours = hours;
        void this.load();
      });
      chips.append(chip);
    }
    return chips;
  }

  private chart(response: DepartureResponse): HTMLElement[] {
    const comfort = this.options.getComfort();
    const bars = buildChart(response, comfort);
    const best = bestOptionIndex(response);
    const selected = optionIndexAt(response.options, this.options.getSelectedTime());
    const resting = bars[selected >= 0 ? selected : best] ?? bars[0];

    const readout = el('p', 'dchart__readout', resting.readout);
    const plot = el('div', 'dchart__plot');
    const axis = el('div', 'dchart__axis');
    axis.setAttribute('aria-hidden', 'true');

    for (const bar of bars) {
      plot.append(this.barButton(bar, bar.index === selected, readout, resting));
      axis.append(el('span', '', bar.tick ?? ''));
    }

    const chart = el('div', 'dchart', plot, axis);
    chart.setAttribute('role', 'group');
    chart.setAttribute('aria-label', 'Ocena komfortu trasy dla kolejnych godzin wyjścia. Wybierz słupek, aby ustawić godzinę.');

    const summaryText = response.summary?.trim();
    const summary = summaryText ? el('p', 'departure__summary', icon('clock'), el('span', '', summaryText)) : null;
    summary?.setAttribute('role', 'status');

    const nodes: (HTMLElement | null)[] = [summary, chart, readout];
    return nodes.filter((node): node is HTMLElement => node !== null);
  }

  private barButton(bar: ChartBar, selected: boolean, readout: HTMLElement, resting: ChartBar): HTMLButtonElement {
    const mark = el('span', 'dchart__bar');
    mark.style.background = bar.color;
    const button = el('button', 'dchart__slot', bar.isBest ? el('span', 'dchart__best', '★') : null, mark);
    button.type = 'button';
    button.style.setProperty('--h', `${bar.heightPct}%`);
    button.classList.toggle('dchart__slot--best', bar.isBest);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', bar.isBest ? `${bar.readout} — najlepsza pora` : bar.readout);
    button.title = bar.readout;

    const show = (): void => {
      readout.textContent = bar.isBest ? `${bar.readout} — najlepsza pora` : bar.readout;
    };
    const rest = (): void => {
      readout.textContent = resting.isBest ? `${resting.readout} — najlepsza pora` : resting.readout;
    };
    if (bar === resting) show();
    button.addEventListener('mouseenter', show);
    button.addEventListener('focus', show);
    button.addEventListener('mouseleave', rest);
    button.addEventListener('blur', rest);
    button.addEventListener('click', () => this.options.onPickTime(bar.time));
    return button;
  }
}
