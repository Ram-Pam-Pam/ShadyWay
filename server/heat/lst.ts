// Pole temperatury powierzchni (LST) z siatki zbudowanej przez server/scripts/fetch-lst.ts.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { HeatMeta } from '../../shared/types.ts';
import type { IHeatField } from '../contracts.ts';

/** Zawartość data/lst/krakow_lst.json. */
export interface LstGridMeta {
  /** Zewnętrzne krawędzie siatki [west, south, east, north]; wartości odnoszą się do środków komórek. */
  bounds: [number, number, number, number];
  width: number;
  height: number;
  p5: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  source: string;
}

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/lst');
const OVERLAY_MAX_WIDTH = 1600;
const OVERLAY_ALPHA = 170;

/** Rampa chłodny niebieski → żółty → czerwony (odwrócona ColorBrewer RdYlBu), równe odstępy. */
const HEAT_RAMP: [number, number, number][] = [
  [49, 54, 149],
  [69, 117, 180],
  [116, 173, 209],
  [171, 217, 233],
  [224, 243, 248],
  [255, 255, 191],
  [254, 224, 144],
  [253, 174, 97],
  [244, 109, 67],
  [215, 48, 39],
  [165, 0, 38],
];

/** Kolor rampy dla t ∈ 0..1 (interpolacja liniowa między progami). */
export function heatColor(t: number): [number, number, number] {
  const pos = Math.min(1, Math.max(0, t)) * (HEAT_RAMP.length - 1);
  const i = Math.min(HEAT_RAMP.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = HEAT_RAMP[i];
  const b = HEAT_RAMP[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const UNAVAILABLE: IHeatField = {
  available: false,
  sampleC: () => null,
  normalized: () => 0,
  meta: () => ({ available: false }),
  overlayPng: () => null,
};

/**
 * @param grid Float32, wierszami, północ → południe, NaN = brak danych; długość = width × height.
 */
export function createHeatField(grid: Float32Array, meta: LstGridMeta): IHeatField {
  const { width, height } = meta;
  if (grid.length !== width * height) {
    throw new Error(`Siatka LST ma ${grid.length} komórek, oczekiwano ${width} × ${height}`);
  }
  const [west, south, east, north] = meta.bounds;
  const cellLon = (east - west) / width;
  const cellLat = (north - south) / height;
  const range = meta.p95 - meta.p5;
  let overlay: Buffer | null = null;

  const sampleC = (lat: number, lon: number): number | null => {
    if (!(lon >= west && lon <= east && lat >= south && lat <= north)) return null;
    // Pozycja względem środków komórek; na brzegu siatki przytnij do skrajnego środka.
    const fx = Math.min(width - 1, Math.max(0, (lon - west) / cellLon - 0.5));
    const fy = Math.min(height - 1, Math.max(0, (north - lat) / cellLat - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    // Interpolacja dwuliniowa po ważnych sąsiadach (wagi komórek NaN są pomijane i renormalizowane).
    let sum = 0;
    let weight = 0;
    const add = (x: number, y: number, w: number) => {
      const v = grid[y * width + x];
      if (w > 0 && !Number.isNaN(v)) {
        sum += v * w;
        weight += w;
      }
    };
    add(x0, y0, (1 - tx) * (1 - ty));
    add(x1, y0, tx * (1 - ty));
    add(x0, y1, (1 - tx) * ty);
    add(x1, y1, tx * ty);
    return weight > 0 ? sum / weight : null;
  };

  const normalizeC = (c: number): number => (range > 0 ? Math.min(1, Math.max(0, (c - meta.p5) / range)) : 0);

  const renderOverlay = (): Buffer => {
    // Uśrednianie blokowe (z pominięciem NaN), gdy siatka jest szersza niż limit nakładki.
    const factor = Math.max(1, Math.ceil(width / OVERLAY_MAX_WIDTH));
    const outW = Math.ceil(width / factor);
    const outH = Math.ceil(height / factor);
    const png = new PNG({ width: outW, height: outH });
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        let sum = 0;
        let count = 0;
        for (let y = oy * factor; y < Math.min(height, (oy + 1) * factor); y++) {
          for (let x = ox * factor; x < Math.min(width, (ox + 1) * factor); x++) {
            const v = grid[y * width + x];
            if (!Number.isNaN(v)) {
              sum += v;
              count++;
            }
          }
        }
        const o = (oy * outW + ox) * 4;
        if (count === 0) {
          png.data.fill(0, o, o + 4);
        } else {
          const [r, g, b] = heatColor(normalizeC(sum / count));
          png.data[o] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = OVERLAY_ALPHA;
        }
      }
    }
    return PNG.sync.write(png);
  };

  return {
    available: true,
    sampleC,
    normalized(lat, lon) {
      const c = sampleC(lat, lon);
      return c === null ? 0 : normalizeC(c);
    },
    // minC/maxC to zakres skali kolorów nakładki (percentyle 5–95), nie skrajne wartości siatki.
    meta: (): HeatMeta => ({
      available: true,
      bounds: meta.bounds,
      minC: meta.p5,
      maxC: meta.p95,
      source: meta.source,
    }),
    overlayPng() {
      overlay ??= renderOverlay();
      return overlay;
    },
  };
}

function loadFromDisk(): IHeatField {
  const jsonPath = path.join(DATA_DIR, 'krakow_lst.json');
  const binPath = path.join(DATA_DIR, 'krakow_lst.bin');
  if (!existsSync(jsonPath) || !existsSync(binPath)) return UNAVAILABLE;
  try {
    const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as LstGridMeta;
    const bin = readFileSync(binPath);
    // Kopia do wyrównanego bufora — Buffer z puli Node nie musi mieć offsetu podzielnego przez 4.
    const grid = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    return createHeatField(grid, meta);
  } catch (err) {
    console.warn(`[heat] Nie udało się wczytać siatki LST: ${(err as Error).message}`);
    return UNAVAILABLE;
  }
}

let singleton: IHeatField | null = null;

export function getHeatField(): IHeatField {
  singleton ??= loadFromDisk();
  return singleton;
}
