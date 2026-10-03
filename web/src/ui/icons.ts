// Ikony interfejsu jako wbudowane SVG (siatka 20×20, kreska w kolorze tekstu).

import type { CoolSpotKind, ManeuverType } from '../../../shared/types.ts';

const ICONS = {
  walk: '<circle cx="11" cy="3.4" r="1.6" class="fill"/><path d="M11 7l-2 4 2.6 2.4V18M9 11l-1.6 6.5M11 7.4l2.6 2.2 2.4.4M10.4 7.2L7.4 8.6 6.6 11"/>',
  wheelchair: '<circle cx="8" cy="3.4" r="1.5" class="fill"/><path d="M8 6.5v5h4.2l2 4.3h1.8"/><path d="M6 9.6a4.6 4.6 0 1 0 6.3 5.6"/>',
  senior: '<circle cx="9" cy="3.5" r="1.6" class="fill"/><path d="M9 7c-1.4 1-2 2.4-2 4l2.2 2v5M7 11.5L5.8 18M9.4 8l2.4 2.6h2.4M14.4 10.6V18"/>',
  auto: '<circle cx="10" cy="10" r="4.6"/><path d="M10 5.4a4.6 4.6 0 0 1 0 9.2z" class="fill"/><path d="M10 1.6v1.6M10 16.8v1.6M1.6 10h1.6M16.8 10h1.6"/>',
  shade: '<path d="M3 17V8.2l5-3.6 5 3.6V17z" class="fill"/><path d="M13 17v-5.4l4.6 5.4z" class="fill" opacity=".5"/>',
  sun: '<circle cx="10" cy="10" r="3.6" class="fill"/><path d="M10 1.8v2.2M10 16v2.2M1.8 10H4M16 10h2.2M4.2 4.2l1.6 1.6M14.2 14.2l1.6 1.6M4.2 15.8l1.6-1.6M14.2 5.8l1.6-1.6"/>',
  drinking_water: '<path d="M10 2.6c3 3.6 5 6.2 5 8.7a5 5 0 0 1-10 0c0-2.5 2-5.1 5-8.7z"/>',
  fountain: '<path d="M3 13h14l-1.5 4h-11zM10 13V6M10 6C8.6 3.8 6 4 5.6 6.6M10 6c1.4-2.2 4-2 4.4.6"/>',
  water_mist: '<path d="M3.5 7.5c1.6-1.5 3.2-1.5 4.8 0s3.2 1.5 4.8 0 2.4-1 3.4-.4M3.5 11.5c1.6-1.5 3.2-1.5 4.8 0s3.2 1.5 4.8 0 2.4-1 3.4-.4M6 16h.01M10 16h.01M14 16h.01"/>',
  bench: '<path d="M3 9h14M3 12h14M5 12v5M15 12v5M4 9V6M16 9V6"/>',
  park: '<path d="M10 18v-6.4"/><path d="M10 2.6c3 0 5 2.1 5 4.8s-2 4.4-5 4.4-5-1.7-5-4.4 2-4.8 5-4.8z"/>',
  shelter: '<path d="M2.5 9L10 3.6 17.5 9M5 8v9M15 8v9M5 13h10"/>',
  arrow: '<path d="M10 17V4M10 4L5 9M10 4l5 5"/>',
  uturn: '<path d="M6 17V8a4 4 0 0 1 8 0v6M14 14l-3-3M14 14l3-3"/>',
  cross: '<path d="M4 4v12M8 4v12M12 4v12M16 4v12"/>',
  stairs: '<path d="M3 17h4v-4h4V9h4V5h2"/>',
  flag: '<path d="M5 18V3M5 4h10l-2.5 3.5L15 11H5"/>',
  depart: '<circle cx="10" cy="10" r="3.4" class="fill"/><circle cx="10" cy="10" r="7.2"/>',
  signal: '<rect x="6.5" y="2" width="7" height="16" rx="2.5"/><circle cx="10" cy="6" r="1.2" class="fill"/><circle cx="10" cy="10" r="1.2" class="fill"/><circle cx="10" cy="14" r="1.2" class="fill"/>',
  clock: '<circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3 2"/>',
  nav: '<path d="M10 2.6l6 14.4-6-3.4-6 3.4z"/>',
  thermo: '<path d="M8 11.4V4a2 2 0 0 1 4 0v7.4a3.6 3.6 0 1 1-4 0z"/><path d="M10 8v6"/>',
  leaf: '<path d="M4 16c0-7 4-11 12-12 0 8-4 12-11 12zM4 16l6-6"/>',
  height: '<path d="M4 17V7.4l6-4.2 6 4.2V17zM8 17v-4h4v4"/>',
  sparkle: '<path d="M9 2.5l1.5 4.2a2 2 0 0 0 1.2 1.2L16 9.5l-4.3 1.6a2 2 0 0 0-1.2 1.2L9 16.5l-1.5-4.2a2 2 0 0 0-1.2-1.2L2 9.5l4.3-1.6a2 2 0 0 0 1.2-1.2z" class="fill"/><path d="M16 2v3M14.5 3.5h3M16.5 14.5v3M15 16h3"/>',
  mic: '<rect x="7.4" y="2.2" width="5.2" height="9.6" rx="2.6"/><path d="M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.8M7 17.8h6"/>',
  send: '<path d="M10 16.5V4M10 4L5 9M10 4l5 5"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.8" class="fill"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
  retry: '<path d="M16 10a6 6 0 1 1-2-4.5M16 3.5v3.2h-3.2"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  volume: '<path d="M3.5 8v4h2.8L10 15V5L6.3 8z" class="fill"/><path d="M12.6 7.4a3.6 3.6 0 0 1 0 5.2M14.8 5.2a6.8 6.8 0 0 1 0 9.6"/>',
  mute: '<path d="M3.5 8v4h2.8L10 15V5L6.3 8z" class="fill"/><path d="M13 8l4 4M17 8l-4 4"/>',
  compass: '<circle cx="10" cy="10" r="7.6"/><path d="M10 4.6l2.2 5.4H7.8z" class="fill"/><path d="M7.8 10L10 15.4 12.2 10z"/>',
  target: '<circle cx="10" cy="10" r="5.2"/><circle cx="10" cy="10" r="1.6" class="fill"/><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3"/>',
  download: '<path d="M10 3v9.5M10 12.5l-4-4M10 12.5l4-4M4 16.5h12"/>',
  offline: '<path d="M2.5 8.2a11 11 0 0 1 4-2.4M17.5 8.2a11 11 0 0 0-6.4-3M5.4 11.4a7 7 0 0 1 3-1.7M14.6 11.4a7 7 0 0 0-1.6-1.1M3 3l14 14"/><circle cx="10" cy="15" r="1.2" class="fill"/>',
} as const;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Ikona dekoracyjna (aria-hidden) — znaczenie niesie zawsze tekst obok albo aria-label elementu nadrzędnego. */
export function icon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className ? `icon ${className}` : 'icon');
  svg.innerHTML = ICONS[name]; // stałe z tego pliku, nigdy dane z sieci
  return svg;
}

export function coolSpotIcon(kind: CoolSpotKind): IconName {
  return kind in ICONS ? (kind as IconName) : 'drinking_water';
}

/** Kąt obrotu strzałki dla manewrów „skrętnych” (0° = prosto). */
const ARROW_ROTATION: Partial<Record<ManeuverType, number>> = {
  continue: 0,
  slight_right: 45,
  right: 90,
  sharp_right: 135,
  slight_left: -45,
  left: -90,
  sharp_left: -135,
};

const MANEUVER_ICONS: Partial<Record<ManeuverType, IconName>> = {
  depart: 'depart',
  arrive: 'flag',
  uturn: 'uturn',
  cross: 'cross',
  stairs: 'stairs',
};

export function maneuverIcon(maneuver: ManeuverType): SVGSVGElement {
  const special = MANEUVER_ICONS[maneuver];
  if (special) return icon(special);
  const arrow = icon('arrow');
  const rotation = ARROW_ROTATION[maneuver] ?? 0;
  if (rotation !== 0) arrow.style.transform = `rotate(${rotation}deg)`;
  return arrow;
}
