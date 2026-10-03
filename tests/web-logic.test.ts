// Czysta logika frontendu: hash i preferencje, etykiety, wykres „Kiedy wyjść?”, plan asystenta, SSE.

import { describe, expect, it } from 'vitest';
import type { DepartureOption } from '../shared/types.ts';
import {
  MIN_BAR_PCT,
  barHeightPct,
  bestOptionIndex,
  buildChart,
  departureReadout,
  optionIndexAt,
  shadeColor,
} from '../web/src/departureChart.ts';
import { routeColorScale } from '../web/src/format.ts';
import { parseHash, serializeHash, type ShareableState } from '../web/src/hash.ts';
import {
  comfortShare,
  comfortTexts,
  plural,
  preferenceLabel,
  routeFactsLine,
  routeSummary,
  signalsText,
  stairsText,
  stressLabel,
  thermalText,
  weatherLine,
} from '../web/src/labels.ts';
import { planToPatch } from '../web/src/plan.ts';
import { DEFAULT_PREFS, PREFS_STORAGE_KEY, loadPrefs, parsePrefs, savePrefs, serializePrefs } from '../web/src/prefs.ts';
import { createSseParser } from '../web/src/sse.ts';
import { effectiveComfort } from '../web/src/store.ts';

const BASE: ShareableState = {
  from: { lat: 50.0614, lon: 19.9372, label: 'Rynek Główny' },
  to: { lat: 50.054, lon: 19.9354, label: 'Wawel' },
  date: '2026-07-15',
  minutes: 13 * 60,
  followNow: false,
  shadePreference: 0.5,
  mobility: 'default',
};

describe('hash: profil poruszania się', () => {
  it('pomija wartości domyślne, więc link pozostaje krótki', () => {
    const hash = serializeHash(BASE);
    expect(hash).not.toMatch(/[&?](m|c|v)=/);
    expect(parseHash(hash)).toMatchObject({ mobility: null });
  });

  it('zapisuje i odczytuje profil', () => {
    const hash = serializeHash({ ...BASE, mobility: 'accessible' });
    expect(hash).toContain('m=accessible');
    const parsed = parseHash(`#${hash}`);
    expect(parsed.mobility).toBe('accessible');
    expect(parsed.from).toMatchObject({ lat: 50.0614, lon: 19.9372, label: 'Rynek Główny' });
    expect(parsed.time).toEqual({ date: '2026-07-15', minutes: 780 });
    expect(parsed.shadePreference).toBe(0.5);
  });

  it('odrzuca nieznane wartości', () => {
    expect(parseHash('#m=rower')).toMatchObject({ mobility: null });
    expect(parseHash('#m=senior')).toMatchObject({ mobility: 'senior' });
  });

  it('wczytuje dawne linki z usuniętymi polami (tryb komfortu, punkt chłodu), ignorując je', () => {
    const parsed = parseHash('#a=50.06140,19.93720&an=Rynek&b=50.05400,19.93540&bn=Wawel&d=2026-07-15&t=13:00&p=0.70&m=senior&c=sun&v=1');
    expect(parsed).toEqual({
      from: { lat: 50.0614, lon: 19.9372, label: 'Rynek' },
      to: { lat: 50.054, lon: 19.9354, label: 'Wawel' },
      time: { date: '2026-07-15', minutes: 780 },
      shadePreference: 0.7,
      mobility: 'senior',
    });
    // Zapis takiego stanu nie przywraca usuniętych pól.
    expect(serializeHash({ ...BASE, mobility: 'senior' })).not.toMatch(/[&?](c|v)=/);
  });
});

describe('preferencje w localStorage', () => {
  it('serializacja i odczyt są wzajemnie odwrotne', () => {
    const prefs = { mobility: 'senior' } as const;
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
  });

  it('uszkodzony zapis daje wartości domyślne', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{oops')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"tekst"')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"mobility":"rower"}')).toEqual(DEFAULT_PREFS);
    // Zapis ze starszej wersji (z trybem komfortu i punktem chłodu): zostaje sam profil.
    expect(parsePrefs('{"mobility":"senior","comfort":"sun","viaCoolSpot":true}')).toEqual({ mobility: 'senior' });
  });

  it('korzysta z podanego magazynu i znosi jego awarię', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    savePrefs({ mobility: 'accessible' }, storage);
    expect(data.has(PREFS_STORAGE_KEY)).toBe(true);
    expect(loadPrefs(storage)).toEqual({ mobility: 'accessible' });
    const broken = {
      getItem: (): string => {
        throw new Error('zablokowane');
      },
      setItem: (): void => {
        throw new Error('zablokowane');
      },
    };
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(DEFAULT_PREFS, broken)).not.toThrow();
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe('etykiety', () => {
  it('odmienia rzeczowniki przy liczebnikach', () => {
    const lights = (n: number): string => plural(n, 'światło', 'światła', 'świateł');
    expect([1, 2, 4, 5, 12, 14, 22, 25, 112].map(lights)).toEqual([
      'światło',
      'światła',
      'światła',
      'świateł',
      'świateł',
      'świateł',
      'światła',
      'świateł',
      'świateł',
    ]);
  });

  it('opisuje światła', () => {
    expect(signalsText(3)).toBe('3 światła');
    expect(signalsText(1)).toBe('1 światło');
    expect(signalsText(6)).toBe('6 świateł');
    expect(signalsText(0)).toBeNull();
    expect(signalsText(undefined)).toBeNull();
  });

  it('opisuje schody', () => {
    expect(stairsText(0)).toBe('bez schodów');
    expect(stairsText(1)).toBe('1 odcinek schodów');
    expect(stairsText(3)).toBe('3 odcinki schodów');
    expect(stairsText(5)).toBe('5 odcinków schodów');
    expect(stairsText(undefined)).toBeNull();
  });

  it('składa krótką linię faktów karty trasy', () => {
    expect(routeFactsLine({ signalCrossings: 2, stairsCount: 0 })).toBe('2 światła · bez schodów');
    expect(routeFactsLine({ signalCrossings: 0, stairsCount: 1 })).toBe('1 odcinek schodów');
    expect(routeFactsLine({} as never)).toBe('');
  });

  it('składa jedną linię pogody', () => {
    expect(weatherLine({ source: 'open-meteo', temperatureC: 21.6, apparentTemperatureC: 24.2 } as never)).toBe('22°C · odczuwalna 24°C');
    expect(weatherLine({ source: 'open-meteo', temperatureC: 5, apparentTemperatureC: null } as never)).toBe('5°C');
    expect(weatherLine({ source: 'unavailable', temperatureC: null, apparentTemperatureC: null })).toBeNull();
    expect(weatherLine({ source: 'open-meteo', temperatureC: null, apparentTemperatureC: null } as never)).toBeNull();
    expect(weatherLine(null)).toBeNull();
  });

  it('opisuje komfort cieplny', () => {
    expect(stressLabel('strong')).toBe('Silny stres cieplny');
    expect(stressLabel('none')).toBe('Komfort cieplny');
    expect(stressLabel(null)).toBeNull();
    expect(stressLabel(undefined)).toBeNull();
    expect(thermalText({ feltSunC: 34.4, feltShadeC: 27.6, feltMeanC: 30, stress: 'strong' })).toBe(
      'Odczuwalna 34°C w słońcu · 28°C w cieniu',
    );
    expect(thermalText({ feltSunC: null, feltShadeC: null, feltMeanC: 12, stress: 'none' })).toBe('Odczuwalna średnio 12°C');
    expect(thermalText({ feltSunC: null, feltShadeC: null, feltMeanC: null, stress: null })).toBeNull();
    expect(thermalText(undefined)).toBeNull();
  });

  it('odwraca znaczenie w trybie zimowym', () => {
    expect(comfortShare(0.8, 'shade')).toBeCloseTo(0.8);
    expect(comfortShare(0.8, 'sun')).toBeCloseTo(0.2);
    expect(comfortTexts('sun').sliderMax).toBe('Najwięcej słońca');
    expect(comfortTexts('shade').sliderMax).toBe('Najwięcej cienia');
    expect(preferenceLabel(1, 'sun')).toBe('maksimum słońca');
    expect(preferenceLabel(0.8, 'shade')).toBe('dużo cienia');
    expect(preferenceLabel(0.5, 'sun')).toBe('równowaga');
    expect(preferenceLabel(0)).toBe('liczy się tylko dystans');
    const route = { label: 'Zbalansowana', distanceM: 1240, durationS: 960, shadeFraction: 0.25 };
    expect(routeSummary(route, 'shade')).toBe('Zbalansowana · 1,2 km · 16 min · 25% w cieniu');
    expect(routeSummary(route, 'sun')).toBe('Zbalansowana · 1,2 km · 16 min · 75% w słońcu');
    expect(routeColorScale('sun')).not.toEqual(routeColorScale('shade'));
  });

  it('tryb interfejsu rozstrzyga odpowiedź serwera (zawsze prosimy o auto)', () => {
    expect(effectiveComfort({ response: null })).toBe('shade');
    expect(effectiveComfort({ response: { comfort: 'sun' } as never })).toBe('sun');
    expect(effectiveComfort({ response: { comfort: 'shade' } as never })).toBe('shade');
    // Starszy serwer bez pola comfort: przyjmujemy cień.
    expect(effectiveComfort({ response: {} as never })).toBe('shade');
  });
});

function option(time: string, score: number, shadeFraction: number, extra: Partial<DepartureOption> = {}): DepartureOption {
  return { time, distanceM: 1200, durationS: 900, shadeFraction, sunDistanceM: 1200 * (1 - shadeFraction), sunFactor: 0.8, feltMeanC: 27, score, ...extra };
}

describe('wykres „Kiedy wyjść?”', () => {
  it('skaluje słupki od zera, z minimalną widoczną wysokością', () => {
    expect(barHeightPct(100)).toBe(100);
    expect(barHeightPct(50)).toBe(50);
    expect(barHeightPct(33.33)).toBe(33.3);
    expect(barHeightPct(0)).toBe(MIN_BAR_PCT);
    expect(barHeightPct(-20)).toBe(MIN_BAR_PCT);
    expect(barHeightPct(140)).toBe(100);
    expect(barHeightPct(Number.NaN)).toBe(MIN_BAR_PCT);
  });

  it('koloruje udział cienia jednobarwną rampą', () => {
    expect(shadeColor(0)).toBe('#c9c7ee');
    expect(shadeColor(1)).toBe('#272462');
    expect(shadeColor(0.5)).toBe('#7876a8');
    expect(shadeColor(7)).toBe('#272462');
  });

  it('buduje słupki z podpisami pełnych godzin i wyróżnia najlepszy', () => {
    const options = [
      option('2026-07-15T16:00:00+02:00', 40, 0.3),
      option('2026-07-15T16:30:00+02:00', 55, 0.5),
      option('2026-07-15T17:00:00+02:00', 82, 0.9),
      option('2026-07-15T17:30:00+02:00', 70, 0.8, { feltMeanC: null }),
    ];
    const bars = buildChart({ options, bestIndex: 2 }, 'shade');
    expect(bars.map((bar) => bar.tick)).toEqual(['16', null, '17', null]);
    expect(bars.map((bar) => bar.isBest)).toEqual([false, false, true, false]);
    expect(bars.map((bar) => bar.heightPct)).toEqual([40, 55, 82, 70]);
    expect(bars[2].clock).toBe('17:00');
    expect(bars[2].readout).toBe('17:00 · 90% w cieniu · odczuwalna 27°C · 15 min · ocena 82/100');
    expect(bars[3].readout).toBe('17:30 · 80% w cieniu · 15 min · ocena 70/100');
    expect(departureReadout(options[2], 'sun')).toBe('17:00 · 10% w słońcu · odczuwalna 27°C · 15 min · ocena 82/100');
  });

  it('przy długim oknie podpisuje co drugą godzinę', () => {
    const options: DepartureOption[] = [];
    for (let i = 0; i <= 24; i++) {
      const minutes = 8 * 60 + i * 30;
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
      const mm = String(minutes % 60).padStart(2, '0');
      options.push(option(`2026-07-15T${hh}:${mm}:00+02:00`, 50, 0.5));
    }
    const ticks = buildChart({ options, bestIndex: 0 }, 'shade').map((bar) => bar.tick).filter(Boolean);
    expect(ticks).toEqual(['8', '10', '12', '14', '16', '18', '20']);
  });

  it('naprawia nieprawidłowy indeks najlepszej opcji i odnajduje wybraną godzinę', () => {
    const options = [option('2026-07-15T16:00:00+02:00', 40, 0.3), option('2026-07-15T16:30:00+02:00', 90, 0.5)];
    expect(bestOptionIndex({ options, bestIndex: 7 })).toBe(1);
    expect(bestOptionIndex({ options, bestIndex: 0 })).toBe(0);
    expect(bestOptionIndex({ options: [], bestIndex: 0 })).toBe(-1);
    expect(optionIndexAt(options, '2026-07-15T14:30:00Z')).toBe(1);
    expect(optionIndexAt(options, '2026-07-15T16:15:00+02:00')).toBe(-1);
    expect(optionIndexAt(options, 'nonsens')).toBe(-1);
  });
});

describe('plan asystenta', () => {
  it('przekłada plan na zmianę stanu (tryb komfortu i punkt chłodu z planu są pomijane)', () => {
    const patch = planToPatch(
      {
        to: { lat: 50.054, lon: 19.9354, label: 'Wawel' },
        time: '2026-07-15T16:30:00Z',
        shadePreference: 1.4,
        mobility: 'senior',
        comfort: 'shade',
        viaCoolSpot: true,
        selectProfile: 'shadiest',
      },
      { from: null, to: null },
    );
    expect(patch).toEqual({
      to: { lat: 50.054, lon: 19.9354, label: 'Wawel' },
      pickTarget: 'from',
      formError: null,
      date: '2026-07-15',
      minutes: 18 * 60 + 30,
      followNow: false,
      shadePreference: 1,
      mobility: 'senior',
      selectedProfile: 'shadiest',
    });
  });

  it('pomija pola nieprawidłowe i nieobecne', () => {
    const patch = planToPatch(
      { from: { lat: 52.23, lon: 21.01, label: 'Warszawa' }, time: 'jutro', mobility: 'rower' as never },
      { from: null, to: null },
    );
    expect(patch).toEqual({});
    expect(planToPatch({}, { from: null, to: null })).toEqual({});
  });
});

describe('parser SSE', () => {
  it('składa zdarzenia z dowolnie pociętych fragmentów', () => {
    const events: unknown[] = [];
    const parser = createSseParser<unknown>((event) => events.push(event));
    parser.feed('data: {"type":"text","de');
    parser.feed('lta":"Cześć"}\n\n: ping\n\ndata: {"type":"tool","name":"geocode","label":"Szukam: Wawel…"}\r\n\r\nda');
    parser.feed('ta: nie-json\n\ndata: {"type":"done"}');
    expect(events).toHaveLength(2);
    parser.flush();
    expect(events).toEqual([
      { type: 'text', delta: 'Cześć' },
      { type: 'tool', name: 'geocode', label: 'Szukam: Wawel…' },
      { type: 'done' },
    ]);
  });
});
