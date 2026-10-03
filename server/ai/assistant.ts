// „Asystent Cienia”: endpointy GET /api/assistant/status i POST /api/assistant (Server-Sent Events).
//
// Asystent to pętla agenta na Claude API: model planuje narzędziami z tools.ts (geokodowanie, trasa,
// najlepsza godzina, punkty chłodu, pogoda, pokazanie planu na mapie), a serwer strumieniuje do UI
// zdarzenia AssistantEvent. Konfiguracja wyłącznie ze zmiennych środowiskowych:
//
//   ANTHROPIC_API_KEY   klucz Claude API (wymagany; alternatywnie ANTHROPIC_AUTH_TOKEN). Bez niego
//                       status = { available: false }, a POST odpowiada 503 DATA_UNAVAILABLE.
//   CIEN_AI_MODEL       identyfikator modelu (domyślnie DEFAULT_MODEL poniżej).
//   CIEN_AI_EFFORT      low | medium | high | xhigh | max (domyślnie medium) — głębokość namysłu modelu.
//   CIEN_AI_FALLBACKS   „off” wyłącza serwerowy fallback przy odmowie klasyfikatora bezpieczeństwa.

import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { KRAKOW_BBOX } from '../../shared/types.ts';
import type {
  ApiError,
  AssistantContext,
  AssistantEvent,
  AssistantMessage,
  AssistantStatus,
  ComfortMode,
  LatLon,
  MobilityProfile,
} from '../../shared/types.ts';
import { ASSISTANT_SYSTEM_PROMPT, buildContextBlock, sanitizeLabel } from './prompt.ts';
import { executeTool, TOOL_DEFINITIONS, toolLabel } from './tools.ts';

// ───────────────────────── konfiguracja ─────────────────────────

/**
 * Domyślny model: Claude Sonnet 5.5 — tani i szybki; koszt ma tu znaczenie, bo endpoint jest publiczny.
 * Najzdolniejszy jest claude-fable-5-1 (10 USD / 50 USD za milion tokenów wejścia/wyjścia), ale wymaga 30-dniowej retencji danych w organizacji (konta z „zero data retention” dostają
 * błąd 400) i bywa wolniejszy. Inne modele przez CIEN_AI_MODEL:
 *   claude-opus-5-5    4/20 USD — bardzo dobry kompromis jakości i ceny, zalecany przy stałym ruchu,
 *   claude-sonnet-5-5  2/10 USD — szybszy, rozsądny wybór przy dużym ruchu,
 *   claude-haiku-4-5   1/5 USD — najtańszy; bez adaptacyjnego namysłu, słabiej planuje wieloetapowe zapytania.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT: Effort = 'medium';

/** Modele, dla których API przyjmuje serwerowy fallback po odmowie klasyfikatora (fallbacks: "default"). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Najwyżej tyle rund narzędziowych na jedno zapytanie; potem model musi odpowiedzieć bez narzędzi. */
export const MAX_TOOL_ROUNDS = 8;
const MAX_TOOLS_PER_ROUND = 6;
/** Limit tokenów jednej odpowiedzi modelu (obejmuje też namysł); odpowiedzi asystenta są krótkie. */
const MAX_TOKENS = 4096;
const MAX_JSON_RETRIES = 2;

/** Limity danych od klienta. */
export const LIMITS = {
  bodyBytes: 48 * 1024,
  messagesAccepted: 60,
  messagesKept: 24,
  messageChars: 4000,
  totalChars: 24000,
} as const;

export const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 } as const;
const HEARTBEAT_MS = 15000;

type Env = Record<string, string | undefined>;

export interface AssistantConfig {
  available: boolean;
  model: string;
  effort: Effort;
  fallbacks: boolean;
  reason?: string;
}

export function resolveConfig(env: Env = process.env): AssistantConfig {
  const model = env.CIEN_AI_MODEL?.trim() || DEFAULT_MODEL;
  const effortRaw = env.CIEN_AI_EFFORT?.trim().toLowerCase() as Effort | undefined;
  const effort = effortRaw && EFFORTS.includes(effortRaw) ? effortRaw : DEFAULT_EFFORT;
  const fallbacks = FALLBACK_MODELS.has(model) && !/^(off|0|false|no)$/i.test(env.CIEN_AI_FALLBACKS?.trim() ?? '');
  const hasCredentials = Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
  if (!hasCredentials) {
    return {
      available: false,
      model,
      effort,
      fallbacks,
      reason:
        'Asystent AI jest wyłączony: brak klucza Claude API. Ustaw zmienną środowiskową ANTHROPIC_API_KEY ' +
        '(klucz z console.anthropic.com) i uruchom serwer ponownie.',
    };
  }
  return { available: true, model, effort, fallbacks };
}

// ───────────────────────── klient (wstrzykiwalny) ─────────────────────────

type StreamParams = BetaMessageStreamParams;

/** Minimalny wycinek strumienia SDK, którego używa pętla — tyle musi udawać atrapa w testach. */
export interface AssistantStream {
  on(event: 'text', listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

/** Minimalny wycinek klienta Anthropic SDK (client.beta.messages.stream). */
export interface AssistantClient {
  beta: { messages: { stream(params: StreamParams, options?: { signal?: AbortSignal }): AssistantStream } };
}

// ───────────────────────── walidacja zapytania ─────────────────────────

/** Niepoprawne zapytanie do asystenta — komunikat po polsku trafia do klienta jako 400 BAD_REQUEST. */
export class AssistantRequestError extends Error {}

const MOBILITY: readonly MobilityProfile[] = ['default', 'accessible', 'senior'];
const COMFORT: readonly ComfortMode[] = ['shade', 'sun', 'auto'];

function parseContextPoint(raw: unknown, name: string): (LatLon & { label?: string }) | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const point = raw as { lat?: unknown; lon?: unknown; label?: unknown };
  if (
    typeof raw !== 'object' ||
    typeof point.lat !== 'number' ||
    typeof point.lon !== 'number' ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    Math.abs(point.lat) > 90 ||
    Math.abs(point.lon) > 180
  ) {
    throw new AssistantRequestError(`Niepoprawny kontekst: punkt „${name}” wymaga liczbowych pól lat i lon.`);
  }
  const label = sanitizeLabel(point.label);
  return label ? { lat: point.lat, lon: point.lon, label } : { lat: point.lat, lon: point.lon };
}

function parseContext(raw: unknown): AssistantContext | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AssistantRequestError('Niepoprawny kontekst: oczekiwano obiektu.');
  const input = raw as Record<string, unknown>;
  const context: AssistantContext = {};
  const from = parseContextPoint(input.from, 'from');
  const to = parseContextPoint(input.to, 'to');
  const userLocation = parseContextPoint(input.userLocation, 'userLocation');
  if (from !== undefined) context.from = from;
  if (to !== undefined) context.to = to;
  if (userLocation !== undefined) {
    // Pozycja spoza obszaru aplikacji jest bezużyteczna dla „stąd” — traktujemy ją jak nieznaną.
    const inArea =
      userLocation !== null &&
      userLocation.lat >= KRAKOW_BBOX.south &&
      userLocation.lat <= KRAKOW_BBOX.north &&
      userLocation.lon >= KRAKOW_BBOX.west &&
      userLocation.lon <= KRAKOW_BBOX.east;
    context.userLocation = inArea && userLocation ? { lat: userLocation.lat, lon: userLocation.lon } : null;
  }
  if (input.time !== undefined && input.time !== null) {
    if (typeof input.time !== 'string' || input.time.length > 40 || Number.isNaN(new Date(input.time).getTime())) {
      throw new AssistantRequestError('Niepoprawny kontekst: pole „time” musi być datą w formacie ISO 8601.');
    }
    context.time = input.time;
  }
  if (input.shadePreference !== undefined && input.shadePreference !== null) {
    const value = input.shadePreference;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new AssistantRequestError('Niepoprawny kontekst: „shadePreference” musi być liczbą 0–1.');
    }
    context.shadePreference = value;
  }
  if (input.mobility !== undefined && input.mobility !== null) {
    if (!MOBILITY.includes(input.mobility as MobilityProfile)) throw new AssistantRequestError('Niepoprawny kontekst: nieznany profil „mobility”.');
    context.mobility = input.mobility as MobilityProfile;
  }
  if (input.comfort !== undefined && input.comfort !== null) {
    if (!COMFORT.includes(input.comfort as ComfortMode)) throw new AssistantRequestError('Niepoprawny kontekst: nieznany tryb „comfort”.');
    context.comfort = input.comfort as ComfortMode;
  }
  return context;
}

/**
 * Waliduje ciało POST /api/assistant i przycina historię: zostaje najwyżej LIMITS.messagesKept ostatnich
 * wiadomości o łącznej długości do LIMITS.totalChars, zaczynających się od wiadomości użytkownika.
 */
export function parseAssistantRequest(body: unknown): { messages: AssistantMessage[]; context?: AssistantContext } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AssistantRequestError('Niepoprawne zapytanie: oczekiwano obiektu JSON z polem „messages”.');
  }
  const { messages: rawMessages, context: rawContext } = body as { messages?: unknown; context?: unknown };
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new AssistantRequestError('Niepoprawne zapytanie: pole „messages” musi być niepustą listą.');
  }
  if (rawMessages.length > LIMITS.messagesAccepted) {
    throw new AssistantRequestError('Rozmowa jest zbyt długa — zacznij nową rozmowę z asystentem.');
  }
  const parsed: AssistantMessage[] = [];
  for (const raw of rawMessages) {
    const message = raw as { role?: unknown; content?: unknown } | null;
    if (typeof message !== 'object' || message === null || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      throw new AssistantRequestError('Niepoprawne zapytanie: każda wiadomość wymaga pól role („user” lub „assistant”) i content (tekst).');
    }
    if (message.content.length > LIMITS.messageChars) {
      throw new AssistantRequestError(`Wiadomość jest zbyt długa (limit ${LIMITS.messageChars} znaków).`);
    }
    const content = message.content.trim();
    if (!content) {
      if (message.role === 'user') throw new AssistantRequestError('Niepoprawne zapytanie: pusta wiadomość użytkownika.');
      continue; // pusta odpowiedź asystenta (np. przerwana) — pomijamy
    }
    parsed.push({ role: message.role, content });
  }
  if (parsed.length === 0 || parsed[parsed.length - 1].role !== 'user') {
    throw new AssistantRequestError('Niepoprawne zapytanie: ostatnia wiadomość musi pochodzić od użytkownika.');
  }

  let messages = parsed.slice(-LIMITS.messagesKept);
  const total = (list: AssistantMessage[]): number => list.reduce((sum, m) => sum + m.content.length, 0);
  while (messages.length > 1 && (messages[0].role !== 'user' || total(messages) > LIMITS.totalChars)) {
    messages = messages.slice(1);
  }
  const context = parseContext(rawContext);
  return context ? { messages, context } : { messages };
}

// ───────────────────────── limit zapytań ─────────────────────────

export interface RateLimiter {
  /** Rejestruje zapytanie; ok=false, gdy limit w oknie został wyczerpany. */
  hit(key: string): { ok: boolean; retryAfterS: number };
}

/** Prosty limit w pamięci procesu: najwyżej `max` zapytań na klucz (adres IP) w przesuwanym oknie. */
export function createRateLimiter(max: number, windowMs: number, clock: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key) {
      const now = clock();
      if (hits.size > 5000) {
        for (const [k, times] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(k);
      }
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
      }
      recent.push(now);
      hits.set(key, recent);
      return { ok: true, retryAfterS: 0 };
    },
  };
}

// ───────────────────────── błędy SDK → komunikaty ─────────────────────────

const GENERIC_ERROR = 'Asystent napotkał nieoczekiwany błąd. Spróbuj ponownie za chwilę.';

/**
 * Przyjazny komunikat po polsku dla błędu wywołania modelu; null = nic nie pokazujemy (klient sam przerwał).
 * Nigdy nie zawiera treści wyjątku, klucza API ani stosu wywołań.
 */
export function describeAssistantError(err: unknown): string | null {
  if (err instanceof Anthropic.APIUserAbortError) return null;
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Asystent jest błędnie skonfigurowany: klucz API został odrzucony. Administrator powinien sprawdzić ANTHROPIC_API_KEY.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'Klucz API asystenta nie ma dostępu do wybranego modelu. Administrator powinien sprawdzić ustawienia konta lub CIEN_AI_MODEL.';
  }
  if (err instanceof Anthropic.NotFoundError) {
    return 'Wybrany model asystenta nie jest dostępny. Administrator powinien sprawdzić zmienną CIEN_AI_MODEL.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Asystent obsługuje teraz zbyt wiele zapytań. Spróbuj ponownie za minutę.';
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'Usługa AI nie odpowiedziała na czas. Spróbuj ponownie za chwilę.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Nie udało się połączyć z usługą AI. Sprawdź połączenie serwera z internetem i spróbuj ponownie.';
  }
  if (err instanceof Anthropic.APIError) {
    if (err instanceof Anthropic.InternalServerError || err.type === 'overloaded_error' || err.type === 'api_error') {
      return 'Usługa AI jest chwilowo przeciążona. Spróbuj ponownie za chwilę.';
    }
    if (err.type === 'billing_error') {
      return 'Konto usługi AI wymaga uwagi administratora (rozliczenia). Asystent jest chwilowo niedostępny.';
    }
    if (err instanceof Anthropic.BadRequestError) {
      return 'Asystent nie mógł przetworzyć tej rozmowy. Zacznij nową rozmowę i spróbuj ponownie.';
    }
  }
  return GENERIC_ERROR;
}

// ───────────────────────── pętla agenta ─────────────────────────

export interface RunAssistantOptions {
  client: AssistantClient;
  config: Pick<AssistantConfig, 'model' | 'effort'>;
  /** Stan współdzielony między zapytaniami: fallback wyłącza się sam, gdy API odrzuci go błędem 400. */
  fallbacks: { enabled: boolean };
  messages: AssistantMessage[];
  context?: AssistantContext;
  now: Date;
  emit: (event: AssistantEvent) => void;
  signal: AbortSignal;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

function buildParams(opts: RunAssistantOptions, messages: Anthropic.Beta.BetaMessageParam[], contextBlock: string, final: boolean): StreamParams {
  // Haiku 4.5 nie obsługuje adaptacyjnego namysłu ani parametru effort; pozostałe bieżące modele — tak.
  const adaptive = !opts.config.model.includes('haiku');
  return {
    model: opts.config.model,
    max_tokens: MAX_TOKENS,
    // Kolejność renderowania to tools → system → messages: znacznik na stałym bloku systemowym cache'uje
    // narzędzia i prompt dla wszystkich użytkowników; blok z bieżącym kontekstem leży już za nim.
    system: [
      { type: 'text', text: ASSISTANT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: contextBlock },
    ],
    tools: TOOL_DEFINITIONS,
    messages,
    // Automatyczny punkt cache'owania na końcu rozmowy — kolejne rundy pętli czytają poprzednie z cache.
    cache_control: { type: 'ephemeral' },
    ...(adaptive ? { thinking: { type: 'adaptive' as const }, output_config: { effort: opts.config.effort } } : {}),
    ...(opts.fallbacks.enabled ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    ...(final ? { tool_choice: { type: 'none' as const } } : {}),
  };
}

/**
 * Pętla agenta dla jednego zapytania: strumieniuje tekst, wykonuje narzędzia, kończy się odpowiedzią modelu
 * albo po MAX_TOOL_ROUNDS rundach narzędziowych (ostatnie wywołanie modelu ma wtedy wyłączone narzędzia).
 * Emituje zdarzenia text / tool / plan / error — bez 'done' (to robi warstwa HTTP). Błędy SDK rzuca dalej.
 */
export async function runAssistant(opts: RunAssistantOptions): Promise<void> {
  const { client, signal } = opts;
  const messages: Anthropic.Beta.BetaMessageParam[] = opts.messages.map((m) => ({ role: m.role, content: m.content }));
  const contextBlock = buildContextBlock(opts.now, opts.context);

  let emittedText = false;
  let planShown = false;
  const emit = (event: AssistantEvent): void => {
    if (signal.aborted) return;
    if (event.type === 'plan') planShown = true;
    opts.emit(event);
  };
  const closingNote = (): void => {
    if (emittedText) return;
    emit({
      type: 'text',
      delta: planShown ? 'Trasa jest już na mapie.' : 'Nie udało mi się przygotować odpowiedzi — spróbuj zadać pytanie inaczej.',
    });
  };

  let toolRounds = 0;
  let jsonRetries = 0;
  while (!signal.aborted) {
    const final = toolRounds >= MAX_TOOL_ROUNDS;
    let roundText = false;
    const stream = client.beta.messages.stream(buildParams(opts, messages, contextBlock, final), { signal });
    stream.on('text', (delta) => {
      if (!delta) return;
      if (!roundText && emittedText) emit({ type: 'text', delta: '\n\n' });
      roundText = true;
      emittedText = true;
      emit({ type: 'text', delta });
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof Anthropic.BadRequestError && opts.fallbacks.enabled && !roundText) {
        // Nagłówek beta fallbacku bywa niedostępny dla organizacji (400) — wyłączamy go i ponawiamy rundę.
        opts.fallbacks.enabled = false;
        opts.log?.('assistant: fallback wyłączony po błędzie 400');
        continue;
      }
      // Przy eager_input_streaming SDK odrzuca finalMessage(), gdy wejście narzędzia nie jest poprawnym
      // JSON-em; tylko ten przypadek ponawiamy — błędy API idą dalej.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= MAX_JSON_RETRIES) throw err;
      continue;
    }
    opts.log?.('assistant: runda', {
      stop: message.stop_reason,
      in: message.usage?.input_tokens,
      cacheRead: message.usage?.cache_read_input_tokens,
      cacheWrite: message.usage?.cache_creation_input_tokens,
      out: message.usage?.output_tokens,
    });

    // Odmowa może uciąć tool_use w połowie — narzędzi z takiej tury nie wolno wykonywać.
    if (message.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'Nie mogę pomóc w tej prośbie. Zapytaj o trasę, cień, pogodę albo wodę po drodze w Krakowie.' });
      return;
    }
    const toolUses = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
    if (toolUses.length === 0) {
      if (message.stop_reason === 'max_tokens' && emittedText) {
        emit({ type: 'text', delta: '\n\n_(Odpowiedź została skrócona.)_' });
      }
      closingNote();
      return;
    }
    // Wejście narzędzia ucięte limitem tokenów zwykle parsuje się jako poprawny, ale niepełny obiekt.
    if (message.stop_reason === 'max_tokens') {
      emit({ type: 'error', message: 'Asystent nie zmieścił się w limicie odpowiedzi. Spróbuj zadać prostsze pytanie.' });
      return;
    }
    if (final) {
      closingNote();
      return;
    }

    messages.push({ role: 'assistant', content: message.content });
    const results = await Promise.all(
      toolUses.map(async (toolUse, index): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        if (index >= MAX_TOOLS_PER_ROUND) {
          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Za dużo wywołań w jednym kroku (limit ${MAX_TOOLS_PER_ROUND}). Powtórz to wywołanie w następnym kroku.`,
            is_error: true,
          };
        }
        emit({ type: 'tool', name: toolUse.name, label: toolLabel(toolUse.name, toolUse.input) });
        const outcome = await executeTool(toolUse.name, toolUse.input, {
          now: opts.now,
          emit,
          context: opts.context,
          onInternalError: (tool, error) => opts.log?.('assistant: błąd narzędzia', { tool, error: error instanceof Error ? error.name : typeof error }),
        });
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        };
      }),
    );
    toolRounds++;
    const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
    if (toolRounds >= MAX_TOOL_ROUNDS) {
      content.push({
        type: 'text',
        text: 'Limit kroków narzędziowych został wyczerpany. Odpowiedz teraz użytkownikowi na podstawie zebranych danych, bez kolejnych wywołań.',
      });
    }
    messages.push({ role: 'user', content });
  }
}

// ───────────────────────── HTTP ─────────────────────────

export interface AssistantDeps {
  /** Zmienne środowiskowe (domyślnie process.env). */
  env?: Env;
  /** Fabryka klienta (domyślnie `new Anthropic()` — dane dostępowe z otoczenia). W testach: atrapa. */
  createClient?: () => AssistantClient;
  now?: () => Date;
  rateLimit?: { max: number; windowMs: number };
}

function sendApiError(reply: FastifyReply, status: number, code: ApiError['code'], message: string): FastifyReply {
  const body: ApiError = { error: message, code };
  return reply.code(status).send(body);
}

/** GET /api/assistant/status, POST /api/assistant (SSE z AssistantEvent). */
export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantDeps = {}): void {
  const env = deps.env ?? process.env;
  const limits = deps.rateLimit ?? RATE_LIMIT;
  const limiter = createRateLimiter(limits.max, limits.windowMs);
  const fallbacks = { enabled: resolveConfig(env).fallbacks };
  let client: AssistantClient | null = null;
  const getClient = (): AssistantClient => (client ??= deps.createClient ? deps.createClient() : new Anthropic());

  app.get('/api/assistant/status', async (): Promise<AssistantStatus> => {
    const config = resolveConfig(env);
    return config.available ? { available: true, model: config.model } : { available: false, reason: config.reason };
  });

  app.post(
    '/api/assistant',
    {
      bodyLimit: LIMITS.bodyBytes,
      // Błędy parsowania ciała (za duże, niepoprawny JSON) → 400 w formacie ApiError, niezależnie od handlera aplikacji.
      errorHandler: (error, _request, reply) => {
        const status = (error as { statusCode?: number }).statusCode ?? 500;
        if (status >= 400 && status < 500) {
          const tooLarge = status === 413;
          return sendApiError(
            reply,
            400,
            'BAD_REQUEST',
            tooLarge ? 'Zapytanie jest zbyt duże — skróć wiadomość albo zacznij nową rozmowę.' : 'Niepoprawne zapytanie: oczekiwano poprawnego JSON-u.',
          );
        }
        return sendApiError(reply, 500, 'INTERNAL', GENERIC_ERROR);
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const config = resolveConfig(env);
      if (!config.available) return sendApiError(reply, 503, 'DATA_UNAVAILABLE', config.reason ?? 'Asystent AI jest niedostępny.');

      let parsed: ReturnType<typeof parseAssistantRequest>;
      try {
        parsed = parseAssistantRequest(request.body);
      } catch (err) {
        if (err instanceof AssistantRequestError) return sendApiError(reply, 400, 'BAD_REQUEST', err.message);
        throw err;
      }

      const limit = limiter.hit(request.ip);
      if (!limit.ok) {
        reply.header('Retry-After', String(limit.retryAfterS));
        const minutes = Math.ceil(limit.retryAfterS / 60);
        return sendApiError(reply, 429, 'DATA_UNAVAILABLE', `Zbyt wiele pytań do asystenta. Spróbuj ponownie za ok. ${minutes} min.`);
      }

      // Od tego miejsca odpowiedź jest strumieniem SSE pisanym wprost do gniazda (poza cyklem Fastify).
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // wyłącza buforowanie w nginx
      });
      raw.flushHeaders?.();

      const controller = new AbortController();
      const open = (): boolean => !raw.writableEnded && !raw.destroyed;
      const send = (event: AssistantEvent): void => {
        if (open()) raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      // Klient zamknął połączenie przed końcem → przerywamy zapytanie do modelu.
      raw.on('close', () => {
        if (!raw.writableEnded) controller.abort();
      });
      // Komentarze SSE podtrzymują połączenie, gdy narzędzie liczy długo (np. pobieranie kafli mapy).
      const heartbeat = setInterval(() => {
        if (open()) raw.write(': ping\n\n');
      }, HEARTBEAT_MS);

      try {
        await runAssistant({
          client: getClient(),
          config,
          fallbacks,
          messages: parsed.messages,
          context: parsed.context,
          now: deps.now ? deps.now() : new Date(),
          emit: send,
          signal: controller.signal,
          log: (message, detail) => request.log.info(detail ?? {}, message),
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          const message = describeAssistantError(err);
          // Do logu trafia tylko rodzaj błędu — bez treści, nagłówków i stosu.
          const status = err instanceof Anthropic.APIError ? err.status : undefined;
          request.log.warn({ name: err instanceof Error ? err.name : typeof err, status }, 'assistant: błąd zapytania do modelu');
          if (message) send({ type: 'error', message });
        }
      } finally {
        clearInterval(heartbeat);
        send({ type: 'done' });
        if (open()) raw.end();
      }
    },
  );
}
