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

  /** `interrupt` przerywa trwającą zapowiedź (np. manewr „teraz” jest ważniejszy niż podpowiedź o cieniu). */
  speak(text: string, interrupt = false): void {
    if (!this.isEnabled() || !text.trim()) return;
    try {
      const synth = window.speechSynthesis;
      if (interrupt) synth.cancel();
      const utterance = new SpeechSynthesisUtterance(toSpeech(text));
      utterance.lang = 'pl-PL';
      const voice = synth.getVoices().find((candidate) => candidate.lang.toLowerCase().startsWith('pl'));
      if (voice) utterance.voice = voice;
      utterance.rate = 1.05;
      synth.speak(utterance);
    } catch {
      // Brak głosu lub blokada przeglądarki — nawigacja działa dalej bez dźwięku.
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
