// Asystent AI po stronie frontendu: bezpieczny Markdown, historia i kontekst rozmowy, opis planu, strumień SSE,
// a także zapis ostatniej trasy do pracy offline.

import { describe, expect, it } from 'vitest';
import type { AssistantEvent, RouteResponse, RouteResult } from '../shared/types.ts';
import {
  EXPLAIN_QUESTION,
  MESSAGE_CHAR_LIMIT,
  PLAN_ONLY_PLACEHOLDER,
  buildContext,
  buildRequestMessages,
  describePlan,
  explainPrompt,
  routeBrief,
  suggestions,
  type ChatMessage,
} from '../web/src/assistant/chat.ts';
import { parseInline, parseMarkdown, safeHref } from '../web/src/assistant/markdown.ts';
import { offlineBannerText } from '../web/src/features/pwa.ts';
import {
  LAST_ROUTE_KEY,
  cachedRouteFor,
  loadLastRoute,
  parseSavedRoute,
  saveLastRoute,
  toSavedRoute,
} from '../web/src/offlineRoute.ts';
import { createSseParser } from '../web/src/sse.ts';

describe('markdown: składnia w linii', () => {
  it('rozpoznaje pogrubienie, kursywę i kod', () => {
    expect(parseInline('Idź **lewą stroną** ulicy, *powoli*, `kod`.')).toEqual([
      { t: 'text', v: 'Idź ' },
      { t: 'bold', c: [{ t: 'text', v: 'lewą stroną' }] },
      { t: 'text', v: ' ulicy, ' },
      { t: 'em', c: [{ t: 'text', v: 'powoli' }] },
      { t: 'text', v: ', ' },
      { t: 'code', v: 'kod' },
      { t: 'text', v: '.' },
    ]);
  });

  it('obsługuje zagnieżdżenie i podkreślniki', () => {
    expect(parseInline('**ważne _bardzo_**')).toEqual([
      { t: 'bold', c: [{ t: 'text', v: 'ważne ' }, { t: 'em', c: [{ t: 'text', v: 'bardzo' }] }] },
    ]);
    expect(parseInline('_(Odpowiedź została skrócona.)_')).toEqual([{ t: 'em', c: [{ t: 'text', v: '(Odpowiedź została skrócona.)' }] }]);
  });

  it('zostawia niedomknięte znaczniki i znaki w środku słów jako tekst', () => {
    expect(parseInline('**Waw')).toEqual([{ t: 'text', v: '**Waw' }]);
    expect(parseInline('plik_z_nazwa i 2 * 3 * 4')).toEqual([{ t: 'text', v: 'plik_z_nazwa i 2 * 3 * 4' }]);
    expect(parseInline('`niedomknięty')).toEqual([{ t: 'text', v: '`niedomknięty' }]);
  });

  it('traktuje HTML jak zwykły tekst', () => {
    expect(parseInline('<img src=x onerror=alert(1)> <b>x</b>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)> <b>x</b>' }]);
  });

  it('dopuszcza odnośniki tylko http(s)', () => {
    expect(parseInline('[mapa](https://example.org/a?b=1)')).toEqual([
      { t: 'link', href: 'https://example.org/a?b=1', c: [{ t: 'text', v: 'mapa' }] },
    ]);
    expect(parseInline('[kliknij](javascript:alert(1))')[0]).toEqual({ t: 'text', v: 'kliknij)' });
    expect(parseInline('[x](data:text/html,abc)')).toEqual([{ t: 'text', v: 'x' }]);
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' HTTPS://krakow.pl ')).toBe('HTTPS://krakow.pl');
    expect(safeHref('https://a.b/"onmouseover="x')).toBeNull();
  });
});

describe('markdown: bloki', () => {
  it('dzieli tekst na akapity z łamaniem linii', () => {
    expect(parseMarkdown('Pierwsza linia\ndruga linia\n\nNowy akapit')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'Pierwsza linia' }, { t: 'br' }, { t: 'text', v: 'druga linia' }] },
      { t: 'p', c: [{ t: 'text', v: 'Nowy akapit' }] },
    ]);
  });

  it('rozpoznaje listy punktowane i numerowane', () => {
    const blocks = parseMarkdown('Plan:\n- **Start**: Rynek\n- Cel: Wawel\n\n1. Wyjdź o 18:30\n2. Idź Plantami');
    expect(blocks.map((block) => block.t)).toEqual(['p', 'ul', 'ol']);
    expect(blocks[1]).toMatchObject({ t: 'ul', items: [[{ t: 'bold' }, { t: 'text', v: ': Rynek' }], [{ t: 'text', v: 'Cel: Wawel' }]] });
    expect(blocks[2]).toMatchObject({ t: 'ol', start: 1 });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('zachowuje numer początkowy listy i ciąg dalszy punktu', () => {
    const blocks = parseMarkdown('3) trzeci\n   dalszy ciąg\n4) czwarty');
    expect(blocks).toEqual([
      {
        t: 'ol',
        start: 3,
        items: [[{ t: 'text', v: 'trzeci' }, { t: 'br' }, { t: 'text', v: 'dalszy ciąg' }], [{ t: 'text', v: 'czwarty' }]],
      },
    ]);
  });

  it('nagłówki stają się wyróżnionym akapitem, a CRLF nie psuje podziału', () => {
    expect(parseMarkdown('## Trasa\r\n\r\nOpis')).toEqual([
      { t: 'h', c: [{ t: 'text', v: 'Trasa' }] },
      { t: 'p', c: [{ t: 'text', v: 'Opis' }] },
    ]);
  });

  it('pusty tekst i godzina na początku linii nie tworzą listy', () => {
    expect(parseMarkdown('  \n\n')).toEqual([]);
    expect(parseMarkdown('18:30 to dobra pora')).toEqual([{ t: 'p', c: [{ t: 'text', v: '18:30 to dobra pora' }] }]);
  });
});

function message(role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: Math.random(), role, text, tools: [], plans: [], status: 'done', ...extra };
}

describe('historia rozmowy wysyłana do serwera', () => {
  it('wysyła treść dla serwera zamiast pokazywanej i pomija puste odpowiedzi', () => {
    const history = [
      message('user', 'Wyjaśnij tę trasę', { apiText: 'Wyjaśnij tę trasę: …dane…' }),
      message('assistant', '', { status: 'error', error: 'Błąd' }),
      message('user', 'Jeszcze raz'),
    ];
    expect(buildRequestMessages(history)).toEqual([{ role: 'user', content: 'Wyjaśnij tę trasę: …dane…\n\nJeszcze raz' }]);
  });

  it('odpowiedź złożona z samego planu dostaje treść zastępczą', () => {
    const history = [
      message('user', 'Zaplanuj'),
      message('assistant', '', { plans: [{ selectProfile: 'shadiest' }] }),
      message('user', 'Dzięki, a woda?'),
    ];
    expect(buildRequestMessages(history)).toEqual([
      { role: 'user', content: 'Zaplanuj' },
      { role: 'assistant', content: PLAN_ONLY_PLACEHOLDER },
      { role: 'user', content: 'Dzięki, a woda?' },
    ]);
  });

  it('przycina do ostatnich N wiadomości i zaczyna od użytkownika', () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(message('user', `pytanie ${i}`), message('assistant', `odpowiedź ${i}`));
    }
    history.push(message('user', 'ostatnie'));
    const sent = buildRequestMessages(history, 6);
    // Ostatnie 6 zaczynałoby się od odpowiedzi asystenta — zostaje 5, od pytania.
    expect(sent).toHaveLength(5);
    expect(sent[0]).toEqual({ role: 'user', content: 'pytanie 8' });
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'ostatnie' });
  });

  it('pomija odpowiedź w trakcie strumieniowania i ogranicza długość wiadomości', () => {
    const sent = buildRequestMessages([message('user', 'x'.repeat(5000)), message('assistant', 'pół odpo', { status: 'streaming' })]);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toHaveLength(MESSAGE_CHAR_LIMIT);
  });

  it('zatrzymana odpowiedź z tekstem zostaje w historii', () => {
    const sent = buildRequestMessages([message('user', 'a'), message('assistant', 'częściowa', { status: 'stopped' }), message('user', 'b')]);
    expect(sent.map((item) => item.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('kontekst, podpowiedzi i opis planu', () => {
  const from = { lat: 50.0614, lon: 19.9372, label: 'Rynek Główny' };
  const to = { lat: 50.054, lon: 19.9354, label: 'Wawel' };

  it('buduje kontekst z bieżącego stanu, z pozycją GPS', () => {
    expect(
      buildContext({
        from,
        to: null,
        date: '2026-07-15',
        minutes: 13 * 60,
        shadePreference: 0.7,
        mobility: 'senior',
        comfort: 'auto',
        userLocation: { lat: 50.06, lon: 19.94 },
      }),
    ).toEqual({
      from,
      to: null,
      time: '2026-07-15T13:00:00+02:00',
      shadePreference: 0.7,
      mobility: 'senior',
      comfort: 'auto',
      userLocation: { lat: 50.06, lon: 19.94 },
    });
  });

  it('podpowiedzi korzystają z wybranych punktów i trybu', () => {
    const withRoute = suggestions({ from, to }, true, 'shade');
    expect(withRoute[0].prompt).toBe('Zaplanuj spacer w cieniu z: Rynek Główny do: Wawel');
    expect(withRoute.map((item) => item.label)).toContain(EXPLAIN_QUESTION);
    const empty = suggestions({ from: null, to: null }, false, 'sun');
    expect(empty[0].label).toBe('Zaplanuj spacer w słońcu z Rynku Głównego na Wawel');
    expect(empty.map((item) => item.label)).not.toContain(EXPLAIN_QUESTION);
    expect(empty.map((item) => item.label)).toEqual(expect.arrayContaining(['Kiedy najlepiej wyjść?', 'Gdzie po drodze napiję się wody?']));
  });

  it('opisuje zastosowany plan po polsku', () => {
    expect(
      describePlan({
        from,
        to,
        time: '2026-07-15T18:30:00+02:00',
        mobility: 'accessible',
        comfort: 'shade',
        viaCoolSpot: true,
        selectProfile: 'shadiest',
      }),
    ).toEqual([
      'Rynek Główny → Wawel',
      'wyjście środa, 15 lipca, 18:30',
      'profil: wózek / bez schodów',
      'tryb: szukaj cienia',
      'przez punkt chłodu',
      'wariant najbardziej zacieniony',
    ]);
    expect(describePlan({ to })).toEqual(['cel: Wawel']);
    expect(describePlan({ time: 'bzdura' })).toEqual([]);
    expect(describePlan({ shadePreference: 1, comfort: 'sun' })).toEqual(['tryb: szukaj słońca', 'preferencja: maksimum słońca']);
  });

  const route: RouteResult = {
    profile: 'balanced',
    label: 'Zbalansowana',
    distanceM: 1440,
    durationS: 1170,
    sunDistanceM: 550,
    shadeFraction: 0.62,
    meanLstC: 36,
    geometry: [
      [19.93, 50.06],
      [19.94, 50.06],
    ],
    segments: [],
    steps: [
      { maneuver: 'depart', text: 'Ruszaj na wschód — ul. Karmelicka. Idź 240 m.', distanceM: 240, geometryIndex: 0, location: [19.93, 50.06], sunFraction: 0.2 },
      { maneuver: 'arrive', text: 'Jesteś u celu.', distanceM: 0, geometryIndex: 1, location: [19.94, 50.06], sunFraction: 0 },
    ],
    waitS: 60,
    signalCrossings: 2,
    stairsCount: 0,
    thermal: { feltSunC: 36, feltShadeC: 29, feltMeanC: 31, stress: 'moderate' },
    coolSpots: [{ id: 'n1', kind: 'drinking_water', lat: 50.06, lon: 19.93, name: 'Zdrój' }],
    via: { id: 'n3', kind: 'fountain', lat: 50.06, lon: 19.935, name: 'Fontanna na Plantach' },
  };

  it('do pytania „Wyjaśnij tę trasę” dołącza dane wybranej trasy', () => {
    const brief = routeBrief(route, 'shade');
    expect(brief).toContain('Dystans 1,4 km, czas 20 min, w cieniu 62% trasy');
    expect(brief).toContain('Przejścia ze światłami: 2');
    expect(brief).toContain('Schody: brak.');
    expect(brief).toContain('przez punkt chłodu: Fontanna na Plantach');
    expect(brief).toContain('1. Ruszaj na wschód — ul. Karmelicka. Idź 240 m.');
    const prompt = explainPrompt(route, 'shade');
    expect(prompt.startsWith(EXPLAIN_QUESTION)).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(MESSAGE_CHAR_LIMIT);
  });
});

describe('strumień SSE asystenta', () => {
  function collect(chunks: string[]): AssistantEvent[] {
    const events: AssistantEvent[] = [];
    const parser = createSseParser<AssistantEvent>((event) => events.push(event));
    for (const chunk of chunks) parser.feed(chunk);
    parser.flush();
    return events;
  }

  const stream =
    ': ping\n\n' +
    'data: {"type":"tool","name":"geocode","label":"Szukam: Wawel…"}\n\n' +
    'data: {"type":"text","delta":"Idź **Plantami**"}\n\n' +
    'data: {"type":"plan","plan":{"to":{"lat":50.054,"lon":19.9354,"label":"Wawel"},"selectProfile":"shadiest"}}\n\n' +
    'data: {"type":"done"}\n\n';

  it('daje te same zdarzenia niezależnie od miejsca cięcia strumienia', () => {
    const whole = collect([stream]);
    expect(whole.map((event) => event.type)).toEqual(['tool', 'text', 'plan', 'done']);
    for (const size of [1, 2, 3, 7, 16, 61]) {
      const chunks: string[] = [];
      for (let i = 0; i < stream.length; i += size) chunks.push(stream.slice(i, i + size));
      expect(collect(chunks)).toEqual(whole);
    }
  });

  it('obsługuje CRLF przecięte między fragmentami, dane wieloliniowe i znacznik [DONE]', () => {
    const events = collect([
      'data: {"type":"text",\r',
      '\ndata: "delta":"a\\nb"}\r\n\r',
      '\ndata: [DONE]\r\n\r\n',
      'event: message\ndata:{"type":"done"}',
    ]);
    expect(events).toEqual([{ type: 'text', delta: 'a\nb' }, { type: 'done' }]);
  });
});

describe('ostatnia trasa offline', () => {
  const from = { lat: 50.0614, lon: 19.9372, label: 'Rynek Główny' };
  const to = { lat: 50.054, lon: 19.9354, label: 'Wawel' };
  const response = {
    routes: [
      { profile: 'shortest', distanceM: 900, geometry: [], segments: [] },
      { profile: 'balanced', distanceM: 1000, geometry: [], segments: [] },
    ],
    sun: { azimuthDeg: 180, altitudeDeg: 50, sunrise: null, sunset: null, isDay: true },
    weather: null,
    sunFactor: 1,
    warnings: [],
    comfort: 'shade',
    mobility: 'default',
    heightSource: 'osm',
    leafOff: false,
  } as unknown as RouteResponse;
  const state = {
    from,
    to,
    date: '2026-07-15',
    minutes: 780,
    shadePreference: 0.5,
    mobility: 'default' as const,
    comfort: 'auto' as const,
    viaCoolSpot: false,
    selectedProfile: 'balanced' as const,
    response,
  };

  function memoryStorage(limit = Infinity): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        if (value.length > limit) throw new Error('QuotaExceededError');
        data.set(key, value);
      },
    };
  }

  it('zapisuje i odczytuje trasę', () => {
    const storage = memoryStorage();
    saveLastRoute(state, storage);
    const saved = loadLastRoute(storage)!;
    expect(saved).toMatchObject({ from, to, date: '2026-07-15', minutes: 780, selectedProfile: 'balanced' });
    expect(saved.response.routes).toHaveLength(2);
    expect(Number.isNaN(new Date(saved.savedAt).getTime())).toBe(false);
  });

  it('przy braku miejsca zapisuje tylko wybrany wariant', () => {
    const full = JSON.stringify(toSavedRoute(state)).length;
    const storage = memoryStorage(full - 20);
    saveLastRoute(state, storage);
    expect(loadLastRoute(storage)!.response.routes.map((route) => route.profile)).toEqual(['balanced']);
  });

  it('nie zapisuje stanu bez trasy i odrzuca uszkodzone zapisy', () => {
    const storage = memoryStorage();
    saveLastRoute({ ...state, response: null }, storage);
    expect(storage.data.has(LAST_ROUTE_KEY)).toBe(false);
    expect(parseSavedRoute('{nie json')).toBeNull();
    expect(parseSavedRoute(JSON.stringify({ ...toSavedRoute(state), response: { routes: [] } }))).toBeNull();
    expect(parseSavedRoute(JSON.stringify({ ...toSavedRoute(state), from: { lat: 52.2, lon: 21, label: 'Warszawa' } }))).toBeNull();
    expect(parseSavedRoute(JSON.stringify({ ...toSavedRoute(state), date: '15.07.2026' }))).toBeNull();
    expect(loadLastRoute(null)).toBeNull();
  });

  it('pasuje tylko do zapytania o te same punkty', () => {
    const saved = toSavedRoute(state)!;
    expect(cachedRouteFor({ from, to }, saved)).toBe(saved);
    expect(cachedRouteFor({ from: { ...from, label: 'inna nazwa' }, to }, saved)).toBe(saved);
    expect(cachedRouteFor({ from: { ...from, lat: from.lat + 0.001 }, to }, saved)).toBeNull();
    expect(cachedRouteFor({ from: to, to: from }, saved)).toBeNull();
    expect(cachedRouteFor({ from, to: null }, saved)).toBeNull();
    expect(cachedRouteFor({ from, to }, null)).toBeNull();
  });

  it('dobiera tekst banera offline', () => {
    expect(offlineBannerText(false, { routeFromCache: true, from, to })).toBe('Jesteś offline — pokazuję ostatnią trasę');
    expect(offlineBannerText(true, { routeFromCache: true, from, to })).toContain('Brak połączenia z serwerem');
    expect(offlineBannerText(false, { routeFromCache: false, from: null, to: null })).toContain('Jesteś offline');
    expect(offlineBannerText(true, { routeFromCache: false, from, to })).toBeNull();
  });
});
