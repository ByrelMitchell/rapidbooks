import {
  formatMoney,
  formatUsDate,
  type Aging,
  type Statement,
  type StatementCustomer,
  type StatementRow,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { appliedTo, fullName, nameRow, selfAndDescendants } from './common';

// Customer statements, computed on demand from A/R splits (never stored).

const inList = (ids: number[]) => `(${ids.map(() => '?').join(', ')})`;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** Which aging column an amount due on `due` falls in, as of `asOf`. */
export function agingBucket(due: string, asOf: string): keyof Aging {
  const late = daysBetween(due, asOf);
  if (late <= 0) return 'current';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'over_90';
}

interface ArTxn {
  txn_id: number;
  date: string;
  type: string;
  num: string;
  name_id: number | null;
  memo: string;
  due_date: string;
  ref_no: string;
  is_finance_charge: number;
  total: number;
  amount: number;
}

function arActivity(db: DB, names: number[], to: string): ArTxn[] {
  return db
    .prepare(
      `SELECT t.id AS txn_id, t.date, t.type, t.num, COALESCE(s.name_id, t.name_id) AS name_id, t.memo, t.due_date,
              t.ref_no, t.is_finance_charge, t.total, SUM(s.amount) AS amount
         FROM splits s
         JOIN txns t ON t.id = s.txn_id
         JOIN accounts a ON a.id = s.account_id
        WHERE a.type = 'AR' AND COALESCE(s.name_id, t.name_id) IN ${inList(names)} AND t.date <= ?
        GROUP BY t.id, COALESCE(s.name_id, t.name_id)
        ORDER BY t.date, t.id`,
    )
    .all(...names, to) as ArTxn[];
}

function describe(db: DB, t: ArTxn, customerId: number): string {
  const job = t.name_id !== null && t.name_id !== customerId ? `${nameRow(db, t.name_id)?.name ?? ''}: ` : '';
  switch (t.type) {
    case 'INVOICE':
      return t.is_finance_charge
        ? `${job}Finance Charge ${t.num}`
        : `${job}INV #${t.num}. Due ${formatUsDate(t.due_date)}. Orig. Amount $${formatMoney(t.total)}.`;
    case 'CREDITMEMO':
      return `${job}CREDMEM #${t.num}.${t.memo ? ` ${t.memo}` : ''}`;
    case 'PAYMENT':
      return `${job}PMT${t.ref_no ? ` #${t.ref_no}` : ''}.${t.memo ? ` ${t.memo}` : ''}`;
    default:
      return `${job}${t.memo || 'General Journal'}`;
  }
}

/**
 * A statement for a customer (with its jobs) from `from` to `to` (the statement date):
 * the balance forward, each A/R transaction in range with a running balance, the
 * amount due, and the aging of what is due as of the statement date.
 */
export function getStatement(db: DB, customerId: number, from: string, to: string): Statement {
  const cust = nameRow(db, customerId);
  if (!cust || cust.kind !== 'customer') throw new AppError(404, 'That customer no longer exists.');
  if (from > to) throw new AppError(400, 'The statement period must start on or before the statement date.');
  const names = selfAndDescendants(db, customerId);
  const activity = arActivity(db, names, to);

  let balance_forward = 0;
  const rows: StatementRow[] = [];
  let running = 0;
  for (const t of activity) {
    if (t.date < from) {
      balance_forward += t.amount;
      continue;
    }
    if (rows.length === 0) running = balance_forward;
    running += t.amount;
    rows.push({
      txn_id: t.txn_id,
      date: t.date,
      type: t.type,
      num: t.num,
      name_id: t.name_id,
      description: describe(db, t, customerId),
      amount: t.amount,
      balance: running,
    });
  }
  const ending_balance = balance_forward + rows.reduce((s, r) => s + r.amount, 0);

  // Aging: open invoices as of the statement date by days past due. Unapplied credits
  // and anything else on A/R (journal entries) count as current, so the columns add up
  // to the amount due.
  const aging: Aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
  let invoicesOpen = 0;
  for (const t of activity) {
    if (t.type !== 'INVOICE') continue;
    const open = t.total - appliedTo(db, t.txn_id, null, to);
    if (open === 0) continue;
    aging[agingBucket(t.due_date || t.date, to)] += open;
    invoicesOpen += open;
  }
  aging.current += ending_balance - invoicesOpen;

  return {
    customer_id: customerId,
    full_name: fullName(db, customerId),
    bill_addr: cust.bill_addr,
    from,
    to,
    balance_forward,
    rows,
    ending_balance,
    aging,
  };
}

/**
 * Customers who would get a statement for the period: a balance other than zero on the
 * statement date, or any A/R activity in the period. Top-level customers only; a
 * customer's statement includes its jobs.
 */
export function listStatementCustomers(db: DB, from: string, to: string): StatementCustomer[] {
  const top = db
    .prepare("SELECT id FROM names WHERE kind = 'customer' AND parent_id IS NULL")
    .all() as { id: number }[];
  const out: StatementCustomer[] = [];
  for (const { id } of top) {
    const names = selfAndDescendants(db, id);
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(s.amount), 0) AS balance,
                COALESCE(SUM(CASE WHEN t.date >= ? THEN 1 ELSE 0 END), 0) AS n
           FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id
          WHERE a.type = 'AR' AND COALESCE(s.name_id, t.name_id) IN ${inList(names)} AND t.date <= ?`,
      )
      .get(from, ...names, to) as { balance: number; n: number };
    if (r.balance !== 0 || r.n > 0) {
      out.push({ customer_id: id, full_name: fullName(db, id), balance: r.balance, has_activity: r.n > 0 });
    }
  }
  return out.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' }));
}
