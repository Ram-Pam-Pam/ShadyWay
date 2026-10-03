// Zakładki panelu („Trasa” / „Asystent”). Pasek zakładek jest ukryty, dopóki nie zostanie włączona
// druga zakładka — punkt rozszerzenia dla panelu asystenta AI (zawartość: #assistant-panel).

import { byId } from '../util.ts';

export type PanelTab = 'plan' | 'assistant';

const TAB_ORDER: readonly PanelTab[] = ['plan', 'assistant'];

export class PanelTabs {
  private readonly bar = byId<HTMLElement>('panel-tabs');
  private readonly tabs: Record<PanelTab, HTMLButtonElement> = {
    plan: byId<HTMLButtonElement>('tab-plan'),
    assistant: byId<HTMLButtonElement>('tab-assistant'),
  };
  private readonly panels: Record<PanelTab, HTMLElement> = {
    plan: byId<HTMLElement>('plan-panel'),
    assistant: byId<HTMLElement>('assistant-panel'),
  };
  private active: PanelTab = 'plan';
  private readonly listeners = new Set<(tab: PanelTab) => void>();

  constructor() {
    for (const tab of TAB_ORDER) {
      this.tabs[tab].addEventListener('click', () => this.select(tab));
      this.tabs[tab].addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const enabled = TAB_ORDER.filter((name) => !this.tabs[name].hidden);
        const next = enabled[(enabled.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
        this.select(next);
        this.tabs[next].focus();
        event.preventDefault();
      });
    }
    this.sync();
  }

  /** Pokazuje pasek zakładek z zakładką „Asystent” (woła moduł asystenta, gdy jest gotowy). */
  enableAssistant(): void {
    this.tabs.assistant.hidden = false;
    this.bar.hidden = false;
    this.sync();
  }

  select(tab: PanelTab): void {
    if (this.tabs[tab].hidden || tab === this.active) return;
    this.active = tab;
    this.sync();
    for (const listener of this.listeners) listener(tab);
  }

  current(): PanelTab {
    return this.active;
  }

  onChange(listener: (tab: PanelTab) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sync(): void {
    for (const tab of TAB_ORDER) {
      const selected = tab === this.active;
      this.tabs[tab].setAttribute('aria-selected', String(selected));
      this.tabs[tab].tabIndex = selected ? 0 : -1;
      this.panels[tab].hidden = !selected;
    }
  }
}
