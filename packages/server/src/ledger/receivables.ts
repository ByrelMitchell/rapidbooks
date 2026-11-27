import {
  addDays,
  type ApplyCreditsInput,
  type AvailableCredit,
  type DocSummary,
  type OpenInvoice,
  type PendingPayment,
  type TxnRef,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import {
  appliedFrom,
  appliedFromSql,
  appliedTo,
  appliedToSql,
  canPay,
  cap,
  invName,
  fullName,
  money,
  selfAndAncestors,
  selfAndDescendants,
  systemAccount,
  txnRow,
} from './common';

// Receivables: lists the sales forms need, and applying existing credits to invoices.
// Open balances and unapplied amounts are always computed from links.

/** Compare document numbers the way a person would: 9 < 10 < 10A < ABC. */
function numKey(num: string): [number, string] {
  const m = /^\d+/.exec(num);
  return [m ? Number(m[0]) : Number.MAX_SAFE_INTEGER, num];
}

/** Order by date, then number, then id. */
function byDateNum(a: { id: number; date: string; num: string }, b: { id: number; date: string; num: string }) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const [an, as] = numKey(a.num);
  const [bn, bs] = numKey(b.num);
  if (an !== bn) return an - bn;
  if (as !== bs) return as < bs ? -1 : 1;
  return a.id - b.id;
}

const inList = (ids: number[]) => `(${ids.map(() => '?').join(', ') || 'NULL'})`;

/**
 * Open invoices of a customer and its jobs, oldest first. With paymentId (editing a
 * payment), what that payment applied is added back, so its invoices stay listed and
 * open_balance is what is open apart from it. With arAccountId, only the invoices in that
 * Accounts Receivable account (the only ones a payment in it can pay).
 */
export function listOpenInvoices(db: DB, customerId: number, paymentId: number | null = null, arAccountId?: number): OpenInvoice[] {
  const names = selfAndDescendants(db, customerId);
  const rows = db
    .prepare(
      `SELECT t.id, t.num, t.date, t.due_date, t.name_id, t.total, t.is_finance_charge, t.terms_id,
              COALESCE(tm.discount_pct, 0) AS discount_pct, tm.discount_days,
              t.total - ${appliedToSql('t', true)} AS open_balance,
              COALESCE((SELECT SUM(l.amount) FROM links l WHERE l.kind = 'apply' AND l.to_txn = t.id AND l.from_txn = ?), 0) AS applied_by_payment,
              COALESCE((SELECT SUM(l.discount) FROM links l WHERE l.kind = 'apply' AND l.to_txn = t.id AND l.from_txn = ?), 0) AS discount_by_payment
         FROM txns t LEFT JOIN terms tm ON tm.id = t.terms_id
        WHERE t.type = 'INVOICE' AND t.name_id IN ${inList(names)} AND (? IS NULL OR t.ar_account_id = ?)
        ORDER BY t.date, t.id`,
    )
    .all(paymentId, paymentId, paymentId, ...names, arAccountId ?? null, arAccountId ?? null) as (Omit<OpenInvoice, 'is_finance_charge' | 'full_name' | 'discount_date'> & {
    is_finance_charge: number;
    discount_days: number | null;
  })[];
  return rows
    .filter((r) => r.open_balance > 0)
    .sort((a, b) => byDateNum(a, b))
    .map(({ discount_days, ...r }) => ({
      ...r,
      full_name: fullName(db, r.name_id),
      is_finance_charge: !!r.is_finance_charge,
      discount_date: r.discount_pct > 0 && discount_days !== null ? addDays(r.date, discount_days) : null,
    }));
}

/**
 * Unapplied payments and credit memos that could go to this customer's invoices: those
 * from the customer, its jobs, or a customer it belongs to. Oldest first.
 */
export function listCredits(db: DB, customerId: number): AvailableCredit[] {
  const names = [...new Set([...selfAndDescendants(db, customerId), ...selfAndAncestors(db, customerId)])];
  const rows = db
    .prepare(
      `SELECT t.id, t.type, t.num, t.date, t.name_id, t.memo, t.total,
              t.total - ${appliedFromSql('t')} AS unapplied
         FROM txns t
        WHERE t.type IN ('PAYMENT', 'CREDITMEMO') AND t.name_id IN ${inList(names)}
        ORDER BY t.date, t.id`,
    )
    .all(...names) as Omit<AvailableCredit, 'full_name'>[];
  return rows.filter((r) => r.unapplied > 0).map((r) => ({ ...r, full_name: fullName(db, r.name_id) }));
}

/**
 * Apply unapplied payments and credit memos to invoices. Only links are added (or
 * increased); nothing is posted, because the credit is already in A/R.
 */
export function applyCredits(db: DB, input: ApplyCreditsInput) {
  db.transaction(() => {
    for (const a of input.applications) {
      const from = txnRow(db, a.from_txn);
      const to = txnRow(db, a.to_txn);
      if (!from || !to) throw new AppError(400, 'One of those transactions no longer exists.');
      if (from.type !== 'PAYMENT' && from.type !== 'CREDITMEMO') {
        throw new AppError(400, 'Only payments and credit memos can be applied to invoices.');
      }
      if (to.type !== 'INVOICE') throw new AppError(400, 'Credits can only be applied to invoices.');
      if (!canPay(db, from.name_id!, to.name_id!)) {
        throw new AppError(
          400,
          `${cap(invName(to))} is for ${fullName(db, to.name_id)}, so a credit from ${fullName(db, from.name_id)} cannot be applied to it.`,
        );
      }
      if (from.ar_account_id !== to.ar_account_id) {
        throw new AppError(400, `${cap(invName(to))} is in a different Accounts Receivable account than the credit.`);
      }
      const available = from.total - appliedFrom(db, from.id);
      if (a.amount > available) {
        throw new AppError(400, `Only ${money(available)} of that ${from.type === 'PAYMENT' ? 'payment' : 'credit memo'} is left to apply.`);
      }
      const open = to.total - appliedTo(db, to.id);
      if (a.amount > open) {
        throw new AppError(400, `That is more than the open balance of ${invName(to)} (${money(open)}).`);
      }
      const existing = db
        .prepare("SELECT id FROM links WHERE kind = 'apply' AND from_txn = ? AND to_txn = ?")
        .get(from.id, to.id) as { id: number } | undefined;
      if (existing) db.prepare('UPDATE links SET amount = amount + ? WHERE id = ?').run(a.amount, existing.id);
      else {
        db.prepare("INSERT INTO links (from_txn, to_txn, kind, amount) VALUES (?, ?, 'apply', ?)").run(from.id, to.id, a.amount);
      }
      // The credit's own form now shows different applications.
      db.prepare('UPDATE txns SET version = version + 1 WHERE id = ?').run(from.id);
      db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run('apply', from.id, JSON.stringify(a));
    }
  })();
}

function docQueue(db: DB, where: string): DocSummary[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.type, t.num, t.date, t.name_id, n.email, t.total, t.emailed_at
         FROM txns t JOIN names n ON n.id = t.name_id
        WHERE t.type IN ('INVOICE', 'CREDITMEMO') AND ${where}
        ORDER BY t.date, t.id`,
    )
    .all() as Omit<DocSummary, 'full_name'>[];
  return rows.map((r) => ({ ...r, full_name: fullName(db, r.name_id) }));
}

/** Invoices and credit memos marked To be printed. */
export const listToPrint = (db: DB) => docQueue(db, 't.to_print = 1');
/** Invoices and credit memos marked To be e-mailed. */
export const listToEmail = (db: DB) => docQueue(db, 't.to_email = 1');

/**
 * Payments waiting in Undeposited Funds. With depositId (editing a deposit), the
 * payments already in that deposit are included and marked.
 */
export function listPendingPayments(db: DB, depositId: number | null = null): PendingPayment[] {
  const uf = systemAccount(db, 'UNDEPOSITED');
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.ref_no, t.pay_method, t.name_id, t.memo, t.total AS amount, d.from_txn AS deposit
         FROM txns t LEFT JOIN links d ON d.kind = 'deposit' AND d.to_txn = t.id
        WHERE t.type = 'PAYMENT' AND t.account_id = ? AND t.total <> 0 AND (d.from_txn IS NULL OR d.from_txn = ?)
        ORDER BY t.date, t.id`,
    )
    .all(uf, depositId) as (Omit<PendingPayment, 'full_name' | 'in_this_deposit'> & { deposit: number | null })[];
  return rows.map(({ deposit, ...r }) => ({
    ...r,
    full_name: fullName(db, r.name_id),
    in_this_deposit: deposit !== null,
  }));
}


/**
 * The previous and next transaction of the same type, ordered by date, then number,
 * then id (for the forms' Previous/Next buttons). Without an id (a new, unsaved form),
 * Previous is the last one and there is no Next.
 */
export function adjacentTxns(db: DB, type: string, id: number | null): { prev: number | null; next: number | null } {
  const rows = db.prepare('SELECT id, date, num FROM txns WHERE type = ?').all(type) as {
    id: number;
    date: string;
    num: string;
  }[];
  rows.sort(byDateNum);
  if (id === null) return { prev: rows.length ? rows[rows.length - 1].id : null, next: null };
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) throw new AppError(404, 'That transaction no longer exists.');
  return { prev: i > 0 ? rows[i - 1].id : null, next: i < rows.length - 1 ? rows[i + 1].id : null };
}

/** Transactions of a type with exactly this number (case-insensitive), newest first. */
export function findTxns(db: DB, type: string, num: string): TxnRef[] {
  return db
    .prepare(
      `SELECT id, type, date, num, name_id, total FROM txns
        WHERE type = ? AND num = ? COLLATE NOCASE ORDER BY date DESC, id DESC`,
    )
    .all(type, num.trim()) as TxnRef[];
}
