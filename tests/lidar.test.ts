import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AreaData, Building, HeightRaster } from '../server/contracts.ts';
import { toXY } from '../server/geo/project.ts';
import {
  applyLidarHeights,
  canopyEvidence,
  CROWN_BASE_UNIT_M,
  crownBaseM,
  detectDecks,
  dilateMask,
  footprintSamples,
  isCanopyContaminated,
  vegetationLayers,
  percentile,
  rasterizeFootprints,
  removeSpecks,
  roofHeightFromSamples,
  terrainRaster,
  vegetationRaster,
} from '../server/lidar/heights.ts';
import {
  bbox2180ForLocalRect,
  createLocalTo2180,
  epsg2180ToLocal,
  localTo2180,
  ownedCells,
  resampleToLocal,
  sampleBilinear,
  sampleNearest,
  tileGrid,
  tileNdsmGrid,
  tileRectXY,
  tileTerrainGrid,
  unionGrid,
  wgs84To2180,
} from '../server/lidar/raster.ts';
import {
  buildTile,
  createLidarStore,
  decodeTile,
  encodeTile,
  lidarTileFileName,
  parseTileKey,
  tileNdsmRaster,
  tileRequestBBox,
  tileTerrainRaster,
  type LidarTile,
} from '../server/lidar/store.ts';
import {
  alignBBox,
  coverageUrl,
  createWcsClient,
  parseAaiGrid,
  pasteWindow,
  splitWindows,
  WcsError,
  type BBox2180,
  type Raster2180,
} from '../server/lidar/wcs.ts';
import { tileAt, tileKey, type TileIndex } from '../server/osm/store.ts';

/** Raster 1 m o zadanym rozmiarze wypełniony funkcją środka komórki. */
function raster(cols: number, rows: number, value: (x: number, y: number) => number, cellM = 1): HeightRaster {
  const data = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) data[row * cols + col] = value((col + 0.5) * cellM, (row + 0.5) * cellM);
  }
  return { x0: 0, y0: 0, cellM, cols, rows, data };
}

const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
const inRect = (x: number, y: number, r: [number, number, number, number]): boolean =>
  x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

function building(id: number, ring: number[], extra: Partial<Building> = {}): Building {
  return { id, ring, height: 10, minHeight: 0, ...extra };
}

describe('wysokość dachu z nDSM', () => {
  it('percentyl z interpolacją liniową', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([5, 1, 3], 1)).toBe(5);
    expect(percentile([0, 10], 0.85)).toBeCloseTo(8.5, 10);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('85. percentyl ignoruje wieżyczkę i daje wysokość głównej bryły', () => {
    // Budynek 20×20 m o wysokości 12 m z wieżyczką 3×3 m (30 m) — 9 z 400 komórek to za mało, by przebić p85.
    const ndsm = raster(60, 60, (x, y) => {
      if (inRect(x, y, [28, 28, 31, 31])) return 30;
      return inRect(x, y, [20, 20, 40, 40]) ? 12 : 0;
    });
    const b = building(1, rect(20, 20, 40, 40));
    expect(applyLidarHeights([b], ndsm)).toBe(1);
    expect(b.height).toBe(12);
    expect(b.heightSource).toBe('lidar');
  });

  it('pomija komórki przy obrysie (obrys OSM przesunięty o metr względem LiDAR-u)', () => {
    // Dach 15 m zaczyna się metr w głąb obrysu; pas brzegowy to grunt.
    const ndsm = raster(40, 40, (x, y) => (inRect(x, y, [11, 11, 19, 29]) ? 15 : 0));
    const b = building(1, rect(10, 10, 20, 30));
    const samples = footprintSamples(b, ndsm);
    expect(samples.all).toHaveLength(200);
    expect(samples.inner).toHaveLength(8 * 18);
    expect(samples.inner.every((v) => v === 15)).toBe(true);
    applyLidarHeights([b], ndsm);
    expect(b.height).toBe(15);
  });

  it('dziedziniec (pierścień wewnętrzny) nie zaniża wysokości', () => {
    // Kamienica 30×30 m z dziedzińcem 20×20 m: skrzydła mają tylko 5 m szerokości, dziedziniec to grunt.
    const court: [number, number, number, number] = [15, 15, 35, 35];
    const ndsm = raster(60, 60, (x, y) => (inRect(x, y, [10, 10, 40, 40]) && !inRect(x, y, court) ? 20 : 0));
    const withHole = building(1, rect(10, 10, 40, 40), { holes: [rect(15, 15, 35, 35)] });
    const withoutHole = building(2, rect(10, 10, 40, 40));
    applyLidarHeights([withHole], ndsm);
    expect(withHole.height).toBe(20);
    // Bez dziury w obrysie ponad połowa komórek to dziedziniec — p85 nadal trafia w skrzydła.
    applyLidarHeights([withoutHole], ndsm);
    expect(withoutHole.height).toBe(20);
    expect(footprintSamples(withHole, ndsm).all).toHaveLength(900 - 400);
  });

  it('zostawia wysokość z OSM, gdy LiDAR jest niewiarygodny albo go brak', () => {
    const flat = raster(40, 40, () => 0.3);
    const tooLow = building(1, rect(5, 5, 25, 25), { height: 18, heightSource: 'osm' });
    expect(applyLidarHeights([tooLow], flat)).toBe(0);
    expect(tooLow.height).toBe(18);
    expect(tooLow.heightSource).toBe('osm');

    const absurd = building(2, rect(5, 5, 25, 25));
    expect(applyLidarHeights([absurd], raster(40, 40, () => 400))).toBe(0);
    expect(absurd.height).toBe(10);

    const noData = building(3, rect(5, 5, 25, 25));
    expect(applyLidarHeights([noData], raster(40, 40, () => NaN))).toBe(0);

    // Za mało komórek (2×2 m) i obrys poza rastrem.
    const tiny = building(4, rect(5, 5, 7, 7));
    const outside = building(5, rect(100, 100, 120, 120));
    expect(applyLidarHeights([tiny, outside], raster(40, 40, () => 9))).toBe(0);

    // Bryła „wisząca": dach z LiDAR-u poniżej min_height → bez zmian.
    const part = building(6, rect(5, 5, 25, 25), { height: 30, minHeight: 20 });
    expect(applyLidarHeights([part], raster(40, 40, () => 12))).toBe(0);
    expect(part.height).toBe(30);
  });

  it('wąski budynek korzysta ze wszystkich komórek obrysu, gdy po odsunięciu od krawędzi nic nie zostaje', () => {
    const ndsm = raster(30, 30, (x, y) => (inRect(x, y, [5, 5, 7, 25]) ? 4 : 0));
    const garage = building(1, rect(5, 5, 7, 25));
    expect(footprintSamples(garage, ndsm).inner).toHaveLength(0);
    expect(applyLidarHeights([garage], ndsm)).toBe(1);
    expect(garage.height).toBe(4);
  });

  it('jest idempotentne i łączy próbki budynku przeciętego krawędzią rastra', () => {
    const ndsm = raster(40, 40, (x, y) => (inRect(x, y, [10, 10, 30, 30]) ? 17.26 : 0));
    const b = building(1, rect(10, 10, 30, 30));
    applyLidarHeights([b], ndsm);
    const first = b.height;
    applyLidarHeights([b], ndsm);
    expect(b.height).toBe(first);
    expect(first).toBeCloseTo(17.3, 5);

    // Obrys wystaje poza raster: próbki tylko z części wspólnej, bez „zjadania" krawędzi cięcia.
    const cut = building(2, rect(30, 10, 60, 30));
    const tall = raster(40, 40, () => 21);
    const samples = footprintSamples(cut, tall);
    expect(samples.all).toHaveLength(10 * 20);
    expect(samples.inner).toHaveLength(9 * 18);
    expect(roofHeightFromSamples(samples)).toBe(21);
  });
});

describe('maski i raster roślinności', () => {
  it('rasteryzuje obrysy po środkach komórek, z dziedzińcami', () => {
    const grid = { x0: 0, y0: 0, cellM: 1, cols: 20, rows: 20 };
    const mask = rasterizeFootprints([building(1, rect(2, 2, 12, 12), { holes: [rect(5, 5, 9, 9)] })], grid);
    const sum = mask.reduce((a, b) => a + b, 0);
    expect(sum).toBe(100 - 16);
    expect(mask[3 * 20 + 3]).toBe(1);
    expect(mask[6 * 20 + 6]).toBe(0);
    expect(mask[1 * 20 + 3]).toBe(0);
    // Trójkąt x + y < 10,5: środki komórek z i + j ≤ 9.
    const tri = rasterizeFootprints([building(2, [0, 0, 10.5, 0, 0, 10.5, 0, 0])], grid);
    expect(tri.reduce((a, b) => a + b, 0)).toBe(55);
  });

  it('dylatacja poszerza maskę o zadany promień', () => {
    const mask = new Uint8Array(7 * 7);
    mask[3 * 7 + 3] = 1;
    expect(dilateMask(mask, 7, 7, 1).reduce((a, b) => a + b, 0)).toBe(9);
    expect(dilateMask(mask, 7, 7, 2).reduce((a, b) => a + b, 0)).toBe(25);
    expect(dilateMask(mask, 7, 7, 0).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('filtr drobin usuwa pojedyncze komórki i cienkie linie, zostawia zwarte plamy', () => {
    const cols = 20;
    const rows = 20;
    const mask = new Uint8Array(cols * rows);
    mask[2 * cols + 2] = 1; // latarnia
    for (let c = 5; c < 18; c++) mask[5 * cols + c] = 1; // przewód (pozioma linia)
    for (let k = 0; k < 6; k++) mask[(8 + k) * cols + 1 + k] = 1; // przewód po skosie
    for (let r = 12; r < 14; r++) for (let c = 12; c < 14; c++) mask[r * cols + c] = 1; // krzak 2×2
    for (let r = 15; r < 20; r++) for (let c = 14; c < 19; c++) mask[r * cols + c] = 1; // korona 5×5
    const out = removeSpecks(mask, cols, rows);
    expect(out[2 * cols + 2]).toBe(0);
    for (let c = 5; c < 18; c++) expect(out[5 * cols + c]).toBe(0);
    for (let k = 0; k < 6; k++) expect(out[(8 + k) * cols + 1 + k]).toBe(0);
    expect(out[12 * cols + 12] + out[12 * cols + 13] + out[13 * cols + 12] + out[13 * cols + 13]).toBe(4);
    let crown = 0;
    for (let r = 15; r < 20; r++) for (let c = 14; c < 19; c++) crown += out[r * cols + c];
    expect(crown).toBe(25);
  });

  it('roślinność: poza budynkami z buforem, ≥ 2,5 m, w komórkach 2 m jako maksimum', () => {
    const house: [number, number, number, number] = [10, 10, 30, 30];
    const ndsm = raster(60, 60, (x, y) => {
      if (inRect(x, y, house)) return 15;
      if (inRect(x, y, [30, 14, 31, 26])) return 14; // okap wystający 1 m poza obrys OSM
      if (inRect(x, y, [40, 40, 48, 48])) return x < 44 ? 11 : 18; // drzewa
      if (inRect(x, y, [40, 10, 46, 16])) return 1.5; // krzaki poniżej progu
      if (inRect(x, y, [52.2, 20.2, 52.8, 20.8])) return 9; // latarnia (1 komórka)
      return 0;
    });
    const veg = vegetationRaster(ndsm, [building(1, rect(...house))]);
    expect(veg.cellM).toBe(2);
    expect(veg.cols).toBe(30);
    expect(veg.rows).toBe(30);
    const at = (x: number, y: number): number => veg.data[Math.floor(y / 2) * veg.cols + Math.floor(x / 2)];
    expect(at(20, 20)).toBe(0); // dach budynku to nie roślinność
    expect(at(30.5, 20)).toBe(0); // okap w buforze 1,5 m
    expect(at(41, 41)).toBe(11);
    expect(at(47, 47)).toBe(18);
    expect(at(43, 43)).toBe(11); // komórka 2 m [42,44): same komórki 11 m
    expect(at(43, 11)).toBe(0); // za niskie
    expect(at(52.5, 20.5)).toBe(0); // latarnia odfiltrowana
    expect(at(55, 55)).toBe(0);
    // Udział roślinności = 64 m² drzew / 3600 m².
    const share = veg.data.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / veg.data.length;
    expect(share).toBeCloseTo(64 / 3600, 10);
  });

  it('roślinność: drzewo na dziedzińcu zostaje, wysokość jest przycinana, brak danych → NaN', () => {
    const ndsm = raster(40, 40, (x, y) => {
      if (inRect(x, y, [16, 16, 24, 24])) return 13; // drzewo na dziedzińcu 20×20 m
      if (inRect(x, y, [0, 0, 4, 4])) return NaN;
      if (inRect(x, y, [30, 30, 36, 36])) return 90; // komin spoza OSM
      return inRect(x, y, [5, 5, 35, 35]) && !inRect(x, y, [10, 10, 30, 30]) ? 20 : 0;
    });
    const b = building(1, rect(5, 5, 35, 35), { holes: [rect(10, 10, 30, 30)] });
    const veg = vegetationRaster(ndsm, [b]);
    const at = (x: number, y: number): number => veg.data[Math.floor(y / 2) * veg.cols + Math.floor(x / 2)];
    expect(at(20, 20)).toBe(13);
    expect(at(7, 20)).toBe(0);
    expect(at(1, 1)).toBeNaN();
    expect(at(5, 1)).toBe(0);
    // Bez obrysu budynek sam staje się „roślinnością" (znane ograniczenie) — i jest przycinany do 40 m.
    const noBuildings = vegetationRaster(ndsm, []);
    expect(noBuildings.data[Math.floor(7 / 2) * noBuildings.cols + 10]).toBe(20);
    expect(noBuildings.data[Math.floor(33 / 2) * noBuildings.cols + Math.floor(37 / 2)]).toBe(0);
    expect(noBuildings.data[16 * noBuildings.cols + 16]).toBe(40);
  });

  it('raster terenu: średnia w blokach 10 m, NaN pomijane', () => {
    const dtm = raster(30, 20, (x, y) => (x < 1 && y < 1 ? NaN : 200 + Math.floor(x / 10) * 5 + Math.floor(y / 10)));
    const terrain = terrainRaster(dtm);
    expect(terrain.cellM).toBe(10);
    expect([terrain.cols, terrain.rows]).toEqual([3, 2]);
    expect(Array.from(terrain.data)).toEqual([200, 205, 210, 201, 206, 211]);
    expect(terrainRaster(raster(10, 10, () => NaN)).data[0]).toBeNaN();
  });
});

describe('EPSG:2180 ↔ lokalne metry', () => {
  it('PL-1992: południk osiowy 19°E i Rynek Główny w oknie znanym z usługi', () => {
    const [e0] = wgs84To2180(50, 19);
    expect(e0).toBeCloseTo(500000, 6);
    // Okno x(566700,567100), y(244100,244500) to okolice Rynku (sprawdzone na GeoTIFF-ie z WCS).
    const [e, n] = wgs84To2180(50.0617, 19.9372);
    expect(e).toBeGreaterThan(566700);
    expect(e).toBeLessThan(567100);
    expect(n).toBeGreaterThan(244100);
    expect(n).toBeLessThan(244500);
  });

  it('przeliczenie tam i z powrotem zgadza się co do milimetra', () => {
    for (const [x, y] of [
      [0, 0],
      [-3500, 2100],
      [8000, -6000],
      [12345.6, 9876.5],
    ]) {
      const [e, n] = localTo2180(x, y);
      const [bx, by] = epsg2180ToLocal(e, n);
      expect(Math.abs(bx - x)).toBeLessThan(1e-3);
      expect(Math.abs(by - y)).toBeLessThan(1e-3);
    }
  });

  it('osie układów są skręcone o ~0,7° (zbieżność południków), skala bliska 1', () => {
    const [e0, n0] = localTo2180(0, 0);
    const [e1, n1] = localTo2180(0, 1000);
    const angleDeg = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI;
    expect(Math.abs(angleDeg)).toBeGreaterThan(0.5);
    expect(Math.abs(angleDeg)).toBeLessThan(0.9);
    expect(Math.hypot(e1 - e0, n1 - n0)).toBeGreaterThan(995);
    expect(Math.hypot(e1 - e0, n1 - n0)).toBeLessThan(1005);
    // Na szerokości kafla skręt to kilkadziesiąt metrów — dlatego przepróbkowujemy, a nie przesuwamy.
    const [, nEast] = localTo2180(2140, 0);
    expect(Math.abs(nEast - n0)).toBeGreaterThan(15);
  });

  it('siatka kontrolna z interpolacją odwzorowuje proj4 z błędem < 1 cm', () => {
    const area: [number, number, number, number] = [-1200, -900, 1000, 1400];
    const project = createLocalTo2180(area);
    const out = new Float64Array(2);
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const x = area[0] + ((area[2] - area[0]) * i) / 20 + (i < 20 ? 0.37 : 0);
        const y = area[1] + ((area[3] - area[1]) * j) / 20 + (j < 20 ? 0.61 : 0);
        project(x, y, out);
        const [e, n] = localTo2180(x, y);
        worst = Math.max(worst, Math.hypot(out[0] - e, out[1] - n));
      }
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('bbox 2180 obejmuje obrócony prostokąt lokalny', () => {
    const local: [number, number, number, number] = [100, 200, 2240, 2420];
    const bbox = bbox2180ForLocalRect(local, 3);
    for (const [x, y] of [
      [100, 200],
      [2240, 200],
      [100, 2420],
      [2240, 2420],
      [1170, 1310],
    ]) {
      const [e, n] = localTo2180(x, y);
      expect(e).toBeGreaterThan(bbox[0]);
      expect(e).toBeLessThan(bbox[2]);
      expect(n).toBeGreaterThan(bbox[1]);
      expect(n).toBeLessThan(bbox[3]);
    }
    // Większy niż sam prostokąt o skręt osi.
    expect(bbox[2] - bbox[0]).toBeGreaterThan(2140 + 20);
  });

  /** Syntetyczny raster 2180 (wiersz 0 = północ) z funkcji (E, N) środka komórki. */
  function raster2180(bbox: BBox2180, value: (e: number, n: number) => number): Raster2180 {
    const cols = bbox[2] - bbox[0];
    const rows = bbox[3] - bbox[1];
    const data = new Float32Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) data[row * cols + col] = value(bbox[0] + col + 0.5, bbox[3] - row - 0.5);
    }
    return { west: bbox[0], north: bbox[3], cellM: 1, cols, rows, data };
  }

  it('próbkowanie: najbliższy sąsiad i dwuliniowe', () => {
    const src = raster2180([1000, 2000, 1010, 2010], (e, n) => (e - 1000) * 2 + (n - 2000) * 10);
    expect(sampleNearest(src, 1000.2, 2009.9)).toBeCloseTo(0.5 * 2 + 9.5 * 10, 4);
    expect(sampleNearest(src, 999.9, 2005)).toBeNaN();
    expect(sampleNearest(src, 1005, 2010.1)).toBeNaN();
    expect(sampleBilinear(src, 1004.2, 2003.7)).toBeCloseTo(4.2 * 2 + 3.7 * 10, 3);
    // Przy krawędzi (poza środkami skrajnych komórek) — wartość najbliższej komórki.
    expect(sampleBilinear(src, 1000.1, 2000.1)).toBeCloseTo(0.5 * 2 + 0.5 * 10, 4);
  });

  it('przepróbkowanie do lokalnej siatki: płaszczyzna (dwuliniowo) i ostry obiekt (najbliższy sąsiad)', () => {
    const grid = { x0: 400, y0: -300, cellM: 1, cols: 300, rows: 260 };
    const bbox = alignBBox(bbox2180ForLocalRect([400, -300, 700, -40], 3));
    const plane = (e: number, n: number): number => 200 + (e - bbox[0]) * 0.02 - (n - bbox[1]) * 0.03;
    const smooth = resampleToLocal(raster2180(bbox, plane), grid, 'bilinear');
    let worst = 0;
    for (const [col, row] of [
      [0, 0],
      [299, 0],
      [0, 259],
      [299, 259],
      [150, 130],
      [17, 201],
    ]) {
      const [e, n] = localTo2180(grid.x0 + col + 0.5, grid.y0 + row + 0.5);
      worst = Math.max(worst, Math.abs(smooth.data[row * grid.cols + col] - plane(e, n)));
    }
    expect(worst).toBeLessThan(0.002);

    // „Budynek" zdefiniowany w lokalnych metrach, zrasteryzowany w 2180, wraca na swoje miejsce (±1 komórka).
    const block: [number, number, number, number] = [520, -200, 560, -150];
    const src = raster2180(bbox, (e, n) => {
      const [x, y] = epsg2180ToLocal(e, n);
      return inRect(x, y, block) ? 25 : 0;
    });
    const sharp = resampleToLocal(src, grid, 'nearest');
    expect(sharp.x0).toBe(400);
    let mismatched = 0;
    let area = 0;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const x = grid.x0 + col + 0.5;
        const y = grid.y0 + row + 0.5;
        const value = sharp.data[row * grid.cols + col];
        if (value > 0) area++;
        const deepInside = inRect(x, y, [block[0] + 1, block[1] + 1, block[2] - 1, block[3] - 1]);
        const farOutside = !inRect(x, y, [block[0] - 1, block[1] - 1, block[2] + 1, block[3] + 1]);
        if ((deepInside && value !== 25) || (farOutside && value !== 0)) mismatched++;
      }
    }
    expect(mismatched).toBe(0);
    expect(Math.abs(area - 40 * 50)).toBeLessThan(60);
  });
});

describe('siatka kafli LiDAR', () => {
  const centre: TileIndex = tileAt(50.0617, 19.9372);

  it('klucze i nazwy plików', () => {
    expect(tileKey(centre)).toBe('664_2503');
    expect(parseTileKey('664_2503')).toEqual(centre);
    expect(parseTileKey('-3_12')).toEqual({ ix: -3, iy: 12 });
    expect(parseTileKey('empty')).toBeNull();
    expect(parseTileKey('664_2503+665_2503')).toBeNull();
    expect(lidarTileFileName('664_2503')).toBe('664_2503.v1.bin.gz');
  });

  it('komórki globalnej siatki należą do dokładnie jednego kafla', () => {
    expect(ownedCells(0, 10, 2)).toEqual([0, 5]);
    expect(ownedCells(0.9, 10.9, 2)).toEqual([0, 5]); // środki 1,3,…,9
    expect(ownedCells(1.1, 11.1, 2)).toEqual([1, 6]); // środek 1 już poza, 11 w środku
    expect(ownedCells(-3.2, 1, 2)).toEqual([-2, 0]); // środki -3 i -1; środek 1 należy już do sąsiada

    const east: TileIndex = { ix: centre.ix + 1, iy: centre.iy };
    const north: TileIndex = { ix: centre.ix, iy: centre.iy + 1 };
    for (const grid of [tileNdsmGrid, tileTerrainGrid, (t: TileIndex) => tileGrid(t, 2)]) {
      const a = grid(centre);
      expect(a.x0 + a.cols * a.cellM).toBe(grid(east).x0);
      expect(a.y0 + a.rows * a.cellM).toBe(grid(north).y0);
      expect(grid(east).y0).toBe(a.y0);
      expect(grid(north).x0).toBe(a.x0);
      expect(grid(north).cols).toBe(a.cols);
    }
  });

  it('siatka nDSM (1 m) zagnieżdża się w siatce roślinności (2 m) i pokrywa prostokąt kafla', () => {
    const ndsm = tileNdsmGrid(centre);
    const veg = tileGrid(centre, 2);
    expect(ndsm.cellM).toBe(1);
    expect([ndsm.x0, ndsm.y0]).toEqual([veg.x0, veg.y0]);
    expect([ndsm.cols, ndsm.rows]).toEqual([veg.cols * 2, veg.rows * 2]);
    expect(Math.abs(ndsm.x0 % 2)).toBe(0);
    const [minX, minY, maxX, maxY] = tileRectXY(centre);
    expect(Math.abs(ndsm.x0 - minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(ndsm.y0 - minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(ndsm.x0 + ndsm.cols - maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(ndsm.y0 + ndsm.rows - maxY)).toBeLessThanOrEqual(1);
    // Kafel 0,03° × 0,02° to w Krakowie ok. 2,14 × 2,22 km; centrum miasta leży w kaflu.
    expect(ndsm.cols).toBeGreaterThan(2100);
    expect(ndsm.cols).toBeLessThan(2180);
    expect(ndsm.rows).toBeGreaterThan(2200);
    expect(ndsm.rows).toBeLessThan(2240);
    const [cx, cy] = toXY(50.0617, 19.9372);
    expect(inRect(cx, cy, [ndsm.x0, ndsm.y0, ndsm.x0 + ndsm.cols, ndsm.y0 + ndsm.rows])).toBe(true);
  });

  it('bbox zapytania WCS obejmuje wszystkie komórki kafla i jest w pełnych metrach', () => {
    const bbox = tileRequestBBox(centre);
    expect(bbox.every(Number.isInteger)).toBe(true);
    const ndsm = tileNdsmGrid(centre);
    for (const [x, y] of [
      [ndsm.x0, ndsm.y0],
      [ndsm.x0 + ndsm.cols, ndsm.y0],
      [ndsm.x0, ndsm.y0 + ndsm.rows],
      [ndsm.x0 + ndsm.cols, ndsm.y0 + ndsm.rows],
    ]) {
      const [e, n] = localTo2180(x, y);
      expect(e).toBeGreaterThan(bbox[0] + 1);
      expect(e).toBeLessThan(bbox[2] - 1);
      expect(n).toBeGreaterThan(bbox[1] + 1);
      expect(n).toBeLessThan(bbox[3] - 1);
    }
    expect(bbox[2] - bbox[0]).toBeLessThan(2400);
    expect(bbox[3] - bbox[1]).toBeLessThan(2400);
  });

  it('unionGrid skleja siatki kafli', () => {
    const tiles: TileIndex[] = [centre, { ix: centre.ix + 1, iy: centre.iy + 1 }];
    const union = unionGrid(tiles.map((t) => tileGrid(t, 2)), 2)!;
    const a = tileGrid(tiles[0], 2);
    const b = tileGrid(tiles[1], 2);
    expect(union.x0).toBe(a.x0);
    expect(union.cols).toBe(a.cols + b.cols);
    expect(union.rows).toBe(a.rows + b.rows);
    expect(unionGrid([], 2)).toBeNull();
  });
});

describe('klient WCS (bez sieci)', () => {
  const aai = (body: string): Uint8Array =>
    Buffer.from(
      '\r\n--wcs\r\nContent-Type: image/x-aaigrid\r\nContent-ID: coverage/result.asc\r\n\r\n' + body + '\n--wcs--\n',
      'latin1',
    );

  it('parsuje AAIGrid z odpowiedzi multipart', () => {
    const grid = parseAaiGrid(
      aai(
        'ncols        3\nnrows        2\nxllcorner    566700.000000000000\nyllcorner    244100.000000000000\n' +
          'cellsize     1.000000000000\nNODATA_value  -9999\n' +
          ' 216.7700042724609375 207.57000732421875 -9999\n -1.5 1e2 2.5E+1\n',
      ),
    );
    expect([grid.cols, grid.rows, grid.cellM]).toEqual([3, 2, 1]);
    expect(grid.west).toBe(566700);
    expect(grid.north).toBe(244102);
    expect(grid.data[0]).toBeCloseTo(216.77, 4);
    expect(grid.data[1]).toBeCloseTo(207.57, 4);
    expect(grid.data[2]).toBeNaN();
    expect(grid.data[3]).toBeCloseTo(-1.5, 6);
    expect(grid.data[4]).toBe(100);
    expect(grid.data[5]).toBe(25);
  });

  it('odrzuca uciętą odpowiedź i odpowiedź bez siatki', () => {
    expect(() => parseAaiGrid(aai('ncols 3\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n 1 2 3 4\n'))).toThrow(WcsError);
    expect(() => parseAaiGrid(Buffer.from('<ows:ExceptionReport/>'))).toThrow(WcsError);
  });

  it('adres zapytania: oś x = wschodnia, NMPT skalowany z 0,5 m do 1 m', () => {
    const dsm = coverageUrl('dsm', [566700, 244100, 567100, 244500]);
    expect(dsm).toContain('COVERAGEID=DSM_PL-KRON86-NH&');
    expect(dsm).toContain('FORMAT=image/x-aaigrid');
    expect(dsm).toContain('SUBSET=x(566700,567100)&SUBSET=y(244100,244500)');
    expect(dsm).toContain('SCALEFACTOR=0.5');
    const dtm = coverageUrl('dtm', [566700, 244100, 567100, 244500]);
    expect(dtm).toContain('COVERAGEID=DTM_PL-KRON86-NH_TIFF');
    expect(dtm).toContain('FORMAT=image/tiff');
    expect(dtm).not.toContain('SCALEFACTOR');
  });

  it('dzieli obszar na okna bez dziur i nakładek', () => {
    expect(alignBBox([10.2, 20.7, 30.1, 40])).toEqual([10, 20, 31, 40]);
    const bbox: BBox2180 = [565000, 243000, 567181, 245263];
    const windows = splitWindows(bbox, 1200);
    expect(windows).toHaveLength(4);
    let area = 0;
    for (const w of windows) {
      expect(w[2] - w[0]).toBeLessThanOrEqual(1200);
      expect(w[3] - w[1]).toBeLessThanOrEqual(1200);
      expect(w.every(Number.isInteger)).toBe(true);
      area += (w[2] - w[0]) * (w[3] - w[1]);
    }
    expect(area).toBe(2181 * 2263);
    expect(splitWindows(bbox, 2400)).toEqual([bbox]);
  });

  it('skleja okna w mozaikę (także z okna 0,5 m)', () => {
    const target: Raster2180 = { west: 0, north: 4, cellM: 1, cols: 4, rows: 4, data: new Float32Array(16).fill(NaN) };
    pasteWindow(target, { west: 0, north: 4, cellM: 1, cols: 2, rows: 4, data: new Float32Array(8).fill(1) });
    pasteWindow(target, { west: 2, north: 2, cellM: 0.5, cols: 4, rows: 4, data: new Float32Array(16).fill(2) });
    expect(Array.from(target.data)).toEqual([1, 1, NaN, NaN, 1, 1, NaN, NaN, 1, 1, 2, 2, 1, 1, 2, 2]);
  });

  it('fetchRaster: okna, limit równoległości 2, ponowienie po błędzie', async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      calls++;
      const failFirst = calls === 1;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (failFirst) {
        return new Response('<ows:ExceptionReport><ows:ExceptionText>busy</ows:ExceptionText></ows:ExceptionReport>', {
          status: 503,
          headers: { 'content-type': 'text/xml' },
        });
      }
      const [, x0, x1] = /SUBSET=x\((\d+),(\d+)\)/.exec(url)!.map(Number);
      const [, y0, y1] = /SUBSET=y\((\d+),(\d+)\)/.exec(url)!.map(Number);
      const rows: string[] = [];
      for (let n = y1 - 1; n >= y0; n--) {
        const row: number[] = [];
        for (let e = x0; e < x1; e++) row.push((e - 100) * 10 + n / 100);
        rows.push(' ' + row.join(' '));
      }
      return new Response(
        aai(`ncols ${x1 - x0}\nnrows ${y1 - y0}\nxllcorner ${x0}\nyllcorner ${y0}\ncellsize 1\n${rows.join('\n')}\n`) as unknown as BodyInit,
        { status: 200, headers: { 'content-type': 'multipart/related; boundary=wcs' } },
      );
    }) as typeof fetch;

    const windows: number[] = [];
    const client = createWcsClient({ fetchImpl, retryDelayMs: [1], onWindow: (info) => windows.push(info.attempt) });
    const result = await client.fetchRaster('dsm', [100, 200, 130, 5200]);
    // 30 × 5000 m → 3 okna w pionie (≤ 2400 m); jedno zapytanie ponowione.
    expect(calls).toBe(4);
    expect(windows.sort()).toEqual([0, 0, 1]);
    expect(peak).toBeLessThanOrEqual(2);
    expect([result.cols, result.rows, result.west, result.north]).toEqual([30, 5000, 100, 5200]);
    let wrong = 0;
    for (let row = 0; row < result.rows; row++) {
      for (let col = 0; col < result.cols; col++) {
        if (Math.abs(result.data[row * result.cols + col] - (col * 10 + (5199 - row) / 100)) > 0.01) wrong++;
      }
    }
    expect(wrong).toBe(0);
    expect(urls.every((u) => u.includes('User-Agent') === false)).toBe(true);

    const failing = createWcsClient({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      retryDelayMs: [1],
    });
    await expect(failing.fetchRaster('dsm', [0, 0, 10, 10])).rejects.toThrow(/HTTP 500/);
  });
});

describe('magazyn kafli LiDAR', () => {
  const tile: TileIndex = { ix: 664, iy: 2503 };
  const grid = tileNdsmGrid(tile);
  // Budynek 30×40 m (14 m) i drzewo 8×8 m (11 m) w lokalnych metrach, 300 m od narożnika kafla.
  const house: [number, number, number, number] = [grid.x0 + 300, grid.y0 + 300, grid.x0 + 330, grid.y0 + 340];
  const tree: [number, number, number, number] = [grid.x0 + 360, grid.y0 + 300, grid.x0 + 368, grid.y0 + 308];

  /** Syntetyczne NMT (płaszczyzna) i NMPT (NMT + obiekty) w bbox zapytania kafla. */
  function syntheticRasters(t: TileIndex, objects: { rect: [number, number, number, number]; height: number }[]) {
    const bbox = tileRequestBBox(t);
    const cols = bbox[2] - bbox[0];
    const rows = bbox[3] - bbox[1];
    const dtmData = new Float32Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) dtmData[row * cols + col] = 200 + col * 0.01;
    }
    const dsmData = dtmData.slice();
    for (const object of objects) {
      const [minE, minN, maxE, maxN] = alignBBox(bbox2180ForLocalRect(object.rect, 2));
      for (let n = minN; n < maxN; n++) {
        for (let e = minE; e < maxE; e++) {
          const [x, y] = epsg2180ToLocal(e + 0.5, n + 0.5);
          if (!inRect(x, y, object.rect)) continue;
          dsmData[(bbox[3] - 1 - n) * cols + (e - bbox[0])] += object.height;
        }
      }
    }
    const base = { west: bbox[0], north: bbox[3], cellM: 1, cols, rows };
    return { dtm: { ...base, data: dtmData }, dsm: { ...base, data: dsmData } };
  }

  let built: LidarTile | null = null;
  function syntheticTile(): LidarTile {
    if (!built) {
      const { dtm, dsm } = syntheticRasters(tile, [
        { rect: house, height: 14 },
        { rect: tree, height: 11 },
      ]);
      built = buildTile(tile, dtm, dsm, '2026-10-03T00:00:00.000Z');
    }
    return built;
  }

  function areaFor(buildings: Building[]): AreaData {
    return {
      key: tileKey(tile),
      bboxXY: tileRectXY(tile),
      buildings,
      trees: [],
      canopies: [],
      ways: [],
      blockedNodeIds: [],
    };
  }

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cien-lidar-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('buildTile: nDSM w lokalnych metrach trafia w obiekty, teren w komórkach 10 m', () => {
    const t = syntheticTile();
    expect(t.key).toBe('664_2503');
    const ndsm = tileNdsmRaster(t);
    const at = (x: number, y: number): number => ndsm.data[Math.floor(y - ndsm.y0) * ndsm.cols + Math.floor(x - ndsm.x0)];
    expect(at(house[0] + 15, house[1] + 20)).toBeCloseTo(14, 1);
    expect(at(house[0] + 1.5, house[1] + 1.5)).toBeCloseTo(14, 1);
    expect(at(house[0] - 1.5, house[1] + 20)).toBe(0);
    expect(at(tree[0] + 4, tree[1] + 4)).toBeCloseTo(11, 1);
    expect(at(grid.x0 + 0.5, grid.y0 + 0.5)).toBe(0);
    expect(at(grid.x0 + grid.cols - 0.5, grid.y0 + grid.rows - 0.5)).toBe(0);
    expect(ndsm.data.some((v) => Number.isNaN(v))).toBe(false);

    const terrain = tileTerrainRaster(t);
    expect(terrain.cellM).toBe(10);
    const bbox = tileRequestBBox(tile);
    const col = 50;
    const row = 70;
    const [e] = localTo2180(terrain.x0 + (col + 0.5) * 10, terrain.y0 + (row + 0.5) * 10);
    expect(terrain.data[row * terrain.cols + col]).toBeCloseTo(200 + (e - bbox[0] - 0.5) * 0.01, 1);
  });

  it('plik kafla: zapis i odczyt bez strat, odrzucanie uszkodzonych danych', () => {
    const t = syntheticTile();
    const encoded = encodeTile(t);
    const decoded = decodeTile(encoded, '664_2503')!;
    expect(decoded.ndsmGrid).toEqual(t.ndsmGrid);
    expect(decoded.terrainGrid).toEqual(t.terrainGrid);
    expect(decoded.fetchedAt).toBe(t.fetchedAt);
    expect(Buffer.from(decoded.ndsm.buffer, decoded.ndsm.byteOffset, decoded.ndsm.byteLength).equals(
      Buffer.from(t.ndsm.buffer, t.ndsm.byteOffset, t.ndsm.byteLength),
    )).toBe(true);
    expect(decoded.terrain).toEqual(t.terrain);
    expect(decodeTile(encoded, '665_2503')).toBeNull();
    expect(decodeTile(encoded.subarray(0, encoded.length - 2), '664_2503')).toBeNull();
    expect(decodeTile(Buffer.from('zepsute'))).toBeNull();
  });

  it('attachLidar: pobiera kafel, ustawia rastry i wysokości; idempotentne; cachedOnly bez sieci', async () => {
    let fetches = 0;
    const store = createLidarStore({
      dir,
      fetchTile: async () => {
        fetches++;
        return syntheticTile();
      },
      tileEstimateMs: 10,
    });

    const cachedArea = areaFor([building(1, rect(...house), { height: 10, heightSource: 'default' })]);
    await store.attachLidar(cachedArea, { cachedOnly: true });
    expect(fetches).toBe(0);
    expect(cachedArea.lidar).toBeNull();
    expect(cachedArea.buildings[0].height).toBe(10);

    const b = building(1, rect(...house), { height: 10, heightSource: 'default' });
    const unknown = building(2, rect(grid.x0 + 800, grid.y0 + 800, grid.x0 + 820, grid.y0 + 820), { height: 21 });
    const area = areaFor([b, unknown]);
    // Równoległe wywołania współdzielą jedno pobieranie.
    await Promise.all([store.attachLidar(area), store.attachLidar(area)]);
    expect(fetches).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['664_2503.v1.bin.gz']);
    expect(await store.hasTileOnDisk(tile)).toBe(true);

    expect(b.height).toBeCloseTo(14, 1);
    expect(b.heightSource).toBe('lidar');
    expect(unknown.height).toBe(21); // LiDAR widzi tam grunt → zostaje wysokość z OSM
    expect(unknown.heightSource).toBeUndefined();

    const lidar = area.lidar!;
    expect(lidar.coverage).toBe(1);
    const veg = lidar.vegetation!;
    expect(veg.cellM).toBe(2);
    expect([veg.x0, veg.y0]).toEqual([grid.x0, grid.y0]);
    expect([veg.cols, veg.rows]).toEqual([grid.cols / 2, grid.rows / 2]);
    const vegAt = (x: number, y: number): number =>
      veg.data[Math.floor((y - veg.y0) / 2) * veg.cols + Math.floor((x - veg.x0) / 2)];
    expect(vegAt(tree[0] + 4, tree[1] + 4)).toBeCloseTo(11, 1);
    expect(vegAt(house[0] + 15, house[1] + 20)).toBe(0);
    expect(vegAt(grid.x0 + 1000, grid.y0 + 1000)).toBe(0);
    const terrain = lidar.terrain!;
    expect(terrain.cellM).toBe(10);
    expect(terrain.data[0]).toBeGreaterThan(199);
    expect(terrain.data[0]).toBeLessThan(225);

    // Drugie wywołanie niczego nie zmienia (ten sam obiekt area.lidar, bez sieci).
    await store.attachLidar(area);
    await store.attachLidar(area, { cachedOnly: true });
    expect(area.lidar).toBe(lidar);
    expect(fetches).toBe(1);
    expect(b.height).toBeCloseTo(14, 1);

    // Nowy magazyn na tym samym katalogu czyta kafel z dysku; cachedOnly wystarcza.
    const reopened = createLidarStore({
      dir,
      fetchTile: async () => {
        throw new Error('sieć niedozwolona');
      },
    });
    const again = areaFor([building(1, rect(...house))]);
    await reopened.attachLidar(again, { cachedOnly: true });
    expect(again.lidar?.coverage).toBe(1);
    expect(again.buildings[0].height).toBeCloseTo(14, 1);
    // loadLidar: te same rastry dla bbox, obrysy z podanego źródła.
    const viaBBox = createLidarStore({ dir, loadBuildings: async () => [building(1, rect(...house))] });
    const loaded = await viaBBox.loadLidar({ west: 19.93, south: 50.065, east: 19.94, north: 50.07 }, { cachedOnly: true });
    expect(loaded?.coverage).toBe(1);
    expect(loaded?.vegetation?.cols).toBe(veg.cols);
  });

  it('attachLidar nigdy nie rzuca: błąd pobierania → area.lidar = null, ponowienie dopiero po przerwie', async () => {
    let fetches = 0;
    const store = createLidarStore({
      dir,
      fetchTile: async () => {
        fetches++;
        throw new Error('WCS leży');
      },
      tileEstimateMs: 10,
    });
    const area = areaFor([building(1, rect(...house))]);
    await expect(store.attachLidar(area)).resolves.toBeUndefined();
    expect(area.lidar).toBeNull();
    expect(area.buildings[0].height).toBe(10);
    await store.attachLidar(area);
    expect(fetches).toBe(1);
  });

  it('wolne pobieranie nie blokuje zapytania: wynik bez LiDAR-u od razu, kafel dociąga się w tle', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const store = createLidarStore({
      dir,
      fetchTile: async () => {
        fetches++;
        await gate;
        return syntheticTile();
      },
      budgetMs: 40,
      tileEstimateMs: 10,
    });
    const area = areaFor([building(1, rect(...house))]);
    const started = Date.now();
    await store.attachLidar(area);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(area.lidar).toBeNull();

    // Drugie zapytanie w trakcie pobierania nie startuje go ponownie.
    await store.attachLidar(area);
    expect(fetches).toBe(1);

    release!();
    await store.idle();
    await store.attachLidar(area, { cachedOnly: true });
    expect(area.lidar?.coverage).toBe(1);
    expect(area.buildings[0].heightSource).toBe('lidar');

    // Gdy oszacowanie czasu pobrania przekracza budżet, wywołanie nie czeka wcale.
    const impatient = createLidarStore({
      dir: path.join(dir, 'inny'),
      fetchTile: () => new Promise<LidarTile>(() => undefined),
      budgetMs: 5000,
      tileEstimateMs: 60_000,
    });
    const other = areaFor([]);
    const t0 = Date.now();
    await impatient.attachLidar(other);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(other.lidar).toBeNull();
  });

  it('obszar z dwóch kafli, z których jeden jest w cache: pokrycie częściowe, reszta NaN', async () => {
    const store = createLidarStore({ dir, fetchTile: async () => syntheticTile() });
    await store.ensureTile(tile);
    const east: TileIndex = { ix: tile.ix + 1, iy: tile.iy };
    const area = areaFor([building(1, rect(...house))]);
    area.key = `${tileKey(tile)}+${tileKey(east)}`;
    area.bboxXY = [tileRectXY(tile)[0], tileRectXY(tile)[1], tileRectXY(east)[2], tileRectXY(east)[3]];
    await store.attachLidar(area, { cachedOnly: true });
    const lidar = area.lidar!;
    const eastGrid = tileGrid(east, 2);
    expect(lidar.vegetation!.cols).toBe(grid.cols / 2 + eastGrid.cols);
    expect(lidar.coverage).toBeGreaterThan(0.45);
    expect(lidar.coverage).toBeLessThan(0.55);
    expect(lidar.vegetation!.data[lidar.vegetation!.cols - 1]).toBeNaN();
    expect(lidar.vegetation!.data[0]).toBe(0);
    expect(lidar.terrain!.data[lidar.terrain!.cols - 1]).toBeNaN();
    expect(area.buildings[0].heightSource).toBe('lidar');
  });
});

// ═════════════════════════ v3: analiza wysokości drzew, mosty, budynki pod koronami ═════════════════════════

/** Deterministyczny „szum" 0..1 z pozycji komórki — chropowata powierzchnia koron. */
const noise = (x: number, y: number): number => {
  const v = Math.sin(Math.floor(x) * 12.9898 + Math.floor(y) * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

describe('v3: pomosty mostów w nDSM', () => {
  const deckRect: [number, number, number, number] = [20, 10, 28, 90];
  const ring = rect(...deckRect);

  it('gładki pomost w obrysie mostu jest wykrywany i wycinany z roślinności', () => {
    // Pomost 8 m nad terenem (z latarnią 12 m) + drzewo 15 m obok mostu.
    const ndsm = raster(100, 100, (x, y) => {
      if (inRect(x, y, [24, 50, 25, 51])) return 12;
      if (inRect(x, y, deckRect)) return 8 + 0.01 * y;
      if (inRect(x, y, [60, 40, 70, 50])) return 13 + 4 * noise(x, y);
      return 0.2;
    });
    const terrain = raster(10, 10, () => 200, 10);
    const { mask, decks } = detectDecks(ndsm, [ring], terrain);
    expect(decks).toHaveLength(1);
    expect(decks[0].ring).toBe(ring);
    expect(decks[0].heightM).toBeGreaterThan(8);
    expect(decks[0].heightM).toBeLessThan(9);
    expect(decks[0].topZ).toBeCloseTo(200 + decks[0].heightM, 1);
    expect(mask[50 * 100 + 24]).toBe(1);
    expect(mask[45 * 100 + 65]).toBe(0);

    const before = vegetationRaster(ndsm, []);
    const after = vegetationLayers(ndsm, [], { exclude: mask }).top;
    const at = (v: HeightRaster, x: number, y: number): number => v.data[Math.floor(y / 2) * v.cols + Math.floor(x / 2)];
    expect(at(before, 24, 30)).toBeGreaterThan(8); // defekt: most jako „korony"
    expect(at(after, 24, 30)).toBe(0);
    expect(at(after, 24, 50)).toBe(0);
    expect(at(after, 65, 45)).toBeGreaterThan(13); // drzewo obok zostaje
  });

  it('niska kładka pod koronami drzew nie jest pomostem (korony zostają), pusty obrys też nie', () => {
    const canopy = raster(100, 100, (x, y) => (inRect(x, y, [10, 0, 40, 100]) ? 9 + 8 * noise(x, y) : 0.3));
    expect(detectDecks(canopy, [ring]).decks).toHaveLength(0);
    const flat = raster(100, 100, () => 0.4);
    const none = detectDecks(flat, [ring]);
    expect(none.decks).toHaveLength(0);
    expect(none.mask.some((v) => v === 1)).toBe(false);
    // Obrys poza rastrem jest pomijany.
    expect(detectDecks(flat, [rect(500, 500, 510, 600)]).decks).toHaveLength(0);
  });
});

describe('v3: dolna granica koron z nDSM', () => {
  const baseAt = (layers: { top: HeightRaster; crownBase: Uint8Array }, x: number, y: number): number =>
    layers.crownBase[Math.floor(y / 2) * layers.top.cols + Math.floor(x / 2)] * CROWN_BASE_UNIT_M;

  it('reguła: krzewy od 0,8 m; drzewo wg rąbka w granicach 0,2–0,4 H; zwarty drzewostan 0,3 H; minimalna grubość', () => {
    expect(crownBaseM(3, 3, Infinity)).toBeCloseTo(0.8, 5);
    expect(crownBaseM(4, 4.5, 3)).toBeCloseTo(0.8, 5);
    // Drzewo 20 m: strome brzegi korony (rąbek 14 m) → 0,4 H; nisko zwieszona korona (rąbek 4 m) → 0,2 H.
    expect(crownBaseM(20, 20, 14)).toBeCloseTo(8, 5);
    expect(crownBaseM(20, 20, 4)).toBeCloseTo(4, 5);
    expect(crownBaseM(20, 20, 10)).toBeCloseTo(6, 5);
    expect(crownBaseM(20, 20, Infinity)).toBeCloseTo(6, 5);
    // Niskie drzewo: podstawa nie schodzi poniżej 2 m.
    expect(crownBaseM(6, 6, 3)).toBeCloseTo(2, 5);
    // Komórka na brzegu korony wysokiego drzewa (szczyt 8 m): warstwa ma co najmniej 45% wysokości komórki.
    expect(crownBaseM(8, 20, 14)).toBeCloseTo(4.4, 5);
  });

  it('raster: żywopłot nisko, wysokie drzewo alejowe wysoko — także w komórkach na brzegu korony', () => {
    // Żywopłot 3 m (4 × 30 m), drzewo alejowe: rdzeń 20 m o stromych brzegach (brzeg 12 m).
    const ndsm = raster(120, 80, (x, y) => {
      if (inRect(x, y, [10, 20, 14, 50])) return 3;
      if (inRect(x, y, [62, 32, 74, 44])) return 20;
      if (inRect(x, y, [60, 30, 76, 46])) return 12;
      return 0.1;
    });
    const layers = vegetationLayers(ndsm, []);
    expect(layers.crownBase).toHaveLength(layers.top.data.length);
    expect(baseAt(layers, 12, 35)).toBeCloseTo(0.8, 5);
    // Rąbek = 12 m → 0,6 · 12 = 7,2 m (mieści się w 0,2–0,4 · 20 m).
    expect(baseAt(layers, 63, 38)).toBeCloseTo(7.2, 1);
    // Środek korony, z którego nie widać brzegu (dalej niż 4 m): wartość typowa 0,3 H.
    expect(baseAt(layers, 68, 38)).toBeCloseTo(6, 1);
    // Komórka brzegowa (szczyt 12 m): min(7,2; 12 − 5,4) = 6,6 m — dawna reguła dawała 4,2 m.
    expect(baseAt(layers, 61, 38)).toBeCloseTo(6.6, 1);
    expect(baseAt(layers, 61, 38)).toBeGreaterThan(Math.max(2, 0.35 * 12));
    // Poza roślinnością brak wartości.
    expect(baseAt(layers, 100, 10)).toBe(0);
    // vegetationRaster zwraca ten sam raster szczytów.
    expect(Array.from(vegetationRaster(ndsm, []).data)).toEqual(Array.from(layers.top.data));
  });
});

describe('v3: małe budynki pod koronami drzew', () => {
  const kiosk = rect(40, 40, 48, 48);
  /** Korony 12–20 m wszędzie poza prześwitami; `roof` — co widać w obrysie kiosku. */
  const under = (roof: (x: number, y: number) => number): HeightRaster =>
    raster(90, 90, (x, y) => (inRect(x, y, [40, 40, 48, 48]) ? roof(x, y) : 12 + 8 * noise(x, y)));

  it('kiosk całkowicie przykryty koroną zachowuje wysokość z OSM', () => {
    const b = building(1, kiosk, { height: 3 });
    const ndsm = under((x, y) => 12 + 8 * noise(x + 7, y + 3));
    const samples = footprintSamples(b, ndsm, 1, { built: rasterizeFootprints([b], ndsm) });
    const evidence = canopyEvidence(samples)!;
    expect(evidence.ringFraction).toBe(1);
    expect(evidence.roughnessM).toBeGreaterThan(0.6);
    expect(isCanopyContaminated(samples, 17)).toBe(true);
    expect(applyLidarHeights([b], ndsm)).toBe(0);
    expect(b.height).toBe(3);
    expect(b.heightSource).toBeUndefined();
  });

  it('prześwity w koronie odsłaniają niski dach → wysokość z niskiego percentyla', () => {
    const b = building(1, kiosk, { height: 10 });
    // 30% obrysu to widoczny dach 3 m, reszta korona.
    const ndsm = under((x, y) => (noise(x + 1, y + 5) < 0.3 ? 3 : 12 + 8 * noise(x, y)));
    expect(applyLidarHeights([b], ndsm)).toBe(1);
    expect(b.height).toBeCloseTo(3, 1);
    expect(b.heightSource).toBe('lidar');
  });

  it('prawdziwe wysokie obiekty nie są odrzucane: płaski dach wśród drzew, wieża, duży budynek', () => {
    const flat = building(1, kiosk, { height: 3 });
    expect(applyLidarHeights([flat], under(() => 9))).toBe(1);
    expect(flat.height).toBeCloseTo(9, 1);

    // Wieża 60 m (ponad zasięg drzew) o nierównym szczycie.
    const tower = building(2, kiosk, { height: 10 });
    expect(applyLidarHeights([tower], under((x, y) => 55 + 6 * noise(x, y)))).toBe(1);
    expect(tower.height).toBeGreaterThan(55);

    // Duży budynek (30 × 30 m) o chropowatym dachu wśród drzew — rozmiar wyklucza „skażenie".
    const big = building(3, rect(30, 30, 60, 60), { height: 10 });
    const ndsm = raster(90, 90, (x, y) => 12 + 8 * noise(x, y));
    expect(applyLidarHeights([big], ndsm)).toBe(1);
    expect(big.height).toBeGreaterThan(12);
  });

  it('sąsiednie budynki nie liczą się jako „roślinność wokół": kamienica w pierzei dostaje wysokość z LiDAR-u', () => {
    // Mały dom o spadzistym dachu 12–18 m wciśnięty między wyższe budynki (zwarta zabudowa, zero drzew).
    const house = building(1, kiosk, { height: 10 });
    const neighbours = [building(2, rect(20, 40, 40, 48)), building(3, rect(48, 40, 70, 48)), building(4, rect(20, 48, 70, 70))];
    const ndsm = raster(90, 90, (x, y) => {
      if (inRect(x, y, [40, 40, 48, 48])) return 12 + 1.5 * Math.abs(x - 44);
      if (inRect(x, y, [20, 40, 70, 70])) return 20 + 6 * noise(x, y);
      return 0.2;
    });
    expect(applyLidarHeights([house, ...neighbours], ndsm)).toBe(4);
    expect(house.height).toBeGreaterThan(12);
  });
});

describe('v3: magazyn LiDAR — mosty i dolne granice koron w area.lidar', () => {
  const tile: TileIndex = { ix: 664, iy: 2503 };
  const grid = tileNdsmGrid(tile);
  const deckRect: [number, number, number, number] = [grid.x0 + 500, grid.y0 + 400, grid.x0 + 510, grid.y0 + 520];
  const treeRect: [number, number, number, number] = [grid.x0 + 560, grid.y0 + 400, grid.x0 + 572, grid.y0 + 412];

  function tileWith(objects: { rect: [number, number, number, number]; height: number }[]): LidarTile {
    const ndsmGrid = tileNdsmGrid(tile);
    const terrainGrid = tileTerrainGrid(tile);
    const ndsm = new Uint16Array(ndsmGrid.cols * ndsmGrid.rows);
    for (const object of objects) {
      for (let y = Math.floor(object.rect[1]); y < object.rect[3]; y++) {
        for (let x = Math.floor(object.rect[0]); x < object.rect[2]; x++) {
          ndsm[(y - ndsmGrid.y0) * ndsmGrid.cols + (x - ndsmGrid.x0)] = object.height * 10;
        }
      }
    }
    const terrain = new Uint16Array(terrainGrid.cols * terrainGrid.rows).fill(2000);
    return { key: tileKey(tile), fetchedAt: '2026-10-04T00:00:00.000Z', ndsmGrid, ndsm, terrainGrid, terrain };
  }

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cien-lidar-v3-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('most z bridgeAreas znika z roślinności i trafia do decks; obszar bez mostów (stary kafel OSM) działa jak dawniej', async () => {
    const store = createLidarStore({
      dir,
      fetchTile: async () =>
        tileWith([
          { rect: deckRect, height: 9 },
          { rect: treeRect, height: 16 },
        ]),
      tileEstimateMs: 10,
    });
    const base = { key: tileKey(tile), bboxXY: tileRectXY(tile), buildings: [], trees: [], canopies: [], ways: [], blockedNodeIds: [] };
    const vegAt = (area: AreaData, x: number, y: number): number => {
      const veg = area.lidar!.vegetation!;
      return veg.data[Math.floor((y - veg.y0) / 2) * veg.cols + Math.floor((x - veg.x0) / 2)];
    };

    const withoutBridges: AreaData = { ...base };
    await store.attachLidar(withoutBridges);
    expect(vegAt(withoutBridges, deckRect[0] + 5, deckRect[1] + 60)).toBeCloseTo(9, 1);
    expect(withoutBridges.lidar!.decks).toEqual([]);

    const ring = rect(deckRect[0] - 1, deckRect[1], deckRect[2] + 1, deckRect[3]);
    const withBridges: AreaData = { ...base, bridgeAreas: [ring] };
    await store.attachLidar(withBridges, { cachedOnly: true });
    const lidar = withBridges.lidar!;
    expect(vegAt(withBridges, deckRect[0] + 5, deckRect[1] + 60)).toBe(0);
    expect(vegAt(withBridges, treeRect[0] + 6, treeRect[1] + 6)).toBeCloseTo(16, 1);
    expect(lidar.decks).toHaveLength(1);
    expect(lidar.decks![0].ring).toBe(ring);
    expect(lidar.decks![0].heightM).toBeCloseTo(9, 1);
    expect(lidar.decks![0].topZ).toBeCloseTo(209, 1);

    // Dolna granica koron: ta sama siatka co roślinność; pod drzewem 16 m o stromych brzegach = 0,4 H.
    const veg = lidar.vegetation!;
    expect(lidar.crownBase).toHaveLength(veg.data.length);
    const i = Math.floor((treeRect[1] + 6 - veg.y0) / 2) * veg.cols + Math.floor((treeRect[0] + 6 - veg.x0) / 2);
    expect(lidar.crownBase![i] * CROWN_BASE_UNIT_M).toBeCloseTo(6.4, 1);

    // Idempotencja także z mostami.
    await store.attachLidar(withBridges, { cachedOnly: true });
    expect(withBridges.lidar).toBe(lidar);
  });
});
