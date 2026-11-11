// Receive Payments: how a payment is spread over the customer's open invoices.
// Everything is integer cents; nothing here uses fractions.

export interface ApplyRow {
  /** Amount due on the invoice apart from this payment (open balance), cents. */
  due: number;
  /** This payment's discount on the invoice, cents. */
  discount: number;
  /** This payment's amount applied to the invoice, cents. */
  payment: number;
}

/** The most this payment can put on a row: what is due after the row's discount. */
export const payable = (r: ApplyRow) => Math.max(0, r.due - r.discount);

export const totalApplied = (rows: ApplyRow[]) => rows.reduce((t, r) => t + r.payment, 0);

/**
 * QuickBooks auto-apply: clear every payment, then put the amount on an invoice whose
 * amount due (after its discount) is exactly the amount, if there is one; otherwise
 * (and with anything left over) on the invoices oldest first, each up to what it owes.
 * Rows must be in oldest-first order. Discounts are kept.
 */
export function autoApply<R extends ApplyRow>(rows: R[], amount: number): R[] {
  const out = rows.map((r) => ({ ...r, payment: 0 }));
  let left = Math.max(0, amount);
  if (left === 0) return out;
  const exact = out.findIndex((r) => payable(r) === left);
  if (exact >= 0) {
    out[exact].payment = left;
    return out;
  }
  for (const r of out) {
    if (left === 0) break;
    const put = Math.min(left, payable(r));
    r.payment = put;
    left -= put;
  }
  return out;
}

/**
 * Space on a row: a row with a payment is cleared; otherwise it gets as much as is left
 * of the amount (up to what it owes). When nothing is left, the row gets all it owes and
 * the amount goes up by that much, as QuickBooks does when invoices are ticked first.
 * Returns the new rows and the new amount.
 */
export function toggleRow<R extends ApplyRow>(rows: R[], i: number, amount: number): { rows: R[]; amount: number } {
  const out = rows.map((r) => ({ ...r }));
  const r = out[i];
  if (r.payment > 0) {
    r.payment = 0;
    return { rows: out, amount };
  }
  const left = amount - totalApplied(out);
  const max = payable(r);
  if (left > 0) {
    r.payment = Math.min(left, max);
    return { rows: out, amount };
  }
  r.payment = max;
  return { rows: out, amount: Math.max(amount, totalApplied(out)) };
}
