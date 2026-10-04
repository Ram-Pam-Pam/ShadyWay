import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BBoxLatLon } from '../server/contracts.ts';
import { toLatLon, toXY } from '../server/geo/project.ts';
import { routingBBox, withinBudget } from '../server/graph/context.ts';
import {
  createOverpassClient,
  OverpassError,
  parseOverpassBody,
  type OverpassElement,
} from '../server/osm/overpass.ts';
import {
  buildingHeights,
  classifyWay,
  coolSpotKind,
  isBlockedNode,
  isEvergreen,
  isRaisedKerb,
  isSignalNode,
  bridgeHalfWidthM,
  bufferLine,
  parseBridgeAreas,
  parseBuildings,
  parseCoolSpot,
  parseInclinePct,
  parseKerbHeightM,
  parseMetres,
  parseOverpass,
  parseTrees,
  parseWalkWay,
  wayAttributes,
  relationInnerRings,
  relationOuterRings,
  type ParsedTile,
} from '../server/osm/parse.ts';
import {
  buildTileQuery,
  createOsmStore,
  DataUnavailableError,
  EMPTY_AREA_KEY,
  MAX_TILES_FETCHED_PER_CALL,
  mergeTiles,
  OutOfAreaError,
  TILE_FORMAT_VERSION,
  tileAt,
  tileBBox,
  tileKey,
  tilesForBBox,
} from '../server/osm/store.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function fixture(name: string): Promise<OverpassElement[]> {
  const raw = await readFile(path.join(fixturesDir, name), 'utf8');
  return (JSON.parse(raw) as { elements: OverpassElement[] }).elements;
}

describe('parseMetres / buildingHeights', () => {
  it('parsuje warianty zapisu wysokości', () => {
    expect(parseMetres('12')).toBe(12);
    expect(parseMetres('12.5 m')).toBe(12.5);
    expect(parseMetres('12,5')).toBe(12.5);
    expect(parseMetres(' 7m ')).toBe(7);
    expect(parseMetres('10 ft')).toBeCloseTo(3.048, 3);
    expect(parseMetres('wysoki')).toBeNull();
    expect(parseMetres(undefined)).toBeNull();
  });

  it('tag height ma pierwszeństwo przed kondygnacjami', () => {
    expect(buildingHeights({ building: 'yes', height: '21', 'building:levels': '2' }).height).toBe(21);
  });

  it('liczy wysokość z kondygnacji z naddatkiem na dach i kondygnacjami dachu', () => {
    expect(buildingHeights({ building: 'yes', 'building:levels': '4' }).height).toBe(13.5);
    expect(buildingHeights({ building: 'yes', 'building:levels': '4', 'roof:levels': '1' }).height).toBe(16.5);
  });

  it('stosuje wysokości domyślne według typu budynku', () => {
    expect(buildingHeights({ building: 'garage' }).height).toBe(3);
    expect(buildingHeights({ building: 'roof' }).height).toBe(4);
    expect(buildingHeights({ building: 'house' }).height).toBe(8);
    expect(buildingHeights({ building: 'apartments' }).height).toBe(18);
    expect(buildingHeights({ building: 'church' }).height).toBe(25);
    expect(buildingHeights({ building: 'yes' }).height).toBe(10);
    expect(buildingHeights({ building: 'yes', height: 'abc' }).height).toBe(10);
  });

  it('wyznacza minHeight z min_height albo building:min_level', () => {
    expect(buildingHeights({ 'building:part': 'yes', height: '20', min_height: '6' })).toEqual({
      height: 20,
      minHeight: 6,
    });
    expect(buildingHeights({ building: 'yes', height: '20', 'building:min_level': '2' }).minHeight).toBe(6);
    // Niespójne tagi nie mogą dać bryły o zerowej lub ujemnej grubości.
    const odd = buildingHeights({ building: 'yes', height: '5', min_height: '9' });
    expect(odd.height).toBeGreaterThan(odd.minHeight);
  });
});

describe('classifyWay — gdzie wolno iść pieszo', () => {
  const excluded: [string, Record<string, string>][] = [
    ['autostrada', { highway: 'motorway' }],
    ['łącznica drogi ekspresowej', { highway: 'trunk_link' }],
    ['droga w budowie', { highway: 'construction' }],
    ['peron', { highway: 'platform' }],
    ['korytarz w budynku', { highway: 'corridor' }],
    ['winda', { highway: 'elevator' }],
    ['foot=no', { highway: 'residential', foot: 'no' }],
    ['access=private', { highway: 'service', access: 'private' }],
    ['access=no', { highway: 'footway', access: 'no' }],
    ['jezdnia z sidewalk=separate', { highway: 'secondary', sidewalk: 'separate' }],
    ['jezdnia z sidewalk:both=separate', { highway: 'primary', 'sidewalk:both': 'separate' }],
    [
      'jezdnia z osobnymi chodnikami po obu stronach',
      { highway: 'tertiary', 'sidewalk:left': 'separate', 'sidewalk:right': 'separate' },
    ],
    [
      'jezdnia z osobnym chodnikiem po jedynej stronie, gdzie istnieje',
      { highway: 'residential', 'sidewalk:left': 'separate', 'sidewalk:right': 'no' },
    ],
    ['nieznana klasa drogi', { highway: 'bus_stop' }],
  ];
  it.each(excluded)('wyklucza: %s', (_label, tags) => {
    expect(classifyWay(tags)).toBeNull();
  });

  it('access=private nie blokuje, gdy foot jest jawnie dozwolony', () => {
    expect(classifyWay({ highway: 'service', access: 'private', foot: 'yes' })?.kind).toBe('street');
    expect(classifyWay({ highway: 'footway', access: 'no', foot: 'designated' })?.kind).toBe('footway');
  });

  const kinds: [Record<string, string>, string][] = [
    [{ highway: 'footway' }, 'footway'],
    [{ highway: 'footway', footway: 'sidewalk' }, 'sidewalk'],
    [{ highway: 'footway', footway: 'crossing' }, 'crossing'],
    [{ highway: 'pedestrian' }, 'pedestrian'],
    [{ highway: 'pedestrian', area: 'yes' }, 'pedestrian'],
    [{ highway: 'path' }, 'path'],
    [{ highway: 'track' }, 'path'],
    [{ highway: 'bridleway' }, 'path'],
    [{ highway: 'steps' }, 'steps'],
    [{ highway: 'cycleway' }, 'cycleway'],
    [{ highway: 'living_street' }, 'street'],
    [{ highway: 'residential' }, 'street'],
    [{ highway: 'footway', tunnel: 'yes' }, 'covered'],
    [{ highway: 'footway', tunnel: 'building_passage' }, 'covered'],
    [{ highway: 'pedestrian', covered: 'arcade' }, 'covered'],
    [{ highway: 'footway', indoor: 'yes' }, 'covered'],
  ];
  it.each(kinds)('%j → %s', (tags, kind) => {
    expect(classifyWay(tags)?.kind).toBe(kind);
  });

  it('schody są wolniejsze i droższe', () => {
    expect(classifyWay({ highway: 'steps' })).toMatchObject({ speedFactor: 0.5, penalty: 1.2, sideOffsetM: 0 });
  });

  it('droga rowerowa: bez kary tylko gdy piesi są dopuszczeni', () => {
    expect(classifyWay({ highway: 'cycleway' })?.penalty).toBe(1.5);
    expect(classifyWay({ highway: 'cycleway', foot: 'designated' })?.penalty).toBe(1);
    expect(classifyWay({ highway: 'cycleway', segregated: 'yes' })?.penalty).toBe(1);
  });

  it('ulice: odsunięcie pieszego od osi według klasy drogi', () => {
    expect(classifyWay({ highway: 'primary' })?.sideOffsetM).toBe(8);
    expect(classifyWay({ highway: 'secondary_link' })?.sideOffsetM).toBe(7);
    expect(classifyWay({ highway: 'tertiary' })?.sideOffsetM).toBe(5.5);
    expect(classifyWay({ highway: 'residential' })?.sideOffsetM).toBe(4);
    expect(classifyWay({ highway: 'service' })?.sideOffsetM).toBe(2.5);
    expect(classifyWay({ highway: 'living_street' })?.sideOffsetM).toBe(0);
    // Tagi width / lanes mają pierwszeństwo przed wartością domyślną klasy.
    expect(classifyWay({ highway: 'residential', width: '10' })?.sideOffsetM).toBe(6);
    expect(classifyWay({ highway: 'secondary', lanes: '4' })?.sideOffsetM).toBe(7.4);
  });

  it('ulice: kara zależy od klasy i informacji o chodniku', () => {
    expect(classifyWay({ highway: 'secondary', sidewalk: 'both' })).toMatchObject({ penalty: 1, sidewalk: 'both' });
    expect(classifyWay({ highway: 'primary', sidewalk: 'left' })).toMatchObject({ penalty: 1, sidewalk: 'left' });
    expect(classifyWay({ highway: 'residential' })).toMatchObject({ penalty: 1.1, sidewalk: 'unknown' });
    expect(classifyWay({ highway: 'tertiary' })?.penalty).toBe(1.4);
    expect(classifyWay({ highway: 'primary' })?.penalty).toBe(1.8);
    expect(classifyWay({ highway: 'tertiary', sidewalk: 'no' })).toMatchObject({ penalty: 2.5, sidewalk: 'no' });
    expect(classifyWay({ highway: 'living_street' })?.penalty).toBe(1);
    expect(classifyWay({ highway: 'service', service: 'driveway' })?.penalty).toBe(1.25);
  });

  it('chodnik osobny tylko z jednej strony nie usuwa jezdni', () => {
    const cls = classifyWay({ highway: 'secondary', 'sidewalk:left': 'separate', 'sidewalk:right': 'yes' });
    expect(cls).toMatchObject({ kind: 'street', sidewalk: 'right', penalty: 1 });
    expect(classifyWay({ highway: 'residential', 'sidewalk:left': 'separate' })?.sidewalk).toBe('separate');
  });

  it('sidewalk=separate nie wyklucza dróg serwisowych ani pieszych', () => {
    expect(classifyWay({ highway: 'service', sidewalk: 'separate' })?.kind).toBe('street');
    expect(classifyWay({ highway: 'living_street', sidewalk: 'separate' })?.kind).toBe('street');
  });

  it('tunel drogowy jest w pełni zacieniony i nie ma stron', () => {
    expect(classifyWay({ highway: 'residential', tunnel: 'yes' })).toMatchObject({
      kind: 'covered',
      covered: true,
      sideOffsetM: 0,
    });
  });
});

describe('parseOverpass na fixture', () => {
  let tile: ParsedTile;
  beforeEach(async () => {
    tile = parseOverpass(await fixture('overpass-tile-a.json'));
  });

  it('budynki: zamyka pierścienie, pomija zdegenerowane, czyta wysokości', () => {
    expect(tile.buildings.map((b) => b.id).sort((a, b) => a - b)).toEqual([-500000, 101, 102]);
    const byId = new Map(tile.buildings.map((b) => [b.id, b]));
    expect(byId.get(101)).toMatchObject({ height: 13.5, minHeight: 0 });
    expect(byId.get(102)!.height).toBe(12.5);
    for (const b of tile.buildings) {
      expect(b.ring.length).toBeGreaterThanOrEqual(8);
      expect(b.ring.slice(0, 2)).toEqual(b.ring.slice(-2));
    }
    // Droga 102 w fixture nie była domknięta: 4 punkty + domknięcie.
    expect(byId.get(102)!.ring).toHaveLength(10);
  });

  it('relacja multipolygon: skleja pierścień zewnętrzny z dwóch dróg, a inner zostaje dziedzińcem', async () => {
    const relation = (await fixture('overpass-tile-a.json')).find((e) => e.type === 'relation')!;
    const rings = relationOuterRings(relation);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(10);
    expect(rings[0].slice(0, 2)).toEqual(rings[0].slice(-2));
    const church = tile.buildings.find((b) => b.id === -500000)!;
    expect(church.height).toBe(30);
    // Prostokąt ok. 35,7 m × 33,4 m.
    const xs = church.ring.filter((_, i) => i % 2 === 0);
    const ys = church.ring.filter((_, i) => i % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(35.7, 0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(33.4, 0);

    expect(relationInnerRings(relation)).toHaveLength(1);
    expect(church.holes).toHaveLength(1);
    const hole = church.holes![0];
    expect(hole.slice(0, 2)).toEqual(hole.slice(-2));
    // Dziedziniec leży w całości wewnątrz obrysu.
    for (let i = 0; i < hole.length; i += 2) {
      expect(hole[i]).toBeGreaterThan(Math.min(...xs));
      expect(hole[i]).toBeLessThan(Math.max(...xs));
      expect(hole[i + 1]).toBeGreaterThan(Math.min(...ys));
      expect(hole[i + 1]).toBeLessThan(Math.max(...ys));
    }
    // Zwykłe budynki (drogi) nie mają pola holes.
    expect(tile.buildings.find((b) => b.id === 101)).not.toHaveProperty('holes');
  });

  it('dziedziniec trafia do tego pierścienia zewnętrznego, w którym leży', () => {
    const square = (lat: number, lon: number, size: number) => [
      { lat, lon },
      { lat, lon: lon + size },
      { lat: lat + size, lon: lon + size },
      { lat: lat + size, lon },
      { lat, lon },
    ];
    const buildings = parseBuildings({
      type: 'relation',
      id: 7,
      tags: { type: 'multipolygon', building: 'yes' },
      members: [
        { type: 'way', ref: 1, role: 'outer', geometry: square(50.06, 19.93, 0.001) },
        { type: 'way', ref: 2, role: 'outer', geometry: square(50.07, 19.95, 0.001) },
        { type: 'way', ref: 3, role: 'inner', geometry: square(50.0703, 19.9503, 0.0004) },
        // Niedomknięty inner jest odrzucany.
        { type: 'way', ref: 4, role: 'inner', geometry: square(50.0603, 19.9303, 0.0004).slice(0, 3) },
      ],
    });
    expect(buildings.map((b) => b.id)).toEqual([-7000, -7001]);
    expect(buildings[0].holes).toBeUndefined();
    expect(buildings[1].holes).toHaveLength(1);
  });

  it('isBlockedNode: brama zamknięta dla pieszych blokuje, zwykła bariera i jawne foot=yes nie', () => {
    expect(isBlockedNode({ barrier: 'gate', access: 'private' })).toBe(true);
    expect(isBlockedNode({ barrier: 'gate', access: 'no' })).toBe(true);
    expect(isBlockedNode({ barrier: 'wicket_gate', foot: 'no' })).toBe(true);
    expect(isBlockedNode({ barrier: 'gate', foot: 'private', access: 'yes' })).toBe(true);
    expect(isBlockedNode({ barrier: 'gate', locked: 'yes' })).toBe(true);
    expect(isBlockedNode({ barrier: 'gate', access: 'private', foot: 'yes' })).toBe(false);
    expect(isBlockedNode({ barrier: 'gate', access: 'permissive' })).toBe(false);
    expect(isBlockedNode({ barrier: 'gate' })).toBe(false);
    expect(isBlockedNode({ barrier: 'bollard' })).toBe(false);
    expect(isBlockedNode({ access: 'private' })).toBe(false);
  });

  it('parseOverpass zbiera zablokowane węzły, a mergeTiles łączy je bez powtórzeń', () => {
    const gate = (id: number, tags: Record<string, string>): OverpassElement => ({ type: 'node', id, lat: 50.06, lon: 19.93, tags });
    const a = parseOverpass([gate(1, { barrier: 'gate', access: 'private' }), gate(2, { barrier: 'gate' })]);
    const b = parseOverpass([gate(1, { barrier: 'gate', access: 'private' }), gate(3, { barrier: 'door', foot: 'no' })]);
    expect(a.blockedNodeIds).toEqual([1]);
    expect(mergeTiles('k', [0, 0, 1, 1], [a, b]).blockedNodeIds.sort()).toEqual([1, 3]);
  });

  it('drzewa: tagi, wartości domyślne i szpaler', () => {
    const byId = new Map(tile.trees.map((t) => [t.id, t]));
    expect(byId.get(301)).toMatchObject({ height: 18, crownRadius: 4.5 });
    expect(byId.get(302)).toMatchObject({ height: 10, crownRadius: 3.5 });
    const row = tile.trees.filter((t) => t.id < 0);
    // Szpaler ~50 m → 6 odstępów po ~8,3 m → 7 drzew, z deterministycznymi id.
    expect(row.map((t) => t.id)).toEqual([-401000, -401001, -401002, -401003, -401004, -401005, -401006]);
    const gaps = row.slice(1).map((t, i) => Math.hypot(t.x - row[i].x, t.y - row[i].y));
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 1);
    expect(gaps[0]).toBeGreaterThan(7);
    expect(gaps[0]).toBeLessThan(9);
  });

  it('szpaler łamany: drzewa leżą na linii i obejmują oba końce', () => {
    const trees = parseTrees({
      type: 'way',
      id: 7,
      tags: { natural: 'tree_row', height: '100' },
      geometry: [
        { lat: 50.06, lon: 19.93 },
        { lat: 50.0602, lon: 19.93 },
        { lat: 50.0602, lon: 19.9303 },
      ],
    });
    expect(trees.length).toBeGreaterThan(3);
    expect(trees[0].height).toBe(40); // obcięte do rozsądnego zakresu
    const first = trees[0];
    const last = trees[trees.length - 1];
    expect(first.x).toBeCloseTo(last.x - 21.4, 0);
    expect(last.y - first.y).toBeCloseTo(22.2, 0);
  });

  it('zadrzewienia: pierścień i domyślna wysokość', () => {
    expect(tile.canopies).toHaveLength(1);
    expect(tile.canopies[0]).toMatchObject({ id: 601, height: 15 });
    expect(tile.canopies[0].ring).toHaveLength(10);
  });

  it('drogi: chodnik zostaje, jezdnia z osobnymi chodnikami i autostrada odpadają', () => {
    expect(tile.ways.map((w) => w.id).sort()).toEqual([201, 203]);
    const sidewalk = tile.ways.find((w) => w.id === 201)!;
    expect(sidewalk).toMatchObject({
      kind: 'sidewalk',
      highway: 'footway',
      name: 'Aleja Adama Mickiewicza',
      covered: false,
      nodeIds: [1, 2, 3],
      penalty: 1,
      speedFactor: 1,
      sideOffsetM: 0,
    });
    expect(sidewalk.coords).toHaveLength(sidewalk.nodeIds.length * 2);
  });

  it('droga bez listy węzłów albo z niezgodną geometrią jest pomijana', () => {
    const geometry = [
      { lat: 50.06, lon: 19.93 },
      { lat: 50.061, lon: 19.93 },
    ];
    expect(parseWalkWay({ type: 'way', id: 1, tags: { highway: 'footway' }, geometry })).toBeNull();
    expect(parseWalkWay({ type: 'way', id: 1, tags: { highway: 'footway' }, nodes: [1, 2, 3], geometry })).toBeNull();
    expect(parseWalkWay({ type: 'way', id: 1, tags: { highway: 'footway' }, nodes: [1, 2], geometry })).not.toBeNull();
  });
});

describe('siatka kafli', () => {
  it('klucz i bbox kafla dla Rynku Głównego', () => {
    const tile = tileAt(50.0617, 19.9373);
    expect(tile).toEqual({ ix: 664, iy: 2503 });
    expect(tileKey(tile)).toBe('664_2503');
    expect(tileBBox(tile)).toEqual({ west: 19.92, south: 50.06, east: 19.95, north: 50.08 });
  });

  it('punkt na linii siatki należy do kafla na północny wschód od niej', () => {
    expect(tileAt(50.06, 19.92)).toEqual({ ix: 664, iy: 2503 });
    expect(tileAt(50.08, 19.95)).toEqual({ ix: 665, iy: 2504 });
  });

  it('tilesForBBox: bbox w jednym kaflu, przez granicę i dokładnie na krawędziach', () => {
    expect(tilesForBBox({ west: 19.93, south: 50.061, east: 19.94, north: 50.065 })).toEqual([{ ix: 664, iy: 2503 }]);
    expect(tilesForBBox({ west: 19.94, south: 50.055, east: 19.96, north: 50.065 }).map(tileKey)).toEqual([
      '664_2502',
      '665_2502',
      '664_2503',
      '665_2503',
    ]);
    // bbox równy kaflowi nie dobiera sąsiadów.
    expect(tilesForBBox(tileBBox({ ix: 664, iy: 2503 })).map(tileKey)).toEqual(['664_2503']);
  });

  it('zapytanie Overpass ma bbox kafla i osobne instrukcje out', () => {
    const query = buildTileQuery({ west: 19.92, south: 50.06, east: 19.95, north: 50.08 });
    expect(query).toContain('[bbox:50.06,19.92,50.08,19.95]');
    expect(query).toContain('way["highway"]->.roads;\n.roads out body geom qt;');
    // Bariery tylko z węzłów dróg — po nich wykrywamy bramy zamknięte dla pieszych.
    expect(query).toContain('node(w.roads)["barrier"];\nout body qt;');
    // Relacje muszą wyjść z "body" — inaczej Overpass nie zwraca członków z geometrią.
    expect(query).toMatch(/relation\["building"\];.*\nout body geom qt;/);
    expect(query).toContain('way["natural"="tree_row"]');
    expect(query).toContain('node["natural"="tree"];\nout body qt;');
  });

  it('zapytanie v2: węzły przejść i krawężników na drogach, punkty chłodu, parki', () => {
    const query = buildTileQuery({ west: 19.92, south: 50.06, east: 19.95, north: 50.08 });
    // Węzły przejść/krawężników tylko z dróg i bez współrzędnych (wystarczą id + tagi).
    expect(query).toMatch(/node\(w\.roads\)\["highway"~"\^\(crossing\|traffic_signals\)\$"\];.*\nout tags qt;/);
    for (const filter of ['node(w.roads)["crossing"]', 'node(w.roads)["crossing:signals"]', 'node(w.roads)["kerb"]']) {
      expect(query).toContain(filter);
    }
    expect(query).toContain('node["amenity"~"^(drinking_water|water_point|fountain|bench|shelter)$"]');
    expect(query).toContain('node["man_made"~"^(water_tap|drinking_fountain)$"]');
    expect(query).toContain('way["leisure"~"^(park|garden)$"]');
    expect(query).toMatch(/relation\["leisure"~"\^\(park\|garden\)\$"\];.*\);\nout body geom qt;/);
  });
});

describe('v2: sygnalizacja na przejściach', () => {
  let tile: ParsedTile;
  beforeEach(async () => {
    tile = parseOverpass(await fixture('overpass-tile-v2.json'));
  });
  const way = (id: number) => tile.ways.find((w) => w.id === id)!;

  it('isSignalNode: crossing=traffic_signals, crossing:signals, highway=traffic_signals', () => {
    expect(isSignalNode({ highway: 'crossing', crossing: 'traffic_signals' })).toBe(true);
    expect(isSignalNode({ highway: 'crossing', crossing: 'marked', 'crossing:signals': 'yes' })).toBe(true);
    expect(isSignalNode({ highway: 'crossing', crossing: 'traffic_signals;marked' })).toBe(true);
    expect(isSignalNode({ highway: 'traffic_signals' })).toBe(true);
    expect(isSignalNode({ highway: 'traffic_signals', crossing: 'traffic_signals' })).toBe(true);
    expect(isSignalNode({ highway: 'traffic_signals', crossing: 'no' })).toBe(false);
    expect(isSignalNode({ highway: 'crossing', crossing: 'traffic_signals', 'crossing:signals': 'no' })).toBe(false);
    expect(isSignalNode({ highway: 'crossing', crossing: 'uncontrolled' })).toBe(false);
    expect(isSignalNode({ highway: 'crossing' })).toBe(false);
    expect(isSignalNode({ kerb: 'raised' })).toBe(false);
  });

  it('przejście otagowane crossing=traffic_signals albo crossing:signals=yes ma signals', () => {
    expect(way(700)).toMatchObject({ kind: 'crossing', signals: true });
    const geometry = [
      { lat: 50.06, lon: 19.93 },
      { lat: 50.0601, lon: 19.93 },
    ];
    const crossing = (tags: Record<string, string>) =>
      parseWalkWay({ type: 'way', id: 1, nodes: [1, 2], geometry, tags: { highway: 'footway', footway: 'crossing', ...tags } })!;
    expect(crossing({ crossing: 'marked', 'crossing:signals': 'yes' }).signals).toBe(true);
    expect(crossing({ crossing: 'marked' }).signals).toBeUndefined();
    expect(crossing({}).signals).toBeUndefined();
  });

  it('przejście bez tagów dziedziczy sygnalizację z węzła na swojej geometrii', () => {
    expect(way(701)).toMatchObject({ kind: 'crossing', signals: true });
    // highway=traffic_signals na węźle przejścia (także path=crossing).
    expect(way(704)).toMatchObject({ kind: 'crossing', signals: true });
  });

  it('brak sygnalizacji: przejście niekontrolowane, jawne crossing:signals=no, zwykły chodnik przez węzeł ze światłami', () => {
    expect(way(702).kind).toBe('crossing');
    expect(way(702).signals).toBeUndefined();
    expect(way(703).signals).toBeUndefined();
    expect(way(705).kind).toBe('sidewalk');
    expect(way(705).signals).toBeUndefined();
  });

  it('mergeTiles: sygnalizacja rozpoznana tylko w jednym kaflu nie ginie, a kafle źródłowe się nie zmieniają', () => {
    const elements = [
      {
        type: 'way',
        id: 1,
        tags: { highway: 'footway', footway: 'crossing' },
        nodes: [1, 2],
        geometry: [
          { lat: 50.06, lon: 19.9499 },
          { lat: 50.06, lon: 19.9501 },
        ],
      },
    ] as OverpassElement[];
    const signalNode: OverpassElement = { type: 'node', id: 2, tags: { highway: 'crossing', crossing: 'traffic_signals' } };
    const west = parseOverpass(elements);
    const east = parseOverpass([...elements, signalNode]);
    expect(west.ways[0].signals).toBeUndefined();
    const area = mergeTiles('k', [0, 0, 1, 1], [west, east]);
    expect(area.ways).toHaveLength(1);
    expect(area.ways[0].signals).toBe(true);
    expect(west.ways[0].signals).toBeUndefined();
  });
});

describe('v2: cechy dróg dla profili poruszania się', () => {
  it('parseInclinePct: procenty, stopnie, opisy', () => {
    expect(parseInclinePct('5%')).toBe(5);
    expect(parseInclinePct('-8 %')).toBe(8);
    expect(parseInclinePct('7,5%')).toBe(7.5);
    expect(parseInclinePct('10°')).toBeCloseTo(17.6, 1);
    expect(parseInclinePct('4')).toBe(4);
    expect(parseInclinePct('steep')).toBe(12);
    expect(parseInclinePct('flat')).toBe(0);
    expect(parseInclinePct('0')).toBe(0);
    expect(parseInclinePct('250%')).toBe(100);
    // Kierunek bez wielkości i wartości nieczytelne → nieznane.
    expect(parseInclinePct('up')).toBeUndefined();
    expect(parseInclinePct('down')).toBeUndefined();
    expect(parseInclinePct('90°')).toBeUndefined();
    expect(parseInclinePct('stromo')).toBeUndefined();
    expect(parseInclinePct(undefined)).toBeUndefined();
  });

  it('wayAttributes: surface, smoothness, wheelchair, lit, ramp', () => {
    expect(wayAttributes({ highway: 'footway', surface: 'paving_stones', smoothness: 'good' }, 'footway')).toEqual({
      surface: 'paving_stones',
      smoothness: 'good',
    });
    expect(wayAttributes({ highway: 'footway', wheelchair: 'designated' }, 'footway').wheelchair).toBe('yes');
    expect(wayAttributes({ highway: 'footway', wheelchair: 'no' }, 'footway').wheelchair).toBe('no');
    expect(wayAttributes({ highway: 'footway', wheelchair: 'bad' }, 'footway')).toEqual({});
    expect(wayAttributes({ highway: 'footway', lit: '24/7' }, 'footway').lit).toBe(true);
    expect(wayAttributes({ highway: 'footway', lit: 'no' }, 'footway').lit).toBe(false);
    expect(wayAttributes({ highway: 'footway' }, 'footway')).toEqual({});
    // Rampa tylko na schodach; rampa rowerowa się nie liczy.
    expect(wayAttributes({ highway: 'steps', ramp: 'yes' }, 'steps').ramp).toBe(true);
    expect(wayAttributes({ highway: 'steps', 'ramp:wheelchair': 'yes' }, 'steps').ramp).toBe(true);
    expect(wayAttributes({ highway: 'steps', 'ramp:bicycle': 'yes' }, 'steps').ramp).toBeUndefined();
    expect(wayAttributes({ highway: 'footway', ramp: 'yes' }, 'footway').ramp).toBeUndefined();
  });

  it('drogi z fixture: pola trafiają do WalkWay, a kary i prędkości zostają bez zmian', async () => {
    const tile = parseOverpass(await fixture('overpass-tile-v2.json'));
    const way = (id: number) => tile.ways.find((w) => w.id === id)!;
    expect(way(706)).toMatchObject({
      kind: 'footway',
      surface: 'sett',
      smoothness: 'bad',
      wheelchair: 'limited',
      inclinePct: 8,
      lit: true,
      penalty: 1,
      speedFactor: 1,
    });
    expect(way(707)).toMatchObject({ kind: 'steps', ramp: true, wheelchair: 'no', penalty: 1.2, speedFactor: 0.5 });
    expect(way(707).inclinePct).toBeUndefined();
    // Dla jezdni liczy się nawierzchnia chodnika, jeśli jest podana.
    expect(way(708)).toMatchObject({ kind: 'street', surface: 'paving_stones', lit: false, penalty: 1.1 });
    expect(wayAttributes({ highway: 'residential', surface: 'sett' }, 'street').surface).toBe('sett');
    // Droga bez nowych tagów nie dostaje żadnych nowych pól.
    for (const key of ['signals', 'surface', 'smoothness', 'wheelchair', 'inclinePct', 'ramp', 'lit']) {
      expect(way(705)).not.toHaveProperty(key);
    }
  });
});

describe('v2: krawężniki', () => {
  it('parseKerbHeightM / isRaisedKerb', () => {
    expect(parseKerbHeightM('0.05')).toBe(0.05);
    expect(parseKerbHeightM('0,12 m')).toBe(0.12);
    expect(parseKerbHeightM('5 cm')).toBe(0.05);
    expect(parseKerbHeightM('30mm')).toBe(0.03);
    expect(parseKerbHeightM('wysoki')).toBeNull();
    expect(isRaisedKerb({ kerb: 'raised' })).toBe(true);
    expect(isRaisedKerb({ kerb: 'lowered' })).toBe(false);
    expect(isRaisedKerb({ kerb: 'flush' })).toBe(false);
    expect(isRaisedKerb({ kerb: 'yes' })).toBe(false);
    // Zmierzona wysokość ma pierwszeństwo przed opisem; próg 3 cm.
    expect(isRaisedKerb({ kerb: 'lowered', 'kerb:height': '0.06' })).toBe(true);
    expect(isRaisedKerb({ kerb: 'raised', 'kerb:height': '2 cm' })).toBe(false);
    expect(isRaisedKerb({ 'kerb:height': '3 cm' })).toBe(false);
  });

  it('raisedKerbNodeIds: tylko węzły leżące na drogach pieszych; mergeTiles łączy bez powtórzeń', async () => {
    const tile = parseOverpass(await fixture('overpass-tile-v2.json'));
    // 90: kerb=raised; 92: 5 cm; 91 obniżony; 86: raised, ale zmierzone 2 cm; 93 leży tylko na autostradzie.
    expect(tile.raisedKerbNodeIds.sort()).toEqual([90, 92]);
    const other: ParsedTile = { ...tile, raisedKerbNodeIds: [92, 99] };
    expect(mergeTiles('k', [0, 0, 1, 1], [tile, other]).raisedKerbNodeIds?.sort()).toEqual([90, 92, 99]);
  });
});

describe('v2: drzewa zimozielone', () => {
  it('isEvergreen: leaf_type, leaf_cycle, rodzaj i gatunek', () => {
    expect(isEvergreen({ leaf_type: 'needleleaved' })).toBe(true);
    expect(isEvergreen({ leaf_cycle: 'evergreen', leaf_type: 'broadleaved' })).toBe(true);
    expect(isEvergreen({ genus: 'Pinus' })).toBe(true);
    expect(isEvergreen({ species: 'Abies alba' })).toBe(true);
    expect(isEvergreen({ taxon: 'Thuja occidentalis' })).toBe(true);
    expect(isEvergreen({ species: 'Taxus baccata' })).toBe(true);
    expect(isEvergreen({ 'species:pl': 'Świerk pospolity' })).toBe(true);
    expect(isEvergreen({ 'genus:pl': 'sosna' })).toBe(true);
    // Modrzew: iglasty, ale zrzuca igły; jawne leaf_cycle=deciduous wygrywa.
    expect(isEvergreen({ leaf_type: 'needleleaved', genus: 'Larix' })).toBe(false);
    expect(isEvergreen({ leaf_type: 'needleleaved', leaf_cycle: 'deciduous' })).toBe(false);
    expect(isEvergreen({ leaf_type: 'broadleaved' })).toBe(false);
    expect(isEvergreen({ genus: 'Tilia' })).toBe(false);
    // Dopasowanie całych słów: "Narcissus" zawiera "cis", "Pinuso" to nie "Pinus".
    expect(isEvergreen({ species: 'Narcissus' })).toBe(false);
    expect(isEvergreen({})).toBe(false);
  });

  it('Tree.evergreen jest ustawiane tylko dla zimozielonych; szpaler dziedziczy tagi', async () => {
    const tile = parseOverpass(await fixture('overpass-tile-v2.json'));
    const evergreen = tile.trees.filter((t) => t.evergreen).map((t) => t.id).sort();
    expect(evergreen).toEqual([310, 312, 313, 315]);
    expect(tile.trees.find((t) => t.id === 314)).not.toHaveProperty('evergreen');
    const row = parseTrees({
      type: 'way',
      id: 9,
      tags: { natural: 'tree_row', genus: 'Thuja' },
      geometry: [
        { lat: 50.06, lon: 19.93 },
        { lat: 50.0602, lon: 19.93 },
      ],
    });
    expect(row.length).toBeGreaterThan(1);
    expect(row.every((t) => t.evergreen === true)).toBe(true);
  });
});

describe('v2: punkty chłodu', () => {
  let tile: ParsedTile;
  beforeEach(async () => {
    tile = parseOverpass(await fixture('overpass-tile-v2.json'));
  });
  const spot = (id: string) => tile.coolSpots.find((s) => s.id === id);

  it('coolSpotKind: reguły tagów', () => {
    expect(coolSpotKind({ amenity: 'drinking_water' }, false)).toBe('drinking_water');
    expect(coolSpotKind({ man_made: 'water_tap' }, false)).toBe('drinking_water');
    expect(coolSpotKind({ man_made: 'drinking_fountain' }, false)).toBe('drinking_water');
    expect(coolSpotKind({ man_made: 'water_tap', drinking_water: 'no' }, false)).toBeNull();
    expect(coolSpotKind({ amenity: 'fountain' }, false)).toBe('fountain');
    expect(coolSpotKind({ amenity: 'fountain', fountain: 'bubbler' }, false)).toBe('drinking_water');
    expect(coolSpotKind({ amenity: 'fountain', fountain: 'mist' }, false)).toBe('water_mist');
    expect(coolSpotKind({ amenity: 'fountain', name: 'Kurtyna wodna przy Rynku' }, true)).toBe('water_mist');
    expect(coolSpotKind({ amenity: 'drinking_water', description: 'kurtyny wodne latem' }, false)).toBe('water_mist');
    expect(coolSpotKind({ name: 'Kurtyna wodna' }, false)).toBe('water_mist');
    // Sama nazwa nie wystarcza dla drogi ani dla obszaru bez fontanny.
    expect(coolSpotKind({ highway: 'bus_stop', name: 'Kurtyna wodna' }, false)).toBeNull();
    expect(coolSpotKind({ building: 'yes', name: 'Kurtyna wodna' }, true)).toBeNull();
    expect(coolSpotKind({ amenity: 'bench' }, false)).toBe('bench');
    expect(coolSpotKind({ amenity: 'shelter' }, true)).toBe('shelter');
    expect(coolSpotKind({ leisure: 'park' }, true)).toBe('park');
    expect(coolSpotKind({ leisure: 'garden' }, true)).toBe('park');
    expect(coolSpotKind({ leisure: 'park' }, false)).toBeNull();
    expect(coolSpotKind({ leisure: 'garden', 'garden:type': 'residential' }, true)).toBeNull();
    expect(coolSpotKind({ leisure: 'garden', access: 'private', name: 'Ogród' }, true)).toBeNull();
    expect(coolSpotKind({ amenity: 'cafe' }, false)).toBeNull();
  });

  it('węzły: rodzaje, stabilne id, nazwy; prywatne i niezdatne do picia odpadają', () => {
    expect(spot('n800')).toMatchObject({ kind: 'drinking_water' });
    expect(spot('n801')).toMatchObject({ kind: 'fountain', name: 'Fontanna' });
    expect(spot('n802')!.kind).toBe('water_mist');
    expect(spot('n803')).toMatchObject({ kind: 'water_mist', name: 'Kurtyna wodna' });
    expect(spot('n804')).toEqual({ id: 'n804', kind: 'bench', x: expect.any(Number), y: expect.any(Number) });
    expect(spot('n805')!.kind).toBe('shelter');
    expect(spot('n806')!.kind).toBe('drinking_water');
    expect(spot('n809')!.kind).toBe('drinking_water');
    expect(spot('n807')).toBeUndefined();
    expect(spot('n808')).toBeUndefined();
    const [x, y] = toXY(50.063, 19.93);
    expect(spot('n800')!.x).toBeCloseTo(x, 1);
    expect(spot('n800')!.y).toBeCloseTo(y, 1);
  });

  it('parki: nazwane albo duże; punkt w środku obrysu', () => {
    // Skwer ~14 × 22 m, ale nazwany → jest; ogród tej samej wielkości bez nazwy → nie ma.
    expect(spot('w820')).toMatchObject({ kind: 'park', name: 'Skwer Testowy' });
    expect(spot('w821')).toBeUndefined();
    // Park bez nazwy ~43 × 67 m (≈ 2860 m²) → jest; ogród przydomowy bez nazwy → nie ma mimo rozmiaru.
    expect(spot('w822')!.kind).toBe('park');
    expect(spot('w822')).not.toHaveProperty('name');
    expect(spot('w824')).toBeUndefined();
    const [cx, cy] = toXY(50.0673, 19.9403);
    expect(spot('w822')!.x).toBeCloseTo(cx, 0);
    expect(spot('w822')!.y).toBeCloseTo(cy, 0);
  });

  it('obszar z dziurą w środku: punkt leży w parku, nie w dziurze', () => {
    const park = spot('r830')!;
    expect(park).toMatchObject({ kind: 'park', name: 'Park z dziurą' });
    const [west, south] = toXY(50.07, 19.93);
    const [east, north] = toXY(50.071, 19.9315);
    const [holeWest] = toXY(50.0703, 19.9304);
    const [holeEast] = toXY(50.0707, 19.9312);
    expect(park.y).toBeGreaterThan(south);
    expect(park.y).toBeLessThan(north);
    expect(park.x).toBeGreaterThan(west);
    expect(park.x).toBeLessThan(east);
    expect(park.x > holeWest && park.x < holeEast).toBe(false);
    // Szerszy jest pas zachodni (0,0004° wobec 0,0003°) — punkt trafia w jego środek.
    expect(park.x).toBeCloseTo((west + holeWest) / 2, 0);
  });

  it('fontanna i ławka narysowane jako drogi dają punkt z id "w…"', () => {
    expect(spot('w823')).toMatchObject({ kind: 'fountain', name: 'Fontanna na placu' });
    expect(spot('w825')!.kind).toBe('bench');
    const [x] = toXY(50.064, 19.9401);
    expect(spot('w825')!.x).toBeCloseTo(x, 0);
  });

  it('parseCoolSpot pomija elementy bez tagów, bez współrzędnych i niepasujące', () => {
    expect(parseCoolSpot({ type: 'node', id: 1, lat: 50.06, lon: 19.93 })).toBeNull();
    expect(parseCoolSpot({ type: 'node', id: 1, tags: { amenity: 'bench' } })).toBeNull();
    expect(parseCoolSpot({ type: 'node', id: 1, lat: 50.06, lon: 19.93, tags: { natural: 'tree' } })).toBeNull();
    expect(parseCoolSpot({ type: 'way', id: 1, tags: { leisure: 'park', name: 'Bez geometrii' } })).toBeNull();
  });

  it('zliczenie rodzajów w fixture', () => {
    const counts: Record<string, number> = {};
    for (const s of tile.coolSpots) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    expect(counts).toEqual({ drinking_water: 3, fountain: 2, water_mist: 2, bench: 2, shelter: 1, park: 3 });
  });

  it('mergeTiles deduplikuje punkty chłodu po id i toleruje kafel bez nowych kolekcji', () => {
    const legacy = { buildings: [], trees: [], canopies: [], ways: [], blockedNodeIds: [] } as unknown as ParsedTile;
    const area = mergeTiles('k', [0, 0, 1, 1], [tile, legacy, tile]);
    expect(area.coolSpots).toHaveLength(tile.coolSpots.length);
    expect(new Set(area.coolSpots!.map((s) => s.id)).size).toBe(tile.coolSpots.length);
    expect(mergeTiles('k', [0, 0, 1, 1], [legacy])).toMatchObject({ coolSpots: [], raisedKerbNodeIds: [] });
  });
});

describe('store: scalanie, cache, błędy', () => {
  let dir: string;
  let tileA: ParsedTile;
  let tileB: ParsedTile;
  const twoTiles: BBoxLatLon = { west: 19.94, south: 50.061, east: 19.96, north: 50.065 };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cien-osm-'));
    tileA = parseOverpass(await fixture('overpass-tile-a.json'));
    tileB = parseOverpass(await fixture('overpass-tile-b.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fetchByTile =
    (calls: string[]) =>
    async (bbox: BBoxLatLon): Promise<ParsedTile> => {
      calls.push(`${bbox.west},${bbox.south}`);
      return bbox.west < 19.95 ? tileA : tileB;
    };

  it('mergeTiles deduplikuje po id obiekty obecne w obu kaflach', () => {
    const area = mergeTiles('k', [0, 0, 1, 1], [tileA, tileB]);
    expect(area.buildings.map((b) => b.id).sort((a, b) => a - b)).toEqual([-500000, 101, 102, 110]);
    expect(area.ways.map((w) => w.id).sort()).toEqual([201, 203, 210]);
    expect(area.trees).toHaveLength(tileA.trees.length);
    expect(new Set(area.trees.map((t) => t.id)).size).toBe(area.trees.length);
  });

  it('loadArea pobiera brakujące kafle, zapisuje je na dysku i scala', async () => {
    const calls: string[] = [];
    const store = createOsmStore({ dir, fetchTile: fetchByTile(calls) });
    const area = await store.loadArea(twoTiles);

    expect(calls.sort()).toEqual(['19.92,50.06', '19.95,50.06']);
    expect(area.key).toBe('664_2503+665_2503');
    expect(area.buildings).toHaveLength(4);
    expect((await readdir(dir)).sort()).toEqual(['664_2503.json.gz', '665_2503.json.gz']);
    // bbox w metrach obejmuje oba kafle: 0,06° × 0,02°.
    const [minX, minY, maxX, maxY] = area.bboxXY;
    expect(maxX - minX).toBeCloseTo(4283, -1);
    expect(maxY - minY).toBeCloseTo(2224, -1);

    // Drugi magazyn na tym samym katalogu czyta z dysku, bez sieci.
    const failing = createOsmStore({
      dir,
      fetchTile: async () => {
        throw new Error('sieć niedostępna');
      },
    });
    const again = await failing.loadArea(twoTiles);
    expect(again.ways.map((w) => w.id).sort()).toEqual(area.ways.map((w) => w.id).sort());
    expect(again.ways.find((w) => w.id === 201)).toEqual(area.ways.find((w) => w.id === 201));
  });

  it('nowe kolekcje v2 przechodzą przez zapis na dysk i odczyt bez zmian', async () => {
    const v2 = parseOverpass(await fixture('overpass-tile-v2.json'));
    const one: BBoxLatLon = { west: 19.93, south: 50.061, east: 19.94, north: 50.065 };
    const area = await createOsmStore({ dir, fetchTile: async () => v2 }).loadArea(one);
    expect(area.coolSpots).toHaveLength(v2.coolSpots.length);
    expect(area.raisedKerbNodeIds).toEqual(v2.raisedKerbNodeIds);

    const fromDisk = await createOsmStore({
      dir,
      fetchTile: async () => {
        throw new Error('sieć niedostępna');
      },
    }).loadArea(one);
    expect(fromDisk.coolSpots).toEqual(area.coolSpots);
    expect(fromDisk.raisedKerbNodeIds).toEqual(area.raisedKerbNodeIds);
    expect(fromDisk.ways).toEqual(area.ways);
    expect(fromDisk.trees.filter((t) => t.evergreen).length).toBe(4);
    expect(fromDisk.ways.filter((w) => w.signals).map((w) => w.id).sort()).toEqual([700, 701, 704]);
  });

  it('kafel zapisany w starszej wersji formatu jest pobierany od nowa', async () => {
    const stale = { v: 2, key: '664_2503', fetchedAt: '2026-01-01T00:00:00Z', tile: { ...tileA, blockedNodeIds: undefined } };
    await writeFile(path.join(dir, '664_2503.json.gz'), gzipSync(JSON.stringify(stale)));
    const calls: string[] = [];
    const store = createOsmStore({ dir, fetchTile: fetchByTile(calls) });
    expect(await store.hasTileOnDisk({ ix: 664, iy: 2503 })).toBe(false);
    const cachedOnly = await store.loadArea({ west: 19.93, south: 50.061, east: 19.94, north: 50.065 }, { cachedOnly: true });
    expect(cachedOnly.key).toBe(EMPTY_AREA_KEY);
    expect((await store.ensureTile({ ix: 664, iy: 2503 })).source).toBe('network');
    expect(calls).toHaveLength(1);
    expect(await store.hasTileOnDisk({ ix: 664, iy: 2503 })).toBe(true);
  });

  it('równoległe żądania tego samego kafla dają jedno pobranie', async () => {
    const calls: string[] = [];
    const store = createOsmStore({ dir, fetchTile: fetchByTile(calls) });
    const one: BBoxLatLon = { west: 19.93, south: 50.061, east: 19.94, north: 50.065 };
    const [a, b] = await Promise.all([store.loadArea(one), store.loadArea(one)]);
    expect(calls).toHaveLength(1);
    expect(a.key).toBe('664_2503');
    expect(b.buildings).toHaveLength(a.buildings.length);
    expect((await store.ensureTile({ ix: 664, iy: 2503 })).source).toBe('memory');
  });

  it('cachedOnly pomija brakujące kafle i nie sięga do sieci', async () => {
    const calls: string[] = [];
    const store = createOsmStore({ dir, fetchTile: fetchByTile(calls) });
    const empty = await store.loadArea(twoTiles, { cachedOnly: true });
    expect(calls).toHaveLength(0);
    expect(empty).toMatchObject({ key: EMPTY_AREA_KEY, buildings: [], ways: [], trees: [], canopies: [], blockedNodeIds: [] });
    expect(empty).toMatchObject({ coolSpots: [], raisedKerbNodeIds: [] });

    await store.ensureTile({ ix: 665, iy: 2503 });
    const partial = await store.loadArea(twoTiles, { cachedOnly: true });
    expect(partial.key).toBe('665_2503');
    expect(partial.buildings.map((b) => b.id).sort()).toEqual([101, 110]);
    expect(calls).toHaveLength(1);
  });

  it('błąd pobierania → DataUnavailableError z komunikatem po polsku', async () => {
    const store = createOsmStore({
      dir,
      fetchTile: async () => {
        throw new Error('HTTP 429');
      },
    });
    const promise = store.loadArea(twoTiles);
    await expect(promise).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(promise).rejects.toThrow(/Nie udało się pobrać danych mapy/);
  });

  it('odrzuca obszar poza Krakowem i niepoprawny bbox, a wystający przycina', async () => {
    const calls: string[] = [];
    const store = createOsmStore({ dir, fetchTile: fetchByTile(calls) });
    await expect(store.loadArea({ west: 21.0, south: 52.2, east: 21.05, north: 52.25 })).rejects.toBeInstanceOf(
      OutOfAreaError,
    );
    await expect(store.loadArea({ west: 19.95, south: 50.07, east: 19.94, north: 50.06 })).rejects.toBeInstanceOf(
      OutOfAreaError,
    );
    expect(calls).toHaveLength(0);
    const edge = await store.loadArea({ west: 20.215, south: 50.125, east: 20.4, north: 50.3 });
    expect(edge.key).toBe('673_2506');
  });
});

describe('klient Overpass', () => {
  const ok = (body: string, status = 200): Response => new Response(body, { status });
  const mirrors = ['https://a.example/api', 'https://b.example/api'];

  it('parseOverpassBody odrzuca HTML i remark z błędem', () => {
    expect(() => parseOverpassBody('<html><body>Dispatcher error</body></html>')).toThrow(OverpassError);
    expect(() => parseOverpassBody('{"elements":[],"remark":"runtime error: Query timed out"}')).toThrow(OverpassError);
    expect(() => parseOverpassBody('{"foo":1}')).toThrow(OverpassError);
    expect(parseOverpassBody('{"elements":[]}').elements).toEqual([]);
  });

  it('przechodzi na kolejny mirror i pamięta ten, który zawiódł', async () => {
    const hits: string[] = [];
    const client = createOverpassClient({
      mirrors,
      sleepFn: async () => {},
      fetchFn: (async (url: string, init: RequestInit) => {
        hits.push(url);
        expect(init.method).toBe('POST');
        expect(String(init.body)).toMatch(/^data=/);
        expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/Canopy/);
        return url.startsWith('https://a.') ? ok('<html>429</html>', 429) : ok('{"elements":[{"type":"node","id":1}]}');
      }) as typeof fetch,
    });
    expect((await client.query('q')).elements).toHaveLength(1);
    expect(hits).toEqual([mirrors[0], mirrors[1]]);
    // Mirror A "stygnie", więc następne zapytanie zaczyna od B.
    await client.query('q');
    expect(hits).toEqual([mirrors[0], mirrors[1], mirrors[1]]);
  });

  it('po wyczerpaniu rund rzuca OverpassError z listą przyczyn', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const client = createOverpassClient({
      mirrors,
      rounds: 2,
      backoffMs: 10,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      fetchFn: (async () => {
        attempts++;
        return ok('{"elements":[],"remark":"runtime error: timeout"}');
      }) as typeof fetch,
    });
    await expect(client.query('q')).rejects.toThrow(/a\.example.*b\.example/);
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([10]);
  });

  it('budżet zapytania skraca próbę w toku: zawieszony mirror nie trzyma zapytania dłużej niż deadlineMs', async () => {
    let attempts = 0;
    const client = createOverpassClient({
      mirrors,
      rounds: 2,
      timeoutMs: 10_000,
      deadlineMs: 60,
      backoffMs: 1,
      fetchFn: ((_url: string, init: RequestInit) => {
        attempts++;
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as typeof fetch,
    });
    const started = Date.now();
    await expect(client.query('q')).rejects.toThrow(/limit czasu/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(attempts).toBe(1);
  });

  it('przerywa próbę po przekroczeniu limitu czasu', async () => {
    const client = createOverpassClient({
      mirrors: [mirrors[0]],
      rounds: 1,
      timeoutMs: 20,
      fetchFn: ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof fetch,
    });
    await expect(client.query('q')).rejects.toThrow(/limit czasu/);
  });

  it('nie przekracza limitu 2 równoległych zapytań', async () => {
    let active = 0;
    let peak = 0;
    const client = createOverpassClient({
      mirrors: [mirrors[0]],
      fetchFn: (async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return ok('{"elements":[]}');
      }) as typeof fetch,
    });
    await Promise.all(Array.from({ length: 6 }, () => client.query('q')));
    expect(peak).toBe(2);
  });
});

describe('obszar routingu a limit kafli', () => {
  it('każda para punktów do 8 km mieści się w limicie kafli pobieranych jednym wywołaniem', () => {
    // Najgorsze ustawienia: przekątna i przesunięcia względem siatki; punkty w niepobranej części miasta.
    let worst = 0;
    for (let angle = 0; angle < 180; angle += 5) {
      for (const shift of [0, 0.004, 0.009, 0.013, 0.019]) {
        const from = { lat: 50.02 + shift, lon: 20.0 + shift * 1.5 };
        const [x, y] = toXY(from.lat, from.lon);
        const rad = (angle * Math.PI) / 180;
        const [lat, lon] = toLatLon(x + 7990 * Math.cos(rad), y + 7990 * Math.sin(rad));
        worst = Math.max(worst, tilesForBBox(routingBBox(from, { lat, lon })).length);
      }
    }
    expect(worst).toBeGreaterThan(20);
    expect(worst).toBeLessThanOrEqual(MAX_TILES_FETCHED_PER_CALL);
  });

  it('withinBudget: po przekroczeniu budżetu zgłasza DataUnavailableError, a pobieranie trwa dalej', async () => {
    let finished = false;
    const slow = new Promise<string>((resolve) => setTimeout(() => {
      finished = true;
      resolve('dane');
    }, 60));
    await expect(withinBudget(slow, 10)).rejects.toBeInstanceOf(DataUnavailableError);
    expect(finished).toBe(false);
    expect(await slow).toBe('dane');
    expect(await withinBudget(Promise.resolve('od razu'), 10)).toBe('od razu');
    // Błąd pobierania, na który nikt już nie czeka, nie może zostać nieobsłużony.
    const failing = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('sieć')), 30));
    await expect(withinBudget(failing, 5)).rejects.toThrow(/trwa dłużej niż zwykle/);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

describe('v3: mosty', () => {
  const geometry = [
    { lat: 50.054, lon: 19.928 },
    { lat: 50.0545, lon: 19.928 },
    { lat: 50.055, lon: 19.928 },
  ];
  const bridgeWay = (id: number, tags: Record<string, string>): OverpassElement => ({ type: 'way', id, nodes: [1, 2, 3], geometry, tags });

  it('WalkWay.bridge: bridge=* poza "no"', () => {
    expect(parseWalkWay(bridgeWay(1, { highway: 'footway', bridge: 'yes' }))?.bridge).toBe(true);
    expect(parseWalkWay(bridgeWay(2, { highway: 'footway', bridge: 'viaduct' }))?.bridge).toBe(true);
    expect(parseWalkWay(bridgeWay(3, { highway: 'footway', bridge: 'no' }))?.bridge).toBeUndefined();
    expect(parseWalkWay(bridgeWay(4, { highway: 'footway' }))?.bridge).toBeUndefined();
  });

  it('bufor osi: pierścień o szerokości 2 × połowa, końce ucięte płasko', () => {
    const ring = bufferLine([0, 0, 0, 50, 0, 100], 4)!;
    expect(ring).toEqual([-4, 0, -4, 50, -4, 100, 4, 100, 4, 50, 4, 0, -4, 0]);
    // Zakręt 90°: złącze ukośne (narożnik odsunięty o połowę szerokości w obu osiach).
    const bent = bufferLine([0, 0, 0, 50, 50, 50], 4)!;
    expect(bent.slice(2, 4)).toEqual([-4, 54]);
    expect(bufferLine([0, 0], 4)).toBeNull();
  });

  it('szerokość pomostu: width → klasa drogi → tor; kładka wąska', () => {
    expect(bridgeHalfWidthM({ highway: 'footway', bridge: 'yes' })).toBe(3.5);
    expect(bridgeHalfWidthM({ highway: 'primary', bridge: 'yes' })).toBe(9.5);
    expect(bridgeHalfWidthM({ highway: 'primary', bridge: 'yes', width: '12' })).toBe(7.5);
    expect(bridgeHalfWidthM({ railway: 'tram', bridge: 'yes' })).toBe(3.5);
  });

  it('parseBridgeAreas: droga i tor z bridge=* jako bufor, man_made=bridge jako obrys', () => {
    const footbridge = parseBridgeAreas(bridgeWay(10, { highway: 'footway', bridge: 'yes' }));
    expect(footbridge).toHaveLength(1);
    const xs = footbridge[0].ring.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(7, 1);
    expect(parseBridgeAreas(bridgeWay(11, { railway: 'rail', bridge: 'yes' }))).toHaveLength(1);
    expect(parseBridgeAreas(bridgeWay(12, { highway: 'footway' }))).toHaveLength(0);
    expect(parseBridgeAreas(bridgeWay(13, { waterway: 'canal', bridge: 'aqueduct' }))).toHaveLength(0);
    const outline: OverpassElement = {
      type: 'way',
      id: 14,
      tags: { man_made: 'bridge' },
      geometry: [
        { lat: 50.054, lon: 19.928 },
        { lat: 50.054, lon: 19.9283 },
        { lat: 50.055, lon: 19.9283 },
        { lat: 50.055, lon: 19.928 },
        { lat: 50.054, lon: 19.928 },
      ],
    };
    const area = parseBridgeAreas(outline);
    expect(area).toHaveLength(1);
    expect(area[0].ring).toHaveLength(10);
  });

  it('parseOverpass i mergeTiles: bridgeAreas trafiają do AreaData bez powtórzeń; zapytanie pobiera mosty', () => {
    const tile = parseOverpass([bridgeWay(20, { highway: 'footway', bridge: 'yes' }), bridgeWay(21, { highway: 'footway' })]);
    expect(tile.bridgeAreas).toHaveLength(1);
    expect(tile.ways.map((w) => w.bridge)).toEqual([true, undefined]);
    const area = mergeTiles('k', [0, 0, 1, 1], [tile, tile]);
    expect(area.bridgeAreas).toHaveLength(1);
    // Kafel bez pola (starszy format) nie psuje scalania.
    const old = { ...tile, bridgeAreas: undefined };
    expect(mergeTiles('k', [0, 0, 1, 1], [old]).bridgeAreas).toEqual([]);
    const query = buildTileQuery({ west: 19.92, south: 50.06, east: 19.95, north: 50.08 });
    expect(query).toContain('way["bridge"]["bridge"!="no"]["highway"]');
    expect(query).toContain('way["man_made"="bridge"]');
    expect(query).toContain('relation["man_made"="bridge"]');
  });
});

describe('v3: kafle w starszym formacie są używane i odświeżane w tle', () => {
  let dir: string;
  const one: BBoxLatLon = { west: 19.93, south: 50.061, east: 19.94, north: 50.065 };
  const index = { ix: 664, iy: 2503 };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cien-osm-v3-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeOldTile(): Promise<ParsedTile> {
    const tile = parseOverpass(await fixture('overpass-tile-a.json'));
    const old = { ...tile, bridgeAreas: undefined };
    const file = { v: TILE_FORMAT_VERSION - 1, key: '664_2503', fetchedAt: '2026-01-01T00:00:00Z', tile: old };
    await writeFile(path.join(dir, '664_2503.json.gz'), gzipSync(JSON.stringify(file)));
    return tile;
  }

  it('Overpass nie działa: stary kafel nadal wczytuje się (bez mostów) i routing nie staje', async () => {
    const tile = await writeOldTile();
    let calls = 0;
    const store = createOsmStore({
      dir,
      fetchTile: async () => {
        calls++;
        throw new Error('sieć niedostępna');
      },
    });
    expect(await store.hasTileOnDisk(index)).toBe(false); // prefetch pobierze go od nowa
    const cachedOnly = await store.loadArea(one, { cachedOnly: true });
    expect(cachedOnly.key).toBe('664_2503');
    expect(calls).toBe(0);
    const area = await store.loadArea(one);
    expect(area.ways).toHaveLength(tile.ways.length);
    expect(area.bridgeAreas).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1); // jedna próba odświeżenia w tle
    // Po nieudanej próbie nie ponawiamy od razu, a dane dalej są dostępne.
    expect((await store.loadArea(one)).key).toBe('664_2503');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    await expect(store.ensureTile(index)).rejects.toBeInstanceOf(DataUnavailableError);
  });

  it('udane odświeżenie w tle podmienia kafel i unieważnia scalony obszar', async () => {
    const tile = await writeOldTile();
    const fresh: ParsedTile = { ...tile, bridgeAreas: [{ id: 99, ring: [0, 0, 10, 0, 10, 10, 0, 10, 0, 0] }] };
    let calls = 0;
    const store = createOsmStore({
      dir,
      fetchTile: async () => {
        calls++;
        return fresh;
      },
    });
    const before = await store.loadArea(one);
    expect(before.bridgeAreas).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    const after = await store.loadArea(one);
    expect(after).not.toBe(before);
    expect(after.bridgeAreas).toHaveLength(1);
    expect(await store.hasTileOnDisk(index)).toBe(true);
    // backgroundRefresh: false — nic nie pobiera.
    await writeOldTile();
    let quietCalls = 0;
    const quiet = createOsmStore({ dir, backgroundRefresh: false, fetchTile: async () => (quietCalls++, fresh) });
    await quiet.loadArea(one);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quietCalls).toBe(0);
  });
});
