// All money is stored and computed as integer cents.

export function formatMoney(cents: number, opts: { blankZero?: boolean } = {}): string {
  if (cents === 0 && opts.blankZero) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Evaluate what was typed into an amount field. Accepts plain amounts
 * ("1,234.5", "$12") and arithmetic ("3*12.50+4", "(100-15)/2"), as the
 * QuickBooks amount fields do. Returns cents, or null if it isn't a valid amount.
 */
export function evalAmount(input: string): number | null {
  const src = input.replace(/[\s,$]/g, '');
  if (src === '') return null;
  let pos = 0;

  const peek = () => src[pos];
  function number(): number {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(pos));
    if (!m) throw new Error('number expected');
    pos += m[0].length;
    return parseFloat(m[0]);
  }
  function factor(): number {
    if (peek() === '-') { pos++; return -factor(); }
    if (peek() === '+') { pos++; return factor(); }
    if (peek() === '(') {
      pos++;
      const v = expr();
      if (peek() !== ')') throw new Error(') expected');
      pos++;
      return v;
    }
    return number();
  }
  function term(): number {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = src[pos++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[pos++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  try {
    const v = expr();
    if (pos !== src.length || !Number.isFinite(v)) return null;
    // Nudge before rounding so 1.005 and friends round half away from zero.
    const cents = Math.round(Math.abs(v) * 100 + 1e-7);
    return v < 0 ? -cents : cents;
  } catch {
    return null;
  }
}
