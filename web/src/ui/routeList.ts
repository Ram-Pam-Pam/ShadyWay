// Sekcja „Trasy”: stan ładowania, błędy, ostrzeżenia z serwera i zwarte karty wariantów trasy
// (nazwa, udział cienia/słońca, dystans i czas, pasek cienia). Wybrana karta ma akcje i zwijane wskazówki.

import type { RouteProfile, RouteResult, RouteStep } from '../../../shared/types.ts';
import { formatDistance, formatDuration, formatPercent } from '../format.ts';
import { comfortShare, comfortTexts, heatAdvice, routeFactsLine, type AppliedComfort } from '../labels.ts';
import { effectiveComfort, selectedRoute, type AppState } from '../store.ts';
import { byId, el } from '../util.ts';
import { icon } from './icons.ts';
import { createStepsList } from './stepsList.ts';

export interface RouteListOptions {
  onSelect(profile: RouteProfile): void;
  /** Podświetlenie miejsca kroku na mapie (null = zdejmij). */
  onHighlightStep(step: RouteStep | null, pan: boolean): void;
}

type RouteViewState = Pick<
  AppState,
  'from' | 'to' | 'routeStatus' | 'routeSlow' | 'routeError' | 'response' | 'selectedProfile'
>;

const STEPS_ID = 'route-steps';

export class RouteList {
  private readonly status = byId<HTMLElement>('route-status');
  private readonly list = byId<HTMLElement>('route-list');
  private readonly warnings = byId<HTMLElement>('route-warnings');
  private readonly options: RouteListOptions;
  /** Ostrzeżenia zamknięte przez użytkownika — nie pokazujemy ich ponownie, póki treść się nie zmieni. */
  private dismissedWarnings = '';
  private stepsOpen = false;
  private navigationHandler: ((route: RouteResult) => void) | null = null;
  private explainHandler: ((route: RouteResult) => void) | null = null;
  private lastState: RouteViewState | null = null;

  constructor(options: RouteListOptions) {
    this.options = options;
  }

  /**
   * Punkt rozszerzenia dla trybu nawigacji: po ustawieniu obsługi na karcie wybranej trasy
   * pojawia się przycisk „Nawiguj” (bez niej pozostaje ukryty).
   */
  setNavigationHandler(handler: ((route: RouteResult) => void) | null): void {
    this.navigationHandler = handler;
    if (this.lastState) this.render(this.lastState);
  }

  /** Uruchamia nawigację tak, jak przycisk „Nawiguj” (np. na polecenie asystenta); false, gdy nawigacja nie jest dostępna. */
  navigate(route: RouteResult): boolean {
    if (!this.navigationHandler) return false;
    this.navigationHandler(route);
    return true;
  }

  /** Po ustawieniu obsługi na karcie wybranej trasy pojawia się przycisk „Wyjaśnij trasę” (asystent AI). */
  setExplainHandler(handler: ((route: RouteResult) => void) | null): void {
    this.explainHandler = handler;
    if (this.lastState) this.render(this.lastState);
  }

  render(state: RouteViewState): void {
    this.lastState = state;
    const comfort = effectiveComfort(state);
    this.renderStatus(state);
    this.renderWarnings(state.response?.warnings ?? []);

    const routes = state.response?.routes ?? [];
    const selected = selectedRoute(state);
    // Karty są budowane od nowa, więc fokus klawiatury przenosimy na ten sam element nowej listy.
    const focusKey = this.focusKey();
    this.list.replaceChildren(...routes.map((route) => this.card(route, route === selected, comfort)));
    if (focusKey) this.list.querySelector<HTMLElement>(focusKey)?.focus();
    this.list.classList.toggle('routes--stale', state.routeStatus === 'loading');
    this.list.hidden = routes.length === 0;
  }

  /** Selektor elementu z fokusem wewnątrz listy (karta trasy albo przycisk akcji) — do odtworzenia po przebudowie. */
  private focusKey(): string | null {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !this.list.contains(focused)) return null;
    if (focused.dataset.profile) return `.route[data-profile="${focused.dataset.profile}"]`;
    if (focused.dataset.action) return `[data-action="${focused.dataset.action}"]`;
    return null;
  }

  private renderStatus(state: RouteViewState): void {
    if (state.routeStatus === 'loading') {
      const text = state.routeSlow ? 'Pobieram dane mapy dla tej okolicy — może to potrwać do 40 s…' : 'Wyznaczam trasę…';
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
      const text = !state.from ? 'Wskaż start (A).' : !state.to ? 'Wskaż cel (B).' : '';
      if (text) this.status.replaceChildren(el('p', 'empty', text));
      else this.status.replaceChildren();
      return;
    }
    this.status.replaceChildren();
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

  private card(route: RouteResult, selected: boolean, comfort: AppliedComfort): HTMLElement {
    const share = formatPercent(comfortShare(route.shadeFraction, comfort));

    // Pasek zawsze pokazuje cień po lewej (indygo) i słońce po prawej (bursztyn).
    const bar = el('div', 'shadebar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('div', 'shadebar__shade');
    fill.style.width = formatPercent(route.shadeFraction);
    bar.append(fill);

    const button = el(
      'button',
      'route',
      el(
        'div',
        'route__head',
        el(
          'span',
          'route__main',
          el('span', 'route__label', route.label),
          el('span', 'route__meta', `${formatDistance(route.distanceM)} · ${formatDuration(route.durationS)}`),
        ),
        el('span', 'route__shade', el('strong', '', share), ` ${comfortTexts(comfort).shareSuffix}`),
      ),
      bar,
    );
    button.type = 'button';
    button.dataset.profile = route.profile;
    button.setAttribute('aria-pressed', String(selected));
    button.addEventListener('click', () => this.options.onSelect(route.profile));

    return el('li', selected ? 'route-item route-item--selected' : 'route-item', button, selected && this.detail(route));
  }

  /** Rozwinięcie wybranej karty: krótka linia faktów, akcje („Nawiguj”, „Wskazówki”, „Wyjaśnij”) i lista kroków. */
  private detail(route: RouteResult): HTMLElement | null {
    const steps = route.steps ?? [];
    const facts = routeFactsLine(route);
    const heat = heatAdvice(route.thermal);

    const start = el('button', 'action-button', icon('nav'), el('span', '', 'Nawiguj'));
    start.type = 'button';
    start.id = 'start-navigation';
    start.dataset.action = 'navigate';
    start.hidden = this.navigationHandler === null;
    start.addEventListener('click', () => this.navigationHandler?.(route));

    const list = steps.length > 0 ? createStepsList(steps, (step, pan) => this.options.onHighlightStep(step, pan)) : null;
    if (list) {
      list.id = STEPS_ID;
      list.hidden = !this.stepsOpen;
    }
    const toggle = el('button', 'action-button action-button--ghost', icon('list'), el('span', '', 'Wskazówki'));
    toggle.type = 'button';
    toggle.dataset.action = 'steps';
    toggle.hidden = list === null;
    toggle.setAttribute('aria-controls', STEPS_ID);
    toggle.setAttribute('aria-expanded', String(this.stepsOpen));
    toggle.addEventListener('click', () => {
      if (!list) return;
      this.stepsOpen = !this.stepsOpen;
      list.hidden = !this.stepsOpen;
      toggle.setAttribute('aria-expanded', String(this.stepsOpen));
      if (!this.stepsOpen) this.options.onHighlightStep(null, false);
    });

    const explain = el('button', 'action-button action-button--ghost action-button--icon', icon('sparkle'));
    explain.type = 'button';
    explain.id = 'explain-route';
    explain.dataset.action = 'explain';
    explain.title = 'Wyjaśnij trasę';
    explain.setAttribute('aria-label', 'Wyjaśnij trasę');
    explain.hidden = this.explainHandler === null;
    explain.addEventListener('click', () => this.explainHandler?.(route));

    if (!facts && !heat && start.hidden && toggle.hidden && explain.hidden) return null;
    return el(
      'div',
      'route__detail',
      heat ? el('p', 'route__heat', heat) : null,
      facts ? el('p', 'route__facts', facts) : null,
      el('div', 'route__actions', start, toggle, explain),
      list,
    );
  }
}
