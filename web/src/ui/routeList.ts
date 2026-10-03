// Sekcja „Trasy”: stan ładowania, błędy, ostrzeżenia z serwera, karty wariantów trasy
// (udział cienia/słońca, komfort cieplny, światła, schody, punkt chłodu), wskazówki i plakietki jakości danych.

import type { RouteProfile, RouteResult, RouteStep } from '../../../shared/types.ts';
import {
  cssGradient,
  formatDistance,
  formatDuration,
  formatPercent,
  formatTemperature,
  routeColorScale,
} from '../format.ts';
import {
  adverseDistanceM,
  comfortShare,
  comfortTexts,
  coolSpotTitle,
  qualityBadges,
  signalsText,
  stairsText,
  stressLabel,
  thermalText,
  type AppliedComfort,
} from '../labels.ts';
import { effectiveComfort, selectedRoute, type AppState } from '../store.ts';
import { byId, el, queryIn } from '../util.ts';
import { icon, type IconName } from './icons.ts';
import { createStepsList } from './stepsList.ts';

export interface RouteListOptions {
  onSelect(profile: RouteProfile): void;
  /** Podświetlenie miejsca kroku na mapie (null = zdejmij). */
  onHighlightStep(step: RouteStep | null, pan: boolean): void;
}

type RouteViewState = Pick<
  AppState,
  'from' | 'to' | 'routeStatus' | 'routeSlow' | 'routeError' | 'response' | 'selectedProfile' | 'comfort'
>;

function stat(label: string, value: string): HTMLElement {
  return el('div', 'route__stat', el('dt', '', label), el('dd', '', value));
}

function fact(iconName: IconName, text: string, className = ''): HTMLElement {
  return el('li', `fact ${className}`.trim(), icon(iconName), el('span', '', text));
}

export class RouteList {
  private readonly status = byId<HTMLElement>('route-status');
  private readonly list = byId<HTMLElement>('route-list');
  private readonly warnings = byId<HTMLElement>('route-warnings');
  private readonly legend = byId<HTMLElement>('route-legend');
  private readonly legendBar = queryIn<HTMLElement>(this.legend, '.legend__bar');
  private readonly quality = byId<HTMLElement>('route-quality');
  private readonly options: RouteListOptions;
  /** Ostrzeżenia zamknięte przez użytkownika — nie pokazujemy ich ponownie, póki treść się nie zmieni. */
  private dismissedWarnings = '';
  private stepsOpen = false;
  private openBadge: string | null = null;
  private navigationHandler: ((route: RouteResult) => void) | null = null;
  private explainHandler: ((route: RouteResult) => void) | null = null;
  private lastState: RouteViewState | null = null;

  constructor(options: RouteListOptions) {
    this.options = options;
  }

  /**
   * Punkt rozszerzenia dla trybu nawigacji: po ustawieniu obsługi na karcie wybranej trasy
   * pojawia się przycisk „Rozpocznij nawigację” (bez niej pozostaje ukryty).
   */
  setNavigationHandler(handler: ((route: RouteResult) => void) | null): void {
    this.navigationHandler = handler;
    if (this.lastState) this.render(this.lastState);
  }

  /** Po ustawieniu obsługi na karcie wybranej trasy pojawia się przycisk „Wyjaśnij trasę” (asystent AI). */
  setExplainHandler(handler: ((route: RouteResult) => void) | null): void {
    this.explainHandler = handler;
    if (this.lastState) this.render(this.lastState);
  }

  render(state: RouteViewState): void {
    this.lastState = state;
    const comfort = effectiveComfort(state);
    this.renderStatus(state, comfort);
    this.renderWarnings(state.response?.warnings ?? []);

    const routes = state.response?.routes ?? [];
    const selected = selectedRoute(state);
    // Karty są budowane od nowa, więc fokus klawiatury przenosimy na kartę tego samego profilu.
    const focused = document.activeElement;
    const focusedProfile =
      focused instanceof HTMLElement && focused.classList.contains('route') && this.list.contains(focused)
        ? focused.dataset.profile
        : undefined;
    const showLst = comfort !== 'sun' && state.response?.sun.isDay === true;
    this.list.replaceChildren(...routes.map((route) => this.card(route, route === selected, comfort, showLst)));
    if (focusedProfile) {
      this.list.querySelector<HTMLElement>(`.route[data-profile="${focusedProfile}"]`)?.focus();
    }
    this.list.classList.toggle('routes--stale', state.routeStatus === 'loading');
    this.list.hidden = routes.length === 0;
    this.legend.hidden = routes.length === 0;
    this.legendBar.style.background = cssGradient(routeColorScale(comfort).map(([, color]) => color));
    this.renderQuality(routes.length > 0 ? state.response : null);
  }

  private renderStatus(state: RouteViewState, comfort: AppliedComfort): void {
    if (state.routeStatus === 'loading') {
      const text = state.routeSlow
        ? 'Pobieram dane OpenStreetMap dla tej okolicy… Pierwsze wyznaczenie trasy w nowym miejscu może potrwać do 40 sekund; jeśli dane nie zdążą się pobrać, poprosimy o ponowienie.'
        : 'Wyznaczam trasę…';
      this.status.replaceChildren(el('div', 'status status--loading', el('span', 'spinner'), el('p', '', text)));
      return;
    }
    if (state.routeStatus === 'error') {
      const notice = el('p', 'notice notice--error', state.routeError ?? 'Nie udało się wyznaczyć trasy.');
      notice.setAttribute('role', 'alert');
      this.status.replaceChildren(notice);
      return;
    }
    if (state.routeStatus === 'idle') {
      this.status.replaceChildren(this.emptyState(state, comfort));
      return;
    }
    this.status.replaceChildren();
  }

  private emptyState(state: RouteViewState, comfort: AppliedComfort): HTMLElement {
    const steps = el(
      'ol',
      'empty__steps',
      el('li', state.from ? 'is-done' : '', 'Wskaż start (A) — wpisz adres, kliknij mapę albo użyj swojej lokalizacji.'),
      el('li', state.to ? 'is-done' : '', 'Wskaż cel (B) w ten sam sposób.'),
      el(
        'li',
        '',
        comfort === 'sun'
          ? 'Wybierz godzinę wyjścia i to, jak bardzo zależy Ci na słońcu.'
          : 'Wybierz godzinę wyjścia i to, jak bardzo zależy Ci na cieniu.',
      ),
    );
    return el('div', 'empty', el('p', 'empty__lead', comfortTexts(comfort).emptyLead), steps);
  }

  private renderWarnings(warnings: string[]): void {
    const key = warnings.join('\n');
    if (warnings.length === 0 || key === this.dismissedWarnings) {
      this.warnings.replaceChildren();
      return;
    }
    const close = el('button', 'icon-button notice__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Zamknij komunikat');
    close.textContent = '×';
    close.addEventListener('click', () => {
      this.dismissedWarnings = key;
      this.warnings.replaceChildren();
    });
    const body = el('div', 'notice__body', ...warnings.map((warning) => el('p', '', warning)));
    const notice = el('div', 'notice notice--warning', body, close);
    notice.setAttribute('role', 'status');
    this.warnings.replaceChildren(notice);
  }

  /** Plakietki źródła wysokości i sezonu liści; kliknięcie rozwija wyjaśnienie (na telefonie nie ma podpowiedzi). */
  private renderQuality(response: RouteViewState['response']): void {
    const badges = qualityBadges(response);
    this.quality.hidden = badges.length === 0;
    if (badges.length === 0) {
      this.quality.replaceChildren();
      return;
    }
    const note = el('p', 'quality__note');
    note.id = 'route-quality-note';
    const open = badges.find((badge) => badge.id === this.openBadge) ?? null;
    note.hidden = open === null;
    note.textContent = open?.detail ?? '';

    const buttons = badges.map((badge) => {
      const button = el(
        'button',
        `badge badge--${badge.tone}`,
        icon(badge.id === 'leaf' ? 'leaf' : 'height'),
        el('span', '', badge.label),
      );
      button.type = 'button';
      button.title = badge.detail;
      button.setAttribute('aria-expanded', String(open === badge));
      button.setAttribute('aria-controls', note.id);
      button.addEventListener('click', () => {
        this.openBadge = this.openBadge === badge.id ? null : badge.id;
        this.renderQuality(response);
        this.quality.querySelector<HTMLElement>(`[data-badge="${badge.id}"]`)?.focus();
      });
      button.dataset.badge = badge.id;
      return button;
    });
    this.quality.replaceChildren(el('div', 'quality__badges', ...buttons), note);
  }

  private card(route: RouteResult, selected: boolean, comfort: AppliedComfort, showLst: boolean): HTMLElement {
    const texts = comfortTexts(comfort);
    const share = formatPercent(comfortShare(route.shadeFraction, comfort));

    // Pasek zawsze pokazuje cień po lewej (indygo) i słońce po prawej (bursztyn).
    const bar = el('div', 'shadebar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('div', 'shadebar__shade');
    fill.style.width = formatPercent(route.shadeFraction);
    bar.append(fill);

    const stats = el(
      'dl',
      'route__stats',
      stat('Dystans', formatDistance(route.distanceM)),
      stat('Czas', formatDuration(route.durationS)),
      stat(texts.adverseLabel, formatDistance(adverseDistanceM(route, comfort))),
      // LST pochodzi z letnich scen satelitarnych (przedpołudnie) — w nocy i w trybie zimowym wprowadzałaby w błąd.
      showLst && route.meanLstC !== null && stat('Nagrzanie okolicy latem (satelita)', formatTemperature(route.meanLstC)),
    );

    const button = el(
      'button',
      'route',
      el(
        'div',
        'route__head',
        el('span', 'route__label', route.label),
        el('span', 'route__shade', el('strong', '', share), ` ${texts.shareSuffix}`),
      ),
      bar,
      stats,
      this.facts(route),
    );
    button.type = 'button';
    button.dataset.profile = route.profile;
    button.setAttribute('aria-pressed', String(selected));
    button.addEventListener('click', () => this.options.onSelect(route.profile));

    return el('li', 'route-item', button, selected && this.detail(route));
  }

  /** Komfort cieplny, światła, schody i punkt chłodu — tylko to, co serwer faktycznie podał. */
  private facts(route: RouteResult): HTMLElement | null {
    const items: HTMLElement[] = [];
    const stress = route.thermal?.stress ?? null;
    const label = stressLabel(stress);
    if (label && stress) items.push(el('li', `fact fact--stress stress--${stress}`, el('span', 'stress__dot'), el('span', '', label)));
    const thermal = thermalText(route.thermal);
    if (thermal) items.push(fact('thermo', thermal));
    const signals = signalsText(route.signalCrossings, route.waitS);
    if (signals) items.push(fact('signal', signals));
    const stairs = stairsText(route.stairsCount);
    if (stairs) items.push(fact('stairs', stairs));
    if (route.via) items.push(fact('drinking_water', `Przez: ${coolSpotTitle(route.via)}`, 'fact--via'));
    if (items.length === 0) return null;
    const list = el('ul', 'route__facts', ...items);
    list.setAttribute('aria-label', 'Szczegóły trasy');
    return list;
  }

  /** Rozwinięcie pod wybraną kartą: akcje (nawigacja) i lista wskazówek. */
  private detail(route: RouteResult): HTMLElement | null {
    const steps = route.steps ?? [];
    const start = el('button', 'action-button', icon('nav'), el('span', '', 'Rozpocznij nawigację'));
    start.type = 'button';
    start.id = 'start-navigation';
    start.hidden = this.navigationHandler === null;
    start.addEventListener('click', () => this.navigationHandler?.(route));

    const explain = el('button', 'action-button action-button--ghost', icon('sparkle'), el('span', '', 'Wyjaśnij trasę'));
    explain.type = 'button';
    explain.id = 'explain-route';
    explain.hidden = this.explainHandler === null;
    explain.addEventListener('click', () => this.explainHandler?.(route));

    if (steps.length === 0 && start.hidden && explain.hidden) return null;
    return el(
      'div',
      'route__detail',
      el('div', 'route__actions', start, explain),
      steps.length > 0 &&
        createStepsList(steps, this.stepsOpen, {
          onHighlight: (step, pan) => this.options.onHighlightStep(step, pan),
          onToggle: (open) => {
            this.stepsOpen = open;
          },
        }),
    );
  }
}
