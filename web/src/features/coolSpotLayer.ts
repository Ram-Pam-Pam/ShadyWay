// Warstwa „Punkty chłodu”: pobiera punkty dla widoku mapy (od przybliżenia 15), z opóźnieniem i anulowalnie.
// Wynik trafia do stanu (`coolSpotLayer`), a rysowaniem znaczników zajmuje się mapa.

import { fetchCoolSpots, isAbortError } from '../api.ts';
import { COOL_SPOT_MIN_ZOOM, capCoolSpots, coolSpotLayerNote } from '../coolSpots.ts';
import type { MapView } from '../map.ts';
import type { AppState, Store } from '../store.ts';
import { wallTimeToIso } from '../time.ts';
import { debounce, type Debounced } from '../util.ts';

const COOL_SPOTS_DEBOUNCE_MS = 350;

/** Zwraca funkcję odświeżającą warstwę (wołaną po ruchu mapy, zmianie czasu, przełączeniu warstwy, nowej trasie). */
export function createCoolSpotLayer(store: Store<AppState>, map: MapView): Debounced<[]> {
  let request: AbortController | null = null;

  const load = async (): Promise<void> => {
    request?.abort();
    request = null;
    const state = store.get();
    if (!state.layers.coolSpots) {
      store.set({ coolSpotLayer: { spots: [], note: null } });
      return;
    }
    if (map.getZoom() < COOL_SPOT_MIN_ZOOM) {
      store.set({ coolSpotLayer: { spots: [], note: 'Przybliż mapę, aby zobaczyć punkty chłodu' } });
      return;
    }
    const controller = new AbortController();
    request = controller;
    try {
      const all = await fetchCoolSpots(
        map.getViewBbox(),
        { time: wallTimeToIso(state.date, state.minutes) },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const { spots, total } = capCoolSpots(Array.isArray(all) ? all : []);
      store.set({ coolSpotLayer: { spots, note: coolSpotLayerNote(spots.length, total) } });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return;
      store.set({ coolSpotLayer: { spots: [], note: 'Nie udało się pobrać punktów chłodu' } });
    }
  };

  return debounce(() => void load(), COOL_SPOTS_DEBOUNCE_MS);
}
