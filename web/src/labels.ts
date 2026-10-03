// Teksty interfejsu zależne od danych v2 (profil, tryb komfortu, obciążenie cieplne, światła, punkty chłodu).
// Same czyste funkcje — bez DOM — żeby dało się je testować.

import type {
  ComfortMode,
  CoolSpot,
  CoolSpotKind,
  MobilityProfile,
  RouteResponse,
  RouteResult,
  ThermalInfo,
  WeatherInfo,
} from '../../shared/types.ts';
import { formatDistance, formatDuration, formatPercent, formatTemperature } from './format.ts';

export type AppliedComfort = 'shade' | 'sun';

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** Dłuższy opis (podpowiedź / czytnik ekranu). */
  hint: string;
}

export const MOBILITY_CHOICES: ReadonlyArray<Choice<MobilityProfile>> = [
  { value: 'default', label: 'Pieszo', hint: 'Zwykły marsz, schody dozwolone' },
  { value: 'accessible', label: 'Wózek / bez schodów', hint: 'Bez schodów, z dala od złej nawierzchni i wysokich krawężników' },
  { value: 'senior', label: 'Senior', hint: 'Wolniejszy marsz, unikanie schodów, trasy przy ławkach' },
];

export const COMFORT_CHOICES: ReadonlyArray<Choice<ComfortMode>> = [
  { value: 'auto', label: 'Auto', hint: 'Cień w upale, słońce w chłodne dni — według temperatury odczuwalnej' },
  { value: 'shade', label: 'Szukaj cienia', hint: 'Zawsze prowadź możliwie zacienioną trasą' },
  { value: 'sun', label: 'Szukaj słońca', hint: 'Tryb zimowy: prowadź możliwie nasłonecznioną trasą' },
];

/** Polska odmiana rzeczownika przy liczebniku: plural(3, 'światło', 'światła', 'świateł') → 'światła'. */
export function plural(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.round(count));
  if (n === 1) return one;
  const lastTwo = n % 100;
  const last = n % 10;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

// ───────────── tryb komfortu ─────────────

export interface ComfortTexts {
  /** Tytuł karty z suwakiem. */
  prefTitle: string;
  sliderMax: string;
  /** Dopisek przy udziale procentowym na karcie trasy. */
  shareSuffix: string;
  /** Etykieta dystansu „po złej stronie” na karcie trasy. */
  adverseLabel: string;
  legendCaption: string;
  emptyLead: string;
  idleSummary: string;
}

const COMFORT_TEXTS: Record<AppliedComfort, ComfortTexts> = {
  shade: {
    prefTitle: 'Ile cienia?',
    sliderMax: 'Maksimum cienia',
    shareSuffix: 'w cieniu',
    adverseLabel: 'W słońcu',
    legendCaption: 'Kolor odcinka trasy',
    emptyLead: 'Pokażę Ci drogę pieszą, która o wybranej porze biegnie jak najwięcej w cieniu.',
    idleSummary: 'Zaplanuj trasę w cieniu',
  },
  sun: {
    prefTitle: 'Ile słońca?',
    sliderMax: 'Maksimum słońca',
    shareSuffix: 'w słońcu',
    adverseLabel: 'W cieniu',
    legendCaption: 'Kolor odcinka trasy',
    emptyLead: 'Pokażę Ci drogę pieszą, która o wybranej porze biegnie jak najwięcej w słońcu.',
    idleSummary: 'Zaplanuj trasę w słońcu',
  },
};

export function comfortTexts(comfort: AppliedComfort): ComfortTexts {
  return COMFORT_TEXTS[comfort];
}

export function preferenceLabel(preference: number, comfort: AppliedComfort = 'shade'): string {
  const what = comfort === 'sun' ? 'słońca' : 'cienia';
  if (preference <= 0.02) return 'liczy się tylko dystans';
  if (preference < 0.35) return `trochę ${what}`;
  if (preference <= 0.65) return 'równowaga';
  if (preference < 0.98) return `dużo ${what}`;
  return `maksimum ${what}`;
}

/** Udział trasy „po dobrej stronie”: w cieniu latem, w słońcu w trybie zimowym. */
export function comfortShare(shadeFraction: number, comfort: AppliedComfort): number {
  const shade = Math.max(0, Math.min(1, shadeFraction));
  return comfort === 'sun' ? 1 - shade : shade;
}

/** Metry „po złej stronie”: w słońcu latem, w cieniu w trybie zimowym. */
export function adverseDistanceM(route: Pick<RouteResult, 'distanceM' | 'sunDistanceM'>, comfort: AppliedComfort): number {
  return comfort === 'sun' ? Math.max(0, route.distanceM - route.sunDistanceM) : route.sunDistanceM;
}

/**
 * Plakietka wyjaśniająca wybór trybu „Auto”, np. „Tryb zimowy: szukam słońca, bo odczuwalna 4°C”.
 * null, gdy użytkownik sam wybrał tryb albo nie ma jeszcze odpowiedzi serwera.
 */
export function autoComfortBadge(
  requested: ComfortMode,
  applied: AppliedComfort | null | undefined,
  weather: Pick<WeatherInfo, 'apparentTemperatureC' | 'temperatureC'> | null | undefined,
): string | null {
  if (requested !== 'auto' || (applied !== 'sun' && applied !== 'shade')) return null;
  const felt = weather?.apparentTemperatureC ?? null;
  const air = weather?.temperatureC ?? null;
  const reason =
    felt !== null ? `, bo odczuwalna ${formatTemperature(felt)}` : air !== null ? `, bo jest ${formatTemperature(air)}` : '';
  return applied === 'sun' ? `Tryb zimowy: szukam słońca${reason}` : `Auto: szukam cienia${reason}`;
}

// ───────────── komfort cieplny ─────────────

export type StressLevel = NonNullable<ThermalInfo['stress']>;

const STRESS_LABELS: Record<StressLevel, string> = {
  cold: 'Chłodno',
  none: 'Komfort cieplny',
  moderate: 'Umiarkowany stres cieplny',
  strong: 'Silny stres cieplny',
  very_strong: 'Bardzo silny stres cieplny',
  extreme: 'Skrajny stres cieplny',
};

export function stressLabel(stress: ThermalInfo['stress'] | undefined): string | null {
  return stress ? (STRESS_LABELS[stress] ?? null) : null;
}

/** „Odczuwalna 34°C w słońcu · 28°C w cieniu”; null, gdy serwer nie ma pogody. */
export function thermalText(thermal: ThermalInfo | null | undefined): string | null {
  if (!thermal) return null;
  const { feltSunC, feltShadeC, feltMeanC } = thermal;
  const parts: string[] = [];
  if (typeof feltSunC === 'number') parts.push(`${formatTemperature(feltSunC)} w słońcu`);
  if (typeof feltShadeC === 'number') parts.push(`${formatTemperature(feltShadeC)} w cieniu`);
  if (parts.length > 0) return `Odczuwalna ${parts.join(' · ')}`;
  return typeof feltMeanC === 'number' ? `Odczuwalna średnio ${formatTemperature(feltMeanC)}` : null;
}

// ───────────── światła i schody ─────────────

function formatWait(seconds: number): string {
  if (seconds < 50) return `${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return formatDuration(seconds);
}

/** „3 światła, ok. 1 min czekania”; null, gdy na trasie nie ma przejść z sygnalizacją. */
export function signalsText(signalCrossings: number | undefined, waitS: number | undefined): string | null {
  const count = Math.round(signalCrossings ?? 0);
  if (!(count > 0)) return null;
  const lights = `${count} ${plural(count, 'światło', 'światła', 'świateł')}`;
  return waitS !== undefined && waitS >= 1 ? `${lights}, ok. ${formatWait(waitS)} czekania` : lights;
}

/** „Bez schodów” / „2 odcinki schodów”. */
export function stairsText(stairsCount: number | undefined): string | null {
  if (stairsCount === undefined || !Number.isFinite(stairsCount)) return null;
  const count = Math.round(stairsCount);
  if (count <= 0) return 'Bez schodów';
  return `${count} ${plural(count, 'odcinek', 'odcinki', 'odcinków')} schodów`;
}

// ───────────── punkty chłodu ─────────────

const COOL_SPOT_LABELS: Record<CoolSpotKind, string> = {
  drinking_water: 'Woda pitna',
  fountain: 'Fontanna',
  water_mist: 'Kurtyna wodna',
  bench: 'Ławka',
  park: 'Park',
  shelter: 'Wiata / zadaszenie',
};

export function coolSpotKindLabel(kind: CoolSpotKind): string {
  return COOL_SPOT_LABELS[kind] ?? 'Punkt chłodu';
}

/** Nazwa punktu do pokazania: własna nazwa z OSM albo rodzaj. */
export function coolSpotTitle(spot: Pick<CoolSpot, 'kind' | 'name'>): string {
  return spot.name?.trim() || coolSpotKindLabel(spot.kind);
}

export function coolSpotShadeLabel(shaded: boolean | undefined): string | null {
  if (shaded === undefined) return null;
  return shaded ? 'o tej porze w cieniu' : 'o tej porze w słońcu';
}

// ───────────── nawierzchnia ─────────────

const SURFACE_LABELS: Record<string, string> = {
  asphalt: 'asfalt',
  paved: 'utwardzona',
  concrete: 'beton',
  'concrete:plates': 'płyty betonowe',
  'concrete:lanes': 'pasy betonowe',
  paving_stones: 'kostka brukowa',
  sett: 'bruk (kostka kamienna)',
  cobblestone: 'kocie łby',
  unhewn_cobblestone: 'kocie łby',
  bricks: 'cegła',
  metal: 'metal',
  wood: 'drewno',
  compacted: 'ubita',
  fine_gravel: 'drobny żwir',
  gravel: 'żwir',
  pebblestone: 'otoczaki',
  unpaved: 'nieutwardzona',
  ground: 'grunt',
  dirt: 'ziemia',
  earth: 'ziemia',
  grass: 'trawa',
  grass_paver: 'płyty ażurowe',
  sand: 'piasek',
  mud: 'błoto',
};

/** Wartość tagu OSM surface=* po polsku; nieznane wartości pokazujemy tak, jak są w OSM. */
export function surfaceLabel(surface: string | undefined): string | null {
  const key = surface?.trim().toLowerCase();
  if (!key) return null;
  return SURFACE_LABELS[key] ?? key.replace(/_/g, ' ');
}

// ───────────── jakość danych ─────────────

export interface QualityBadge {
  id: 'height' | 'leaf';
  label: string;
  /** Wyjaśnienie pokazywane w podpowiedzi i po kliknięciu plakietki. */
  detail: string;
  tone: 'good' | 'neutral';
}

export function qualityBadges(response: Pick<RouteResponse, 'heightSource' | 'leafOff'> | null | undefined): QualityBadge[] {
  if (!response) return [];
  const badges: QualityBadge[] = [];
  if (response.heightSource === 'lidar') {
    badges.push({
      id: 'height',
      label: 'Wysokości: LiDAR',
      detail: 'Wysokości budynków i drzew pochodzą z lotniczego skaningu laserowego (LiDAR) — cienie są liczone z rzeczywistych brył.',
      tone: 'good',
    });
  } else if (response.heightSource === 'mixed') {
    badges.push({
      id: 'height',
      label: 'Wysokości: LiDAR + OSM',
      detail: 'Dla części okolicy wysokości pochodzą z pomiaru LiDAR, dla reszty z OpenStreetMap (tam mogą być szacowane).',
      tone: 'neutral',
    });
  } else if (response.heightSource === 'osm') {
    badges.push({
      id: 'height',
      label: 'Wysokości: OSM (szacowane)',
      detail: 'Wysokości budynków pochodzą z OpenStreetMap; gdzie ich brak, przyjmujemy wartość domyślną, więc zasięg cienia jest przybliżony.',
      tone: 'neutral',
    });
  }
  if (response.leafOff === true) {
    badges.push({
      id: 'leaf',
      label: 'Drzewa bez liści',
      detail: 'O tej porze roku drzewa liściaste liczymy jako bezlistne — dają tylko niewielki cień gałęzi.',
      tone: 'neutral',
    });
  }
  return badges;
}

// ───────────── podsumowania ─────────────

/** Jednowierszowe podsumowanie wybranej trasy (uchwyt arkusza na telefonie). */
export function routeSummary(
  route: Pick<RouteResult, 'label' | 'distanceM' | 'durationS' | 'shadeFraction'>,
  comfort: AppliedComfort,
): string {
  return [
    route.label,
    formatDistance(route.distanceM),
    formatDuration(route.durationS),
    `${formatPercent(comfortShare(route.shadeFraction, comfort))} ${comfortTexts(comfort).shareSuffix}`,
  ].join(' · ');
}
