import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { useLiveState } from '../util';

export interface ComboOption {
  id: number;
  label: string;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  options: ComboOption[];
  value: number | null;
  onChange: (id: number | null) => void;
};

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
export function Combo({ options, value, onChange, className, onKeyDown, onFocus, onBlur, ...rest }: Props) {
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

  // Follow the value when it changes from outside (or when the options finish loading).
  useEffect(() => {
    if (focused.current) return;
    if (value === null && invalidRef.current) return; // keep showing what was typed wrong
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

  const commit = () => {
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
    } else {
      setInvalid(true);
      if (value !== null) onChange(null);
    }
  };

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const typed = el.value;
    const inputType = (e.nativeEvent as InputEvent).inputType ?? '';
    setInvalid(false);
    // Complete only while inserting at the end, never while deleting.
    if (inputType.startsWith('insert') && typed && el.selectionStart === typed.length) {
      const m = findMatch(options, typed);
      if (m) {
        const completed = typed + m.rest;
        setText(completed);
        // Apply to the DOM now as well: when the completion is the same text as before
        // (typing "h" after "C" already completed to "Checking") React does not re-render,
        // so the layout effect below would never restore the selection.
        el.value = completed;
        el.setSelectionRange(typed.length, completed.length);
        pendingSel.current = [typed.length, completed.length];
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
        onBlur={(e) => {
          focused.current = false;
          commit();
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
