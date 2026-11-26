import { formatMoney, formatUsDate } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

// Small lookups shared by the posting engine, receivables, statements and PDFs.

export type SystemRole = 'AR' | 'AP' | 'UNDEPOSITED' | 'OPENING_EQUITY' | 'RETAINED';

const ROLE_LABEL: Record<SystemRole, string> = {
  AR: 'Accounts Receivable',
  AP: 'Accounts Payable',
  UNDEPOSITED: 'Undeposited Funds',
  OPENING_EQUITY: 'Opening Bal Equity',
  RETAINED: 'Retained Earnings',
};

export function systemAccount(db: DB, role: SystemRole): number {
  const r = db.prepare('SELECT id FROM accounts WHERE system_role = ?').get(role) as { id: number } | undefined;
  if (!r) throw new AppError(500, `The ${ROLE_LABEL[role]} account is missing from the chart of accounts.`);
  return r.id;
}

export interface AccountRow {
  id: number;
  name: string;
  type: string;
  system_role: string | null;
}

export function accountRow(db: DB, id: number): AccountRow | undefined {
  return db.prepare('SELECT id, name, type, system_role FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export interface NameRow {
  id: number;
  kind: string;
  name: string;
  parent_id: number | null;
  email: string;
  bill_addr: string;
  ship_addr: string;
  terms_id: number | null;
  contact: string;
  first_name: string;
  last_name: string;
  salutation: string;
  company: string;
}

export function nameRow(db: DB, id: number): NameRow | undefined {
  return db.prepare('SELECT * FROM names WHERE id = ?').get(id) as NameRow | undefined;
}

/** Customer:Job style full name. */
export function fullName(db: DB, id: number | null): string {
  if (id === null) return '';
  const parts: string[] = [];
  let p: number | null = id;
  const get = db.prepare('SELECT name, parent_id FROM names WHERE id = ?');
  while (p !== null) {
    const r = get.get(p) as { name: string; parent_id: number | null } | undefined;
    if (!r) break;
    parts.unshift(r.name);
    p = r.parent_id;
  }
  return parts.join(':');
}

/** The name itself and its parents, nearest first. */
export function selfAndAncestors(db: DB, id: number): number[] {
  const out: number[] = [];
  let p: number | null = id;
  const get = db.prepare('SELECT parent_id FROM names WHERE id = ?');
  while (p !== null && !out.includes(p)) {
    out.push(p);
    p = ((get.get(p) as { parent_id: number | null } | undefined)?.parent_id ?? null) as number | null;
  }
  return out;
}

/** The name itself and all its jobs (and their jobs). */
export function selfAndDescendants(db: DB, id: number): number[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT n.id FROM names n JOIN tree t ON n.parent_id = t.id)
       SELECT id FROM tree`,
    )
    .all(id) as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Whether money received from `payer` may pay a document for `customer`: the payer
 * must be that customer or job itself, or a customer it belongs to.
 */
export function canPay(db: DB, payer: number, customer: number): boolean {
  return selfAndAncestors(db, customer).includes(payer);
}

export function requireCustomer(db: DB, id: number | null): NameRow {
  if (id === null) throw new AppError(400, 'Choose a customer.');
  const n = nameRow(db, id);
  if (!n) throw new AppError(400, 'That customer no longer exists.');
  if (n.kind !== 'customer') throw new AppError(400, `${n.name} is not a customer. Choose a customer or job.`);
  return n;
}

export const money = (cents: number) => `$${formatMoney(cents)}`;

export interface TxnHeaderRow {
  id: number;
  type: string;
  date: string;
  num: string;
  name_id: number | null;
  memo: string;
  version: number;
  terms_id: number | null;
  due_date: string;
  po_number: string;
  ship_date: string;
  ship_via: string;
  bill_addr: string;
  ship_addr: string;
  message: string;
  to_print: number;
  to_email: number;
  emailed_at: string | null;
  pay_method: string;
  ref_no: string;
  account_id: number | null;
  ar_account_id: number | null;
  is_finance_charge: number;
  total: number;
  ap_account_id: number | null;
  to_account_id: number | null;
  expected_date: string;
  closed: number;
  period_from: string;
  period_to: string;
  // History import (migration 005); see ledger/posting.ts importWriter.
  import_locked?: number;
  import_note?: string;
  qb_type?: string;
  qb_trans_no?: string;
}

export function txnRow(db: DB, id: number): TxnHeaderRow | undefined {
  return db.prepare('SELECT * FROM txns WHERE id = ?').get(id) as TxnHeaderRow | undefined;
}

/**
 * Amount applied to an invoice (payments, credits and discounts), optionally leaving out
 * one source. With asOf, only applications in effect on that date count (an application
 * takes effect on the later of the two documents' dates).
 */
export function appliedTo(db: DB, invoiceId: number, exceptFrom: number | null = null, asOf?: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(l.amount + l.discount), 0) AS n
         FROM links l JOIN txns f ON f.id = l.from_txn JOIN txns t ON t.id = l.to_txn
        WHERE l.kind = 'apply' AND l.to_txn = ? AND l.from_txn IS NOT ? AND (? IS NULL OR MAX(f.date, t.date) <= ?)`,
    )
    .get(invoiceId, exceptFrom, asOf ?? null, asOf ?? null) as { n: number };
  return r.n;
}

/*
 * The same sums as appliedTo / appliedFrom (without asOf), as SQL over a txns row `t`, for
 * queries that list many documents at once. `except` adds a `l.from_txn IS NOT ?` parameter
 * (appliedTo's exceptFrom). Keep these and the two functions in step.
 */
export const appliedToSql = (t: string, except = false) =>
  `COALESCE((SELECT SUM(l.amount + l.discount) FROM links l WHERE l.kind = 'apply' AND l.to_txn = ${t}.id${except ? ' AND l.from_txn IS NOT ?' : ''}), 0)`;
export const appliedFromSql = (t: string) => `COALESCE((SELECT SUM(l.amount) FROM links l WHERE l.kind = 'apply' AND l.from_txn = ${t}.id), 0)`;

/** SQL: what is still open on `t`: unpaid on an invoice or bill, unapplied on a payment or credit; NULL for other types. */
export const openBalanceSql = (t: string) =>
  `CASE WHEN ${t}.type IN ('INVOICE', 'BILL') THEN ${t}.total - ${appliedToSql(t)}
        WHEN ${t}.type IN ('PAYMENT', 'CREDITMEMO', 'BILLPMT', 'BILLCREDIT') THEN ${t}.total - ${appliedFromSql(t)} END`;

/** Amount of a payment or credit memo applied to invoices. */
export function appliedFrom(db: DB, fromId: number, asOf?: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(l.amount), 0) AS n
         FROM links l JOIN txns f ON f.id = l.from_txn JOIN txns t ON t.id = l.to_txn
        WHERE l.kind = 'apply' AND l.from_txn = ? AND (? IS NULL OR MAX(f.date, t.date) <= ?)`,
    )
    .get(fromId, asOf ?? null, asOf ?? null) as { n: number };
  return r.n;
}

/** The deposit a payment is in, if any. */
export function depositOf(db: DB, paymentId: number): number | null {
  const r = db.prepare("SELECT from_txn FROM links WHERE kind = 'deposit' AND to_txn = ?").get(paymentId) as
    | { from_txn: number }
    | undefined;
  return r?.from_txn ?? null;
}

/** "invoice 1001", or "the invoice of 01/10/2026" when it has no number. */
export const invName = (t: { num: string; date: string }) =>
  t.num ? `invoice ${t.num}` : `the invoice of ${formatUsDate(t.date)}`;

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
