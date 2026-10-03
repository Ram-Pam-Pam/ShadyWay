// Tryb nawigacji krok po kroku: mapa na cały ekran, baner najbliższego manewru, pasek z pozostałą drogą,
// śledzenie pozycji (GPS albo symulacja), wykrywanie zejścia z trasy z automatycznym przeliczeniem,
// zapowiedzi głosowe, podpowiedzi o cieniu i blokada wygaszania ekranu.

import type { RouteResult } from '../../../shared/types.ts';
import type { App } from '../app.ts';
import { formatDistance, formatDuration, formatPercent } from '../format.ts';
import {
  dueAnnouncement,
  distanceM,
  hasArrived,
  navProgress,
  prepareRoute,
  shadeHint,
  snapToRoute,
  splitInstruction,
  trackOffRoute,
  type NavProgress,
  type NavRoute,
} from '../nav/progress.ts';
import {
  GeolocationSource,
  SimulatedSource,
  geolocationAvailable,
  type Fix,
  type PositionSource,
  type SourceError,
} from '../nav/sources.ts';
import { Speaker } from '../nav/speech.ts';
import { inServiceArea } from '../plan.ts';
import { effectiveComfort, selectedRoute, type AppState } from '../store.ts';
import { formatKrakowClock } from '../time.ts';
import { icon, maneuverIcon, type IconName } from '../ui/icons.ts';
import { byId, el } from '../util.ts';

const SETTINGS_KEY = 'cien:nav:v1';
const NAV_ZOOM = 17.3;
const FOLLOW_MS = 1000;
/** Po przeliczeniu trasy przez chwilę nie oceniamy zejścia z niej (nowa trasa dopiero się rysuje). */
const REROUTE_COOLDOWN_MS = 8000;
const USER_LOCATION_INTERVAL_MS = 5000;
const SIM_SPEEDS = [1, 4, 12] as const;
/** Bliżej linii trasy rysujemy pozycję na samej trasie (GPS w mieście „pływa” o kilka–kilkanaście metrów). */
const SNAP_DISPLAY_M = 20;

interface NavSettings {
  voice: boolean;
  headingUp: boolean;
}

function loadSettings(): NavSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<NavSettings> | null;
    return { voice: raw?.voice !== false, headingUp: raw?.headingUp !== false };
  } catch {
    return { voice: true, headingUp: true };
  }
}

function saveSettings(settings: NavSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Pamięć lokalna niedostępna — ustawienia obowiązują do zamknięcia karty.
  }
}

function demoRequested(): boolean {
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

interface Session {
  nav: NavRoute;
  mode: 'gps' | 'sim';
  source: PositionSource;
  /** Ostatni znany postęp wzdłuż trasy (null = jeszcze nieustalony albo trasa właśnie się zmieniła). */
  alongM: number | null;
  strikes: number;
  spoken: Set<string>;
  following: boolean;
  arrived: boolean;
  rerouting: boolean;
  ignoreOffRouteUntil: number;
  lastFix: Fix | null;
  lastBearing: number;
  simSpeedIndex: number;
  lastLocationWrite: number;
  hintKey: string | null;
  /** GPS zgłosił chwilowy brak pozycji — komunikat znika przy następnym odczycie. */
  signalLost: boolean;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

function roundButton(name: IconName, label: string): HTMLButtonElement {
  const button = el('button', 'nav-round', icon(name));
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

export function installNavigation(app: App): void {
  const { store, map } = app;
  const appRoot = byId<HTMLElement>('app');
  const overlay = byId<HTMLElement>('nav-overlay');
  const settings = loadSettings();
  const speaker = new Speaker(settings.voice);
  let session: Session | null = null;
  let wakeLock: WakeLockSentinelLike | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  // ───────────── szkielet nakładki ─────────────

  const bannerIcon = el('span', 'nav-banner__icon');
  const bannerDistance = el('span', 'nav-banner__distance');
  const bannerText = el('span', 'nav-banner__text');
  const bannerRest = el('span', 'nav-banner__rest');
  const banner = el('div', 'nav-banner', bannerIcon, el('div', 'nav-banner__body', bannerDistance, bannerText, bannerRest));
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const hint = el('p', 'nav-hint');
  hint.hidden = true;
  const noticeText = el('span');
  const noticeAction = el('button', 'chip-button chip-button--small');
  noticeAction.type = 'button';
  noticeAction.hidden = true;
  const notice = el('div', 'nav-notice', noticeText, noticeAction);
  notice.setAttribute('role', 'status');
  notice.hidden = true;

  const voiceButton = roundButton('volume', 'Zapowiedzi głosowe');
  voiceButton.hidden = !Speaker.supported();
  const headingButton = roundButton('compass', 'Orientacja mapy');
  const recenterButton = el('button', 'nav-recenter', icon('target'), el('span', '', 'Wyśrodkuj'));
  recenterButton.type = 'button';
  recenterButton.hidden = true;

  const statTime = el('strong', 'nav-stats__time');
  const statDetail = el('span', 'nav-stats__detail');
  const statShade = el('span', 'nav-stats__shade');
  const simBadge = el('span', 'nav-sim__badge', 'Symulacja');
  const simSpeed = el('button', 'chip-button chip-button--small nav-sim__speed');
  simSpeed.type = 'button';
  const sim = el('div', 'nav-sim', simBadge, simSpeed);
  sim.hidden = true;
  const exit = el('button', 'nav-exit', icon('close'), el('span', '', 'Zakończ'));
  exit.type = 'button';
  exit.setAttribute('aria-label', 'Zakończ nawigację');

  overlay.replaceChildren(
    el('div', 'nav-top', banner, hint, notice),
    el('div', 'nav-side', voiceButton, headingButton),
    el(
      'div',
      'nav-bottom',
      el('div', 'nav-bottom__row', sim, recenterButton),
      el('div', 'nav-bar', el('div', 'nav-stats', statTime, statDetail, statShade), exit),
    ),
  );

  // ───────────── komunikaty ─────────────

  function showNotice(text: string, options: { action?: { label: string; run: () => void }; autoHideMs?: number } = {}): void {
    clearTimeout(noticeTimer);
    noticeText.textContent = text;
    noticeAction.hidden = !options.action;
    noticeAction.textContent = options.action?.label ?? '';
    noticeAction.onclick = options.action ? options.action.run : null;
    notice.hidden = false;
    if (options.autoHideMs) noticeTimer = setTimeout(() => (notice.hidden = true), options.autoHideMs);
  }

  function hideNotice(): void {
    clearTimeout(noticeTimer);
    notice.hidden = true;
  }

  function setBanner(iconNode: Node, distance: string, text: string, rest = ''): void {
    bannerIcon.replaceChildren(iconNode);
    bannerDistance.textContent = distance;
    bannerDistance.hidden = distance === '';
    bannerText.textContent = text;
    bannerRest.textContent = rest;
    bannerRest.hidden = rest === '';
  }

  function syncToggles(): void {
    voiceButton.replaceChildren(icon(settings.voice ? 'volume' : 'mute'));
    voiceButton.setAttribute('aria-pressed', String(settings.voice));
    voiceButton.title = settings.voice ? 'Zapowiedzi głosowe włączone' : 'Zapowiedzi głosowe wyłączone';
    voiceButton.setAttribute('aria-label', voiceButton.title);
    headingButton.setAttribute('aria-pressed', String(settings.headingUp));
    headingButton.title = settings.headingUp ? 'Kierunek marszu u góry — przełącz na północ u góry' : 'Północ u góry — przełącz na kierunek marszu';
    headingButton.setAttribute('aria-label', headingButton.title);
    headingButton.classList.toggle('nav-round--north', !settings.headingUp);
  }

  function syncSim(): void {
    sim.hidden = session?.mode !== 'sim';
    if (session) {
      const speed = SIM_SPEEDS[session.simSpeedIndex];
      simSpeed.textContent = speed === 1 ? 'Tempo marszu' : `Tempo ×${speed}`;
      simSpeed.setAttribute('aria-label', `Tempo symulacji: ×${speed}. Zmień`);
    }
  }

  // ───────────── blokada wygaszania ekranu ─────────────

  async function acquireWakeLock(): Promise<void> {
    const api = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!api || wakeLock || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await api.request('screen');
    } catch {
      wakeLock = null; // np. oszczędzanie baterii — nawigacja działa, ekran może zgasnąć
    }
  }

  function releaseWakeLock(): void {
    void wakeLock?.release().catch(() => undefined);
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!session) return;
    // Przeglądarka sama zwalnia blokadę po ukryciu karty; po powrocie prosimy o nią ponownie.
    if (document.visibilityState === 'visible') {
      wakeLock = null;
      void acquireWakeLock();
    }
  });

  // ───────────── widok postępu ─────────────

  function renderProgress(current: Session, progress: NavProgress): void {
    const steps = current.nav.route.steps ?? [];
    const next = steps[progress.nextStepIndex];
    if (next) {
      const { lead, rest } = splitInstruction(next.text);
      const destination = store.get().to?.label;
      if (next.maneuver === 'arrive') {
        setBanner(maneuverIcon('arrive'), formatDistance(progress.distanceToNextM), 'Do celu', destination ?? '');
      } else {
        setBanner(maneuverIcon(next.maneuver), formatDistance(progress.distanceToNextM), lead, rest ? `Potem: ${rest}` : '');
      }
      map.highlightPoint(next.location);
    } else {
      setBanner(maneuverIcon('continue'), formatDistance(progress.remainingM), 'Idź wzdłuż trasy');
    }

    statTime.textContent = formatDuration(progress.remainingS);
    const eta = formatKrakowClock(new Date(Date.now() + progress.remainingS * 1000));
    statDetail.textContent = `${formatDistance(progress.remainingM)}${current.mode === 'gps' && eta ? ` · u celu ok. ${eta}` : ''}`;
    const comfort = effectiveComfort(store.get());
    if (progress.shadeAhead === null) statShade.textContent = '';
    else {
      const share = comfort === 'sun' ? 1 - progress.shadeAhead : progress.shadeAhead;
      statShade.textContent = `${formatPercent(share)} ${comfort === 'sun' ? 'słońca' : 'cienia'} przed Tobą`;
    }

    const tip = shadeHint(current.nav, progress.alongM, comfort);
    hint.hidden = tip === null;
    if (tip) {
      hint.textContent = tip.text;
      hint.classList.toggle('nav-hint--bad', tip.tone === 'bad');
      if (tip.key !== current.hintKey && tip.key.startsWith('side:')) speaker.speak(tip.text);
    }
    current.hintKey = tip?.key ?? null;
  }

  function renderArrived(): void {
    const destination = store.get().to?.label ?? '';
    setBanner(maneuverIcon('arrive'), '', 'Jesteś u celu', destination);
    statTime.textContent = 'U celu';
    statDetail.textContent = destination;
    statShade.textContent = '';
    hint.hidden = true;
    map.highlightPoint(null);
  }

  function moveCamera(current: Session, center: { lat: number; lon: number }): void {
    if (!current.following) return;
    map.follow(center, {
      bearingDeg: settings.headingUp ? current.lastBearing : 0,
      pitch: settings.headingUp ? 40 : 0,
      zoom: NAV_ZOOM,
      offsetY: settings.headingUp ? 0.16 : 0.05,
      durationMs: FOLLOW_MS,
    });
  }

  // ───────────── pozycja ─────────────

  function handleFix(fix: Fix): void {
    const current = session;
    if (!current || current.arrived) return;
    current.lastFix = fix;
    if (current.signalLost) {
      current.signalLost = false;
      hideNotice();
    }
    const now = Date.now();
    if (current.mode === 'gps' && now - current.lastLocationWrite > USER_LOCATION_INTERVAL_MS) {
      current.lastLocationWrite = now;
      store.set({ userLocation: { lat: fix.lat, lon: fix.lon } });
    }

    const snap = snapToRoute(current.nav.index, fix, current.alongM === null ? {} : { hintAlongM: current.alongM });
    if (!snap) return;
    const onRoute = snap.offsetM <= SNAP_DISPLAY_M;
    if (onRoute) current.lastBearing = snap.bearingDeg;
    else if (fix.headingDeg !== null) current.lastBearing = fix.headingDeg;
    const shown = onRoute ? { lon: snap.point[0], lat: snap.point[1] } : { lon: fix.lon, lat: fix.lat };
    map.setUserPosition({ ...shown, accuracyM: fix.accuracyM, headingDeg: fix.headingDeg ?? (onRoute ? snap.bearingDeg : null) });
    moveCamera(current, shown);

    // Zejście z trasy (tylko GPS; w symulacji pozycja zawsze leży na trasie).
    if (current.mode === 'gps' && !current.rerouting && now >= current.ignoreOffRouteUntil) {
      const result = trackOffRoute(current.strikes, snap.offsetM, fix.accuracyM);
      current.strikes = result.strikes;
      if (result.offRoute) {
        reroute(current, fix);
        return;
      }
    }
    if (current.rerouting) return;

    // Postęp rośnie tylko wtedy, gdy pozycja jest przy trasie — pojedynczy odległy odczyt go nie cofa.
    if (onRoute || current.alongM === null) current.alongM = snap.alongM;
    const progress = navProgress(current.nav, current.alongM);
    const geometry = current.nav.route.geometry;
    const end = geometry[geometry.length - 1];
    if (hasArrived(progress.remainingM, snap.offsetM, distanceM(fix, { lon: end[0], lat: end[1] }))) {
      arrive(current);
      return;
    }
    renderProgress(current, progress);

    const announcement = dueAnnouncement(current.nav.route.steps ?? [], progress, current.spoken);
    if (announcement) {
      current.spoken.add(announcement.key);
      speaker.speak(announcement.text, announcement.key.startsWith('now:'));
    }
  }

  function arrive(current: Session): void {
    current.arrived = true;
    current.source.stop();
    simSpeed.hidden = true;
    renderArrived();
    hideNotice();
    speaker.speak('Jesteś u celu.', true);
    releaseWakeLock();
  }

  function reroute(current: Session, fix: Fix): void {
    current.strikes = 0;
    if (!inServiceArea(fix)) {
      showNotice('Jesteś poza obszarem Krakowa — nie mogę poprowadzić stąd na żywo.', {
        action: { label: 'Uruchom symulację', run: () => startSource('sim') },
      });
      current.ignoreOffRouteUntil = Date.now() + 60_000;
      return;
    }
    current.rerouting = true;
    setBanner(el('span', 'spinner'), '', 'Wyznaczam nową trasę…', 'Zeszliśmy z poprzedniej trasy');
    hint.hidden = true;
    showNotice('Poza trasą — przeliczam z Twojej pozycji.');
    speaker.speak('Wyznaczam nową trasę.', true);
    app.actions.setEndpoint('from', { lat: fix.lat, lon: fix.lon, label: 'Moja lokalizacja' }, 'if-needed');
  }

  function handleSourceError(error: SourceError): void {
    if (!session || session.mode !== 'gps') return;
    const simulate = { label: 'Uruchom symulację', run: () => startSource('sim') };
    if (error === 'denied') {
      session.source.stop();
      setBanner(icon('target'), '', 'Brak pozycji GPS');
      showNotice('Brak zgody na dostęp do lokalizacji. Zezwól na nią w przeglądarce albo zobacz przejście w symulacji.', {
        action: simulate,
      });
      return;
    }
    // Brak pozycji bywa chwilowy (brama, wąska ulica) — nasłuch trwa, a komunikat znika przy następnym odczycie.
    session.signalLost = true;
    if (!session.lastFix) setBanner(icon('target'), '', 'Brak pozycji GPS');
    showNotice(
      session.lastFix
        ? 'Chwilowo brak sygnału GPS — pokazuję ostatnią znaną pozycję.'
        : 'Nie udało się ustalić pozycji. Możesz zobaczyć przejście w symulacji.',
      { action: simulate },
    );
  }

  function startSource(mode: 'gps' | 'sim'): void {
    const current = session;
    if (!current) return;
    current.source.stop();
    current.mode = mode;
    current.alongM = null;
    current.strikes = 0;
    current.arrived = false;
    current.rerouting = false;
    current.signalLost = false;
    current.lastFix = null;
    simSpeed.hidden = false;
    hideNotice();
    if (mode === 'sim') {
      const source = new SimulatedSource(() => current.nav.index);
      source.setSpeedFactor(SIM_SPEEDS[current.simSpeedIndex]);
      current.source = source;
    } else {
      current.source = new GeolocationSource();
      setBanner(icon('target'), '', 'Ustalam pozycję…', 'Wyjdź na otwartą przestrzeń, jeśli to potrwa');
    }
    syncSim();
    current.source.start(handleFix, handleSourceError);
  }

  // ───────────── start i koniec ─────────────

  function start(route: RouteResult): void {
    if (session || route.geometry.length < 2) return;
    const mode: 'gps' | 'sim' = demoRequested() || !geolocationAvailable() ? 'sim' : 'gps';
    session = {
      nav: prepareRoute(route),
      mode,
      source: { start: () => undefined, stop: () => undefined },
      alongM: null,
      strikes: 0,
      spoken: new Set(),
      following: true,
      arrived: false,
      rerouting: false,
      ignoreOffRouteUntil: 0,
      lastFix: null,
      lastBearing: 0,
      simSpeedIndex: 0,
      lastLocationWrite: 0,
      hintKey: null,
      signalLost: false,
    };
    appRoot.classList.add('app--navigating');
    overlay.hidden = false;
    recenterButton.hidden = true;
    map.setFitLocked(true);
    // Rozwinięty podpis źródeł mapy zasłaniałby dolny pasek — zwijamy go do przycisku „i” (jak po przesunięciu mapy).
    document.querySelector('#map .maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    syncToggles();
    void acquireWakeLock();
    startSource(mode);
    if (mode === 'sim' && !demoRequested()) {
      showNotice('Ta przeglądarka nie udostępnia lokalizacji — pokazuję symulację przejścia.', { autoHideMs: 6000 });
    }
    exit.focus();
  }

  function stop(): void {
    const current = session;
    if (!current) return;
    session = null;
    current.source.stop();
    speaker.cancel();
    releaseWakeLock();
    hideNotice();
    map.setUserPosition(null);
    map.highlightPoint(null);
    map.setFitLocked(false);
    appRoot.classList.remove('app--navigating');
    overlay.hidden = true;
    const state = store.get();
    map.resetCamera(state.layers.buildings3d ? 50 : 0);
    const route = selectedRoute(state);
    // Po powrocie panelu mapa zmienia rozmiar — dopasowanie widoku czeka na nowy układ.
    if (route) setTimeout(() => map.fitRoute(route, 'always'), 550);
    document.getElementById('start-navigation')?.focus();
  }

  /** Nowa trasa w trakcie nawigacji (przeliczenie po zejściu z trasy albo odświeżenie o pełnym kwadransie). */
  function handleState(state: AppState, previous: AppState): void {
    const current = session;
    if (!current) return;
    if (state.routeStatus === 'error' && previous.routeStatus !== 'error' && current.rerouting) {
      current.rerouting = false;
      current.ignoreOffRouteUntil = Date.now() + 15_000;
      showNotice(`Nie udało się wyznaczyć nowej trasy. ${state.routeError ?? ''}`.trim(), { autoHideMs: 8000 });
      return;
    }
    if (state.routeStatus !== 'ready') return;
    const route = selectedRoute(state);
    if (!route || route === current.nav.route || route.geometry.length < 2) return;
    const wasRerouting = current.rerouting;
    current.nav = prepareRoute(route);
    current.alongM = null;
    current.strikes = 0;
    current.rerouting = false;
    current.hintKey = null;
    current.ignoreOffRouteUntil = Date.now() + REROUTE_COOLDOWN_MS;
    if (wasRerouting) {
      current.spoken = new Set();
      showNotice('Nowa trasa gotowa.', { autoHideMs: 4000 });
    }
    if (current.lastFix && !current.arrived) handleFix(current.lastFix);
  }

  // ───────────── zdarzenia ─────────────

  exit.addEventListener('click', stop);
  voiceButton.addEventListener('click', () => {
    settings.voice = !settings.voice;
    speaker.setEnabled(settings.voice);
    saveSettings(settings);
    syncToggles();
    if (settings.voice) speaker.speak('Zapowiedzi głosowe włączone.');
  });
  headingButton.addEventListener('click', () => {
    settings.headingUp = !settings.headingUp;
    saveSettings(settings);
    syncToggles();
    recenter();
  });
  function recenter(): void {
    if (!session) return;
    session.following = true;
    recenterButton.hidden = true;
    const fix = session.lastFix;
    if (fix) moveCamera(session, fix);
  }
  recenterButton.addEventListener('click', recenter);
  simSpeed.addEventListener('click', () => {
    if (!session || !(session.source instanceof SimulatedSource)) return;
    session.simSpeedIndex = (session.simSpeedIndex + 1) % SIM_SPEEDS.length;
    session.source.setSpeedFactor(SIM_SPEEDS[session.simSpeedIndex]);
    syncSim();
  });
  map.onUserPan(() => {
    if (!session || !session.following) return;
    session.following = false;
    recenterButton.hidden = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && session) stop();
  });
  store.subscribe(handleState);

  app.routeList.setNavigationHandler(start);
}
