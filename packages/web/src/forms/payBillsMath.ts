// Pay Bills: how a selection of bills is paid. Everything is integer cents.
//
// For each bill:  credits used + discount + amount to pay  <=  open balance.
// The server applies the credits first, then checks payment + discount against what is left,
// so keeping this inequality on every row is all it needs.

export interface CreditUse {
  creditId: number;
  amount: number;
}

export interface PayRow {
  /** The bill. */
  id: number;
  /** Open balance of the bill (before anything chosen here), cents. */
  open: number;
  /** Amt. To Pay, cents. */
  pay: number;
  /** Disc. Used, cents. */
  discount: number;
  discountAccountId: number | null;
  /** Credits Used on this bill. */
  credits: CreditUse[];
}

export const creditsUsed = (r: PayRow) => r.credits.reduce((t, c) => t + c.amount, 0);

/** The most that can still be paid on a row: open balance less its discount and credits. */
export const payMax = (r: PayRow) => Math.max(0, r.open - r.discount - creditsUsed(r));

/** A row is ticked when anything is paid, discounted or credited on it. */
export const isSelected = (r: PayRow) => r.pay > 0 || r.discount > 0 || creditsUsed(r) > 0;

/** Space / click on ✓: a ticked row is cleared entirely; an unticked one pays its full open balance. */
export function toggle<R extends PayRow>(r: R): R {
  if (isSelected(r)) return { ...r, pay: 0, discount: 0, discountAccountId: null, credits: [] };
  return { ...r, pay: payMax(r) };
}

/** Amt. To Pay typed: kept between 0 and what the bill still owes. */
export function setPay<R extends PayRow>(r: R, cents: number | null): R {
  return { ...r, pay: Math.max(0, Math.min(cents ?? 0, payMax(r))) };
}

/**
 * A row's discount or credits changed: a row being paid in full (or not ticked yet) pays
 * its new full balance; a part payment keeps its amount, cut down if it no longer fits.
 */
function rebalance<R extends PayRow>(before: R, after: R): R {
  const full = !isSelected(before) || before.pay === payMax(before);
  return { ...after, pay: full ? payMax(after) : Math.min(before.pay, payMax(after)) };
}

export function setDiscount<R extends PayRow>(r: R, discount: number, accountId: number | null): R {
  const d = Math.max(0, Math.min(discount, r.open - creditsUsed(r)));
  return rebalance(r, { ...r, discount: d, discountAccountId: d > 0 ? accountId : null });
}

export function setCredits<R extends PayRow>(r: R, credits: CreditUse[]): R {
  return rebalance(r, { ...r, credits: credits.filter((c) => c.amount > 0) });
}

/** How much of each credit is used on rows other than `exceptId`. */
export function creditUseElsewhere(rows: PayRow[], exceptId: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) {
    if (r.id === exceptId) continue;
    for (const c of r.credits) m.set(c.creditId, (m.get(c.creditId) ?? 0) + c.amount);
  }
  return m;
}

/**
 * The list reloaded (filter, sort or payment date changed): keep what was chosen on bills
 * still listed, trimmed to their current open balances.
 */
export function mergeRows<R extends PayRow>(fresh: R[], old: PayRow[]): R[] {
  const prev = new Map(old.map((r) => [r.id, r]));
  return fresh.map((r) => {
    const o = prev.get(r.id);
    if (!o || !isSelected(o)) return r;
    let credits = o.credits;
    if (credits.reduce((t, c) => t + c.amount, 0) > r.open) credits = [];
    const discount = Math.min(o.discount, r.open - credits.reduce((t, c) => t + c.amount, 0));
    const next = { ...r, credits, discount, discountAccountId: discount > 0 ? o.discountAccountId : null };
    return { ...next, pay: Math.min(o.pay, payMax(next)) };
  });
}

export function totals(rows: PayRow[]) {
  let open = 0;
  let discount = 0;
  let credits = 0;
  let pay = 0;
  for (const r of rows) {
    open += r.open;
    discount += r.discount;
    credits += creditsUsed(r);
    pay += r.pay;
  }
  return { open, discount, credits, pay };
}
