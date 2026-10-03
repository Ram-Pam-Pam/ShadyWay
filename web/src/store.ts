// Mały magazyn stanu aplikacji: jedno źródło prawdy + powiadamianie subskrybentów o zmianach.

import type {
  ComfortMode,
  CoolSpot,
  HeatMeta,
  LatLon,
  MobilityProfile,
  RouteProfile,
  RouteResponse,
  RouteResult,
  SunInfo,
  WeatherInfo,
} from '../../shared/types.ts';

export type EndpointKey = 'from' | 'to';

export interface Place extends LatLon {
  label: string;
}

export type RouteStatus = 'idle' | 'loading' | 'ready' | 'error';

export type HeatStatus =
  | { state: 'loading' }
  | { state: 'ready'; meta: HeatMeta }
  | { state: 'unavailable'; reason: string };

export interface LayerToggles {
  shadows: boolean;
  heat: boolean;
  buildings3d: boolean;
  /** Punkty chłodu (woda, ławki, parki…) w widoku mapy. */
  coolSpots: boolean;
}

/** Wynik warstwy „Punkty chłodu” dla bieżącego widoku mapy. */
export interface CoolSpotLayerState {
  spots: CoolSpot[];
  /** Komunikat pod przełącznikiem warstwy (np. prośba o przybliżenie) albo null. */
  note: string | null;
}

export interface AppState {
  from: Place | null;
  to: Place | null;
  /** Który punkt ustawi następne kliknięcie mapy (null = żaden). */
  pickTarget: EndpointKey | null;
  /** Data w Krakowie, YYYY-MM-DD. */
  date: string;
  /** Minuty od północy w Krakowie. */
  minutes: number;
  /** true, gdy użytkownik nie wybrał czasu ręcznie (link bez daty oznacza „teraz”). */
  followNow: boolean;
  shadePreference: number;
  mobility: MobilityProfile;
  /** Tryb wybrany przez użytkownika; faktycznie zastosowany zwraca serwer (patrz effectiveComfort). */
  comfort: ComfortMode;
  viaCoolSpot: boolean;
  /** Ostatnia pozycja z GPS (dla asystenta i nawigacji); null, gdy nieznana. */
  userLocation: LatLon | null;
  coolSpotLayer: CoolSpotLayerState;
  routeStatus: RouteStatus;
  /** Zapytanie trwa dłużej niż chwilę — pewnie pobierane są dane OSM. */
  routeSlow: boolean;
  routeError: string | null;
  response: RouteResponse | null;
  /** true, gdy pokazywana trasa pochodzi z pamięci urządzenia (brak połączenia z serwerem). */
  routeFromCache: boolean;
  selectedProfile: RouteProfile;
  sun: SunInfo | null;
  weather: WeatherInfo | null;
  layers: LayerToggles;
  heat: HeatStatus;
  /** Komunikat warstwy cieni pokazywany na mapie (np. prośba o przybliżenie). */
  shadowHint: string | null;
  /** Błąd formularza (geolokalizacja itp.). */
  formError: string | null;
}

export type Listener<S> = (state: S, previous: S) => void;

export class Store<S extends object> {
  private state: S;
  private notified: S;
  private notifying = false;
  private readonly listeners = new Set<Listener<S>>();

  constructor(initial: S) {
    this.state = initial;
    this.notified = initial;
  }

  get(): S {
    return this.state;
  }

  set(patch: Partial<S>): void {
    const previous = this.state;
    const keys = Object.keys(patch) as (keyof S)[];
    if (keys.every((key) => Object.is(previous[key], patch[key]))) return;
    this.state = { ...previous, ...patch };
    // Zmiany zgłoszone przez subskrybenta w trakcie powiadamiania trafiają do kolejnego obiegu pętli,
    // dzięki czemu każdy subskrybent zawsze kończy na najnowszym stanie.
    if (this.notifying) return;
    this.notifying = true;
    try {
      while (this.notified !== this.state) {
        const from = this.notified;
        this.notified = this.state;
        for (const listener of [...this.listeners]) listener(this.notified, from);
      }
    } finally {
      this.notifying = false;
    }
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function samePoint(a: LatLon | null, b: LatLon | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lat === b.lat && a.lon === b.lon;
}

/** Wybrana trasa: profil zapamiętany przez użytkownika, w razie braku „balanced”, potem pierwsza. */
export function selectedRoute(state: Pick<AppState, 'response' | 'selectedProfile'>): RouteResult | null {
  const routes = state.response?.routes ?? [];
  return (
    routes.find((route) => route.profile === state.selectedProfile) ??
    routes.find((route) => route.profile === 'balanced') ??
    routes[0] ??
    null
  );
}

/**
 * Tryb, w którym interfejs ma „mówić”: rozstrzygnięty przez serwer dla bieżącej odpowiedzi,
 * a zanim odpowiedź przyjdzie — wybór użytkownika ('auto' traktujemy do tego czasu jak cień).
 */
export function effectiveComfort(state: Pick<AppState, 'response' | 'comfort'>): 'shade' | 'sun' {
  const applied = state.response?.comfort;
  if (applied === 'sun' || applied === 'shade') return applied;
  return state.comfort === 'sun' ? 'sun' : 'shade';
}
