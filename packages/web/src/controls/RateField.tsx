import { evalAmount } from '@rapidbooks/shared';
import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { formatAmount, parseAmount } from './AmountField';

export interface Rate {
  /** Cents (up to 3 decimals: $0.00001), or basis points when percent (10% = 1000). */
  rate: number;
  percent: boolean;
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: Rate;
  onChange: (v: Rate) => void;
};

/** Basis points as a percentage: 1000 -> "10%", 250 -> "2.5%". */
export function formatPercent(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** An item price or rate as the item list shows it. */
export function formatRate(v: Rate): string {
  return v.percent ? formatPercent(v.rate) : formatAmount(v.rate, 5);
}

/** Parse "12.50", "0.03755", "3*1.25" (money, up to 5 decimals) or "10%" / "2.5%" (percent). */
export function parseRate(text: string): Rate | null {
  const t = text.trim();
  if (t === '') return { rate: 0, percent: false };
  if (t.endsWith('%')) {
    const bp = evalAmount(t.slice(0, -1)); // hundredths of a percent = basis points
    return bp === null ? null : { rate: bp, percent: true };
  }
  const cents = parseAmount(t, 5);
  return cents === null ? null : { rate: cents, percent: false };
}

/**
 * Rate or price field: money with up to five decimal places, or a percentage when
 * the text ends in "%". (Whether a percentage is allowed is the item type's business;
 * the server says so if it is not.)
 */
export function RateField({ value, onChange, className, onFocus, onBlur, ...rest }: Props) {
  const [text, setText] = useState(formatRate(value));

  useEffect(() => {
    setText(formatRate(value));
  }, [value.rate, value.percent]);

  return (
    <input
      {...rest}
      type="text"
      className={`field amount-field${className ? ` ${className}` : ''}`}
      value={text}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => {
        e.target.select();
        onFocus?.(e);
      }}
      onBlur={(e) => {
        if (text !== formatRate(value)) {
          const v = parseRate(text);
          if (v === null) {
            setText(formatRate(value));
          } else {
            setText(formatRate(v));
            if (v.rate !== value.rate || v.percent !== value.percent) onChange(v);
          }
        }
        onBlur?.(e);
      }}
    />
  );
}
