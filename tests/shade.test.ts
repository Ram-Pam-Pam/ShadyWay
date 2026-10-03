import { describe, expect, it } from 'vitest';
import type { Building, CanopyArea, ShadowPolygon, SunPosition, Tree } from '../server/contracts.ts';
import { toLonLat } from '../server/geo/project.ts';
import { ShadeScene } from '../server/shade/scene.ts';

const RAD = Math.PI / 180;
let nextId = 1;

function sun(azimuthDeg: number, altitudeDeg: number): SunPosition {
  return { azimuth: azimuthDeg * RAD, altitude: altitudeDeg * RAD };
}

function box(x0: number, y0: number, x1: number, y1: number, height: number, minHeight = 0): Building {
  return { id: nextId++, ring: [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], height, minHeight };
}

function tree(x: number, y: number, height: number, crownRadius: number): Tree {
  return { id: nextId++, x, y, height, crownRadius };
}

function scene(parts: { buildings?: Building[]; trees?: Tree[]; canopies?: CanopyArea[] }) {
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

/** Budynek 100 × 100 m (wysokość 10 m) z dziedzińcem 60 × 60 m pośrodku: skrzydła mają po 20 m. */
function courtyardBuilding(): Building {
  return { ...box(0, 0, 100, 100, 10), holes: [[20, 20, 80, 20, 80, 80, 20, 80, 20, 20]] };
}

describe('ShadeScene — dziedzińce i insideBuilding', () => {
  const s = scene({ buildings: [courtyardBuilding(), box(200, 0, 220, 20, 12, 4)], canopies: [{ id: 999, ring: [300, 0, 320, 0, 320, 20, 300, 20, 300, 0], height: 15 }] });

  it('dziedziniec jest pod gołym niebem: słońce poza cieniem murów, cień tuż za murem od strony słońca', () => {
    expect(s.exposureAt(50, 50, SOUTH_45)).toBe(1); // środek dziedzińca
    expect(s.exposureAt(50, 25, SOUTH_45)).toBe(0); // 5 m za południowym skrzydłem, cień ma 10 m
    expect(s.exposureAt(50, 31, SOUTH_45)).toBe(1);
    expect(s.exposureAt(50, 10, SOUTH_45)).toBe(0); // wnętrze skrzydła
    // Niskie słońce: cały dziedziniec w cieniu murów.
    expect(s.exposureAt(50, 50, sun(180, 5))).toBe(0);
  });

  it('insideBuilding: wnętrze bryły tak; dziedziniec, bryła z min_height i zadrzewienie nie', () => {
    expect(s.insideBuilding(10, 50)).toBe(true);
    expect(s.insideBuilding(50, 50)).toBe(false);
    expect(s.insideBuilding(-5, 50)).toBe(false);
    expect(s.insideBuilding(210, 10)).toBe(false);
    expect(s.insideBuilding(310, 10)).toBe(false);
    expect(s.insideBuilding(5000, 5000)).toBe(false);
  });
});

describe('ShadeScene.exposureAt — budynki', () => {
  // Budynek 20×20 m o wysokości 20 m; słońce dokładnie z południa na 45° → cień 20 m na północ.
  const s = scene({ buildings: [box(0, 0, 20, 20, 20)] });

  it('cień sięga 20 m na północ od północnej ściany', () => {
    for (const d of [0.5, 5, 10, 19.5]) expect(s.exposureAt(10, 20 + d, SOUTH_45)).toBe(0);
    expect(s.exposureAt(10, 41, SOUTH_45)).toBe(1);
    expect(s.exposureAt(10, 60, SOUTH_45)).toBe(1);
  });

  it('po stronie słońca i obok budynku jest słonecznie', () => {
    expect(s.exposureAt(10, -5, SOUTH_45)).toBe(1);
    expect(s.exposureAt(-3, 30, SOUTH_45)).toBe(1);
    expect(s.exposureAt(23, 30, SOUTH_45)).toBe(1);
  });

  it('długość cienia zależy od wysokości słońca', () => {
    const low = sun(180, 20); // 20 / tan(20°) ≈ 54,9 m
    expect(s.exposureAt(10, 20 + 54, low)).toBe(0);
    expect(s.exposureAt(10, 20 + 56, low)).toBe(1);
    const high = sun(180, 63.4); // ≈ 10 m
    expect(s.exposureAt(10, 20 + 9.5, high)).toBe(0);
    expect(s.exposureAt(10, 20 + 10.5, high)).toBe(1);
  });

  it('cień pada w kierunku przeciwnym do azymutu słońca', () => {
    const east = sun(90, 45);
    expect(s.exposureAt(-10, 10, east)).toBe(0);
    expect(s.exposureAt(30, 10, east)).toBe(1);
    const southWest = sun(225, 45); // cień na północny wschód, 20 m → przesunięcie (14.1, 14.1)
    expect(s.exposureAt(30, 30, southWest)).toBe(0);
    expect(s.exposureAt(-5, -5, southWest)).toBe(1);
  });

  it('punkt wewnątrz obrysu budynku jest w cieniu, nawet pod wysokim słońcem', () => {
    const wide = scene({ buildings: [box(0, 0, 100, 100, 4)] });
    expect(wide.exposureAt(50, 50, sun(180, 80))).toBe(0);
  });

  it('po zachodzie słońca zwraca 0, a pusta scena w dzień 1', () => {
    expect(s.exposureAt(10, -5, sun(180, 0))).toBe(0);
    expect(s.exposureAt(10, -5, sun(180, -10))).toBe(0);
    expect(scene({}).exposureAt(3, 4, SOUTH_45)).toBe(1);
  });

  it('działa dla punktów poza zasięgiem siatki i przy bardzo niskim słońcu', () => {
    expect(s.exposureAt(10, 500, sun(180, 2))).toBe(0); // cień 573 m
    expect(s.exposureAt(10, 700, sun(180, 2))).toBe(1); // ponad limit długości promienia
    expect(s.exposureAt(10, -500, sun(180, 2))).toBe(1);
    expect(s.exposureAt(5000, 5000, SOUTH_45)).toBe(1);
    expect(s.exposureAt(10, 30, sun(180, 0.01))).toBe(0);
  });
});

describe('ShadeScene.exposureAt — min_height (przejścia i nadwieszenia)', () => {
  // Bryła 20×10 m zawieszona między 4 a 12 m nad gruntem.
  const s = scene({ buildings: [box(0, 0, 20, 10, 12, 4)] });

  it('punkt pod bryłą jest w cieniu', () => {
    expect(s.exposureAt(10, 5, SOUTH_45)).toBe(0);
  });

  it('promień trafiający w ścianę między min_height a height jest zasłonięty', () => {
    expect(s.exposureAt(10, 16, SOUTH_45)).toBe(0); // ściana na 6 m
    expect(s.exposureAt(10, 23, SOUTH_45)).toBe(1); // ściana na 13 m — nad dachem
  });

  it('niskie słońce świeci pod bryłą na wylot', () => {
    // Tuż za północną krawędzią: promień wychodzi spod bryły na wysokości 10,5·tan(15°) ≈ 2,8 m < 4 m.
    expect(s.exposureAt(10, 10.5, sun(180, 15))).toBe(1);
  });

  it('promień wchodzący w bryłę od spodu jest zasłonięty', () => {
    // Pod północną ścianą przechodzi na 2 m, ale południową minąłby na 12 m — czyli przez bryłę.
    expect(s.exposureAt(10, 12, SOUTH_45)).toBe(0);
  });
});

describe('ShadeScene.exposureAt — drzewa i zadrzewienia', () => {
  // Drzewo 10 m z koroną r = 3 m: środek korony na 7 m, więc przy 45° środek cienia 7 m na północ.
  const single = scene({ trees: [tree(0, 0, 10, 3)] });

  it('cień korony jest częściowy: ~0,25 przez środek, słabszy przy brzegu', () => {
    const centre = single.exposureAt(0, 7, SOUTH_45);
    expect(centre).toBeCloseTo(0.25, 2);
    const edge = single.exposureAt(2.5, 7, SOUTH_45);
    expect(edge).toBeGreaterThan(centre);
    expect(edge).toBeLessThan(1);
    expect(single.exposureAt(3.5, 7, SOUTH_45)).toBe(1);
    expect(single.exposureAt(0, 20, SOUTH_45)).toBe(1);
    expect(single.exposureAt(0, -7, SOUTH_45)).toBe(1);
  });

  it('punkt pod koroną przy wysokim słońcu jest w półcieniu', () => {
    const under = single.exposureAt(0, 0.5, sun(180, 85));
    expect(under).toBeGreaterThan(0.2);
    expect(under).toBeLessThan(0.35);
  });

  it('kolejne korony mnożą tłumienie, z dolnym ograniczeniem', () => {
    // Promień z (0,7) przechodzi przez środki koron: (0,0,7), (0,-5,12), (0,-10,17).
    const two = scene({ trees: [tree(0, 0, 10, 3), tree(0, -5, 15, 3)] });
    expect(two.exposureAt(0, 7, SOUTH_45)).toBeCloseTo(0.0625, 3);
    const three = scene({ trees: [tree(0, 0, 10, 3), tree(0, -5, 15, 3), tree(0, -10, 20, 3)] });
    expect(three.exposureAt(0, 7, SOUTH_45)).toBeCloseTo(0.05, 6);
  });

  it('budynek za drzewem daje pełny cień', () => {
    const s = scene({ trees: [tree(0, 0, 10, 3)], buildings: [box(-10, -30, 10, -20, 40)] });
    expect(s.exposureAt(0, 7, SOUTH_45)).toBe(0);
  });

  it('zwarty drzewostan: mocny półcień wewnątrz i ażurowy cień na zewnątrz', () => {
    const forest: CanopyArea = { id: nextId++, ring: [0, 0, 50, 0, 50, 50, 0, 50, 0, 0], height: 15 };
    const s = scene({ canopies: [forest] });
    expect(s.exposureAt(25, 25, SOUTH_45)).toBeCloseTo(0.15, 6);
    const cast = s.exposureAt(25, 55, SOUTH_45);
    expect(cast).toBeGreaterThan(0.15);
    expect(cast).toBeLessThan(0.5);
    expect(s.exposureAt(25, 70, SOUTH_45)).toBe(1);
    expect(s.exposureAt(25, -5, SOUTH_45)).toBe(1);
  });
});

describe('ShadeScene.polylineExposure', () => {
  // Cień budynku zajmuje x ∈ [0, 20], y ∈ [20, 40].
  const s = scene({ buildings: [box(0, 0, 20, 20, 20)] });

  it('linia w połowie w cieniu ma ekspozycję ≈ 0,5', () => {
    expect(s.polylineExposure([-20, 30, 20, 30], SOUTH_45, 1)).toBeCloseTo(0.5, 6);
    // Domyślny krok 6 m: 7 próbek, więc wynik jest skwantowany do 1/7.
    expect(Math.abs(s.polylineExposure([-20.5, 30, 19.5, 30], SOUTH_45) - 0.5)).toBeLessThan(0.1);
  });

  it('wynik nie zależy od podziału polilinii na odcinki', () => {
    const straight = s.polylineExposure([-20, 30, 20, 30], SOUTH_45, 1);
    const split = s.polylineExposure([-20, 30, -7, 30, -7, 30, 3, 30, 20, 30], SOUTH_45, 1);
    expect(split).toBeCloseTo(straight, 9);
  });

  it('linia w całości w cieniu / w słońcu', () => {
    expect(s.polylineExposure([2, 25, 18, 35], SOUTH_45)).toBe(0);
    expect(s.polylineExposure([-30, -10, 50, -10], SOUTH_45)).toBe(1);
  });

  it('krótki odcinek zaczynający się przy ścianie jest próbkowany w środku, nie na końcach', () => {
    // Odcinek 4 m prostopadły do granicy cienia (y = 40): próbki na y = 39 i 41.
    expect(s.polylineExposure([10, 38, 10, 42], SOUTH_45)).toBeCloseTo(0.5, 9);
  });

  it('przypadki brzegowe: punkt, pusta lista, noc', () => {
    expect(s.polylineExposure([10, 30, 10, 30], SOUTH_45)).toBe(0);
    expect(s.polylineExposure([10, -5], SOUTH_45)).toBe(1);
    expect(s.polylineExposure([], SOUTH_45)).toBe(0);
    expect(s.polylineExposure([-30, -10, 50, -10], sun(180, -5))).toBe(0);
  });
});

describe('ulica N–S między dwiema pierzejami (wybór strony ulicy)', () => {
  // Jezdnia o szerokości 20 m (x ∈ [-10, 10]), kamienice 18 m po obu stronach; chodniki na x = ±8.
  const buildings: Building[] = [];
  for (let y = 0; y < 300; y += 30) {
    buildings.push(box(-30, y, -10, y + 30, 18), box(10, y, 30, y + 30, 18));
  }
  const s = scene({ buildings });
  const westPavement = [-8, 20, -8, 280];
  const eastPavement = [8, 20, 8, 280];

  it('po południu (słońce na zachodzie) zacieniony jest chodnik zachodni', () => {
    const afternoon = sun(270, 50); // cień 18 / tan(50°) ≈ 15,1 m od zachodniej pierzei
    expect(s.exposureAt(-8, 150, afternoon)).toBe(0);
    expect(s.exposureAt(8, 150, afternoon)).toBe(1);
    expect(s.polylineExposure(westPavement, afternoon)).toBe(0);
    expect(s.polylineExposure(eastPavement, afternoon)).toBe(1);
  });

  it('rano (słońce na wschodzie) zacieniony jest chodnik wschodni', () => {
    const morning = sun(90, 50);
    expect(s.polylineExposure(westPavement, morning)).toBe(1);
    expect(s.polylineExposure(eastPavement, morning)).toBe(0);
  });

  it('przy słońcu z południowego zachodu strona zachodnia nadal wygrywa', () => {
    const southWest = sun(240, 45);
    const west = s.polylineExposure(westPavement, southWest);
    const east = s.polylineExposure(eastPavement, southWest);
    expect(west).toBeLessThan(0.05);
    expect(east).toBeGreaterThan(0.9);
  });

  it('w południe (słońce wzdłuż ulicy) obie strony są w słońcu', () => {
    expect(s.polylineExposure(westPavement, sun(180, 60))).toBe(1);
    expect(s.polylineExposure(eastPavement, sun(180, 60))).toBe(1);
  });
});

describe('ShadeScene.shadowPolygons', () => {
  it('cień budynku zawiera punkt zacieniony i nie zawiera nasłonecznionego', () => {
    const s = scene({ buildings: [box(0, 0, 20, 20, 20)] });
    const polygons = s.shadowPolygons([-100, -100, 100, 100], SOUTH_45);
    expect(polygons).toHaveLength(1);
    expect(polygons[0].kind).toBe('building');
    const ring = polygons[0].rings[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(inShadowPolygons(polygons, 10, 30)).toBe(true);
    expect(inShadowPolygons(polygons, 10, 39.5)).toBe(true);
    expect(inShadowPolygons(polygons, 10, 10)).toBe(true);
    expect(inShadowPolygons(polygons, 10, 41)).toBe(false);
    expect(inShadowPolygons(polygons, 10, -5)).toBe(false);
    expect(inShadowPolygons(polygons, -3, 30)).toBe(false);
  });

  it('nachodzące na siebie cienie sąsiednich budynków łączą się w jeden wielokąt', () => {
    const s = scene({ buildings: [box(0, 0, 20, 20, 20), box(20, 0, 40, 20, 15), box(45, 0, 60, 20, 30)] });
    const polygons = s.shadowPolygons([-100, -100, 200, 200], sun(250, 30));
    expect(polygons).toHaveLength(1);
  });

  it('zwraca cienie obiektów, których środek leży w oknie — sąsiednie okna nie dublują cieni', () => {
    const s = scene({
      buildings: [box(0, 0, 20, 20, 20), box(1000, 1000, 1020, 1020, 20)],
      trees: [tree(40, 10, 10, 3)],
    });
    expect(s.shadowPolygons([-50, -50, 100, 100], SOUTH_45)).toHaveLength(2);
    // Okno obejmuje sam cień, ale nie środek budynku: cień należy do okna z budynkiem.
    expect(s.shadowPolygons([0, 30, 20, 35], SOUTH_45)).toHaveLength(0);
    expect(s.shadowPolygons([300, 300, 400, 400], SOUTH_45)).toHaveLength(0);
    // Okna przylegające (granica x = 10 przechodzi przez środek budynku): każdy obiekt dokładnie w jednym.
    const west = s.shadowPolygons([-50, -50, 10, 100], SOUTH_45);
    const east = s.shadowPolygons([10, -50, 100, 100], SOUTH_45);
    expect(west).toHaveLength(0);
    expect(east.map((p) => p.kind).sort()).toEqual(['building', 'tree']);
  });

  it('dziedziniec nie jest rysowany jako cień poza zasięgiem cienia jego murów', () => {
    const s = scene({ buildings: [courtyardBuilding()] });
    const polygons = s.shadowPolygons([-10, -10, 200, 200], SOUTH_45);
    expect(inShadowPolygons(polygons, 5, 50)).toBe(true); // skrzydło budynku
    expect(inShadowPolygons(polygons, 50, 25)).toBe(true); // 5 m za południowym skrzydłem (cień 10 m)
    expect(inShadowPolygons(polygons, 50, 50)).toBe(false); // środek dziedzińca
    expect(inShadowPolygons(polygons, 50, 105)).toBe(true); // cień za budynkiem
  });

  it('współrzędne cieni są zaokrąglone do 6 miejsc po przecinku', () => {
    const s = scene({ buildings: [box(0, 0, 20, 20, 20)] });
    for (const [lon, lat] of s.shadowPolygons([-100, -100, 100, 100], SOUTH_45)[0].rings[0]) {
      expect(lon).toBe(Number(lon.toFixed(6)));
      expect(lat).toBe(Number(lat.toFixed(6)));
    }
  });

  it('gdy słońce jest przy horyzoncie lub pod nim, nie zwraca nic', () => {
    const s = scene({ buildings: [box(0, 0, 20, 20, 20)], trees: [tree(50, 50, 10, 3)] });
    expect(s.shadowPolygons([-100, -100, 100, 100], sun(180, 0.5))).toEqual([]);
    expect(s.shadowPolygons([-100, -100, 100, 100], sun(180, -20))).toEqual([]);
  });

  it('długość cienia jest ograniczona przy niskim słońcu', () => {
    const s = scene({ buildings: [box(0, 0, 20, 20, 50)] });
    const polygons = s.shadowPolygons([-100, -100, 100, 2000], sun(180, 2)); // 50 / tan(2°) ≈ 1432 m
    expect(inShadowPolygons(polygons, 10, 400)).toBe(true);
    expect(inShadowPolygons(polygons, 10, 430)).toBe(false);
  });

  it('cień bryły z min_height zaczyna się w odstępie od obrysu', () => {
    const s = scene({ buildings: [box(0, 0, 20, 10, 12, 4)] });
    const polygons = s.shadowPolygons([-100, -100, 100, 100], SOUTH_45);
    expect(inShadowPolygons(polygons, 10, 2)).toBe(false); // tu słońce wpada pod bryłę
    expect(inShadowPolygons(polygons, 10, 16)).toBe(true);
    expect(inShadowPolygons(polygons, 10, 23)).toBe(false);
  });

  it('cień drzewa to elipsa przesunięta zgodnie z wysokością korony', () => {
    const s = scene({ trees: [tree(0, 0, 10, 3)] });
    const polygons = s.shadowPolygons([-50, -50, 50, 50], SOUTH_45);
    expect(polygons).toHaveLength(1);
    expect(polygons[0].kind).toBe('tree');
    expect(inShadowPolygons(polygons, 0, 7)).toBe(true);
    expect(inShadowPolygons(polygons, 0, 10.5)).toBe(true); // półoś wzdłuż cienia: 3 / sin(45°) ≈ 4,24
    expect(inShadowPolygons(polygons, 0, 12)).toBe(false);
    expect(inShadowPolygons(polygons, 3.5, 7)).toBe(false);
    expect(inShadowPolygons(polygons, 0, 0)).toBe(false);
  });

  it('jest spójne z exposureAt w losowych punktach losowej sceny', () => {
    const random = rng(12345);
    const buildings: Building[] = [];
    const trees: Tree[] = [];
    for (let i = 0; i < 40; i++) {
      const x = random() * 360 - 180;
      const y = random() * 360 - 180;
      buildings.push(box(x, y, x + 8 + random() * 25, y + 8 + random() * 25, 6 + random() * 25));
    }
    for (let i = 0; i < 60; i++) {
      trees.push(tree(random() * 400 - 200, random() * 400 - 200, 6 + random() * 12, 2 + random() * 3));
    }
    const s = scene({ buildings, trees });

    for (const position of [sun(135, 25), sun(200, 55), sun(285, 12)]) {
      const polygons = s.shadowPolygons([-200, -200, 200, 200], position);
      const buildingShadows = polygons.filter((p) => p.kind === 'building');
      expect(buildingShadows.length).toBeGreaterThan(0);
      expect(polygons.some((p) => p.kind === 'tree')).toBe(true);

      const samples = 4000;
      let buildingMismatches = 0;
      let anyMismatches = 0;
      for (let i = 0; i < samples; i++) {
        const x = random() * 400 - 200;
        const y = random() * 400 - 200;
        const exposure = s.exposureAt(x, y, position);
        if ((exposure === 0) !== inShadowPolygons(buildingShadows, x, y)) buildingMismatches++;
        if (exposure < 1 !== inShadowPolygons(polygons, x, y)) anyMismatches++;
      }
      // Budynki: zgodność co do zaokrągleń na krawędziach. Drzewa: elipsa jest 16-kątem wpisanym.
      expect(buildingMismatches / samples).toBeLessThan(0.002);
      expect(anyMismatches / samples).toBeLessThan(0.01);
    }
  });
});

describe('wydajność (mikro-benchmark)', () => {
  it('exposureAt na gęstej scenie ~20 tys. budynków', () => {
    const random = rng(2024);
    const buildings: Building[] = [];
    const trees: Tree[] = [];
    const pitch = 34;
    const blocks = 142; // 142² = 20 164 budynki na obszarze ~4,8 × 4,8 km
    for (let i = 0; i < blocks; i++) {
      for (let j = 0; j < blocks; j++) {
        buildings.push(box(i * pitch, j * pitch, i * pitch + 22, j * pitch + 22, 9 + random() * 16));
      }
    }
    const extent = blocks * pitch;
    for (let i = 0; i < 8000; i++) {
      trees.push(tree(random() * extent, random() * extent, 8 + random() * 10, 2 + random() * 3));
    }
    const buildStart = performance.now();
    const s = scene({ buildings, trees });
    const buildMs = performance.now() - buildStart;

    const calls = 300_000;
    const points = new Float64Array(calls * 2).map(() => random() * extent);
    const report: string[] = [];
    let slowest = Infinity;
    for (const position of [sun(110, 8), sun(150, 30), sun(200, 60)]) {
      let sum = 0;
      const start = performance.now();
      for (let i = 0; i < calls; i++) sum += s.exposureAt(points[2 * i], points[2 * i + 1], position);
      const perSecond = calls / ((performance.now() - start) / 1000);
      slowest = Math.min(slowest, perSecond);
      const altitudeDeg = Math.round(position.altitude / RAD);
      report.push(`alt ${altitudeDeg}°: ${Math.round(perSecond / 1000)} tys./s (śr. ${(sum / calls).toFixed(2)})`);
    }

    const shadowStart = performance.now();
    const polygons = s.shadowPolygons([2000, 2000, 3000, 3000], sun(150, 30));
    const shadowMs = performance.now() - shadowStart;

    console.log(
      `[bench] budowa sceny: ${buildMs.toFixed(0)} ms; exposureAt: ${report.join('; ')}; ` +
        `shadowPolygons 1 km²: ${shadowMs.toFixed(0)} ms → ${polygons.length} wielokątów`,
    );
    expect(slowest).toBeGreaterThan(20_000); // luźna granica; cel to ≥ 200 tys./s
    expect(polygons.length).toBeGreaterThan(0);
  }, 120_000);
});
