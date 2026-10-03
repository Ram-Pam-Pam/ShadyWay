// Preferencje użytkownika pamiętane w localStorage (profil poruszania się).
// Link z hashem ma pierwszeństwo; pamięć lokalna wypełnia to, czego link nie podaje.

import type { MobilityProfile } from '../../shared/types.ts';
import { parseMobility } from './hash.ts';

export interface StoredPrefs {
  mobility: MobilityProfile;
}

export const PREFS_STORAGE_KEY = 'cien:prefs:v2';

export const DEFAULT_PREFS: StoredPrefs = { mobility: 'default' };

/** Odczyt zapisanych preferencji; uszkodzony lub obcy zapis daje wartości domyślne. */
export function parsePrefs(raw: string | null | undefined): StoredPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_PREFS };
  const record = value as Record<string, unknown>;
  return { mobility: parseMobility(record.mobility) ?? DEFAULT_PREFS.mobility };
}

export function serializePrefs(prefs: StoredPrefs): string {
  return JSON.stringify({ mobility: prefs.mobility });
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // np. zablokowane ciasteczka
  }
}

export function loadPrefs(storage: StorageLike | null = defaultStorage()): StoredPrefs {
  try {
    return parsePrefs(storage?.getItem(PREFS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: StoredPrefs, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(PREFS_STORAGE_KEY, serializePrefs(prefs));
  } catch {
    // Brak miejsca lub tryb prywatny — preferencje po prostu nie zostaną zapamiętane.
  }
}
