// Głos w rozmowie z asystentem: mikrofon (Web Speech API, pl-PL), czytanie odpowiedzi (speechSynthesis)
// i tryb rozmowy bez użycia rąk. Kolejnością „kto mówi” rządzi czysty automat z assistant/voice.ts —
// ten moduł tylko wykonuje jego polecenia na prawdziwych API przeglądarki i odświeża przyciski.

import { MESSAGE_CHAR_LIMIT } from '../assistant/chat.ts';
import {
  createSentenceStream,
  initialVoiceState,
  voiceStep,
  type SentenceStream,
  type VoiceCaps,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from '../assistant/voice.ts';
import { Speaker } from '../nav/speech.ts';
import { icon } from '../ui/icons.ts';

// Web Speech API (rozpoznawanie mowy) nie ma typów w lib.dom — opisujemy tylko to, czego używamy.
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const scope = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const SPEAK_PREF_KEY = 'cien:assistant:speak';
/** Chwila ciszy między końcem czytania a włączeniem mikrofonu — żeby asystent nie usłyszał własnego echa. */
const RELISTEN_DELAY_MS = 250;
const WATCHDOG_MS = 1000;

const NOTES = {
  denied: 'Brak zgody na mikrofon — zezwól na niego w przeglądarce albo napisz.',
  failed: 'Nie udało się rozpoznać mowy — spróbuj jeszcze raz albo napisz.',
} as const;

function loadSpeakPref(): boolean {
  try {
    return localStorage.getItem(SPEAK_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSpeakPref(on: boolean): void {
  try {
    localStorage.setItem(SPEAK_PREF_KEY, on ? '1' : '0');
  } catch {
    // tryb prywatny — ustawienie obowiązuje do zamknięcia karty
  }
}

export interface AssistantVoiceOptions {
  input: HTMLTextAreaElement;
  composer: HTMLElement;
  mic: HTMLButtonElement;
  speakerButton: HTMLButtonElement;
  note: HTMLElement;
  /** Placeholder pola poza słuchaniem. */
  placeholder: string;
  /** Wysyła wiadomość rozpoznaną z mowy; false, gdy nie dało się wysłać. */
  send(text: string): boolean;
  /** Stan głosu albo treść pola się zmieniły — odśwież resztę kontrolek. */
  onChange(): void;
}

export interface AssistantVoice {
  state(): VoiceState;
  dispatch(event: VoiceEvent): void;
  /** Wysłano wiadomość pisaną (albo ponowiono zapytanie). */
  textSent(): void;
  /** Kolejny fragment odpowiedzi — `fullText` to cały dotychczasowy tekst. */
  replyText(fullText: string): void;
  /** Koniec odpowiedzi: `ok` = dotarła w całości (nie błąd i nie „Zatrzymaj”). */
  replyEnded(ok: boolean, fullText: string): void;
}

export function installAssistantVoice(options: AssistantVoiceOptions): AssistantVoice {
  const { input, composer, mic, speakerButton, note } = options;
  const caps: VoiceCaps = { recognition: speechRecognitionCtor() !== null, synthesis: Speaker.supported() };
  const speaker = new Speaker(true);

  let speakPref = loadSpeakPref();
  let state = initialVoiceState(speakPref, caps);
  let recognition: SpeechRecognitionLike | null = null;
  let listenTimer: ReturnType<typeof setTimeout> | undefined;
  let stream: SentenceStream = createSentenceStream();
  let replySoFar = '';
  /** Zapowiedzi oddane syntezatorowi i jeszcze nieprzeczytane; `speechRun` unieważnia te sprzed przerwania. */
  let outstanding = 0;
  let speechRun = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let idleChecks = 0;

  mic.hidden = !caps.recognition;
  speakerButton.hidden = !caps.synthesis;

  // ───────────── widok ─────────────

  function speakerShown(): boolean {
    return state.phase === 'idle' && !state.conversation ? speakPref : state.speak;
  }

  function render(notify = true): void {
    const listening = state.phase === 'listening';
    const conversing = state.conversation && !listening;
    mic.classList.toggle('is-listening', listening);
    mic.classList.toggle('is-conversing', conversing);
    mic.setAttribute('aria-pressed', String(listening || conversing));
    const micLabel = listening ? 'Słucham — dotknij, aby przerwać' : conversing ? 'Zakończ rozmowę głosową' : 'Powiedz to na głos';
    mic.title = micLabel;
    mic.setAttribute('aria-label', micLabel);
    // Podczas zwykłej (pisanej) odpowiedzi mikrofon czeka, aż asystent skończy.
    mic.disabled = state.phase === 'sending' && !state.conversation;
    composer.classList.toggle('assistant__composer--listening', listening);
    input.placeholder = listening ? 'Słucham…' : options.placeholder;

    const on = speakerShown();
    speakerButton.replaceChildren(icon(on ? 'volume' : 'mute'));
    speakerButton.setAttribute('aria-pressed', String(on));
    const speakerLabel = on ? 'Odpowiedzi czytane na głos — wyłącz' : 'Czytaj odpowiedzi na głos';
    speakerButton.title = speakerLabel;
    speakerButton.setAttribute('aria-label', speakerLabel);
    if (notify) options.onChange();
  }

  // ───────────── syntezator ─────────────

  function stopWatchdog(): void {
    clearInterval(watchdog);
    watchdog = undefined;
  }

  function stopSpeaking(): void {
    speechRun++;
    outstanding = 0;
    stopWatchdog();
    speaker.cancel();
  }

  function speechFinished(): void {
    outstanding = 0;
    stopWatchdog();
    dispatch({ type: 'speechEnd' });
  }

  function say(sentences: string[]): void {
    const run = speechRun;
    for (const sentence of sentences) {
      outstanding++;
      speaker.speak(sentence, false, () => {
        if (run !== speechRun) return;
        outstanding = Math.max(0, outstanding - 1);
        if (outstanding === 0 && state.phase === 'speaking') speechFinished();
      });
    }
  }

  /** Niektóre przeglądarki gubią zdarzenie końca zapowiedzi — po chwili ciszy uznajemy czytanie za skończone. */
  function startWatchdog(): void {
    stopWatchdog();
    idleChecks = 0;
    watchdog = setInterval(() => {
      if (state.phase !== 'speaking') return stopWatchdog();
      idleChecks = speaker.busy() ? 0 : idleChecks + 1;
      if (idleChecks >= 2) speechFinished();
    }, WATCHDOG_MS);
  }

  // ───────────── mikrofon ─────────────

  function stopListening(restore: string | null): void {
    clearTimeout(listenTimer);
    const instance = recognition;
    recognition = null;
    if (instance) {
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      try {
        instance.abort();
      } catch {
        // bez znaczenia
      }
    }
    if (restore !== null) input.value = restore;
  }

  let typedBefore = '';

  function listen(): void {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return dispatch({ type: 'listenError', error: 'unsupported' });
    const instance = new Ctor();
    typedBefore = input.value.trim();
    let transcript = '';
    let error: string | null = null;
    let finished = false;
    const withBase = (): string => [typedBefore, transcript].filter(Boolean).join(' ').slice(0, MESSAGE_CHAR_LIMIT);
    const finish = (): void => {
      if (finished || recognition !== instance) return;
      finished = true;
      recognition = null;
      if (error) {
        input.value = typedBefore;
        dispatch({ type: 'listenError', error });
      } else if (transcript) {
        dispatch({ type: 'heard', text: withBase() });
      } else {
        dispatch({ type: 'silence' });
      }
    };

    instance.lang = 'pl-PL';
    instance.continuous = false;
    instance.interimResults = true;
    instance.onresult = (event) => {
      if (recognition !== instance) return;
      let text = '';
      let final = event.results.length > 0;
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
        if (!event.results[i].isFinal) final = false;
      }
      transcript = text.trim();
      input.value = withBase();
      options.onChange();
      if (final && transcript) finish();
    };
    instance.onerror = (event) => {
      error = event.error;
    };
    instance.onend = finish;

    note.hidden = true;
    recognition = instance;
    try {
      instance.start();
    } catch {
      recognition = null;
      dispatch({ type: 'listenError', error: 'start-failed' });
    }
  }

  // ───────────── automat ─────────────

  function perform(effect: VoiceEffect, cause: VoiceEvent['type']): void {
    switch (effect.type) {
      case 'listen':
        clearTimeout(listenTimer);
        // Po dotknięciu mikrofonu słuchamy od razu; po czytaniu odpowiedzi — po chwili ciszy.
        if (cause === 'mic' && !speaker.busy()) listen();
        else {
          listenTimer = setTimeout(() => {
            if (state.phase === 'listening' && !recognition) listen();
          }, RELISTEN_DELAY_MS);
        }
        break;
      case 'stopListening':
        // Przerwanie mikrofonem odrzuca niedokończone rozpoznanie; przy pisaniu i wysyłaniu pole zostaje, jak jest.
        stopListening(cause === 'mic' ? typedBefore : null);
        break;
      case 'stopSpeaking':
        stopSpeaking();
        break;
      case 'send':
        input.value = '';
        stream = createSentenceStream();
        replySoFar = '';
        if (!options.send(effect.text)) dispatch({ type: 'stop' });
        break;
      case 'note':
        note.textContent = NOTES[effect.kind];
        note.hidden = false;
        break;
    }
  }

  function dispatch(event: VoiceEvent): void {
    const step = voiceStep(state, event, caps);
    if (step.state === state && step.effects.length === 0) return;
    state = step.state;
    for (const effect of step.effects) perform(effect, event.type);
    if (state.phase === 'speaking') {
      if (!watchdog) startWatchdog();
    } else stopWatchdog();
    render();
  }

  mic.addEventListener('click', () => dispatch({ type: 'mic' }));
  speakerButton.addEventListener('click', () => {
    const on = !speakerShown();
    speakPref = on;
    saveSpeakPref(on);
    // Włączenie w połowie odpowiedzi: czytamy od bieżącego miejsca, nie od początku.
    if (on) stream.skip(replySoFar);
    dispatch({ type: 'speaker', on });
    render();
  });

  render(false);

  return {
    state: () => state,
    dispatch,
    textSent() {
      stream = createSentenceStream();
      replySoFar = '';
      dispatch({ type: 'sent', speak: speakPref });
    },
    replyText(fullText) {
      replySoFar = fullText;
      if (state.phase === 'sending' && state.speak) say(stream.push(fullText));
    },
    replyEnded(ok, fullText) {
      replySoFar = fullText;
      if (ok && state.phase === 'sending' && state.speak) say(stream.flush(fullText));
      dispatch({ type: 'replyEnd', ok, speechPending: outstanding > 0 });
    },
  };
}
