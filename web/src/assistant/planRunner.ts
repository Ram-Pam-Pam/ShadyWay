// Wykonanie planu asystenta w aplikacji — we właściwej kolejności i z informacją zwrotną dla rozmowy:
// pola trasy → (widok „Trasa”, gdy potrzebny) → czekanie na przeliczoną trasę → wariant → warstwy / „Kiedy wyjść?”
// → nawigacja na samym końcu i tylko wtedy, gdy trasa istnieje. Pola bez odpowiednika w interfejsie
// (tryb komfortu, punkt chłodu) są pomijane po cichu. Moduł nie dotyka DOM — wszystko robi przez `PlanHost`.

import type { AssistantPlan, RouteProfile } from '../../../shared/types.ts';
import { planToPatch, type PlanPatch } from '../plan.ts';
import { selectedRoute, type AppState, type LayerToggles } from '../store.ts';
import { describePlan, type PlanResult } from './chat.ts';

export type PlanHostState = Pick<AppState, 'from' | 'to' | 'routeStatus' | 'routeError' | 'response' | 'selectedProfile' | 'layers'>;

export interface PlanHost {
  state(): PlanHostState;
  /** Ustawia start/cel/czas/profil/preferencję; aplikacja sama przelicza trasę. */
  setRouting(patch: PlanPatch): void;
  /** Spełnia się, gdy trasa nie jest już przeliczana (gotowa, błąd albo brak punktów). */
  waitForRoute(): Promise<void>;
  selectProfile(profile: RouteProfile): void;
  /** Przełącza warstwy; zwraca te, które faktycznie dało się ustawić (np. mapa ciepła bywa niedostępna). */
  setLayers(layers: Partial<LayerToggles>): Partial<LayerToggles>;
  /** Pokazuje zakładkę „Trasa” (potrzebna dla wykresu „Kiedy wyjść?”). */
  showRouteView(): Promise<void> | void;
  openDeparture(): void;
  /** Uruchamia nawigację dla zaznaczonej trasy; false, gdy się nie udało. */
  startNavigation(): Promise<boolean> | boolean;
}

export type PlanOutcome = PlanResult;

const LAYER_NAMES: Record<keyof LayerToggles, [on: string, off: string]> = {
  shadows: ['cienie włączone', 'cienie wyłączone'],
  heat: ['mapa ciepła włączona', 'mapa ciepła wyłączona'],
  buildings3d: ['budynki 3D włączone', 'budynki 3D wyłączone'],
};
const LAYER_KEYS = Object.keys(LAYER_NAMES) as (keyof LayerToggles)[];

function requestedLayers(plan: AssistantPlan): Partial<LayerToggles> {
  const layers: Partial<LayerToggles> = {};
  if (plan.layers && typeof plan.layers === 'object') {
    for (const key of LAYER_KEYS) {
      const value = plan.layers[key];
      if (typeof value === 'boolean') layers[key] = value;
    }
  }
  return layers;
}

function isProfile(value: unknown): value is RouteProfile {
  return value === 'shortest' || value === 'balanced' || value === 'shadiest';
}

/** Wykonuje plan krok po kroku. `today` (YYYY-MM-DD w Krakowie) służy tylko do zwięzłego opisu godziny. */
export async function runPlan(plan: AssistantPlan, host: PlanHost, today?: string): Promise<PlanOutcome> {
  const { selectedProfile: _later, ...routing } = planToPatch(plan, host.state());
  const routed = Object.keys(routing).length > 0;
  const profile = isProfile(plan.selectProfile) ? plan.selectProfile : null;
  const layers = requestedLayers(plan);
  const wantsDeparture = plan.openDeparture === true;
  const wantsNavigation = plan.startNavigation === true;

  const done: string[] = describePlan({ ...plan, selectProfile: undefined }, today);
  let problem: string | null = null;
  let navigating = false;

  // 1. Pola trasy — aplikacja zaczyna przeliczanie od razu.
  if (routed) host.setRouting(routing);
  // 2. Widok „Trasa”, gdy plan z niego korzysta.
  if (wantsDeparture) await host.showRouteView();
  // 3. Trasa: czekamy tylko wtedy, gdy plan jej dotyczy (same warstwy niczego nie przeliczają).
  if (routed || profile || wantsNavigation) await host.waitForRoute();

  const state = host.state();
  const hasEndpoints = state.from !== null && state.to !== null;
  const route = state.routeStatus === 'ready' ? selectedRoute(state) : null;
  if (routed && state.routeStatus === 'error') {
    problem = `Nie udało się wyznaczyć trasy. ${state.routeError ?? ''}`.trim();
  }

  // 4. Wariant trasy.
  if (profile && state.response?.routes.some((candidate) => candidate.profile === profile)) {
    host.selectProfile(profile);
    done.push(...describePlan({ selectProfile: profile }, today));
  }

  // 5. Warstwy mapy i wykres „Kiedy wyjść?”.
  if (Object.keys(layers).length > 0) {
    const before = state.layers;
    const applied = host.setLayers(layers);
    const name = (key: keyof LayerToggles): string => LAYER_NAMES[key][applied[key] ? 0 : 1];
    const set = LAYER_KEYS.filter((key) => typeof applied[key] === 'boolean');
    const changed = set.filter((key) => applied[key] !== before[key]);
    // W potwierdzeniu tylko faktyczne zmiany; gdy plan nie zmienił niczego innego — to, o co proszono.
    done.push(...(changed.length > 0 || done.length > 0 ? changed : set).map(name));
  }
  if (wantsDeparture) {
    if (hasEndpoints) {
      host.openDeparture();
      done.push('wykres „Kiedy wyjść?” otwarty');
    } else {
      problem ??= 'Wykres „Kiedy wyjść?” wymaga startu i celu.';
    }
  }

  // 6. Nawigacja — na końcu i tylko z gotową trasą.
  if (wantsNavigation) {
    if (route && (await host.startNavigation())) {
      navigating = true;
      done.push('nawigacja uruchomiona');
    } else {
      problem ??= hasEndpoints ? 'Nawigacja nie ruszyła — nie ma gotowej trasy.' : 'Nawigacja nie ruszyła — najpierw wskaż start i cel.';
    }
  }

  return { summary: done.length > 0 ? `Ustawiono: ${done.join(' · ')}` : null, problem, routed, navigating };
}

/** Kolejka planów: następny plan rusza dopiero po zakończeniu poprzedniego (strumień może przynieść kilka). */
export function createPlanQueue(host: PlanHost, today: () => string): (plan: AssistantPlan) => Promise<PlanOutcome> {
  let tail: Promise<unknown> = Promise.resolve();
  return (plan) => {
    const run = tail.then(() => runPlan(plan, host, today()));
    tail = run.catch(() => undefined);
    return run;
  };
}
