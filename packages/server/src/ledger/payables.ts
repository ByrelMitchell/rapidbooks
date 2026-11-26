import {
  addDays,
  percentOf,
  todayIso,
  type AssignCheckNumbersInput,
  type BillPaymentInput,
  type CheckNumUse,
  type CheckToPrint,
  type OpenPurchaseOrder,
  type PayBillsInput,
  type PayBillsResult,
  type PayrollItemKind,
  type PayrollSummaryRow,
  type PurchTxn,
  type TxnRef,
  type UnpaidBill,
  type VendorCredit,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { accountRow, appliedFrom, appliedFromSql, appliedTo, appliedToSql, cap, fullName, money, nameRow, txnRow } from './common';
import { getTxn, nextNum, saveTxn } from './posting';
import { billName, CHECK_TYPES } from './purchasing';

// Payables and banking: the lists the purchase forms need, Pay Bills, check numbering
// and printing queues, and payroll summaries. Open balances and unapplied amounts are
// always computed from links, never stored.

const inList = (ids: unknown[]) => `(${ids.map(() => '?').join(', ') || 'NULL'})`;
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** Open (not closed) purchase orders, oldest first, optionally of one vendor. */
export function listOpenPurchaseOrders(db: DB, vendorId: number | null = null): OpenPurchaseOrder[] {
  const rows = db
    .prepare(
      `SELECT id, num, date, expected_date, name_id, memo, total FROM txns
        WHERE type = 'PURCHORD' AND closed = 0 AND (? IS NULL OR name_id = ?)
        ORDER BY date, id`,
    )
    .all(vendorId, vendorId) as Omit<OpenPurchaseOrder, 'full_name'>[];
  return rows.map((r) => ({ ...r, full_name: fullName(db, r.name_id) }));
}

/** Unapplied bill credits and bill payments of a vendor (or of every vendor), oldest first. */
export function listVendorCredits(db: DB, vendorId: number | null): VendorCredit[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.type, t.num, t.date, t.name_id, t.ap_account_id, t.memo, t.total,
              t.total - ${appliedFromSql('t')} AS unapplied
         FROM txns t
        WHERE t.type IN ('BILLCREDIT', 'BILLPMT') AND (? IS NULL OR t.name_id = ?)
        ORDER BY t.date, t.id`,
    )
    .all(vendorId, vendorId) as Omit<VendorCredit, 'full_name'>[];
  return rows.filter((r) => r.unapplied > 0).map((r) => ({ ...r, full_name: fullName(db, r.name_id) }));
}

export interface UnpaidBillsQuery {
  due_on_or_before?: string | null; // null = all bills
  vendor_id?: number | null;
  sort?: 'due_date' | 'vendor';
  pay_date?: string | null; // for the suggested discount; default today
  payment_id?: number | null; // editing a bill payment: add back what it applied
}

/** Bills with an open balance, for Pay Bills. */
export function listUnpaidBills(db: DB, q: UnpaidBillsQuery = {}): UnpaidBill[] {
  const paymentId = q.payment_id ?? null;
  const vendorId = q.vendor_id ?? null;
  const payDate = q.pay_date ?? todayIso();
  const rows = db
    .prepare(
      `SELECT t.id, t.ref_no, t.date, t.due_date, t.name_id, t.ap_account_id, t.memo, t.total, t.terms_id,
              COALESCE(tm.discount_pct, 0) AS discount_pct, tm.discount_days,
              t.total - ${appliedToSql('t', true)} AS open_balance,
              COALESCE((SELECT SUM(l.amount) FROM links l WHERE l.kind = 'apply' AND l.to_txn = t.id AND l.from_txn = ?), 0) AS applied_by_payment,
              COALESCE((SELECT SUM(l.discount) FROM links l WHERE l.kind = 'apply' AND l.to_txn = t.id AND l.from_txn = ?), 0) AS discount_by_payment
         FROM txns t LEFT JOIN terms tm ON tm.id = t.terms_id
        WHERE t.type = 'BILL' AND (? IS NULL OR t.name_id = ?)
          AND (? IS NULL OR (CASE WHEN t.due_date = '' THEN t.date ELSE t.due_date END) <= ?)`,
    )
    .all(paymentId, paymentId, paymentId, vendorId, vendorId, q.due_on_or_before ?? null, q.due_on_or_before ?? null) as (Omit<
    UnpaidBill,
    'full_name' | 'discount_date' | 'suggested_discount' | 'credits_available'
  > & { discount_days: number | null })[];

  const credits = new Map<number, number>();
  for (const c of listVendorCredits(db, vendorId)) credits.set(c.name_id, (credits.get(c.name_id) ?? 0) + c.unapplied);

  const out: UnpaidBill[] = rows
    .filter((r) => r.open_balance > 0 || r.applied_by_payment > 0 || r.discount_by_payment > 0)
    .map(({ discount_days, ...r }) => {
      const discount_date = r.discount_pct > 0 && discount_days !== null ? addDays(r.date, discount_days) : null;
      return {
        ...r,
        due_date: r.due_date || r.date,
        full_name: fullName(db, r.name_id),
        discount_date,
        suggested_discount: discount_date !== null && payDate <= discount_date ? percentOf(r.open_balance, r.discount_pct) : 0,
        credits_available: credits.get(r.name_id) ?? 0,
      };
    });
  const byDue = (a: UnpaidBill, b: UnpaidBill) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0);
  const byDate = (a: UnpaidBill, b: UnpaidBill) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.id - b.id;
  out.sort((a, b) =>
    q.sort === 'vendor'
      ? byName(a.full_name, b.full_name) || byDue(a, b) || byDate(a, b)
      : byDue(a, b) || byName(a.full_name, b.full_name) || byDate(a, b),
  );
  return out;
}

/**
 * Pay Bills. Applies the chosen credits (links only; nothing is posted, because the credit
 * is already in A/P), then writes one bill payment per vendor and A/P account, in vendor
 * order, numbering the checks from first_check_num. All or nothing.
 */
export function payBills(db: DB, input: PayBillsInput): PayBillsResult {
  return db.transaction(() => {
    const bank = accountRow(db, input.account_id);
    if (!bank) throw new AppError(400, 'The account to pay from no longer exists.');
    const paying = input.payments.filter((p) => p.amount !== 0 || p.discount !== 0);
    if (paying.length === 0 && input.credits.length === 0) throw new AppError(400, 'Choose at least one bill to pay.');

    // Credits first, so the payments see the reduced open balances.
    for (const c of input.credits) {
      const credit = txnRow(db, c.credit_id);
      const bill = txnRow(db, c.bill_id);
      if (!credit || !bill) throw new AppError(400, 'One of those bills or credits no longer exists.');
      if (credit.type !== 'BILLCREDIT' && credit.type !== 'BILLPMT') throw new AppError(400, 'Only bill credits and bill payments can be applied to bills.');
      if (bill.type !== 'BILL') throw new AppError(400, 'Credits can only be applied to bills.');
      if (credit.name_id !== bill.name_id) {
        throw new AppError(400, `${cap(billName(db, bill))} is not from the same vendor as ${billName(db, credit)}, so the credit cannot be applied to it.`);
      }
      if (credit.ap_account_id !== bill.ap_account_id) {
        throw new AppError(400, `${cap(billName(db, bill))} is in a different Accounts Payable account than the credit.`);
      }
      const available = credit.total - appliedFrom(db, credit.id);
      if (c.amount > available) throw new AppError(400, `Only ${money(available)} of ${billName(db, credit)} is left to apply.`);
      const open = bill.total - appliedTo(db, bill.id);
      if (c.amount > open) throw new AppError(400, `That is more than the open balance of ${billName(db, bill)} (${money(open)}).`);
      const existing = db
        .prepare("SELECT id FROM links WHERE kind = 'apply' AND from_txn = ? AND to_txn = ?")
        .get(credit.id, bill.id) as { id: number } | undefined;
      if (existing) db.prepare('UPDATE links SET amount = amount + ? WHERE id = ?').run(c.amount, existing.id);
      else db.prepare("INSERT INTO links (from_txn, to_txn, kind, amount) VALUES (?, ?, 'apply', ?)").run(credit.id, bill.id, c.amount);
      db.prepare('UPDATE txns SET version = version + 1 WHERE id = ?').run(credit.id);
      db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run('apply', credit.id, JSON.stringify(c));
    }

    // One payment per vendor and A/P account.
    const groups = new Map<string, { vendor: number; ap: number; apps: BillPaymentInput['applications'] }>();
    const seen = new Set<number>();
    for (const p of paying) {
      if (seen.has(p.bill_id)) throw new AppError(400, 'The same bill is listed twice.');
      seen.add(p.bill_id);
      const bill = txnRow(db, p.bill_id);
      if (!bill || bill.type !== 'BILL') throw new AppError(400, 'One of the bills to pay no longer exists.');
      const key = `${bill.name_id}:${bill.ap_account_id}`;
      const g = groups.get(key) ?? { vendor: bill.name_id!, ap: bill.ap_account_id!, apps: [] };
      g.apps.push({ txn_id: bill.id, amount: p.amount, discount: p.discount, discount_account_id: p.discount_account_id });
      groups.set(key, g);
    }
    const ordered = [...groups.values()].sort((a, b) => byName(fullName(db, a.vendor), fullName(db, b.vendor)) || a.ap - b.ap);

    const numbered = input.method === 'check' && !input.to_print;
    let num = 0;
    if (numbered) {
      const first = input.first_check_num.trim() || nextNum(db, 'CHECK', input.account_id);
      if (!/^\d+$/.test(first)) throw new AppError(400, 'The first check number must be a number.');
      num = Number(first);
    }

    const result: PayBillsResult = { payments: [] };
    for (const g of ordered) {
      const amount = g.apps.reduce((t, a) => t + a.amount, 0);
      const vendor = nameRow(db, g.vendor)!;
      // A payment of only a discount writes no check, so it takes no number.
      const checkNum = numbered && amount > 0 ? String(num++) : '';
      const { id } = saveTxn(db, {
        type: 'BILLPMT',
        date: input.date,
        num: checkNum,
        to_print: input.method === 'check' && input.to_print && amount > 0,
        name_id: g.vendor,
        memo: input.memo,
        account_id: input.account_id,
        ap_account_id: g.ap,
        pay_method: input.method,
        address: vendor.bill_addr,
        amount,
        applications: g.apps,
      });
      result.payments.push({ id, name_id: g.vendor, num: checkNum, amount });
    }
    return result;
  })();
}

/** Checks, bill payments and paychecks on a bank account with this number (a warning, not a refusal). */
export function checkNumUse(db: DB, accountId: number, num: string, exceptId: number | null = null): CheckNumUse {
  const n = num.trim();
  if (n === '') return { used: false, txns: [] };
  const txns = db
    .prepare(
      `SELECT id, type, date, num, name_id, total FROM txns
        WHERE type IN ${inList(CHECK_TYPES)} AND account_id = ? AND num = ? COLLATE NOCASE AND id IS NOT ?
        ORDER BY date DESC, id DESC`,
    )
    .all(...CHECK_TYPES, accountId, n, exceptId) as TxnRef[];
  return { used: txns.length > 0, txns };
}

/** Checks, bill payments and paychecks marked To be printed, optionally on one bank account. */
export function listChecksToPrint(db: DB, accountId: number | null = null): CheckToPrint[] {
  const rows = db
    .prepare(
      `SELECT id, type, date, account_id, name_id, total AS amount FROM txns
        WHERE type IN ${inList(CHECK_TYPES)} AND to_print = 1 AND (? IS NULL OR account_id = ?)
        ORDER BY date, id`,
    )
    .all(...CHECK_TYPES, accountId, accountId) as Omit<CheckToPrint, 'full_name'>[];
  return rows.map((r) => ({ ...r, full_name: fullName(db, r.name_id) }));
}

/**
 * Give checks marked To be printed their numbers, in the order given, starting from
 * first_num, and clear the mark. No ledger posting changes.
 */
export function assignCheckNumbers(db: DB, input: AssignCheckNumbersInput): { id: number; num: string }[] {
  return db.transaction(() => {
    let n = Number(input.first_num);
    const out: { id: number; num: string }[] = [];
    const seen = new Set<number>();
    for (const id of input.txn_ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = txnRow(db, id);
      if (!t) throw new AppError(400, 'One of those checks no longer exists.');
      if (!CHECK_TYPES.includes(t.type)) throw new AppError(400, 'Only checks, bill payments and paychecks can be given check numbers.');
      if (t.type === 'BILLPMT' && t.pay_method === 'other') throw new AppError(400, 'That bill payment was not paid by check.');
      const num = String(n++);
      db.prepare("UPDATE txns SET num = ?, to_print = 0, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(num, id);
      db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run('number', id, JSON.stringify({ num }));
      out.push({ id, num });
    }
    return out;
  })();
}

// ---------------------------------------------------------------------------
// Payroll

/** The employee's most recent paycheck (the form copies it forward), or null. */
export function lastPaycheck(db: DB, employeeId: number): PurchTxn | null {
  const r = db
    .prepare("SELECT id FROM txns WHERE type = 'PAYCHECK' AND name_id = ? ORDER BY date DESC, id DESC LIMIT 1")
    .get(employeeId) as { id: number } | undefined;
  return r ? (getTxn(db, r.id) as PurchTxn) : null;
}

const KIND_ORDER: Record<PayrollItemKind, number> = { earning: 0, deduction: 1, company: 2 };

/**
 * Paycheck totals per employee and payroll item for paychecks dated from..to. With
 * throughTxn, paychecks dated `to` count only up to and including that one (the pay
 * stub's year-to-date column).
 */
export function payrollSummary(
  db: DB,
  from: string,
  to: string,
  employeeId: number | null = null,
  throughTxn: number | null = null,
): PayrollSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT t.name_id AS employee_id, l.payroll_item_id, p.name AS payroll_item, p.kind,
              COALESCE(SUM(l.qty), 0) AS hours, SUM(l.amount) AS amount
         FROM lines l JOIN txns t ON t.id = l.txn_id JOIN payroll_items p ON p.id = l.payroll_item_id
        WHERE t.type = 'PAYCHECK' AND t.date >= ? AND t.date <= ? AND (? IS NULL OR t.name_id = ?)
          AND (? IS NULL OR t.date < ? OR t.id <= ?)
        GROUP BY t.name_id, l.payroll_item_id`,
    )
    .all(from, to, employeeId, employeeId, throughTxn, to, throughTxn) as Omit<PayrollSummaryRow, 'employee'>[];
  return rows
    .map((r) => ({ ...r, employee: fullName(db, r.employee_id) }))
    .sort(
      (a, b) =>
        byName(a.employee, b.employee) || a.employee_id - b.employee_id || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a.payroll_item, b.payroll_item),
    );
}
