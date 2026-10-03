// Karta preferencji: jeden suwak (najkrótsza ↔ najwięcej cienia) i profil poruszania się.

import type { MobilityProfile } from '../../../shared/types.ts';
import { MOBILITY_CHOICES, comfortTexts, preferenceLabel } from '../labels.ts';
import { effectiveComfort, type AppState } from '../store.ts';
import { byId, el } from '../util.ts';
import { icon, type IconName } from './icons.ts';

export interface PreferencesControlOptions {
  onMobility(mobility: MobilityProfile): void;
  onPreference(preference: number): void;
}

type PreferencesViewState = Pick<AppState, 'mobility' | 'shadePreference' | 'response'>;

const MOBILITY_ICONS: Record<MobilityProfile, IconName> = { default: 'walk', accessible: 'wheelchair', senior: 'senior' };

export class PreferencesControl {
  private readonly mobilityInputs = new Map<MobilityProfile, HTMLInputElement>();
  private readonly slider = byId<HTMLInputElement>('pref-slider');
  private readonly sliderMax = byId<HTMLElement>('pref-max-label');
  private readonly sliderLabel = byId<HTMLElement>('pref-slider-label');
  private readonly winterTag = byId<HTMLElement>('winter-tag');

  constructor(options: PreferencesControlOptions) {
    // Natywne pola radio: strzałki i czytniki ekranu działają bez dodatkowego kodu.
    const container = byId<HTMLElement>('mobility-options');
    for (const choice of MOBILITY_CHOICES) {
      const input = el('input');
      input.type = 'radio';
      input.name = 'mobility';
      input.value = choice.value;
      input.addEventListener('change', () => {
        if (input.checked) options.onMobility(choice.value);
      });
      const label = el(
        'label',
        'segmented__option',
        input,
        el('span', 'segmented__face', icon(MOBILITY_ICONS[choice.value]), el('span', '', choice.label)),
      );
      label.title = choice.hint;
      container.append(label);
      this.mobilityInputs.set(choice.value, input);
    }
    this.slider.addEventListener('input', () => options.onPreference(Number(this.slider.value)));
  }

  render(state: PreferencesViewState): void {
    for (const [value, input] of this.mobilityInputs) input.checked = value === state.mobility;

    const applied = effectiveComfort(state);
    this.sliderMax.textContent = comfortTexts(applied).sliderMax;
    this.sliderLabel.textContent = applied === 'sun' ? 'Preferencja słońca' : 'Preferencja cienia';
    this.winterTag.hidden = applied !== 'sun';

    this.slider.value = String(state.shadePreference);
    this.slider.setAttribute('aria-valuetext', preferenceLabel(state.shadePreference, applied));
  }
}
