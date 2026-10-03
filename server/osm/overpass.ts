// Klient Overpass API: POST z kolejką mirrorów, limitem czasu, ponowieniami i globalnym limitem współbieżności.

export interface OverpassLatLon {
  lat: number;
  lon: number;
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  /** Obecne dla członków typu way przy "out geom". */
  geometry?: (OverpassLatLon | null)[];
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  /** Węzły: współrzędne. */
  lat?: number;
  lon?: number;
  /** Drogi przy "out body": identyfikatory węzłów, zgodne co do indeksu z `geometry`. */
  nodes?: number[];
  /** Drogi przy "out geom". */
  geometry?: (OverpassLatLon | null)[];
  /** Relacje. */
  members?: OverpassMember[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

export class OverpassError extends Error {}

/** Kolejność wg zmierzonej dostępności: openstreetmap.fr działa stabilnie, overpass-api.de bywa przeciążony. */
export const OVERPASS_MIRRORS: readonly string[] = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Uwaga: overpass.openstreetmap.fr odpowiada 403 na domyślny User-Agent Node.js i na UA zawierające "Node.js".
const USER_AGENT = 'Cien-SmartCity-Krakow/0.1 (nawigacja piesza w cieniu)';

export interface OverpassClientOptions {
  mirrors?: readonly string[];
  /** Limit czasu jednej próby (nagłówki + treść); próba nie trwa też dłużej, niż zostało do `deadlineMs`. */
  timeoutMs?: number;
  /** Ile razy przejść całą listę mirrorów. */
  rounds?: number;
  /** Jak długo pomijać mirror, który właśnie zawiódł. */
  cooldownMs?: number;
  /** Bazowa przerwa między rundami (mnożona przez numer rundy). */
  backoffMs?: number;
  /** Łączny budżet czasu jednego zapytania (liczony od rozpoczęcia pierwszej próby): przerywa też próbę w toku. */
  deadlineMs?: number;
  maxConcurrent?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

export interface OverpassClient {
  query(ql: string): Promise<OverpassResponse>;
}

/** Sprawdza treść odpowiedzi; rzuca OverpassError dla stron błędów HTML i odpowiedzi z "remark" o błędzie. */
export function parseOverpassBody(body: string): OverpassResponse {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new OverpassError(`odpowiedź nie jest JSON-em: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  if (typeof json !== 'object' || json === null || !Array.isArray((json as OverpassResponse).elements)) {
    throw new OverpassError('odpowiedź bez tablicy "elements"');
  }
  const response = json as OverpassResponse;
  if (typeof response.remark === 'string' && /error|timeout|timed out/i.test(response.remark)) {
    throw new OverpassError(`Overpass zgłosił błąd: ${response.remark}`);
  }
  return response;
}

export function createOverpassClient(options: OverpassClientOptions = {}): OverpassClient {
  const mirrors = options.mirrors ?? OVERPASS_MIRRORS;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const rounds = options.rounds ?? 2;
  const cooldownMs = options.cooldownMs ?? 3 * 60_000;
  const backoffMs = options.backoffMs ?? 2_000;
  const deadlineMs = options.deadlineMs ?? 75_000;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowFn = options.nowFn ?? Date.now;

  const failedUntil = new Map<string, number>();
  let active = 0;
  const waiting: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return;
    }
    // Zwalniający przekazuje swój slot bezpośrednio czekającemu, więc `active` się nie zmienia.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  /** Mirrory bez świeżej awarii najpierw; "ostygające" na końcu jako ostatnia deska ratunku. */
  function orderedMirrors(): string[] {
    const now = nowFn();
    const healthy = mirrors.filter((m) => (failedUntil.get(m) ?? 0) <= now);
    const cooling = mirrors.filter((m) => (failedUntil.get(m) ?? 0) > now);
    return [...healthy, ...cooling];
  }

  async function attempt(mirror: string, ql: string, limitMs: number): Promise<OverpassResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      const res = await fetchFn(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(ql)}`,
        signal: controller.signal,
      });
      if (!res.ok) throw new OverpassError(`HTTP ${res.status}`);
      return parseOverpassBody(await res.text());
    } catch (err) {
      if (controller.signal.aborted) throw new OverpassError(`przekroczono limit czasu ${Math.round(limitMs)} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function query(ql: string): Promise<OverpassResponse> {
    await acquire();
    try {
      const failures: string[] = [];
      const deadline = nowFn() + deadlineMs;
      for (let round = 1; round <= rounds && nowFn() < deadline; round++) {
        if (round > 1) await sleepFn(backoffMs * (round - 1));
        for (const mirror of orderedMirrors()) {
          const remainingMs = deadline - nowFn();
          if (remainingMs <= 0) break;
          try {
            const response = await attempt(mirror, ql, Math.min(timeoutMs, remainingMs));
            failedUntil.delete(mirror);
            return response;
          } catch (err) {
            failedUntil.set(mirror, nowFn() + cooldownMs);
            failures.push(`${new URL(mirror).host}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      throw new OverpassError(`Wszystkie serwery Overpass zawiodły (${failures.join('; ')})`);
    } finally {
      release();
    }
  }

  return { query };
}

const defaultClient = createOverpassClient();

/** Zapytanie przez domyślnego klienta (wspólny limit 2 równoległych zapytań na proces). */
export function overpassQuery(ql: string): Promise<OverpassResponse> {
  return defaultClient.query(ql);
}
