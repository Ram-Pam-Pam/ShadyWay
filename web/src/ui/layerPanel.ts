// Przełączniki warstw mapy: cienie, mapa ciepła (LST) z legendą, punkty chłodu, budynki 3D.

import { HEAT_RAMP, cssGradient, formatTemperature } from '../format.ts';
import type { AppState, LayerToggles } from '../store.ts';
import { byId } from '../util.ts';

const HEAT_NOTE_DEFAULT = 'Satelitarna temperatura powierzchni';
const COOL_SPOTS_NOTE_DEFAULT = 'Woda pitna, fontanny, ławki, parki i wiaty';

export interface LayerPanelOptions {
  onToggle(layer: keyof LayerToggles, enabled: boolean): void;
}

type LayerViewState = Pick<AppState, 'layers' | 'heat' | 'coolSpotLayer'>;

export class LayerPanel {
  private readonly shadows = byId<HTMLInputElement>('layer-shadows');
  private readonly heat = byId<HTMLInputElement>('layer-heat');
  private readonly buildings = byId<HTMLInputElement>('layer-buildings');
  private readonly coolSpots = byId<HTMLInputElement>('layer-coolspots');
  private readonly coolSpotsNote = byId<HTMLElement>('layer-coolspots-note');
  private readonly heatNote = byId<HTMLElement>('layer-heat-note');
  private readonly buildingsNote = byId<HTMLElement>('layer-buildings-note');
  private readonly heatLegend = byId<HTMLElement>('heat-legend');
  private readonly heatMin = byId<HTMLElement>('heat-min');
  private readonly heatMax = byId<HTMLElement>('heat-max');
  private readonly heatSource = byId<HTMLElement>('heat-source');

  constructor(options: LayerPanelOptions) {
    byId<HTMLElement>('heat-legend-bar').style.background = cssGradient(HEAT_RAMP);
    const bind = (input: HTMLInputElement, layer: keyof LayerToggles): void => {
      input.addEventListener('change', () => options.onToggle(layer, input.checked));
    };
    bind(this.shadows, 'shadows');
    bind(this.heat, 'heat');
    bind(this.coolSpots, 'coolSpots');
    bind(this.buildings, 'buildings3d');
  }

  /** Podkład mapy nie ma wysokości budynków — przełącznik 3D zostaje wyłączony z wyjaśnieniem. */
  disableBuildings(): void {
    this.buildings.disabled = true;
    this.buildings.checked = false;
    this.buildingsNote.textContent = 'Podkład mapy nie zawiera wysokości budynków';
  }

  render(state: LayerViewState): void {
    this.shadows.checked = state.layers.shadows;
    this.buildings.checked = state.layers.buildings3d && !this.buildings.disabled;
    this.coolSpots.checked = state.layers.coolSpots;
    this.coolSpotsNote.textContent = (state.layers.coolSpots && state.coolSpotLayer.note) || COOL_SPOTS_NOTE_DEFAULT;

    const heat = state.heat;
    const available = heat.state === 'ready';
    this.heat.disabled = !available;
    this.heat.checked = available && state.layers.heat;
    if (heat.state === 'loading') this.heatNote.textContent = 'Sprawdzam dostępność danych…';
    else if (heat.state === 'unavailable') this.heatNote.textContent = heat.reason;
    else this.heatNote.textContent = HEAT_NOTE_DEFAULT;

    const meta = available ? heat.meta : null;
    const showLegend = this.heat.checked && meta !== null;
    this.heatLegend.hidden = !showLegend;
    if (showLegend && meta) {
      this.heatMin.textContent = meta.minC !== undefined ? formatTemperature(meta.minC) : 'chłodniej';
      this.heatMax.textContent = meta.maxC !== undefined ? formatTemperature(meta.maxC) : 'cieplej';
      this.heatSource.textContent = meta.source ? `Źródło: ${meta.source}` : '';
    }
  }
}
