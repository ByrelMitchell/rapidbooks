import { applyDateKey, formatUsDate, parseUsDate } from '@rapidbooks/shared';
import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type Ref } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string; // ISO date
  onChange: (iso: string) => void;
  ref?: Ref<HTMLInputElement>;
};

/** MM/DD/YYYY date field with the QuickBooks date keys (+ - T W K M H Y R). */
export function DateField({ value, onChange, className, onKeyDown, onFocus, onBlur, ref: outerRef, ...rest }: Props) {
  const [text, setText] = useState(formatUsDate(value));
  const ref = useRef<HTMLInputElement>(null);
  const selectNext = useRef(false);

  useEffect(() => {
    setText(formatUsDate(value));
  }, [value]);

  useEffect(() => {
    if (selectNext.current) {
      selectNext.current = false;
      ref.current?.select();
    }
  });

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1) return;
    const base = parseUsDate(text) ?? value;
    const next = applyDateKey(base, e.key);
    if (next === null) return;
    e.preventDefault();
    setText(formatUsDate(next));
    selectNext.current = true;
    if (next !== value) onChange(next);
  };

  return (
    <input
      {...rest}
      ref={(el) => {
        ref.current = el;
        if (typeof outerRef === 'function') outerRef(el);
        else if (outerRef) outerRef.current = el;
      }}
      type="text"
      className={`field date-field${className ? ` ${className}` : ''}`}
      value={text}
      inputMode="numeric"
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        e.target.select();
        onFocus?.(e);
      }}
      onKeyDown={handleKey}
      onBlur={(e) => {
        if (text !== formatUsDate(value)) {
          const iso = parseUsDate(text);
          if (iso) {
            setText(formatUsDate(iso));
            if (iso !== value) onChange(iso);
          } else {
            setText(formatUsDate(value));
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
