// CLI: pobiera z wyprzedzeniem kafle OSM do data/osm/, żeby pierwsze wyznaczenie trasy nie czekało na Overpass.
// Użycie: npm run prefetch [-- <west> <south> <east> <north>]   (domyślnie centrum Krakowa)
// Bezpieczne do ponownego uruchomienia — kafle obecne na dysku są pomijane.

import type { BBoxLatLon } from '../contracts.ts';
import { clampToCity, ensureTile, hasTileOnDisk, tileKey, tilesForBBox } from '../osm/store.ts';

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

async function main(): Promise<void> {
  const bbox = clampToCity(bboxFromArgs(process.argv.slice(2)));
  const tiles = tilesForBBox(bbox);
  console.log(`Obszar: ${bbox.west},${bbox.south},${bbox.east},${bbox.north} — kafli: ${tiles.length}`);

  let fetched = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const [i, tile] of tiles.entries()) {
    const key = tileKey(tile);
    const prefix = `[${i + 1}/${tiles.length}] ${key}`;
    if (await hasTileOnDisk(tile)) {
      skipped++;
      console.log(`${prefix}: już w cache`);
      continue;
    }
    const started = Date.now();
    try {
      const { tile: data } = await ensureTile(tile);
      fetched++;
      console.log(
        `${prefix}: pobrano w ${((Date.now() - started) / 1000).toFixed(1)} s — budynki ${data.buildings.length}, ` +
          `drzewa ${data.trees.length}, zadrzewienia ${data.canopies.length}, drogi ${data.ways.length}, ` +
          `przejścia ze światłami ${data.ways.filter((w) => w.signals).length}, punkty chłodu ${data.coolSpots.length}, ` +
          `wysokie krawężniki ${data.raisedKerbNodeIds.length}`,
      );
    } catch (err) {
      failed.push(key);
      console.error(`${prefix}: BŁĄD — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Gotowe: pobrano ${fetched}, pominięto ${skipped}, błędów ${failed.length}.`);
  if (failed.length > 0) {
    console.error(`Nieudane kafle: ${failed.join(', ')}. Uruchom ponownie, aby je dociągnąć.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
