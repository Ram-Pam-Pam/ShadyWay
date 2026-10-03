// Mapa MapLibre: podkład, znaczniki A/B, trasy barwione udziałem słońca, cienie, mapa ciepła, budynki 3D.

import {
  AttributionControl,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type MapMouseEvent,
  type PaddingOptions,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import {
  KRAKOW_BBOX,
  KRAKOW_CENTER,
  type CoolSpot,
  type HeatMeta,
  type LatLon,
  type LonLat,
  type RouteProfile,
  type RouteResult,
  type RouteSegment,
} from '../../shared/types.ts';
import { HEAT_OVERLAY_URL, type ShadowCollection } from './api.ts';
import { coolSpotMarkerKey, type CoolSpotMarker, type CoolSpotRole } from './coolSpots.ts';
import { routeColorScale } from './format.ts';
import type { EndpointKey } from './store.ts';

// Bundler nie widzi dynamicznego adresu workera wewnątrz MapLibre, więc podajemy go jawnie.
setWorkerUrl(workerUrl);

const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

const BOUNDS_MARGIN_DEG = 0.06;
const HIT_TOLERANCE_PX = 7;
/** Poniżej tego przybliżenia znaczniki punktów chłodu są pomniejszane (klasa map--far). */
const FAR_ZOOM = 14.5;
const SHADOW_COLOR = '#1e1b4b';
const ALT_ROUTE_COLOR = '#7b7e98';

const SOURCE = {
  shadows: 'cien-shadows',
  heat: 'cien-heat',
  altRoutes: 'cien-routes-alt',
  route: 'cien-route',
  accuracy: 'cien-user-accuracy',
} as const;

const LAYER = {
  heat: 'cien-heat',
  shadows: 'cien-shadows',
  buildings3d: 'cien-buildings-3d',
  altCasing: 'cien-routes-alt-casing',
  altLine: 'cien-routes-alt-line',
  altHit: 'cien-routes-alt-hit',
  routeCasing: 'cien-route-casing',
  routeLine: 'cien-route-line',
  routeHit: 'cien-route-hit',
  accuracy: 'cien-user-accuracy',
} as const;

const MAP_LOCALE: Record<string, string> = {
  'AttributionControl.ToggleAttribution': 'Pokaż lub ukryj informacje o źródłach danych',
  'Map.Title': 'Mapa',
  'Marker.Title': 'Znacznik na mapie',
  'NavigationControl.ResetBearing': 'Przeciągnij, aby obrócić mapę; kliknij, aby ustawić północ u góry',
  'NavigationControl.ZoomIn': 'Przybliż',
  'NavigationControl.ZoomOut': 'Oddal',
  'Popup.Close': 'Zamknij',
};

const EMPTY_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Kolor odcinka trasy wg udziału słońca; skala zależy od trybu (cień latem, słońce zimą). */
function sunColorExpression(comfort: 'shade' | 'sun'): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['get', 'sun'],
    ...routeColorScale(comfort).flatMap(([stop, color]) => [stop, color]),
  ] as ExpressionSpecification;
}

export interface MapViewOptions {
  container: HTMLElement;
  /** Kliknięcie w mapę poza trasą. */
  onPick(point: LatLon): void;
  onMarkerDrag(which: EndpointKey, point: LatLon): void;
  onSelectRoute(profile: RouteProfile): void;
  /** Koniec ruchu mapy (przesunięcie, zoom). */
  onViewChange(): void;
  /** Treść dymka dla odcinka wybranej trasy. */
  describeSegment(segment: RouteSegment): HTMLElement;
  /** Element znacznika punktu chłodu (przycisk z ikoną). */
  createCoolSpotElement(spot: CoolSpot, role: CoolSpotRole): HTMLElement;
  /** Treść dymka punktu chłodu. */
  describeCoolSpot(spot: CoolSpot, role: CoolSpotRole): HTMLElement;
  /** Margines na elementy interfejsu zasłaniające mapę (np. dolny arkusz na telefonie). */
  getPadding(): PaddingOptions;
}

function line(coords: [number, number][], properties: Record<string, unknown>): Feature<LineString> {
  return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords } };
}

/** Pozycja pieszego w trybie nawigacji. */
export interface UserPosition extends LatLon {
  /** Promień niepewności w metrach (null = nie rysuj okręgu). */
  accuracyM: number | null;
  /** Kierunek marszu, 0 = północ (null = brak strzałki). */
  headingDeg: number | null;
}

export interface FollowOptions {
  /** Obrót mapy (kierunek marszu u góry); 0 = północ u góry. */
  bearingDeg: number;
  pitch: number;
  zoom: number;
  /** Przesunięcie pozycji w dół ekranu, jako ułamek wysokości mapy (widać więcej drogi przed sobą). */
  offsetY: number;
  durationMs: number;
}

/** Okrąg o promieniu w metrach jako wielokąt GeoJSON (do zaznaczenia dokładności GPS). */
function circlePolygon(center: LatLon, radiusM: number, points = 48): Feature {
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI;
    ring.push([
      center.lon + (Math.cos(angle) * radiusM) / (111_320 * cosLat),
      center.lat + (Math.sin(angle) * radiusM) / 110_540,
    ]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function createPin(which: EndpointKey): HTMLElement {
  const pin = document.createElement('div');
  pin.className = `pin pin--${which}`;
  pin.title = which === 'from' ? 'Start (A) — przeciągnij, aby zmienić' : 'Cel (B) — przeciągnij, aby zmienić';
  const letter = document.createElement('span');
  letter.textContent = which === 'from' ? 'A' : 'B';
  pin.append(letter);
  return pin;
}

export class MapView {
  private readonly map: MapLibreMap;
  private readonly options: MapViewOptions;
  private readonly markers: Record<EndpointKey, Marker | null> = { from: null, to: null };
  private readonly hoverPopup = new Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'segment-popup' });
  private readonly pinnedPopup = new Popup({ closeButton: true, closeOnClick: true, offset: 12, className: 'segment-popup' });
  private loaded = false;
  private readonly pending: Array<() => void> = [];
  private firstSymbolLayerId: string | undefined;
  /** Źródło wektorowe z warstwą budynków w stylu podkładu (null = podkład jej nie ma). */
  private buildingSourceId: string | null = null;
  private segments: RouteSegment[] = [];
  private hoveredSegment = -1;
  private readonly spotPopup = new Popup({ closeButton: true, closeOnClick: true, offset: 18, className: 'segment-popup' });
  /** Znaczniki punktów chłodu wg klucza (rola + id + stan cienia). */
  private readonly spotMarkers = new Map<string, Marker>();
  private stepMarker: Marker | null = null;
  private comfort: 'shade' | 'sun' = 'shade';
  private userMarker: Marker | null = null;
  private userArrow: HTMLElement | null = null;
  /** W trybie nawigacji kamerą steruje nawigacja — dopasowanie widoku do trasy jest wstrzymane. */
  private fitLocked = false;
  private readonly userPanListeners = new Set<() => void>();

  constructor(options: MapViewOptions) {
    this.options = options;
    this.map = new MapLibreMap({
      container: options.container,
      style: BASE_STYLE_URL,
      center: [KRAKOW_CENTER.lon, KRAKOW_CENTER.lat],
      zoom: 14,
      minZoom: 10,
      maxZoom: 19.5,
      maxPitch: 60,
      maxBounds: [
        [KRAKOW_BBOX.west - BOUNDS_MARGIN_DEG, KRAKOW_BBOX.south - BOUNDS_MARGIN_DEG],
        [KRAKOW_BBOX.east + BOUNDS_MARGIN_DEG, KRAKOW_BBOX.north + BOUNDS_MARGIN_DEG],
      ],
      attributionControl: false,
      locale: MAP_LOCALE,
    });

    this.map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: [
          'Wysokości (LiDAR): NMT/NMPT © <a href="https://www.geoportal.gov.pl/" target="_blank" rel="noopener">GUGiK</a>',
          'LST: Landsat (USGS)',
          'Pogoda: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>',
        ],
      }),
      'bottom-right',
    );

    this.map.on('load', () => this.handleLoad());
    this.map.on('moveend', () => this.options.onViewChange());
    const syncFar = (): void => {
      this.map.getContainer().classList.toggle('map--far', this.map.getZoom() < FAR_ZOOM);
    };
    this.map.on('zoom', syncFar);
    syncFar();
    this.map.on('click', (event) => this.handleClick(event));
    this.map.on('mousemove', (event) => this.handleMouseMove(event));
    this.map.on('mouseout', () => this.clearHover());
    // Ruch mapy wywołany gestem użytkownika (a nie przez easeTo) ma w zdarzeniu oryginalne zdarzenie wejścia.
    const userPan = (event: { originalEvent?: unknown }): void => {
      if (!event.originalEvent) return;
      for (const listener of this.userPanListeners) listener();
    };
    this.map.on('dragstart', userPan);
    this.map.on('zoomstart', userPan);
    this.map.on('rotatestart', userPan);
  }

  /** Powiadamia, gdy użytkownik sam przesunie, przybliży lub obróci mapę. */
  onUserPan(listener: () => void): () => void {
    this.userPanListeners.add(listener);
    return () => this.userPanListeners.delete(listener);
  }

  /** Wstrzymuje dopasowywanie widoku do trasy (kamerę prowadzi tryb nawigacji). */
  setFitLocked(locked: boolean): void {
    this.fitLocked = locked;
  }

  /** Rysuje pozycję pieszego (kropka ze strzałką kierunku i okręgiem dokładności); null ją usuwa. */
  setUserPosition(position: UserPosition | null): void {
    if (!position) {
      this.userMarker?.remove();
      this.userMarker = null;
      this.userArrow = null;
      this.run(() => this.geoJsonSource(SOURCE.accuracy).setData(EMPTY_COLLECTION));
      return;
    }
    if (!this.userMarker) {
      const element = document.createElement('div');
      element.className = 'puck';
      const arrow = document.createElement('div');
      arrow.className = 'puck__arrow';
      const dot = document.createElement('div');
      dot.className = 'puck__dot';
      element.append(arrow, dot);
      this.userArrow = arrow;
      // rotationAlignment 'map': strzałka pokazuje kierunek w terenie także przy obróconej mapie.
      this.userMarker = new Marker({ element, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'map' });
    }
    this.userMarker.setLngLat([position.lon, position.lat]).addTo(this.map);
    if (this.userArrow) this.userArrow.hidden = position.headingDeg === null;
    if (position.headingDeg !== null) this.userMarker.setRotation(position.headingDeg);
    const accuracy = position.accuracyM;
    this.run(() =>
      this.geoJsonSource(SOURCE.accuracy).setData(
        accuracy !== null && accuracy >= 8
          ? { type: 'FeatureCollection', features: [circlePolygon(position, Math.min(accuracy, 250))] }
          : EMPTY_COLLECTION,
      ),
    );
  }

  /** Prowadzi kamerę za pieszym. */
  follow(center: LatLon, options: FollowOptions): void {
    const height = this.map.getContainer().clientHeight;
    this.map.easeTo({
      center: [center.lon, center.lat],
      bearing: options.bearingDeg,
      pitch: options.pitch,
      zoom: options.zoom,
      offset: [0, height * options.offsetY],
      duration: options.durationMs,
      easing: (t) => t,
    });
  }

  /** Przywraca widok z północą u góry (po wyjściu z nawigacji). */
  resetCamera(pitch: number): void {
    this.map.easeTo({ bearing: 0, pitch, duration: 500 });
  }


  /** true, gdy podkład ma warstwę budynków z wysokościami (dostępne po załadowaniu stylu). */
  whenReady(callback: (info: { hasBuildings: boolean }) => void): void {
    this.run(() => callback({ hasBuildings: this.buildingSourceId !== null }));
  }

  getCenter(): LatLon {
    const center = this.map.getCenter();
    return { lat: center.lat, lon: center.lng };
  }

  /** Widoczne okno mapy [west, south, east, north]; przy pochylonej mapie to prostokąt opisany na widocznym trapezie. */
  getViewBbox(): [number, number, number, number] {
    const bounds = this.map.getBounds();
    return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
  }

  getZoom(): number {
    return this.map.getZoom();
  }

  /** Tryb komfortu zmienia skalę barw wybranej trasy (zimą wyróżnione są odcinki w słońcu). */
  setComfort(comfort: 'shade' | 'sun'): void {
    if (comfort === this.comfort) return;
    this.comfort = comfort;
    this.run(() => this.map.setPaintProperty(LAYER.routeLine, 'line-color', sunColorExpression(comfort)));
  }

  /** Rysuje znaczniki punktów chłodu; niezmienione znaczniki zostają na miejscu (bez migotania przy ruchu mapy). */
  setCoolSpots(markers: readonly CoolSpotMarker[]): void {
    const wanted = new Map(markers.map((marker) => [coolSpotMarkerKey(marker), marker]));
    for (const [key, marker] of this.spotMarkers) {
      if (wanted.has(key)) continue;
      marker.remove();
      this.spotMarkers.delete(key);
    }
    for (const [key, { spot, role }] of wanted) {
      if (this.spotMarkers.has(key)) continue;
      const element = this.options.createCoolSpotElement(spot, role);
      element.addEventListener('click', (event) => {
        // Kliknięcie znacznika nie jest kliknięciem mapy (nie ustawia punktu trasy ani nie zamyka dymka).
        event.stopPropagation();
        this.hoverPopup.remove();
        this.pinnedPopup.remove();
        this.spotPopup
          .setLngLat([spot.lon, spot.lat])
          .setDOMContent(this.options.describeCoolSpot(spot, role))
          .addTo(this.map);
      });
      const marker = new Marker({ element, anchor: 'center' }).setLngLat([spot.lon, spot.lat]).addTo(this.map);
      this.spotMarkers.set(key, marker);
    }
    if (this.spotPopup.isOpen() && markers.length === 0) this.spotPopup.remove();
  }

  closeSpotPopup(): void {
    this.spotPopup.remove();
  }

  /** Podświetla punkt na mapie (miejsce kroku nawigacji); null zdejmuje podświetlenie. */
  highlightPoint(location: LonLat | null, pan = false): void {
    if (!location) {
      this.stepMarker?.remove();
      this.stepMarker = null;
      return;
    }
    if (!this.stepMarker) {
      const element = document.createElement('div');
      element.className = 'step-marker';
      this.stepMarker = new Marker({ element, anchor: 'center' });
    }
    this.stepMarker.setLngLat(location).addTo(this.map);
    if (!pan) return;
    const padding = this.options.getPadding();
    this.map.easeTo({
      center: location,
      zoom: Math.max(this.map.getZoom(), 16.5),
      offset: [
        ((padding.left ?? 0) - (padding.right ?? 0)) / 2,
        ((padding.top ?? 0) - (padding.bottom ?? 0)) / 2,
      ],
      duration: 500,
    });
  }

  setPickCursor(active: boolean): void {
    this.map.getContainer().classList.toggle('map--picking', active);
  }

  setMarker(which: EndpointKey, point: LatLon | null): void {
    const existing = this.markers[which];
    if (!point) {
      existing?.remove();
      this.markers[which] = null;
      return;
    }
    if (existing) {
      existing.setLngLat([point.lon, point.lat]);
      return;
    }
    const marker = new Marker({ element: createPin(which), anchor: 'bottom', draggable: true })
      .setLngLat([point.lon, point.lat])
      .addTo(this.map);
    marker.on('dragend', () => {
      const position = marker.getLngLat();
      this.options.onMarkerDrag(which, { lat: position.lat, lon: position.lng });
    });
    this.markers[which] = marker;
  }

  flyTo(point: LatLon): void {
    // `offset` zamiast `padding`: padding przekazany do easeTo zostaje w mapie na stałe
    // i sumowałby się z marginesem późniejszego fitBounds.
    const padding = this.options.getPadding();
    this.map.easeTo({
      center: [point.lon, point.lat],
      zoom: Math.max(this.map.getZoom(), 15),
      offset: [
        ((padding.left ?? 0) - (padding.right ?? 0)) / 2,
        ((padding.top ?? 0) - (padding.bottom ?? 0)) / 2,
      ],
    });
  }

  /** Rysuje trasy: wybraną odcinkami wg udziału słońca, pozostałe jako cienkie, stonowane linie. */
  setRoutes(routes: RouteResult[], selected: RouteResult | null, dimmed: boolean): void {
    this.segments = selected?.segments ?? [];
    this.hoveredSegment = -1;
    this.hoverPopup.remove();
    this.pinnedPopup.remove();

    const alternatives = routes
      .filter((route) => route !== selected && route.geometry.length >= 2)
      .map((route) => line(route.geometry, { profile: route.profile }));
    const segmentFeatures = this.segments.flatMap((segment, index) =>
      segment.coords.length >= 2 ? [line(segment.coords, { index, sun: segment.sunFraction })] : [],
    );

    this.run(() => {
      this.geoJsonSource(SOURCE.altRoutes).setData({ type: 'FeatureCollection', features: alternatives });
      this.geoJsonSource(SOURCE.route).setData({ type: 'FeatureCollection', features: segmentFeatures });
      this.map.setPaintProperty(LAYER.routeLine, 'line-opacity', dimmed ? 0.45 : 1);
      this.map.setPaintProperty(LAYER.altLine, 'line-opacity', dimmed ? 0.35 : 0.85);
    });
  }

  /**
   * Dopasowuje widok do trasy. W trybie 'if-needed' nie rusza mapy, gdy trasa jest już cała widoczna
   * i zajmuje sensowną część okna (żeby nie szarpać widokiem po przeciągnięciu znacznika).
   */
  fitRoute(route: RouteResult, mode: 'always' | 'if-needed'): void {
    if (this.fitLocked || route.geometry.length < 2) return;
    const bounds = new LngLatBounds();
    for (const coord of route.geometry) bounds.extend(coord);
    const padding = this.options.getPadding();

    if (mode === 'if-needed') {
      const size = this.map.getContainer().getBoundingClientRect();
      const topLeft = this.map.project(bounds.getNorthWest());
      const bottomRight = this.map.project(bounds.getSouthEast());
      const minX = padding.left ?? 0;
      const minY = padding.top ?? 0;
      const maxX = size.width - (padding.right ?? 0);
      const maxY = size.height - (padding.bottom ?? 0);
      const visible = topLeft.x >= minX && topLeft.y >= minY && bottomRight.x <= maxX && bottomRight.y <= maxY;
      const coverage = Math.max(
        (bottomRight.x - topLeft.x) / Math.max(1, maxX - minX),
        (bottomRight.y - topLeft.y) / Math.max(1, maxY - minY),
      );
      if (visible && coverage >= 0.35) return;
    }
    this.map.fitBounds(bounds, { padding, maxZoom: 17, duration: 700 });
  }

  setShadows(data: ShadowCollection | null, visible: boolean): void {
    this.run(() => {
      this.geoJsonSource(SOURCE.shadows).setData(data ?? EMPTY_COLLECTION);
      this.map.setLayoutProperty(LAYER.shadows, 'visibility', visible ? 'visible' : 'none');
    });
  }

  setHeat(meta: HeatMeta | null, visible: boolean): void {
    this.run(() => {
      if (!this.map.getLayer(LAYER.heat)) {
        if (!visible || !meta?.bounds) return;
        const [west, south, east, north] = meta.bounds;
        this.map.addSource(SOURCE.heat, {
          type: 'image',
          url: HEAT_OVERLAY_URL,
          coordinates: [
            [west, north],
            [east, north],
            [east, south],
            [west, south],
          ],
        });
        this.map.addLayer(
          {
            id: LAYER.heat,
            type: 'raster',
            source: SOURCE.heat,
            paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
          },
          LAYER.shadows,
        );
        return;
      }
      this.map.setLayoutProperty(LAYER.heat, 'visibility', visible ? 'visible' : 'none');
    });
  }

  setBuildings3d(visible: boolean): void {
    this.run(() => {
      if (!this.buildingSourceId) return;
      if (!this.map.getLayer(LAYER.buildings3d)) {
        if (!visible) return;
        this.map.addLayer(
          {
            id: LAYER.buildings3d,
            type: 'fill-extrusion',
            source: this.buildingSourceId,
            'source-layer': 'building',
            minzoom: 14,
            paint: {
              'fill-extrusion-color': '#dcdce8',
              'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
              'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
              'fill-extrusion-opacity': 0.82,
            },
          },
          LAYER.altCasing,
        );
      } else {
        this.map.setLayoutProperty(LAYER.buildings3d, 'visibility', visible ? 'visible' : 'none');
      }
      // Pochylenie pokazuje bryły; po wyłączeniu wracamy do widoku z góry.
      this.map.easeTo({ pitch: visible ? 50 : 0, duration: 600 });
    });
  }

  private run(action: () => void): void {
    if (this.loaded) action();
    else this.pending.push(action);
  }

  private geoJsonSource(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }

  private handleLoad(): void {
    const layers = this.map.getStyle().layers;
    this.firstSymbolLayerId = layers.find((layer) => layer.type === 'symbol')?.id;
    const buildingLayer = layers.find((layer) => 'source-layer' in layer && layer['source-layer'] === 'building');
    this.buildingSourceId = buildingLayer && 'source' in buildingLayer ? String(buildingLayer.source) : null;

    this.addOverlayLayers();
    this.loaded = true;
    for (const action of this.pending.splice(0)) action();
  }

  /** Warstwy aplikacji wstawiamy pod etykiety podkładu, żeby nazwy ulic pozostały czytelne. */
  private addOverlayLayers(): void {
    const before = this.firstSymbolLayerId;
    const map = this.map;

    map.addSource(SOURCE.shadows, { type: 'geojson', data: EMPTY_COLLECTION });
    map.addSource(SOURCE.altRoutes, { type: 'geojson', data: EMPTY_COLLECTION });
    map.addSource(SOURCE.route, { type: 'geojson', data: EMPTY_COLLECTION });
    map.addSource(SOURCE.accuracy, { type: 'geojson', data: EMPTY_COLLECTION });

    // fill-extrusion o znikomej wysokości: krycie jest liczone dla całej warstwy,
    // więc nakładające się wielokąty cieni (budynek + drzewo) nie przyciemniają się podwójnie.
    map.addLayer(
      {
        id: LAYER.shadows,
        type: 'fill-extrusion',
        source: SOURCE.shadows,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': SHADOW_COLOR,
          'fill-extrusion-height': 0.05,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.34,
          'fill-extrusion-vertical-gradient': false,
        },
      },
      before,
    );

    const roundLine = { 'line-cap': 'round', 'line-join': 'round' } as const;
    const width = (base: number): ExpressionSpecification => [
      'interpolate',
      ['linear'],
      ['zoom'],
      12,
      base * 0.6,
      16,
      base,
      19,
      base * 1.6,
    ];

    map.addLayer(
      {
        id: LAYER.altCasing,
        type: 'line',
        source: SOURCE.altRoutes,
        layout: roundLine,
        paint: { 'line-color': '#ffffff', 'line-width': width(6), 'line-opacity': 0.9 },
      },
      before,
    );
    map.addLayer(
      {
        id: LAYER.altLine,
        type: 'line',
        source: SOURCE.altRoutes,
        layout: roundLine,
        paint: { 'line-color': ALT_ROUTE_COLOR, 'line-width': width(3), 'line-opacity': 0.85 },
      },
      before,
    );
    map.addLayer(
      {
        id: LAYER.routeCasing,
        type: 'line',
        source: SOURCE.route,
        layout: roundLine,
        paint: { 'line-color': '#ffffff', 'line-width': width(10) },
      },
      before,
    );
    map.addLayer(
      {
        id: LAYER.routeLine,
        type: 'line',
        source: SOURCE.route,
        layout: roundLine,
        paint: { 'line-color': sunColorExpression(this.comfort), 'line-width': width(6) },
      },
      before,
    );
    map.addLayer(
      {
        id: LAYER.accuracy,
        type: 'fill',
        source: SOURCE.accuracy,
        paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.14, 'fill-outline-color': '#2563eb' },
      },
      before,
    );
    // Niewidoczne, szerokie linie ułatwiają trafienie w trasę palcem lub kursorem.
    for (const [id, source] of [
      [LAYER.altHit, SOURCE.altRoutes],
      [LAYER.routeHit, SOURCE.route],
    ] as const) {
      map.addLayer(
        { id, type: 'line', source, layout: roundLine, paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 22 } },
        before,
      );
    }
  }

  private featuresNear(event: MapMouseEvent, layer: string) {
    const { x, y } = event.point;
    return this.map.queryRenderedFeatures(
      [
        [x - HIT_TOLERANCE_PX, y - HIT_TOLERANCE_PX],
        [x + HIT_TOLERANCE_PX, y + HIT_TOLERANCE_PX],
      ],
      { layers: [layer] },
    );
  }

  private segmentAt(event: MapMouseEvent): number {
    if (!this.loaded) return -1;
    const index = this.featuresNear(event, LAYER.routeHit)[0]?.properties?.index;
    return typeof index === 'number' && this.segments[index] ? index : -1;
  }

  private handleClick(event: MapMouseEvent): void {
    const target = event.originalEvent.target;
    if (target instanceof Element && target.closest('.pin, .spot, .step-marker, .puck')) return;

    const segmentIndex = this.segmentAt(event);
    if (segmentIndex >= 0) {
      this.hoverPopup.remove();
      this.pinnedPopup
        .setLngLat(event.lngLat)
        .setDOMContent(this.options.describeSegment(this.segments[segmentIndex]))
        .addTo(this.map);
      return;
    }

    if (this.loaded) {
      const profile = this.featuresNear(event, LAYER.altHit)[0]?.properties?.profile;
      if (typeof profile === 'string') {
        this.options.onSelectRoute(profile as RouteProfile);
        return;
      }
    }
    this.options.onPick({ lat: event.lngLat.lat, lon: event.lngLat.lng });
  }

  private handleMouseMove(event: MapMouseEvent): void {
    if (!this.loaded) return;
    const segmentIndex = this.segmentAt(event);
    const overAlternative = segmentIndex < 0 && this.featuresNear(event, LAYER.altHit).length > 0;
    this.map.getCanvas().style.cursor = segmentIndex >= 0 || overAlternative ? 'pointer' : '';

    if (segmentIndex < 0 || this.pinnedPopup.isOpen()) {
      this.clearHover();
      return;
    }
    this.hoverPopup.setLngLat(event.lngLat);
    if (segmentIndex !== this.hoveredSegment) {
      this.hoveredSegment = segmentIndex;
      this.hoverPopup.setDOMContent(this.options.describeSegment(this.segments[segmentIndex])).addTo(this.map);
    }
  }

  private clearHover(): void {
    this.hoveredSegment = -1;
    this.hoverPopup.remove();
  }
}
