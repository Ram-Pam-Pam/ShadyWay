// Czysta logika rozmowy z asystentem: historia wysyłana do serwera, kontekst aplikacji,
// podpowiedzi pytań, opis zastosowanego planu i dane trasy dołączane do pytania „Wyjaśnij tę trasę”.

import type {
  AssistantContext,
  AssistantMessage,
  AssistantPlan,
  RouteResult,
} from '../../../shared/types.ts';
import { formatDistance, formatDuration, formatPercent } from '../format.ts';
import { MOBILITY_CHOICES, preferenceLabel, stressLabel, thermalText } from '../labels.ts';
import { inServiceArea } from '../plan.ts';
import type { AppState } from '../store.ts';
import { formatClock, instantToWallTime, nowWallTime, wallTimeToIso } from '../time.ts';

/** Tyle ostatnich wiadomości trafia do serwera (serwer i tak przycina historię po swojej stronie). */
export const HISTORY_LIMIT = 16;
/** Limit znaków jednej wiadomości po stronie serwera (z zapasem). */
export const MESSAGE_CHAR_LIMIT = 3800;
/** Treść zastępcza dla odpowiedzi asystenta, która składała się wyłącznie z planu. */
export const PLAN_ONLY_PLACEHOLDER = '(Zastosowałem plan na mapie.)';

/** Wynik wykonania planu w aplikacji (patrz planRunner.ts). */
export interface PlanResult {
  /** Jedna zwarta linia, np. „Ustawiono: AGH → Wawel, 15:00 · nawigacja uruchomiona”; null = nic do pokazania. */
  summary: string | null;
  /** Co się nie udało (krótko, po polsku) albo null. */
  problem: string | null;
  /** Czy plan ustawiał trasę (wtedy rozmowa proponuje „Pokaż trasę”). */
  routed: boolean;
  navigating: boolean;
}

export type ChatStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  /** Tekst pokazywany w rozmowie. */
  text: string;
  /** Treść wysyłana do serwera, gdy różni się od pokazywanej (np. pytanie z dołączonymi danymi trasy). */
  apiText?: string;
  /** Krótka adnotacja pod wiadomością użytkownika (np. „Dołączono dane wybranej trasy”). */
  note?: string;
  tools: string[];
  plans: AssistantPlan[];
  /** Wynik wykonania kolejnych planów (równolegle do `plans`); brak wpisu = plan jeszcze się wykonuje. */
  planResults?: (PlanResult | undefined)[];
  status: ChatStatus;
  error?: string;
}

/**
 * Historia w kształcie API: ostatnie `limit` wiadomości, zaczynające się od użytkownika, bez pustych treści
 * i bez odpowiedzi zakończonych błędem; sąsiednie wiadomości tej samej roli są łączone.
 */
export function buildRequestMessages(history: readonly ChatMessage[], limit: number = HISTORY_LIMIT): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  for (const message of history) {
    let content = (message.apiText ?? message.text).trim();
    if (message.role === 'assistant') {
      if (message.status === 'streaming') continue;
      if (!content && message.plans.length > 0) content = PLAN_ONLY_PLACEHOLDER;
    }
    if (!content) continue;
    content = content.slice(0, MESSAGE_CHAR_LIMIT);
    const last = messages[messages.length - 1];
    if (last && last.role === message.role) last.content = `${last.content}\n\n${content}`.slice(0, MESSAGE_CHAR_LIMIT);
    else messages.push({ role: message.role, content });
  }
  let recent = messages.slice(-Math.max(1, limit));
  while (recent.length > 0 && recent[0].role !== 'user') recent = recent.slice(1);
  return recent;
}

type ContextState = Pick<
  AppState,
  'from' | 'to' | 'date' | 'minutes' | 'shadePreference' | 'mobility' | 'userLocation'
>;

export function buildContext(state: ContextState): AssistantContext {
  const place = (value: ContextState['from']): AssistantContext['from'] =>
    value ? { lat: value.lat, lon: value.lon, label: value.label } : null;
  return {
    from: place(state.from),
    to: place(state.to),
    time: wallTimeToIso(state.date, state.minutes),
    shadePreference: state.shadePreference,
    mobility: state.mobility,
    // Interfejs nie ma wyboru trybu — serwer sam rozstrzyga cień/słońce.
    comfort: 'auto',
    userLocation: state.userLocation ? { lat: state.userLocation.lat, lon: state.userLocation.lon } : null,
  };
}

export interface Suggestion {
  /** Tekst na przycisku. */
  label: string;
  /** Treść pytania; `null` = wymaga wybranej trasy i idzie przez akcję „Wyjaśnij tę trasę”. */
  prompt: string | null;
}

export const EXPLAIN_QUESTION = 'Wyjaśnij tę trasę';

export function suggestions(state: Pick<AppState, 'from' | 'to'>, hasRoute: boolean, comfort: 'shade' | 'sun'): Suggestion[] {
  const where = comfort === 'sun' ? 'w słońcu' : 'w cieniu';
  const plan =
    state.from && state.to
      ? `Zaplanuj spacer ${where} z: ${state.from.label} do: ${state.to.label}`
      : `Zaplanuj spacer ${where} z Rynku Głównego na Wawel`;
  const list: Suggestion[] = [
    { label: plan, prompt: plan },
    { label: 'Kiedy najlepiej wyjść?', prompt: 'Kiedy najlepiej wyjść, żeby było jak najprzyjemniej?' },
  ];
  if (hasRoute) list.push({ label: EXPLAIN_QUESTION, prompt: null });
  return list;
}

/** Dane wybranej trasy dopisywane do pytania „Wyjaśnij tę trasę” (asystent nie widzi mapy). */
export function routeBrief(route: RouteResult, comfort: 'shade' | 'sun'): string {
  const lines: string[] = [
    `Wariant: ${route.label} (${route.profile}).`,
    `Dystans ${formatDistance(route.distanceM)}, czas ${formatDuration(route.durationS)}, w cieniu ${formatPercent(route.shadeFraction)} trasy, w słońcu ${formatDistance(route.sunDistanceM)}.`,
    `Tryb: ${comfort === 'sun' ? 'szukam słońca' : 'szukam cienia'}.`,
  ];
  const thermal = thermalText(route.thermal);
  const stress = stressLabel(route.thermal?.stress);
  if (thermal || stress) lines.push(`Komfort cieplny: ${[stress, thermal].filter(Boolean).join('; ')}.`);
  if (route.signalCrossings > 0) {
    lines.push(`Przejścia ze światłami: ${route.signalCrossings}, szacowane czekanie ${formatDuration(route.waitS)}.`);
  }
  lines.push(`Schody: ${route.stairsCount > 0 ? route.stairsCount : 'brak'}.`);
  const steps = (route.steps ?? []).slice(0, 14).map((step, index) => `${index + 1}. ${step.text}`);
  if (steps.length > 0) lines.push('Wskazówki:', ...steps);
  return lines.join('\n');
}

export function explainPrompt(route: RouteResult, comfort: 'shade' | 'sun'): string {
  return `${EXPLAIN_QUESTION}: dlaczego biegnie właśnie tak, gdzie jest cień, a gdzie słońce, i na co uważać.\n\nDane wybranej trasy z aplikacji:\n${routeBrief(route, comfort)}`.slice(
    0,
    MESSAGE_CHAR_LIMIT,
  );
}

function choiceLabel<T extends string>(choices: ReadonlyArray<{ value: T; label: string }>, value: T): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

const PROFILE_LABELS: Record<NonNullable<AssistantPlan['selectProfile']>, string> = {
  shortest: 'najkrótszy',
  balanced: 'zbalansowany',
  shadiest: 'najbardziej zacieniony',
};

/** „15:00” dla dzisiejszej daty, „jutro 15:00” albo „15.07, 18:30” dla innych dni. */
function shortTime(date: string, minutes: number, today: string): string {
  const clock = formatClock(minutes);
  if (date === today) return clock;
  const [year, month, day] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  if (date === tomorrow) return `jutro ${clock}`;
  return `${date.slice(8, 10)}.${date.slice(5, 7)}, ${clock}`;
}

/**
 * Zwięzła lista zmian z planu, po polsku — składa się na linię potwierdzenia w rozmowie
 * („Ustawiono: AGH → Wawel, 15:00 · bez schodów”). Pola, których aplikacja nie zastosuje, są pomijane.
 */
export function describePlan(plan: AssistantPlan, today: string = nowWallTime().date): string[] {
  const parts: string[] = [];
  const from = plan.from && inServiceArea(plan.from) ? plan.from : null;
  const to = plan.to && inServiceArea(plan.to) ? plan.to : null;
  let where = '';
  if (from && to) where = `${from.label} → ${to.label}`;
  else if (from) where = `start: ${from.label}`;
  else if (to) where = `cel: ${to.label}`;
  let when = '';
  if (plan.time) {
    const instant = new Date(plan.time);
    if (!Number.isNaN(instant.getTime())) {
      const wall = instantToWallTime(instant);
      when = shortTime(wall.date, wall.minutes, today);
    }
  }
  if (where) parts.push(when ? `${where}, ${when}` : where);
  else if (when) parts.push(`wyjście ${when}`);
  if (plan.mobility && MOBILITY_CHOICES.some((choice) => choice.value === plan.mobility)) {
    parts.push(choiceLabel(MOBILITY_CHOICES, plan.mobility).toLocaleLowerCase('pl-PL'));
  }
  if (typeof plan.shadePreference === 'number' && Number.isFinite(plan.shadePreference)) {
    parts.push(preferenceLabel(Math.min(1, Math.max(0, plan.shadePreference)), 'shade'));
  }
  if (plan.selectProfile && PROFILE_LABELS[plan.selectProfile]) parts.push(`wariant ${PROFILE_LABELS[plan.selectProfile]}`);
  return parts;
}
