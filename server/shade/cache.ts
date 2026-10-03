// Wspólna pamięć scen cieni: jedna ShadeScene na zestaw danych obszaru (routing i warstwa cieni dzielą tę samą).

import type { AreaData, HeightRaster, LidarData } from '../contracts.ts';
import { ShadeScene } from './scene.ts';

interface SceneEntry {
  scene: ShadeScene;
  lidar: LidarData | null;
  vegetation: HeightRaster | null;
  terrain: HeightRaster | null;
  coverage: number;
}

/**
 * Magazyn OSM zwraca ten sam obiekt AreaData dla tego samego zestawu kafli, więc sceny wiążemy z obiektem:
 * gdy magazyn usunie obszar ze swojego LRU, scena znika razem z nim.
 * Dane LiDAR są dołączane do obszaru później (attachLidar zmienia area.lidar i wysokości budynków w miejscu),
 * dlatego scena pamięta, z jakimi danymi LiDAR powstała, i jest budowana od nowa, gdy się zmienią.
 */
const scenes = new WeakMap<AreaData, SceneEntry>();

const lidarIds = new WeakMap<object, number>();
let nextLidarId = 1;

function idOf(value: object | null): string {
  if (value === null) return '-';
  let id = lidarIds.get(value);
  if (id === undefined) {
    id = nextLidarId++;
    lidarIds.set(value, id);
  }
  return String(id);
}

/** Znacznik stanu danych LiDAR obszaru (tożsamość obiektów i pokrycie) — do kluczy pamięci podręcznych. */
export function lidarTag(area: Pick<AreaData, 'lidar'>): string {
  const lidar = area.lidar ?? null;
  if (lidar === null) return 'osm';
  return `${idOf(lidar)}.${idOf(lidar.vegetation)}.${idOf(lidar.terrain)}.${lidar.coverage}`;
}

export function sceneForArea(area: AreaData): ShadeScene {
  const lidar = area.lidar ?? null;
  const vegetation = lidar?.vegetation ?? null;
  const terrain = lidar?.terrain ?? null;
  const coverage = lidar?.coverage ?? 0;
  const entry = scenes.get(area);
  if (
    entry &&
    entry.lidar === lidar &&
    entry.vegetation === vegetation &&
    entry.terrain === terrain &&
    entry.coverage === coverage
  ) {
    return entry.scene;
  }
  const scene = new ShadeScene(area);
  scenes.set(area, { scene, lidar, vegetation, terrain, coverage });
  return scene;
}
