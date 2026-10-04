// Kontekst aplikacji przekazywany modułom funkcji (features/*): stan, mapa, panel i wspólne akcje.
// Nowe funkcje (asystent AI, nawigacja krok po kroku, PWA) dopinają się przez ten interfejs,
// zamiast rozbudowywać main.ts — wzór: `export function installX(app: App): void`.

import type { LatLon, RouteProfile } from '../../shared/types.ts';
import type { MapView } from './map.ts';
import type { PlanPatch } from './plan.ts';
import type { AppState, EndpointKey, LayerToggles, Place, Store } from './store.ts';
import type { RouteList } from './ui/routeList.ts';
import type { Sheet } from './ui/sheet.ts';
import type { PanelTabs } from './ui/tabs.ts';

export type FitMode = 'always' | 'if-needed';

export interface AppActions {
  /** Ustawia start lub cel (znana nazwa miejsca); trasa przelicza się sama. */
  setEndpoint(which: EndpointKey, place: Place, fit: FitMode): void;
  /** Ustawia punkt wskazany współrzędnymi i dociąga jego nazwę z odwrotnego geokodowania. */
  placePoint(which: EndpointKey, point: LatLon, fit: FitMode): void;
  selectProfile(profile: RouteProfile): void;
  /** Ustawia moment wyjścia (ISO) i wyłącza tryb „Teraz”. */
  setDepartureTime(iso: string): void;
  /** Ustawia pola trasy z planu asystenta AI (punkty, czas, profil, preferencja); trasa przelicza się sama. */
  applyPlanRouting(patch: PlanPatch): void;
  /** Przełącza warstwy mapy; zwraca te, które faktycznie ustawiono (niedostępne są pomijane). */
  setLayers(layers: Partial<LayerToggles>): Partial<LayerToggles>;
  /** Rozwija wykres „Kiedy wyjść?” w zakładce „Trasa”. */
  openDeparture(): void;
  /** Wyznacza trasę ponownie dla bieżących ustawień (np. po odzyskaniu połączenia). */
  refreshRoute(): void;
}

export interface App {
  store: Store<AppState>;
  map: MapView;
  sheet: Sheet;
  /** Zakładki panelu; `tabs.enableAssistant()` pokazuje zakładkę „Asystent” (zawartość: #assistant-panel). */
  tabs: PanelTabs;
  /** `routeList.setNavigationHandler(fn)` pokazuje przycisk „Nawiguj” na wybranej trasie. */
  routeList: RouteList;
  actions: AppActions;
}
