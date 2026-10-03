// Pozycja Słońca oraz wschód/zachód — uproszczone wzory astronomiczne (Meeus, w wariancie znanym z SunCalc).
// Dokładność rzędu 0,1–0,3° dla pozycji i ~1–2 min dla wschodu/zachodu, czyli z zapasem dla cieni budynków.

import { KRAKOW_CENTER, TIMEZONE } from '../../shared/types.ts';
import type { SunInfo } from '../../shared/types.ts';
import type { SunPosition } from '../contracts.ts';

const RAD = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
/** Poprawka przejścia przez południk (ułamek doby) we wzorze na numer cyklu słonecznego. */
const J0 = 0.0009;
/** Wysokość środka tarczy w chwili wschodu/zachodu: refrakcja (34') + promień tarczy (16'). */
const SUNRISE_ALTITUDE = -0.833 * RAD;

const localDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toDays(ms: number): number {
  return ms / DAY_MS - 0.5 + J1970 - J2000;
}

function fromDays(days: number): Date {
  return new Date((days + J2000 + 0.5 - J1970) * DAY_MS);
}

function solarMeanAnomaly(d: number): number {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(m: number): number {
  const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  const perihelion = RAD * 102.9372;
  return m + center + perihelion + Math.PI;
}

function declination(eclLon: number): number {
  return Math.asin(Math.sin(eclLon) * Math.sin(OBLIQUITY));
}

function rightAscension(eclLon: number): number {
  return Math.atan2(Math.sin(eclLon) * Math.cos(OBLIQUITY), Math.cos(eclLon));
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const d = toDays(date.getTime());
  const phi = lat * RAD;
  const eclLon = eclipticLongitude(solarMeanAnomaly(d));
  const dec = declination(eclLon);
  const siderealTime = RAD * (280.16 + 360.9856235 * d) + lon * RAD;
  const hourAngle = siderealTime - rightAscension(eclLon);

  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle),
  );
  // atan2 daje azymut liczony od południa na zachód; +π przenosi zero na północ (zgodnie z zegarem).
  const fromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  );
  const azimuth = (((fromSouth + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  return { azimuth, altitude };
}

/** Południe UTC dnia kalendarzowego (w strefie Europe/Warsaw), do którego należy `date`. */
function localDayNoonUtcMs(date: Date): number {
  const parts = localDateFormat.formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), 12);
}

/**
 * Wschód i zachód Słońca w dniu kalendarzowym (czas lokalny Krakowa) zawierającym `date`.
 * null, gdy Słońce danego dnia nie przekracza horyzontu (dzień/noc polarna).
 */
export function sunTimes(
  date: Date,
  lat: number,
  lon: number,
): { sunrise: Date | null; sunset: Date | null } {
  const lw = -lon * RAD;
  const phi = lat * RAD;
  const d = toDays(localDayNoonUtcMs(date));
  const cycle = Math.round(d - J0 - lw / TWO_PI);

  const approxTransit = J0 + lw / TWO_PI + cycle;
  const m = solarMeanAnomaly(approxTransit);
  const eclLon = eclipticLongitude(m);
  const dec = declination(eclLon);
  const equationOfTime = 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * eclLon);
  const noon = approxTransit + equationOfTime;

  const cosHourAngle =
    (Math.sin(SUNRISE_ALTITUDE) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosHourAngle < -1 || cosHourAngle > 1) return { sunrise: null, sunset: null };

  const halfDay = Math.acos(cosHourAngle) / TWO_PI;
  return { sunrise: fromDays(noon - halfDay), sunset: fromDays(noon + halfDay) };
}

export function sunInfo(
  date: Date,
  lat: number = KRAKOW_CENTER.lat,
  lon: number = KRAKOW_CENTER.lon,
): SunInfo {
  const { azimuth, altitude } = sunPosition(date, lat, lon);
  const { sunrise, sunset } = sunTimes(date, lat, lon);
  return {
    azimuthDeg: azimuth / RAD,
    altitudeDeg: altitude / RAD,
    sunrise: sunrise ? sunrise.toISOString() : null,
    sunset: sunset ? sunset.toISOString() : null,
    isDay: altitude > 0,
  };
}

/**
 * Sezon bezlistny drzew liściastych w Krakowie: w przybliżeniu 1 listopada – 10 kwietnia
 * (dzień kalendarzowy w czasie lokalnym). Korony przepuszczają wtedy większość światła.
 */
export function isLeafOff(date: Date): boolean {
  const parts = localDateFormat.formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const month = part('month');
  return month >= 11 || month <= 3 || (month === 4 && part('day') <= 10);
}
