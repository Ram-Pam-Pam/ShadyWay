// Źródła pozycji dla nawigacji: GPS przeglądarki albo symulowane przejście wzdłuż trasy (demo, testy).

import type { LatLon } from '../../../shared/types.ts';
import { pointAlong, type RouteIndex } from './progress.ts';

export interface Fix extends LatLon {
  accuracyM: number | null;
  /** Kierunek ruchu z GPS (null, gdy nieznany — np. w bezruchu). */
  headingDeg: number | null;
}

export type SourceError = 'denied' | 'unavailable';

export interface PositionSource {
  start(onFix: (fix: Fix) => void, onError: (error: SourceError) => void): void;
  stop(): void;
}

export function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

export class GeolocationSource implements PositionSource {
  private watchId: number | null = null;

  start(onFix: (fix: Fix) => void, onError: (error: SourceError) => void): void {
    this.stop();
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy, heading, speed } = position.coords;
        onFix({
          lat: latitude,
          lon: longitude,
          accuracyM: Number.isFinite(accuracy) ? accuracy : null,
          // Kierunek z GPS jest wiarygodny dopiero w ruchu.
          headingDeg: heading !== null && Number.isFinite(heading) && (speed ?? 0) > 0.4 ? heading : null,
        });
      },
      (error) => {
        // TIMEOUT jest przejściowy — watchPosition próbuje dalej.
        if (error.code === error.PERMISSION_DENIED) onError('denied');
        else if (error.code === error.POSITION_UNAVAILABLE) onError('unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}

export const WALKING_SPEED_MPS = 1.35;
const SIM_TICK_MS = 1000;

/** Przesuwa pozycję wzdłuż trasy w tempie marszu (razy `speedFactor`). */
export class SimulatedSource implements PositionSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alongM = 0;
  private speedFactor = 1;
  private readonly getIndex: () => RouteIndex;

  constructor(getIndex: () => RouteIndex) {
    this.getIndex = getIndex;
  }

  setSpeedFactor(factor: number): void {
    this.speedFactor = factor;
  }

  start(onFix: (fix: Fix) => void): void {
    this.stop();
    const emit = (): void => {
      const index = this.getIndex();
      this.alongM = Math.min(index.totalM, this.alongM);
      const at = pointAlong(index, this.alongM);
      if (at) onFix({ lon: at.point[0], lat: at.point[1], accuracyM: 5, headingDeg: at.bearingDeg });
    };
    emit();
    this.timer = setInterval(() => {
      this.alongM += WALKING_SPEED_MPS * this.speedFactor * (SIM_TICK_MS / 1000);
      emit();
    }, SIM_TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
