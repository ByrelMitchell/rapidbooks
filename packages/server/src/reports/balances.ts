import type { Aging, ReportColumn } from '@rapidbooks/shared';
import type { DB } from '../db';
import { appliedTo } from '../ledger/common';
import { agingBucket } from '../ledger/statements';
import {
  asOfSubtitle,
  byName,
  col,
  hi,
  lo,
  lookups,
  nameFilter,
  rangeParams,
  rangeSubtitle,
  reportDrill,
  txnDrill,
  typeLabel,
  type Built,
  type Lookups,
  type NameInfo,
  type Params,
  type Row,
} from './engine';

// Customers & Receivables and Vendors & Payables: aging, open invoices, unpaid bills,
// customer and vendor balances. Open amounts are derived from links as of the date,
// exactly as the customer statement does (ledger/statements.ts), so the aging here
// agrees with the aging printed on statements.

export type Side = 'AR' | 'AP';

export interface OpenItem {
  txn_id: number;
  type: string;
  pay_method: string;
  date: string;
  num: string;
  name_id: number | null;
  due_date: string; // '' when none
  po_number: string;
  terms_id: number | null;
  memo: string;
  is_finance_charge: boolean;
  amount: number; // natural sign (A/R: owed to us positive; A/P: owed by us positive)
  open: number; // natural sign, as of the date
  bucket: keyof Aging;
  days: number | null; // days past due, invoices and bills only (null when not yet due)
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * Everything open in A/R or A/P as of a date, one entry per transaction and name.
 *   Invoices and bills: total less what is applied to them in effect by the date (aged by due date).
 *   Payments, credits, journal entries: their A/R or A/P amount less what they have applied
 *   (with discounts) in effect by the date; always "current", as on statements.
 * The open amounts add up to the A/R or A/P balance as of the date exactly.
 */
export function openItems(db: DB, side: Side, asOf: string): OpenItem[] {
  const sign = side === 'AR' ? 1 : -1;
  const doc = side === 'AR' ? 'INVOICE' : 'BILL';
  const rows = db
    .prepare(
      `SELECT t.id AS txn_id, t.type, t.pay_method, t.date, t.num, COALESCE(s.name_id, t.name_id) AS name_id, t.due_date, t.po_number,
              t.terms_id, t.memo, t.is_finance_charge, t.total, SUM(s.amount) AS amount
         FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id
        WHERE a.type = ? AND t.date <= ?
        GROUP BY t.id, COALESCE(s.name_id, t.name_id)
        ORDER BY t.date, t.id`,
    )
    .all(side, asOf) as {
    txn_id: number;
    type: string;
    pay_method: string;
    date: string;
    num: string;
    name_id: number | null;
    due_date: string;
    po_number: string;
    terms_id: number | null;
    memo: string;
    is_finance_charge: number;
    total: number;
    amount: number;
  }[];
  const appliedFrom = db.prepare(
    `SELECT COALESCE(SUM(l.amount + l.discount), 0) AS n
       FROM links l JOIN txns f ON f.id = l.from_txn JOIN txns t ON t.id = l.to_txn
      WHERE l.kind = 'apply' AND l.from_txn = ? AND MAX(f.date, t.date) <= ?`,
  );
  const out: OpenItem[] = [];
  for (const r of rows) {
    const amount = sign * r.amount;
    let open: number;
    let bucket: keyof Aging = 'current';
    let days: number | null = null;
    if (r.type === doc) {
      open = amount - appliedTo(db, r.txn_id, null, asOf);
      const due = r.due_date || r.date;
      bucket = agingBucket(due, asOf);
      const late = daysBetween(due, asOf);
      days = late > 0 ? late : null;
    } else {
      open = amount + (appliedFrom.get(r.txn_id, asOf) as { n: number }).n;
    }
    if (open === 0) continue;
    out.push({
      txn_id: r.txn_id,
      type: r.type,
      pay_method: r.pay_method,
      date: r.date,
      num: r.num,
      name_id: r.name_id,
      due_date: r.due_date,
      po_number: r.po_number,
      terms_id: r.terms_id,
      memo: r.memo,
      is_finance_charge: !!r.is_finance_charge,
      amount,
      open,
      bucket,
      days,
    });
  }
  return out;
}

const BUCKETS: [keyof Aging, string][] = [
  ['current', 'Current'],
  ['d1_30', '1 - 30'],
  ['d31_60', '31 - 60'],
  ['d61_90', '61 - 90'],
  ['over_90', '> 90'],
];

/**
 * Rows for names (customers with their jobs indented, or vendors): a name with jobs is a
 * header, its own row, its jobs, and a total. Names whose values are all zero are left out.
 */
export function nameTree(
  L: Lookups,
  kind: string,
  vals: (id: number | null) => number[],
  keys: string[],
  drill: (n: NameInfo) => Row['drill'],
  depth = 0,
): { rows: Row[]; total: number[] } {
  const all = [...L.names.values()].filter((n) => n.kind === kind);
  const kids = new Map<number | null, NameInfo[]>();
  for (const n of all) {
    const list = kids.get(n.parent_id) ?? [];
    list.push(n);
    kids.set(n.parent_id, list);
  }
  for (const list of kids.values()) list.sort((a, b) => byName(a.name, b.name));
  const cells = (v: number[]) => Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  const nonzero = (v: number[]) => v.some((x) => x !== 0);
  const walk = (n: NameInfo, d: number): { rows: Row[]; total: number[] } => {
    const own = vals(n.id);
    const sub = (kids.get(n.id) ?? []).map((c) => walk(c, d + 1));
    const subRows = sub.flatMap((s) => s.rows);
    const total = own.map((v, i) => v + sub.reduce((t, s) => t + s.total[i], 0));
    if (subRows.length === 0) return { rows: nonzero(own) ? [{ kind: 'data', depth: d, label: n.name, cells: cells(own), drill: drill(n) }] : [], total };
    const rows: Row[] = [{ kind: 'header', depth: d, label: n.name, cells: {}, drill: drill(n) }];
    if (nonzero(own)) rows.push({ kind: 'data', depth: d + 1, label: n.name, cells: cells(own), drill: drill(n) });
    rows.push(...subRows, { kind: 'subtotal', depth: d, label: `Total ${n.name}`, cells: cells(total), drill: drill(n) });
    return { rows, total };
  };
  const rows: Row[] = [];
  const total = keys.map(() => 0);
  for (const n of kids.get(null) ?? []) {
    const r = walk(n, depth);
    rows.push(...r.rows);
    r.total.forEach((v, i) => (total[i] += v));
  }
  // Anything posted to A/R or A/P without a name (journal entries).
  const none = vals(null);
  if (nonzero(none)) {
    rows.push({ kind: 'data', depth, label: '(No name)', cells: cells(none) });
    none.forEach((v, i) => (total[i] += v));
  }
  return { rows, total };
}

const sideKind = (side: Side) => (side === 'AR' ? 'customer' : 'vendor');
const detailId = (side: Side) => (side === 'AR' ? 'ar_aging_detail' : 'ap_aging_detail');

/** Open items limited to the chosen names (with their jobs). */
function filtered(L: Lookups, p: Params, items: OpenItem[]): OpenItem[] {
  if (!p.name_ids.length) return items;
  const f = nameFilter(L, p);
  return items.filter((i) => i.name_id !== null && f.has(i.name_id));
}

export const AGING_COLUMNS: ReportColumn[] = [col('label', ''), ...BUCKETS.map(([k, t]) => col(k, t, 'money')), col('total', 'TOTAL', 'money')];

export function agingSummary(side: Side) {
  return (db: DB, p: Params): Built => {
    const L = lookups(db);
    const items = filtered(L, p, openItems(db, side, p.as_of));
    const per = new Map<number | null, number[]>();
    for (const i of items) {
      const v = per.get(i.name_id) ?? [0, 0, 0, 0, 0, 0];
      v[BUCKETS.findIndex(([k]) => k === i.bucket)] += i.open;
      v[5] += i.open;
      per.set(i.name_id, v);
    }
    const keys = [...BUCKETS.map(([k]) => k), 'total'];
    const t = nameTree(L, sideKind(side), (id) => per.get(id) ?? [0, 0, 0, 0, 0, 0], keys, (n) => reportDrill(detailId(side), { as_of: p.as_of, name_ids: n.id }));
    // Names of another kind holding A/R or A/P (rare): list them flat.
    for (const [id, v] of per) {
      if (id === null) continue;
      const n = L.names.get(id);
      if (n && n.kind !== sideKind(side)) {
        t.rows.push({ kind: 'data', depth: 0, label: n.full_name, cells: Object.fromEntries(keys.map((k, i) => [k, v[i]])), drill: reportDrill(detailId(side), { as_of: p.as_of, name_ids: id }) });
        v.forEach((x, i) => (t.total[i] += x));
      }
    }
    t.rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: Object.fromEntries(keys.map((k, i) => [k, t.total[i]])) });
    return { subtitle: asOfSubtitle(p.as_of), columns: AGING_COLUMNS, rows: t.rows };
  };
}

export const OPEN_ITEM_COLUMNS: ReportColumn[] = [
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('po_no', 'P. O. #'),
  col('name', 'Name'),
  col('terms', 'Terms'),
  col('due_date', 'Due Date', 'date'),
  col('aging', 'Aging', 'qty'),
  col('memo', 'Memo'),
  col('amount', 'Orig. Amount', 'money'),
  col('open_balance', 'Open Balance', 'money'),
];

function itemRow(L: Lookups, terms: Map<number, string>, i: OpenItem, depth: number): Row {
  return {
    kind: 'data',
    depth,
    cells: {
      type: typeLabel(i.type, i.pay_method),
      date: i.date,
      num: i.num,
      po_no: i.po_number,
      name: i.name_id !== null ? (L.names.get(i.name_id)?.full_name ?? '') : '',
      terms: i.terms_id !== null ? (terms.get(i.terms_id) ?? '') : '',
      due_date: i.due_date || null,
      aging: i.days,
      memo: i.memo,
      amount: i.amount,
      open_balance: i.open,
    },
    drill: txnDrill(i.txn_id, i.type),
  };
}

const termsMap = (db: DB) => new Map((db.prepare('SELECT id, name FROM terms').all() as { id: number; name: string }[]).map((r) => [r.id, r.name]));

/** A/R or A/P Aging Detail: open items grouped by aging column, oldest first. */
export function agingDetail(side: Side) {
  return (db: DB, p: Params): Built => {
    const L = lookups(db);
    const terms = termsMap(db);
    const items = filtered(L, p, openItems(db, side, p.as_of));
    const rows: Row[] = [];
    let total = 0;
    for (const [k, title] of BUCKETS) {
      const list = items.filter((i) => i.bucket === k);
      if (list.length === 0) continue;
      list.sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.txn_id - b.txn_id));
      const sum = list.reduce((t, i) => t + i.open, 0);
      total += sum;
      rows.push({ kind: 'header', depth: 0, label: k === 'current' ? 'Current' : k === 'over_90' ? '> 90' : title, cells: {} });
      rows.push(...list.map((i) => itemRow(L, terms, i, 1)));
      rows.push({ kind: 'subtotal', depth: 0, label: `Total ${k === 'current' ? 'Current' : title}`, cells: { open_balance: sum } });
    }
    rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { open_balance: total } });
    return { subtitle: asOfSubtitle(p.as_of), rows };
  };
}

/** Open Invoices / Unpaid Bills Detail: open items grouped by customer or vendor. */
export function openByName(side: Side) {
  return (db: DB, p: Params): Built => {
    const L = lookups(db);
    const terms = termsMap(db);
    const items = filtered(L, p, openItems(db, side, p.as_of));
    const groups = new Map<number | null, OpenItem[]>();
    for (const i of items) {
      const list = groups.get(i.name_id) ?? [];
      list.push(i);
      groups.set(i.name_id, list);
    }
    const label = (id: number | null) => (id === null ? '(No name)' : (L.names.get(id)?.full_name ?? ''));
    const rows: Row[] = [];
    let total = 0;
    for (const id of [...groups.keys()].sort((a, b) => byName(label(a), label(b)))) {
      const list = groups.get(id)!;
      list.sort((a, b) => ((a.due_date || a.date) < (b.due_date || b.date) ? -1 : (a.due_date || a.date) > (b.due_date || b.date) ? 1 : a.txn_id - b.txn_id));
      const sum = list.reduce((t, i) => t + i.open, 0);
      total += sum;
      rows.push({ kind: 'header', depth: 0, label: label(id), cells: {} });
      rows.push(...list.map((i) => itemRow(L, terms, i, 1)));
      rows.push({ kind: 'subtotal', depth: 0, label: `Total ${label(id)}`, cells: { open_balance: sum } });
    }
    rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { open_balance: total } });
    return { subtitle: asOfSubtitle(p.as_of), rows };
  };
}

// ---------------------------------------------------------------------------
// Customer and vendor balances

/** A/R or A/P balance per name as of a date (natural sign). */
export function balancesByName(db: DB, side: Side, asOf: string): Map<number | null, number> {
  const sign = side === 'AR' ? 1 : -1;
  const rows = db
    .prepare(
      `SELECT COALESCE(s.name_id, t.name_id) AS name_id, SUM(s.amount) AS n
         FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id
        WHERE a.type = ? AND t.date <= ? GROUP BY 1`,
    )
    .all(side, asOf) as { name_id: number | null; n: number }[];
  return new Map(rows.map((r) => [r.name_id, sign * r.n]));
}

export function balanceSummary(side: Side) {
  return (db: DB, p: Params): Built => {
    const L = lookups(db);
    const bal = balancesByName(db, side, p.as_of);
    const f = p.name_ids.length ? nameFilter(L, p) : null;
    const v = (id: number | null) => [f && (id === null || !f.has(id)) ? 0 : (bal.get(id) ?? 0)];
    const t = nameTree(L, sideKind(side), v, ['balance'], (n) =>
      reportDrill(side === 'AR' ? 'customer_balance_detail' : 'vendor_balance_detail', { from: '', to: p.as_of, name_ids: n.id }),
    );
    for (const [id, b] of bal) {
      if (id === null) continue;
      const n = L.names.get(id);
      if (n && n.kind !== sideKind(side) && b !== 0 && (!f || f.has(id))) {
        t.rows.push({ kind: 'data', depth: 0, label: n.full_name, cells: { balance: b } });
        t.total[0] += b;
      }
    }
    t.rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { balance: t.total[0] } });
    return { subtitle: asOfSubtitle(p.as_of), columns: [col('label', ''), col('balance', 'Balance', 'money')], rows: t.rows };
  };
}

export const BALANCE_DETAIL_COLUMNS: ReportColumn[] = [
  col('trans_no', 'Trans #', 'qty'),
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('memo', 'Memo'),
  col('account', 'Account'),
  col('due_date', 'Due Date', 'date'),
  col('amount', 'Amount', 'money'),
  col('balance', 'Balance', 'money'),
];

/** Every A/R (or A/P) transaction per customer (or vendor) with a running balance. */
export function balanceDetail(side: Side) {
  return (db: DB, p: Params): Built => {
    const L = lookups(db);
    const sign = side === 'AR' ? 1 : -1;
    const rows = db
      .prepare(
        `SELECT t.id, t.type, t.pay_method, t.date, t.num, t.memo, t.due_date, COALESCE(s.name_id, t.name_id) AS name_id, s.account_id, SUM(s.amount) AS amount
           FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id
          WHERE a.type = ? AND t.date <= ?
          GROUP BY t.id, COALESCE(s.name_id, t.name_id), s.account_id
          ORDER BY t.date, t.id`,
      )
      .all(side, hi(p)) as { id: number; type: string; pay_method: string; date: string; num: string; memo: string; due_date: string; name_id: number | null; account_id: number; amount: number }[];
    const f = p.name_ids.length ? nameFilter(L, p) : null;
    const groups = new Map<number | null, typeof rows>();
    for (const r of rows) {
      if (f && (r.name_id === null || !f.has(r.name_id))) continue;
      const list = groups.get(r.name_id) ?? [];
      list.push(r);
      groups.set(r.name_id, list);
    }
    const label = (id: number | null) => (id === null ? '(No name)' : (L.names.get(id)?.full_name ?? ''));
    const out: Row[] = [];
    let total = 0;
    const from = lo(p);
    for (const id of [...groups.keys()].sort((a, b) => byName(label(a), label(b)))) {
      const list = groups.get(id)!;
      const before = list.filter((r) => r.date < from).reduce((t, r) => t + sign * r.amount, 0);
      const inRange = list.filter((r) => r.date >= from);
      if (inRange.length === 0 && before === 0) continue;
      out.push({ kind: 'header', depth: 0, label: label(id), cells: {} });
      let bal = before;
      if (before !== 0) out.push({ kind: 'data', depth: 1, label: 'Balance forward', cells: { memo: 'Balance forward', balance: before } });
      for (const r of inRange) {
        bal += sign * r.amount;
        out.push({
          kind: 'data',
          depth: 1,
          cells: {
            trans_no: r.id,
            type: typeLabel(r.type, r.pay_method),
            date: r.date,
            num: r.num,
            memo: r.memo,
            account: L.account.get(r.account_id)?.full_name ?? '',
            due_date: r.due_date || null,
            amount: sign * r.amount,
            balance: bal,
          },
          drill: txnDrill(r.id, r.type),
        });
      }
      total += bal;
      out.push({ kind: 'subtotal', depth: 0, label: `Total ${label(id)}`, cells: { amount: bal - before, balance: bal } });
    }
    out.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { balance: total } });
    return { subtitle: rangeSubtitle(p), rows: out };
  };
}

