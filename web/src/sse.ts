// Parser strumienia Server-Sent Events (zdarzenia `data: <JSON>\n\n`) — używany przez klienta asystenta.

export interface SseParser<T> {
  /** Podaje kolejny fragment tekstu ze strumienia; kompletne zdarzenia trafiają do `onEvent`. */
  feed(chunk: string): void;
  /** Koniec strumienia: przetwarza ostatnie zdarzenie bez kończącej pustej linii. */
  flush(): void;
}

export function createSseParser<T>(onEvent: (event: T) => void): SseParser<T> {
  let buffer = '';

  const emit = (block: string): void => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return; // komentarz (": ping") albo zdarzenie bez danych
    try {
      onEvent(JSON.parse(data) as T);
    } catch {
      // Nieczytelne zdarzenie pomijamy — strumień biegnie dalej.
    }
  };

  return {
    feed(chunk: string): void {
      // Samotne '\r' na końcu fragmentu zostaje w buforze — może być początkiem '\r\n' przeciętego między fragmentami.
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        emit(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    },
    flush(): void {
      if (buffer.trim()) emit(buffer);
      buffer = '';
    },
  };
}
