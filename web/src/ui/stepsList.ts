// Lista wskazówek dla wybranej trasy: manewr, instrukcja, dystans i nasłonecznienie kroku.
// Najechanie lub fokus podświetla miejsce manewru na mapie; kliknięcie przypina podświetlenie i przesuwa mapę.

import type { RouteStep } from '../../../shared/types.ts';
import { formatDistance, formatPercent } from '../format.ts';
import { el } from '../util.ts';
import { maneuverIcon } from './icons.ts';

function shadeHint(sunFraction: number): { className: string; text: string } {
  const sun = Math.max(0, Math.min(1, sunFraction));
  if (sun <= 0.25) return { className: 'step__dot--shade', text: 'w cieniu' };
  if (sun >= 0.75) return { className: 'step__dot--sun', text: 'w słońcu' };
  return { className: 'step__dot--mixed', text: `${formatPercent(1 - sun)} w cieniu` };
}

/** @param onHighlight `pan` = przesuń mapę do kroku (kliknięcie); null = zdejmij podświetlenie. */
export function createStepsList(
  steps: readonly RouteStep[],
  onHighlight: (step: RouteStep | null, pan: boolean) => void,
): HTMLOListElement {
  let pinned: HTMLButtonElement | null = null;

  const items = steps.map((step) => {
    const hint = shadeHint(step.sunFraction);
    const dot = el('span', `step__dot ${hint.className}`);
    dot.title = hint.text;
    const meta = el(
      'span',
      'step__meta',
      step.distanceM > 0 ? formatDistance(step.distanceM) : null,
      dot,
      el('span', 'visually-hidden', hint.text),
    );
    const button = el(
      'button',
      'step',
      el('span', 'step__icon', maneuverIcon(step.maneuver)),
      el('span', 'step__text', step.text),
      meta,
    );
    button.type = 'button';

    const show = (): void => onHighlight(step, false);
    const restore = (): void => {
      if (pinned === button) return;
      // Po zjechaniu z kroku wraca podświetlenie przypiętego kroku (albo żadne).
      if (pinned) pinned.dispatchEvent(new CustomEvent('cien:restore'));
      else onHighlight(null, false);
    };
    button.addEventListener('mouseenter', show);
    button.addEventListener('focus', show);
    button.addEventListener('mouseleave', restore);
    button.addEventListener('blur', restore);
    button.addEventListener('cien:restore', show);
    button.addEventListener('click', () => {
      if (pinned === button) {
        pinned = null;
        button.removeAttribute('aria-current');
        onHighlight(null, false);
        return;
      }
      pinned?.removeAttribute('aria-current');
      pinned = button;
      button.setAttribute('aria-current', 'step');
      onHighlight(step, true);
    });
    return el('li', '', button);
  });

  const list = el('ol', 'steps', ...items);
  list.setAttribute('aria-label', 'Wskazówki');
  return list;
}
