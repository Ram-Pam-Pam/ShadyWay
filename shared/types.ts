// Typy współdzielone przez serwer i frontend (kontrakt HTTP API).
// Współrzędne w API: zawsze WGS84; pary w geometrii to [lon, lat] (kolejność GeoJSON).

export interface LatLon {
  lat: number;
  lon: number;
}

export type LonLat = [number, number];

/** Obszar obsługiwany przez aplikację (Kraków z marginesem). */
export const KRAKOW_BBOX = { west: 19.78, south: 49.96, east: 20.22, north: 50.13 } as const;
export const KRAKOW_CENTER: LatLon = { lat: 50.0614, lon: 19.9372 };
export const TIMEZONE = 'Europe/Warsaw';
/** Największe okno (km²), dla którego /api/shadows zwraca cienie. */
export const MAX_SHADOW_AREA_KM2 = 4;

export type RouteProfile = 'shortest' | 'balanced' | 'shadiest';

export type SegmentKind =
  | 'sidewalk'
  | 'footway'
  | 'path'
  | 'pedestrian'
  | 'crossing'
  | 'steps'
  | 'street' // jezdnia/ulica bez osobno zmapowanego chodnika
  | 'cycleway'
  | 'covered'; // tunel, pasaż, arkady — pełny cień

export interface RouteRequest {
  from: LatLon;
  to: LatLon;
  /** Moment wyjścia, ISO 8601 z offsetem lub w UTC (np. 2026-07-15T13:00:00+02:00). */
  time: string;
  /** 0 = ignoruj słońce (najkrótsza), 1 = maksymalnie unikaj słońca. Steruje profilem "balanced". Domyślnie 0.5. */
  shadePreference?: number;
  /** Prędkość marszu w m/s (domyślnie 1.3). */
  walkSpeed?: number;
}

export interface RouteSegment {
  /** Geometria odcinka [lon, lat]; dla ulic bez chodnika przesunięta na zalecaną stronę. */
  coords: LonLat[];
  lengthM: number;
  /** Udział długości odcinka w słońcu, 0..1 (0 = pełny cień), w chwili przejścia. */
  sunFraction: number;
  /** Temperatura powierzchni (LST) w °C albo null, gdy brak danych. */
  lstC: number | null;
  kind: SegmentKind;
  name?: string;
  /** Zalecana strona ulicy względem kierunku marszu (tylko dla kind = 'street'). */
  side?: 'left' | 'right';
}

export interface RouteResult {
  profile: RouteProfile;
  /** Etykieta po polsku, np. "Najkrótsza". */
  label: string;
  distanceM: number;
  durationS: number;
  /** Metry przebyte w słońcu. */
  sunDistanceM: number;
  /** Udział trasy w cieniu, 0..1. */
  shadeFraction: number;
  /** Średnia LST wzdłuż trasy (°C) albo null. */
  meanLstC: number | null;
  /** Cała geometria trasy [lon, lat]. */
  geometry: LonLat[];
  segments: RouteSegment[];
}

export interface SunInfo {
  /** Azymut w stopniach, 0 = północ, zgodnie z ruchem wskazówek zegara (90 = wschód). */
  azimuthDeg: number;
  /** Wysokość nad horyzontem w stopniach (ujemna = noc). */
  altitudeDeg: number;
  sunrise: string | null; // ISO
  sunset: string | null; // ISO
  isDay: boolean;
}

export interface WeatherInfo {
  time: string; // ISO godziny, której dotyczą dane
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  cloudCoverPct: number | null;
  /** Bezpośrednie promieniowanie słoneczne W/m² (direct normal irradiance). */
  directRadiationWm2: number | null;
  uvIndex: number | null;
  source: 'open-meteo' | 'unavailable';
}

export interface RouteResponse {
  routes: RouteResult[];
  sun: SunInfo;
  weather: WeatherInfo | null;
  /** 0..1 — jak mocno słońce "liczy się" w tej chwili (0 w nocy / przy pełnym zachmurzeniu). */
  sunFactor: number;
  /** Komunikaty dla użytkownika po polsku (np. "Słońce jest pod horyzontem"). */
  warnings: string[];
}

export interface ApiError {
  error: string; // komunikat po polsku
  code: 'OUT_OF_AREA' | 'NO_ROUTE' | 'BAD_REQUEST' | 'DATA_UNAVAILABLE' | 'TOO_FAR' | 'INTERNAL';
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
}

export interface HeatMeta {
  available: boolean;
  /** Granice nakładki obrazu [west, south, east, north]. */
  bounds?: [number, number, number, number];
  minC?: number;
  maxC?: number;
  /** Opis źródła, np. "Landsat 9, 2025-07-02, LST (ST_B10)". */
  source?: string;
}

/**
 * Endpoints (wszystkie pod /api):
 *  POST /api/route            body: RouteRequest            -> RouteResponse | ApiError (4xx/5xx)
 *  GET  /api/shadows?bbox=w,s,e,n&time=ISO                  -> GeoJSON FeatureCollection<Polygon|MultiPolygon>
 *        (cienie budynków i drzew sięgające danego okna; properties: { kind: 'building' | 'tree' });
 *        dodatkowe pole kolekcji `missingData: boolean` — true, gdy dla części okna serwer nie ma jeszcze
 *        danych mapy (cienie są tam niekompletne; dane pobiera wyznaczenie trasy w tej okolicy);
 *        gdy bbox za duży (> MAX_SHADOW_AREA_KM2) -> 400 ApiError BAD_REQUEST
 *  GET  /api/sun?time=ISO                                   -> SunInfo
 *  GET  /api/weather?time=ISO                               -> WeatherInfo
 *  GET  /api/geocode?q=tekst                                -> GeocodeResult[]  ([] = brak trafień;
 *        awaria usług geokodowania -> 503 ApiError DATA_UNAVAILABLE)
 *  GET  /api/reverse?lat=..&lon=..                          -> GeocodeResult | null
 *  GET  /api/heat/meta                                      -> HeatMeta
 *  GET  /api/heat/overlay.png                               -> image/png (kolorowana mapa LST, przezroczyste tło)
 *  GET  /api/health                                         -> { ok: true }
 */

// ═════════════════════════════════════════════════════════════════════════════
// Rozszerzenia v2 (kontrakt): profile poruszania się, tryb zimowy, światła, komfort cieplny,
// punkty chłodu, najlepsza godzina wyjścia, nawigacja krok po kroku, asystent AI.
// Wszystkie nowe pola zapytań są opcjonalne — stare zapytania działają bez zmian.
// ═════════════════════════════════════════════════════════════════════════════

/** Profil poruszania się. */
export type MobilityProfile =
  | 'default'
  | 'accessible' // wózek / wózek dziecięcy: bez schodów, unikaj złej nawierzchni i wysokich krawężników
  | 'senior'; // wolniejszy marsz, unikaj schodów (dozwolone z dużą karą), preferuj ławki i łagodne trasy

/** 'shade' = unikaj słońca (lato); 'sun' = szukaj słońca (tryb zimowy); 'auto' = wg temperatury odczuwalnej. */
export type ComfortMode = 'shade' | 'sun' | 'auto';

export type CoolSpotKind = 'drinking_water' | 'fountain' | 'water_mist' | 'bench' | 'park' | 'shelter';

export interface CoolSpot {
  id: string;
  kind: CoolSpotKind;
  lat: number;
  lon: number;
  name?: string;
  /** Tylko gdy liczone dla konkretnej chwili: czy punkt jest w cieniu (ekspozycja < 0.5). */
  shaded?: boolean;
}

/** Rozszerzenie RouteRequest (pola dopisane przez scalanie deklaracji poniżej). */
export interface RouteRequest {
  mobility?: MobilityProfile;
  /** Domyślnie 'auto'. */
  comfort?: ComfortMode;
  /** Poprowadź trasę zacienioną/zbalansowaną przez punkt chłodu (woda pitna / fontanna), jeśli nadkłada mało. */
  viaCoolSpot?: boolean;
}

export type ManeuverType = 'depart' | 'continue' | 'slight_left' | 'left' | 'sharp_left' | 'slight_right' | 'right' | 'sharp_right' | 'uturn' | 'cross' | 'stairs' | 'arrive';

/** Krok nawigacji "krok po kroku". */
export interface RouteStep {
  maneuver: ManeuverType;
  /** Gotowa instrukcja po polsku, np. "Skręć w lewo w ul. Karmelicką i idź 240 m lewą stroną ulicy (w cieniu)". */
  text: string;
  distanceM: number;
  /** Indeks w RouteResult.geometry, od którego zaczyna się krok. */
  geometryIndex: number;
  /** Punkt manewru [lon, lat]. */
  location: LonLat;
  /** Średnia ekspozycja kroku 0..1. */
  sunFraction: number;
}

export interface ThermalInfo {
  /** Temperatura odczuwalna (UTCI lub przybliżenie) w pełnym słońcu / w cieniu, °C; null gdy brak pogody. */
  feltSunC: number | null;
  feltShadeC: number | null;
  /** Średnia odczuwalna wzdłuż trasy, ważona ekspozycją. */
  feltMeanC: number | null;
  /** Kategoria obciążenia cieplnego dla średniej. */
  stress: 'cold' | 'none' | 'moderate' | 'strong' | 'very_strong' | 'extreme' | null;
}

/** Rozszerzenie RouteSegment. */
export interface RouteSegment {
  /** Sygnalizacja świetlna na przejściu (tylko kind = 'crossing'). */
  signals?: boolean;
  /** Nawierzchnia z OSM (surface=*), jeśli znana. */
  surface?: string;
}

/** Rozszerzenie RouteResult. */
export interface RouteResult {
  /** Instrukcje krok po kroku. */
  steps: RouteStep[];
  /** Szacowany łączny czas oczekiwania na światłach (wliczony w durationS). */
  waitS: number;
  /** Liczba przejść z sygnalizacją na trasie. */
  signalCrossings: number;
  /** Liczba odcinków schodów na trasie. */
  stairsCount: number;
  thermal: ThermalInfo;
  /** Punkty chłodu w pobliżu trasy (do ~60 m), w kolejności wzdłuż trasy. */
  coolSpots: CoolSpot[];
  /** Punkt chłodu, przez który trasę celowo poprowadzono (viaCoolSpot). */
  via?: CoolSpot;
}

/** Rozszerzenie RouteResponse. */
export interface RouteResponse {
  /** Faktycznie zastosowany tryb ('auto' rozstrzygnięty na 'shade' albo 'sun'). */
  comfort: 'shade' | 'sun';
  mobility: MobilityProfile;
  /** Skąd pochodzą wysokości obiektów dla tej okolicy. */
  heightSource: 'lidar' | 'osm' | 'mixed';
  /** true, gdy drzewa liściaste liczone są jako bezlistne (sezon). */
  leafOff: boolean;
}

export interface DepartureRequest {
  from: LatLon;
  to: LatLon;
  /** Początek okna (ISO); domyślnie teraz. */
  start?: string;
  /** Długość okna w godzinach (domyślnie 6, max 16) i krok w minutach (domyślnie 30, min 15). */
  windowHours?: number;
  stepMinutes?: number;
  shadePreference?: number;
  mobility?: MobilityProfile;
  comfort?: ComfortMode;
}

export interface DepartureOption {
  time: string; // ISO
  /** Dla trasy "zbalansowanej" o tej godzinie. */
  distanceM: number;
  durationS: number;
  shadeFraction: number;
  sunDistanceM: number;
  sunFactor: number;
  feltMeanC: number | null;
  /** Wynik komfortu 0..100 (wyżej = lepiej) łączący cień, pogodę i długość. */
  score: number;
}

export interface DepartureResponse {
  options: DepartureOption[];
  /** Indeks najlepszej opcji w `options`. */
  bestIndex: number;
  /** Jedno zdanie po polsku, np. "Najlepiej wyjść o 18:30 — 82% trasy w cieniu i o 6°C chłodniej niż teraz." */
  summary: string;
}

// ───────────── Asystent AI ─────────────

export interface AssistantStatus {
  available: boolean;
  /** Model używany przez asystenta (gdy dostępny). */
  model?: string;
  /** Powód niedostępności po polsku (np. brak klucza GEMINI_API_KEY). */
  reason?: string;
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Stan aplikacji przekazywany asystentowi jako kontekst. */
export interface AssistantContext {
  from?: (LatLon & { label?: string }) | null;
  to?: (LatLon & { label?: string }) | null;
  time?: string; // ISO
  shadePreference?: number;
  mobility?: MobilityProfile;
  comfort?: ComfortMode;
  /** Pozycja użytkownika z GPS, jeśli znana. */
  userLocation?: LatLon | null;
}

export interface AssistantRequest {
  messages: AssistantMessage[];
  context?: AssistantContext;
}

/** Plan, który UI ma zastosować (ustawić pola i przeliczyć trasę). Pola nieobecne = bez zmian. */
export interface AssistantPlan {
  from?: LatLon & { label: string };
  to?: LatLon & { label: string };
  time?: string; // ISO
  shadePreference?: number;
  mobility?: MobilityProfile;
  comfort?: ComfortMode;
  viaCoolSpot?: boolean;
  /** Który wariant trasy zaznaczyć. */
  selectProfile?: RouteProfile;
}

/**
 * Zdarzenia strumienia POST /api/assistant (Server-Sent Events, każde jako `data: <JSON>\n\n`):
 */
export type AssistantEvent =
  | { type: 'text'; delta: string } // fragment odpowiedzi (Markdown, po polsku)
  | { type: 'tool'; name: string; label: string } // asystent wykonuje czynność, label po polsku ("Szukam: Wawel…")
  | { type: 'plan'; plan: AssistantPlan } // UI stosuje plan
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * Nowe endpointy v2:
 *  GET  /api/coolspots?bbox=w,s,e,n[&time=ISO][&kinds=a,b]  -> CoolSpot[]  (z pobranych kafli; max ~500; z `time` uzupełnia `shaded`)
 *  POST /api/departure        body: DepartureRequest        -> DepartureResponse | ApiError
 *  GET  /api/assistant/status                               -> AssistantStatus
 *  POST /api/assistant        body: AssistantRequest        -> text/event-stream z AssistantEvent
 *        (gdy asystent niedostępny -> 503 ApiError DATA_UNAVAILABLE)
 */
