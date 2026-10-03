// CLI: pobiera z wyprzedzeniem kafle LiDAR (GUGiK NMT + NMPT) do data/lidar/, żeby trasy od razu korzystały
// z prawdziwych wysokości budynków i drzew.
// Użycie: tsx server/scripts/prefetch-lidar.ts [<west> <south> <east> <north>]   (domyślnie centrum Krakowa)
// Bezpieczne do ponownego uruchomienia — kafle obecne na dysku są pomijane (wznawia przerwane pobieranie).
// Usługa NMPT jest wolna: ok. 100 MB tekstu i 1–3 min na kafel; kafle idą od centrum na zewnątrz.

import type { BBoxLatLon } from '../contracts.ts';
import { KRAKOW_CENTER } from '../../shared/types.ts';
import { clampToCity, tileBBox, tileKey, tilesForBBox, type TileIndex } from '../osm/store.ts';
import { createLidarStore, createWcsTileFetcher } from '../lidar/store.ts';
import { createWcsClient } from '../lidar/wcs.ts';

const CITY_CENTRE: BBoxLatLon = { west: 19.88, south: 50.03, east: 20.0, north: 50.09 };

function bboxFromArgs(args: string[]): BBoxLatLon {
  if (args.length === 0) return CITY_CENTRE;
  const numbers = args.map(Number);
  if (numbers.length !== 4 || !numbers.every(Number.isFinite)) {
    throw new Error('Podaj cztery liczby: <west> <south> <east> <north> (stopnie WGS84) albo nie podawaj żadnych.');
  }
  const [west, south, east, north] = numbers;
  return { west, south, east, north };
}

/** Kwadrat odległości środka kafla od centrum miasta (w stopniach, z poprawką na zbieżność południków). */
function distanceFromCentre(tile: TileIndex): number {
  const bbox = tileBBox(tile);
  const dLat = (bbox.south + bbox.north) / 2 - KRAKOW_CENTER.lat;
  const dLon = ((bbox.west + bbox.east) / 2 - KRAKOW_CENTER.lon) * Math.cos((KRAKOW_CENTER.lat * Math.PI) / 180);
  return dLat * dLat + dLon * dLon;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

async function main(): Promise<void> {
  const bbox = clampToCity(bboxFromArgs(process.argv.slice(2)));
  const tiles = tilesForBBox(bbox).sort((a, b) => distanceFromCentre(a) - distanceFromCentre(b));
  console.log(`Obszar: ${bbox.west},${bbox.south},${bbox.east},${bbox.north} — kafli: ${tiles.length}`);

  const client = createWcsClient({
    onWindow: ({ layer, bbox: window, ms, bytes, attempt }) =>
      console.log(
        `    ${layer.toUpperCase()} okno ${window[2] - window[0]}×${window[3] - window[1]} m: ` +
          `${(bytes / 1e6).toFixed(1)} MB w ${seconds(ms)} s${attempt > 0 ? ` (próba ${attempt + 1})` : ''}`,
      ),
  });
  const store = createLidarStore({ fetchTile: createWcsTileFetcher(client) });

  let fetched = 0;
  let skipped = 0;
  const failed: string[] = [];
  const startedAll = Date.now();
  for (const [i, tile] of tiles.entries()) {
    const key = tileKey(tile);
    const prefix = `[${i + 1}/${tiles.length}] ${key}`;
    if (await store.hasTileOnDisk(tile)) {
      skipped++;
      console.log(`${prefix}: już w cache`);
      continue;
    }
    const started = Date.now();
    console.log(`${prefix}: pobieranie…`);
    try {
      const { tile: data } = await store.ensureTile(tile);
      fetched++;
      let valid = 0;
      let sum = 0;
      for (const value of data.ndsm) {
        if (value === 0xffff) continue;
        valid++;
        sum += value;
      }
      console.log(
        `${prefix}: gotowe w ${seconds(Date.now() - started)} s — ${data.ndsmGrid.cols}×${data.ndsmGrid.rows} komórek, ` +
          `dane w ${((100 * valid) / data.ndsm.length).toFixed(1)}%, średni nDSM ${(sum / Math.max(1, valid) / 10).toFixed(1)} m`,
      );
    } catch (err) {
      failed.push(key);
      console.error(`${prefix}: BŁĄD po ${seconds(Date.now() - started)} s — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `Gotowe w ${seconds(Date.now() - startedAll)} s: pobrano ${fetched}, pominięto ${skipped}, błędów ${failed.length}.`,
  );
  if (failed.length > 0) {
    console.error(`Nieudane kafle: ${failed.join(', ')}. Uruchom ponownie, aby je dociągnąć.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
