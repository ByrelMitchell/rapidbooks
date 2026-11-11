import { evalAmount, formatMoney } from '@rapidbooks/shared';
import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | null; // cents
  onChange: (cents: number | null) => void;
};

const show = (v: number | null) => (v === null ? '' : formatMoney(v));

/** Right-aligned money field; accepts arithmetic ("3*12.50") like QuickBooks. */
export function AmountField({ value, onChange, className, onFocus, onBlur, ...rest }: Props) {
  const [text, setText] = useState(show(value));

  useEffect(() => {
    setText(show(value));
  }, [value]);

  return (
    <input
      {...rest}
      type="text"
      className={`field amount-field${className ? ` ${className}` : ''}`}
      value={text}
      inputMode="decimal"
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        e.target.select();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        if (text !== show(value)) {
          if (text.trim() === '') {
            onChange(null);
          } else {
            const cents = evalAmount(text);
            if (cents === null) {
              setText(show(value));
            } else {
              setText(formatMoney(cents));
              if (cents !== value) onChange(cents);
            }
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
