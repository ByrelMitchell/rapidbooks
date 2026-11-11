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

/** Round to the nearest integer, halves away from zero (2.5 -> 3, -2.5 -> -3). */
export function roundHalfAway(x: number): number {
  const r = Math.round(Math.abs(x) + 1e-9);
  return x < 0 && r !== 0 ? -r : r;
}

const QTY_PLACES = 6n;
const RATE_PLACES = 3n;

function scaled(n: number, places: bigint): bigint {
  return BigInt(Math.round(n * 10 ** Number(places)));
}

/** Integer division of a by b, rounding halves away from zero. */
function divRound(a: bigint, b: bigint): bigint {
  const neg = a < 0n !== b < 0n;
  const aa = a < 0n ? -a : a;
  const bb = b < 0n ? -b : b;
  let q = aa / bb;
  if ((aa % bb) * 2n >= bb) q += 1n;
  return neg ? -q : q;
}

/**
 * The amount of a document line in cents: qty × rate, rounded half away from zero.
 * rate is cents and may carry up to 3 decimals (piece prices like $0.0375 = 3.75);
 * qty may carry up to 6 decimals. Computed exactly, without floating-point drift.
 * A blank qty counts as 1, as on QuickBooks forms.
 */
export function lineAmount(qty: number | null, rate: number): number {
  const q = scaled(qty ?? 1, QTY_PLACES);
  const r = scaled(rate, RATE_PLACES);
  return Number(divRound(q * r, 10n ** (QTY_PLACES + RATE_PLACES)));
}

/** pct basis points of `cents` (10% = 1000), rounded half away from zero. */
export function percentOf(cents: number, bp: number): number {
  return Number(divRound(BigInt(cents) * scaled(bp, RATE_PLACES), 10000n * 10n ** RATE_PLACES));
}

/**
 * Format a rate held in cents that may carry fractions of a cent: at least two
 * decimals of dollars, more only when needed ("12.50", "0.0375").
 */
export function formatRate(cents: number): string {
  const neg = cents < 0;
  const thousandths = Math.round(Math.abs(cents) * 1000); // 1/1000 cent = $0.00001
  const whole = Math.floor(thousandths / 100000);
  let frac = (thousandths % 100000).toString().padStart(5, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${w}.${frac}`;
}
