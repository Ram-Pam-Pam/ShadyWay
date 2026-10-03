// Lokalny rzut równoodległościowy wokół KRAKOW_CENTER: x na wschód, y na północ, w metrach.
// W skali miasta (±15 km) błąd odległości jest rzędu 0,1%, co w zupełności wystarcza do cieni i tras.

import { KRAKOW_CENTER } from '../../shared/types.ts';

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = EARTH_RADIUS_M * DEG;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(KRAKOW_CENTER.lat * DEG);

export function toXY(lat: number, lon: number): [number, number] {
  return [(lon - KRAKOW_CENTER.lon) * M_PER_DEG_LON, (lat - KRAKOW_CENTER.lat) * M_PER_DEG_LAT];
}

/** Zwraca [lat, lon]. */
export function toLatLon(x: number, y: number): [number, number] {
  return [KRAKOW_CENTER.lat + y / M_PER_DEG_LAT, KRAKOW_CENTER.lon + x / M_PER_DEG_LON];
}

/** Zwraca [lon, lat] (kolejność GeoJSON). */
export function toLonLat(x: number, y: number): [number, number] {
  return [KRAKOW_CENTER.lon + x / M_PER_DEG_LON, KRAKOW_CENTER.lat + y / M_PER_DEG_LAT];
}
