// Synchronizacja stanu z hashem adresu URL (link do udostępnienia) i reakcja na ręczną zmianę hasha.

import { parseHash, serializeHash, type ParsedHash, type ShareableState } from '../hash.ts';

export interface UrlSync {
  /** Zapisuje stan w adresie (bez tworzenia wpisu historii). */
  write(state: ShareableState): void;
}

/** @param onExternalChange hash zmieniony poza aplikacją (wklejony link, przycisk Wstecz) */
export function installUrlSync(onExternalChange: (parsed: ParsedHash) => void): UrlSync {
  let lastWritten = window.location.hash.replace(/^#/, '');

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash === lastWritten) return;
    lastWritten = hash;
    onExternalChange(parseHash(hash));
  });

  return {
    write(state: ShareableState): void {
      const hash = serializeHash(state);
      if (hash === lastWritten) return;
      lastWritten = hash;
      history.replaceState(null, '', `#${hash}`);
    },
  };
}
