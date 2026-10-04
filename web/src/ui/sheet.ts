// Panel boczny (desktop) / dolny arkusz (telefon): zwijanie oraz margines mapy pod arkuszem.

import type { PaddingOptions } from 'maplibre-gl';
import { byId } from '../util.ts';

const MOBILE_QUERY = '(max-width: 719px)';
const MAP_EDGE_PADDING = 56;
/** U góry mapy zostaje miejsce na znacznik (czubek w punkcie, reszta nad nim) i komunikat warstwy cieni. */
const MAP_TOP_PADDING = 92;
/** Ruch palca poniżej tej wartości to stuknięcie, nie przeciągnięcie. */
const TAP_SLOP_PX = 6;
/** Przeciągnięcie o co najmniej tyle przełącza arkusz; krótsze wraca na miejsce. */
const SNAP_DISTANCE_PX = 70;
/** Szybki ruch (px/ms) przełącza arkusz w swoim kierunku niezależnie od przebytej drogi. */
const FLICK_SPEED = 0.5;
const SNAP_MS = 220;

interface Drag {
  pointerId: number;
  /** Położenie palca, przy którym arkusz byłby w pełni rozwinięty. */
  originY: number;
  downY: number;
  lastY: number;
  lastT: number;
  speed: number;
  /** Na ile arkusz może zjechać w dół: wszystko poza uchwytem. */
  travel: number;
  startedCollapsed: boolean;
  moved: boolean;
}

export class Sheet {
  private readonly panel = byId<HTMLElement>('panel');
  private readonly toggle = byId<HTMLButtonElement>('sheet-toggle');
  private readonly toggleLabel = byId<HTMLElement>('sheet-toggle-label');
  private readonly summary = byId<HTMLElement>('sheet-summary');
  private readonly mapWrap = byId<HTMLElement>('map-wrap');
  private readonly mobile = window.matchMedia(MOBILE_QUERY);
  private drag: Drag | null = null;
  private settleTimer = 0;

  constructor() {
    // Klawiatura i czytniki ekranu (click bez wskaźnika) przełączają arkusz; palcem i myszą arkusz się przeciąga.
    this.toggle.addEventListener('click', (event) => {
      if (event.detail === 0) this.setCollapsed(!this.isCollapsed());
    });
    this.toggle.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.toggle.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.toggle.addEventListener('pointerup', (event) => this.onPointerEnd(event));
    this.toggle.addEventListener('pointercancel', (event) => this.onPointerEnd(event));

    const sync = (): void => {
      // Na telefonie kontrolki mapy (skala, atrybucja) podnosimy ponad arkusz.
      const height = this.mobile.matches ? this.panel.offsetHeight : 0;
      this.mapWrap.style.setProperty('--sheet-height', `${height}px`);
    };
    new ResizeObserver(sync).observe(this.panel);
    this.mobile.addEventListener('change', () => {
      if (!this.mobile.matches) {
        this.clearOffset();
        this.setCollapsed(false);
      }
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
      bottom: sheet + (this.mobile.matches ? 40 : MAP_EDGE_PADDING),
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

  // ───────────── przeciąganie uchwytu ─────────────

  private setOffset(px: number, animate: boolean): void {
    this.panel.style.transition = animate ? `transform ${SNAP_MS}ms ease` : 'none';
    this.panel.style.transform = px > 0 ? `translateY(${px}px)` : 'none';
  }

  private clearOffset(): void {
    window.clearTimeout(this.settleTimer);
    this.panel.style.transition = '';
    this.panel.style.transform = '';
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.mobile.matches || this.drag) return;
    this.clearOffset();
    const startedCollapsed = this.isCollapsed();
    // Zwinięty arkusz rozwijamy od razu, ale zsunięty w dół — treść wyjeżdża spod krawędzi razem z palcem.
    if (startedCollapsed) this.setCollapsed(false);
    const travel = Math.max(0, this.panel.offsetHeight - this.toggle.offsetHeight);
    if (startedCollapsed) this.setOffset(travel, false);
    this.drag = {
      pointerId: event.pointerId,
      originY: event.clientY - (startedCollapsed ? travel : 0),
      downY: event.clientY,
      lastY: event.clientY,
      lastT: event.timeStamp,
      speed: 0,
      travel,
      startedCollapsed,
      moved: false,
    };
    this.toggle.setPointerCapture(event.pointerId);
  }

  private offsetAt(drag: Drag, clientY: number): number {
    return Math.min(drag.travel, Math.max(0, clientY - drag.originY));
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (Math.abs(event.clientY - drag.downY) > TAP_SLOP_PX) drag.moved = true;
    const dt = event.timeStamp - drag.lastT;
    if (dt > 0) drag.speed = (event.clientY - drag.lastY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = event.timeStamp;
    this.setOffset(this.offsetAt(drag, event.clientY), false);
  }

  private onPointerEnd(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    const offset = this.offsetAt(drag, event.clientY);

    let collapsed: boolean;
    if (!drag.moved) {
      // Stuknięcie: zwinięty arkusz się rozwija, rozwinięty zostaje na miejscu.
      collapsed = false;
    } else if (Math.abs(drag.speed) > FLICK_SPEED) {
      collapsed = drag.speed > 0;
    } else if (drag.startedCollapsed) {
      collapsed = drag.travel - offset < SNAP_DISTANCE_PX;
    } else {
      collapsed = offset > SNAP_DISTANCE_PX;
    }

    // Dosuwamy animacją do krawędzi, a dopiero potem zmieniamy stan (zwinięcie chowa treść arkusza).
    this.setOffset(collapsed ? drag.travel : 0, true);
    this.settleTimer = window.setTimeout(() => {
      this.setCollapsed(collapsed);
      this.clearOffset();
    }, SNAP_MS);
  }
}
