// Cicha podpowiedź pod kartami tras: po wyznaczeniu trasy „na teraz” pyta w tle o najbliższe 3 godziny
// i — tylko gdy późniejsze wyjście jest wyraźnie lepsze — pokazuje jedną linię, której dotknięcie ustawia godzinę.

import { fetchDeparture } from '../api.ts';
import type { App } from '../app.ts';
import { HINT_STEP_MINUTES, HINT_WINDOW_HOURS, hintApplies, pickDepartureHint } from '../departureHint.ts';
import { effectiveComfort, type AppState } from '../store.ts';
import { wallTimeToIso } from '../time.ts';
import { icon } from '../ui/icons.ts';
import { byId, el } from '../util.ts';

const HINT_DELAY_MS = 1200;

export function installDepartureHint(app: App): void {
  const { store } = app;
  const box = byId<HTMLElement>('departure-hint');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  /** Odpowiedź z trasami, dla której już zapytano (najwyżej jedno zapytanie na trasę). */
  let asked: AppState['response'] = null;

  function clear(): void {
    clearTimeout(timer);
    request?.abort();
    request = null;
    box.hidden = true;
    box.replaceChildren();
  }

  async function load(response: NonNullable<AppState['response']>): Promise<void> {
    const state = store.get();
    if (state.response !== response || !state.from || !state.to) return;
    asked = response;
    const controller = new AbortController();
    request = controller;
    try {
      const result = await fetchDeparture(
        {
          from: { lat: state.from.lat, lon: state.from.lon },
          to: { lat: state.to.lat, lon: state.to.lon },
          start: wallTimeToIso(state.date, state.minutes),
          windowHours: HINT_WINDOW_HOURS,
          stepMinutes: HINT_STEP_MINUTES,
          shadePreference: state.shadePreference,
          mobility: state.mobility,
          comfort: 'auto',
        },
        controller.signal,
      );
      if (controller.signal.aborted || store.get().response !== response) return;
      const hint = pickDepartureHint(result, effectiveComfort(store.get()));
      if (!hint) return;
      const chip = el('button', 'hint-chip', icon('clock'), el('span', '', hint.text));
      chip.type = 'button';
      chip.addEventListener('click', () => app.actions.setDepartureTime(hint.time));
      box.replaceChildren(chip);
      box.hidden = false;
    } catch {
      // Podpowiedź jest dodatkiem — przy błędzie po prostu jej nie ma.
    } finally {
      if (request === controller) request = null;
    }
  }

  function sync(state: AppState, previous: AppState | null): void {
    if (
      previous !== null &&
      state.response === previous.response &&
      state.routeStatus === previous.routeStatus &&
      state.date === previous.date &&
      state.minutes === previous.minutes
    ) {
      return;
    }
    clear();
    const response = state.response;
    if (state.routeStatus !== 'ready' || !response || state.routeFromCache || response === asked) return;
    if (!hintApplies({ date: state.date, minutes: state.minutes }, new Date())) return;
    timer = setTimeout(() => void load(response), HINT_DELAY_MS);
  }

  store.subscribe(sync);
  sync(store.get(), null);
}
