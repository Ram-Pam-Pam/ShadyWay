// PWA: rejestracja service workera (tylko w wersji produkcyjnej), praca offline z ostatnią zapisaną trasą,
// baner „Jesteś offline” i zachęta do instalacji aplikacji.

import type { App } from '../app.ts';
import { loadLastRoute } from '../offlineRoute.ts';
import type { AppState } from '../store.ts';
import { icon } from '../ui/icons.ts';
import { byId, el } from '../util.ts';

const INSTALL_DISMISSED_KEY = 'cien:install-dismissed:v1';

/** Zdarzenie Chromium poprzedzające możliwość instalacji (brak w lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function offlineBannerText(online: boolean, state: Pick<AppState, 'routeFromCache' | 'from' | 'to'>): string | null {
  if (state.routeFromCache) {
    return online
      ? 'Brak połączenia z serwerem — pokazuję ostatnią zapisaną trasę'
      : 'Jesteś offline — pokazuję ostatnią trasę';
  }
  if (online) return null;
  return 'Jesteś offline — nowe trasy wyznaczę po odzyskaniu połączenia';
}

function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = (): void => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        // Pliki z /assets/ pobrane, zanim worker przejął stronę (pierwsza wizyta), dopisujemy do jego pamięci.
        const urls = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => name.startsWith(`${window.location.origin}/assets/`));
        registration.active?.postMessage({ type: 'cache-assets', urls: [...new Set(urls)] });
      })
      .catch(() => {
        // Bez service workera aplikacja działa jak zwykła strona.
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

function installOfflineBanner(app: App): void {
  const { store } = app;
  const text = el('span');
  const banner = el('p', 'offline-banner', icon('offline'), text);
  banner.id = 'offline-banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  const mapWrap = byId<HTMLElement>('map-wrap');
  mapWrap.append(banner);

  const sync = (): void => {
    const message = offlineBannerText(navigator.onLine, store.get());
    banner.hidden = message === null;
    // Komunikaty warstw mapy o braku połączenia powtarzałyby to samo co baner.
    mapWrap.classList.toggle('map-wrap--offline', message !== null);
    text.textContent = message ?? '';
  };

  /** Bez sieci i bez wskazanych punktów przywracamy ostatnią trasę (zapytanie o nią trafi do pamięci urządzenia). */
  const restore = (): void => {
    const state = store.get();
    if (navigator.onLine || state.from || state.to) return;
    const saved = loadLastRoute();
    if (!saved) return;
    store.set({
      from: saved.from,
      to: saved.to,
      pickTarget: null,
      date: saved.date,
      minutes: saved.minutes,
      followNow: false,
      shadePreference: saved.shadePreference,
      mobility: saved.mobility,
      comfort: saved.comfort,
      viaCoolSpot: saved.viaCoolSpot,
      selectedProfile: saved.selectedProfile,
    });
  };

  window.addEventListener('offline', () => {
    restore();
    sync();
  });
  window.addEventListener('online', () => {
    sync();
    // Po odzyskaniu połączenia trasę z pamięci zastępujemy świeżo wyznaczoną.
    if (store.get().routeFromCache) app.actions.refreshRoute();
  });
  store.subscribe((state, previous) => {
    if (state.routeFromCache !== previous.routeFromCache) sync();
  });
  restore();
  sync();
}

function installPrompt(): void {
  let deferred: BeforeInstallPromptEvent | null = null;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(INSTALL_DISMISSED_KEY) === '1';
  } catch {
    dismissed = false;
  }

  const install = el('button', 'chip-button chip-button--small', 'Zainstaluj');
  install.type = 'button';
  const close = el('button', 'icon-button install-hint__close', icon('close'));
  close.type = 'button';
  close.setAttribute('aria-label', 'Ukryj zachętę do instalacji');
  const hint = el(
    'div',
    'install-hint',
    el('span', 'install-hint__mark', icon('download')),
    el(
      'p',
      'install-hint__text',
      el('strong', '', 'Zainstaluj aplikację'),
      el('span', '', 'Otwiera się jak zwykła aplikacja i pamięta ostatnią trasę bez internetu.'),
    ),
    install,
    close,
  );
  hint.id = 'install-hint';
  hint.hidden = true;
  byId<HTMLElement>('plan-panel').prepend(hint);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    hint.hidden = dismissed;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    hint.hidden = true;
  });
  install.addEventListener('click', () => {
    const prompt = deferred;
    if (!prompt) return;
    deferred = null;
    hint.hidden = true;
    void prompt
      .prompt()
      .then(() => prompt.userChoice)
      .catch(() => undefined);
  });
  close.addEventListener('click', () => {
    dismissed = true;
    hint.hidden = true;
    try {
      localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      // Bez pamięci lokalnej zachęta wróci przy następnej wizycie.
    }
  });
}

export function installPwa(app: App): void {
  installOfflineBanner(app);
  installPrompt();
  registerServiceWorker();
}
