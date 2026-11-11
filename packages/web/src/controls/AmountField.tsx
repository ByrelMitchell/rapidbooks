import { evalAmount, formatMoney } from '@rapidbooks/shared';
import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | null; // cents (fractional when decimals > 2)
  onChange: (cents: number | null) => void;
  /** Decimal places of dollars accepted, 2 to 5 (piece prices can be fractions of a cent). Default 2. */
  decimals?: number;
};

/** Format cents as dollars, showing up to `decimals` places (never fewer than 2). */
export function formatAmount(cents: number, decimals = 2): string {
  if (decimals <= 2 || Number.isInteger(cents)) return formatMoney(Math.round(cents));
  const div = 10 ** decimals;
  const units = Math.round(Math.abs(cents) * 10 ** (decimals - 2)); // in 10^-decimals dollars
  const whole = Math.floor(units / div)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (units % div).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${cents < 0 && units > 0 ? '-' : ''}${whole}.${frac}`;
}

/** Evaluate typed amount or arithmetic into cents, keeping up to `decimals` places of dollars. */
export function parseAmount(text: string, decimals = 2): number | null {
  if (decimals <= 2) return evalAmount(text);
  const scale = 10 ** (decimals - 2);
  const v = evalAmount(`(${text})*${scale}`);
  return v === null ? null : v / scale;
}

const show = (v: number | null, decimals: number) => (v === null ? '' : formatAmount(v, decimals));

/** Right-aligned money field; accepts arithmetic ("3*12.50") like QuickBooks. */
export function AmountField({ value, onChange, decimals = 2, className, onFocus, onBlur, ...rest }: Props) {
  const [text, setText] = useState(show(value, decimals));

  useEffect(() => {
    setText(show(value, decimals));
  }, [value, decimals]);

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
        if (text !== show(value, decimals)) {
          if (text.trim() === '') {
            onChange(null);
          } else {
            const cents = parseAmount(text, decimals);
            if (cents === null) {
              setText(show(value, decimals));
            } else {
              setText(formatAmount(cents, decimals));
              if (cents !== value) onChange(cents);
            }
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
