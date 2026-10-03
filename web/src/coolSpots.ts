// Punkty chłodu na mapie: które pokazać i w jakiej roli (czysta logika, bez DOM).

import type { CoolSpot, CoolSpotKind, RouteResult } from '../../shared/types.ts';

/** Poniżej tego przybliżenia warstwa „Punkty chłodu” nie pobiera danych. */
export const COOL_SPOT_MIN_ZOOM = 15;
/** Najwyżej tyle znaczników warstwy naraz (znaczniki to elementy DOM). */
export const COOL_SPOT_LAYER_CAP = 120;

/** 'via' — punkt, przez który poprowadzono trasę; 'route' — przy wybranej trasie; 'layer' — z warstwy mapy. */
export type CoolSpotRole = 'via' | 'route' | 'layer';

export interface CoolSpotMarker {
  spot: CoolSpot;
  role: CoolSpotRole;
}

/** Przy nadmiarze najpierw zostają punkty z wodą, na końcu ławki (jest ich najwięcej). */
const KIND_PRIORITY: Record<CoolSpotKind, number> = {
  drinking_water: 0,
  water_mist: 1,
  fountain: 2,
  shelter: 3,
  park: 4,
  bench: 5,
};

function priority(kind: CoolSpotKind): number {
  return KIND_PRIORITY[kind] ?? 9;
}

function isValidSpot(spot: CoolSpot | null | undefined): spot is CoolSpot {
  return (
    !!spot && typeof spot.id === 'string' && Number.isFinite(spot.lat) && Number.isFinite(spot.lon) && typeof spot.kind === 'string'
  );
}

/** Ogranicza listę do `max` punktów wg ważności rodzaju (kolejność w obrębie rodzaju zostaje). */
export function capCoolSpots(spots: readonly CoolSpot[], max: number = COOL_SPOT_LAYER_CAP): { spots: CoolSpot[]; total: number } {
  const valid = spots.filter(isValidSpot);
  if (valid.length <= max) return { spots: valid, total: valid.length };
  const ranked = valid
    .map((spot, index) => ({ spot, index }))
    .sort((a, b) => priority(a.spot.kind) - priority(b.spot.kind) || a.index - b.index)
    .slice(0, Math.max(0, max));
  return { spots: ranked.map((entry) => entry.spot), total: valid.length };
}

/**
 * Znaczniki do narysowania: punkt „via” i punkty przy wybranej trasie mają pierwszeństwo
 * przed tym samym punktem z warstwy mapy (każde id tylko raz).
 */
export function coolSpotMarkers(
  route: Pick<RouteResult, 'coolSpots' | 'via'> | null,
  layerSpots: readonly CoolSpot[],
): CoolSpotMarker[] {
  const markers: CoolSpotMarker[] = [];
  const seen = new Set<string>();
  const add = (spot: CoolSpot | null | undefined, role: CoolSpotRole): void => {
    if (!isValidSpot(spot) || seen.has(spot.id)) return;
    seen.add(spot.id);
    markers.push({ spot, role });
  };
  add(route?.via, 'via');
  for (const spot of route?.coolSpots ?? []) add(spot, 'route');
  for (const spot of layerSpots) add(spot, 'layer');
  return markers;
}

/** Klucz znacznika: zmiana roli lub stanu cienia wymaga narysowania go od nowa. */
export function coolSpotMarkerKey(marker: CoolSpotMarker): string {
  const shade = marker.spot.shaded === undefined ? 'u' : marker.spot.shaded ? 's' : 'n';
  return `${marker.role}:${marker.spot.id}:${shade}`;
}

/** Komunikat pod przełącznikiem warstwy. */
export function coolSpotLayerNote(shown: number, total: number): string | null {
  if (total === 0) return 'Brak punktów chłodu w tym widoku (dane pojawiają się po wyznaczeniu trasy w okolicy)';
  if (shown < total) return `Pokazuję ${shown} z ${total} — przybliż mapę, aby zobaczyć wszystkie`;
  return null;
}
