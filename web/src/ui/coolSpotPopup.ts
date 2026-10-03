// Znacznik i dymek punktu chłodu na mapie (woda pitna, fontanna, kurtyna wodna, ławka, park, wiata).

import type { CoolSpot } from '../../../shared/types.ts';
import type { CoolSpotRole } from '../coolSpots.ts';
import { coolSpotKindLabel, coolSpotShadeLabel, coolSpotTitle } from '../labels.ts';
import type { EndpointKey } from '../store.ts';
import { el } from '../util.ts';
import { coolSpotIcon, icon } from './icons.ts';

export interface CoolSpotPopupActions {
  /** Ustawia punkt jako start albo cel trasy. */
  onUseAs(which: EndpointKey, spot: CoolSpot): void;
}

function roleNote(role: CoolSpotRole): string | null {
  if (role === 'via') return 'Trasa prowadzi przez ten punkt';
  if (role === 'route') return 'Przy wybranej trasie';
  return null;
}

/** Opis znacznika dla czytnika ekranu i podpowiedzi. */
export function coolSpotAriaLabel(spot: CoolSpot, role: CoolSpotRole): string {
  const title = coolSpotTitle(spot);
  const kind = coolSpotKindLabel(spot.kind);
  return [title === kind ? kind : `${kind}: ${title}`, coolSpotShadeLabel(spot.shaded), roleNote(role)]
    .filter(Boolean)
    .join(', ');
}

/** Element znacznika: okrągły przycisk z ikoną rodzaju; obwódka mówi, czy punkt jest w cieniu. */
export function createCoolSpotElement(spot: CoolSpot, role: CoolSpotRole): HTMLButtonElement {
  const state = spot.shaded === undefined ? 'unknown' : spot.shaded ? 'shaded' : 'sunny';
  const button = el('button', `spot spot--${spot.kind} spot--${state} spot--${role}`, icon(coolSpotIcon(spot.kind)));
  button.type = 'button';
  const label = coolSpotAriaLabel(spot, role);
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

export function describeCoolSpot(spot: CoolSpot, role: CoolSpotRole, actions: CoolSpotPopupActions): HTMLElement {
  const title = coolSpotTitle(spot);
  const kind = coolSpotKindLabel(spot.kind);
  const shade = coolSpotShadeLabel(spot.shaded);
  const note = roleNote(role);

  const action = (text: string, which: EndpointKey): HTMLButtonElement => {
    const button = el('button', 'chip-button', text);
    button.type = 'button';
    button.addEventListener('click', () => actions.onUseAs(which, spot));
    return button;
  };

  return el(
    'div',
    'segment spot-popup',
    el('p', 'segment__title', title),
    el(
      'p',
      'spot-popup__meta',
      title === kind ? null : el('span', '', kind),
      shade && el('span', `spot-popup__shade spot-popup__shade--${spot.shaded ? 'shaded' : 'sunny'}`, shade),
    ),
    note && el('p', role === 'via' ? 'segment__side' : 'spot-popup__note', note),
    el('div', 'spot-popup__actions', action('Ustaw jako cel', 'to'), action('Ustaw jako start', 'from')),
  );
}
