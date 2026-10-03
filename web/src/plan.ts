// Zamiana planu asystenta AI (AssistantPlan) na zmianę stanu aplikacji. Pola nieobecne w planie = bez zmian.

import { KRAKOW_BBOX, type AssistantPlan, type LatLon } from '../../shared/types.ts';
import { parseComfort, parseMobility } from './hash.ts';
import type { AppState, Place } from './store.ts';
import { instantToWallTime } from './time.ts';

export type PlanPatch = Partial<
  Pick<
    AppState,
    | 'from'
    | 'to'
    | 'pickTarget'
    | 'date'
    | 'minutes'
    | 'followNow'
    | 'shadePreference'
    | 'mobility'
    | 'comfort'
    | 'viaCoolSpot'
    | 'selectedProfile'
    | 'formError'
  >
>;

export function inServiceArea(point: LatLon): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= KRAKOW_BBOX.south &&
    point.lat <= KRAKOW_BBOX.north &&
    point.lon >= KRAKOW_BBOX.west &&
    point.lon <= KRAKOW_BBOX.east
  );
}

function planPlace(value: (LatLon & { label: string }) | undefined): Place | null {
  if (!value || !inServiceArea(value)) return null;
  return { lat: value.lat, lon: value.lon, label: String(value.label ?? '').trim() || 'Punkt z asystenta' };
}

/** Nieprawidłowe pola planu (punkt poza Krakowem, błędna data) są pomijane, reszta planu obowiązuje. */
export function planToPatch(plan: AssistantPlan, current: Pick<AppState, 'from' | 'to'>): PlanPatch {
  const patch: PlanPatch = {};
  const from = planPlace(plan.from);
  const to = planPlace(plan.to);
  if (from) patch.from = from;
  if (to) patch.to = to;
  if (from || to) {
    const nextFrom = from ?? current.from;
    const nextTo = to ?? current.to;
    patch.pickTarget = !nextFrom ? 'from' : !nextTo ? 'to' : null;
    patch.formError = null;
  }
  if (plan.time) {
    const instant = new Date(plan.time);
    if (!Number.isNaN(instant.getTime())) {
      const wall = instantToWallTime(instant);
      patch.date = wall.date;
      patch.minutes = wall.minutes;
      patch.followNow = false;
    }
  }
  if (typeof plan.shadePreference === 'number' && Number.isFinite(plan.shadePreference)) {
    patch.shadePreference = Math.min(1, Math.max(0, plan.shadePreference));
  }
  const mobility = parseMobility(plan.mobility);
  if (mobility) patch.mobility = mobility;
  const comfort = parseComfort(plan.comfort);
  if (comfort) patch.comfort = comfort;
  if (typeof plan.viaCoolSpot === 'boolean') patch.viaCoolSpot = plan.viaCoolSpot;
  if (plan.selectProfile === 'shortest' || plan.selectProfile === 'balanced' || plan.selectProfile === 'shadiest') {
    patch.selectedProfile = plan.selectProfile;
  }
  return patch;
}
