import { isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "pi-tool-preset";

/** Brand newcomers start without file/command tools; explicit choices are retained. */
export function defaultToolPreset(brandGate = process.env.NEXT_PUBLIC_AUTH_GATE): ToolPreset {
  return brandGate === "1" ? "none" : "default";
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return defaultToolPreset();
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : defaultToolPreset();
  } catch {
    return defaultToolPreset();
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}
