// Przycisk „Moja lokalizacja”: ustawia start z GPS i zapamiętuje pozycję użytkownika w stanie.

import type { LatLon } from '../../../shared/types.ts';
import { inServiceArea } from '../plan.ts';
import type { AppState, Store } from '../store.ts';
import { byId } from '../util.ts';

export interface LocateOptions {
  store: Store<AppState>;
  /** Pozycja w obszarze obsługi — ustaw ją jako start. */
  onLocated(point: LatLon): void;
}

export function installLocateButton({ store, onLocated }: LocateOptions): void {
  const button = byId<HTMLButtonElement>('locate-button');
  button.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      store.set({ formError: 'Ta przeglądarka nie udostępnia lokalizacji.' });
      return;
    }
    button.disabled = true;
    button.classList.add('is-busy');
    const finish = (): void => {
      button.disabled = false;
      button.classList.remove('is-busy');
    };
    navigator.geolocation.getCurrentPosition(
      (position) => {
        finish();
        const point = { lat: position.coords.latitude, lon: position.coords.longitude };
        if (!inServiceArea(point)) {
          store.set({ formError: 'Twoja lokalizacja jest poza Krakowem — wskaż start na mapie.' });
          return;
        }
        store.set({ userLocation: point });
        onLocated(point);
      },
      (error) => {
        finish();
        store.set({
          formError:
            error.code === error.PERMISSION_DENIED
              ? 'Brak zgody na dostęp do lokalizacji. Zezwól na nią w przeglądarce albo wskaż start na mapie.'
              : 'Nie udało się ustalić lokalizacji. Wskaż start na mapie.',
        });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}
