// Czysta logika frontendu v2: hash i preferencje, etykiety, wykres „Kiedy wyjść?”, punkty chłodu, plan asystenta, SSE.

import { describe, expect, it } from 'vitest';
import type { CoolSpot, DepartureOption, RouteResult } from '../shared/types.ts';
import {
  COOL_SPOT_LAYER_CAP,
  capCoolSpots,
  coolSpotLayerNote,
  coolSpotMarkerKey,
  coolSpotMarkers,
} from '../web/src/coolSpots.ts';
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
  adverseDistanceM,
  autoComfortBadge,
  comfortShare,
  comfortTexts,
  coolSpotTitle,
  plural,
  preferenceLabel,
  qualityBadges,
  routeSummary,
  signalsText,
  stairsText,
  stressLabel,
  surfaceLabel,
  thermalText,
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
  comfort: 'auto',
  viaCoolSpot: false,
};

describe('hash: pola v2', () => {
  it('pomija wartości domyślne, więc link v1 pozostaje bez zmian', () => {
    const hash = serializeHash(BASE);
    expect(hash).not.toMatch(/[&?](m|c|v)=/);
    expect(parseHash(hash)).toMatchObject({ mobility: null, comfort: null, viaCoolSpot: null });
  });

  it('zapisuje i odczytuje profil, tryb komfortu i punkt chłodu', () => {
    const hash = serializeHash({ ...BASE, mobility: 'accessible', comfort: 'sun', viaCoolSpot: true });
    expect(hash).toContain('m=accessible');
    expect(hash).toContain('c=sun');
    expect(hash).toContain('v=1');
    const parsed = parseHash(`#${hash}`);
    expect(parsed.mobility).toBe('accessible');
    expect(parsed.comfort).toBe('sun');
    expect(parsed.viaCoolSpot).toBe(true);
    expect(parsed.from).toMatchObject({ lat: 50.0614, lon: 19.9372, label: 'Rynek Główny' });
    expect(parsed.time).toEqual({ date: '2026-07-15', minutes: 780 });
    expect(parsed.shadePreference).toBe(0.5);
  });

  it('odrzuca nieznane wartości', () => {
    const parsed = parseHash('#m=rower&c=mgła&v=tak');
    expect(parsed).toMatchObject({ mobility: null, comfort: null, viaCoolSpot: null });
    expect(parseHash('#m=senior&c=shade&v=0')).toMatchObject({ mobility: 'senior', comfort: 'shade', viaCoolSpot: false });
  });
});

describe('preferencje w localStorage', () => {
  it('serializacja i odczyt są wzajemnie odwrotne', () => {
    const prefs = { mobility: 'senior', comfort: 'sun', viaCoolSpot: true } as const;
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
  });

  it('uszkodzony zapis daje wartości domyślne', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{oops')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"tekst"')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"mobility":"rower","comfort":7,"viaCoolSpot":"1"}')).toEqual(DEFAULT_PREFS);
  });

  it('korzysta z podanego magazynu i znosi jego awarię', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
    savePrefs({ mobility: 'accessible', comfort: 'shade', viaCoolSpot: false }, storage);
    expect(data.has(PREFS_STORAGE_KEY)).toBe(true);
    expect(loadPrefs(storage)).toEqual({ mobility: 'accessible', comfort: 'shade', viaCoolSpot: false });
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

  it('opisuje światła i czas czekania', () => {
    expect(signalsText(3, 62)).toBe('3 światła, ok. 1 min czekania');
    expect(signalsText(1, 20)).toBe('1 światło, ok. 20 s czekania');
    expect(signalsText(6, 185)).toBe('6 świateł, ok. 3 min czekania');
    expect(signalsText(2, 0)).toBe('2 światła');
    expect(signalsText(0, 0)).toBeNull();
    expect(signalsText(undefined, undefined)).toBeNull();
  });

  it('opisuje schody', () => {
    expect(stairsText(0)).toBe('Bez schodów');
    expect(stairsText(1)).toBe('1 odcinek schodów');
    expect(stairsText(3)).toBe('3 odcinki schodów');
    expect(stairsText(5)).toBe('5 odcinków schodów');
    expect(stairsText(undefined)).toBeNull();
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
    expect(adverseDistanceM({ distanceM: 1000, sunDistanceM: 300 }, 'shade')).toBe(300);
    expect(adverseDistanceM({ distanceM: 1000, sunDistanceM: 300 }, 'sun')).toBe(700);
    expect(comfortTexts('sun').sliderMax).toBe('Maksimum słońca');
    expect(comfortTexts('shade').sliderMax).toBe('Maksimum cienia');
    expect(preferenceLabel(1, 'sun')).toBe('maksimum słońca');
    expect(preferenceLabel(0.8, 'shade')).toBe('dużo cienia');
    expect(preferenceLabel(0.5, 'sun')).toBe('równowaga');
    expect(preferenceLabel(0)).toBe('liczy się tylko dystans');
    const route = { label: 'Zbalansowana', distanceM: 1240, durationS: 960, shadeFraction: 0.25 };
    expect(routeSummary(route, 'shade')).toBe('Zbalansowana · 1,2 km · 16 min · 25% w cieniu');
    expect(routeSummary(route, 'sun')).toBe('Zbalansowana · 1,2 km · 16 min · 75% w słońcu');
    expect(routeColorScale('sun')).not.toEqual(routeColorScale('shade'));
  });

  it('wyjaśnia wybór trybu auto', () => {
    expect(autoComfortBadge('auto', 'sun', { apparentTemperatureC: 4.2, temperatureC: 6 })).toBe(
      'Tryb zimowy: szukam słońca, bo odczuwalna 4°C',
    );
    expect(autoComfortBadge('auto', 'shade', { apparentTemperatureC: 29, temperatureC: 27 })).toBe(
      'Auto: szukam cienia, bo odczuwalna 29°C',
    );
    expect(autoComfortBadge('auto', 'sun', { apparentTemperatureC: null, temperatureC: 3 })).toBe(
      'Tryb zimowy: szukam słońca, bo jest 3°C',
    );
    expect(autoComfortBadge('auto', 'sun', null)).toBe('Tryb zimowy: szukam słońca');
    expect(autoComfortBadge('sun', 'sun', null)).toBeNull();
    expect(autoComfortBadge('auto', undefined, null)).toBeNull();
  });

  it('rozstrzyga tryb interfejsu', () => {
    expect(effectiveComfort({ response: null, comfort: 'auto' })).toBe('shade');
    expect(effectiveComfort({ response: null, comfort: 'sun' })).toBe('sun');
    const response = { comfort: 'sun' } as never;
    expect(effectiveComfort({ response, comfort: 'auto' })).toBe('sun');
    // Starszy serwer bez pola comfort: obowiązuje wybór użytkownika.
    expect(effectiveComfort({ response: {} as never, comfort: 'shade' })).toBe('shade');
  });

  it('opisuje nawierzchnię, punkty chłodu i jakość danych', () => {
    expect(surfaceLabel('paving_stones')).toBe('kostka brukowa');
    expect(surfaceLabel('Asphalt')).toBe('asfalt');
    expect(surfaceLabel('rubber_mat')).toBe('rubber mat');
    expect(surfaceLabel(undefined)).toBeNull();
    expect(coolSpotTitle({ kind: 'fountain', name: ' Fontanna na Plantach ' })).toBe('Fontanna na Plantach');
    expect(coolSpotTitle({ kind: 'drinking_water' })).toBe('Woda pitna');
    expect(qualityBadges({ heightSource: 'lidar', leafOff: false }).map((b) => b.label)).toEqual(['Wysokości: LiDAR']);
    expect(qualityBadges({ heightSource: 'osm', leafOff: true }).map((b) => b.label)).toEqual([
      'Wysokości: OSM (szacowane)',
      'Drzewa bez liści',
    ]);
    expect(qualityBadges({} as never)).toEqual([]);
    expect(qualityBadges(null)).toEqual([]);
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

function spot(id: string, kind: CoolSpot['kind'], shaded?: boolean): CoolSpot {
  return { id, kind, lat: 50.06, lon: 19.94, shaded };
}

describe('punkty chłodu', () => {
  it('przy nadmiarze zostawia najpierw wodę, na końcu ławki', () => {
    const spots = [spot('b1', 'bench'), spot('b2', 'bench'), spot('w1', 'drinking_water'), spot('p1', 'park'), spot('f1', 'fountain')];
    const capped = capCoolSpots(spots, 3);
    expect(capped.total).toBe(5);
    expect(capped.spots.map((s) => s.id)).toEqual(['w1', 'f1', 'p1']);
    expect(capCoolSpots(spots).spots).toHaveLength(5);
    expect(COOL_SPOT_LAYER_CAP).toBeGreaterThan(0);
  });

  it('pomija uszkodzone rekordy', () => {
    const broken = [{ id: 'x', kind: 'bench', lat: Number.NaN, lon: 19.9 }, null, spot('ok', 'bench')] as CoolSpot[];
    expect(capCoolSpots(broken).spots.map((s) => s.id)).toEqual(['ok']);
  });

  it('łączy punkty trasy i warstwy bez powtórzeń, z rolami', () => {
    const via = spot('w1', 'drinking_water', true);
    const route = { via, coolSpots: [via, spot('b1', 'bench', false)] } as Pick<RouteResult, 'coolSpots' | 'via'>;
    const markers = coolSpotMarkers(route, [spot('b1', 'bench'), spot('p1', 'park')]);
    expect(markers.map((m) => `${m.role}:${m.spot.id}`)).toEqual(['via:w1', 'route:b1', 'layer:p1']);
    expect(markers.map(coolSpotMarkerKey)).toEqual(['via:w1:s', 'route:b1:n', 'layer:p1:u']);
    expect(coolSpotMarkers(null, [])).toEqual([]);
    // Odpowiedź starszego serwera bez pola coolSpots.
    expect(coolSpotMarkers({} as never, [spot('p1', 'park')])).toHaveLength(1);
  });

  it('opisuje stan warstwy', () => {
    expect(coolSpotLayerNote(10, 10)).toBeNull();
    expect(coolSpotLayerNote(120, 300)).toContain('120 z 300');
    expect(coolSpotLayerNote(0, 0)).toContain('Brak punktów chłodu');
  });
});

describe('plan asystenta', () => {
  it('przekłada plan na zmianę stanu', () => {
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
      comfort: 'shade',
      viaCoolSpot: true,
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
