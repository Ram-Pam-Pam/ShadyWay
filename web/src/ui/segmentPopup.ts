// Treść dymka z opisem odcinka trasy (po najechaniu lub kliknięciu na mapie).

import type { RouteSegment } from '../../../shared/types.ts';
import { formatDistance, formatPercent, formatTemperature, segmentKindLabel } from '../format.ts';
import { surfaceLabel } from '../labels.ts';
import { el } from '../util.ts';

function row(label: string, value: string): HTMLElement {
  return el('div', 'segment__row', el('dt', '', label), el('dd', '', value));
}

export function describeSegment(segment: RouteSegment): HTMLElement {
  const kind = segmentKindLabel(segment.kind);
  const title = segment.name?.trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
  const details = el('dl', 'segment__details');
  if (segment.name?.trim()) details.append(row('Rodzaj', kind));
  details.append(
    row('W słońcu', formatPercent(segment.sunFraction)),
    row('Długość', formatDistance(segment.lengthM)),
  );
  if (segment.lstC !== null) details.append(row('Temp. powierzchni', formatTemperature(segment.lstC)));
  if (segment.kind === 'crossing' && segment.signals !== undefined) {
    details.append(row('Sygnalizacja', segment.signals ? 'światła' : 'bez świateł'));
  }
  const surface = surfaceLabel(segment.surface);
  if (surface) details.append(row('Nawierzchnia', surface));

  const side =
    segment.side &&
    el('p', 'segment__side', `Idź ${segment.side === 'left' ? 'lewą' : 'prawą'} stroną ulicy`);

  return el('div', 'segment', el('p', 'segment__title', title), details, side);
}
