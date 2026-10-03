// Formatowanie wartości dla interfejsu (po polsku) oraz wspólna skala barw cień ↔ słońce.

import type { LatLon, SegmentKind } from '../../shared/types.ts';

/** Skala barw odcinka trasy wg udziału słońca: 0 = cień (indygo), 1 = słońce (bursztyn). */
export const SUN_SCALE: ReadonlyArray<readonly [number, string]> = [
  [0, '#2d2a86'],
  [0.5, '#b86a96'],
  [1, '#f59e0b'],
];

/**
 * Skala w trybie zimowym („szukaj słońca”): słońce zostaje bursztynowe i wyraziste,
 * cień jest stonowany (chłodny szaroniebieski), żeby na mapie wybijały się odcinki nasłonecznione.
 */
export const SUN_SCALE_WINTER: ReadonlyArray<readonly [number, string]> = [
  [0, '#7f89ad'],
  [0.5, '#c9976a'],
  [1, '#f59e0b'],
];

export function routeColorScale(comfort: 'shade' | 'sun'): ReadonlyArray<readonly [number, string]> {
  return comfort === 'sun' ? SUN_SCALE_WINTER : SUN_SCALE;
}

/** Rampa nakładki LST po stronie serwera (odwrócona ColorBrewer RdYlBu) — do legendy. */
export const HEAT_RAMP: readonly string[] = [
  '#313695',
  '#4575b4',
  '#74add1',
  '#abd9e9',
  '#e0f3f8',
  '#ffffbf',
  '#fee090',
  '#fdae61',
  '#f46d43',
  '#d73027',
  '#a50026',
];

const SEGMENT_KIND_LABELS: Record<SegmentKind, string> = {
  sidewalk: 'chodnik',
  footway: 'droga dla pieszych',
  path: 'ścieżka',
  pedestrian: 'deptak',
  crossing: 'przejście dla pieszych',
  steps: 'schody',
  street: 'ulica bez wydzielonego chodnika',
  cycleway: 'droga dla rowerów',
  covered: 'przejście zadaszone',
};

const oneDecimal = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
const coordinate = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 5, maximumFractionDigits: 5 });

export function segmentKindLabel(kind: SegmentKind): string {
  return SEGMENT_KIND_LABELS[kind] ?? 'odcinek pieszy';
}

/** 850 → "850 m", 1234 → "1,2 km". */
export function formatDistance(metres: number): string {
  if (metres < 1000) {
    const rounded = metres < 100 ? Math.round(metres) : Math.round(metres / 10) * 10;
    if (rounded < 1000) return `${integer.format(rounded)} m`;
  }
  return `${oneDecimal.format(metres / 1000)} km`;
}

/** 930 s → "16 min", 3900 s → "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/** Ułamek 0..1 → "78%". */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

export function formatTemperature(celsius: number): string {
  return `${integer.format(Math.round(celsius))}°C`;
}

export function formatCoordinates(point: LatLon): string {
  return `${coordinate.format(point.lat)}; ${coordinate.format(point.lon)}`;
}

export function cssGradient(stops: readonly string[]): string {
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
