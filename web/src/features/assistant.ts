// „Asystent FRIGUS”: czat z asystentem AI w zakładce panelu (na telefonie — arkusz na całą wysokość).
// Odpowiedź przychodzi strumieniem zdarzeń (tekst, czynności, plan); plan wykonuje w aplikacji assistant/planRunner.ts.
// Z asystentem można pisać albo rozmawiać głosem (features/assistantVoice.ts).

import type { AssistantEvent, AssistantMessage, AssistantStatus, RouteResult } from '../../../shared/types.ts';
import { ApiRequestError, errorMessage, fetchAssistantStatus, isAbortError, streamAssistant } from '../api.ts';
import type { App } from '../app.ts';
import {
  EXPLAIN_QUESTION,
  MESSAGE_CHAR_LIMIT,
  buildContext,
  buildRequestMessages,
  explainPrompt,
  suggestions,
  type ChatMessage,
  type PlanResult,
} from '../assistant/chat.ts';
import { renderMarkdown } from '../assistant/markdown.ts';
import { createPlanQueue, type PlanHost } from '../assistant/planRunner.ts';
import { effectiveComfort, selectedRoute } from '../store.ts';
import { icon, type IconName } from '../ui/icons.ts';
import { nowWallTime } from '../time.ts';
import { byId, el } from '../util.ts';
import { installAssistantVoice } from './assistantVoice.ts';

/** Najdłużej tyle czekamy na przeliczenie trasy (serwer bywa wolny, gdy dociąga dane mapy) i na koniec odpowiedzi. */
const ROUTE_WAIT_MS = 75_000;
const REPLY_WAIT_MS = 45_000;

type Availability = { state: 'checking' } | { state: 'ready'; status: AssistantStatus } | { state: 'failed'; reason: string };

function iconButton(name: IconName, label: string, className: string): HTMLButtonElement {
  const button = el('button', className, icon(name));
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

export interface AssistantHandle {
  /** Otwiera panel asystenta (zakładka + rozwinięty arkusz). */
  open(): void;
}

export function installAssistant(app: App): AssistantHandle {
  const { store, tabs, sheet } = app;
  const root = byId<HTMLElement>('assistant-panel');
  const panel = byId<HTMLElement>('panel');
  root.classList.add('assistant');

  let availability: Availability = { state: 'checking' };
  const history: ChatMessage[] = [];
  const elements = new Map<number, HTMLElement>();
  let nextId = 1;
  let request: AbortController | null = null;
  let renderQueued = false;

  // ───────────── szkielet ─────────────

  const subtitle = el('p', 'assistant__sub', 'Zapytaj o trasę, cień albo pogodę');
  const reset = el('button', 'chip-button chip-button--small', icon('plus'), el('span', '', 'Nowa rozmowa'));
  reset.type = 'button';
  reset.hidden = true;
  const title = el('h2', 'assistant__title', 'Asystent FRIGUS');
  title.id = 'assistant-title';
  const head = el('header', 'assistant__head', el('span', 'assistant__mark', icon('sparkle')), el('div', 'assistant__heading', title, subtitle), reset);

  const log = el('div', 'assistant__log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', 'Rozmowa z asystentem');
  log.tabIndex = 0;

  const input = el('textarea', 'assistant__input');
  input.id = 'assistant-input';
  input.rows = 1;
  input.maxLength = MESSAGE_CHAR_LIMIT;
  const placeholder = 'Dokąd idziesz?';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', 'Wiadomość do asystenta');
  input.setAttribute('enterkeyhint', 'send');

  const speakerButton = iconButton('mute', 'Czytaj odpowiedzi na głos', 'icon-button assistant__speaker');
  const mic = iconButton('mic', 'Powiedz to na głos', 'icon-button assistant__mic');
  const submit = iconButton('send', 'Wyślij', 'assistant__send');
  submit.type = 'submit';
  const stop = iconButton('stop', 'Zatrzymaj odpowiedź', 'assistant__send assistant__send--stop');
  stop.hidden = true;

  const voiceNote = el('p', 'assistant__note');
  voiceNote.setAttribute('role', 'status');
  voiceNote.hidden = true;
  const composer = el('form', 'assistant__composer', input, speakerButton, mic, submit, stop);
  const disclaimer = el('p', 'assistant__disclaimer', 'Asystent AI może się mylić — przed wyjściem sprawdź trasę na mapie.');
  const footer = el('div', 'assistant__footer', voiceNote, composer, disclaimer);

  root.replaceChildren(head, log, footer);

  const fab = el('button', 'assistant-fab', icon('sparkle'), el('span', 'assistant-fab__label', 'Asystent'));
  fab.type = 'button';
  fab.id = 'assistant-fab';
  fab.setAttribute('aria-label', 'Otwórz Asystenta FRIGUS');
  byId<HTMLElement>('map-wrap').append(fab);

  // ───────────── widok ─────────────

  const busy = (): boolean => request !== null;
  const isAvailable = (): boolean => availability.state === 'ready' && availability.status.available;

  function nearBottom(): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }

  function scrollToEnd(): void {
    log.scrollTop = log.scrollHeight;
  }

  function syncControls(): void {
    const available = isAvailable();
    footer.hidden = !available;
    reset.hidden = history.length === 0;
    // „Zatrzymaj” przerywa odpowiedź, a po jej zakończeniu — czytanie na głos.
    const stoppable = busy() || voice.state().phase === 'speaking';
    submit.hidden = stoppable;
    stop.hidden = !stoppable;
    submit.disabled = input.value.trim() === '';
    if (availability.state === 'ready' && availability.status.available && availability.status.model) {
      subtitle.textContent = `Zapytaj o trasę, cień albo pogodę · ${availability.status.model}`;
    }
  }

  function autosize(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }

  function unavailableView(reason: string, checking: boolean): HTMLElement {
    if (checking) {
      return el('div', 'status status--loading', el('span', 'spinner'), el('p', '', 'Łączę z asystentem…'));
    }
    const retry = el('button', 'chip-button', icon('retry'), el('span', '', 'Sprawdź ponownie'));
    retry.type = 'button';
    retry.addEventListener('click', () => void checkStatus());
    return el(
      'div',
      'assistant__unavailable',
      el('span', 'assistant__unavailable-mark', icon('sparkle')),
      el('h3', '', 'Asystent jest teraz niedostępny'),
      el('p', 'assistant__reason', reason),
      el('p', '', 'Planowanie tras działa bez asystenta — wszystko ustawisz w zakładce „Trasa”.'),
      retry,
    );
  }

  function emptyView(): HTMLElement {
    const state = store.get();
    const route = selectedRoute(state);
    const chips = suggestions(state, route !== null, effectiveComfort(state)).map((suggestion) => {
      const chip = el('button', 'suggestion', icon('sparkle'), el('span', '', suggestion.label));
      chip.type = 'button';
      chip.addEventListener('click', () => {
        if (suggestion.prompt !== null) send(suggestion.prompt);
        else explainSelected();
      });
      return chip;
    });
    return el(
      'div',
      'assistant__empty',
      el('p', 'assistant__lead', 'Cześć! Powiedz, dokąd idziesz, a zaplanuję przejście chłodniejszą stroną ulicy i ustawię je na mapie.'),
      el('div', 'assistant__suggestions', ...chips),
    );
  }

  /** Jedna zwarta linia potwierdzenia planu („Ustawiono: AGH → Wawel, 15:00 · nawigacja uruchomiona”). */
  function planView(result: PlanResult | undefined): HTMLElement | null {
    if (!result) {
      return el('div', 'plan-applied plan-applied--pending', el('span', 'spinner spinner--small'), el('span', 'plan-applied__text', 'Ustawiam w aplikacji…'));
    }
    if (!result.summary && !result.problem) return null;
    const box = el('div', 'plan-applied-group');
    if (result.summary) {
      const show = el('button', 'chip-button chip-button--small', el('span', '', 'Pokaż trasę'));
      show.type = 'button';
      show.addEventListener('click', () => {
        tabs.select('plan');
        sheet.collapse();
      });
      box.append(
        el('div', 'plan-applied', icon('check'), el('span', 'plan-applied__text', result.summary), result.routed && !result.navigating ? show : null),
      );
    }
    if (result.problem) {
      const problem = el('p', 'plan-applied plan-applied--problem', result.problem);
      problem.setAttribute('role', 'alert');
      box.append(problem);
    }
    return box;
  }

  function fillMessage(element: HTMLElement, message: ChatMessage): void {
    if (message.role === 'user') {
      element.replaceChildren(el('div', 'msg__bubble', message.text));
      if (message.note) element.append(el('p', 'msg__note', message.note));
      return;
    }
    const children: (HTMLElement | null)[] = [];
    if (message.tools.length > 0) {
      const streaming = message.status === 'streaming';
      children.push(
        el(
          'ul',
          'msg__tools',
          ...message.tools.map((label, index) => {
            const active = streaming && index === message.tools.length - 1 && message.plans.length === 0;
            return el('li', active ? 'tool-chip tool-chip--active' : 'tool-chip', active ? el('span', 'spinner spinner--small') : icon('check'), el('span', '', label));
          }),
        ),
      );
    }
    if (message.text.trim()) {
      const body = el('div', 'msg__bubble msg__bubble--md');
      body.append(renderMarkdown(message.text));
      children.push(body);
    } else if (message.status === 'streaming') {
      const typing = el('div', 'msg__bubble msg__typing', el('span'), el('span'), el('span'));
      typing.setAttribute('aria-label', 'Asystent pisze');
      children.push(typing);
    }
    message.plans.forEach((_plan, index) => children.push(planView(message.planResults?.[index])));
    if (message.status === 'stopped') children.push(el('p', 'msg__note', 'Zatrzymano odpowiedź.'));
    if (message.status === 'error') {
      const retry = el('button', 'chip-button chip-button--small', icon('retry'), el('span', '', 'Spróbuj ponownie'));
      retry.type = 'button';
      retry.addEventListener('click', () => retryLast());
      const isLast = history[history.length - 1] === message;
      const notice = el('div', 'notice notice--error msg__error', el('p', '', message.error ?? 'Coś poszło nie tak.'), isLast ? retry : null);
      notice.setAttribute('role', 'alert');
      children.push(notice);
    }
    element.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
  }

  function messageElement(message: ChatMessage): HTMLElement {
    let element = elements.get(message.id);
    if (!element) {
      element = el('div', `msg msg--${message.role}`);
      elements.set(message.id, element);
    }
    fillMessage(element, message);
    return element;
  }

  /** Przebudowuje całą listę wiadomości (zmiana stanu, nowa wiadomość). */
  function renderLog(): void {
    if (availability.state === 'checking') log.replaceChildren(unavailableView('', true));
    else if (availability.state === 'failed') log.replaceChildren(unavailableView(availability.reason, false));
    else if (!availability.status.available) {
      log.replaceChildren(
        unavailableView(availability.status.reason ?? 'Serwer nie ma skonfigurowanego dostępu do modelu AI.', false),
      );
    } else if (history.length === 0) log.replaceChildren(emptyView());
    else log.replaceChildren(...history.map(messageElement));
    syncControls();
  }

  /** Odświeża tylko bieżącą odpowiedź — najwyżej raz na klatkę, żeby strumień tekstu nie zalewał DOM. */
  function queueStreamRender(message: ChatMessage): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const element = elements.get(message.id);
      if (!element) return;
      const stick = nearBottom();
      fillMessage(element, message);
      if (stick) scrollToEnd();
    });
  }

  // ───────────── rozmowa ─────────────

  async function checkStatus(): Promise<void> {
    availability = { state: 'checking' };
    renderLog();
    try {
      availability = { state: 'ready', status: await fetchAssistantStatus() };
    } catch (error) {
      const offline = error instanceof ApiRequestError && error.code === 'NETWORK';
      availability = {
        state: 'failed',
        reason: offline
          ? 'Nie udało się połączyć z serwerem — asystent wymaga połączenia z internetem.'
          : 'Serwer nie udostępnia asystenta (starsza wersja serwera albo chwilowa awaria).',
      };
    }
    app.routeList.setExplainHandler(isAvailable() ? (route) => explain(route) : null);
    renderLog();
  }

  function handleEvent(message: ChatMessage, event: AssistantEvent): void {
    switch (event.type) {
      case 'text':
        if (typeof event.delta === 'string') {
          message.text += event.delta;
          voice.replyText(message.text);
        }
        break;
      case 'tool':
        if (typeof event.label === 'string' && event.label) message.tools.push(event.label);
        break;
      case 'plan':
        if (event.plan && typeof event.plan === 'object') {
          const index = message.plans.push(event.plan) - 1;
          // Plan zaraz zabierze rozmowę sprzed oczu (nawigacja, zakładka „Trasa”) — mikrofon nie włącza się już sam.
          if (event.plan.startNavigation === true || event.plan.openDeparture === true) voice.dispatch({ type: 'hangup' });
          const results = (message.planResults ??= []);
          const settle = (result: PlanResult): void => {
            results[index] = result;
            if (history.includes(message)) queueStreamRender(message);
          };
          applyPlan(event.plan).then(settle, () =>
            settle({ summary: null, problem: 'Nie udało się zastosować planu w aplikacji.', routed: false, navigating: false }),
          );
        }
        break;
      case 'error':
        message.status = 'error';
        message.error = typeof event.message === 'string' && event.message ? event.message : 'Asystent napotkał błąd.';
        break;
      case 'done':
        if (message.status === 'streaming') message.status = 'done';
        break;
    }
    queueStreamRender(message);
  }

  /** Wysyła historię (kończącą się wiadomością użytkownika) i strumieniuje odpowiedź do nowej wiadomości asystenta. */
  function run(viaVoice = false): void {
    const messages = buildRequestMessages(history);
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') return;
    if (!viaVoice) voice.textSent();
    const reply: ChatMessage = { id: nextId++, role: 'assistant', text: '', tools: [], plans: [], status: 'streaming' };
    history.push(reply);
    const controller = new AbortController();
    request = controller;
    renderLog();
    scrollToEnd();
    void stream(reply, messages, controller);
  }

  async function stream(reply: ChatMessage, messages: AssistantMessage[], controller: AbortController): Promise<void> {
    try {
      await streamAssistant({ messages, context: buildContext(store.get()) }, (event) => handleEvent(reply, event), controller.signal);
      if (reply.status === 'streaming') reply.status = 'done';
      if (reply.status === 'done' && !reply.text.trim() && reply.plans.length === 0) {
        reply.status = 'error';
        reply.error = 'Asystent nie zwrócił odpowiedzi.';
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        reply.status = 'stopped';
      } else {
        reply.status = 'error';
        reply.error = errorMessage(error);
        // 503 = asystent wyłączony po stronie serwera: pokaż wyjaśnienie zamiast pola rozmowy.
        if (error instanceof ApiRequestError && error.status === 503) void checkStatus();
      }
    } finally {
      if (request === controller) request = null;
      voice.replyEnded(reply.status === 'done', reply.text);
      const stick = nearBottom();
      renderLog();
      if (stick) scrollToEnd();
    }
  }

  function send(text: string, extra: { apiText?: string; note?: string; viaVoice?: boolean } = {}): boolean {
    const trimmed = text.trim();
    if (!trimmed || busy() || !isAvailable()) return false;
    history.push({ id: nextId++, role: 'user', text: trimmed, apiText: extra.apiText, note: extra.note, tools: [], plans: [], status: 'done' });
    input.value = '';
    autosize();
    run(extra.viaVoice === true);
    return true;
  }

  function retryLast(): void {
    if (busy()) return;
    const last = history[history.length - 1];
    if (!last || last.role !== 'assistant') return;
    history.pop();
    elements.delete(last.id);
    run();
  }

  function explain(route: RouteResult): void {
    open();
    if (busy()) return;
    send(EXPLAIN_QUESTION, { apiText: explainPrompt(route, effectiveComfort(store.get())), note: 'Dołączono dane wybranej trasy' });
  }

  function explainSelected(): void {
    const route = selectedRoute(store.get());
    if (route) explain(route);
  }

  function open(): void {
    tabs.select('assistant');
    sheet.expand();
    // Na telefonie fokus w polu od razu wysuwałby klawiaturę i zasłaniał rozmowę.
    if (!sheet.isMobile() && isAvailable()) input.focus();
  }

  // ───────────── głos ─────────────

  const voice = installAssistantVoice({
    input,
    composer,
    mic,
    speakerButton,
    note: voiceNote,
    placeholder,
    send: (text) => send(text, { viaVoice: true }),
    onChange: () => {
      autosize();
      syncControls();
    },
  });

  // ───────────── plan: asystent obsługuje aplikację ─────────────

  /** Spełnia się, gdy `ready()` zwróci prawdę albo minie `timeoutMs` (sprawdzane przy zmianach stanu i co chwilę). */
  function until(ready: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (ready()) return resolve();
      const finish = (): void => {
        clearInterval(poll);
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      };
      const check = (): void => {
        if (ready()) finish();
      };
      const unsubscribe = store.subscribe(check);
      const poll = setInterval(check, 150);
      const timeout = setTimeout(finish, timeoutMs);
    });
  }

  /** Odpowiedź dopisana i przeczytana do końca — dopiero wtedy wolno zabrać użytkownikowi rozmowę sprzed oczu. */
  function replySettled(): Promise<void> {
    return until(() => !busy() && voice.state().phase !== 'speaking', REPLY_WAIT_MS);
  }

  const planHost: PlanHost = {
    state: () => store.get(),
    setRouting: (patch) => app.actions.applyPlanRouting(patch),
    waitForRoute: () => until(() => store.get().routeStatus !== 'loading', ROUTE_WAIT_MS),
    selectProfile: (profile) => app.actions.selectProfile(profile),
    setLayers: (layers) => app.actions.setLayers(layers),
    showRouteView: async () => {
      await replySettled();
      tabs.select('plan');
      sheet.expand();
    },
    openDeparture: () => app.actions.openDeparture(),
    startNavigation: async () => {
      await replySettled();
      const state = store.get();
      const route = state.routeStatus === 'ready' ? selectedRoute(state) : null;
      if (!route) return false;
      voice.dispatch({ type: 'leave' });
      return app.routeList.navigate(route);
    },
  };
  const applyPlan = createPlanQueue(planHost, () => nowWallTime().date);

  // ───────────── zdarzenia ─────────────

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });
  input.addEventListener('input', () => {
    voice.dispatch({ type: 'typed' });
    autosize();
    syncControls();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    send(input.value);
  });
  stop.addEventListener('click', () => {
    request?.abort();
    voice.dispatch({ type: 'stop' });
  });
  reset.addEventListener('click', () => {
    request?.abort();
    voice.dispatch({ type: 'stop' });
    history.length = 0;
    elements.clear();
    renderLog();
    if (!sheet.isMobile()) input.focus();
  });
  fab.addEventListener('click', open);

  const syncTab = (): void => {
    const active = tabs.current() === 'assistant';
    panel.classList.toggle('panel--assistant', active);
    fab.hidden = active;
    if (active && history.length === 0) renderLog();
    if (!active) voice.dispatch({ type: 'leave' });
  };
  tabs.onChange(syncTab);

  // Podpowiedzi w pustej rozmowie zależą od punktów trasy i od tego, czy trasa jest wyznaczona.
  store.subscribe((state, previous) => {
    if (history.length > 0 || tabs.current() !== 'assistant') return;
    if (state.from !== previous.from || state.to !== previous.to || state.response !== previous.response) renderLog();
  });

  tabs.enableAssistant();
  syncTab();
  void checkStatus();

  return { open };
}
