// „Asystent Canopy”: endpointy GET /api/assistant/status i POST /api/assistant (Server-Sent Events).
//
// Asystent to pętla agenta na Gemini API (Google): model planuje narzędziami z tools.ts (geokodowanie,
// trasa, najlepsza godzina, pogoda, sterowanie aplikacją: mapa, nawigacja, warstwy), a serwer strumieniuje do UI
// zdarzenia AssistantEvent. Konfiguracja wyłącznie ze zmiennych środowiskowych (skrypty npm wczytują
// plik .env z katalogu projektu):
//
//   GEMINI_API_KEY   klucz Gemini API z aistudio.google.com (wymagany; alternatywnie GOOGLE_API_KEY).
//                    Bez niego status = { available: false }, a POST odpowiada 503 DATA_UNAVAILABLE.
//   CIEN_AI_MODEL    identyfikator modelu (domyślnie DEFAULT_MODEL poniżej).
//
// Używamy oficjalnego SDK @google/genai i metody generateContentStream (bezstanowej: cała historia idzie
// w każdym zapytaniu). Dokumentacja poleca dla nowych projektów nowsze Interactions API, ale generateContent
// „remains fully supported” (https://ai.google.dev/gemini-api/docs/interactions, sprawdzone 2026-10-04).

import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import type { Content, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
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
 * Domyślny model: Gemini 3.5 Flash-Lite — najtańszy bieżący model bez zapowiedzianej daty wyłączenia, który
 * obsługuje wywoływanie funkcji. Wybór na podstawie (sprawdzone 2026-10-04):
 *   https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite — status Stable, „Function calling: Supported”,
 *   https://ai.google.dev/gemini-api/docs/pricing       — 0,30 / 2,50 USD za milion tokenów wejścia/wyjścia
 *                                                         (gemini-3.8-flash: 0,75 / 3,75 do 31.12.2026, potem drożej);
 *                                                         jest darmowy poziom,
 *   https://ai.google.dev/gemini-api/docs/deprecations  — brak daty wyłączenia.
 * Modele „lite” słabiej planują wieloetapowe zapytania, dlatego prompt (prompt.ts) podaje gotowe przepisy kroków.
 * Inne opcje przez CIEN_AI_MODEL:
 *   gemini-3.8-flash       — mocniejszy i droższy (lepsze planowanie z narzędziami),
 *   gemini-3.1-flash-lite  — jeszcze tańszy (0,25 / 1,50 USD), ale z datą wyłączenia 7.05.2027,
 *   gemini-2.5-flash-lite  — najtańszy w cenniku (0,10 / 0,40 USD), starsza generacja; wg strony wycofań modele 2.5
 *                            są dostępne dla kont z wcześniejszym użyciem, więc nie nadaje się na wartość domyślną.
 */
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/** Najwyżej tyle rund narzędziowych na jedno zapytanie; potem model musi odpowiedzieć bez narzędzi. */
export const MAX_TOOL_ROUNDS = 8;
const MAX_TOOLS_PER_ROUND = 6;
/** Limit tokenów jednej odpowiedzi modelu (obejmuje też namysł); odpowiedzi asystenta są krótkie. */
export const MAX_OUTPUT_TOKENS = 4096;
/** Tyle razy ponawiamy rundę, w której model wygenerował niepoprawne wywołanie funkcji. */
const MAX_MALFORMED_RETRIES = 2;

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
  reason?: string;
}

/** Klucz Gemini API z otoczenia: GEMINI_API_KEY, a gdy go nie ma — GOOGLE_API_KEY. */
function apiKeyFrom(env: Env): string | undefined {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined;
}

export function resolveConfig(env: Env = process.env): AssistantConfig {
  const model = env.CIEN_AI_MODEL?.trim() || DEFAULT_MODEL;
  if (!apiKeyFrom(env)) {
    return {
      available: false,
      model,
      reason:
        'Asystent AI jest wyłączony: brak klucza Gemini API. Wpisz GEMINI_API_KEY=… (klucz z aistudio.google.com) ' +
        'do pliku .env w katalogu projektu i uruchom serwer ponownie.',
    };
  }
  return { available: true, model };
}

// ───────────────────────── klient (wstrzykiwalny) ─────────────────────────

/** Fragment strumienia odpowiedzi, którego używa pętla — tyle musi udawać atrapa w testach. */
export type AssistantChunk = Pick<GenerateContentResponse, 'candidates' | 'promptFeedback' | 'usageMetadata'>;

/** Minimalny wycinek klienta @google/genai (ai.models.generateContentStream). */
export interface AssistantClient {
  models: { generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<AssistantChunk>> };
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

// ───────────────────────── błędy API → komunikaty ─────────────────────────

const GENERIC_ERROR = 'Asystent napotkał nieoczekiwany błąd. Spróbuj ponownie za chwilę.';
const REFUSAL_MESSAGE = 'Nie mogę pomóc w tej prośbie. Zapytaj o trasę, cień albo pogodę w Krakowie.';

/** Kod HTTP błędu API (ApiError z @google/genai ma pole `status`); undefined dla błędów sieci i innych. */
function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * Przyjazny komunikat po polsku dla błędu wywołania modelu; null = nic nie pokazujemy (klient sam przerwał).
 * Nigdy nie zawiera treści wyjątku, klucza API ani stosu wywołań.
 */
export function describeAssistantError(err: unknown): string | null {
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : '';
  if (name === 'AbortError') return null;
  const status = httpStatusOf(err);
  if (status !== undefined) {
    // Gemini API odrzuca zły klucz kodem 400 („API key not valid”), nie 401 — rozpoznajemy oba przypadki.
    if (status === 401 || (status === 400 && /api[ _]key/i.test(text))) {
      return 'Asystent jest błędnie skonfigurowany: klucz API został odrzucony. Administrator powinien sprawdzić GEMINI_API_KEY w pliku .env.';
    }
    if (status === 403) {
      return 'Klucz API asystenta nie ma dostępu do usługi lub wybranego modelu. Administrator powinien sprawdzić GEMINI_API_KEY i CIEN_AI_MODEL.';
    }
    if (status === 404) {
      return 'Wybrany model asystenta nie jest dostępny. Administrator powinien sprawdzić zmienną CIEN_AI_MODEL.';
    }
    if (status === 429) {
      return 'Limit zapytań do usługi AI został wyczerpany. Spróbuj ponownie za minutę.';
    }
    if (status >= 500) {
      return 'Usługa AI jest chwilowo przeciążona. Spróbuj ponownie za chwilę.';
    }
    if (status === 400) {
      return 'Asystent nie mógł przetworzyć tej rozmowy. Zacznij nową rozmowę i spróbuj ponownie.';
    }
    return GENERIC_ERROR;
  }
  if (name === 'TimeoutError' || /timed? ?out/i.test(text)) {
    return 'Usługa AI nie odpowiedziała na czas. Spróbuj ponownie za chwilę.';
  }
  // Błąd sieci z fetch() to TypeError („fetch failed”).
  if (err instanceof TypeError || /fetch failed|ECONNRE|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return 'Nie udało się połączyć z usługą AI. Sprawdź połączenie serwera z internetem i spróbuj ponownie.';
  }
  return GENERIC_ERROR;
}

// ───────────────────────── pętla agenta ─────────────────────────

export interface RunAssistantOptions {
  client: AssistantClient;
  config: Pick<AssistantConfig, 'model'>;
  messages: AssistantMessage[];
  context?: AssistantContext;
  now: Date;
  emit: (event: AssistantEvent) => void;
  signal: AbortSignal;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Deklaracje funkcji dla Gemini; schemat narzędzia to zwykły JSON Schema, więc idzie polem parametersJsonSchema. */
const FUNCTION_DECLARATIONS = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parametersJsonSchema: tool.parameters,
}));

/** Powody zakończenia oznaczające blokadę treści przez filtry — narzędzi z takiej tury nie wolno wykonywać. */
const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);
const MALFORMED_FINISH = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']);

function buildParams(opts: RunAssistantOptions, contents: Content[], contextBlock: string, final: boolean): GenerateContentParameters {
  return {
    model: opts.config.model,
    contents,
    config: {
      // Stały prompt na początku (wspólny prefiks dla wszystkich zapytań), bieżący kontekst za nim.
      systemInstruction: `${ASSISTANT_SYSTEM_PROMPT}\n\n${contextBlock}`,
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      // AUTO: model sam wybiera tekst albo wywołania funkcji; NONE w ostatniej rundzie wymusza odpowiedź tekstową.
      toolConfig: { functionCallingConfig: { mode: final ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO } },
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: opts.signal,
    },
  };
}

/** Wynik narzędzia w kształcie functionResponse.response: klucz „output” dla wyniku, „error” dla błędu. */
function toolResponseBody(outcome: { content: string; isError?: boolean }): Record<string, unknown> {
  if (outcome.isError) return { error: outcome.content };
  try {
    return { output: JSON.parse(outcome.content) as unknown };
  } catch {
    return { output: outcome.content };
  }
}

/**
 * Pętla agenta dla jednego zapytania: strumieniuje tekst, wykonuje narzędzia, kończy się odpowiedzią modelu
 * albo po MAX_TOOL_ROUNDS rundach narzędziowych (ostatnie wywołanie modelu ma wtedy wyłączone narzędzia).
 * Emituje zdarzenia text / tool / plan / error — bez 'done' (to robi warstwa HTTP). Błędy API rzuca dalej.
 */
export async function runAssistant(opts: RunAssistantOptions): Promise<void> {
  const { client, signal } = opts;
  const contents: Content[] = opts.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
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
      delta: planShown ? 'Gotowe.' :'Nie udało mi się przygotować odpowiedzi — spróbuj zadać pytanie inaczej.',
    });
  };

  let toolRounds = 0;
  let malformedRetries = 0;
  while (!signal.aborted) {
    const final = toolRounds >= MAX_TOOL_ROUNDS;
    let roundText = false;
    // Części odpowiedzi modelu zachowujemy DOSŁOWNIE (razem z polami thoughtSignature) i odsyłamy w historii
    // kolejnej rundy — modele Gemini 3 wymagają zwrotu sygnatur namysłu przy wywoływaniu funkcji
    // (https://ai.google.dev/gemini-api/docs/thinking#signatures).
    const modelParts: Part[] = [];
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    let usage: AssistantChunk['usageMetadata'];
    try {
      const stream = await client.models.generateContentStream(buildParams(opts, contents, contextBlock, final));
      for await (const chunk of stream) {
        if (signal.aborted) return;
        if (chunk.promptFeedback?.blockReason) blockReason = String(chunk.promptFeedback.blockReason);
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        if (candidate.finishReason) finishReason = String(candidate.finishReason);
        for (const part of candidate.content?.parts ?? []) {
          const hasText = typeof part.text === 'string' && part.text.length > 0;
          // Pusta część bez sygnatury i bez wywołania nic nie wnosi; z sygnaturą — musi wrócić do modelu.
          if (!hasText && !part.functionCall && !part.thoughtSignature) continue;
          modelParts.push(part);
          if (!hasText || part.thought) continue; // streszczenia namysłu nie są odpowiedzią dla użytkownika
          if (!roundText && emittedText) emit({ type: 'text', delta: '\n\n' });
          roundText = true;
          emittedText = true;
          emit({ type: 'text', delta: part.text as string });
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    if (signal.aborted) return;
    opts.log?.('assistant: runda', {
      finish: finishReason,
      in: usage?.promptTokenCount,
      cached: usage?.cachedContentTokenCount,
      out: usage?.candidatesTokenCount,
      thoughts: usage?.thoughtsTokenCount,
    });

    // Blokada promptu albo odpowiedzi przez filtry bezpieczeństwa: kończymy komunikatem, bez narzędzi.
    if (blockReason || (finishReason && BLOCKED_FINISH.has(finishReason))) {
      emit({ type: 'error', message: REFUSAL_MESSAGE });
      return;
    }
    if (finishReason && MALFORMED_FINISH.has(finishReason)) {
      if (!roundText && malformedRetries++ < MAX_MALFORMED_RETRIES) continue;
      if (final) {
        closingNote();
        return;
      }
      emit({ type: 'error', message: 'Asystent nie zdołał poprawnie użyć narzędzi aplikacji. Spróbuj zadać pytanie inaczej.' });
      return;
    }
    malformedRetries = 0;

    const calls = modelParts.flatMap((part) => (part.functionCall?.name ? [part.functionCall] : []));
    if (calls.length === 0) {
      if (finishReason === 'MAX_TOKENS' && emittedText) {
        emit({ type: 'text', delta: '\n\n(Odpowiedź została skrócona.)' });
      } else if (!emittedText && !planShown) {
        // Pusta odpowiedź (brak kandydatów albo sam namysł ucięty limitem tokenów).
        emit({ type: 'error', message: 'Usługa AI nie zwróciła odpowiedzi. Spróbuj ponownie albo zadaj pytanie inaczej.' });
        return;
      }
      closingNote();
      return;
    }
    // Argumenty wywołania ucięte limitem tokenów mogą być niepełne — nie wykonujemy takiej tury.
    if (finishReason === 'MAX_TOKENS') {
      emit({ type: 'error', message: 'Asystent nie zmieścił się w limicie odpowiedzi. Spróbuj zadać prostsze pytanie.' });
      return;
    }
    if (final) {
      closingNote();
      return;
    }

    contents.push({ role: 'model', parts: modelParts });
    // Wyniki wracają w JEDNEJ turze użytkownika, w kolejności wywołań; id (gdy model je nadał) łączy wynik z wywołaniem.
    const results = await Promise.all(
      calls.map(async (call, index): Promise<Part> => {
        const name = call.name as string;
        const ident = call.id ? { id: call.id } : {};
        if (index >= MAX_TOOLS_PER_ROUND) {
          return {
            functionResponse: {
              ...ident,
              name,
              response: { error: `Za dużo wywołań w jednym kroku (limit ${MAX_TOOLS_PER_ROUND}). Powtórz to wywołanie w następnym kroku.` },
            },
          };
        }
        const input = call.args ?? {};
        emit({ type: 'tool', name, label: toolLabel(name, input) });
        const outcome = await executeTool(name, input, {
          now: opts.now,
          emit,
          context: opts.context,
          onInternalError: (tool, error) => opts.log?.('assistant: błąd narzędzia', { tool, error: error instanceof Error ? error.name : typeof error }),
        });
        return { functionResponse: { ...ident, name, response: toolResponseBody(outcome) } };
      }),
    );
    toolRounds++;
    const parts: Part[] = [...results];
    if (toolRounds >= MAX_TOOL_ROUNDS) {
      parts.push({
        text: 'Limit kroków narzędziowych został wyczerpany. Odpowiedz teraz użytkownikowi na podstawie zebranych danych, bez kolejnych wywołań.',
      });
    }
    contents.push({ role: 'user', parts });
  }
}

// ───────────────────────── HTTP ─────────────────────────

export interface AssistantDeps {
  /** Zmienne środowiskowe (domyślnie process.env). */
  env?: Env;
  /** Fabryka klienta (domyślnie GoogleGenAI z kluczem z otoczenia). W testach: atrapa. */
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
  let client: AssistantClient | null = null;
  const getClient = (): AssistantClient => (client ??= deps.createClient ? deps.createClient() : new GoogleGenAI({ apiKey: apiKeyFrom(env) }));

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
          const status = httpStatusOf(err);
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
