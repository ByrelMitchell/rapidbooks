import { isIsoDate, type FindResult, type FindRow, type GraphData, type SalesGraph } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { mainAccount, type TxnHead } from './accountant';
import { lookups, monthLabel, monthsBetween, withDescendants, typeLabel, txnDateBounds } from './engine';
import { salesLines } from './sales';
import { sumsByAccountMonth } from './data';

// Find (Ctrl+F) and the graph data.

export interface FindQuery {
  types: string[];
  name_id: number | null; // includes jobs
  from: string | null;
  to: string | null;
  num: string | null; // exact, case-insensitive
  amount: number | null; // cents, exact (the transaction total)
  amount_min: number | null;
  amount_max: number | null;
  text: string | null; // in the memo, split memos or line descriptions
  account_id: number | null; // any split in this account (or its sub-accounts)
  item_id: number | null; // any line with this item
  limit: number;
}

export function find(db: DB, q: FindQuery): FindResult {
  const L = lookups(db);
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.types.length) {
    where.push(`t.type IN (${q.types.map(() => '?').join(', ')})`);
    args.push(...q.types);
  }
  if (q.name_id !== null) {
    const ids = [...withDescendants([q.name_id], L.names)];
    const list = ids.map(() => '?').join(', ');
    where.push(`(t.name_id IN (${list}) OR EXISTS (SELECT 1 FROM splits s WHERE s.txn_id = t.id AND s.name_id IN (${list})) OR EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.name_id IN (${list})))`);
    args.push(...ids, ...ids, ...ids);
  }
  if (q.from) {
    where.push('t.date >= ?');
    args.push(q.from);
  }
  if (q.to) {
    where.push('t.date <= ?');
    args.push(q.to);
  }
  if (q.num !== null) {
    where.push('(t.num = ? COLLATE NOCASE OR t.ref_no = ? COLLATE NOCASE)');
    args.push(q.num, q.num);
  }
  if (q.amount !== null) {
    where.push('t.total = ?');
    args.push(q.amount);
  }
  if (q.amount_min !== null) {
    where.push('t.total >= ?');
    args.push(q.amount_min);
  }
  if (q.amount_max !== null) {
    where.push('t.total <= ?');
    args.push(q.amount_max);
  }
  if (q.text !== null) {
    const like = `%${q.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(t.memo LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM splits s WHERE s.txn_id = t.id AND s.memo LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.description LIKE ? ESCAPE '\\'))`,
    );
    args.push(like, like, like);
  }
  if (q.account_id !== null) {
    const ids = [...withDescendants([q.account_id], L.account)];
    where.push(`EXISTS (SELECT 1 FROM splits s WHERE s.txn_id = t.id AND s.account_id IN (${ids.map(() => '?').join(', ')}))`);
    args.push(...ids);
  }
  if (q.item_id !== null) {
    where.push('EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.item_id = ?)');
    args.push(q.item_id);
  }
  const limit = Math.max(1, Math.min(q.limit, 1000));
  const rows = db
    .prepare(
      `SELECT t.id, t.type, t.date, t.num, t.name_id, t.memo, t.pay_method, t.account_id, t.ar_account_id, t.ap_account_id, t.due_date, t.total,
              (SELECT s.account_id FROM splits s WHERE s.txn_id = t.id ORDER BY s.seq LIMIT 1) AS first_account
         FROM txns t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.date DESC, t.id DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as (TxnHead & { first_account: number | null })[];
  const out: FindRow[] = rows.slice(0, limit).map((t) => {
    const a = mainAccount(t, t.first_account);
    return {
      id: t.id,
      type: t.type,
      type_label: typeLabel(t.type, t.pay_method),
      date: t.date,
      num: t.num,
      name_id: t.name_id,
      name: t.name_id !== null ? (L.names.get(t.name_id)?.full_name ?? '') : '',
      account: a !== null ? (L.account.get(a)?.full_name ?? '') : '',
      memo: t.memo,
      amount: t.total,
    };
  });
  return { rows: out, more: rows.length > limit };
}

// ---------------------------------------------------------------------------
// Graphs

export interface SalesGraphQuery {
  from: string | null;
  to: string | null;
  today: string;
  by: 'customer' | 'item';
  top: number;
  name_ids: number[];
  item_ids: number[];
}

/**
 * Sales by month, one series per customer (jobs roll up to their customer) or item: the
 * top N by total over the range, the rest as "Other". The breakdown is each series' total.
 * Everything is the same sales lines as the Sales by Customer / Item reports.
 */
export function salesGraph(db: DB, q: SalesGraphQuery): SalesGraph {
  const L = lookups(db);
  const b = txnDateBounds(db, q.today);
  const from = q.from ?? b.min;
  const to = q.to ?? b.max;
  if (from > to) throw new AppError(400, 'The From date is after the To date.');
  const months = monthsBetween(from, to);
  const lines = salesLines(db, L, { from, to, name_ids: q.name_ids, item_ids: q.item_ids });
  const keyOf = (l: (typeof lines)[number]) => (q.by === 'customer' ? `n${L.names.get(l.name_id)?.root_id ?? l.name_id}` : l.item_id !== null ? `i${l.item_id}` : `a${l.account_id}`);
  const labelOf = (k: string) => {
    const id = Number(k.slice(1));
    if (k[0] === 'n') return L.names.get(id)?.full_name ?? '';
    if (k[0] === 'i') return L.items.get(id)?.full_name ?? '';
    return `${L.account.get(id)?.full_name ?? ''} (no item)`;
  };
  const per = new Map<string, number[]>();
  for (const l of lines) {
    const k = keyOf(l);
    const v = per.get(k) ?? months.map(() => 0);
    v[months.indexOf(l.date.slice(0, 7))] += l.amount;
    per.set(k, v);
  }
  const sum = (v: number[]) => v.reduce((t, x) => t + x, 0);
  const ranked = [...per.entries()].sort((a, b) => sum(b[1]) - sum(a[1]) || labelOf(a[0]).localeCompare(labelOf(b[0])));
  const top = Math.max(1, q.top);
  const series = ranked.slice(0, top).map(([k, v]) => ({ name: labelOf(k), id: k[0] === 'a' ? null : Number(k.slice(1)), values: v }));
  const rest = ranked.slice(top);
  if (rest.length) series.push({ name: 'Other', id: null, values: months.map((_, i) => rest.reduce((t, [, v]) => t + v[i], 0)) });
  return {
    by: q.by,
    from,
    to,
    labels: months.map(monthLabel),
    keys: months,
    series,
    breakdown: { labels: series.map((s) => s.name), values: series.map((s) => sum(s.values)), ids: series.map((s) => s.id) },
    total: lines.reduce((t, l) => t + l.amount, 0),
  };
}

/** Income and expense by month (as on the Profit & Loss) and the net. */
export function incomeExpenseGraph(db: DB, q: { from: string | null; to: string | null; today: string }): GraphData {
  const L = lookups(db);
  const b = txnDateBounds(db, q.today);
  const from = q.from ?? b.min;
  const to = q.to ?? b.max;
  const months = monthsBetween(from, to);
  const sums = sumsByAccountMonth(db, from, to);
  const income = months.map(() => 0);
  const expense = months.map(() => 0);
  for (const [id, m] of sums) {
    const a = L.account.get(id);
    if (!a) continue;
    months.forEach((ym, i) => {
      const v = m.get(ym) ?? 0;
      if (a.type === 'INC' || a.type === 'OINC') income[i] -= v;
      else if (a.type === 'COGS' || a.type === 'EXP' || a.type === 'OEXP') expense[i] += v;
    });
  }
  return {
    labels: months.map(monthLabel),
    keys: months,
    series: [
      { name: 'Income', id: null, values: income },
      { name: 'Expense', id: null, values: expense },
      { name: 'Net Income', id: null, values: income.map((v, i) => v - expense[i]) },
    ],
  };
}

export const optDate = (s: string | undefined, label: string) => {
  if (s === undefined || s === '') return null;
  if (!isIsoDate(s)) throw new AppError(400, `${label} is not a valid date.`);
  return s;
};
