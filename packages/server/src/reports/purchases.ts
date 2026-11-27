import type { ReportColumn } from '@rapidbooks/shared';
import type { DB } from '../db';
import {
  byName,
  col,
  divCents,
  hi,
  itemFilter,
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
  type Params,
  type Row,
} from './engine';
import { poReceived } from '../ledger/purchasing';

// Purchases reports, from the lines of bills, bill credits (negative) and checks. Like
// QuickBooks these are item reports: only Items-tab lines count, unless
// include_expense_lines is set (then Expenses-tab lines count too, under their account).

interface PurchLine {
  txn_id: number;
  type: string;
  date: string;
  num: string;
  name_id: number | null; // vendor / payee
  memo: string;
  item_id: number | null;
  description: string;
  qty: number | null;
  rate: number | null;
  amount: number;
  account_id: number | null;
  cust_id: number | null;
  key: string; // item id, or "a<account>" for expense lines
}

function purchLines(db: DB, L: Lookups, p: Params, includeExpenses: boolean): PurchLine[] {
  const rows = db
    .prepare(
      `SELECT t.id AS txn_id, t.type, t.date, t.num, t.name_id, t.memo, l.item_id, l.description, l.qty, l.rate, l.amount,
              l.account_id, l.name_id AS cust_id
         FROM lines l JOIN txns t ON t.id = l.txn_id
        WHERE t.type IN ('BILL', 'BILLCREDIT', 'CHECK') AND l.payroll_item_id IS NULL AND t.date >= ? AND t.date <= ?
          AND (l.item_id IS NOT NULL OR (? = 1 AND l.account_id IS NOT NULL))
        ORDER BY t.date, t.id, l.seq`,
    )
    .all(lo(p), hi(p), includeExpenses ? 1 : 0) as Omit<PurchLine, 'key'>[];
  const names = p.name_ids.length ? nameFilter(L, p) : null;
  const items = p.item_ids.length ? itemFilter(L, p) : null;
  return rows
    .filter((r) => (!names || (r.name_id !== null && names.has(r.name_id))) && (!items || (r.item_id !== null && items.has(r.item_id))))
    .map((r) => {
      const sign = r.type === 'BILLCREDIT' ? -1 : 1;
      return { ...r, qty: r.qty === null ? null : sign * r.qty, amount: sign * r.amount, key: r.item_id !== null ? String(r.item_id) : `a${r.account_id}` };
    });
}

const keyLabel = (L: Lookups, k: string) =>
  k.startsWith('a') ? (L.account.get(Number(k.slice(1)))?.full_name ?? '') : (L.items.get(Number(k))?.full_name ?? '');
const vendorLabel = (L: Lookups, id: number | null) => (id === null ? '(No name)' : (L.names.get(id)?.full_name ?? ''));
const sumQty = (ls: PurchLine[]) => Math.round(ls.reduce((t, l) => t + (l.qty ?? 0), 0) * 1e6) / 1e6;
const sumAmt = (ls: PurchLine[]) => ls.reduce((t, l) => t + l.amount, 0);

function groupBy<T>(list: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    const l = m.get(k) ?? [];
    l.push(x);
    m.set(k, l);
  }
  return m;
}

export const PURCH_DETAIL_COLUMNS: ReportColumn[] = [
  col('trans_no', 'Trans #', 'qty'),
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('memo', 'Memo'),
  col('vendor', 'Source Name'),
  col('item', 'Item'),
  col('account', 'Account'),
  col('description', 'Description'),
  col('customer', 'Customer:Job'),
  col('qty', 'Qty', 'qty'),
  col('rate', 'Cost Price', 'money'),
  col('amount', 'Amount', 'money'),
  col('balance', 'Balance', 'money'),
];

function detail(L: Lookups, groups: { key: string; label: string; lines: PurchLine[] }[]): Row[] {
  const rows: Row[] = [];
  let all: PurchLine[] = [];
  for (const g of groups) {
    rows.push({ kind: 'header', depth: 0, label: g.label, cells: {} });
    let bal = 0;
    for (const l of g.lines) {
      bal += l.amount;
      rows.push({
        kind: 'data',
        depth: 1,
        cells: {
          trans_no: l.txn_id,
          type: typeLabel(l.type),
          date: l.date,
          num: l.num,
          memo: l.memo,
          vendor: vendorLabel(L, l.name_id),
          item: l.item_id !== null ? keyLabel(L, l.key) : '',
          account: l.account_id !== null ? (L.account.get(l.account_id)?.full_name ?? '') : '',
          description: l.description,
          customer: l.cust_id !== null ? (L.names.get(l.cust_id)?.full_name ?? '') : '',
          qty: l.qty,
          rate: l.rate,
          amount: l.amount,
          balance: bal,
        },
        drill: txnDrill(l.txn_id, l.type),
      });
    }
    rows.push({ kind: 'subtotal', depth: 0, label: `Total ${g.label}`, cells: { qty: sumQty(g.lines), amount: bal, balance: bal } });
    all = all.concat(g.lines);
  }
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { qty: sumQty(all), amount: sumAmt(all), balance: sumAmt(all) } });
  return rows;
}

const inc = (p: Params) => p.extra.include_expense_lines === true;

export function purchasesByVendorSummary(db: DB, p: Params): Built {
  const L = lookups(db);
  const g = groupBy(purchLines(db, L, p, inc(p)), (l) => String(l.name_id));
  const keys = [...g.keys()].sort((a, b) => byName(vendorLabel(L, a === 'null' ? null : Number(a)), vendorLabel(L, b === 'null' ? null : Number(b))));
  const rows: Row[] = keys.map((k) => {
    const id = k === 'null' ? null : Number(k);
    return {
      kind: 'data',
      depth: 0,
      label: vendorLabel(L, id),
      cells: { amount: sumAmt(g.get(k)!) },
      drill: reportDrill('purchases_by_vendor_detail', { ...rangeParams(p), name_ids: id, include_expense_lines: String(inc(p)) }),
    };
  });
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { amount: [...g.values()].reduce((t, l) => t + sumAmt(l), 0) } });
  return { subtitle: rangeSubtitle(p), columns: [col('label', ''), col('amount', 'Amount', 'money')], rows };
}

export function purchasesByVendorDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const g = groupBy(purchLines(db, L, p, inc(p)), (l) => String(l.name_id));
  const groups = [...g.entries()]
    .map(([k, lines]) => ({ key: k, label: vendorLabel(L, k === 'null' ? null : Number(k)), lines }))
    .sort((a, b) => byName(a.label, b.label));
  return { subtitle: rangeSubtitle(p), rows: detail(L, groups) };
}

function itemOrder(L: Lookups, k: string) {
  return k.startsWith('a') ? 1e9 + Number(k.slice(1)) : (L.items.get(Number(k))?.order ?? 1e8);
}

export function purchasesByItemSummary(db: DB, p: Params): Built {
  const L = lookups(db);
  const lines = purchLines(db, L, p, false);
  const g = groupBy(lines, (l) => l.key);
  const rows: Row[] = [...g.keys()]
    .sort((a, b) => itemOrder(L, a) - itemOrder(L, b))
    .map((k) => {
      const ls = g.get(k)!;
      const q = sumQty(ls);
      const a = sumAmt(ls);
      return {
        kind: 'data' as const,
        depth: 0,
        label: keyLabel(L, k),
        cells: { qty: q, amount: a, avg: q ? divCents(a, q) : null },
        drill: reportDrill('purchases_by_item_detail', { ...rangeParams(p), item_ids: Number(k) }),
      };
    });
  const tq = sumQty(lines);
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { qty: tq, amount: sumAmt(lines), avg: tq ? divCents(sumAmt(lines), tq) : null } });
  return {
    subtitle: rangeSubtitle(p),
    columns: [col('label', ''), col('qty', 'Qty', 'qty'), col('amount', 'Amount', 'money'), col('avg', 'Avg. Cost', 'money')],
    rows,
  };
}

export function purchasesByItemDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const g = groupBy(purchLines(db, L, p, false), (l) => l.key);
  const groups = [...g.entries()]
    .sort((a, b) => itemOrder(L, a[0]) - itemOrder(L, b[0]))
    .map(([k, lines]) => ({ key: k, label: keyLabel(L, k), lines }));
  return { subtitle: rangeSubtitle(p), rows: detail(L, groups) };
}

export function openPurchaseOrders(db: DB, p: Params): Built {
  const L = lookups(db);
  const rows = db
    .prepare(
      `SELECT id, date, num, name_id, memo, expected_date, total FROM txns
        WHERE type = 'PURCHORD' AND closed = 0 AND date >= ? AND date <= ? ORDER BY date, id`,
    )
    .all(lo(p), hi(p)) as { id: number; date: string; num: string; name_id: number; memo: string; expected_date: string; total: number }[];
  const f = p.name_ids.length ? nameFilter(L, p) : null;
  const out: Row[] = [];
  let total = 0;
  let openTotal = 0;
  for (const r of rows) {
    if (f && !f.has(r.name_id)) continue;
    // What is still to be received (part of it may be on bills already).
    const open = poReceived(db, r.id).remaining;
    total += r.total;
    openTotal += open;
    out.push({
      kind: 'data',
      depth: 0,
      cells: { type: 'Purchase Order', date: r.date, num: r.num, name: vendorLabel(L, r.name_id), memo: r.memo, deliv_date: r.expected_date || null, amount: r.total, open_balance: open },
      drill: txnDrill(r.id, 'PURCHORD'),
    });
  }
  out.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { amount: total, open_balance: openTotal } });
  return {
    subtitle: rangeSubtitle(p),
    columns: [
      col('type', 'Type'),
      col('date', 'Date', 'date'),
      col('num', 'Num'),
      col('name', 'Name'),
      col('memo', 'Memo'),
      col('deliv_date', 'Deliv Date', 'date'),
      col('amount', 'Amount', 'money'),
      col('open_balance', 'Open Balance', 'money'),
    ],
    rows: out,
  };
}
