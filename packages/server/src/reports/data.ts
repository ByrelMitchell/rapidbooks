import type { Account } from '@rapidbooks/shared';
import type { DB } from '../db';
import { debitNormal, isPL, type Lookups } from './engine';

// Ledger queries the reports share. Amounts are cents, debit-positive unless a name says
// "natural" (income, liabilities and equity shown credit-positive).

export interface SplitRow {
  split_id: number;
  seq: number;
  txn_id: number;
  type: string;
  pay_method: string;
  date: string;
  num: string;
  txn_name_id: number | null;
  name_id: number | null; // the split's name, else the transaction's
  memo: string; // the split's memo, else the transaction's
  txn_memo: string;
  account_id: number;
  amount: number;
  cleared: number;
  due_date: string;
}

/** Every split dated from..to (inclusive), in date, transaction and split order. */
export function loadSplits(db: DB, from: string, to: string): SplitRow[] {
  return db
    .prepare(
      `SELECT s.id AS split_id, s.seq, t.id AS txn_id, t.type, t.pay_method, t.date, t.num, t.name_id AS txn_name_id,
              COALESCE(s.name_id, t.name_id) AS name_id,
              CASE WHEN s.memo <> '' THEN s.memo ELSE t.memo END AS memo, t.memo AS txn_memo,
              s.account_id, s.amount, s.cleared, t.due_date
         FROM splits s JOIN txns t ON t.id = s.txn_id
        WHERE t.date >= ? AND t.date <= ?
        ORDER BY t.date, t.id, s.seq`,
    )
    .all(from, to) as SplitRow[];
}

/** Per transaction: the accounts it posts to (for the "Split" column). */
export function accountsByTxn(rows: SplitRow[]): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>();
  for (const r of rows) {
    const s = m.get(r.txn_id) ?? new Set<number>();
    s.add(r.account_id);
    m.set(r.txn_id, s);
  }
  return m;
}

/** QuickBooks' Split column: the other account, or -SPLIT- when there are several. */
export function splitLabel(L: Lookups, accts: Set<number> | undefined, self: number): string {
  if (!accts) return '';
  const others = [...accts].filter((a) => a !== self);
  if (others.length === 0) return '';
  if (others.length > 1) return '-SPLIT-';
  return L.account.get(others[0])?.full_name ?? '';
}

/** Sum of splits per account dated from..to (debit-positive). */
export function sumsByAccount(db: DB, from: string, to: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT s.account_id, SUM(s.amount) AS n FROM splits s JOIN txns t ON t.id = s.txn_id
        WHERE t.date >= ? AND t.date <= ? GROUP BY s.account_id`,
    )
    .all(from, to) as { account_id: number; n: number }[];
  return new Map(rows.map((r) => [r.account_id, r.n]));
}

/** Sum of splits per account and month (YYYY-MM) dated from..to (debit-positive). */
export function sumsByAccountMonth(db: DB, from: string, to: string): Map<number, Map<string, number>> {
  const rows = db
    .prepare(
      `SELECT s.account_id, SUBSTR(t.date, 1, 7) AS ym, SUM(s.amount) AS n FROM splits s JOIN txns t ON t.id = s.txn_id
        WHERE t.date >= ? AND t.date <= ? GROUP BY s.account_id, ym`,
    )
    .all(from, to) as { account_id: number; ym: string; n: number }[];
  const out = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const m = out.get(r.account_id) ?? new Map<string, number>();
    m.set(r.ym, r.n);
    out.set(r.account_id, m);
  }
  return out;
}

/** Net income (credit-positive) of transactions dated from..to. */
export function netIncome(db: DB, L: Lookups, from: string, to: string): number {
  let n = 0;
  for (const [id, amt] of sumsByAccount(db, from, to)) {
    const a = L.account.get(id);
    if (a && isPL(a.type)) n -= amt;
  }
  return n;
}

/** An account's balance shown the way QuickBooks shows it: credit-normal accounts credit-positive. */
export const natural = (a: Pick<Account, 'type'>, debitPositive: number) => (debitNormal(a.type) ? debitPositive : -debitPositive);

export const fyStart = (date: string) => `${date.slice(0, 4)}-01-01`;
export const dayBefore = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export function retainedAccount(L: Lookups): Account | undefined {
  return L.accounts.find((a) => a.system_role === 'RETAINED');
}

/**
 * Debit-positive balances as of a date the way the Trial Balance and Balance Sheet show
 * them: balance-sheet accounts through asOf; income and expense accounts for the fiscal
 * year to date; Retained Earnings plus the net income of all earlier fiscal years.
 * Returns the balances and the prior-years net income that was rolled in (credit-positive).
 */
export function closingBalances(db: DB, L: Lookups, asOf: string): { bal: Map<number, number>; priorNI: number } {
  const start = fyStart(asOf);
  const all = sumsByAccount(db, '0000-01-01', asOf);
  const ytd = sumsByAccount(db, start, asOf);
  const priorNI = netIncome(db, L, '0000-01-01', dayBefore(start));
  const bal = new Map<number, number>();
  for (const a of L.accounts) {
    const v = isPL(a.type) ? (ytd.get(a.id) ?? 0) : (all.get(a.id) ?? 0);
    bal.set(a.id, v);
  }
  const re = retainedAccount(L);
  if (re) bal.set(re.id, (bal.get(re.id) ?? 0) - priorNI);
  return { bal, priorNI };
}
