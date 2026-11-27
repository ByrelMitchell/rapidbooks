import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { isModalOpen } from '../shell/desktop';
import { isQuietBlur, useLiveState } from '../util';

export interface ComboOption {
  id: number;
  label: string;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  options: ComboOption[];
  value: number | null;
  onChange: (id: number | null) => void;
  /** The list this field picks from, as QuickBooks names it ("Customer:Job", "Item"...). Ctrl+L opens it. */
  listName?: string;
  /**
   * Called when the field is left holding text that is not on the list (the Quick Add / Set Up box).
   * Resolve to the id to select, or null to leave the field invalid with focus back in it.
   */
  onNotFound?: (text: string) => Promise<number | null>;
};

// Not-found boxes still being answered (each leaves the set once answered), so a save can wait for them.
const pending = new Set<Promise<boolean>>();

/**
 * Wait until every Quick Add / Set Up started by leaving a Combo is answered.
 * Resolves false if any was cancelled: the save should stop (focus is already back in that field).
 * Call it right after commitActiveField() in a save handler, before reading the form.
 */
export async function settleQuickFill(): Promise<boolean> {
  let ok = true;
  while (pending.size > 0) {
    const results = await Promise.all([...pending]);
    if (results.includes(false)) ok = false;
  }
  return ok;
}

const lastSeg = (label: string) => label.slice(label.lastIndexOf(':') + 1);

/** First option whose label, or the part after its last ':', starts with what was typed. */
function findMatch(options: ComboOption[], typed: string): { index: number; rest: string } | null {
  const t = typed.toLowerCase();
  let i = options.findIndex((o) => o.label.toLowerCase().startsWith(t));
  if (i >= 0) return { index: i, rest: options[i].label.slice(typed.length) };
  i = options.findIndex((o) => lastSeg(o.label).toLowerCase().startsWith(t));
  if (i >= 0) return { index: i, rest: lastSeg(options[i].label).slice(typed.length) };
  return null;
}

function resolve(options: ComboOption[], text: string): ComboOption | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const exact = options.find((o) => o.label.toLowerCase() === t);
  if (exact) return exact;
  const bySeg = options.filter((o) => lastSeg(o.label).toLowerCase() === t);
  return bySeg.length === 1 ? bySeg[0] : null;
}

/** QuickBooks "QuickFill" combo: type-ahead completion plus an Alt+Down dropdown list. */
export function Combo({
  options,
  value,
  onChange,
  listName,
  onNotFound,
  className,
  onKeyDown,
  onFocus,
  onBlur,
  ...rest
}: Props) {
  const valueLabel = options.find((o) => o.id === value)?.label ?? '';
  // The ref copy lets blur (which may follow a pick in the same keystroke) see the latest text.
  const [text, setText, textRef] = useLiveState(valueLabel);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const [dropPos, setDropPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const invalidRef = useRef(false);
  invalidRef.current = invalid;
  const pendingSel = useRef<[number, number] | null>(null);
  // A not-found box for this field is up (or its Set Up window is open): don't ask again.
  const asking = useRef(false);
  // The id Quick Add / Set Up just created; until the list reloads it has no label yet.
  const added = useRef<number | null>(null);

  // Follow the value when it changes from outside (or when the options finish loading).
  const shownValue = useRef(value);
  const shownLabel = useRef(valueLabel);
  useEffect(() => {
    const changed = value !== shownValue.current;
    shownValue.current = value;
    if (focused.current) {
      // The field changes its own value only on a pick or on leaving it, never while typing,
      // so a new value while focused came from the form (Previous/Next, Save & New): show it,
      // selected so typing replaces it. Its label arriving later (the list loading) is shown
      // too, unless she has typed since.
      const untouched = textRef.current === shownLabel.current;
      if ((!changed && !untouched) || textRef.current === valueLabel) return;
      if (value !== null && value === added.current && !options.some((o) => o.id === value)) return;
      shownLabel.current = valueLabel;
      setText(valueLabel);
      setInvalid(false);
      pendingSel.current = [0, valueLabel.length];
      return;
    }
    shownLabel.current = valueLabel;
    if (value === null && invalidRef.current) return; // keep showing what was typed wrong
    if (value !== null && value === added.current && !options.some((o) => o.id === value)) return;
    setText(valueLabel);
    setInvalid(false);
  }, [value, valueLabel]);

  useLayoutEffect(() => {
    const sel = pendingSel.current;
    if (sel && inputRef.current) {
      pendingSel.current = null;
      inputRef.current.setSelectionRange(sel[0], sel[1]);
    }
  });

  useEffect(() => {
    if (!open || hi < 0) return;
    listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  const indexFor = (t: string) => {
    const r = resolve(options, t);
    if (r) return options.indexOf(r);
    const m = t ? findMatch(options, t) : null;
    return m ? m.index : options.findIndex((o) => o.id === value);
  };

  const openList = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setDropPos({ left: r.left, top: r.bottom, width: r.width });
    setHi(indexFor(text));
    setOpen(true);
  };

  const pick = (o: ComboOption) => {
    setText(o.label);
    setInvalid(false);
    setOpen(false);
    if (o.id !== value) onChange(o.id);
  };

  /** The box (via onNotFound) for text that is not on the list. */
  const askNotFound = (
    typed: string,
    handler: (text: string) => Promise<number | null>,
    // Where focus was going when the field was left (Tab to the next field), if anywhere.
    next: HTMLElement | null,
  ) => {
    asking.current = true;
    const p = (async () => {
      let id: number | null = null;
      try {
        id = await handler(typed);
      } catch {
        id = null;
      }
      asking.current = false;
      if (id !== null) {
        added.current = id;
        setInvalid(false);
        onChange(id);
        // The box may have opened before focus reached the next field; carry on there.
        const now = document.activeElement;
        if ((!now || now === document.body) && next?.isConnected) next.focus();
        return true;
      }
      const el = inputRef.current;
      if (el && el.isConnected) {
        el.focus();
        el.select();
      }
      return false;
    })();
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const commit = (mayAsk: boolean, next: HTMLElement | null = null) => {
    setOpen(false);
    const text = textRef.current;
    if (!text.trim()) {
      setText('');
      setInvalid(false);
      if (value !== null) onChange(null);
      return;
    }
    const o = resolve(options, text);
    if (o) {
      setText(o.label);
      setInvalid(false);
      if (o.id !== value) onChange(o.id);
    } else if (mayAsk && onNotFound && options.length === 0 && !asking.current) {
      // The list has not come from the server yet (she typed as the window opened): wait for
      // it before saying the name is not on it, or Quick Add would make a second one.
      waitForList(text.trim(), onNotFound, next);
    } else {
      setInvalid(true);
      if (value !== null) onChange(null);
      if (mayAsk && onNotFound && !asking.current) askNotFound(text.trim(), onNotFound, next);
    }
  };

  // Text left in the field before the list loaded: settled when the list comes (or after a
  // while, when the list really is empty). A save waits for it, as for a Quick Add box.
  const listWait = useRef<{ text: string; settle: () => void } | null>(null);
  const waitForList = (typed: string, handler: (text: string) => Promise<number | null>, next: HTMLElement | null) => {
    if (listWait.current) return;
    let timer = 0;
    const p = new Promise<boolean>((done) => {
      const settle = () => {
        window.clearTimeout(timer);
        listWait.current = null;
        // What Tab would have taken had the list been there: the name, or what QuickFill completes it to.
        const list = optionsRef.current;
        const m = findMatch(list, typed);
        const o = resolve(list, typed) ?? (m ? list[m.index] : null);
        if (o && textRef.current === typed) {
          setText(o.label);
          setInvalid(false);
          if (o.id !== valueRef.current) onChange(o.id);
          done(true);
          return;
        }
        if (textRef.current !== typed) {
          done(true); // she has typed something else since
          return;
        }
        setInvalid(true);
        askNotFound(typed, handler, next);
        done(true);
      };
      listWait.current = { text: typed, settle };
      timer = window.setTimeout(settle, 2500);
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (options.length > 0) listWait.current?.settle();
  }, [options]);

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const typed = el.value;
    const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
    setInvalid(false);
    // A selection left over from an earlier keystroke must never be applied to this one:
    // after "Acc" (completed to "Accumulated Depreciation", no re-render) it would select
    // the "o" of "Acco" and the next key would overwrite it ("Accunts").
    pendingSel.current = null;
    // Complete only while inserting at the end, never while deleting.
    if (inputType.startsWith('insert') && typed && el.selectionStart === typed.length) {
      const m = findMatch(options, typed);
      if (m) {
        const completed = typed + m.rest;
        const rerenders = completed !== textRef.current;
        setText(completed);
        // Apply to the DOM now as well: when the completion is the same text as before
        // (typing "h" after "C" already completed to "Checking") React does not re-render,
        // so the layout effect below would never restore the selection.
        el.value = completed;
        el.setSelectionRange(typed.length, completed.length);
        // Restore it after the render too (React rewrites the value), but only when one comes.
        if (rerenders) pendingSel.current = [typed.length, completed.length];
        setHi(m.index);
        return;
      }
    }
    setText(typed);
    const m = typed ? findMatch(options, typed) : null;
    setHi(m ? m.index : -1);
  };

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (open) setOpen(false);
      else openList();
      return;
    }
    if (!open) return;
    const n = options.length;
    const move = (d: number) => {
      e.preventDefault();
      e.stopPropagation();
      if (n) setHi((h) => Math.max(0, Math.min(n - 1, (h < 0 ? (d > 0 ? -1 : n) : h) + d)));
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(1);
      case 'ArrowUp':
        return move(-1);
      case 'PageDown':
        return move(8);
      case 'PageUp':
        return move(-8);
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (hi >= 0 && options[hi]) pick(options[hi]);
        else setOpen(false);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      case 'Tab':
        if (hi >= 0 && options[hi]) pick(options[hi]);
        setOpen(false);
        return;
    }
  };

  return (
    <span ref={wrapRef} className={`combo${invalid ? ' invalid' : ''}${className ? ` ${className}` : ''}`}>
      <input
        {...rest}
        ref={inputRef}
        type="text"
        className="field combo-input"
        value={text}
        autoComplete="off"
        aria-invalid={invalid}
        aria-expanded={open}
        onChange={handleInput}
        onKeyDown={handleKey}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
          onFocus?.(e);
        }}
        data-list={listName}
        onBlur={(e) => {
          focused.current = false;
          // No box when focus left because a message box opened, a window is closing, or she
          // went to another window (QuickBooks asks only on leaving the field within its form;
          // a box over the other window would take the keys she types there).
          const to = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
          const otherWindow = !!to && to.closest('.win') !== e.currentTarget.closest('.win');
          commit(!isQuietBlur() && !isModalOpen() && !to?.closest('.msgbox') && !otherWindow, to);
          onBlur?.(e);
        }}
      />
      <button
        type="button"
        className="combo-arrow"
        tabIndex={-1}
        disabled={rest.disabled}
        aria-label="Show list"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          inputRef.current?.focus();
          if (open) setOpen(false);
          else openList();
        }}
      >
        ▼
      </button>
      {open && dropPos && (
        <div
          ref={listRef}
          className="combo-drop"
          style={{ left: dropPos.left, top: dropPos.top, minWidth: dropPos.width }}
          onMouseDown={(e) => e.preventDefault()}
          role="listbox"
        >
          {options.map((o, i) => (
            <div
              key={o.id}
              role="option"
              aria-selected={i === hi}
              className={`combo-opt${i === hi ? ' hot' : ''}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o)}
            >
              {o.label}
            </div>
          ))}
          {options.length === 0 && <div className="combo-opt empty">(no entries)</div>}
        </div>
      )}
    </span>
  );
}
