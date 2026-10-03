import { describe, expect, it } from 'vitest';
import type {
  AreaData,
  Building,
  CanopyArea,
  HeightRaster,
  LidarData,
  ShadowPolygon,
  SunPosition,
  Tree,
} from '../server/contracts.ts';
import { toLonLat } from '../server/geo/project.ts';
import { lidarTag, sceneForArea } from '../server/shade/cache.ts';
import { ShadeScene } from '../server/shade/scene.ts';

const RAD = Math.PI / 180;
let nextId = 1;

function sun(azimuthDeg: number, altitudeDeg: number, leafOff?: boolean): SunPosition {
  return { azimuth: azimuthDeg * RAD, altitude: altitudeDeg * RAD, ...(leafOff === undefined ? {} : { leafOff }) };
}

function box(x0: number, y0: number, x1: number, y1: number, height: number, minHeight = 0): Building {
  return { id: nextId++, ring: [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], height, minHeight };
}

function tree(x: number, y: number, height: number, crownRadius: number, evergreen?: boolean): Tree {
  return { id: nextId++, x, y, height, crownRadius, ...(evergreen === undefined ? {} : { evergreen }) };
}

/** Raster o wartościach z funkcji środka komórki. */
function raster(
  x0: number,
  y0: number,
  cellM: number,
  cols: number,
  rows: number,
  valueAt: (x: number, y: number) => number,
): HeightRaster {
  const data = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      data[row * cols + col] = valueAt(x0 + (col + 0.5) * cellM, y0 + (row + 0.5) * cellM);
    }
  }
  return { x0, y0, cellM, cols, rows, data };
}

function lidar(vegetation: HeightRaster | null, terrain: HeightRaster | null = null): LidarData {
  return { vegetation, terrain, coverage: 1 };
}

function scene(parts: {
  buildings?: Building[];
  trees?: Tree[];
  canopies?: CanopyArea[];
  lidar?: LidarData | null;
}): ShadeScene {
  return new ShadeScene({ buildings: [], trees: [], canopies: [], ...parts });
}

/** Deterministyczny generator liczb pseudolosowych (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ringContains(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < xi + ((xj - xi) * (lat - yi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

function inShadowPolygons(polygons: ShadowPolygon[], x: number, y: number): boolean {
  const [lon, lat] = toLonLat(x, y);
  return polygons.some(
    ({ rings }) =>
      ringContains(rings[0], lon, lat) && !rings.slice(1).some((hole) => ringContains(hole, lon, lat)),
  );
}

const SOUTH_45 = sun(180, 45);

describe('roślinność z rastra LiDAR', () => {
  // Kępa drzew 20 × 20 m o wysokości 12 m (warstwa koron 4,2–12 m) pośrodku rastra 200 × 200 m.
  const grove = raster(-100, -100, 2, 100, 100, (x, y) => (Math.abs(x) < 10 && Math.abs(y) < 10 ? 12 : 0));
  const s = scene({ lidar: lidar(grove) });

  it('punkt pod koroną w południe jest zacieniony, także przy słońcu blisko zenitu', () => {
    const noon = s.exposureAt(0, 0, sun(180, 60));
    expect(noon).toBeGreaterThanOrEqual(0.05);
    expect(noon).toBeLessThan(0.3);
    expect(s.exposureAt(0, 0, sun(180, 85))).toBeLessThan(0.3);
    expect(s.exposureAt(0, 0, sun(90, 30))).toBeLessThan(0.3);
  });

  it('z dala od drzew jest słonecznie, w nocy 0', () => {
    expect(s.exposureAt(60, 60, sun(180, 60))).toBe(1);
    expect(s.exposureAt(0, -40, SOUTH_45)).toBe(1); // po stronie słońca
    expect(s.exposureAt(500, 500, SOUTH_45)).toBe(1); // poza rastrem
    expect(s.exposureAt(0, 0, sun(180, -5))).toBe(0);
  });

  it('pas koron 15 m: cień na północ sięga ≈ 15 m (minus wysokość oczu), dalej słońce', () => {
    // Pas drzew: y ∈ [-4, 0), x ∈ [-50, 50); słońce z południa na 45°.
    const row = raster(-100, -100, 2, 100, 100, (x, y) => (y > -4 && y < 0 && Math.abs(x) < 50 ? 15 : 0));
    const r = scene({ lidar: lidar(row) });
    for (const d of [4, 8, 10]) {
      const exposure = r.exposureAt(0.5, d, SOUTH_45);
      expect(exposure).toBeGreaterThanOrEqual(0.05);
      expect(exposure).toBeLessThan(0.4);
    }
    // Przy końcu cienia promień tylko muska wierzchołki koron: półcień.
    expect(r.exposureAt(0.5, 12, SOUTH_45)).toBeGreaterThan(0.4);
    expect(r.exposureAt(0.5, 12, SOUTH_45)).toBeLessThan(1);
    for (const d of [14.5, 16, 25, 60]) expect(r.exposureAt(0.5, d, SOUTH_45)).toBe(1);
    // Po stronie słońca i obok końca pasa — słońce.
    expect(r.exposureAt(0.5, -8, SOUTH_45)).toBe(1);
    expect(r.exposureAt(60, 8, SOUTH_45)).toBe(1);
    // Niższe słońce → dłuższy cień: 13,5 / tan(20°) ≈ 37 m.
    expect(r.exposureAt(0.5, 30, sun(180, 20))).toBeLessThan(0.6);
    expect(r.exposureAt(0.5, 40, sun(180, 20))).toBe(1);
  });

  it('tłumienie rośnie z długością drogi przez korony i ma dolne ograniczenie 0,05', () => {
    const thin = scene({
      lidar: lidar(raster(-100, -100, 2, 100, 100, (x, y) => (y > -2 && y < 0 && Math.abs(x) < 50 ? 15 : 0))),
    });
    const thick = scene({
      lidar: lidar(raster(-100, -100, 2, 100, 100, (x, y) => (y > -40 && y < 0 && Math.abs(x) < 50 ? 15 : 0))),
    });
    const low = sun(180, 15);
    const throughThin = thin.exposureAt(0.5, 20, low);
    expect(throughThin).toBeGreaterThan(0.3);
    expect(throughThin).toBeLessThan(1);
    expect(thick.exposureAt(0.5, 20, low)).toBe(0.05);
    // 10 m za pasem promień przechodzi pod podstawą koron (4,2–4,7 m < 5,25 m): słońce między pniami.
    expect(thin.exposureAt(0.5, 10, low)).toBe(1);
  });

  it('sezon bezlistny (leafOff) podnosi ekspozycję pod koronami i w ich cieniu', () => {
    const summer = s.exposureAt(0, 0, sun(180, 60));
    const winter = s.exposureAt(0, 0, sun(180, 60, true));
    expect(winter).toBeGreaterThan(summer + 0.3);
    expect(winter).toBeLessThan(1);
    expect(s.exposureAt(0, 0, sun(180, 60, false))).toBe(summer);
    // 6 m drogi przez koronę: 0,25 latem i 0,7 zimą. Pas 6 m, promień poziomo… przy 45° droga = 6·√2 m.
    const band = scene({
      lidar: lidar(raster(-100, -100, 2, 100, 100, (x, y) => (y > -6 && y < 0 && Math.abs(x) < 50 ? 40 : 0))),
    });
    // Punkt 20 m za pasem: promień przechodzi przez pas na wysokości 21,5–27,5 m (w całości w warstwie koron).
    expect(band.exposureAt(0.5, 20, SOUTH_45)).toBeCloseTo(Math.pow(0.25, Math.SQRT2), 2);
    expect(band.exposureAt(0.5, 20, sun(180, 45, true))).toBeCloseTo(Math.pow(0.7, Math.SQRT2), 2);
  });

  it('drzewa i zadrzewienia z OSM są pomijane, gdy jest raster roślinności', () => {
    const trees = [tree(50, 50, 10, 3)];
    const canopies: CanopyArea[] = [{ id: nextId++, ring: [-80, 40, -40, 40, -40, 80, -80, 80, -80, 40], height: 15 }];
    const osmOnly = scene({ trees, canopies });
    expect(osmOnly.exposureAt(50, 57, SOUTH_45)).toBeCloseTo(0.25, 2);
    expect(osmOnly.exposureAt(-60, 60, SOUTH_45)).toBeCloseTo(0.15, 6);

    const withRaster = scene({ trees, canopies, lidar: lidar(grove) });
    expect(withRaster.exposureAt(50, 57, SOUTH_45)).toBe(1);
    expect(withRaster.exposureAt(-60, 60, SOUTH_45)).toBe(1);
    expect(withRaster.exposureAt(0, 0, sun(180, 60))).toBeLessThan(0.3);
    // Raster bez żadnej roślinności też zastępuje model OSM (LiDAR mówi: tu nie ma drzew).
    const empty = scene({ trees, canopies, lidar: lidar(raster(-100, -100, 2, 100, 100, () => 0)) });
    expect(empty.exposureAt(50, 57, SOUTH_45)).toBe(1);
    expect(empty.shadowPolygons([-100, -100, 100, 100], SOUTH_45)).toEqual([]);
    // Tam, gdzie raster nie ma danych (NaN — kafel LiDAR niepobrany) albo nie sięga, drzewa z OSM zostają.
    const partial = scene({
      trees: [...trees, tree(-50, -50, 10, 3), tree(150, 0, 10, 3)],
      canopies,
      lidar: lidar(raster(-100, -100, 2, 100, 100, (x, y) => (x > 0 ? NaN : Math.abs(x + 50) < 4 && Math.abs(y - 20) < 4 ? 12 : 0))),
    });
    expect(partial.exposureAt(50, 57, SOUTH_45)).toBeCloseTo(0.25, 2); // x > 0: brak danych → drzewo z OSM
    expect(partial.exposureAt(150, 7, SOUTH_45)).toBeCloseTo(0.25, 2); // poza rastrem
    expect(partial.exposureAt(-50, -43, SOUTH_45)).toBe(1); // raster ma dane i mówi: brak drzew
    expect(partial.exposureAt(-60, 60, SOUTH_45)).toBe(1); // zadrzewienie z OSM w zasięgu danych pominięte
    expect(partial.exposureAt(-50, 20, sun(180, 70))).toBeLessThan(0.5); // roślinność z rastra
    // Brak rastra roślinności (sam teren) → drzewa z OSM działają dalej.
    const terrainOnly = scene({ trees, lidar: lidar(null, raster(-200, -200, 10, 40, 40, () => 210)) });
    expect(terrainOnly.exposureAt(50, 57, SOUTH_45)).toBeCloseTo(0.25, 2);
  });

  it('budynek daje pełny cień niezależnie od roślinności; NaN i niska roślinność nie cieniują', () => {
    const b = scene({ buildings: [box(-10, -40, 10, -20, 40)], lidar: lidar(grove) });
    expect(b.exposureAt(0, 0, SOUTH_45)).toBe(0);
    expect(b.exposureAt(0, -30, SOUTH_45)).toBe(0);
    const low = scene({
      lidar: lidar(raster(-100, -100, 2, 100, 100, (x, y) => (Math.abs(x) < 10 && Math.abs(y) < 10 ? 1.8 : y > 50 ? NaN : x > 80 ? 9 : 0))),
    });
    expect(low.exposureAt(0, 0, sun(180, 60))).toBe(1);
    expect(low.exposureAt(0, 60, sun(180, 60))).toBe(1);
  });
});

describe('sezon bezlistny w modelu OSM', () => {
  it('drzewo liściaste: ~0,7 zamiast ~0,25; iglaste (evergreen) bez zmian', () => {
    const deciduous = scene({ trees: [tree(0, 0, 10, 3)] });
    const evergreen = scene({ trees: [tree(0, 0, 10, 3, true)] });
    const winter = sun(180, 45, true);
    expect(deciduous.exposureAt(0, 7, SOUTH_45)).toBeCloseTo(0.25, 2);
    expect(deciduous.exposureAt(0, 7, winter)).toBeCloseTo(0.7, 2);
    expect(evergreen.exposureAt(0, 7, winter)).toBe(evergreen.exposureAt(0, 7, SOUTH_45));
    expect(evergreen.exposureAt(0, 7, winter)).toBeCloseTo(0.25, 2);
  });

  it('zwarty drzewostan: ~0,6 wewnątrz zamiast 0,15; cień na zewnątrz słabszy', () => {
    const forest: CanopyArea = { id: nextId++, ring: [0, 0, 50, 0, 50, 50, 0, 50, 0, 0], height: 15 };
    const s = scene({ canopies: [forest] });
    const winter = sun(180, 45, true);
    expect(s.exposureAt(25, 25, winter)).toBeCloseTo(0.6, 6);
    expect(s.exposureAt(25, 55, winter)).toBeGreaterThan(s.exposureAt(25, 55, SOUTH_45));
    expect(s.exposureAt(25, 55, winter)).toBeLessThan(1);
  });

  it('warstwa cieni zimą pomija bezlistne korony pojedynczych drzew, zostawia iglaste', () => {
    const s = scene({ trees: [tree(0, 0, 10, 3), tree(40, 0, 10, 3, true)] });
    expect(s.shadowPolygons([-50, -50, 50, 50], SOUTH_45)).toHaveLength(2);
    const winter = s.shadowPolygons([-50, -50, 50, 50], sun(180, 45, true));
    expect(winter).toHaveLength(1);
    expect(inShadowPolygons(winter, 40, 7)).toBe(true);
  });
});

describe('teren z rastra LiDAR', () => {
  it('wzgórze 20 m na południu zasłania słońce na 10°, ale nie na 25°', () => {
    // Płasko 200 m n.p.m., grzbiet 220 m w pasie y ∈ [-160, -100].
    const terrain = raster(-400, -400, 10, 80, 80, (_x, y) => (y > -160 && y < -100 ? 220 : 200));
    const s = scene({ lidar: lidar(null, terrain) });
    expect(s.exposureAt(0, -40, sun(180, 10))).toBe(0); // nad grzbietem promień ma 201,5 + 65·tan(10°) ≈ 213 m
    expect(s.exposureAt(0, -40, sun(180, 25))).toBe(1);
    expect(s.exposureAt(0, 200, sun(180, 10))).toBe(1); // 300 m od grzbietu: promień przechodzi górą
    expect(s.exposureAt(0, -250, sun(180, 10))).toBe(1); // po słonecznej stronie wzgórza
    expect(s.exposureAt(0, -130, sun(180, 10))).toBe(1); // na grzbiecie
    expect(s.exposureAt(0, 0, sun(0, 10))).toBe(1); // słońce z północy
    expect(s.exposureAt(0, 0, sun(180, -1))).toBe(0);

    // Warstwa cieni: cień terenu jako wielokąt „building” (pełny cień).
    const polygons = s.shadowPolygons([-100, -100, 100, 300], sun(180, 10));
    expect(polygons.length).toBeGreaterThan(0);
    expect(polygons.every((p) => p.kind === 'building')).toBe(true);
    expect(inShadowPolygons(polygons, 0, -40)).toBe(true);
    expect(inShadowPolygons(polygons, 0, 200)).toBe(false);
  });

  it('płaski teren (stała rzędna) daje to samo co brak danych o terenie', () => {
    const random = rng(77);
    const buildings: Building[] = [];
    const trees: Tree[] = [];
    for (let i = 0; i < 30; i++) {
      const x = random() * 300 - 150;
      const y = random() * 300 - 150;
      buildings.push(box(x, y, x + 10 + random() * 20, y + 10 + random() * 20, 6 + random() * 25, i % 7 === 0 ? 4 : 0));
      trees.push(tree(random() * 300 - 150, random() * 300 - 150, 6 + random() * 12, 2 + random() * 3));
    }
    const flat = scene({ buildings, trees });
    const elevated = scene({ buildings, trees, lidar: lidar(null, raster(-300, -300, 10, 60, 60, () => 213.5)) });
    for (const position of [sun(120, 20), sun(200, 55), sun(280, 8)]) {
      let mismatches = 0;
      for (let i = 0; i < 3000; i++) {
        const x = random() * 360 - 180;
        const y = random() * 360 - 180;
        if (Math.abs(flat.exposureAt(x, y, position) - elevated.exposureAt(x, y, position)) > 1e-6) mismatches++;
      }
      expect(mismatches / 3000).toBeLessThan(0.002); // tylko zaokrąglenia na krawędziach cieni
    }
  });

  it('budynek stojący 5 m niżej niż pieszy rzuca na niego odpowiednio krótszy cień', () => {
    // Taras: y < -10 → 200 m n.p.m., y > -10 → 205 m (środki komórek co 10 m: …, -15 | -5, …).
    const terrain = raster(-200, -200, 10, 40, 40, (_x, y) => (y < -10 ? 200 : 205));
    const building = box(-20, -30, 20, -20, 20); // podstawa na 200 m, dach na 220 m
    const flat = scene({ buildings: [building] });
    const stepped = scene({ buildings: [building], lidar: lidar(null, terrain) });
    // Na płaskim cień sięga 20 m od ściany (do y = 0); z tarasu 205 m dach wystaje tylko 15 m → do y = -5.
    expect(flat.exposureAt(0, -3, SOUTH_45)).toBe(0);
    expect(flat.exposureAt(0, 1, SOUTH_45)).toBe(1);
    expect(stepped.exposureAt(0, -7, SOUTH_45)).toBe(0);
    expect(stepped.exposureAt(0, -3, SOUTH_45)).toBe(1);
    expect(stepped.exposureAt(0, 1, SOUTH_45)).toBe(1);
    // Budynek wyżej niż pieszy: dłuższy cień. Pieszy na 200 m, budynek na tarasie 205 m.
    const raised = raster(-200, -200, 10, 40, 40, (_x, y) => (y < 0 ? 205 : 200));
    const upper = scene({ buildings: [box(-20, -30, 20, -20, 20)], lidar: lidar(null, raised) });
    expect(upper.exposureAt(0, 3, SOUTH_45)).toBe(0); // 25 m cienia od ściany (y = -20) → do y = 5
    expect(upper.exposureAt(0, 7, SOUTH_45)).toBe(1);

    // Wielokąt cienia budynku jest skrócony zgodnie z rzędną terenu w miejscu, gdzie pada.
    const polygons = stepped.shadowPolygons([-100, -100, 100, 100], SOUTH_45).filter((p) => p.kind === 'building');
    expect(inShadowPolygons(polygons, 0, -7)).toBe(true);
    expect(inShadowPolygons(polygons, 0, -3)).toBe(false);
  });

  it('roślinność rośnie na terenie: korony na wzniesieniu cieniują dalej, dziury (NaN) w terenie są wypełniane', () => {
    // Wał 10 m w pasie y ∈ [-20, 0] z drzewami 10 m; pieszy na północ od wału, na poziomie 200 m.
    const terrain = raster(-200, -200, 10, 40, 40, (x, y) => (x > 150 && y > 150 ? NaN : y > -20 && y < 0 ? 210 : 200));
    const vegetation = raster(-100, -100, 2, 100, 100, (x, y) => (y > -12 && y < -8 && Math.abs(x) < 60 ? 10 : 0));
    const onBank = scene({ lidar: lidar(vegetation, terrain) });
    const onFlat = scene({ lidar: lidar(vegetation) });
    const high = sun(180, 50);
    // Na płaskim cień koron (3,5–10 m) przy 50° kończy się ok. 7 m za pasem; na wale (213,5–220 m) sięga ok. 15 m.
    expect(onFlat.exposureAt(0.5, 4, high)).toBe(1);
    expect(onBank.exposureAt(0.5, 4, high)).toBeLessThan(0.7);
    expect(onBank.exposureAt(0.5, 40, high)).toBe(1);
    expect(Number.isFinite(onBank.exposureAt(170, 170, high))).toBe(true);
    expect(onBank.exposureAt(170, 170, high)).toBe(1);
  });
});

describe('wielokąty cieni roślinności z rastra', () => {
  it('pas koron: wielokąt „tree” pokrywa cień i nie wychodzi poza okno odbiorców', () => {
    const row = raster(-100, -100, 2, 100, 100, (x, y) => (y > -4 && y < 0 && Math.abs(x) < 50 ? 15 : 0));
    const s = scene({ lidar: lidar(row) });
    const polygons = s.shadowPolygons([-100, -100, 100, 100], SOUTH_45);
    expect(polygons.length).toBeGreaterThan(0);
    expect(polygons.every((p) => p.kind === 'tree')).toBe(true);
    expect(inShadowPolygons(polygons, 0.5, 8)).toBe(true);
    expect(inShadowPolygons(polygons, 0.5, 20)).toBe(false);
    expect(inShadowPolygons(polygons, 0.5, -10)).toBe(false);
    for (const { rings } of polygons) {
      for (const ring of rings) {
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(ring.length).toBeGreaterThanOrEqual(4);
        for (const [lon, lat] of ring) {
          expect(lon).toBe(Number(lon.toFixed(6)));
          expect(lat).toBe(Number(lat.toFixed(6)));
        }
      }
    }
    // Maska dotyczy punktów w oknie: okna przylegające dzielą cień bez nakładania.
    const west = s.shadowPolygons([-100, -100, 0, 100], SOUTH_45);
    const east = s.shadowPolygons([0, -100, 100, 100], SOUTH_45);
    expect(inShadowPolygons(west, -20, 8)).toBe(true);
    expect(inShadowPolygons(west, 20, 8)).toBe(false);
    expect(inShadowPolygons(east, 20, 8)).toBe(true);
    expect(inShadowPolygons(east, -20, 8)).toBe(false);
    // Zimą i nocą cienia koron nie rysujemy (ekspozycja ≥ 0,6 / brak słońca).
    expect(s.shadowPolygons([-100, -100, 100, 100], sun(180, 45, true))).toEqual([]);
    expect(s.shadowPolygons([-100, -100, 100, 100], sun(180, 0.5))).toEqual([]);
  });

  it('plama z dziurą (polana) daje wielokąt z pierścieniem wewnętrznym', () => {
    // Las 80 × 80 m z polaną 40 × 40 m; słońce w zenicie niemal — cień ≈ rzut koron.
    const forest = raster(-100, -100, 2, 100, 100, (x, y) =>
      Math.abs(x) < 40 && Math.abs(y) < 40 && !(Math.abs(x) < 20 && Math.abs(y) < 20) ? 14 : 0,
    );
    const s = scene({ lidar: lidar(forest) });
    const polygons = s.shadowPolygons([-100, -100, 100, 100], sun(180, 80));
    expect(polygons).toHaveLength(1);
    expect(polygons[0].rings).toHaveLength(2);
    expect(inShadowPolygons(polygons, 30, 30)).toBe(true);
    expect(inShadowPolygons(polygons, 0, 5)).toBe(false);
    expect(inShadowPolygons(polygons, 70, 70)).toBe(false);
  });

  it('jest spójne z exposureAt w losowych punktach losowej sceny (z budynkami)', () => {
    const random = rng(4242);
    const crowns: { x: number; y: number; r: number; h: number }[] = [];
    for (let i = 0; i < 70; i++) {
      crowns.push({ x: random() * 400 - 200, y: random() * 400 - 200, r: 3 + random() * 7, h: 8 + random() * 18 });
    }
    const vegetation = raster(-220, -220, 2, 220, 220, (x, y) => {
      let h = 0;
      for (const c of crowns) if (Math.hypot(x - c.x, y - c.y) < c.r && c.h > h) h = c.h;
      return h;
    });
    const buildings: Building[] = [];
    for (let i = 0; i < 25; i++) {
      const x = random() * 360 - 180;
      const y = random() * 360 - 180;
      buildings.push(box(x, y, x + 8 + random() * 25, y + 8 + random() * 25, 6 + random() * 25));
    }
    const s = scene({ buildings, lidar: lidar(vegetation) });

    const report: string[] = [];
    for (const position of [sun(135, 25), sun(200, 55), sun(285, 12)]) {
      const start = performance.now();
      const polygons = s.shadowPolygons([-200, -200, 200, 200], position);
      const ms = performance.now() - start;
      const treeShadows = polygons.filter((p) => p.kind === 'tree');
      const buildingShadows = polygons.filter((p) => p.kind === 'building');
      expect(treeShadows.length).toBeGreaterThan(0);
      expect(buildingShadows.length).toBeGreaterThan(0);

      const samples = 5000;
      let treeMismatches = 0;
      let treeShaded = 0;
      let buildingMismatches = 0;
      for (let i = 0; i < samples; i++) {
        const x = random() * 400 - 200;
        const y = random() * 400 - 200;
        const exposure = s.exposureAt(x, y, position);
        const inTree = exposure > 0 && exposure < 0.6;
        if (inTree) treeShaded++;
        if (inTree !== inShadowPolygons(treeShadows, x, y)) treeMismatches++;
        if ((exposure === 0) !== inShadowPolygons(buildingShadows, x, y)) buildingMismatches++;
      }
      const vertices = treeShadows.reduce((n, p) => n + p.rings.reduce((m, r) => m + r.length, 0), 0);
      report.push(
        `alt ${Math.round(position.altitude / RAD)}°: ${ms.toFixed(0)} ms, ${treeShadows.length} wielok./${vertices} wierzch., ` +
          `cień drzew ${((100 * treeShaded) / samples).toFixed(1)}%, niezgodność ${((100 * treeMismatches) / samples).toFixed(2)}%`,
      );
      expect(buildingMismatches / samples).toBeLessThan(0.002);
      // Maska ma komórki 2,5 m i uproszczone obrysy — niezgodności tylko w wąskim pasie przy krawędziach plam.
      expect(treeMismatches / samples).toBeLessThan(0.06);
      expect(vertices).toBeLessThan(12_000);
    }
    console.log(`[lidar] shadowPolygons 400 × 400 m: ${report.join('; ')}`);
  });
});

describe('zgodność z v1 bez danych LiDAR', () => {
  it('lidar: undefined / null / puste dane dają identyczne wyniki co do bitu', () => {
    const random = rng(987);
    const buildings: Building[] = [];
    const trees: Tree[] = [];
    const canopies: CanopyArea[] = [
      { id: nextId++, ring: [-150, 100, -90, 100, -90, 160, -150, 160, -150, 100], height: 16 },
    ];
    for (let i = 0; i < 40; i++) {
      const x = random() * 360 - 180;
      const y = random() * 360 - 180;
      buildings.push(box(x, y, x + 8 + random() * 25, y + 8 + random() * 25, 6 + random() * 25, i % 9 === 0 ? 3.5 : 0));
    }
    for (let i = 0; i < 60; i++) {
      trees.push(tree(random() * 400 - 200, random() * 400 - 200, 6 + random() * 12, 2 + random() * 3));
    }
    const base = scene({ buildings, trees, canopies });
    const variants = [
      scene({ buildings, trees, canopies, lidar: null }),
      scene({ buildings, trees, canopies, lidar: { vegetation: null, terrain: null, coverage: 0 } }),
    ];
    for (const position of [sun(135, 25), sun(200, 55), sun(285, 12), sun(180, 45, false)]) {
      const expectedPolygons = base.shadowPolygons([-200, -200, 200, 200], position);
      for (const variant of variants) {
        expect(variant.shadowPolygons([-200, -200, 200, 200], position)).toEqual(expectedPolygons);
      }
      for (let i = 0; i < 3000; i++) {
        const x = random() * 440 - 220;
        const y = random() * 440 - 220;
        const expected = base.exposureAt(x, y, position);
        for (const variant of variants) expect(variant.exposureAt(x, y, position)).toBe(expected);
      }
      const line = [-180, random() * 100, 0, random() * 100, 180, -50];
      for (const variant of variants) {
        expect(variant.polylineExposure(line, position)).toBe(base.polylineExposure(line, position));
      }
    }
  });
});

describe('shade/cache — sceneForArea', () => {
  it('buduje scenę od nowa, gdy do obszaru dołączono dane LiDAR', () => {
    const area: AreaData = {
      key: 'test',
      bboxXY: [-100, -100, 100, 100],
      buildings: [box(0, 0, 20, 20, 20)],
      trees: [tree(50, 50, 10, 3)],
      canopies: [],
      ways: [],
      blockedNodeIds: [],
    };
    const first = sceneForArea(area);
    expect(sceneForArea(area)).toBe(first);
    expect(lidarTag(area)).toBe('osm');
    expect(first.exposureAt(50, 57, SOUTH_45)).toBeCloseTo(0.25, 2);

    // attachLidar: zmienia wysokości budynków w miejscu i ustawia area.lidar.
    area.buildings[0].height = 30;
    area.lidar = lidar(raster(-100, -100, 2, 100, 100, (x, y) => (Math.abs(x + 50) < 6 && Math.abs(y) < 6 ? 12 : 0)));
    const second = sceneForArea(area);
    expect(second).not.toBe(first);
    expect(sceneForArea(area)).toBe(second);
    expect(lidarTag(area)).not.toBe('osm');
    expect(second.exposureAt(50, 57, SOUTH_45)).toBe(1); // drzewo z OSM pominięte
    expect(second.exposureAt(10, 45, SOUTH_45)).toBe(0); // cień 30 m zamiast 20 m
    expect(first.exposureAt(10, 45, SOUTH_45)).toBe(1);

    // Podmiana rastra lub zmiana pokrycia w tym samym obiekcie lidar też unieważnia scenę.
    const tagBefore = lidarTag(area);
    area.lidar.coverage = 0.5;
    const third = sceneForArea(area);
    expect(third).not.toBe(second);
    expect(lidarTag(area)).not.toBe(tagBefore);
    area.lidar = null;
    expect(sceneForArea(area)).not.toBe(third);
    expect(lidarTag(area)).toBe('osm');
  });
});

describe('wydajność z rastrami LiDAR (mikro-benchmark)', () => {
  it('exposureAt na gęstej scenie ~20 tys. budynków: bez rastra, z roślinnością, z roślinnością i terenem', () => {
    const random = rng(2024);
    const buildings: Building[] = [];
    const trees: Tree[] = [];
    const pitch = 34;
    const blocks = 142;
    for (let i = 0; i < blocks; i++) {
      for (let j = 0; j < blocks; j++) {
        buildings.push(box(i * pitch, j * pitch, i * pitch + 22, j * pitch + 22, 9 + random() * 16));
      }
    }
    const extent = blocks * pitch; // ~4,8 km
    for (let i = 0; i < 8000; i++) {
      trees.push(tree(random() * extent, random() * extent, 8 + random() * 10, 2 + random() * 3));
    }
    // Raster roślinności 2 m: 30 tys. koron (r 2–7 m, 6–28 m) wrysowanych w siatkę ~2414².
    const cellM = 2;
    const size = Math.ceil(extent / cellM);
    const vegetationData = new Float32Array(size * size);
    for (let i = 0; i < 30_000; i++) {
      const cx = random() * extent;
      const cy = random() * extent;
      const r = 2 + random() * 5;
      const h = 6 + random() * 22;
      for (let row = Math.max(0, Math.floor((cy - r) / cellM)); row <= Math.min(size - 1, Math.floor((cy + r) / cellM)); row++) {
        for (let col = Math.max(0, Math.floor((cx - r) / cellM)); col <= Math.min(size - 1, Math.floor((cx + r) / cellM)); col++) {
          if (Math.hypot((col + 0.5) * cellM - cx, (row + 0.5) * cellM - cy) < r) {
            const k = row * size + col;
            if (h > vegetationData[k]) vegetationData[k] = h;
          }
        }
      }
    }
    const vegetation: HeightRaster = { x0: 0, y0: 0, cellM, cols: size, rows: size, data: vegetationData };
    let covered = 0;
    for (const h of vegetationData) if (h > 0) covered++;
    // Teren 10 m: łagodne fale ±6 m i wzgórze 60 m (jak kopiec) w narożniku.
    const terrain = raster(0, 0, 10, Math.ceil(extent / 10), Math.ceil(extent / 10), (x, y) => {
      const hill = 60 * Math.exp(-((x - 1200) ** 2 + (y - 1200) ** 2) / (2 * 250 ** 2));
      return 205 + 6 * Math.sin(x / 300) * Math.cos(y / 420) + hill;
    });

    const build = (name: string, parts: Parameters<typeof scene>[0]) => {
      const start = performance.now();
      const s = scene(parts);
      return { name, s, buildMs: performance.now() - start };
    };
    const scenes = [
      build('OSM (v1)', { buildings, trees }),
      build('roślinność', { buildings, trees, lidar: lidar(vegetation) }),
      build('roślinność+teren', { buildings, trees, lidar: lidar(vegetation, terrain) }),
      // Najgorszy przypadek dla marszu po rastrze: brak budynków, które kończą promień wcześniej.
      build('bez budynków: roślinność', { lidar: lidar(vegetation) }),
      build('bez budynków: roślinność+teren', { lidar: lidar(vegetation, terrain) }),
    ];

    const calls = 300_000;
    const points = new Float64Array(calls * 2).map(() => random() * extent);
    const slowest: Record<string, number> = {};
    const lines: string[] = [];
    for (const { name, s, buildMs } of scenes) {
      const report: string[] = [];
      slowest[name] = Infinity;
      for (const position of [sun(110, 8), sun(150, 30), sun(200, 60)]) {
        let sum = 0;
        const start = performance.now();
        for (let i = 0; i < calls; i++) sum += s.exposureAt(points[2 * i], points[2 * i + 1], position);
        const perSecond = calls / ((performance.now() - start) / 1000);
        slowest[name] = Math.min(slowest[name], perSecond);
        report.push(`alt ${Math.round(position.altitude / RAD)}°: ${Math.round(perSecond / 1000)} tys./s (śr. ${(sum / calls).toFixed(3)})`);
      }
      lines.push(`${name}: budowa ${buildMs.toFixed(0)} ms; ${report.join('; ')}`);
    }

    // Kafel warstwy cieni (~360 × 370 m) z maską roślinności.
    const tileReport: string[] = [];
    for (const { name, s } of scenes.slice(1, 3)) {
      for (const position of [sun(110, 8), sun(150, 30), sun(200, 60)]) {
        const start = performance.now();
        const polygons = s.shadowPolygons([2000, 2000, 2360, 2370], position);
        const ms = performance.now() - start;
        const treePolygons = polygons.filter((p) => p.kind === 'tree');
        const vertices = treePolygons.reduce((n, p) => n + p.rings.reduce((m, r) => m + r.length, 0), 0);
        tileReport.push(`${name} alt ${Math.round(position.altitude / RAD)}°: ${ms.toFixed(0)} ms, ${treePolygons.length} wielok. drzew / ${vertices} wierzch.`);
        expect(vertices).toBeLessThan(12_000);
      }
    }
    console.log(
      `[bench lidar] pokrycie koronami ${((100 * covered) / vegetationData.length).toFixed(1)}%\n  ` +
        `${lines.join('\n  ')}\n  kafel cieni 360 m: ${tileReport.join('; ')}`,
    );
    expect(slowest['roślinność']).toBeGreaterThan(20_000); // luźna granica dla wolnych maszyn; cel ≥ 100 tys./s
    expect(slowest['roślinność+teren']).toBeGreaterThan(20_000);
    expect(slowest['bez budynków: roślinność+teren']).toBeGreaterThan(20_000);
  }, 180_000);
});
