// Dobór okna, dla którego prosimy serwer o cienie: zależy od rzeczywistej powierzchni widoku, nie od zoomu.

import { MAX_SHADOW_AREA_KM2, type LatLon } from '../../shared/types.ts';

export type Bbox = [west: number, south: number, east: number, north: number];

/** Widok większy od limitu serwera więcej niż tyle razy: cienie byłyby i tak nieczytelne — prosimy o przybliżenie. */
const MAX_VIEW_TO_LIMIT_RATIO = 3;
/** Zapas poniżej limitu serwera (różnice w przeliczaniu stopni na metry). */
const AREA_SAFETY = 0.97;

const METRES_PER_DEG_LAT = 111_195;

function bboxAreaKm2([west, south, east, north]: Bbox): number {
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const widthM = (east - west) * METRES_PER_DEG_LAT * Math.cos(midLat);
  const heightM = (north - south) * METRES_PER_DEG_LAT;
  return (widthM * heightM) / 1e6;
}

export type ShadowWindow =
  | { kind: 'too-large' }
  /** `partial`: okno jest wycinkiem widoku (wokół środka mapy), bo cały widok przekracza limit. */
  | { kind: 'bbox'; bbox: Bbox; partial: boolean };

/**
 * Okno zapytania o cienie dla widoku mapy. Widok mieszczący się w limicie serwera bierzemy w całości;
 * nieco większy (np. mapa pochylona przy budynkach 3D, bardzo duży ekran) zmniejszamy proporcjonalnie
 * do limitu, wokół środka mapy i bez wychodzenia poza widok; znacznie większy — odrzucamy.
 */
export function shadowWindow(view: Bbox, center: LatLon, limitKm2: number = MAX_SHADOW_AREA_KM2): ShadowWindow {
  const area = bboxAreaKm2(view);
  const limit = limitKm2 * AREA_SAFETY;
  if (!(area > 0)) return { kind: 'too-large' };
  if (area <= limit) return { kind: 'bbox', bbox: view, partial: false };
  if (area > limitKm2 * MAX_VIEW_TO_LIMIT_RATIO) return { kind: 'too-large' };

  const [west, south, east, north] = view;
  const scale = Math.sqrt(limit / area);
  const halfLon = ((east - west) * scale) / 2;
  const halfLat = ((north - south) * scale) / 2;
  const lon = Math.min(east - halfLon, Math.max(west + halfLon, center.lon));
  const lat = Math.min(north - halfLat, Math.max(south + halfLat, center.lat));
  return { kind: 'bbox', bbox: [lon - halfLon, lat - halfLat, lon + halfLon, lat + halfLat], partial: true };
}
