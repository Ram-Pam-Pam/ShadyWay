// Przycisk „Warstwy mapy” na mapie: wysuwane przełączniki (cienie, mapa ciepła, budynki 3D)
// oraz mała legenda mapy ciepła, widoczna tylko przy włączonej warstwie.

import { HEAT_RAMP, cssGradient, formatTemperature } from '../format.ts';
import type { AppState, LayerToggles } from '../store.ts';
import { byId } from '../util.ts';

export interface LayerPanelOptions {
  onToggle(layer: keyof LayerToggles, enabled: boolean): void;
}

type LayerViewState = Pick<AppState, 'layers' | 'heat'>;

export class LayerPanel {
  private readonly root = byId<HTMLElement>('layers');
  private readonly button = byId<HTMLButtonElement>('layers-button');
  private readonly popover = byId<HTMLElement>('layers-popover');
  private readonly shadows = byId<HTMLInputElement>('layer-shadows');
  private readonly heat = byId<HTMLInputElement>('layer-heat');
  private readonly buildings = byId<HTMLInputElement>('layer-buildings');
  private readonly heatLegend = byId<HTMLElement>('heat-legend');
  private readonly heatMin = byId<HTMLElement>('heat-min');
  private readonly heatMax = byId<HTMLElement>('heat-max');

  constructor(options: LayerPanelOptions) {
    byId<HTMLElement>('heat-legend-bar').style.background = cssGradient(HEAT_RAMP);
    const bind = (input: HTMLInputElement, layer: keyof LayerToggles): void => {
      input.addEventListener('change', () => options.onToggle(layer, input.checked));
    };
    bind(this.shadows, 'shadows');
    bind(this.heat, 'heat');
    bind(this.buildings, 'buildings3d');

    this.button.addEventListener('click', () => this.setOpen(this.button.getAttribute('aria-expanded') !== 'true'));
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.popover.hidden) return;
      this.setOpen(false);
      this.button.focus();
    });
    // Kliknięcie poza przyciskiem i listą (np. w mapę) zamyka listę.
    document.addEventListener('pointerdown', (event) => {
      if (!this.popover.hidden && event.target instanceof Node && !this.root.contains(event.target)) this.setOpen(false);
    });
  }

  /** Podkład mapy nie ma wysokości budynków — przełącznik 3D zostaje wyłączony. */
  disableBuildings(): void {
    this.buildings.disabled = true;
    this.buildings.checked = false;
    this.buildings.title = 'Podkład mapy nie zawiera wysokości budynków';
  }

  render(state: LayerViewState): void {
    this.shadows.checked = state.layers.shadows;
    this.buildings.checked = state.layers.buildings3d && !this.buildings.disabled;

    const heat = state.heat;
    const meta = heat.state === 'ready' ? heat.meta : null;
    this.heat.disabled = meta === null;
    this.heat.checked = meta !== null && state.layers.heat;
    this.heat.title = heat.state === 'unavailable' ? heat.reason : '';

    const showLegend = this.heat.checked && meta !== null;
    this.heatLegend.hidden = !showLegend;
    if (showLegend && meta) {
      const min = meta.minC !== undefined ? formatTemperature(meta.minC) : 'chłodniej';
      const max = meta.maxC !== undefined ? formatTemperature(meta.maxC) : 'cieplej';
      this.heatMin.textContent = min;
      this.heatMax.textContent = max;
      this.heatLegend.setAttribute('aria-label', `Temperatura powierzchni: od ${min} do ${max}`);
    }
  }

  private setOpen(open: boolean): void {
    this.popover.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
  }
}
