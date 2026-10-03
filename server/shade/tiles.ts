// Warstwa cieni liczona kaflami na stałej siatce: każdy kafel OSM dzieli się na 6 × 6 kafli cieni (~360 m).
// Kafel cieni zawiera cienie obiektów, których środek w nim leży, więc zależy tylko od danych jednego
// kafla OSM i przedziału czasu — wynik można trzymać w pamięci niezależnie od tego, jak użytkownik
// przesuwa mapę, a liczenie odbywa się małymi porcjami, które nie blokują serwera na długo.
//
// v2: gdy dla kafla OSM są na dysku dane LiDAR, dołączamy je (bez pobierania z sieci) — cienie roślinności
// i terenu powstają wtedy z maski rastrowej liczonej dla punktów W KAFLU (nie dla obiektów w nim stojących).

import { KRAKOW_BBOX, KRAKOW_CENTER } from '../../shared/types.ts';
import type { AreaData, BBoxLatLon, ShadowPolygon, SunPosition } from '../contracts.ts';
import { toLatLon, toXY } from '../geo/project.ts';
import { isLeafOff, sunPosition } from '../geo/sun.ts';
import { attachLidar } from '../lidar/store.ts';
import { EMPTY_AREA_KEY, loadArea, TILE_LAT_DEG, TILE_LON_DEG } from '../osm/store.ts';
import { lidarTag, sceneForArea } from './cache.ts';
import { MAX_SHADOW_M } from './scene.ts';

const SUBDIVISIONS = 6;
const SHADOW_LON_DEG = TILE_LON_DEG / SUBDIVISIONS;
const SHADOW_LAT_DEG = TILE_LAT_DEG / SUBDIVISIONS;
const GRID_EPS = 1e-9;

export const SHADOW_TIME_BUCKET_MS = 5 * 60 * 1000;
/** Budynki do tej wysokości na pewno dorzucają cień do okna; wyższe (pojedyncze wieżowce) mogą go nie dorzucić z daleka. */
const REACH_HEIGHT_M = 60;
/** Zapas na rozmiar samego obiektu: kafel wybieramy po jego środku, a obrys może sięgać dalej. */
const CASTER_HALF_SIZE_M = 60;
const CACHE_LIMIT = 400;

export interface ShadowTile {
  sx: number;
  sy: number;
}

/** Przedział czasu (5 min), dla którego liczymy jedno położenie słońca wspólne dla całego miasta. */
export function shadowBucket(time: Date): number {
  return Math.floor(time.getTime() / SHADOW_TIME_BUCKET_MS);
}

export function shadowSun(bucket: number): SunPosition {
  const time = new Date((bucket + 0.5) * SHADOW_TIME_BUCKET_MS);
  return { ...sunPosition(time, KRAKOW_CENTER.lat, KRAKOW_CENTER.lon), leafOff: isLeafOff(time) };
}

function tileBounds(tile: ShadowTile): BBoxLatLon {
  return {
    west: tile.sx * SHADOW_LON_DEG,
    south: tile.sy * SHADOW_LAT_DEG,
    east: (tile.sx + 1) * SHADOW_LON_DEG,
    north: (tile.sy + 1) * SHADOW_LAT_DEG,
  };
}

/**
 * Kafle cieni potrzebne do narysowania okna: samo okno poszerzone W STRONĘ SŁOŃCA o zasięg cienia
 * (obiekt stojący od strony słońca rzuca cień w głąb okna) i dookoła o rozmiar obiektu.
 * Kafle leżące poza obsługiwanym obszarem miasta są pomijane.
 */
export function shadowTilesFor(bbox: BBoxLatLon, sun: SunPosition): ShadowTile[] {
  if (!(sun.altitude > 0)) return [];
  const reach = Math.min(MAX_SHADOW_M, REACH_HEIGHT_M / Math.tan(sun.altitude));
  const towardSunX = Math.sin(sun.azimuth) * reach;
  const towardSunY = Math.cos(sun.azimuth) * reach;
  const [minX, minY] = toXY(bbox.south, bbox.west);
  const [maxX, maxY] = toXY(bbox.north, bbox.east);
  const [south, west] = toLatLon(
    minX + Math.min(0, towardSunX) - CASTER_HALF_SIZE_M,
    minY + Math.min(0, towardSunY) - CASTER_HALF_SIZE_M,
  );
  const [north, east] = toLatLon(
    maxX + Math.max(0, towardSunX) + CASTER_HALF_SIZE_M,
    maxY + Math.max(0, towardSunY) + CASTER_HALF_SIZE_M,
  );

  const tiles: ShadowTile[] = [];
  const firstX = Math.floor(Math.max(west, KRAKOW_BBOX.west) / SHADOW_LON_DEG + GRID_EPS);
  const lastX = Math.ceil(Math.min(east, KRAKOW_BBOX.east) / SHADOW_LON_DEG - GRID_EPS) - 1;
  const firstY = Math.floor(Math.max(south, KRAKOW_BBOX.south) / SHADOW_LAT_DEG + GRID_EPS);
  const lastY = Math.ceil(Math.min(north, KRAKOW_BBOX.north) / SHADOW_LAT_DEG - GRID_EPS) - 1;
  for (let sy = firstY; sy <= lastY; sy++) {
    for (let sx = firstX; sx <= lastX; sx++) tiles.push({ sx, sy });
  }
  return tiles;
}

/** Fragmenty JSON (obiekty Feature rozdzielone przecinkami) gotowych kafli; odczyt odświeża pozycję wpisu (LRU). */
const fragments = new Map<string, { fragment: string; areaKey: string; lidar: string }>();
/** Ostatnio widziany stan danych LiDAR obszaru (wg area.key) — kafle policzone przy innym stanie są nieaktualne. */
const lidarState = new Map<string, string>();

/** Dołącza do obszaru dane LiDAR już zapisane na dysku; nigdy nie rzuca i niczego nie pobiera. */
async function attachCachedLidar(area: AreaData): Promise<void> {
  try {
    await attachLidar(area, { cachedOnly: true });
  } catch {
    // cienie z samych danych OSM
  }
}

function featureJson(polygon: ShadowPolygon): string {
  return JSON.stringify({
    type: 'Feature',
    properties: { kind: polygon.kind },
    geometry: { type: 'Polygon', coordinates: polygon.rings },
  });
}

export interface ShadowTileResult {
  /** Obiekty Feature jako tekst JSON rozdzielony przecinkami ('' = brak cieni); null = brak danych OSM dla kafla. */
  fragment: string | null;
  /** true, gdy kafel trzeba było policzyć (kosztowne) — wołający powinien wtedy oddać sterowanie pętli zdarzeń. */
  computed: boolean;
}

/**
 * Cienie jednego kafla. Korzysta wyłącznie z kafli OSM już pobranych (cachedOnly); brak danych nie jest
 * zapamiętywany, więc kafel pojawi się, gdy tylko dane zostaną pobrane (np. przy wyznaczaniu trasy).
 */
export async function shadowTileFragment(tile: ShadowTile, bucket: number, sun: SunPosition): Promise<ShadowTileResult> {
  const key = `${bucket}|${tile.sx}_${tile.sy}`;
  const cached = fragments.get(key);
  // Kafel policzony, zanim do obszaru dołączono dane LiDAR, liczymy od nowa.
  if (cached !== undefined && (lidarState.get(cached.areaKey) ?? cached.lidar) === cached.lidar) {
    fragments.delete(key);
    fragments.set(key, cached);
    return { fragment: cached.fragment, computed: false };
  }

  const bounds = tileBounds(tile);
  // Punkt w środku kafla cieni wskazuje dokładnie jeden kafel OSM — ten, który go zawiera.
  const lat = (bounds.south + bounds.north) / 2;
  const lon = (bounds.west + bounds.east) / 2;
  const area = await loadArea({ west: lon, south: lat, east: lon, north: lat }, { cachedOnly: true });
  if (area.key === EMPTY_AREA_KEY) return { fragment: null, computed: false };
  await attachCachedLidar(area);
  const lidar = lidarTag(area);
  if (lidarState.size > CACHE_LIMIT) lidarState.clear();
  lidarState.set(area.key, lidar);

  const [minX, minY] = toXY(bounds.south, bounds.west);
  const [maxX, maxY] = toXY(bounds.north, bounds.east);
  const polygons =
    area.buildings.length + area.trees.length + area.canopies.length > 0 || area.lidar
      ? sceneForArea(area).shadowPolygons([minX, minY, maxX, maxY], sun)
      : [];
  const fragment = polygons.map(featureJson).join(',');
  fragments.delete(key);
  fragments.set(key, { fragment, areaKey: area.key, lidar });
  while (fragments.size > CACHE_LIMIT) fragments.delete(fragments.keys().next().value as string);
  return { fragment, computed: true };
}
