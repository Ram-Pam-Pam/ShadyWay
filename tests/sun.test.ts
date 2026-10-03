import { describe, expect, it } from 'vitest';
import { KRAKOW_CENTER } from '../shared/types.ts';
import { toLatLon, toLonLat, toXY } from '../server/geo/project.ts';
import { isLeafOff, sunInfo, sunPosition, sunTimes } from '../server/geo/sun.ts';

const { lat: LAT, lon: LON } = KRAKOW_CENTER;
const DEG = 180 / Math.PI;
const MINUTE_MS = 60_000;

/** Chwila górowania: maksimum wysokości Słońca przeszukiwane co 30 s w danym dniu UTC. */
function solarNoon(dayUtc: string): Date {
  const start = Date.parse(`${dayUtc}T08:00:00Z`);
  let best = start;
  let bestAltitude = -Infinity;
  for (let t = start; t <= start + 6 * 60 * MINUTE_MS; t += MINUTE_MS / 2) {
    const { altitude } = sunPosition(new Date(t), LAT, LON);
    if (altitude > bestAltitude) {
      bestAltitude = altitude;
      best = t;
    }
  }
  return new Date(best);
}

function minutesApart(a: Date | null, isoB: string): number {
  return Math.abs(a!.getTime() - Date.parse(isoB)) / MINUTE_MS;
}

describe('geo/project', () => {
  it('środek Krakowa to początek układu', () => {
    expect(toXY(LAT, LON)).toEqual([0, 0]);
  });

  it('x rośnie na wschód, y na północ, w metrach', () => {
    const [x, y] = toXY(LAT + 0.01, LON + 0.01);
    expect(y).toBeCloseTo(1111.95, 0);
    expect(x).toBeCloseTo(1111.95 * Math.cos(LAT / DEG), 0);
  });

  it('odwzorowanie jest odwracalne', () => {
    const [x, y] = toXY(50.0497, 19.9445);
    const [lat, lon] = toLatLon(x, y);
    expect(lat).toBeCloseTo(50.0497, 9);
    expect(lon).toBeCloseTo(19.9445, 9);
    expect(toLonLat(x, y)).toEqual([lon, lat]);
  });
});

describe('geo/sun — pozycja', () => {
  it('w południe słoneczne Słońce jest dokładnie na południu', () => {
    for (const day of ['2024-03-20', '2024-06-21', '2024-09-22', '2024-12-21']) {
      const { azimuth } = sunPosition(solarNoon(day), LAT, LON);
      expect(azimuth * DEG).toBeGreaterThan(179);
      expect(azimuth * DEG).toBeLessThan(181);
    }
  });

  it('wysokość górowania w przesileniach: ok. 63,4° latem i 16,5° zimą', () => {
    const summer = sunPosition(solarNoon('2024-06-21'), LAT, LON);
    const winter = sunPosition(solarNoon('2024-12-21'), LAT, LON);
    expect(summer.altitude * DEG).toBeCloseTo(63.4, 0);
    expect(Math.abs(summer.altitude * DEG - 63.38)).toBeLessThan(0.3);
    expect(Math.abs(winter.altitude * DEG - 16.5)).toBeLessThan(0.3);
  });

  it('rano Słońce jest na wschodzie, po południu na zachodzie', () => {
    const morning = sunPosition(new Date('2024-07-15T08:00:00+02:00'), LAT, LON);
    const afternoon = sunPosition(new Date('2024-07-15T17:00:00+02:00'), LAT, LON);
    expect(morning.azimuth * DEG).toBeGreaterThan(60);
    expect(morning.azimuth * DEG).toBeLessThan(120);
    expect(afternoon.azimuth * DEG).toBeGreaterThan(240);
    expect(afternoon.azimuth * DEG).toBeLessThan(290);
    expect(morning.altitude).toBeGreaterThan(0);
    expect(afternoon.altitude).toBeGreaterThan(0);
  });

  it('azymut jest w zakresie [0, 2π), a w nocy wysokość jest ujemna', () => {
    for (let hour = 0; hour < 24; hour++) {
      const { azimuth } = sunPosition(new Date(Date.UTC(2024, 4, 10, hour)), LAT, LON);
      expect(azimuth).toBeGreaterThanOrEqual(0);
      expect(azimuth).toBeLessThan(2 * Math.PI);
    }
    expect(sunPosition(new Date('2024-07-15T01:00:00+02:00'), LAT, LON).altitude).toBeLessThan(0);
  });

  it('w równonoc Słońce wschodzi niemal dokładnie na wschodzie i zachodzi na zachodzie', () => {
    const { sunrise, sunset } = sunTimes(new Date('2024-03-20T12:00:00+01:00'), LAT, LON);
    expect(Math.abs(sunPosition(sunrise!, LAT, LON).azimuth * DEG - 90)).toBeLessThan(2);
    expect(Math.abs(sunPosition(sunset!, LAT, LON).azimuth * DEG - 270)).toBeLessThan(2);
  });
});

describe('geo/sun — wschód i zachód', () => {
  // Wartości publikowane dla Krakowa (kalendarze astronomiczne, czas urzędowy).
  const published = [
    { day: '2024-06-21', sunrise: '2024-06-21T04:31:00+02:00', sunset: '2024-06-21T20:54:00+02:00' },
    { day: '2024-12-21', sunrise: '2024-12-21T07:37:00+01:00', sunset: '2024-12-21T15:41:00+01:00' },
    { day: '2024-03-20', sunrise: '2024-03-20T05:44:00+01:00', sunset: '2024-03-20T17:53:00+01:00' },
  ];

  it.each(published)('$day: zgodność z tablicami co do kilku minut', ({ day, sunrise, sunset }) => {
    const times = sunTimes(new Date(`${day}T12:00:00Z`), LAT, LON);
    expect(minutesApart(times.sunrise, sunrise)).toBeLessThan(4);
    expect(minutesApart(times.sunset, sunset)).toBeLessThan(4);
  });

  it('w chwili wschodu i zachodu Słońce jest tuż pod horyzontem geometrycznym', () => {
    const { sunrise, sunset } = sunTimes(new Date('2025-08-01T12:00:00Z'), LAT, LON);
    for (const moment of [sunrise!, sunset!]) {
      const altitudeDeg = sunPosition(moment, LAT, LON).altitude * DEG;
      expect(Math.abs(altitudeDeg + 0.833)).toBeLessThan(0.3);
    }
  });

  it('dotyczy dnia kalendarzowego w Krakowie, także tuż po północy czasu lokalnego', () => {
    // 00:30 czasu letniego 4 października to jeszcze 3 października w UTC.
    const afterMidnight = sunTimes(new Date('2026-10-04T00:30:00+02:00'), LAT, LON);
    const sameDayNoon = sunTimes(new Date('2026-10-04T12:00:00+02:00'), LAT, LON);
    expect(afterMidnight.sunrise!.getTime()).toBe(sameDayNoon.sunrise!.getTime());
    expect(afterMidnight.sunrise!.toISOString().slice(0, 10)).toBe('2026-10-04');
  });

  it('zwraca null w dzień i noc polarną', () => {
    expect(sunTimes(new Date('2024-06-21T12:00:00Z'), 78.2, 15.6)).toEqual({
      sunrise: null,
      sunset: null,
    });
    expect(sunTimes(new Date('2024-12-21T12:00:00Z'), 78.2, 15.6).sunrise).toBeNull();
  });
});

describe('geo/sun — sunInfo', () => {
  it('domyślnie liczy dla centrum Krakowa i zwraca stopnie oraz ISO', () => {
    const date = new Date('2024-06-21T13:00:00+02:00');
    const info = sunInfo(date);
    const position = sunPosition(date, LAT, LON);
    expect(info.azimuthDeg).toBeCloseTo(position.azimuth * DEG, 9);
    expect(info.altitudeDeg).toBeCloseTo(position.altitude * DEG, 9);
    expect(info.isDay).toBe(true);
    expect(minutesApart(new Date(info.sunrise!), '2024-06-21T04:31:00+02:00')).toBeLessThan(4);
    expect(minutesApart(new Date(info.sunset!), '2024-06-21T20:54:00+02:00')).toBeLessThan(4);
  });

  it('w nocy isDay = false', () => {
    const info = sunInfo(new Date('2024-06-21T23:30:00+02:00'));
    expect(info.isDay).toBe(false);
    expect(info.altitudeDeg).toBeLessThan(0);
  });
});

describe('geo/sun — isLeafOff (sezon bezlistny)', () => {
  it('od 1 listopada do 10 kwietnia drzewa liściaste są bez liści', () => {
    for (const day of ['2026-11-01', '2026-12-24', '2027-01-15', '2027-02-28', '2027-03-31', '2027-04-10']) {
      expect(isLeafOff(new Date(`${day}T12:00:00Z`))).toBe(true);
    }
    for (const day of ['2026-04-11', '2026-05-01', '2026-07-15', '2026-09-30', '2026-10-31']) {
      expect(isLeafOff(new Date(`${day}T12:00:00Z`))).toBe(false);
    }
  });

  it('granice liczone są w czasie lokalnym Krakowa', () => {
    // 1 listopada 00:30 czasu zimowego to jeszcze 31 października w UTC.
    expect(isLeafOff(new Date('2026-11-01T00:30:00+01:00'))).toBe(true);
    expect(isLeafOff(new Date('2026-10-31T23:30:00+01:00'))).toBe(false);
    // 11 kwietnia 00:30 czasu letniego to jeszcze 10 kwietnia w UTC.
    expect(isLeafOff(new Date('2027-04-11T00:30:00+02:00'))).toBe(false);
    expect(isLeafOff(new Date('2027-04-10T23:30:00+02:00'))).toBe(true);
  });
});
