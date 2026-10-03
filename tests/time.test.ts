import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatKrakowClock,
  formatLongDate,
  instantToWallTime,
  isValidDateString,
  krakowMinutesOf,
  nowWallTime,
  offsetMinutesAt,
  parseClock,
  toIsoWithOffset,
  wallTimeToInstant,
  wallTimeToIso,
} from '../web/src/time.ts';

describe('offsetMinutesAt', () => {
  it('zwraca +120 latem i +60 zimą', () => {
    expect(offsetMinutesAt(new Date('2026-07-15T11:00:00Z'))).toBe(120);
    expect(offsetMinutesAt(new Date('2026-01-15T11:00:00Z'))).toBe(60);
  });

  it('zmienia się dokładnie w chwili przejścia na czas letni i zimowy', () => {
    expect(offsetMinutesAt(new Date('2026-03-29T00:59:59Z'))).toBe(60);
    expect(offsetMinutesAt(new Date('2026-03-29T01:00:00Z'))).toBe(120);
    expect(offsetMinutesAt(new Date('2026-10-25T00:59:59Z'))).toBe(120);
    expect(offsetMinutesAt(new Date('2026-10-25T01:00:00Z'))).toBe(60);
  });
});

describe('wallTimeToInstant', () => {
  it('przelicza zwykły letni i zimowy dzień', () => {
    expect(wallTimeToInstant('2026-07-15', 13 * 60).toISOString()).toBe('2026-07-15T11:00:00.000Z');
    expect(wallTimeToInstant('2026-01-15', 13 * 60).toISOString()).toBe('2026-01-15T12:00:00.000Z');
  });

  it('obsługuje północ i ostatni krok suwaka', () => {
    expect(wallTimeToInstant('2026-07-15', 0).toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(wallTimeToInstant('2026-07-15', 23 * 60 + 45).toISOString()).toBe('2026-07-15T21:45:00.000Z');
  });

  it('w dniu przejścia na czas letni używa właściwego offsetu przed i po zmianie', () => {
    expect(wallTimeToInstant('2026-03-29', 1 * 60 + 45).toISOString()).toBe('2026-03-29T00:45:00.000Z');
    expect(wallTimeToInstant('2026-03-29', 3 * 60).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(wallTimeToInstant('2026-03-29', 12 * 60).toISOString()).toBe('2026-03-29T10:00:00.000Z');
  });

  it('nieistniejącą godzinę wiosną przesuwa o godzinę do przodu', () => {
    const instant = wallTimeToInstant('2026-03-29', 2 * 60 + 30);
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(instantToWallTime(instant)).toEqual({ date: '2026-03-29', minutes: 3 * 60 + 30 });
  });

  it('w dniu przejścia na czas zimowy używa właściwego offsetu przed i po zmianie', () => {
    expect(wallTimeToInstant('2026-10-25', 1 * 60 + 45).toISOString()).toBe('2026-10-24T23:45:00.000Z');
    expect(wallTimeToInstant('2026-10-25', 3 * 60).toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(wallTimeToInstant('2026-10-25', 12 * 60).toISOString()).toBe('2026-10-25T11:00:00.000Z');
  });

  it('powtórzoną godzinę jesienią rozstrzyga na wcześniejszy moment (czas letni)', () => {
    expect(wallTimeToInstant('2026-10-25', 2 * 60 + 30).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('odrzuca nieprawidłową datę', () => {
    expect(() => wallTimeToInstant('2026-02-30', 0)).toThrow(RangeError);
    expect(() => wallTimeToInstant('15.07.2026', 0)).toThrow(RangeError);
  });
});

describe('toIsoWithOffset / wallTimeToIso', () => {
  it('zapisuje offset Krakowa', () => {
    expect(wallTimeToIso('2026-07-15', 13 * 60)).toBe('2026-07-15T13:00:00+02:00');
    expect(wallTimeToIso('2026-12-24', 8 * 60 + 15)).toBe('2026-12-24T08:15:00+01:00');
    expect(toIsoWithOffset(new Date('2026-07-15T22:30:00Z'))).toBe('2026-07-16T00:30:00+02:00');
  });

  it('wynik wskazuje ten sam moment co wejście', () => {
    for (const [date, minutes] of [
      ['2026-03-29', 135],
      ['2026-03-29', 600],
      ['2026-10-25', 150],
      ['2026-10-25', 185],
      ['2027-01-01', 0],
    ] as const) {
      const instant = wallTimeToInstant(date, minutes);
      expect(new Date(toIsoWithOffset(instant)).getTime()).toBe(instant.getTime());
    }
  });

  it('zachowuje czas ścienny dla każdego kroku suwaka w zwykły dzień', () => {
    for (let minutes = 0; minutes < 1440; minutes += 15) {
      expect(instantToWallTime(wallTimeToInstant('2026-06-21', minutes))).toEqual({ date: '2026-06-21', minutes });
    }
  });
});

describe('instantToWallTime / nowWallTime', () => {
  it('przechodzi przez północ zgodnie z czasem Krakowa', () => {
    expect(instantToWallTime(new Date('2026-07-15T22:05:00Z'))).toEqual({ date: '2026-07-16', minutes: 5 });
    expect(instantToWallTime(new Date('2026-12-31T23:30:00Z'))).toEqual({ date: '2027-01-01', minutes: 30 });
  });

  it('zaokrągla "teraz" w dół do kroku suwaka', () => {
    expect(nowWallTime(new Date('2026-07-15T11:14:59Z'))).toEqual({ date: '2026-07-15', minutes: 13 * 60 });
    expect(nowWallTime(new Date('2026-07-15T11:15:00Z'))).toEqual({ date: '2026-07-15', minutes: 13 * 60 + 15 });
  });
});

describe('formatowanie', () => {
  it('formatClock i parseClock są wzajemnie odwrotne', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(13 * 60 + 5)).toBe('13:05');
    expect(formatClock(5000)).toBe('23:59');
    expect(parseClock('13:05')).toBe(13 * 60 + 5);
    expect(parseClock('7:30')).toBe(450);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });

  it('formatuje momenty ISO w czasie Krakowa', () => {
    expect(formatKrakowClock('2026-07-15T02:42:00Z')).toBe('04:42');
    expect(formatKrakowClock('2026-01-15T15:05:00+01:00')).toBe('15:05');
    expect(formatKrakowClock('nonsens')).toBeNull();
    expect(krakowMinutesOf('2026-07-15T18:47:00Z')).toBe(20 * 60 + 47);
    expect(krakowMinutesOf(null)).toBeNull();
  });

  it('formatuje datę po polsku', () => {
    expect(formatLongDate('2026-07-15')).toBe('środa, 15 lipca');
  });

  it('sprawdza poprawność daty', () => {
    expect(isValidDateString('2026-02-28')).toBe(true);
    expect(isValidDateString('2026-02-29')).toBe(false);
    expect(isValidDateString('2026-2-9')).toBe(false);
  });
});
