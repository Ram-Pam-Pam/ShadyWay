// Rozmowa głosowa z asystentem (automat kolejności, tekst do przeczytania), wykonanie planu asystenta w aplikacji,
// cicha podpowiedź pory wyjścia i ostrzeżenie o upale.

import { describe, expect, it } from 'vitest';
import type { AssistantPlan, DepartureOption, RouteResponse, RouteResult } from '../shared/types.ts';
import { describePlan } from '../web/src/assistant/chat.ts';
import { createPlanQueue, runPlan, type PlanHost, type PlanHostState } from '../web/src/assistant/planRunner.ts';
import {
  createSentenceStream,
  initialVoiceState,
  speakable,
  voiceStep,
  type VoiceCaps,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from '../web/src/assistant/voice.ts';
import { hintApplies, pickDepartureHint } from '../web/src/departureHint.ts';
import { heatAdvice } from '../web/src/labels.ts';

const FULL: VoiceCaps = { recognition: true, synthesis: true };

/** Przepuszcza kolejne zdarzenia przez automat; zwraca stan końcowy i wszystkie polecenia po kolei. */
function play(events: VoiceEvent[], caps: VoiceCaps = FULL, start: VoiceState = initialVoiceState(false, caps)) {
  let state = start;
  const effects: VoiceEffect[] = [];
  for (const event of events) {
    const step = voiceStep(state, event, caps);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects, kinds: effects.map((effect) => effect.type) };
}

describe('automat rozmowy głosowej', () => {
  it('prowadzi rozmowę bez użycia rąk: słucha → wysyła → czyta → znowu słucha', () => {
    const heard = play([{ type: 'mic' }, { type: 'heard', text: '  Zaplanuj trasę na Wawel ' }]);
    expect(heard.state).toEqual({ phase: 'sending', conversation: true, speak: true });
    expect(heard.effects).toEqual([{ type: 'stopSpeaking' }, { type: 'listen' }, { type: 'send', text: 'Zaplanuj trasę na Wawel' }]);

    const speaking = play([{ type: 'replyEnd', ok: true, speechPending: true }], FULL, heard.state);
    expect(speaking.state.phase).toBe('speaking');
    // Dopóki asystent mówi, mikrofon się nie włącza.
    expect(speaking.kinds).not.toContain('listen');

    const again = play([{ type: 'speechEnd' }], FULL, speaking.state);
    expect(again.state).toEqual({ phase: 'listening', conversation: true, speak: true });
    expect(again.kinds).toEqual(['listen']);
  });

  it('wiadomość głosowa włącza czytanie odpowiedzi nawet przy wyciszonym głośniku, pisana wraca do ustawienia', () => {
    const voiced = play([{ type: 'mic' }, { type: 'heard', text: 'cześć' }]);
    expect(voiced.state.speak).toBe(true);
    const typed = play([{ type: 'replyEnd', ok: true, speechPending: false }, { type: 'mic' }, { type: 'sent', speak: false }], FULL, voiced.state);
    expect(typed.state).toEqual({ phase: 'sending', conversation: false, speak: false });
    expect(play([{ type: 'sent', speak: true }]).state.speak).toBe(true);
  });

  it('odpowiedź przeczytana przed końcem strumienia od razu wraca do słuchania; pisana rozmowa kończy się bezczynnością', () => {
    const voiced = play([{ type: 'mic' }, { type: 'heard', text: 'tak' }, { type: 'replyEnd', ok: true, speechPending: false }]);
    expect(voiced.state.phase).toBe('listening');
    expect(voiced.kinds.at(-1)).toBe('listen');

    const typed = play([{ type: 'sent', speak: true }, { type: 'replyEnd', ok: true, speechPending: true }, { type: 'speechEnd' }]);
    expect(typed.state).toEqual({ phase: 'idle', conversation: false, speak: true });
    expect(typed.kinds).not.toContain('listen');
  });

  it('ponowne dotknięcie mikrofonu przerywa słuchanie, a cisza i błędy kończą rozmowę', () => {
    const cancelled = play([{ type: 'mic' }, { type: 'mic' }]);
    expect(cancelled.state).toEqual({ phase: 'idle', conversation: false, speak: false });
    expect(cancelled.kinds).toEqual(['stopSpeaking', 'listen', 'stopListening']);

    expect(play([{ type: 'mic' }, { type: 'silence' }]).state.phase).toBe('idle');
    expect(play([{ type: 'mic' }, { type: 'heard', text: '   ' }]).state.phase).toBe('idle');

    const denied = play([{ type: 'mic' }, { type: 'listenError', error: 'not-allowed' }]);
    expect(denied.state.phase).toBe('idle');
    expect(denied.effects.at(-1)).toEqual({ type: 'note', kind: 'denied' });
    expect(play([{ type: 'mic' }, { type: 'listenError', error: 'network' }]).effects.at(-1)).toEqual({ type: 'note', kind: 'failed' });
    expect(play([{ type: 'mic' }, { type: 'listenError', error: 'no-speech' }]).kinds).not.toContain('note');
  });

  it('każda czynność użytkownika ucisza asystenta', () => {
    const speaking = play([{ type: 'mic' }, { type: 'heard', text: 'opowiedz' }, { type: 'replyEnd', ok: true, speechPending: true }]).state;

    // Mikrofon w trakcie czytania = wejście w słowo: najpierw cisza, potem słuchanie.
    const bargeIn = play([{ type: 'mic' }], FULL, speaking);
    expect(bargeIn.state.phase).toBe('listening');
    expect(bargeIn.kinds).toEqual(['stopSpeaking', 'listen']);

    for (const event of [{ type: 'typed' }, { type: 'stop' }, { type: 'leave' }, { type: 'speaker', on: false }] as VoiceEvent[]) {
      const result = play([event], FULL, speaking);
      expect(result.state.phase, event.type).toBe('idle');
      expect(result.state.conversation, event.type).toBe(false);
      expect(result.kinds, event.type).toEqual(['stopSpeaking']);
    }

    // Pisanie podczas słuchania wyłącza mikrofon.
    expect(play([{ type: 'mic' }, { type: 'typed' }]).kinds).toEqual(['stopSpeaking', 'listen', 'stopListening', 'stopSpeaking']);
  });

  it('w trakcie odpowiedzi: mikrofon, pisanie i wyjście z zakładki wyciszają ją i kończą rozmowę, a „stop” i błąd wracają do bezczynności', () => {
    const sending = play([{ type: 'mic' }, { type: 'heard', text: 'pytanie' }]).state;
    for (const event of [{ type: 'mic' }, { type: 'typed' }, { type: 'leave' }] as VoiceEvent[]) {
      const result = play([event], FULL, sending);
      expect(result.state, event.type).toEqual({ phase: 'sending', conversation: false, speak: false });
      expect(result.kinds, event.type).toEqual(['stopSpeaking']);
      // Po wyciszeniu koniec odpowiedzi nie uruchamia ani czytania, ani mikrofonu.
      const ended = play([{ type: 'replyEnd', ok: true, speechPending: false }], FULL, result.state);
      expect(ended.state.phase).toBe('idle');
      expect(ended.kinds).toEqual([]);
    }
    expect(play([{ type: 'stop' }], FULL, sending).state.phase).toBe('idle');
    const failed = play([{ type: 'replyEnd', ok: false, speechPending: true }], FULL, sending);
    expect(failed.state).toEqual({ phase: 'idle', conversation: false, speak: true });
    expect(failed.kinds).toEqual(['stopSpeaking']);
  });

  it('„hangup” kończy tryb rozmowy bez przerywania czytanej odpowiedzi', () => {
    const sending = play([{ type: 'mic' }, { type: 'heard', text: 'nawiguj' }]).state;
    const hung = play([{ type: 'hangup' }], FULL, sending);
    expect(hung.state).toEqual({ phase: 'sending', conversation: false, speak: true });
    expect(hung.effects).toEqual([]);
    const done = play([{ type: 'replyEnd', ok: true, speechPending: true }, { type: 'speechEnd' }], FULL, hung.state);
    expect(done.state.phase).toBe('idle');
    expect(done.kinds).not.toContain('listen');
    expect(play([{ type: 'mic' }, { type: 'hangup' }]).kinds.at(-1)).toBe('stopListening');
  });

  it('działa bez API przeglądarki: brak rozpoznawania = mikrofon nic nie robi, brak syntezatora = nic nie jest czytane', () => {
    const noMic: VoiceCaps = { recognition: false, synthesis: true };
    const tapped = play([{ type: 'mic' }], noMic);
    expect(tapped.state.phase).toBe('idle');
    expect(tapped.effects).toEqual([]);
    // Czytanie odpowiedzi na wiadomość pisaną działa dalej.
    expect(play([{ type: 'sent', speak: true }, { type: 'replyEnd', ok: true, speechPending: true }], noMic).state.phase).toBe('speaking');

    const noVoice: VoiceCaps = { recognition: true, synthesis: false };
    expect(initialVoiceState(true, noVoice).speak).toBe(false);
    const dictated = play([{ type: 'mic' }, { type: 'heard', text: 'cześć' }, { type: 'replyEnd', ok: true, speechPending: false }], noVoice);
    // Dyktowanie z automatycznym wysłaniem działa, ale bez głosu nie ma rozmowy „w kółko”.
    expect(dictated.state).toEqual({ phase: 'idle', conversation: false, speak: false });
    expect(play([{ type: 'speaker', on: true }], noVoice).state.speak).toBe(false);
  });

  it('ignoruje spóźnione zdarzenia', () => {
    const idle = initialVoiceState(true, FULL);
    for (const event of [
      { type: 'heard', text: 'x' },
      { type: 'silence' },
      { type: 'speechEnd' },
      { type: 'replyEnd', ok: true, speechPending: true },
      { type: 'listenError', error: 'network' },
    ] as VoiceEvent[]) {
      expect(voiceStep(idle, event, FULL)).toEqual({ state: idle, effects: [] });
    }
  });
});

describe('tekst odpowiedzi do przeczytania', () => {
  it('usuwa Markdown, adresy i emoji', () => {
    expect(speakable('## Trasa\n- **Idź** [Plantami](https://example.com) 🌳\n- potem `prosto`')).toBe('Trasa Idź Plantami potem prosto');
    expect(speakable('AGH → Wawel')).toBe('AGH do Wawel');
  });

  it('wydaje zdania dopiero, gdy są kompletne, a resztę na końcu', () => {
    const stream = createSentenceStream();
    let text = 'Trasa ma 1,2 km';
    expect(stream.push(text)).toEqual([]);
    text += ' i biegnie ul. Karmelicką. Potem';
    expect(stream.push(text)).toEqual(['Trasa ma 1,2 km i biegnie ul. Karmelicką.']);
    text += ' skręć w lewo! **Miłego** spaceru';
    expect(stream.push(text)).toEqual(['Potem skręć w lewo!']);
    expect(stream.push(text)).toEqual([]);
    expect(stream.flush(text)).toEqual(['Miłego spaceru']);
    expect(stream.flush(text)).toEqual([]);
  });

  it('dzieli po liniach, nie tnie po skrótach i liczbach, a `skip` pomija to, co już napłynęło', () => {
    const stream = createSentenceStream();
    expect(createSentenceStream().push('Ustawiłem wyjście na 15:00. Idź Plantami. ')).toEqual(['Ustawiłem wyjście na 15:00.', 'Idź Plantami.']);
    expect(createSentenceStream().push('Wyjdź 15. lipca rano. ')).toEqual(['Wyjdź 15. lipca rano.']);
    expect(stream.push('1. Start: Rynek\n2. Cel: Wawel o 15.30\n')).toEqual(['Start: Rynek', 'Cel: Wawel o 15.30']);
    const late = createSentenceStream();
    const text = 'Pierwsze zdanie. Drugie zdanie. Trzecie';
    late.skip(text);
    expect(late.flush(text)).toEqual(['Trzecie']);
  });
});

// ───────────── plan asystenta ─────────────

const AGH = { lat: 50.0647, lon: 19.9237, label: 'AGH' };
const WAWEL = { lat: 50.0541, lon: 19.9354, label: 'Wawel' };

function route(profile: RouteResult['profile']): RouteResult {
  return { profile, geometry: [[19.92, 50.06], [19.93, 50.05]] } as unknown as RouteResult;
}

interface FakeOptions {
  state?: Partial<PlanHostState>;
  /** Stan po „przeliczeniu trasy” (nakładany, gdy runner doczeka się trasy). */
  afterRoute?: Partial<PlanHostState>;
  heatAvailable?: boolean;
  navigationWorks?: boolean;
}

function fakeHost(options: FakeOptions = {}) {
  const calls: string[] = [];
  let state: PlanHostState = {
    from: null,
    to: null,
    routeStatus: 'idle',
    routeError: null,
    response: null,
    selectedProfile: 'balanced',
    layers: { shadows: true, heat: false, buildings3d: false },
    ...options.state,
  };
  const host: PlanHost = {
    state: () => state,
    setRouting: (patch) => {
      calls.push(`routing:${Object.keys(patch).sort().join(',')}`);
      state = { ...state, ...(patch as Partial<PlanHostState>), routeStatus: 'loading' };
    },
    waitForRoute: async () => {
      calls.push('wait');
      await Promise.resolve();
      if (state.routeStatus === 'loading') {
        state = {
          ...state,
          routeStatus: 'ready',
          response: { routes: [route('shortest'), route('balanced'), route('shadiest')] } as unknown as RouteResponse,
          ...options.afterRoute,
        };
      }
    },
    selectProfile: (profile) => {
      calls.push(`profile:${profile}`);
      state = { ...state, selectedProfile: profile };
    },
    setLayers: (layers) => {
      calls.push(`layers:${JSON.stringify(layers)}`);
      const applied = { ...layers };
      if (options.heatAvailable === false) delete applied.heat;
      return applied;
    },
    showRouteView: async () => {
      calls.push('view');
    },
    openDeparture: () => {
      calls.push('departure');
    },
    startNavigation: async () => {
      calls.push('navigate');
      return options.navigationWorks !== false;
    },
  };
  return { host, calls };
}

const TODAY = '2026-07-15';

describe('wykonanie planu asystenta', () => {
  it('stosuje wszystkie pola we właściwej kolejności, nawigację na końcu', async () => {
    const { host, calls } = fakeHost();
    const plan: AssistantPlan = {
      from: AGH,
      to: WAWEL,
      time: '2026-07-15T15:00:00+02:00',
      mobility: 'accessible',
      shadePreference: 1,
      comfort: 'sun',
      viaCoolSpot: true,
      selectProfile: 'shadiest',
      layers: { heat: true, buildings3d: false },
      openDeparture: true,
      startNavigation: true,
    };
    const outcome = await runPlan(plan, host, TODAY);
    expect(calls).toEqual([
      'routing:date,followNow,formError,from,minutes,mobility,pickTarget,shadePreference,to',
      'view',
      'wait',
      'profile:shadiest',
      'layers:{"heat":true,"buildings3d":false}',
      'departure',
      'navigate',
    ]);
    expect(outcome).toEqual({
      summary:
        'Ustawiono: AGH → Wawel, 15:00 · bez schodów · maksimum cienia · wariant najbardziej zacieniony · mapa ciepła włączona · wykres „Kiedy wyjść?” otwarty · nawigacja uruchomiona',
      problem: null,
      routed: true,
      navigating: true,
    });
  });

  it('daje zwartą linię potwierdzenia dla typowego planu', async () => {
    const { host } = fakeHost();
    const outcome = await runPlan({ from: AGH, to: WAWEL, time: '2026-07-15T15:00:00+02:00', startNavigation: true }, host, TODAY);
    expect(outcome.summary).toBe('Ustawiono: AGH → Wawel, 15:00 · nawigacja uruchomiona');
  });

  it('plan z samymi warstwami niczego nie przelicza i nie czeka na trasę', async () => {
    const { host, calls } = fakeHost({ state: { from: AGH, to: WAWEL, routeStatus: 'ready' } });
    const outcome = await runPlan({ layers: { shadows: false, heat: true } }, host, TODAY);
    expect(calls).toEqual(['layers:{"shadows":false,"heat":true}']);
    expect(outcome).toEqual({ summary: 'Ustawiono: cienie wyłączone · mapa ciepła włączona', problem: null, routed: false, navigating: false });
  });

  it('warstwa już ustawiona: potwierdza prośbę, ale nie dopisuje jej do większego planu', async () => {
    const alone = fakeHost();
    expect((await runPlan({ layers: { shadows: true } }, alone.host, TODAY)).summary).toBe('Ustawiono: cienie włączone');
    const withRoute = fakeHost();
    expect((await runPlan({ from: AGH, to: WAWEL, layers: { shadows: true, heat: false } }, withRoute.host, TODAY)).summary).toBe('Ustawiono: AGH → Wawel');
  });

  it('pomija po cichu pola bez odpowiednika w interfejsie i niedostępne warstwy', async () => {
    const { host, calls } = fakeHost({ heatAvailable: false });
    const outcome = await runPlan({ comfort: 'sun', viaCoolSpot: true, layers: { heat: true } }, host, TODAY);
    expect(calls).toEqual(['layers:{"heat":true}']);
    expect(outcome).toEqual({ summary: null, problem: null, routed: false, navigating: false });
  });

  it('błąd wyznaczania trasy trafia do rozmowy, a nawigacja nie rusza', async () => {
    const { host, calls } = fakeHost({ afterRoute: { routeStatus: 'error', routeError: 'Serwer nie odpowiada.', response: null } });
    const outcome = await runPlan({ from: AGH, to: WAWEL, selectProfile: 'shortest', startNavigation: true }, host, TODAY);
    expect(calls).toEqual(['routing:formError,from,pickTarget,to', 'wait']);
    expect(outcome.problem).toBe('Nie udało się wyznaczyć trasy. Serwer nie odpowiada.');
    expect(outcome.navigating).toBe(false);
    expect(outcome.summary).toBe('Ustawiono: AGH → Wawel');
  });

  it('nawigacja bez trasy: jasny komunikat zamiast startu', async () => {
    const empty = fakeHost();
    const outcome = await runPlan({ startNavigation: true }, empty.host, TODAY);
    expect(empty.calls).toEqual(['wait']);
    expect(outcome).toEqual({ summary: null, problem: 'Nawigacja nie ruszyła — najpierw wskaż start i cel.', routed: false, navigating: false });

    const broken = fakeHost({ state: { from: AGH, to: WAWEL, routeStatus: 'error', routeError: 'x' } });
    expect((await runPlan({ startNavigation: true }, broken.host, TODAY)).problem).toBe('Nawigacja nie ruszyła — nie ma gotowej trasy.');

    const refused = fakeHost({
      state: { from: AGH, to: WAWEL, routeStatus: 'ready', response: { routes: [route('balanced')] } as unknown as RouteResponse },
      navigationWorks: false,
    });
    const result = await runPlan({ startNavigation: true }, refused.host, TODAY);
    expect(refused.calls).toEqual(['wait', 'navigate']);
    expect(result.navigating).toBe(false);
  });

  it('nawigacja dla istniejącej trasy rusza bez przeliczania; wariant spoza odpowiedzi jest pomijany', async () => {
    const { host, calls } = fakeHost({
      state: { from: AGH, to: WAWEL, routeStatus: 'ready', response: { routes: [route('balanced')] } as unknown as RouteResponse },
    });
    const outcome = await runPlan({ selectProfile: 'shadiest', startNavigation: true }, host, TODAY);
    expect(calls).toEqual(['wait', 'navigate']);
    expect(outcome.summary).toBe('Ustawiono: nawigacja uruchomiona');
  });

  it('„Kiedy wyjść?” bez punktów trasy nie otwiera wykresu', async () => {
    const { host, calls } = fakeHost();
    const outcome = await runPlan({ openDeparture: true }, host, TODAY);
    expect(calls).toEqual(['view']);
    expect(outcome.problem).toBe('Wykres „Kiedy wyjść?” wymaga startu i celu.');
  });

  it('kolejka wykonuje plany jeden po drugim', async () => {
    const { host, calls } = fakeHost();
    const queue = createPlanQueue(host, () => TODAY);
    const first = queue({ from: AGH, to: WAWEL });
    const second = queue({ startNavigation: true });
    await Promise.all([first, second]);
    expect(calls).toEqual(['routing:formError,from,pickTarget,to', 'wait', 'wait', 'navigate']);
    expect((await second).navigating).toBe(true);
  });

  it('opisuje godzinę zwięźle: dziś, jutro, inna data', () => {
    expect(describePlan({ time: '2026-07-15T18:30:00+02:00' }, TODAY)).toEqual(['wyjście 18:30']);
    expect(describePlan({ to: WAWEL, time: '2026-07-16T08:00:00+02:00' }, TODAY)).toEqual(['cel: Wawel, jutro 08:00']);
    expect(describePlan({ time: '2026-08-02T08:00:00+02:00' }, TODAY)).toEqual(['wyjście 02.08, 08:00']);
    // Punkt spoza Krakowa nie zostanie ustawiony, więc nie trafia do opisu.
    expect(describePlan({ to: { lat: 52.23, lon: 21.01, label: 'Warszawa' } }, TODAY)).toEqual([]);
  });
});

// ───────────── podpowiedź pory wyjścia i upał ─────────────

function option(minutesFromStart: number, shadeFraction: number, score: number): DepartureOption {
  return {
    time: new Date(Date.parse('2026-07-15T12:00:00Z') + minutesFromStart * 60_000).toISOString(),
    distanceM: 1200,
    durationS: 900,
    shadeFraction,
    sunDistanceM: 0,
    sunFactor: 1,
    feltMeanC: 30,
    score,
  };
}

describe('cicha podpowiedź pory wyjścia', () => {
  it('pojawia się tylko przy wyraźnie lepszej późniejszej porze', () => {
    const better = { options: [option(0, 0.4, 50), option(30, 0.5, 55), option(60, 0.82, 80)], bestIndex: 2 };
    expect(pickDepartureHint(better, 'shade')).toEqual({
      time: better.options[2].time,
      text: 'Za 1 h będzie 82% cienia — przestaw godzinę',
    });
    // +10 punktów procentowych i podobna ocena — za mało.
    expect(pickDepartureHint({ options: [option(0, 0.4, 50), option(30, 0.5, 55)], bestIndex: 1 }, 'shade')).toBeNull();
    // Teraz jest najlepiej.
    expect(pickDepartureHint({ options: [option(0, 0.8, 80), option(30, 0.5, 55)], bestIndex: 0 }, 'shade')).toBeNull();
    expect(pickDepartureHint({ options: [option(0, 0.4, 50)], bestIndex: 0 }, 'shade')).toBeNull();
    expect(pickDepartureHint(null, 'shade')).toBeNull();
  });

  it('uznaje też wyraźnie wyższą ocenę serwera przy umiarkowanym zysku cienia', () => {
    const scored = { options: [option(0, 0.5, 40), option(90, 0.58, 62)], bestIndex: 1 };
    expect(pickDepartureHint(scored, 'shade')?.text).toBe('Za 1 h 30 min będzie 58% cienia — przestaw godzinę');
    // Więcej cienia, ale gorsza ocena (np. dużo dłuższa trasa) — bez podpowiedzi.
    expect(pickDepartureHint({ options: [option(0, 0.4, 60), option(30, 0.7, 50)], bestIndex: 0 }, 'shade')).toBeNull();
  });

  it('gdy najlepsza pora serwera nie spełnia progu, bierze najlepszą z kwalifikujących się', () => {
    const response = { options: [option(0, 0.4, 50), option(30, 0.6, 58), option(60, 0.42, 59), option(90, 0.7, 57)], bestIndex: 2 };
    expect(pickDepartureHint(response, 'shade')?.text).toBe('Za 30 min będzie 60% cienia — przestaw godzinę');
  });

  it('w trybie zimowym mówi o słońcu', () => {
    const response = { options: [option(0, 0.7, 40), option(30, 0.3, 70)], bestIndex: 1 };
    expect(pickDepartureHint(response, 'sun')?.text).toBe('Za 30 min będzie 70% słońca — przestaw godzinę');
  });

  it('dotyczy tylko wyjścia „teraz”', () => {
    const now = new Date('2026-07-15T12:07:00+02:00');
    expect(hintApplies({ date: '2026-07-15', minutes: 12 * 60 }, now)).toBe(true);
    expect(hintApplies({ date: '2026-07-15', minutes: 12 * 60 + 45 }, now)).toBe(true);
    expect(hintApplies({ date: '2026-07-15', minutes: 18 * 60 }, now)).toBe(false);
    expect(hintApplies({ date: '2026-07-15', minutes: 9 * 60 }, now)).toBe(false);
    expect(hintApplies({ date: '2026-07-16', minutes: 12 * 60 }, now)).toBe(false);
  });
});

describe('ostrzeżenie o upale', () => {
  it('pojawia się od silnego obciążenia cieplnego', () => {
    const thermal = { feltSunC: 34.2, feltShadeC: 28, feltMeanC: 31, stress: 'strong' as const };
    expect(heatAdvice(thermal)).toBe('Upał — weź wodę, 34°C odczuwalna w słońcu');
    expect(heatAdvice({ ...thermal, stress: 'extreme', feltSunC: null })).toBe('Upał — weź wodę, 31°C odczuwalna');
    expect(heatAdvice({ ...thermal, stress: 'very_strong', feltSunC: null, feltMeanC: null })).toBe('Upał — weź wodę');
    expect(heatAdvice({ ...thermal, stress: 'moderate' })).toBeNull();
    expect(heatAdvice({ ...thermal, stress: 'cold' })).toBeNull();
    expect(heatAdvice({ ...thermal, stress: null })).toBeNull();
    expect(heatAdvice(undefined)).toBeNull();
  });
});
