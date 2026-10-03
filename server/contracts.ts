// Kontrakty między modułami serwera. Każdy moduł implementuje DOKŁADNIE te sygnatury
// (nazwy plików i eksportów podane w komentarzach), żeby moduły pisane niezależnie do siebie pasowały.
//
// Układ współrzędnych wewnętrznych: lokalne metry (x na wschód, y na północ) względem KRAKOW_CENTER,
// rzut równoodległościowy — patrz server/geo/project.ts. Geometrie jako płaskie tablice [x0,y0,x1,y1,...].

import type {
  LatLon,
  RouteProfile,
  RouteResult,
  SegmentKind,
  SunInfo,
  WeatherInfo,
  HeatMeta,
} from '../shared/types.ts';

// ───────────────────────── geo/project.ts ─────────────────────────
// export function toXY(lat: number, lon: number): [number, number]
// export function toLatLon(x: number, y: number): [number, number]   // [lat, lon]
// export function toLonLat(x: number, y: number): [number, number]   // [lon, lat]

// ───────────────────────── geo/sun.ts ─────────────────────────────
export interface SunPosition {
  /** Azymut w radianach: 0 = północ, π/2 = wschód (zgodnie z ruchem wskazówek zegara). */
  azimuth: number;
  /** Wysokość nad horyzontem w radianach. */
  altitude: number;
}
// export function sunPosition(date: Date, lat: number, lon: number): SunPosition
// export function sunTimes(date: Date, lat: number, lon: number): { sunrise: Date | null; sunset: Date | null }
// export function sunInfo(date: Date, lat?: number, lon?: number): SunInfo   // domyślnie centrum Krakowa

// ───────────────────────── dane OSM: osm/* ────────────────────────
export interface Building {
  id: number;
  /** Zewnętrzny pierścień, zamknięty (pierwszy punkt == ostatni), płaskie [x,y,...] w metrach. */
  ring: number[];
  /** Wysokość dachu nad terenem w metrach (height / building:levels*3+… / domyślna). */
  height: number;
  /** Wysokość dolnej krawędzi (min_height) — np. przejścia bramowe; zwykle 0. */
  minHeight: number;
  /** Dziedzińce: zamknięte pierścienie wewnętrzne (role=inner multipolygonu) — teren pod gołym niebem. */
  holes?: number[][];
}

export interface Tree {
  id: number;
  x: number;
  y: number;
  /** Wysokość całkowita drzewa (m). */
  height: number;
  /** Promień korony (m). */
  crownRadius: number;
}

/** Zwarty drzewostan (las, zadrzewienie) — punkt wewnątrz jest pod koronami; rzuca też cień na zewnątrz. */
export interface CanopyArea {
  id: number;
  ring: number[]; // zamknięty pierścień, metry
  height: number;
}

export type SidewalkTag = 'both' | 'left' | 'right' | 'no' | 'separate' | 'unknown';

export interface WalkWay {
  id: number;
  /** Identyfikatory węzłów OSM (do łączenia dróg w graf), tej samej długości co liczba punktów. */
  nodeIds: number[];
  /** Płaskie [x,y,...] w metrach. */
  coords: number[];
  kind: SegmentKind;
  /** Oryginalna wartość highway=*. */
  highway: string;
  name?: string;
  /** Tunel / covered=yes / arkady / przejście przez budynek — pełny cień. */
  covered: boolean;
  sidewalk: SidewalkTag;
  /**
   * Dla kind='street': odległość (m) od osi jezdni do miejsca, gdzie idzie pieszy po lewej/prawej stronie.
   * 0 dla dróg, które same są przestrzenią pieszą.
   */
  sideOffsetM: number;
  /** Mnożnik kosztu niezależny od słońca (>= 1): schody, ruchliwa ulica bez chodnika itd. */
  penalty: number;
  /** Mnożnik prędkości (schody wolniej): czas = długość / (walkSpeed * speedFactor). */
  speedFactor: number;
}

export interface AreaData {
  /** Klucz identyfikujący zestaw kafli (do cache'owania pochodnych struktur). */
  key: string;
  /** bbox obszaru w metrach lokalnych [minX, minY, maxX, maxY]. */
  bboxXY: [number, number, number, number];
  buildings: Building[];
  trees: Tree[];
  canopies: CanopyArea[];
  ways: WalkWay[];
  /** Węzły OSM zamknięte dla pieszych (bramy/furtki z access|foot = private|no) — graf nie łączy przez nie dróg. */
  blockedNodeIds: number[];
}

export interface BBoxLatLon {
  west: number;
  south: number;
  east: number;
  north: number;
}

// osm/store.ts
// export async function loadArea(bbox: BBoxLatLon, opts?: { cachedOnly?: boolean }): Promise<AreaData>
//   - dzieli bbox na kafle, brakujące pobiera z Overpass (z fallbackiem na mirrory + retry) i zapisuje w data/osm/,
//   - deduplikuje obiekty po id, zwraca połączone dane. Rzuca DataUnavailableError gdy nie da się pobrać.
//   - cachedOnly: użyj wyłącznie kafli z dysku/pamięci (brakujące pomiń) — dla warstwy cieni.
// export class DataUnavailableError extends Error {}

// ───────────────────────── shade/scene.ts ─────────────────────────
export interface ShadowPolygon {
  kind: 'building' | 'tree';
  /** Pierścienie [lon,lat] — polygon GeoJSON (pierwszy = zewnętrzny). */
  rings: [number, number][][];
}

export interface IShadeScene {
  /**
   * Ekspozycja punktu na bezpośrednie słońce: 0 = pełny cień, 1 = pełne słońce.
   * Wartości pośrednie dla cienia drzew (korona przepuszcza część światła).
   * Gdy sun.altitude <= 0 zwraca 0.
   */
  exposureAt(x: number, y: number, sun: SunPosition): number;
  /** Średnia ekspozycja wzdłuż polilinii (próbkowanie co ~stepM metrów, domyślnie 6 m). */
  polylineExposure(coords: number[], sun: SunPosition, stepM?: number): number;
  /** Czy punkt leży w obrysie budynku stojącego na gruncie (dziedzińce i bryły z min_height > 0 się nie liczą). */
  insideBuilding(x: number, y: number): boolean;
  /**
   * Wielokąty cieni do wizualizacji: cienie rzucane przez obiekty, których środek leży w oknie
   * [minX,maxX) × [minY,maxY) — sąsiadujące okna nie powtarzają więc tych samych cieni.
   */
  shadowPolygons(bboxXY: [number, number, number, number], sun: SunPosition): ShadowPolygon[];
}
// export class ShadeScene implements IShadeScene { constructor(area: Pick<AreaData, 'buildings' | 'trees' | 'canopies'>) }

// ───────────────────────── graph/build.ts ─────────────────────────
export interface GraphEdge {
  id: number;
  from: number; // indeks węzła
  to: number;
  /** Geometria osi od `from` do `to`, płaskie [x,y,...]. */
  coords: number[];
  lengthM: number;
  way: WalkWay;
}

export interface Graph {
  nodeCount: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  /** Krawędzie nieskierowane; każda występuje raz. */
  edges: GraphEdge[];
  /** Dla węzła n: indeksy krawędzi incydentnych. */
  adjacency: number[][];
}
// export function buildGraph(ways: WalkWay[], blockedNodeIds?: Iterable<number>): Graph
//   - w węźle zablokowanym (zamknięta brama) każda droga kończy się własnym węzłem grafu — nie ma przez niego przejścia,
//   - węzły grafu = węzły OSM współdzielone przez >1 drogę + końce dróg; drogi cięte na krawędzie w tych węzłach,
//   - usuwa wyspy: zostawia tylko największą (wg łącznej długości) spójną składową.

// ───────────────────────── heat/lst.ts ────────────────────────────
export interface IHeatField {
  available: boolean;
  /** LST w °C w punkcie albo null poza siatką / brak danych. */
  sampleC(lat: number, lon: number): number | null;
  /** Znormalizowany "upał" 0..1 (percentyle 5–95 siatki); 0 gdy brak danych. */
  normalized(lat: number, lon: number): number;
  meta(): HeatMeta;
  /** PNG nakładki (RGBA) albo null. */
  overlayPng(): Buffer | null;
}
// export function getHeatField(): IHeatField        // singleton, leniwie ładuje data/lst/krakow_lst.{json,bin}

// ───────────────────────── weather/openmeteo.ts ───────────────────
// export async function getWeather(time: Date): Promise<WeatherInfo>     // nigdy nie rzuca; source:'unavailable' przy błędzie
// export function sunFactorFrom(sun: SunInfo, weather: WeatherInfo | null): number   // 0..1

// ───────────────────────── graph/route.ts ─────────────────────────
export interface RoutingContext {
  area: AreaData;
  graph: Graph;
  scene: IShadeScene;
  /** Cache ekspozycji krawędzi: klucz = `${bucketCzasu}:${edgeId}:${strona}` → wartość 0..1. */
  exposureCache: Map<string, number>;
}

export interface RouteOptions {
  from: LatLon;
  to: LatLon;
  departure: Date;
  /** 0..1 */
  shadePreference: number;
  walkSpeed: number;
  /** 0..1 — skala wagi słońca (pogoda, noc). */
  sunFactor: number;
  heat: IHeatField;
}
// export function computeRoutes(ctx: RoutingContext, opts: RouteOptions): RouteResult[]
//   - zwraca do 3 tras (shortest / balanced / shadiest), bez duplikatów geometrii,
//   - rzuca NoRouteError gdy brak połączenia.
// export class NoRouteError extends Error {}

// graph/context.ts
// export async function getRoutingContext(from: LatLon, to: LatLon): Promise<RoutingContext>
//   - liczy bbox z buforem, woła loadArea, buduje ShadeScene + Graph, trzyma mały LRU po area.key.

export type { LatLon, RouteProfile, RouteResult, SegmentKind, SunInfo, WeatherInfo, HeatMeta };

// ═════════════════════════════════════════════════════════════════════════════
// Rozszerzenia v2 — kontrakty między modułami (patrz też shared/types.ts, sekcja v2).
// Poniższe interfejsy rozszerzają wcześniejsze przez scalanie deklaracji.
// ═════════════════════════════════════════════════════════════════════════════

import type {
  CoolSpot,
  CoolSpotKind,
  DepartureRequest,
  DepartureResponse,
  MobilityProfile,
  RouteRequest,
  RouteResponse,
} from '../shared/types.ts';

/** Raster w lokalnych metrach; wiersz 0 = najbardziej południowy; data[row * cols + col]; NaN = brak danych. */
export interface HeightRaster {
  /** Lewy dolny (SW) narożnik komórki (0,0). */
  x0: number;
  y0: number;
  cellM: number;
  cols: number;
  rows: number;
  data: Float32Array;
}

/** Dane z lotniczego skaningu laserowego (GUGiK: NMT + NMPT, 1 m) przetworzone dla obszaru. */
export interface LidarData {
  /**
   * Wysokość szczytu roślinności nad terenem (m) w komórkach ~2 m; 0 = brak roślinności / budynek / niski obiekt.
   * Obejmuje także drzewa niezmapowane w OSM. Gdy obecny, ZASTĘPUJE model drzew z OSM (trees/canopies) w cieniowaniu.
   */
  vegetation: HeightRaster | null;
  /** Rzędna terenu (m n.p.m.) w komórkach ~10 m — do cienia rzucanego przez rzeźbę terenu i różnic wysokości. */
  terrain: HeightRaster | null;
  /** Udział obszaru pokryty danymi 0..1. */
  coverage: number;
}

export interface Building {
  /** Skąd pochodzi `height`. */
  heightSource?: 'lidar' | 'osm' | 'default';
}

export interface Tree {
  /** leaf_type / leaf_cycle z OSM; iglaste nie tracą liści zimą. */
  evergreen?: boolean;
}

export interface SunPosition {
  /**
   * Sezon bezlistny: korony drzew liściastych przepuszczają większość światła (transmisyjność ~0.7 zamiast ~0.25).
   * Ustawiane przez wołającego na podstawie daty (isLeafOff w geo/sun.ts); brak = sezon wegetacyjny.
   */
  leafOff?: boolean;
}
// geo/sun.ts (v2): export function isLeafOff(date: Date): boolean   // ok. 1 XI – 10 IV

export interface WalkWay {
  /** Przejście z sygnalizacją świetlną (crossing=traffic_signals / crossing:signals=yes / węzeł highway=traffic_signals). */
  signals?: boolean;
  /** surface=* z OSM. */
  surface?: string;
  /** smoothness=* z OSM. */
  smoothness?: string;
  /** wheelchair=* na drodze. */
  wheelchair?: 'yes' | 'limited' | 'no';
  /** Nachylenie w % (z incline=*), wartość bezwzględna; brak = nieznane. */
  inclinePct?: number;
  /** Schody z rampą/podjazdem (ramp=yes, ramp:wheelchair/stroller=yes). */
  ramp?: boolean;
  /** lit=yes. */
  lit?: boolean;
}

/** Punkt chłodu w metrach lokalnych. */
export interface CoolSpotXY {
  id: string;
  kind: CoolSpotKind;
  x: number;
  y: number;
  name?: string;
}

export interface AreaData {
  /** Punkty chłodu z OSM: amenity=drinking_water|fountain|bench|shelter, man_made=water_tap, parki (centroid). */
  coolSpots?: CoolSpotXY[];
  /** Dane LiDAR dołączone do obszaru (null/undefined = niedostępne → model z OSM). */
  lidar?: LidarData | null;
  /** Węzły OSM z krawężnikiem nieprzejezdnym dla wózka (kerb=raised) — id węzłów. */
  raisedKerbNodeIds?: number[];
}

// ───────────────────────── lidar/* (v2) ─────────────────────────
// lidar/store.ts
// export async function loadLidar(bbox: BBoxLatLon, opts?: { cachedOnly?: boolean }): Promise<LidarData | null>
//   - pobiera NMT i NMPT (GUGiK WCS, EPSG:2180, 1 m) kaflami, liczy nDSM = NMPT − NMT, przelicza do lokalnych metrów,
//     cache na dysku data/lidar/; nigdy nie rzuca — przy błędzie zwraca null (lub dane częściowe z coverage < 1).
// lidar/heights.ts
// export function applyLidarHeights(buildings: Building[], ndsm: HeightRaster): number
//   - ustawia building.height (np. 85. percentyl nDSM wewnątrz obrysu) i heightSource='lidar'; zwraca liczbę zmienionych.
// (loadLidar wewnętrznie potrzebuje obrysów budynków do odfiltrowania ich z rastra roślinności —
//   dlatego pełne API to: export async function attachLidar(area: AreaData, opts?: { cachedOnly?: boolean }): Promise<void>
//   które ustawia area.lidar i aktualizuje wysokości budynków w miejscu; idempotentne.)

// ───────────────────────── shade/scene.ts (v2) ─────────────────────────
// ShadeScene: constructor(area: Pick<AreaData, 'buildings' | 'trees' | 'canopies' | 'lidar'>)
//   - gdy area.lidar?.vegetation istnieje: roślinność z rastra (ray-marching z transmisyjnością zależną od sun.leafOff),
//     drzewa/zadrzewienia z OSM pomijane; gdy area.lidar?.terrain istnieje: uwzględnia rzędne terenu
//     (punkt i podstawa budynku na różnych wysokościach; teren też zasłania słońce).

// ───────────────────────── service.ts (v2) ─────────────────────────
// Logika endpointów wydzielona z index.ts, żeby mógł jej używać także asystent AI:
// export async function planRoute(req: RouteRequest): Promise<RouteResponse>
// export async function planDeparture(req: DepartureRequest): Promise<DepartureResponse>
// export async function coolSpotsIn(bbox: BBoxLatLon, opts?: { time?: Date; kinds?: CoolSpotKind[] }): Promise<CoolSpot[]>
// export class ServiceError extends Error { code: ApiError['code'] }   // komunikat po polsku
//
// ───────────────────────── ai/assistant.ts (v2) ─────────────────────────
// export function registerAssistantRoutes(app: FastifyInstance, deps?: AssistantDeps): void
//   - GET /api/assistant/status, POST /api/assistant (SSE); `deps` (env, klient API, zegar, limit zapytań) służy testom.
//
// ───────────────────────── uzgodnienia po integracji v2 ─────────────────────────
// graph/build.ts:  buildGraph(ways, blockedNodeIds?, raisedKerbNodeIds?) — trzeci parametr oznacza krawędzie z wysokim krawężnikiem.
// shade/cache.ts:  sceneForArea(area) — wspólna scena routingu i warstwy cieni, budowana od nowa po zmianie area.lidar;
//                  lidarTag(area) — znacznik stanu LiDAR do kluczy pamięci podręcznych (kontekst routingu, kafle cieni).
// lidar/store.ts:  attachLidar zmienia wysokości obiektów Building współdzielonych z pamięcią magazynu OSM;
//                  CIEN_LIDAR=off wyłącza LiDAR (area.lidar = null).
// service.ts:      dodatkowo toServiceError, resolveComfort, heightSourceOf.

// ───────────────────────── graph/route.ts (v2) ─────────────────────────
export interface RouteOptions {
  mobility?: MobilityProfile;
  /** Rozstrzygnięty tryb: 'shade' (unikaj słońca) lub 'sun' (szukaj słońca). Domyślnie 'shade'. */
  comfort?: 'shade' | 'sun';
  viaCoolSpot?: boolean;
  /** Pogoda dla chwili wyjścia — do ThermalInfo. */
  weather?: WeatherInfo | null;
}

export type { CoolSpot, CoolSpotKind, DepartureRequest, DepartureResponse, MobilityProfile, RouteRequest, RouteResponse };
