// Czysta logika rozmowy z asystentem: historia wysyłana do serwera, kontekst aplikacji,
// podpowiedzi pytań, opis zastosowanego planu i dane trasy dołączane do pytania „Wyjaśnij tę trasę”.

import type {
  AssistantContext,
  AssistantMessage,
  AssistantPlan,
  RouteResult,
} from '../../../shared/types.ts';
import { formatDistance, formatDuration, formatPercent } from '../format.ts';
import { COMFORT_CHOICES, MOBILITY_CHOICES, coolSpotTitle, preferenceLabel, stressLabel, thermalText } from '../labels.ts';
import type { AppState } from '../store.ts';
import { formatClock, formatLongDate, instantToWallTime, wallTimeToIso } from '../time.ts';

/** Tyle ostatnich wiadomości trafia do serwera (serwer i tak przycina historię po swojej stronie). */
export const HISTORY_LIMIT = 16;
/** Limit znaków jednej wiadomości po stronie serwera (z zapasem). */
export const MESSAGE_CHAR_LIMIT = 3800;
/** Treść zastępcza dla odpowiedzi asystenta, która składała się wyłącznie z planu. */
export const PLAN_ONLY_PLACEHOLDER = '(Zastosowałem plan na mapie.)';

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
  'from' | 'to' | 'date' | 'minutes' | 'shadePreference' | 'mobility' | 'comfort' | 'userLocation'
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
    comfort: state.comfort,
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
    { label: 'Gdzie po drodze napiję się wody?', prompt: 'Gdzie po drodze napiję się wody?' },
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
  if (route.via) lines.push(`Trasa prowadzi przez punkt chłodu: ${coolSpotTitle(route.via)}.`);
  if (route.coolSpots?.length) {
    lines.push(`Punkty chłodu przy trasie: ${route.coolSpots.slice(0, 6).map(coolSpotTitle).join(', ')}.`);
  }
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

/** Lista zmian z planu, po polsku — pokazywana przy potwierdzeniu „Zastosowano na mapie”. */
export function describePlan(plan: AssistantPlan): string[] {
  const parts: string[] = [];
  if (plan.from && plan.to) parts.push(`${plan.from.label} → ${plan.to.label}`);
  else if (plan.from) parts.push(`start: ${plan.from.label}`);
  else if (plan.to) parts.push(`cel: ${plan.to.label}`);
  if (plan.time) {
    const instant = new Date(plan.time);
    if (!Number.isNaN(instant.getTime())) {
      const wall = instantToWallTime(instant);
      parts.push(`wyjście ${formatLongDate(wall.date)}, ${formatClock(wall.minutes)}`);
    }
  }
  if (plan.mobility) parts.push(`profil: ${choiceLabel(MOBILITY_CHOICES, plan.mobility).toLocaleLowerCase('pl-PL')}`);
  if (plan.comfort) parts.push(`tryb: ${choiceLabel(COMFORT_CHOICES, plan.comfort).toLocaleLowerCase('pl-PL')}`);
  if (typeof plan.shadePreference === 'number' && Number.isFinite(plan.shadePreference)) {
    parts.push(`preferencja: ${preferenceLabel(Math.min(1, Math.max(0, plan.shadePreference)), plan.comfort === 'sun' ? 'sun' : 'shade')}`);
  }
  if (plan.viaCoolSpot === true) parts.push('przez punkt chłodu');
  if (plan.viaCoolSpot === false) parts.push('bez punktu chłodu');
  if (plan.selectProfile && PROFILE_LABELS[plan.selectProfile]) parts.push(`wariant ${PROFILE_LABELS[plan.selectProfile]}`);
  return parts;
}
