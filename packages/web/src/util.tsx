import { useCallback, useRef, useState, type ReactNode } from 'react';

/**
 * useState whose latest value is also readable synchronously through a ref.
 * Save handlers blur the focused field first (which commits typed text through
 * onChange) and then read the ref, so nothing the user typed is lost.
 */
export function useLiveState<T>(initial: T | (() => T)) {
  const [state, setState] = useState<T>(initial);
  const ref = useRef<T>(state);
  const set = useCallback((u: T | ((prev: T) => T)) => {
    ref.current = typeof u === 'function' ? (u as (prev: T) => T)(ref.current) : u;
    setState(ref.current);
  }, []);
  return [state, set, ref] as const;
}

/** Labels are written "&File"; "&&" is a literal ampersand. */
export function parseMnemonic(label: string): { text: string; index: number; key: string | null } {
  let text = '';
  let index = -1;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '&') {
      if (label[i + 1] === '&') {
        text += '&';
        i++;
      } else if (i + 1 < label.length && index === -1) {
        index = text.length;
      }
      continue;
    }
    text += c;
  }
  return { text, index, key: index >= 0 ? text[index].toLowerCase() : null };
}

export function Mnemonic({ label }: { label: string }): ReactNode {
  const { text, index } = parseMnemonic(label);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <u>{text[index]}</u>
      {text.slice(index + 1)}
    </>
  );
}

const FOCUSABLE =
  'input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]';

export function focusables(root: Element | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && el.offsetParent !== null,
  );
}

/**
 * Blur the focused field so its onBlur commits whatever was typed, and return it
 * so the caller can put focus back (for example when a save fails).
 */
export function commitActiveField(): HTMLElement | null {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) {
    el.blur();
    return el;
  }
  return null;
}

export function refocus(el: HTMLElement | null) {
  if (el && el.isConnected) el.focus();
}
