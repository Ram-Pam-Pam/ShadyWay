// Treść dymka z opisem odcinka trasy (po najechaniu lub kliknięciu na mapie): ulica, udział słońca, strona ulicy.

import type { RouteSegment } from '../../../shared/types.ts';
import { formatPercent, segmentKindLabel } from '../format.ts';
import { el } from '../util.ts';

export function describeSegment(segment: RouteSegment): HTMLElement {
  const kind = segmentKindLabel(segment.kind);
  const title = segment.name?.trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
  const side =
    segment.side &&
    el('p', 'segment__side', `Idź ${segment.side === 'left' ? 'lewą' : 'prawą'} stroną ulicy`);

  return el(
    'div',
    'segment',
    el('p', 'segment__title', title),
    el('p', 'segment__sun', `${formatPercent(segment.sunFraction)} w słońcu`),
    side,
  );
}
