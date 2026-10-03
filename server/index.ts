// Serwer HTTP aplikacji "Cień": API (kontrakt w shared/types.ts) oraz — gdy istnieje dist/ — zbudowany frontend.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import { MAX_SHADOW_AREA_KM2 } from '../shared/types.ts';
import type { ApiError, CoolSpot, DepartureRequest, DepartureResponse, RouteRequest, RouteResponse } from '../shared/types.ts';
import { registerAssistantRoutes } from './ai/assistant.ts';
import type { BBoxLatLon } from './contracts.ts';
import { toXY } from './geo/project.ts';
import { sunInfo } from './geo/sun.ts';
import { geocode, GeocoderUnavailableError, reverseGeocode } from './geocode.ts';
import { getHeatField } from './heat/lst.ts';
import { coolSpotsIn, planDeparture, planRoute, ServiceError, toServiceError } from './service.ts';
import { shadowBucket, shadowSun, shadowTileFragment, shadowTilesFor } from './shade/tiles.ts';
import { BadRequestError, parseBBox, parseKinds, parsePoint, parseTime } from './validate.ts';
import { getWeather } from './weather/openmeteo.ts';

const PORT = Number(process.env.PORT ?? 3001);
/** Domyślnie tylko ten komputer; HOST=0.0.0.0 udostępnia aplikację w sieci lokalnej. */
const HOST = process.env.HOST ?? 'localhost';
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

/** Limit okna warstwy cieni z niewielkim zapasem na zaokrąglenia po stronie klienta. */
const MAX_SHADOW_AREA_M2 = MAX_SHADOW_AREA_KM2 * 1.05e6;
/** Odpowiedzi krótsze niż tyle bajtów wysyłamy bez kompresji. */
const MIN_GZIP_BYTES = 2048;

const gzipAsync = promisify(gzip);

type ErrorCode = ApiError['code'];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  OUT_OF_AREA: 400,
  TOO_FAR: 400,
  NO_ROUTE: 404,
  DATA_UNAVAILABLE: 503,
  INTERNAL: 500,
};

function sendError(reply: FastifyReply, code: ErrorCode, message: string, status = STATUS_BY_CODE[code]): FastifyReply {
  const body: ApiError = { error: message, code };
  return reply.code(status).send(body);
}

/** Klient rozłączył się (np. przesunął mapę i anulował zapytanie) — dalsze liczenie nie ma odbiorcy. */
class ClientGoneError extends Error {}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Treść odpowiedzi /api/shadows (tekst JSON). Kafle cieni liczone są pojedynczo; po każdym policzonym kaflu
 * oddajemy sterowanie pętli zdarzeń (inne zapytania nie czekają na całość) i sprawdzamy, czy klient wciąż czeka.
 */
async function shadowsJson(bbox: BBoxLatLon, time: Date, isClientGone: () => boolean): Promise<string> {
  const [minX, minY] = toXY(bbox.south, bbox.west);
  const [maxX, maxY] = toXY(bbox.north, bbox.east);
  if ((maxX - minX) * (maxY - minY) > MAX_SHADOW_AREA_M2) {
    throw new BadRequestError(`Obszar jest zbyt duży, by narysować cienie — przybliż mapę (maks. ok. ${MAX_SHADOW_AREA_KM2} km²).`);
  }

  const bucket = shadowBucket(time);
  const sun = shadowSun(bucket);
  const fragments: string[] = [];
  let missingData = false;
  for (const tile of shadowTilesFor(bbox, sun)) {
    const { fragment, computed } = await shadowTileFragment(tile, bucket, sun);
    if (fragment === null) missingData = true;
    else if (fragment !== '') fragments.push(fragment);
    if (computed) {
      await yieldToEventLoop();
      if (isClientGone()) throw new ClientGoneError();
    }
  }
  return `{"type":"FeatureCollection","missingData":${missingData},"features":[${fragments.join(',')}]}`;
}

/** Wysyła gotowy tekst JSON, skompresowany (gzip liczy się poza pętlą zdarzeń), jeśli klient to obsługuje. */
async function sendJson(request: FastifyRequest, reply: FastifyReply, json: string): Promise<FastifyReply> {
  reply.type('application/json; charset=utf-8').header('Vary', 'Accept-Encoding');
  const acceptsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
  if (!acceptsGzip || json.length < MIN_GZIP_BYTES) return reply.send(json);
  return reply.header('Content-Encoding', 'gzip').send(await gzipAsync(json, { level: 5 }));
}

const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

app.addHook('onResponse', (request, reply, done) => {
  if (request.url.startsWith('/api/')) {
    console.log(`${request.method} ${request.url} → ${reply.statusCode} (${Math.round(reply.elapsedTime)} ms)`);
  }
  done();
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ClientGoneError) return reply.code(499).send();
  if (error instanceof GeocoderUnavailableError) return sendError(reply, 'DATA_UNAVAILABLE', error.message);
  // Błędy Fastify (niepoprawny JSON, za duże body itp.) niosą własny kod statusu 4xx.
  const status = (error as { statusCode?: number }).statusCode;
  if (!(error instanceof ServiceError) && !(error instanceof BadRequestError) && typeof status === 'number' && status >= 400 && status < 500) {
    return sendError(reply, 'BAD_REQUEST', 'Niepoprawne zapytanie.', status);
  }
  // Pozostałe błędy (walidacja, brak trasy, brak danych…) mapuje wspólna logika serwisu; nieznane loguje jako INTERNAL.
  const serviceError = toServiceError(error);
  return sendError(reply, serviceError.code, serviceError.message);
});

app.get('/api/health', async () => ({ ok: true }));

// Walidacja i cała logika tras żyją w service.ts (korzysta z niej także asystent AI).
app.post('/api/route', async (request): Promise<RouteResponse> => planRoute(request.body as RouteRequest));

app.post('/api/departure', async (request): Promise<DepartureResponse> => planDeparture(request.body as DepartureRequest));

app.get('/api/coolspots', async (request): Promise<CoolSpot[]> => {
  const query = request.query as Record<string, unknown>;
  const time = query.time === undefined || query.time === '' ? undefined : parseTime(query.time);
  return coolSpotsIn(parseBBox(query.bbox), { time, kinds: parseKinds(query.kinds) });
});

registerAssistantRoutes(app);

app.get('/api/shadows', async (request, reply) => {
  const query = request.query as Record<string, unknown>;
  const isClientGone = (): boolean => request.raw.socket.destroyed;
  return sendJson(request, reply, await shadowsJson(parseBBox(query.bbox), parseTime(query.time), isClientGone));
});

app.get('/api/sun', async (request) => sunInfo(parseTime((request.query as Record<string, unknown>).time)));

app.get('/api/weather', async (request) => getWeather(parseTime((request.query as Record<string, unknown>).time)));

app.get('/api/geocode', async (request) => {
  const q = (request.query as Record<string, unknown>).q;
  if (typeof q !== 'string' || q.trim() === '') throw new BadRequestError('Brak parametru „q” (szukany tekst).');
  if (q.length > 200) throw new BadRequestError('Szukany tekst jest zbyt długi.');
  return geocode(q.trim());
});

app.get('/api/reverse', async (request, reply) => {
  const query = request.query as Record<string, unknown>;
  const point = parsePoint({ lat: Number(query.lat ?? NaN), lon: Number(query.lon ?? NaN) }, '(parametry „lat” i „lon”)');
  // Jawna serializacja: Fastify dla wartości null wysłałby pustą odpowiedź zamiast JSON-owego "null".
  return reply.type('application/json; charset=utf-8').send(JSON.stringify(await reverseGeocode(point.lat, point.lon)));
});

app.get('/api/heat/meta', async () => getHeatField().meta());

app.get('/api/heat/overlay.png', async (_request, reply) => {
  const png = getHeatField().overlayPng();
  if (!png) return sendError(reply, 'DATA_UNAVAILABLE', 'Mapa temperatury powierzchni (LST) nie jest dostępna.', 404);
  return reply.type('image/png').header('Cache-Control', 'public, max-age=3600').send(png);
});

const hasFrontend = existsSync(path.join(DIST_DIR, 'index.html'));
if (hasFrontend) {
  await app.register(fastifyStatic, { root: DIST_DIR });
}

app.setNotFoundHandler((request, reply) => {
  const isApi = request.url === '/api' || request.url.startsWith('/api/');
  if (isApi) return sendError(reply, 'BAD_REQUEST', 'Nie ma takiego adresu API.', 404);
  // Aplikacja jednostronicowa: nieznane ścieżki (poza plikami zasobów) dostają index.html.
  const isAsset = path.extname(request.url.split('?')[0]) !== '';
  if (hasFrontend && request.method === 'GET' && !isAsset) return reply.sendFile('index.html');
  return reply.code(404).type('text/plain; charset=utf-8').send('Nie znaleziono.');
});

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`Cień — serwer działa: http://localhost:${PORT}${hasFrontend ? '' : ' (samo API; frontend: npm run dev albo npm run build)'}`);
} catch (error) {
  console.error(`Nie udało się uruchomić serwera na porcie ${PORT}: ${(error as Error).message}`);
  process.exit(1);
}
