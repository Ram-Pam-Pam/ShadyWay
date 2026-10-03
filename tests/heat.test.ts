import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { createHeatField, heatColor, type LstGridMeta } from '../server/heat/lst.ts';

// Siatka 3 × 2 (północ → południe), komórki 1° × 1°; środki komórek w x.5.
//   lat 51.5:  20  30  NaN
//   lat 50.5:  40  50  60
const grid = new Float32Array([20, 30, NaN, 40, 50, 60]);
const meta: LstGridMeta = {
  bounds: [10, 50, 13, 52],
  width: 3,
  height: 2,
  p5: 20,
  p50: 40,
  p95: 60,
  min: 20,
  max: 60,
  source: 'test',
};
const field = createHeatField(grid, meta);

describe('createHeatField', () => {
  it('zwraca wartości komórek w ich środkach', () => {
    expect(field.sampleC(51.5, 10.5)).toBeCloseTo(20);
    expect(field.sampleC(50.5, 12.5)).toBeCloseTo(60);
  });

  it('interpoluje dwuliniowo między środkami komórek', () => {
    expect(field.sampleC(51.5, 11.0)).toBeCloseTo(25);
    expect(field.sampleC(51.0, 10.5)).toBeCloseTo(30);
    expect(field.sampleC(51.0, 11.0)).toBeCloseTo(35);
  });

  it('pomija komórki NaN i renormalizuje wagi', () => {
    // Między 30 (ważna) a NaN na północy oraz 50 i 60 na południu.
    expect(field.sampleC(51.5, 12.0)).toBeCloseTo(30);
    expect(field.sampleC(51.0, 12.0)).toBeCloseTo((30 * 0.25 + 50 * 0.25 + 60 * 0.25) / 0.75);
    expect(field.sampleC(51.5, 12.5)).toBeNull();
  });

  it('przycina do skrajnych środków na brzegu i zwraca null poza siatką', () => {
    expect(field.sampleC(52, 10)).toBeCloseTo(20);
    expect(field.sampleC(50, 13)).toBeCloseTo(60);
    expect(field.sampleC(52.01, 11)).toBeNull();
    expect(field.sampleC(51, 9.99)).toBeNull();
    expect(field.sampleC(NaN, 11)).toBeNull();
  });

  it('normalizuje percentylami 5–95 z przycięciem do 0..1', () => {
    expect(field.normalized(51.5, 10.5)).toBe(0);
    expect(field.normalized(50.5, 11.5)).toBeCloseTo(0.75);
    expect(field.normalized(50.5, 12.5)).toBe(1);
    expect(field.normalized(51.5, 12.5)).toBe(0); // brak danych
    expect(field.normalized(60, 11)).toBe(0); // poza siatką

    const narrow = createHeatField(grid, { ...meta, p5: 30, p95: 50 });
    expect(narrow.normalized(51.5, 10.5)).toBe(0);
    expect(narrow.normalized(50.5, 12.5)).toBe(1);
    expect(narrow.normalized(50.5, 10.5)).toBeCloseTo(0.5);
  });

  it('opisuje nakładkę w meta()', () => {
    expect(field.available).toBe(true);
    expect(field.meta()).toEqual({ available: true, bounds: [10, 50, 13, 52], minC: 20, maxC: 60, source: 'test' });
  });

  it('renderuje PNG RGBA z przezroczystym brakiem danych', () => {
    const png = field.overlayPng();
    expect(png).not.toBeNull();
    expect([...png!.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(field.overlayPng()).toBe(png); // cache

    const decoded = PNG.sync.read(png!);
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    const pixel = (x: number, y: number) => [...decoded.data.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
    expect(pixel(0, 0)).toEqual([...heatColor(0), 170]);
    expect(pixel(2, 1)).toEqual([...heatColor(1), 170]);
    expect(pixel(2, 0)[3]).toBe(0);
  });

  it('zmniejsza nakładkę dla szerokich siatek', () => {
    const width = 3300;
    const wide = createHeatField(new Float32Array(width * 3).fill(30), { ...meta, width, height: 3 });
    const decoded = PNG.sync.read(wide.overlayPng()!);
    expect(decoded.width).toBe(1100);
    expect(decoded.height).toBe(1);
  });

  it('odrzuca siatkę o złym rozmiarze', () => {
    expect(() => createHeatField(new Float32Array(5), meta)).toThrow();
  });
});

describe('heatColor', () => {
  it('biegnie od chłodnego niebieskiego przez żółty do czerwonego', () => {
    expect(heatColor(0)).toEqual([49, 54, 149]);
    expect(heatColor(0.5)).toEqual([255, 255, 191]);
    expect(heatColor(1)).toEqual([165, 0, 38]);
    expect(heatColor(-3)).toEqual(heatColor(0));
    expect(heatColor(7)).toEqual(heatColor(1));
  });
});
