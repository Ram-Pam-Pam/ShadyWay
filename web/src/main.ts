// Punkt wejścia: spina magazyn stanu, mapę, panel i zapytania do API.
// Funkcje poboczne (warstwy, „Kiedy wyjść?”, lokalizacja, adres URL) żyją w features/*;
// kolejne (asystent AI, nawigacja, PWA) dopinają się na końcu pliku przez obiekt `app`.

import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './style-extras.css';

import type { LatLon, RouteProfile } from '../../shared/types.ts';
import {
  ApiRequestError,
  errorMessage,
  fetchHeatMeta,
  fetchRoute,
  fetchSun,
  fetchWeather,
  isAbortError,
  reverseGeocode,
} from './api.ts';
import type { App, FitMode } from './app.ts';
import { installAssistant } from './features/assistant.ts';
import { DepartureFeature } from './features/departure.ts';
import { installDepartureHint } from './features/departureHint.ts';
import { installLocateButton } from './features/locate.ts';
import { installNavigation } from './features/navigation.ts';
import { installPwa } from './features/pwa.ts';
import { createShadowLayer } from './features/shadows.ts';
import { installUrlSync } from './features/urlSync.ts';
import { formatCoordinates } from './format.ts';
import { parseHash } from './hash.ts';
import { comfortTexts, routeSummary } from './labels.ts';
import { MapView } from './map.ts';
import { cachedRouteFor, loadLastRoute, saveLastRoute } from './offlineRoute.ts';
import { loadPrefs, savePrefs } from './prefs.ts';
import {
  Store,
  effectiveComfort,
  samePoint,
  selectedRoute,
  type AppState,
  type EndpointKey,
  type LayerToggles,
  type Place,
} from './store.ts';
import { instantToWallTime, nowWallTime, wallTimeToIso } from './time.ts';
import { LayerPanel } from './ui/layerPanel.ts';
import { PlaceField } from './ui/placeField.ts';
import { PreferencesControl } from './ui/preferencesControl.ts';
import { RouteList } from './ui/routeList.ts';
import { describeSegment } from './ui/segmentPopup.ts';
import { Sheet } from './ui/sheet.ts';
import { PanelTabs } from './ui/tabs.ts';
import { TimeControl } from './ui/timeControl.ts';
import { byId, debounce, queryIn } from './util.ts';

const ROUTE_DEBOUNCE_MS = 400;
const SLOW_REQUEST_MS = 2000;
const AMBIENT_DEBOUNCE_MS = 250;
const NOW_CHECK_INTERVAL_MS = 60_000;
/** Tryb cień/słońce zawsze rozstrzyga serwer (cień w upale, słońce w chłodne dni). */
const REQUEST_COMFORT = 'auto';

function nextPickTarget(from: Place | null, to: Place | null): EndpointKey | null {
  if (!from) return 'from';
  if (!to) return 'to';
  return null;
}

function initialState(): AppState {
  const parsed = parseHash(window.location.hash);
  const time = parsed.time ?? nowWallTime();
  // Link z trasą opisuje ją w całości (brak pola = wartość domyślna); bez trasy obowiązują zapamiętane preferencje.
  const sharedRoute = parsed.from !== null || parsed.to !== null;
  const prefs = loadPrefs();
  return {
    from: parsed.from,
    to: parsed.to,
    pickTarget: nextPickTarget(parsed.from, parsed.to),
    date: time.date,
    minutes: time.minutes,
    followNow: parsed.time === null,
    shadePreference: parsed.shadePreference ?? 0.5,
    mobility: parsed.mobility ?? (sharedRoute ? 'default' : prefs.mobility),
    userLocation: null,
    routeStatus: 'idle',
    routeSlow: false,
    routeError: null,
    response: null,
    routeFromCache: false,
    selectedProfile: 'balanced',
    sun: null,
    weather: null,
    layers: { shadows: true, heat: false, buildings3d: false },
    heat: { state: 'loading' },
    shadowHint: null,
    formError: null,
  };
}

function endpointPatch(which: EndpointKey, place: Place | null): Partial<AppState> {
  return which === 'from' ? { from: place } : { to: place };
}

const store = new Store<AppState>(initialState());
const sheet = new Sheet();
const tabs = new PanelTabs();

// ───────────────────────── mapa ─────────────────────────

const map = new MapView({
  container: byId('map'),
  onPick: (point) => {
    const target = store.get().pickTarget;
    if (target) placePoint(target, point, 'if-needed');
  },
  onMarkerDrag: (which, point) => placePoint(which, point, 'if-needed'),
  onSelectRoute: (profile) => selectProfile(profile),
  onViewChange: () => refreshShadows(),
  describeSegment,
  getPadding: () => sheet.mapPadding(),
});

const refreshShadows = createShadowLayer(store, map);

// ───────────────────────── panel ─────────────────────────

const fields: Record<EndpointKey, PlaceField> = {
  from: createField('from'),
  to: createField('to'),
};

function createField(which: EndpointKey): PlaceField {
  return new PlaceField({
    root: queryIn<HTMLElement>(document, `.place[data-endpoint="${which}"]`),
    onSelect: (place) => {
      const other = store.get()[which === 'from' ? 'to' : 'from'];
      setEndpoint(which, place, 'always');
      if (!other) map.flyTo(place);
    },
    onClear: () => {
      store.set({ ...endpointPatch(which, null), pickTarget: which, formError: null });
    },
    onActivate: () => store.set({ pickTarget: which }),
  });
}

const timeControl = new TimeControl({
  onChange: (time) => store.set({ ...time, followNow: false }),
  onNow: () => store.set({ ...nowWallTime(), followNow: true }),
});

const preferences = new PreferencesControl({
  onMobility: (mobility) => store.set({ mobility }),
  onPreference: (shadePreference) => store.set({ shadePreference }),
});

const routeList = new RouteList({
  onSelect: (profile) => selectProfile(profile),
  onHighlightStep: (step, pan) => map.highlightPoint(step?.location ?? null, pan),
});

const layerPanel = new LayerPanel({
  onToggle: (layer, enabled) => store.set({ layers: { ...store.get().layers, [layer]: enabled } }),
});

const departure = new DepartureFeature({
  getRequest: () => {
    const { from, to, date, minutes, shadePreference, mobility } = store.get();
    if (!from || !to) return null;
    return {
      from: { lat: from.lat, lon: from.lon },
      to: { lat: to.lat, lon: to.lon },
      start: wallTimeToIso(date, minutes),
      shadePreference,
      mobility,
      comfort: REQUEST_COMFORT,
    };
  },
  getComfort: () => effectiveComfort(store.get()),
  getSelectedTime: () => wallTimeToIso(store.get().date, store.get().minutes),
  onPickTime: (iso) => setDepartureTime(iso),
});

const departureBox = byId<HTMLElement>('departure');
const formError = byId<HTMLElement>('form-error');
const mapHint = byId<HTMLElement>('map-hint');
const mapProgress = byId<HTMLElement>('map-progress');

byId<HTMLButtonElement>('swap-button').addEventListener('click', () => {
  const { from, to } = store.get();
  if (!from && !to) return;
  fitMode = 'always';
  store.set({ from: to, to: from, pickTarget: nextPickTarget(to, from), formError: null });
});

installLocateButton({
  store,
  onLocated: (point) => {
    const hadDestination = store.get().to !== null;
    setEndpoint('from', { ...point, label: 'Moja lokalizacja' }, 'always');
    if (!hadDestination) map.flyTo(point);
  },
});

// ───────────────────────── akcje ─────────────────────────

/** Jak dopasować widok mapy po najbliższym wyznaczeniu trasy (null = nie ruszać mapy). */
let fitMode: FitMode | null = 'always';

function setEndpoint(which: EndpointKey, place: Place, fit: FitMode): void {
  const state = store.get();
  const from = which === 'from' ? place : state.from;
  const to = which === 'to' ? place : state.to;
  fitMode = fit;
  store.set({ ...endpointPatch(which, place), pickTarget: nextPickTarget(from, to), formError: null });
}

/** Punkt wskazany na mapie: od razu etykieta ze współrzędnych, potem nazwa z odwrotnego geokodowania. */
function placePoint(which: EndpointKey, point: LatLon, fit: FitMode): void {
  setEndpoint(which, { ...point, label: formatCoordinates(point) }, fit);
  reverseGeocode(point)
    .then((result) => {
      const current = store.get()[which];
      if (result?.label && current && samePoint(current, point)) {
        store.set(endpointPatch(which, { ...current, label: result.label }));
      }
    })
    .catch(() => {
      // Brak nazwy nie przeszkadza — zostają współrzędne.
    });
}

function selectProfile(profile: RouteProfile): void {
  store.set({ selectedProfile: profile });
}

function setDepartureTime(iso: string): void {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return;
  store.set({ ...instantToWallTime(instant), followNow: false });
}

// ───────────────────────── trasa ─────────────────────────

let routeTimer: ReturnType<typeof setTimeout> | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let routeRequest: AbortController | null = null;

/** Anuluje trwające zapytanie i planuje nowe; `clearResponse` usuwa trasę nieaktualną dla nowych punktów. */
function requestRoute(delayMs: number, clearResponse: boolean): void {
  clearTimeout(routeTimer);
  clearTimeout(slowTimer);
  routeRequest?.abort();
  routeRequest = null;

  const { from, to, response } = store.get();
  if (!from || !to) {
    store.set({ routeStatus: 'idle', routeSlow: false, routeError: null, response: null, routeFromCache: false });
    return;
  }
  store.set({
    routeStatus: 'loading',
    routeSlow: false,
    routeError: null,
    response: clearResponse ? null : response,
  });
  routeTimer = setTimeout(() => void runRoute(), delayMs);
}

async function runRoute(): Promise<void> {
  const state = store.get();
  if (!state.from || !state.to) return;
  const controller = new AbortController();
  routeRequest = controller;
  slowTimer = setTimeout(() => store.set({ routeSlow: true }), SLOW_REQUEST_MS);

  try {
    const response = await fetchRoute(
      {
        from: { lat: state.from.lat, lon: state.from.lon },
        to: { lat: state.to.lat, lon: state.to.lon },
        time: wallTimeToIso(state.date, state.minutes),
        shadePreference: state.shadePreference,
        mobility: state.mobility,
        comfort: REQUEST_COMFORT,
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    clearTimeout(slowTimer);
    if (response.routes.length === 0) {
      store.set({
        routeStatus: 'error',
        routeSlow: false,
        routeError: 'Nie znaleziono pieszej trasy między tymi punktami.',
        response: null,
      });
      return;
    }
    store.set({
      routeStatus: 'ready',
      routeSlow: false,
      response,
      routeFromCache: false,
      sun: response.sun,
      weather: response.weather ?? store.get().weather,
    });
    saveLastRoute(store.get());
    const route = selectedRoute(store.get());
    if (route && fitMode) map.fitRoute(route, fitMode);
    fitMode = null;
    // Wyznaczenie trasy mogło pobrać dane mapy dla okolicy, w której warstwy były dotąd puste.
    refreshShadows();
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) return;
    clearTimeout(slowTimer);
    // Bez połączenia z serwerem pokazujemy ostatnią zapisaną trasę, jeśli dotyczy tych samych punktów.
    const saved =
      error instanceof ApiRequestError && error.code === 'NETWORK' ? cachedRouteFor(store.get(), loadLastRoute()) : null;
    if (saved) {
      store.set({
        routeStatus: 'ready',
        routeSlow: false,
        routeError: null,
        response: saved.response,
        routeFromCache: true,
        sun: saved.response.sun,
        weather: saved.response.weather ?? store.get().weather,
      });
      const route = selectedRoute(store.get());
      if (route && fitMode) map.fitRoute(route, fitMode);
      fitMode = null;
      return;
    }
    store.set({
      routeStatus: 'error',
      routeSlow: false,
      routeError: errorMessage(error),
      response: null,
      routeFromCache: false,
    });
  }
}

// ───────────────────────── słońce i pogoda ─────────────────────────

let ambientRequest: AbortController | null = null;

const refreshAmbient = debounce(() => {
  ambientRequest?.abort();
  const controller = new AbortController();
  ambientRequest = controller;
  const { date, minutes } = store.get();
  const time = wallTimeToIso(date, minutes);
  // Informacje pomocnicze — przy błędzie po prostu ich nie pokazujemy.
  const settle = <T>(request: Promise<T>, commit: (value: T | null) => void): void => {
    const guarded = (value: T | null): void => {
      if (!controller.signal.aborted) commit(value);
    };
    request.then(guarded, () => guarded(null));
  };
  settle(fetchSun(time, controller.signal), (sun) => store.set({ sun }));
  settle(fetchWeather(time, controller.signal), (weather) => store.set({ weather }));
}, AMBIENT_DEBOUNCE_MS);

// ───────────────────────── tryb „Teraz” ─────────────────────────

/**
 * W trybie „Teraz” czas wyjścia podąża za zegarem: co minutę oraz po powrocie do karty sprawdzamy, czy zaczął
 * się nowy przedział suwaka. Zmiana stanu sama odświeża trasę, słońce, pogodę i cienie (patrz apply).
 */
function followClock(): void {
  const state = store.get();
  if (!state.followNow || document.visibilityState === 'hidden') return;
  const now = nowWallTime();
  if (now.date !== state.date || now.minutes !== state.minutes) store.set(now);
}

setInterval(followClock, NOW_CHECK_INTERVAL_MS);
document.addEventListener('visibilitychange', followClock);
window.addEventListener('focus', followClock);

// ───────────────────────── mapa ciepła ─────────────────────────

fetchHeatMeta()
  .then((meta) => {
    store.set({
      heat:
        meta.available && meta.bounds
          ? { state: 'ready', meta }
          : { state: 'unavailable', reason: 'Brak danych satelitarnych na serwerze' },
    });
  })
  .catch(() => {
    store.set({ heat: { state: 'unavailable', reason: 'Nie udało się pobrać danych mapy ciepła' } });
  });

/** Czy podkład mapy ma wysokości budynków (inaczej warstwy 3D nie da się włączyć). */
let buildingsAvailable = true;

map.whenReady(({ hasBuildings }) => {
  buildingsAvailable = hasBuildings;
  if (!hasBuildings) layerPanel.disableBuildings();
});

// ───────────────────────── adres URL ─────────────────────────

const urlSync = installUrlSync((parsed) => {
  const time = parsed.time ?? nowWallTime();
  const current = store.get();
  fitMode = 'always';
  store.set({
    from: parsed.from,
    to: parsed.to,
    pickTarget: nextPickTarget(parsed.from, parsed.to),
    date: time.date,
    minutes: time.minutes,
    followNow: parsed.time === null,
    shadePreference: parsed.shadePreference ?? current.shadePreference,
    mobility: parsed.mobility ?? 'default',
  });
});

// ───────────────────────── widok ─────────────────────────

function sheetSummary(state: AppState): string {
  if (state.routeStatus === 'loading') return 'Wyznaczam trasę…';
  if (state.routeStatus === 'error') return state.routeError ?? 'Nie udało się wyznaczyć trasy';
  const comfort = effectiveComfort(state);
  const route = selectedRoute(state);
  return route ? routeSummary(route, comfort) : comfortTexts(comfort).idleSummary;
}

/** Przenosi zmiany stanu na interfejs i uruchamia zależne zapytania. `previous === null` = pierwsze rysowanie. */
function apply(state: AppState, previous: AppState | null): void {
  const changed = (...keys: (keyof AppState)[]): boolean =>
    previous === null || keys.some((key) => state[key] !== previous[key]);

  const comfort = effectiveComfort(state);
  const comfortChanged = previous === null || comfort !== effectiveComfort(previous);
  if (comfortChanged) {
    // Atrybut na <html> przełącza akcenty interfejsu (cień = indygo, słońce = bursztyn).
    document.documentElement.dataset.comfort = comfort;
    map.setComfort(comfort);
  }

  for (const which of ['from', 'to'] as const) {
    if (changed(which)) {
      fields[which].setPlace(state[which]);
      map.setMarker(which, state[which]);
    }
  }
  if (changed('pickTarget')) {
    fields.from.setActive(state.pickTarget === 'from');
    fields.to.setActive(state.pickTarget === 'to');
    map.setPickCursor(state.pickTarget !== null);
  }
  if (changed('formError')) {
    formError.hidden = state.formError === null;
    formError.textContent = state.formError ?? '';
  }
  if (changed('shadePreference', 'mobility', 'response')) preferences.render(state);
  if (changed('date', 'minutes', 'followNow', 'sun', 'weather')) timeControl.render(state);
  if (changed('from', 'to')) departureBox.hidden = !state.from || !state.to;
  if (changed('from', 'to', 'routeStatus', 'routeSlow', 'routeError', 'response', 'selectedProfile')) {
    routeList.render(state);
    sheet.setSummary(sheetSummary(state));
  }
  if (changed('response', 'selectedProfile', 'routeStatus')) {
    map.setRoutes(state.response?.routes ?? [], selectedRoute(state), state.routeStatus === 'loading');
    map.highlightPoint(null);
    mapProgress.hidden = state.routeStatus !== 'loading';
  }
  if (changed('layers', 'heat')) {
    layerPanel.render(state);
    const heatMeta = state.heat.state === 'ready' ? state.heat.meta : null;
    map.setHeat(heatMeta, heatMeta !== null && state.layers.heat);
  }
  if (previous === null ? state.layers.buildings3d : state.layers.buildings3d !== previous.layers.buildings3d) {
    map.setBuildings3d(state.layers.buildings3d);
  }
  if (changed('shadowHint')) {
    mapHint.hidden = state.shadowHint === null;
    mapHint.textContent = state.shadowHint ?? '';
  }
  const routeOptionsChanged = changed('mobility');
  if (changed('from', 'to', 'date', 'minutes', 'followNow', 'shadePreference') || routeOptionsChanged) urlSync.write(state);
  if (previous !== null && routeOptionsChanged) {
    savePrefs({ mobility: state.mobility });
  }

  // Zapytania zależne od danych wejściowych (zmiana samej etykiety miejsca niczego nie przelicza).
  const endpointsMoved =
    previous === null || !samePoint(state.from, previous.from) || !samePoint(state.to, previous.to);
  const timeChanged = changed('date', 'minutes');
  if (endpointsMoved) requestRoute(0, true);
  else if (routeOptionsChanged) requestRoute(0, false);
  else if (timeChanged || changed('shadePreference')) requestRoute(ROUTE_DEBOUNCE_MS, false);
  if (timeChanged) refreshAmbient();
  if (timeChanged || previous === null || state.layers.shadows !== previous.layers.shadows) refreshShadows();

  if (previous !== null) {
    if (endpointsMoved || changed('shadePreference', 'mobility')) departure.invalidate();
    else if (timeChanged || comfortChanged) departure.refresh();
  }
}

store.subscribe(apply);
apply(store.get(), null);

// ───────────────────────── punkty rozszerzeń ─────────────────────────

/**
 * Kontekst dla kolejnych modułów (patrz app.ts). Wzór użycia:
 *   installAssistant(app)  — tabs.enableAssistant(), czat w #assistant-panel, plan wykonuje assistant/planRunner.ts przez actions.*
 *   installNavigation(app) — routeList.setNavigationHandler(route => …), nakładka #nav-overlay
 */
export const app: App = {
  store,
  map,
  sheet,
  tabs,
  routeList,
  actions: {
    setEndpoint,
    placePoint,
    selectProfile,
    setDepartureTime,
    applyPlanRouting: (patch) => {
      if (patch.from || patch.to) fitMode = 'always';
      store.set(patch);
    },
    setLayers: (layers) => {
      const state = store.get();
      const applied: Partial<LayerToggles> = {};
      if (typeof layers.shadows === 'boolean') applied.shadows = layers.shadows;
      if (typeof layers.heat === 'boolean' && state.heat.state === 'ready') applied.heat = layers.heat;
      if (typeof layers.buildings3d === 'boolean' && buildingsAvailable) applied.buildings3d = layers.buildings3d;
      if (Object.keys(applied).length > 0) store.set({ layers: { ...state.layers, ...applied } });
      return applied;
    },
    openDeparture: () => {
      if (departureBox.hidden) return;
      departure.show();
      departureBox.scrollIntoView({ block: 'nearest' });
    },
    refreshRoute: () => requestRoute(0, false),
  },
};

installDepartureHint(app);
installAssistant(app);
installNavigation(app);
installPwa(app);
