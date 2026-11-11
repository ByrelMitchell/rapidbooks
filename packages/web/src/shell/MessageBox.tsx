import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Mnemonic, parseMnemonic } from '../util';

export type MsgIcon = 'info' | 'question' | 'warning' | 'error';

export interface MsgBoxOptions {
  title?: string;
  /** Button labels with "&" mnemonics, left to right. */
  buttons: string[];
  /** Index of the button that has focus (and Enter) when the box opens. Default 0. */
  defaultButton?: number;
  /** Index of the button Esc chooses. Default: the last button. */
  cancelButton?: number;
  icon?: MsgIcon;
}

export interface MsgBoxRequest extends MsgBoxOptions {
  key: number;
  message: string;
}

const ICON_TEXT: Record<MsgIcon, string> = { info: 'i', question: '?', warning: '!', error: '×' };

/**
 * A Windows-classic message box, modal over the whole desktop. While it is up it owns
 * the keyboard: every key is swallowed (capture phase on window) before fields, menus or
 * the global shortcuts see it. Enter = focused button (the default to start with),
 * Esc = cancel button, Left/Right/Up/Down/Tab move between buttons, a letter = its mnemonic.
 */
export function MessageBox({ req, onDone }: { req: MsgBoxRequest; onDone: (index: number) => void }) {
  const n = req.buttons.length;
  const cancel = Math.min(n - 1, Math.max(0, req.cancelButton ?? n - 1));
  const [cur, setCur] = useState(Math.min(n - 1, Math.max(0, req.defaultButton ?? 0)));
  const boxRef = useRef<HTMLDivElement>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const prevFocus = useRef<Element | null>(null);
  const done = useRef(false);
  const curRef = useRef(cur);
  curRef.current = cur;

  // Where focus was when the box opened, to put it back afterwards.
  useLayoutEffect(() => {
    prevFocus.current = document.activeElement;
  }, []);

  useEffect(() => {
    btns.current[cur]?.focus();
  }, [cur]);

  const choose = (i: number) => {
    if (done.current) return;
    done.current = true;
    const p = prevFocus.current;
    if (p instanceof HTMLElement && p !== document.body && p.isConnected) p.focus();
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    onDone(i);
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (done.current || e.isComposing) return;
      const move = (d: number) => setCur((c) => (c + d + n) % n);
      switch (e.key) {
        case 'Tab':
          return move(e.shiftKey ? -1 : 1);
        case 'ArrowLeft':
        case 'ArrowUp':
          return move(-1);
        case 'ArrowRight':
        case 'ArrowDown':
          return move(1);
        case 'Enter':
        case ' ':
          // A held key must not run straight through the box.
          if (!e.repeat) chooseRef.current(curRef.current);
          return;
        case 'Escape':
          if (!e.repeat) chooseRef.current(cancel);
          return;
      }
      if (e.ctrlKey || e.metaKey || e.repeat || !/^Key[A-Z]$/.test(e.code)) return;
      const letter = e.code.slice(3).toLowerCase();
      const i = req.buttons.findIndex((b) => parseMnemonic(b).key === letter);
      if (i >= 0) chooseRef.current(i);
    };
    // Keep focus inside the box (a click elsewhere cannot reach anything: the layer covers it).
    const onFocusIn = (e: FocusEvent) => {
      if (done.current) return;
      if (!boxRef.current?.contains(e.target as Node)) btns.current[curRef.current]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [n, cancel, req.buttons]);

  const icon = req.icon ?? 'warning';
  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div ref={boxRef} className="win active msgbox" role="alertdialog" aria-modal="true" aria-label={req.title ?? 'RapidBooks'}>
        <div className="win-title" onMouseDown={(e) => e.preventDefault()}>
          <span className="win-title-text">{req.title ?? 'RapidBooks'}</span>
        </div>
        <div className="msgbox-body">
          <span className={`msgbox-icon ${icon}`} aria-hidden="true">
            {ICON_TEXT[icon]}
          </span>
          <div className="msgbox-text">{req.message}</div>
        </div>
        <div className="button-row center">
          {req.buttons.map((b, i) => (
            <button
              key={i}
              ref={(el) => {
                btns.current[i] = el;
              }}
              type="button"
              className={`btn${i === cur ? ' default' : ''}`}
              tabIndex={-1}
              onFocus={() => setCur(i)}
              // Keyboard activation is handled above; a keyboard-made click (detail 0) from the
              // keystroke that opened the box must not choose a button.
              onClick={(e) => e.detail > 0 && choose(i)}
            >
              <Mnemonic label={b} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
