// Czyste funkcje: elementy Overpass JSON → typy kontraktowe (budynki, drzewa, zadrzewienia, drogi piesze,
// punkty chłodu, węzły z wysokim krawężnikiem).

import type { Building, CanopyArea, CoolSpotXY, SidewalkTag, Tree, WalkWay } from '../contracts.ts';
import type { CoolSpotKind, SegmentKind } from '../../shared/types.ts';
import { toXY } from '../geo/project.ts';
import type { OverpassElement, OverpassLatLon } from './overpass.ts';

type Tags = Record<string, string>;

export interface ParsedTile {
  buildings: Building[];
  trees: Tree[];
  canopies: CanopyArea[];
  ways: WalkWay[];
  /** Węzły dróg zamknięte dla pieszych (patrz isBlockedNode). */
  blockedNodeIds: number[];
  /** Punkty chłodu (woda pitna, fontanny, kurtyny wodne, ławki, wiaty, parki) — id "n123" / "w456" / "r789". */
  coolSpots: CoolSpotXY[];
  /** Węzły dróg pieszych z wysokim krawężnikiem (patrz isRaisedKerb). */
  raisedKerbNodeIds: number[];
}

const LEVEL_HEIGHT_M = 3.0;
const ROOF_ALLOWANCE_M = 1.5;
const DEFAULT_BUILDING_HEIGHT_M = 10;
const DEFAULT_TREE_HEIGHT_M = 10;
const DEFAULT_CANOPY_HEIGHT_M = 15;
/** Promień korony przy braku diameter_crown: 0.35 × wysokość (10 m → 3.5 m). */
const CROWN_RADIUS_PER_HEIGHT = 0.35;
const TREE_ROW_SPACING_M = 8;
/** Mnożnik w syntetycznych identyfikatorach (ujemnych): -(idOSM × 1000 + indeks). */
const SYNTHETIC_ID_FACTOR = 1000;

const BUILDING_TYPE_HEIGHT_M: Record<string, number> = {
  garage: 3,
  garages: 3,
  shed: 3,
  kiosk: 3,
  hut: 3,
  carport: 3,
  roof: 4,
  service: 4,
  greenhouse: 4,
  bungalow: 5,
  house: 8,
  detached: 8,
  semidetached_house: 8,
  terrace: 8,
  chapel: 12,
  school: 12,
  university: 15,
  hospital: 15,
  office: 15,
  hotel: 18,
  apartments: 18,
  church: 25,
  cathedral: 25,
  basilica: 25,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Parsuje długość w metrach: "12", "12.5 m", "12,5", "40 ft". Zwraca null dla wartości nieczytelnych. */
export function parseMetres(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*(m|metres|meters|ft|feet|')?$/.exec(raw.trim().toLowerCase().replace(',', '.'));
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === 'ft' || match[2] === 'feet' || match[2] === "'" ? value * 0.3048 : value;
}

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** Wysokość dachu i dolnej krawędzi budynku z tagów OSM. */
export function buildingHeights(tags: Tags): { height: number; minHeight: number } {
  const minLevel = parseCount(tags['building:min_level']);
  const minHeight = clamp(parseMetres(tags.min_height) ?? (minLevel !== null ? minLevel * LEVEL_HEIGHT_M : 0), 0, 300);

  const explicit = parseMetres(tags.height) ?? parseMetres(tags['building:height']);
  const levels = parseCount(tags['building:levels']);
  let height: number;
  if (explicit !== null && explicit > 0) {
    height = explicit;
  } else if (levels !== null && levels > 0) {
    const roofLevels = Math.max(0, parseCount(tags['roof:levels']) ?? 0);
    height = levels * LEVEL_HEIGHT_M + ROOF_ALLOWANCE_M + roofLevels * LEVEL_HEIGHT_M;
  } else {
    const type = tags.building ?? tags['building:part'] ?? 'yes';
    height = BUILDING_TYPE_HEIGHT_M[type] ?? DEFAULT_BUILDING_HEIGHT_M;
  }
  height = clamp(height, 2, 300);
  // Niespójne tagi (min_height >= height): przyjmij jedną kondygnację nad dolną krawędzią.
  if (height <= minHeight) height = minHeight + LEVEL_HEIGHT_M;
  return { height: round2(height), minHeight: round2(minHeight) };
}

function isBuilding(tags: Tags): boolean {
  const building = tags.building ?? tags['building:part'];
  return building !== undefined && building !== 'no' && tags.location !== 'underground';
}

function isCanopy(tags: Tags): boolean {
  return tags.natural === 'wood' || tags.landuse === 'forest';
}

/** Geometria → płaskie [x,y,...] w metrach; pomija null-e i kolejne duplikaty punktów. */
function projectLine(geometry: (OverpassLatLon | null)[]): number[] {
  const out: number[] = [];
  for (const p of geometry) {
    if (!p) continue;
    const [x, y] = toXY(p.lat, p.lon);
    const rx = round2(x);
    const ry = round2(y);
    const n = out.length;
    if (n >= 2 && out[n - 2] === rx && out[n - 1] === ry) continue;
    out.push(rx, ry);
  }
  return out;
}

/** Zamyka pierścień; null gdy po zamknięciu ma mniej niż 4 punkty (czyli nie jest wielokątem). */
function closeRing(line: number[]): number[] | null {
  const ring = line.slice();
  const n = ring.length;
  if (n >= 4 && (ring[0] !== ring[n - 2] || ring[1] !== ring[n - 1])) ring.push(ring[0], ring[1]);
  return ring.length >= 8 ? ring : null;
}

const OUTER_ROLES = ['outer', 'outline'];
const INNER_ROLES = ['inner'];

/** Składa pierścienie multipolygonu z dróg-członków o podanych rolach, łącząc je końcami. Niedomknięte łańcuchy są odrzucane. */
function assembleRings(element: OverpassElement, roles: string[]): number[][] {
  const pieces: number[][] = [];
  for (const member of element.members ?? []) {
    if (member.type !== 'way' || !member.geometry || !roles.includes(member.role)) continue;
    const line = projectLine(member.geometry);
    if (line.length >= 4) pieces.push(line);
  }

  const rings: number[][] = [];
  const used = new Array<boolean>(pieces.length).fill(false);
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain = pieces[i].slice();
    const isClosed = (): boolean =>
      chain[0] === chain[chain.length - 2] && chain[1] === chain[chain.length - 1];
    let extended = true;
    while (!isClosed() && extended) {
      extended = false;
      const endX = chain[chain.length - 2];
      const endY = chain[chain.length - 1];
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        const piece = pieces[j];
        const startsHere = piece[0] === endX && piece[1] === endY;
        const endsHere = piece[piece.length - 2] === endX && piece[piece.length - 1] === endY;
        if (!startsHere && !endsHere) continue;
        if (startsHere) {
          for (let k = 2; k < piece.length; k++) chain.push(piece[k]);
        } else {
          for (let k = piece.length - 4; k >= 0; k -= 2) chain.push(piece[k], piece[k + 1]);
        }
        used[j] = true;
        extended = true;
        break;
      }
    }
    if (isClosed() && chain.length >= 8) rings.push(chain);
  }
  return rings;
}

/** Zewnętrzne pierścienie multipolygonu (role outer/outline). */
export function relationOuterRings(element: OverpassElement): number[][] {
  return assembleRings(element, OUTER_ROLES);
}

/** Wewnętrzne pierścienie multipolygonu (rola inner) — dla budynków są to dziedzińce. */
export function relationInnerRings(element: OverpassElement): number[][] {
  return assembleRings(element, INNER_ROLES);
}

function ringContains(ring: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const yi = ring[i + 1];
    const yj = ring[j + 1];
    if (yi > y !== yj > y && x < ring[i] + ((ring[j] - ring[i]) * (y - yi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/**
 * Indeks pierścienia zewnętrznego, w którym leży dziedziniec, albo -1. Sprawdzamy środki boków dziedzińca:
 * wierzchołki bywają wspólne z obrysem, a punkt na krawędzi nie daje pewnego wyniku.
 */
function outerIndexOf(hole: number[], outers: number[][]): number {
  if (outers.length === 1) return 0;
  for (let i = 0; i + 3 < hole.length; i += 2) {
    const x = (hole[i] + hole[i + 2]) / 2;
    const y = (hole[i + 1] + hole[i + 3]) / 2;
    const index = outers.findIndex((outer) => ringContains(outer, x, y));
    if (index >= 0) return index;
  }
  return -1;
}

interface AreaRing {
  id: number;
  ring: number[];
  holes: number[][];
}

/** Pierścienie elementu-obszaru (z dziedzińcami) wraz ze stabilnymi identyfikatorami (relacje: ujemne, syntetyczne). */
function areaRings(element: OverpassElement): AreaRing[] {
  if (element.type === 'way') {
    const ring = element.geometry ? closeRing(projectLine(element.geometry)) : null;
    return ring ? [{ id: element.id, ring, holes: [] }] : [];
  }
  if (element.type !== 'relation') return [];

  const outers = relationOuterRings(element).slice(0, SYNTHETIC_ID_FACTOR);
  const areas = outers.map((ring, index) => ({
    id: -(element.id * SYNTHETIC_ID_FACTOR + index),
    ring,
    holes: [] as number[][],
  }));
  if (areas.length === 0) return areas;
  for (const hole of relationInnerRings(element)) {
    const index = outerIndexOf(hole, outers);
    if (index >= 0) areas[index].holes.push(hole);
  }
  return areas;
}

export function parseBuildings(element: OverpassElement): Building[] {
  const tags = element.tags ?? {};
  if (!isBuilding(tags)) return [];
  const heights = buildingHeights(tags);
  return areaRings(element).map(({ id, ring, holes }) => {
    const building: Building = { id, ring, ...heights };
    if (holes.length > 0) building.holes = holes;
    return building;
  });
}

export function parseCanopies(element: OverpassElement): CanopyArea[] {
  const tags = element.tags ?? {};
  if (!isCanopy(tags)) return [];
  const height = round2(clamp(parseMetres(tags.height) ?? DEFAULT_CANOPY_HEIGHT_M, 3, 45));
  return areaRings(element).map(({ id, ring }) => ({ id, ring, height }));
}

function treeDimensions(tags: Tags): { height: number; crownRadius: number } {
  const height = clamp(parseMetres(tags.height) ?? DEFAULT_TREE_HEIGHT_M, 2, 40);
  const crownDiameter = parseMetres(tags.diameter_crown);
  const crownRadius = clamp(
    crownDiameter !== null && crownDiameter > 0 ? crownDiameter / 2 : height * CROWN_RADIUS_PER_HEIGHT,
    1,
    12,
  );
  return { height: round2(height), crownRadius: round2(crownRadius) };
}

const TAXON_KEYS = ['genus', 'species', 'taxon', 'genus:la', 'species:la', 'genus:pl', 'species:pl', 'taxon:pl'];
const wordPattern = (names: string): RegExp => new RegExp(`(^|[^\\p{L}])(${names})([^\\p{L}]|$)`, 'iu');
/** Rodzaje zimozielone (łacina i polskie nazwy) — głównie iglaste, plus ostrokrzew i bukszpan. */
const EVERGREEN_TAXA = wordPattern(
  'picea|pinus|abies|thuja|taxus|juniperus|pseudotsuga|tsuga|chamaecyparis|cupressus|cedrus|platycladus|' +
    'sequoiadendron|ilex|buxus|świerk|sosna|jodła|żywotnik|tuja|cis|jałowiec|daglezja|cyprysik|cedr',
);
/** Iglaste, które zrzucają igły na zimę. */
const DECIDUOUS_CONIFERS = wordPattern('larix|metasequoia|taxodium|pseudolarix|modrzew|metasekwoja|cypryśnik');

/**
 * Czy drzewo zachowuje ulistnienie zimą: leaf_cycle=evergreen, leaf_type=needleleaved (poza modrzewiem itp.)
 * albo rodzaj/gatunek zimozielony. Jawne leaf_cycle=deciduous ma pierwszeństwo.
 */
export function isEvergreen(tags: Tags): boolean {
  const cycle = tags.leaf_cycle;
  if (cycle === 'deciduous' || cycle === 'semi_deciduous') return false;
  if (cycle === 'evergreen' || cycle === 'semi_evergreen') return true;
  const taxon = TAXON_KEYS.map((key) => tags[key] ?? '').join(' ');
  if (DECIDUOUS_CONIFERS.test(taxon)) return false;
  if (tags.leaf_type === 'needleleaved') return true;
  return EVERGREEN_TAXA.test(taxon);
}

/** Pojedyncze drzewo (node natural=tree) albo drzewa rozstawione co ~8 m wzdłuż szpaleru (way natural=tree_row). */
export function parseTrees(element: OverpassElement): Tree[] {
  const tags = element.tags ?? {};
  if (element.type === 'node' && tags.natural === 'tree') {
    if (element.lat === undefined || element.lon === undefined) return [];
    const [x, y] = toXY(element.lat, element.lon);
    const tree: Tree = { id: element.id, x: round2(x), y: round2(y), ...treeDimensions(tags) };
    if (isEvergreen(tags)) tree.evergreen = true;
    return [tree];
  }
  if (element.type !== 'way' || tags.natural !== 'tree_row' || !element.geometry) return [];

  const line = projectLine(element.geometry);
  if (line.length < 4) return [];
  const segmentLengths: number[] = [];
  let total = 0;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const length = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]);
    segmentLengths.push(length);
    total += length;
  }
  // Równe odstępy możliwie bliskie 8 m, z drzewem na obu końcach szpaleru.
  const gaps = clamp(Math.round(total / TREE_ROW_SPACING_M), 1, SYNTHETIC_ID_FACTOR - 1);
  const dimensions: Pick<Tree, 'height' | 'crownRadius' | 'evergreen'> = treeDimensions(tags);
  if (isEvergreen(tags)) dimensions.evergreen = true;
  const trees: Tree[] = [];
  let segment = 0;
  let segmentStart = 0;
  for (let i = 0; i <= gaps; i++) {
    const target = (total * i) / gaps;
    while (segment < segmentLengths.length - 1 && segmentStart + segmentLengths[segment] < target) {
      segmentStart += segmentLengths[segment];
      segment++;
    }
    const length = segmentLengths[segment];
    const t = length > 0 ? clamp((target - segmentStart) / length, 0, 1) : 0;
    const a = segment * 2;
    trees.push({
      id: -(element.id * SYNTHETIC_ID_FACTOR + i),
      x: round2(line[a] + (line[a + 2] - line[a]) * t),
      y: round2(line[a + 1] + (line[a + 3] - line[a + 1]) * t),
      ...dimensions,
    });
  }
  return trees;
}

// ───────────────────────── drogi piesze ─────────────────────────

export interface WayClass {
  kind: SegmentKind;
  covered: boolean;
  sidewalk: SidewalkTag;
  sideOffsetM: number;
  penalty: number;
  speedFactor: number;
}

interface RoadClass {
  /** Domyślna odległość osi jezdni od toru pieszego (m). */
  offset: number;
  /** Kara, gdy nie wiadomo, czy jest chodnik. */
  unknownPenalty: number;
  /** Kara przy sidewalk=no. */
  noSidewalkPenalty: number;
}

const ROAD_CLASSES: Record<string, RoadClass> = {
  primary: { offset: 8, unknownPenalty: 1.8, noSidewalkPenalty: 2.5 },
  secondary: { offset: 7, unknownPenalty: 1.8, noSidewalkPenalty: 2.5 },
  tertiary: { offset: 5.5, unknownPenalty: 1.4, noSidewalkPenalty: 2.5 },
  residential: { offset: 4, unknownPenalty: 1.1, noSidewalkPenalty: 1.1 },
  unclassified: { offset: 4, unknownPenalty: 1.1, noSidewalkPenalty: 1.1 },
  road: { offset: 4, unknownPenalty: 1.1, noSidewalkPenalty: 1.1 },
  service: { offset: 2.5, unknownPenalty: 1.1, noSidewalkPenalty: 1.1 },
};

/** Jezdnie, które pomijamy, gdy chodniki są zmapowane jako osobne drogi (footway=sidewalk). */
const SEPARATE_SIDEWALK_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);

const FOOT_ALLOWED = new Set(['yes', 'designated', 'permissive', 'official']);
const FOOT_FORBIDDEN = new Set(['no', 'private', 'use_sidepath', 'discouraged']);
const ACCESS_FORBIDDEN = new Set(['no', 'private']);

const STEPS_SPEED_FACTOR = 0.5;
const STEPS_PENALTY = 1.2;
/** Droga rowerowa bez informacji o ruchu pieszym: dozwolona, ale niechętnie (zwykle obok biegnie chodnik). */
const CYCLEWAY_UNKNOWN_FOOT_PENALTY = 1.5;
const DRIVEWAY_PENALTY = 1.25;
const LANE_WIDTH_M = 3.2;
/** Odstęp krawędzi jezdni od środka chodnika/pobocza. */
const KERB_TO_WALKER_M = 1;

type SideState = 'yes' | 'no' | 'separate' | undefined;

function sideState(value: string | undefined): SideState {
  if (value === undefined) return undefined;
  if (value === 'separate') return 'separate';
  if (value === 'no' || value === 'none') return 'no';
  return 'yes';
}

function sidewalkSides(tags: Tags): { left: SideState; right: SideState } {
  let left: SideState;
  let right: SideState;
  switch (tags.sidewalk) {
    case 'both':
    case 'yes':
      left = right = 'yes';
      break;
    case 'left':
      left = 'yes';
      right = 'no';
      break;
    case 'right':
      left = 'no';
      right = 'yes';
      break;
    case 'no':
    case 'none':
      left = right = 'no';
      break;
    case 'separate':
      left = right = 'separate';
      break;
  }
  const both = sideState(tags['sidewalk:both']);
  if (both) left = right = both;
  left = sideState(tags['sidewalk:left']) ?? left;
  right = sideState(tags['sidewalk:right']) ?? right;
  return { left, right };
}

function sidewalkTag(left: SideState, right: SideState): SidewalkTag {
  if (left === 'yes' && right === 'yes') return 'both';
  if (left === 'yes') return 'left';
  if (right === 'yes') return 'right';
  if (left === 'separate' || right === 'separate') return 'separate';
  if (left === 'no' && right === 'no') return 'no';
  return 'unknown';
}

function roadSideOffset(tags: Tags, road: RoadClass): number {
  const width = parseMetres(tags.width);
  if (width !== null && width > 0) return clamp(width / 2 + KERB_TO_WALKER_M, 2, 15);
  const lanes = parseCount(tags.lanes);
  if (lanes !== null && lanes > 0) return clamp((lanes * LANE_WIDTH_M) / 2 + KERB_TO_WALKER_M, 2, 15);
  return road.offset;
}

function isCovered(tags: Tags): boolean {
  return (
    tags.tunnel === 'yes' ||
    tags.tunnel === 'building_passage' ||
    tags.covered === 'yes' ||
    tags.covered === 'arcade' ||
    tags.covered === 'colonnade' ||
    tags.indoor === 'yes'
  );
}

/**
 * Decyduje, czy po drodze wolno iść pieszo i jak ją traktować w routingu. Zwraca null dla dróg wykluczonych.
 * Lista klas jest zamknięta (biała lista): nieznane wartości highway=* są pomijane.
 */
export function classifyWay(tags: Tags): WayClass | null {
  const highway = tags.highway;
  if (!highway) return null;

  // Jawny tag foot=* ma pierwszeństwo przed ogólnym access=*.
  const foot = tags.foot;
  const footAllowed = foot !== undefined && FOOT_ALLOWED.has(foot);
  if (foot !== undefined && FOOT_FORBIDDEN.has(foot)) return null;
  if (!footAllowed && tags.access !== undefined && ACCESS_FORBIDDEN.has(tags.access)) return null;

  const { left, right } = sidewalkSides(tags);
  let kind: SegmentKind;
  let sideOffsetM = 0;
  let penalty = 1;
  let speedFactor = 1;
  const sidewalk = sidewalkTag(left, right);

  const roadClass = highway.endsWith('_link') ? highway.slice(0, -'_link'.length) : highway;
  const road = ROAD_CLASSES[roadClass];

  if (highway === 'footway') {
    kind = tags.footway === 'sidewalk' ? 'sidewalk' : tags.footway === 'crossing' ? 'crossing' : 'footway';
  } else if (highway === 'steps') {
    kind = 'steps';
    speedFactor = STEPS_SPEED_FACTOR;
    penalty = STEPS_PENALTY;
  } else if (highway === 'pedestrian') {
    kind = 'pedestrian';
  } else if (highway === 'path' || highway === 'track' || highway === 'bridleway') {
    kind = tags.path === 'crossing' ? 'crossing' : 'path';
  } else if (highway === 'cycleway') {
    kind = 'cycleway';
    // segregated=yes/no oznacza drogę pieszo-rowerową (ruch pieszy dopuszczony).
    const pedestriansExpected = footAllowed || tags.segregated === 'yes' || tags.segregated === 'no';
    if (!pedestriansExpected) penalty = CYCLEWAY_UNKNOWN_FOOT_PENALTY;
  } else if (highway === 'living_street') {
    kind = 'street';
  } else if (road) {
    // Chodniki zmapowane osobno po każdej stronie, po której w ogóle istnieją → pieszych niosą tamte drogi.
    const hasSeparate = left === 'separate' || right === 'separate';
    const sideUsable = (s: SideState): boolean => s === 'yes' || s === undefined;
    if (SEPARATE_SIDEWALK_CLASSES.has(roadClass) && hasSeparate && !sideUsable(left) && !sideUsable(right)) {
      return null;
    }
    kind = 'street';
    sideOffsetM = roadSideOffset(tags, road);
    if (sidewalk === 'both' || sidewalk === 'left' || sidewalk === 'right') penalty = 1;
    else if (sidewalk === 'no') penalty = road.noSidewalkPenalty;
    else penalty = road.unknownPenalty;
    if (tags.service === 'driveway' || tags.service === 'parking_aisle') penalty = Math.max(penalty, DRIVEWAY_PENALTY);
  } else {
    return null;
  }

  const covered = isCovered(tags);
  if (covered) {
    kind = 'covered';
    sideOffsetM = 0;
  }
  return { kind, covered, sidewalk, sideOffsetM: round2(sideOffsetM), penalty, speedFactor };
}

const SIGNAL_CROSSING_VALUES = new Set(['traffic_signals', 'pelican', 'toucan', 'puffin', 'pegasus']);

/**
 * Sygnalizacja z tagów crossing=* / crossing:signals=*: true / false, gdy tagi mówią to wprost
 * (crossing:signals ma pierwszeństwo), undefined, gdy nic nie mówią.
 */
function crossingSignals(tags: Tags): boolean | undefined {
  const explicit = tags['crossing:signals'];
  if (explicit === 'yes') return true;
  if (explicit === 'no') return false;
  const values = (tags.crossing ?? '').split(';').map((v) => v.trim().toLowerCase());
  if (values.some((v) => SIGNAL_CROSSING_VALUES.has(v))) return true;
  return undefined;
}

/**
 * Węzeł przejścia z sygnalizacją: crossing=traffic_signals, crossing:signals=yes albo highway=traffic_signals
 * (o ile nie crossing=no / crossing:signals=no). Przejście (droga footway=crossing) przechodzące przez taki
 * węzeł jest przejściem ze światłami.
 */
export function isSignalNode(tags: Tags): boolean {
  const fromCrossing = crossingSignals(tags);
  if (fromCrossing !== undefined) return fromCrossing;
  return tags.highway === 'traffic_signals' && tags.crossing !== 'no';
}

/** Nominalne nachylenie dla opisowego incline=steep (wartość umowna: wyraźnie powyżej progu 6% dla wózków). */
const STEEP_INCLINE_PCT = 12;

/**
 * Nachylenie w % (wartość bezwzględna) z incline=*: "5%", "-8 %", "10°", liczba bez jednostki (= %),
 * "steep" → wartość umowna, "flat" → 0. Dla "up"/"down" (kierunek bez wielkości) i wartości nieczytelnych: undefined.
 */
export function parseInclinePct(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase().replace(',', '.');
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(%|°|deg)?$/.exec(value);
  if (match) {
    const magnitude = Math.abs(Number(match[1]));
    if (match[2] === '°' || match[2] === 'deg') {
      if (magnitude >= 90) return undefined;
      return round1(Math.min(100, Math.tan((magnitude * Math.PI) / 180) * 100));
    }
    return round1(Math.min(100, magnitude));
  }
  if (value === 'steep') return STEEP_INCLINE_PCT;
  if (value === 'flat' || value === 'level') return 0;
  return undefined;
}

/** Pierwsza wartość tagu (przed ";"), małymi literami, bez białych znaków; undefined dla pustej. */
function cleanValue(raw: string | undefined): string | undefined {
  const value = raw?.split(';')[0].trim().toLowerCase().slice(0, 40);
  return value ? value : undefined;
}

/**
 * Tag opisujący miejsce, którym idzie pieszy. Dla jezdni (kind='street') pierwszeństwo mają warianty
 * sidewalk:*:<klucz> — surface=asphalt jezdni nie mówi nic o chodniku; gdy ich brak, zostaje tag jezdni.
 */
function walkerTag(tags: Tags, key: string, kind: SegmentKind): string | undefined {
  if (kind === 'street') {
    for (const prefix of ['sidewalk', 'sidewalk:both', 'sidewalk:left', 'sidewalk:right', 'footway']) {
      const value = cleanValue(tags[`${prefix}:${key}`]);
      if (value) return value;
    }
  }
  return cleanValue(tags[key]);
}

type WayAttributes = Pick<WalkWay, 'surface' | 'smoothness' | 'wheelchair' | 'inclinePct' | 'ramp' | 'lit'>;

/** Cechy drogi istotne dla profili poruszania się (v2); pola nieznane są pomijane. */
export function wayAttributes(tags: Tags, kind: SegmentKind): WayAttributes {
  const out: WayAttributes = {};
  const surface = walkerTag(tags, 'surface', kind);
  if (surface) out.surface = surface;
  const smoothness = walkerTag(tags, 'smoothness', kind);
  if (smoothness) out.smoothness = smoothness;

  const wheelchair = cleanValue(tags.wheelchair);
  if (wheelchair === 'yes' || wheelchair === 'designated') out.wheelchair = 'yes';
  else if (wheelchair === 'limited' || wheelchair === 'no') out.wheelchair = wheelchair;

  const inclinePct = parseInclinePct(tags.incline);
  if (inclinePct !== undefined) out.inclinePct = inclinePct;

  if (tags.highway === 'steps') {
    const yes = (key: string): boolean => tags[key] === 'yes' || tags[key] === 'separate';
    if (yes('ramp') || yes('ramp:wheelchair') || yes('ramp:stroller')) out.ramp = true;
  }

  const lit = cleanValue(tags.lit);
  if (lit === 'no' || lit === 'disused') out.lit = false;
  else if (lit !== undefined) out.lit = true; // yes, 24/7, automatic, limited, sunset-sunrise…
  return out;
}

/**
 * Droga z "out body geom" → WalkWay; null gdy wykluczona lub zdegenerowana.
 * `signalNodeIds`: węzły przejść z sygnalizacją (isSignalNode) — przejście przez taki węzeł dostaje signals=true.
 */
export function parseWalkWay(element: OverpassElement, signalNodeIds?: ReadonlySet<number>): WalkWay | null {
  if (element.type !== 'way' || !element.nodes || !element.geometry) return null;
  if (element.nodes.length !== element.geometry.length) return null;
  const tags = element.tags ?? {};
  const cls = classifyWay(tags);
  if (!cls) return null;

  const nodeIds: number[] = [];
  const coords: number[] = [];
  for (let i = 0; i < element.nodes.length; i++) {
    const p = element.geometry[i];
    if (!p) return null;
    const [x, y] = toXY(p.lat, p.lon);
    nodeIds.push(element.nodes[i]);
    coords.push(round2(x), round2(y));
  }
  if (nodeIds.length < 2) return null;

  const way: WalkWay = { id: element.id, nodeIds, coords, highway: tags.highway, ...cls };
  if (tags.name) way.name = tags.name;
  Object.assign(way, wayAttributes(tags, cls.kind));
  // Jawne crossing:signals=no na drodze wygrywa z tagami węzła; poza tym wystarczy jedno źródło.
  if (cls.kind === 'crossing' && tags['crossing:signals'] !== 'no') {
    const throughSignalNode = signalNodeIds !== undefined && nodeIds.some((id) => signalNodeIds.has(id));
    if (crossingSignals(tags) === true || throughSignalNode) way.signals = true;
  }
  return way;
}

// ───────────────────────── krawężniki ─────────────────────────

/** Krawężnik uznajemy za nieprzejezdny dla wózka powyżej 3 cm. */
const RAISED_KERB_MIN_M = 0.03;

/** Wysokość krawężnika w metrach: "0.05", "0,05 m", "5 cm", "50 mm" (bez jednostki = metry). */
export function parseKerbHeightM(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(m|cm|mm)?$/.exec(raw.trim().toLowerCase().replace(',', '.'));
  if (!match) return null;
  const value = Number(match[1]);
  return match[2] === 'cm' ? value / 100 : match[2] === 'mm' ? value / 1000 : value;
}

/** Węzeł z wysokim krawężnikiem: zmierzona wysokość (kerb:height) > 3 cm, a gdy jej brak — kerb=raised. */
export function isRaisedKerb(tags: Tags): boolean {
  const height = parseKerbHeightM(tags['kerb:height']);
  if (height !== null) return height > RAISED_KERB_MIN_M;
  return tags.kerb === 'raised';
}

// ───────────────────────── punkty chłodu ─────────────────────────

/** Parki i ogrody bez nazwy trafiają na listę dopiero od tej powierzchni. */
const MIN_UNNAMED_PARK_AREA_M2 = 2000;
const MIST_NAME = /kurtyn\p{L}* wodn|zamgławiacz|mgiełk/iu;
const DRINKING_FOUNTAIN_TYPES = new Set(['drinking', 'bubbler', 'bottle_refill']);
const MAX_NAME_LENGTH = 80;

/** Rodzaj punktu chłodu z tagów albo null. `areal`: element jest drogą/relacją (parki liczą się tylko jako obszary). */
export function coolSpotKind(tags: Tags, areal: boolean): CoolSpotKind | null {
  if (tags.access === 'private' || tags.access === 'no') return null;
  const amenity = tags.amenity;
  const manMade = tags.man_made;

  const waterFeature =
    amenity === 'fountain' ||
    amenity === 'drinking_water' ||
    amenity === 'water_point' ||
    manMade === 'water_tap' ||
    manMade === 'drinking_fountain';
  if (amenity === 'fountain' && (tags.fountain === 'mist' || tags.fountain === 'misting')) return 'water_mist';
  // Kurtyny wodne bywają mapowane jako fontanna albo sam nazwany węzeł — rozpoznajemy je po nazwie.
  const namedMist = MIST_NAME.test(`${tags.name ?? ''} ${tags.description ?? ''}`);
  if (namedMist && (waterFeature || (!areal && tags.highway === undefined))) return 'water_mist';

  if (amenity === 'drinking_water' || amenity === 'water_point' || manMade === 'drinking_fountain') return 'drinking_water';
  if (manMade === 'water_tap') return tags.drinking_water === 'no' ? null : 'drinking_water';
  if (amenity === 'fountain') {
    const drinkable = tags.drinking_water === 'yes' || DRINKING_FOUNTAIN_TYPES.has(tags.fountain ?? '');
    return drinkable ? 'drinking_water' : 'fountain';
  }
  if (amenity === 'bench') return 'bench';
  if (amenity === 'shelter') return 'shelter';
  if (areal && (tags.leisure === 'park' || tags.leisure === 'garden')) {
    const privateGarden = tags['garden:type'] === 'residential' || tags['garden:type'] === 'private';
    return privateGarden && !tags.name ? null : 'park';
  }
  return null;
}

function ringArea(ring: number[]): number {
  let twice = 0;
  for (let i = 0; i + 3 < ring.length; i += 2) twice += ring[i] * ring[i + 3] - ring[i + 2] * ring[i + 1];
  return Math.abs(twice) / 2;
}

function lineMean(line: number[]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < line.length; i += 2) {
    sx += line[i];
    sy += line[i + 1];
  }
  const n = Math.max(1, line.length / 2);
  return [sx / n, sy / n];
}

function ringCentroid(ring: number[]): [number, number] {
  // Liczone względem pierwszego wierzchołka — współrzędne rzędu kilometrów psułyby dokładność iloczynów.
  const ox = ring[0];
  const oy = ring[1];
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const ax = ring[i] - ox;
    const ay = ring[i + 1] - oy;
    const bx = ring[i + 2] - ox;
    const by = ring[i + 3] - oy;
    const cross = ax * by - bx * ay;
    twice += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (Math.abs(twice) < 1e-6) return lineMean(ring);
  return [ox + cx / (3 * twice), oy + cy / (3 * twice)];
}

/**
 * Punkt reprezentujący obszar: środek ciężkości, a gdy wypada poza obszarem (kształt wklęsły, pierścień z dziurą —
 * np. Planty) — środek najszerszego odcinka wnętrza na poziomej linii przez środek ciężkości.
 */
function interiorPoint(area: AreaRing): [number, number] {
  const [cx, cy] = ringCentroid(area.ring);
  const inside = (x: number, y: number): boolean =>
    ringContains(area.ring, x, y) && !area.holes.some((hole) => ringContains(hole, x, y));
  if (inside(cx, cy)) return [cx, cy];

  const xs: number[] = [];
  for (const ring of [area.ring, ...area.holes]) {
    for (let i = 0; i + 3 < ring.length; i += 2) {
      const y0 = ring[i + 1];
      const y1 = ring[i + 3];
      if (y0 > cy !== y1 > cy) xs.push(ring[i] + ((ring[i + 2] - ring[i]) * (cy - y0)) / (y1 - y0));
    }
  }
  xs.sort((a, b) => a - b);
  let best: [number, number] | null = null;
  let bestWidth = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const width = xs[i + 1] - xs[i];
    if (width > bestWidth) {
      bestWidth = width;
      best = [(xs[i] + xs[i + 1]) / 2, cy];
    }
  }
  return best ?? [area.ring[0], area.ring[1]];
}

/** Punkt chłodu z elementu OSM (węzeł → jego położenie; droga/relacja → punkt wewnątrz obszaru) albo null. */
export function parseCoolSpot(element: OverpassElement): CoolSpotXY | null {
  const tags = element.tags;
  if (!tags) return null;
  const kind = coolSpotKind(tags, element.type !== 'node');
  if (!kind) return null;

  let point: [number, number];
  if (element.type === 'node') {
    if (element.lat === undefined || element.lon === undefined) return null;
    point = toXY(element.lat, element.lon);
  } else {
    const areas = areaRings(element);
    if (areas.length > 0) {
      const sizes = areas.map((a) => ringArea(a.ring) - a.holes.reduce((sum, hole) => sum + ringArea(hole), 0));
      const total = sizes.reduce((sum, v) => sum + v, 0);
      if (kind === 'park' && !tags.name && total < MIN_UNNAMED_PARK_AREA_M2) return null;
      point = interiorPoint(areas[sizes.indexOf(Math.max(...sizes))]);
    } else {
      // Obiekt liniowy (np. ławka narysowana jako odcinek) — średnia punktów; park bez obrysu pomijamy.
      const line = element.type === 'way' && element.geometry ? projectLine(element.geometry) : [];
      if (line.length < 2 || kind === 'park') return null;
      point = lineMean(line);
    }
  }

  const spot: CoolSpotXY = { id: `${element.type[0]}${element.id}`, kind, x: round1(point[0]), y: round1(point[1]) };
  const name = tags.name?.trim();
  if (name) spot.name = name.slice(0, MAX_NAME_LENGTH);
  return spot;
}

/**
 * Węzeł drogi z barierą (brama, furtka…), przez którą pieszy nie przejdzie: zakaz dla pieszych (foot albo —
 * gdy brak jawnego foot — access = private|no) lub zamknięcie na klucz. Tak jak dla dróg, foot=* ma
 * pierwszeństwo przed access=*. Bariery bez takich tagów uznajemy za przechodnie.
 */
export function isBlockedNode(tags: Tags): boolean {
  if (tags.barrier === undefined || tags.barrier === 'no') return false;
  const foot = tags.foot;
  if (foot !== undefined && FOOT_ALLOWED.has(foot)) return false;
  if (foot === 'no' || foot === 'private') return true;
  if (tags.access !== undefined) return ACCESS_FORBIDDEN.has(tags.access);
  return tags.locked === 'yes';
}

/** Parsuje pełną odpowiedź Overpass dla kafla; każda kategoria jest deduplikowana po id. */
export function parseOverpass(elements: OverpassElement[]): ParsedTile {
  const buildings = new Map<number, Building>();
  const trees = new Map<number, Tree>();
  const canopies = new Map<number, CanopyArea>();
  const ways = new Map<number, WalkWay>();
  const blockedNodeIds = new Set<number>();
  const coolSpots = new Map<string, CoolSpotXY>();
  const signalNodeIds = new Set<number>();
  const raisedKerbs = new Set<number>();

  // Węzły przychodzą w odpowiedzi po drogach, a drogi potrzebują wiedzy o sygnalizacji w węzłach — stąd osobny przebieg.
  for (const element of elements) {
    if (element.type !== 'node' || !element.tags) continue;
    if (isBlockedNode(element.tags)) blockedNodeIds.add(element.id);
    if (isSignalNode(element.tags)) signalNodeIds.add(element.id);
    if (isRaisedKerb(element.tags)) raisedKerbs.add(element.id);
  }

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    const spot = parseCoolSpot(element);
    if (spot) coolSpots.set(spot.id, spot);
    for (const b of parseBuildings(element)) buildings.set(b.id, b);
    for (const c of parseCanopies(element)) canopies.set(c.id, c);
    for (const t of parseTrees(element)) trees.set(t.id, t);
    if (tags.highway) {
      const way = parseWalkWay(element, signalNodeIds);
      if (way) ways.set(way.id, way);
    }
  }

  // Krawężnik liczy się tylko tam, gdzie faktycznie przechodzi droga piesza.
  const raisedKerbNodeIds: number[] = [];
  if (raisedKerbs.size > 0) {
    const walkNodes = new Set<number>();
    for (const way of ways.values()) for (const id of way.nodeIds) walkNodes.add(id);
    for (const id of raisedKerbs) if (walkNodes.has(id)) raisedKerbNodeIds.push(id);
  }
  return {
    buildings: [...buildings.values()],
    trees: [...trees.values()],
    canopies: [...canopies.values()],
    ways: [...ways.values()],
    blockedNodeIds: [...blockedNodeIds],
    coolSpots: [...coolSpots.values()],
    raisedKerbNodeIds,
  };
}
