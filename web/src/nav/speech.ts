// Zapowiedzi głosowe nawigacji (speechSynthesis, pl-PL). Gdy przeglądarka nie ma syntezatora, moduł milczy.

/** Rozwija skróty, które syntezator czyta źle („240 m” → „240 metrów”, „ul.” → „ulica”). */
export function toSpeech(text: string): string {
  return text
    .replace(/(\d+(?:,\d+)?)\s*km(?![\p{L}])/gu, '$1 kilometra')
    .replace(/(\d+)\s*m(?![\p{L}])/gu, '$1 metrów')
    .replace(/(^|[\s(])ul\.\s*/gu, '$1ulica ')
    .replace(/(^|[\s(])al\.\s*/gu, '$1aleja ')
    .replace(/(^|[\s(])pl\.\s*/gu, '$1plac ')
    .replace(/(^|[\s(])os\.\s*/gu, '$1osiedle ')
    .replace(/\s+—\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Speaker {
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  static supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  isEnabled(): boolean {
    return this.enabled && Speaker.supported();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  /**
   * `interrupt` przerywa trwającą zapowiedź (np. manewr „teraz” jest ważniejszy niż podpowiedź o cieniu);
   * bez niego kolejne zapowiedzi ustawiają się w kolejce syntezatora (asystent czyta odpowiedź zdanie po zdaniu).
   * `onEnd` woła się dokładnie raz: po dokończeniu zapowiedzi, po jej przerwaniu albo gdy nie dało się jej wypowiedzieć.
   */
  speak(text: string, interrupt = false, onEnd?: () => void): void {
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      onEnd?.();
    };
    if (!this.isEnabled() || !text.trim()) {
      finish();
      return;
    }
    try {
      const synth = window.speechSynthesis;
      if (interrupt) synth.cancel();
      const utterance = new SpeechSynthesisUtterance(toSpeech(text));
      utterance.lang = 'pl-PL';
      const voice = synth.getVoices().find((candidate) => candidate.lang.toLowerCase().startsWith('pl'));
      if (voice) utterance.voice = voice;
      utterance.rate = 1.05;
      utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
    } catch {
      // Brak głosu lub blokada przeglądarki — aplikacja działa dalej bez dźwięku.
      finish();
    }
  }

  /** Czy syntezator właśnie mówi albo ma zapowiedzi w kolejce. */
  busy(): boolean {
    if (!Speaker.supported()) return false;
    try {
      return window.speechSynthesis.speaking || window.speechSynthesis.pending;
    } catch {
      return false;
    }
  }

  cancel(): void {
    if (!Speaker.supported()) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // bez znaczenia
    }
  }
}
