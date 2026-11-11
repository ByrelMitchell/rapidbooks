import { useSyncExternalStore } from 'react';

/**
 * View menu choices remembered per browser: the icon bar (View > Top Icon Bar / Left Icon
 * Bar / Hide Icon Bar), whether the left bar is open or folded to a strip, and the larger
 * font for lists and registers (View > Large List Font). Storage may be blocked (private
 * window, policy): then the choices just are not remembered.
 */
export interface ViewPrefs {
  iconBar: boolean;
  /** QuickBooks 2013 puts the icon bar down the left ("My Shortcuts"). */
  leftIconBar: boolean;
  /** The left bar shows its labels; folded, it is a narrow strip of icons. */
  leftBarOpen: boolean;
  largeLists: boolean;
  /** Main windows (forms, lists, registers, reports) fill the desktop, as on her screen. */
  maxWindows: boolean;
}

const KEYS: Record<keyof ViewPrefs, string> = {
  iconBar: 'rapidbooks.iconBar',
  leftIconBar: 'rapidbooks.leftIconBar',
  leftBarOpen: 'rapidbooks.leftBarOpen',
  largeLists: 'rapidbooks.largeListFont',
  maxWindows: 'rapidbooks.maxWindows',
};
const DEFAULTS: ViewPrefs = { iconBar: true, leftIconBar: true, leftBarOpen: false, largeLists: false, maxWindows: true };

function read(): ViewPrefs {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(KEYS) as (keyof ViewPrefs)[]) {
    try {
      const v = localStorage.getItem(KEYS[k]);
      if (v === '1' || v === '0') out[k] = v === '1';
    } catch {
      // Storage blocked: keep the default.
    }
  }
  return out;
}

let state: ViewPrefs = read();
const listeners = new Set<() => void>();

export function setViewPref(key: keyof ViewPrefs, value: boolean) {
  if (state[key] === value) return;
  state = { ...state, [key]: value };
  try {
    localStorage.setItem(KEYS[key], value ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
  listeners.forEach((l) => l());
}

export const viewPrefs = () => state;

export function useViewPrefs(): ViewPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
