// Warstwa cieni: pobiera wielokąty cieni dla widoku mapy i wybranej chwili (z opóźnieniem, anulowalnie).

import { errorMessage, fetchShadows, isAbortError } from '../api.ts';
import type { MapView } from '../map.ts';
import { shadowWindow } from '../shadowWindow.ts';
import type { AppState, Store } from '../store.ts';
import { wallTimeToIso } from '../time.ts';
import { debounce, type Debounced } from '../util.ts';

const SHADOWS_DEBOUNCE_MS = 250;

function shadowHintFor(night: boolean, missingData: boolean, partial: boolean): string | null {
  if (night) return 'Słońce pod horyzontem — brak cieni';
  if (missingData) return 'Brak danych o cieniach w części tej okolicy';
  if (partial) return 'Przybliż, aby zobaczyć wszystkie cienie';
  return null;
}

/** Zwraca funkcję odświeżającą warstwę (wołaną po ruchu mapy, zmianie czasu i po wyznaczeniu trasy). */
export function createShadowLayer(store: Store<AppState>, map: MapView): Debounced<[]> {
  let request: AbortController | null = null;

  const load = async (): Promise<void> => {
    request?.abort();
    request = null;
    const state = store.get();
    if (!state.layers.shadows) {
      map.setShadows(null, false);
      store.set({ shadowHint: null });
      return;
    }
    const view = shadowWindow(map.getViewBbox(), map.getCenter());
    if (view.kind === 'too-large') {
      map.setShadows(null, false);
      store.set({ shadowHint: 'Przybliż mapę, aby zobaczyć cienie' });
      return;
    }
    const controller = new AbortController();
    request = controller;
    try {
      const shadows = await fetchShadows(view.bbox, wallTimeToIso(state.date, state.minutes), controller.signal);
      if (controller.signal.aborted) return;
      map.setShadows(shadows, true);
      const night = store.get().sun?.isDay === false;
      store.set({
        shadowHint: shadowHintFor(night && shadows.features.length === 0, shadows.missingData === true, view.partial),
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      map.setShadows(null, false);
      store.set({ shadowHint: errorMessage(error) });
    }
  };

  return debounce(() => void load(), SHADOWS_DEBOUNCE_MS);
}
