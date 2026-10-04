// Rozmowa głosowa z asystentem — czysta logika (bez DOM i bez Web Speech API):
//  • automat kolejności „kto teraz mówi” (bezczynność → słuchanie → wysyłanie → czytanie odpowiedzi → słuchanie…),
//  • przygotowanie tekstu odpowiedzi do przeczytania (bez Markdownu, zdanie po zdaniu w miarę napływu strumienia).

export type VoicePhase = 'idle' | 'listening' | 'sending' | 'speaking';

export interface VoiceState {
  phase: VoicePhase;
  /** Tryb rozmowy bez użycia rąk: po przeczytaniu odpowiedzi mikrofon włącza się sam. */
  conversation: boolean;
  /** Czy bieżąca (lub następna) odpowiedź jest czytana na głos. */
  speak: boolean;
}

export interface VoiceCaps {
  /** Przeglądarka rozpoznaje mowę (SpeechRecognition). */
  recognition: boolean;
  /** Przeglądarka ma syntezator mowy (speechSynthesis). */
  synthesis: boolean;
}

export type VoiceEvent =
  /** Dotknięcie mikrofonu. */
  | { type: 'mic' }
  /** Rozpoznano wypowiedź (wynik końcowy). */
  | { type: 'heard'; text: string }
  /** Rozpoznawanie skończyło się bez słów. */
  | { type: 'silence' }
  /** Błąd rozpoznawania (kod z Web Speech API, np. 'not-allowed'). */
  | { type: 'listenError'; error: string }
  /** Użytkownik pisze w polu wiadomości. */
  | { type: 'typed' }
  /** Wysłano wiadomość pisaną; `speak` = zapamiętane ustawienie głośnika. */
  | { type: 'sent'; speak: boolean }
  /** Odpowiedź dotarła w całości (`ok`) albo została przerwana; `speechPending` = syntezator jeszcze czyta. */
  | { type: 'replyEnd'; ok: boolean; speechPending: boolean }
  /** Syntezator skończył czytać odpowiedź. */
  | { type: 'speechEnd' }
  /** Przełącznik głośnika. */
  | { type: 'speaker'; on: boolean }
  /** Przycisk „Zatrzymaj”. */
  | { type: 'stop' }
  /** Koniec trybu rozmowy bez przerywania czytanej odpowiedzi (np. zaraz ruszy nawigacja). */
  | { type: 'hangup' }
  /** Użytkownik opuścił zakładkę asystenta. */
  | { type: 'leave' };

export type VoiceEffect =
  | { type: 'listen' }
  | { type: 'stopListening' }
  | { type: 'stopSpeaking' }
  | { type: 'send'; text: string }
  | { type: 'note'; kind: 'denied' | 'failed' };

export interface VoiceStep {
  state: VoiceState;
  effects: VoiceEffect[];
}

export function initialVoiceState(speak: boolean, caps: VoiceCaps): VoiceState {
  return { phase: 'idle', conversation: false, speak: speak && caps.synthesis };
}

const idle = (state: VoiceState): VoiceState => ({ ...state, phase: 'idle', conversation: false });

/**
 * Jedno przejście automatu. Zasady: mikrofon nigdy nie słucha, gdy syntezator mówi (każde 'listen' pada po
 * 'stopSpeaking' albo po 'speechEnd'), a każda czynność użytkownika (mikrofon, pisanie, stop, wyjście) ucisza asystenta.
 */
export function voiceStep(state: VoiceState, event: VoiceEvent, caps: VoiceCaps): VoiceStep {
  const same: VoiceStep = { state, effects: [] };
  switch (event.type) {
    case 'mic':
      if (!caps.recognition) return same;
      if (state.phase === 'listening') return { state: idle(state), effects: [{ type: 'stopListening' }] };
      // W trakcie odpowiedzi nie da się słuchać — dotknięcie kończy rozmowę głosową i ucisza czytanie.
      if (state.phase === 'sending') {
        return { state: { ...state, conversation: false, speak: false }, effects: [{ type: 'stopSpeaking' }] };
      }
      // Bezczynność albo czytanie odpowiedzi (wejście w słowo): cisza i od razu słuchamy.
      return {
        state: { ...state, phase: 'listening', conversation: true },
        effects: [{ type: 'stopSpeaking' }, { type: 'listen' }],
      };

    case 'heard': {
      if (state.phase !== 'listening') return same;
      const text = event.text.trim();
      if (!text) return { state: idle(state), effects: [] };
      return {
        state: { phase: 'sending', conversation: true, speak: caps.synthesis },
        effects: [{ type: 'send', text }],
      };
    }

    case 'silence':
      return state.phase === 'listening' ? { state: idle(state), effects: [] } : same;

    case 'listenError': {
      if (state.phase !== 'listening') return same;
      const quiet = event.error === 'aborted' || event.error === 'no-speech';
      const denied = event.error === 'not-allowed' || event.error === 'service-not-allowed';
      return {
        state: idle(state),
        effects: quiet ? [] : [{ type: 'note', kind: denied ? 'denied' : 'failed' }],
      };
    }

    case 'typed':
      if (state.phase === 'listening') {
        return { state: idle(state), effects: [{ type: 'stopListening' }, { type: 'stopSpeaking' }] };
      }
      if (state.phase === 'speaking') return { state: idle(state), effects: [{ type: 'stopSpeaking' }] };
      if (state.phase === 'sending') {
        return { state: { ...state, conversation: false, speak: false }, effects: [{ type: 'stopSpeaking' }] };
      }
      return same;

    case 'sent': {
      const effects: VoiceEffect[] = [];
      if (state.phase === 'listening') effects.push({ type: 'stopListening' });
      effects.push({ type: 'stopSpeaking' });
      return { state: { phase: 'sending', conversation: false, speak: event.speak && caps.synthesis }, effects };
    }

    case 'replyEnd':
      if (state.phase !== 'sending') return same;
      if (!event.ok) return { state: idle(state), effects: [{ type: 'stopSpeaking' }] };
      if (state.speak && event.speechPending) return { state: { ...state, phase: 'speaking' }, effects: [] };
      // Odpowiedź przeczytana do końca (albo bez tekstu) — w rozmowie od razu słuchamy dalej.
      if (state.conversation && state.speak && caps.recognition) {
        return { state: { ...state, phase: 'listening' }, effects: [{ type: 'listen' }] };
      }
      return { state: idle(state), effects: [] };

    case 'speechEnd':
      if (state.phase !== 'speaking') return same;
      if (state.conversation && caps.recognition) {
        return { state: { ...state, phase: 'listening' }, effects: [{ type: 'listen' }] };
      }
      return { state: idle(state), effects: [] };

    case 'speaker': {
      const speak = event.on && caps.synthesis;
      if (speak) return { state: { ...state, speak }, effects: [] };
      // Wyciszenie: asystent milknie; rozmowa bez użycia rąk nie ma sensu bez głosu.
      const next: VoiceState =
        state.phase === 'speaking'
          ? { phase: 'idle', conversation: false, speak }
          : { ...state, speak, conversation: state.phase === 'listening' ? state.conversation : false };
      return { state: next, effects: [{ type: 'stopSpeaking' }] };
    }

    case 'stop': {
      const effects: VoiceEffect[] = [];
      if (state.phase === 'listening') effects.push({ type: 'stopListening' });
      effects.push({ type: 'stopSpeaking' });
      return { state: idle(state), effects };
    }

    case 'hangup':
      if (state.phase === 'listening') return { state: idle(state), effects: [{ type: 'stopListening' }] };
      return { state: { ...state, conversation: false }, effects: [] };

    case 'leave':
      if (state.phase === 'listening') return { state: idle(state), effects: [{ type: 'stopListening' }] };
      if (state.phase === 'speaking') return { state: idle(state), effects: [{ type: 'stopSpeaking' }] };
      if (state.phase === 'sending') {
        // Odpowiedź dopisuje się dalej w rozmowie, ale już po cichu.
        return { state: { ...state, conversation: false, speak: false }, effects: [{ type: 'stopSpeaking' }] };
      }
      return same;
  }
}

// ───────────── tekst do przeczytania ─────────────

/** Markdown → zwykły tekst dla syntezatora: bez gwiazdek, nagłówków, punktorów, adresów i emoji. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/[*_`~#]+/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/→/g, ' do ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Skróty, po których kropka nie kończy zdania („ul. Długa”, „np. przez Planty”). */
const ABBREVIATIONS = new Set(['ul', 'al', 'pl', 'os', 'np', 'św', 'ok', 'godz', 'tzw', 'tj', 'im', 'ks', 'dr', 'prof', 'gen', 'min', 'in']);

/** Pozycje tuż za kolejnymi pełnymi zdaniami w `text`. Zdanie kończy . ! ? … przed odstępem albo nowa linia. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  const boundary = /([.!?…]+["”’)\]]*)(\s+)|\n+/g;
  for (let match = boundary.exec(text); match !== null; match = boundary.exec(text)) {
    const end = match.index + match[0].length;
    if (match[1] === '.') {
      const word = /([\p{L}\d]+)$/u.exec(text.slice(0, match.index))?.[1] ?? '';
      // „ul.” i podobne skróty oraz pojedyncze litery (inicjały) nie kończą zdania.
      if (ABBREVIATIONS.has(word.toLocaleLowerCase('pl-PL')) || (word.length === 1 && !/\d/.test(word))) continue;
      // Po liczbie kropka kończy zdanie tylko przed wielką literą („o 15:00. Idź…”, ale nie „15. lipca”);
      // póki dalszy ciąg nie napłynął, czekamy.
      if (/^\d+$/.test(word) && (text[end] === undefined || !/\p{Lu}/u.test(text[end]))) continue;
    }
    ends.push(end);
  }
  return ends;
}

/** Tnie fragment na krótkie zapowiedzi (długie bywają ucinane przez przeglądarki) i zdejmuje z nich Markdown. */
function splitSentences(chunk: string): string[] {
  const sentences: string[] = [];
  let from = 0;
  for (const end of [...sentenceEnds(chunk), chunk.length]) {
    if (end <= from) continue;
    const spoken = speakable(chunk.slice(from, end));
    if (/[\p{L}\d]/u.test(spoken)) sentences.push(spoken);
    from = end;
  }
  return sentences;
}

function completeEnd(text: string): number {
  return sentenceEnds(text).at(-1) ?? 0;
}

export interface SentenceStream {
  /** Podaje cały dotychczasowy tekst odpowiedzi; zwraca nowe, już kompletne zdania (gotowe do przeczytania). */
  push(fullText: string): string[];
  /** Koniec odpowiedzi: zwraca to, co zostało po ostatnim pełnym zdaniu. */
  flush(fullText: string): string[];
  /** Pomija wszystko, co już napłynęło (np. głośnik włączono w połowie odpowiedzi). */
  skip(fullText: string): void;
}

export function createSentenceStream(): SentenceStream {
  let consumed = 0;
  return {
    push(fullText) {
      const end = consumed + completeEnd(fullText.slice(consumed));
      if (end <= consumed) return [];
      const chunk = fullText.slice(consumed, end);
      consumed = end;
      return splitSentences(chunk);
    },
    flush(fullText) {
      const chunk = fullText.slice(consumed);
      consumed = fullText.length;
      return splitSentences(chunk);
    },
    skip(fullText) {
      consumed = consumed + completeEnd(fullText.slice(consumed));
    },
  };
}
