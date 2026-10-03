// Kontekst routingu dla pary punktów: dane OSM obszaru, scena cieni i graf pieszy (z małym LRU).

import { KRAKOW_BBOX, type LatLon } from '../../shared/types.ts';
import type { BBoxLatLon, RoutingContext } from '../contracts.ts';
import { toLatLon, toXY } from '../geo/project.ts';
import { attachLidar } from '../lidar/store.ts';
import { DataUnavailableError, loadArea } from '../osm/store.ts';
import { lidarTag, sceneForArea } from '../shade/cache.ts';
import { buildGraph } from './build.ts';

export class OutOfAreaError extends Error {
  constructor(message = 'Punkt znajduje się poza obsługiwanym obszarem Krakowa.') {
    super(message);
    this.name = 'OutOfAreaError';
  }
}

export class TooFarError extends Error {
  constructor(message = `Punkty są zbyt daleko od siebie — maksymalna odległość to ${MAX_DISTANCE_M / 1000} km w linii prostej.`) {
    super(message);
    this.name = 'TooFarError';
  }
}

const MAX_DISTANCE_M = 8000;
const MIN_MARGIN_M = 450;
const MARGIN_FRACTION = 0.3;
/**
 * Górna granica marginesu: przy długich trasach 30% odległości oznaczałoby kilkadziesiąt kafli OSM,
 * a objazd w cieniu i tak szuka się w pobliżu prostej łączącej punkty.
 */
const MAX_MARGIN_M = 900;
const CACHE_SIZE = 3;
/**
 * Ile najdłużej zapytanie o trasę czeka na dane mapy. Po tym czasie odpowiadamy błędem, a kafle pobierają się
 * dalej w tle i trafiają do cache — ponowione zapytanie zwykle zastaje je już gotowe.
 */
const LOAD_BUDGET_MS = 40_000;

/** Kolejność wstawiania w Map = kolejność użycia (najdawniej używany na początku). */
const contexts = new Map<string, RoutingContext>();
/** Stan danych LiDAR, z którym zbudowano kontekst — gdy się zmieni (doszły nowe kafle), kontekst jest budowany od nowa. */
const lidarStamps = new WeakMap<RoutingContext, string>();

function isInsideKrakow(point: LatLon): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lon >= KRAKOW_BBOX.west &&
    point.lon <= KRAKOW_BBOX.east &&
    point.lat >= KRAKOW_BBOX.south &&
    point.lat <= KRAKOW_BBOX.north
  );
}

/** Prostokąt obejmujący oba punkty, poszerzony o 30% ich odległości (min. 450 m, maks. 900 m) — miejsce na objazdy w cieniu. */
export function routingBBox(from: LatLon, to: LatLon): BBoxLatLon {
  const [fromX, fromY] = toXY(from.lat, from.lon);
  const [toX, toY] = toXY(to.lat, to.lon);
  const distanceM = Math.hypot(toX - fromX, toY - fromY);
  if (distanceM > MAX_DISTANCE_M) throw new TooFarError();
  const margin = Math.min(MAX_MARGIN_M, Math.max(MIN_MARGIN_M, MARGIN_FRACTION * distanceM));
  const [south, west] = toLatLon(Math.min(fromX, toX) - margin, Math.min(fromY, toY) - margin);
  const [north, east] = toLatLon(Math.max(fromX, toX) + margin, Math.max(fromY, toY) + margin);
  return { west, south, east, north };
}

/** Czeka na dane obszaru najwyżej `budgetMs`; pobieranie nie jest przerywane, tylko przestajemy na nie czekać. */
export async function withinBudget<T>(loading: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DataUnavailableError(
          'Pobieranie danych mapy (OpenStreetMap) dla tej okolicy trwa dłużej niż zwykle. ' +
            'Dane pobierają się dalej w tle — spróbuj ponownie za chwilę.',
        ),
      );
    }, budgetMs);
  });
  // Gdy przegra wyścig, pobieranie kończy się (albo zawodzi) już bez odbiorcy — błąd nie może zostać nieobsłużony.
  loading.catch(() => undefined);
  try {
    return await Promise.race([loading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getRoutingContext(from: LatLon, to: LatLon): Promise<RoutingContext> {
  if (!isInsideKrakow(from)) throw new OutOfAreaError('Punkt startowy znajduje się poza obsługiwanym obszarem Krakowa.');
  if (!isInsideKrakow(to)) throw new OutOfAreaError('Punkt docelowy znajduje się poza obsługiwanym obszarem Krakowa.');

  const area = await withinBudget(loadArea(routingBBox(from, to)), LOAD_BUDGET_MS);

  // LiDAR (wysokości budynków, roślinność, teren) musi być dołączony, ZANIM powstanie scena cieni. attachLidar ma
  // własny limit czasu, nie rzuca i jest idempotentne; bez danych zostaje model z OSM.
  try {
    await attachLidar(area);
  } catch (error) {
    console.warn('[lidar]', error instanceof Error ? error.message : String(error));
  }
  const stamp = lidarTag(area);

  // Budowa sceny i grafu jest synchroniczna, więc równoległe żądania o ten sam obszar nie zbudują go dwa razy:
  // pierwsze, które wróci z attachLidar, zapisuje kontekst, zanim kolejne dojdzie do tego miejsca.
  let context = contexts.get(area.key);
  if (context) contexts.delete(area.key);
  // Kontekst zbudowany dla innego stanu danych (inny obiekt obszaru albo doszły dane LiDAR) jest nieaktualny:
  // jego ekspozycje policzono na innych wysokościach.
  if (context && (context.area !== area || lidarStamps.get(context) !== stamp)) context = undefined;
  if (!context) {
    context = {
      area,
      graph: buildGraph(area.ways, area.blockedNodeIds, area.raisedKerbNodeIds),
      scene: sceneForArea(area),
      exposureCache: new Map(),
    };
    lidarStamps.set(context, stamp);
  }
  contexts.set(area.key, context);
  if (contexts.size > CACHE_SIZE) {
    const oldest = contexts.keys().next().value as string;
    contexts.delete(oldest);
  }
  return context;
}
