// Karta „Preferencje trasy”: profil poruszania się, tryb komfortu (cień / słońce / auto),
// suwak siły preferencji i przełącznik „Przez punkt chłodu”.

import type { ComfortMode, MobilityProfile } from '../../../shared/types.ts';
import {
  COMFORT_CHOICES,
  MOBILITY_CHOICES,
  autoComfortBadge,
  comfortTexts,
  preferenceLabel,
  type Choice,
} from '../labels.ts';
import { effectiveComfort, type AppState } from '../store.ts';
import { byId, el } from '../util.ts';
import { icon, type IconName } from './icons.ts';

export interface PreferencesControlOptions {
  onMobility(mobility: MobilityProfile): void;
  onComfort(comfort: ComfortMode): void;
  onPreference(preference: number): void;
  onViaCoolSpot(enabled: boolean): void;
}

type PreferencesViewState = Pick<
  AppState,
  'mobility' | 'comfort' | 'viaCoolSpot' | 'shadePreference' | 'response' | 'weather'
>;

const MOBILITY_ICONS: Record<MobilityProfile, IconName> = { default: 'walk', accessible: 'wheelchair', senior: 'senior' };
const COMFORT_ICONS: Record<ComfortMode, IconName> = { auto: 'auto', shade: 'shade', sun: 'sun' };

/** Buduje przełącznik segmentowy z natywnych pól radio (strzałki i czytniki ekranu działają bez dodatkowego kodu). */
function buildSegmented<T extends string>(
  container: HTMLElement,
  name: string,
  choices: ReadonlyArray<Choice<T>>,
  icons: Record<T, IconName>,
  onChange: (value: T) => void,
): Map<T, HTMLInputElement> {
  const inputs = new Map<T, HTMLInputElement>();
  for (const choice of choices) {
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = choice.value;
    input.addEventListener('change', () => {
      if (input.checked) onChange(choice.value);
    });
    const label = el(
      'label',
      'segmented__option',
      input,
      el('span', 'segmented__face', icon(icons[choice.value]), el('span', 'segmented__label', choice.label)),
    );
    label.title = choice.hint;
    container.append(label);
    inputs.set(choice.value, input);
  }
  return inputs;
}

export class PreferencesControl {
  private readonly mobilityInputs: Map<MobilityProfile, HTMLInputElement>;
  private readonly comfortInputs: Map<ComfortMode, HTMLInputElement>;
  private readonly comfortBadge = byId<HTMLElement>('comfort-badge');
  private readonly prefTitle = byId<HTMLElement>('pref-title');
  private readonly slider = byId<HTMLInputElement>('pref-slider');
  private readonly readout = byId<HTMLOutputElement>('pref-readout');
  private readonly sliderMax = byId<HTMLElement>('pref-max-label');
  private readonly sliderLabel = byId<HTMLElement>('pref-slider-label');
  private readonly via = byId<HTMLInputElement>('via-coolspot');

  constructor(options: PreferencesControlOptions) {
    this.mobilityInputs = buildSegmented(
      byId<HTMLElement>('mobility-options'),
      'mobility',
      MOBILITY_CHOICES,
      MOBILITY_ICONS,
      options.onMobility,
    );
    this.comfortInputs = buildSegmented(
      byId<HTMLElement>('comfort-options'),
      'comfort',
      COMFORT_CHOICES,
      COMFORT_ICONS,
      options.onComfort,
    );
    this.slider.addEventListener('input', () => options.onPreference(Number(this.slider.value)));
    this.via.addEventListener('change', () => options.onViaCoolSpot(this.via.checked));
  }

  render(state: PreferencesViewState): void {
    for (const [value, input] of this.mobilityInputs) input.checked = value === state.mobility;
    for (const [value, input] of this.comfortInputs) input.checked = value === state.comfort;
    this.via.checked = state.viaCoolSpot;

    const applied = effectiveComfort(state);
    const texts = comfortTexts(applied);
    this.prefTitle.textContent = texts.prefTitle;
    this.sliderMax.textContent = texts.sliderMax;
    this.sliderLabel.textContent = applied === 'sun' ? 'Preferencja słońca' : 'Preferencja cienia';

    this.slider.value = String(state.shadePreference);
    const label = preferenceLabel(state.shadePreference, applied);
    this.readout.textContent = label;
    this.slider.setAttribute('aria-valuetext', label);

    const badge = autoComfortBadge(state.comfort, state.response?.comfort, state.response?.weather ?? state.weather);
    this.comfortBadge.hidden = badge === null;
    if (badge !== null) {
      this.comfortBadge.replaceChildren(icon(applied === 'sun' ? 'sun' : 'shade'), el('span', '', badge));
      this.comfortBadge.dataset.applied = applied;
    }
  }
}
