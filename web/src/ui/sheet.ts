// Panel boczny (desktop) / dolny arkusz (telefon): zwijanie oraz margines mapy pod arkuszem.

import type { PaddingOptions } from 'maplibre-gl';
import { byId } from '../util.ts';

const MOBILE_QUERY = '(max-width: 719px)';
const MAP_EDGE_PADDING = 56;
/** U góry mapy zostaje miejsce na znacznik (czubek w punkcie, reszta nad nim) i komunikat warstwy cieni. */
const MAP_TOP_PADDING = 92;

export class Sheet {
  private readonly panel = byId<HTMLElement>('panel');
  private readonly toggle = byId<HTMLButtonElement>('sheet-toggle');
  private readonly toggleLabel = byId<HTMLElement>('sheet-toggle-label');
  private readonly summary = byId<HTMLElement>('sheet-summary');
  private readonly mapWrap = byId<HTMLElement>('map-wrap');
  private readonly mobile = window.matchMedia(MOBILE_QUERY);

  constructor() {
    this.toggle.addEventListener('click', () => this.setCollapsed(!this.isCollapsed()));

    const sync = (): void => {
      // Na telefonie kontrolki mapy (skala, atrybucja) podnosimy ponad arkusz.
      const height = this.mobile.matches ? this.panel.offsetHeight : 0;
      this.mapWrap.style.setProperty('--sheet-height', `${height}px`);
    };
    new ResizeObserver(sync).observe(this.panel);
    this.mobile.addEventListener('change', () => {
      if (!this.mobile.matches) this.setCollapsed(false);
      sync();
    });
    sync();
  }

  /** Krótki opis stanu widoczny na uchwycie arkusza (np. podsumowanie wybranej trasy). */
  setSummary(text: string): void {
    this.summary.textContent = text;
  }

  /** Margines, w którym mapa ma mieścić trasę — uwzględnia arkusz zasłaniający dół mapy. */
  mapPadding(): PaddingOptions {
    const sheet = this.mobile.matches ? this.panel.offsetHeight : 0;
    return {
      top: MAP_TOP_PADDING,
      right: MAP_EDGE_PADDING,
      left: MAP_EDGE_PADDING,
      // Na telefonie nad arkuszem leży jeszcze pasek atrybucji mapy.
      bottom: sheet + (this.mobile.matches ? 64 : MAP_EDGE_PADDING),
    };
  }

  /** Rozwija arkusz (np. gdy inna część interfejsu otwiera w nim zakładkę). */
  expand(): void {
    this.setCollapsed(false);
  }

  /** Zwija arkusz na telefonie, żeby odsłonić mapę; na szerokim ekranie panel jest zawsze rozwinięty. */
  collapse(): void {
    if (this.mobile.matches) this.setCollapsed(true);
  }

  isMobile(): boolean {
    return this.mobile.matches;
  }

  private isCollapsed(): boolean {
    return this.panel.classList.contains('panel--collapsed');
  }

  private setCollapsed(collapsed: boolean): void {
    this.panel.classList.toggle('panel--collapsed', collapsed);
    this.toggle.setAttribute('aria-expanded', String(!collapsed));
    this.toggleLabel.textContent = collapsed ? 'Rozwiń panel' : 'Zwiń panel';
  }
}
