import { ITEM_TYPES, type ReportColumn } from '@rapidbooks/shared';
import type { DB } from '../db';
import {
  byName,
  col,
  divCents,
  hi,
  lo,
  longMonthLabel,
  lookups,
  monthLabel,
  monthsBetween,
  nameFilter,
  itemFilter,
  pct,
  rangeParams,
  rangeSubtitle,
  reportDrill,
  txnDateBounds,
  txnDrill,
  typeLabel,
  type Built,
  type Lookups,
  type Params,
  type Row,
} from './engine';
import { nameTree } from './balances';

// Sales reports, from the lines of invoices and credit memos (credit memos negative).
// Subtotal lines and description-only lines are left out; discount lines count under
// their discount item; item-less account lines (finance charges) count under a
// "(no item)" entry named after their account.

export interface SalesLine {
  txn_id: number;
  type: string;
  date: string;
  num: string;
  name_id: number;
  po_number: string;
  ship_date: string;
  ship_via: string;
  memo: string;
  is_finance_charge: number;
  seq: number;
  item_id: number | null;
  description: string;
  qty: number | null; // signed (credit memos negative)
  rate: number | null; // cents; null for percentage lines
  amount: number; // signed cents
  account_id: number | null;
  key: string; // item id, or "a<account id>" for item-less lines
}

export function salesLines(db: DB, L: Lookups, p: { from: string | null; to: string | null; name_ids: number[]; item_ids: number[] }): SalesLine[] {
  const rows = db
    .prepare(
      `SELECT t.id AS txn_id, t.type, t.date, t.num, t.name_id, t.po_number, t.ship_date, t.ship_via, t.memo, t.is_finance_charge,
              l.seq, l.item_id, l.description, l.qty, l.rate, l.rate_is_percent, l.amount, l.account_id
         FROM lines l JOIN txns t ON t.id = l.txn_id LEFT JOIN items i ON i.id = l.item_id
        WHERE t.type IN ('INVOICE', 'CREDITMEMO') AND t.date >= ? AND t.date <= ?
          AND ((l.item_id IS NOT NULL AND i.type <> 'SUBTOTAL') OR (l.item_id IS NULL AND l.account_id IS NOT NULL))
        ORDER BY t.date, t.id, l.seq`,
    )
    .all(lo(p), hi(p)) as (Omit<SalesLine, 'key'> & { rate_is_percent: number })[];
  const names = p.name_ids.length ? nameFilter(L, p as Params) : null;
  const items = p.item_ids.length ? itemFilter(L, p as Params) : null;
  const out: SalesLine[] = [];
  for (const { rate_is_percent, ...r } of rows) {
    if (names && !names.has(r.name_id)) continue;
    if (items && (r.item_id === null || !items.has(r.item_id))) continue;
    const sign = r.type === 'CREDITMEMO' ? -1 : 1;
    out.push({
      ...r,
      qty: r.qty === null ? null : sign * r.qty,
      rate: rate_is_percent ? null : r.rate,
      amount: sign * r.amount,
      key: r.item_id !== null ? String(r.item_id) : `a${r.account_id}`,
    });
  }
  return out;
}

export function itemKeyLabel(L: Lookups, key: string): string {
  if (key.startsWith('a')) return `${L.account.get(Number(key.slice(1)))?.full_name ?? 'Account'} (no item)`;
  return L.items.get(Number(key))?.full_name ?? '';
}

// ---------------------------------------------------------------------------
// By customer

export function salesByCustomerSummary(db: DB, p: Params): Built {
  const L = lookups(db);
  const per = new Map<number, number>();
  for (const l of salesLines(db, L, p)) per.set(l.name_id, (per.get(l.name_id) ?? 0) + l.amount);
  const t = nameTree(L, 'customer', (id) => [id === null ? 0 : (per.get(id) ?? 0)], ['amount'], (n) =>
    reportDrill('sales_by_customer_detail', { ...rangeParams(p), name_ids: n.id }),
  );
  t.rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { amount: t.total[0] } });
  return { subtitle: rangeSubtitle(p), columns: [col('label', ''), col('amount', 'Amount', 'money')], rows: t.rows };
}

export const SALES_DETAIL_COLUMNS: ReportColumn[] = [
  col('trans_no', 'Trans #', 'qty'),
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('po_no', 'P. O. #'),
  col('memo', 'Memo'),
  col('customer', 'Customer'),
  col('item', 'Item'),
  col('description', 'Description'),
  col('qty', 'Qty', 'qty'),
  col('rate', 'Sales Price', 'money'),
  col('amount', 'Amount', 'money'),
  col('balance', 'Balance', 'money'),
  col('ship_date', 'Ship Date', 'date'),
  col('via', 'Via'),
];

function lineCells(L: Lookups, l: SalesLine, balance: number): Record<string, string | number | null> {
  return {
    trans_no: l.txn_id,
    type: typeLabel(l.type),
    date: l.date,
    num: l.num,
    po_no: l.po_number,
    memo: l.memo,
    customer: L.names.get(l.name_id)?.full_name ?? '',
    item: itemKeyLabel(L, l.key),
    description: l.description,
    qty: l.qty,
    rate: l.rate,
    amount: l.amount,
    balance,
    ship_date: l.ship_date || null,
    via: l.ship_via,
  };
}

const sumQty = (ls: SalesLine[]) => Math.round(ls.reduce((t, l) => t + (l.qty ?? 0), 0) * 1e6) / 1e6;
const sumAmt = (ls: SalesLine[]) => ls.reduce((t, l) => t + l.amount, 0);

/** Lines grouped by a key, each group a header, its lines with a running balance, and a total. */
function grouped(L: Lookups, lines: SalesLine[], groups: { key: string; label: string }[], keyOf: (l: SalesLine) => string, cells = lineCells): Row[] {
  const rows: Row[] = [];
  const by = new Map<string, SalesLine[]>();
  for (const l of lines) {
    const k = keyOf(l);
    const list = by.get(k) ?? [];
    list.push(l);
    by.set(k, list);
  }
  for (const g of groups) {
    const list = by.get(g.key);
    if (!list) continue;
    rows.push({ kind: 'header', depth: 0, label: g.label, cells: {} });
    let bal = 0;
    for (const l of list) {
      bal += l.amount;
      rows.push({ kind: 'data', depth: 1, cells: cells(L, l, bal), drill: txnDrill(l.txn_id, l.type) });
    }
    rows.push({ kind: 'subtotal', depth: 0, label: `Total ${g.label}`, cells: { qty: sumQty(list), amount: sumAmt(list), balance: bal } });
  }
  return rows;
}

export function salesByCustomerDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const lines = salesLines(db, L, p);
  const ids = [...new Set(lines.map((l) => l.name_id))].sort((a, b) => byName(L.names.get(a)?.full_name ?? '', L.names.get(b)?.full_name ?? ''));
  const rows = grouped(L, lines, ids.map((id) => ({ key: String(id), label: L.names.get(id)?.full_name ?? '' })), (l) => String(l.name_id));
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { qty: sumQty(lines), amount: sumAmt(lines), balance: sumAmt(lines) } });
  return { subtitle: rangeSubtitle(p), rows };
}

// ---------------------------------------------------------------------------
// By item

const SECTION_LABEL: Record<string, string> = {
  SERVICE: 'Service',
  PART: 'Non-inventory Parts',
  OTHER_CHARGE: 'Other Charges',
  DISCOUNT: 'Discounts',
  OTHER: 'Other',
};

function sectionOf(L: Lookups, key: string): string {
  if (key.startsWith('a')) return 'OTHER';
  const it = L.items.get(Number(key));
  let r = it;
  while (r && r.parent_id !== null && L.items.has(r.parent_id)) r = L.items.get(r.parent_id);
  return r && SECTION_LABEL[r.type] ? r.type : 'OTHER';
}

function orderedKeys(L: Lookups, keys: string[]): string[] {
  const ord = (k: string) => (k.startsWith('a') ? 1e9 + Number(k.slice(1)) : (L.items.get(Number(k))?.order ?? 1e8));
  return [...new Set(keys)].sort((a, b) => ord(a) - ord(b));
}

export function salesByItemSummary(db: DB, p: Params): Built {
  const L = lookups(db);
  const lines = salesLines(db, L, p);
  const total = sumAmt(lines);
  const by = new Map<string, SalesLine[]>();
  for (const l of lines) {
    const list = by.get(l.key) ?? [];
    list.push(l);
    by.set(l.key, list);
  }
  const rows: Row[] = [];
  const keys = orderedKeys(L, [...by.keys()]);
  for (const sec of [...ITEM_TYPES.map((t) => t.code as string), 'OTHER']) {
    const ks = keys.filter((k) => sectionOf(L, k) === sec);
    if (ks.length === 0) continue;
    rows.push({ kind: 'header', depth: 0, label: SECTION_LABEL[sec], cells: {} });
    let sq = 0;
    let sa = 0;
    for (const k of ks) {
      const ls = by.get(k)!;
      const q = sumQty(ls);
      const a = sumAmt(ls);
      sq += q;
      sa += a;
      rows.push({
        kind: 'data',
        depth: 1,
        label: itemKeyLabel(L, k),
        cells: { qty: q, amount: a, pct: pct(a, total), avg: q ? divCents(a, q) : null },
        drill: k.startsWith('a') ? reportDrill('sales_by_item_detail', { ...rangeParams(p) }) : reportDrill('sales_by_item_detail', { ...rangeParams(p), item_ids: Number(k) }),
      });
    }
    sq = Math.round(sq * 1e6) / 1e6;
    rows.push({ kind: 'subtotal', depth: 0, label: `Total ${SECTION_LABEL[sec]}`, cells: { qty: sq, amount: sa, pct: pct(sa, total), avg: sq ? divCents(sa, sq) : null } });
  }
  const tq = sumQty(lines);
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { qty: tq, amount: total, pct: total ? 100 : null, avg: tq ? divCents(total, tq) : null } });
  return {
    subtitle: rangeSubtitle(p),
    columns: [col('label', ''), col('qty', 'Qty', 'qty'), col('amount', 'Amount', 'money'), col('pct', '% of Sales', 'percent'), col('avg', 'Avg. Price', 'money')],
    rows,
  };
}

/** The customizable item detail report: totals by item, customer, month, or none. */
export function salesByItemDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const lines = salesLines(db, L, p);
  const by = p.extra.total_by as string;
  let rows: Row[];
  if (by === 'customer') {
    const ids = [...new Set(lines.map((l) => l.name_id))].sort((a, b) => byName(L.names.get(a)?.full_name ?? '', L.names.get(b)?.full_name ?? ''));
    rows = grouped(L, lines, ids.map((id) => ({ key: String(id), label: L.names.get(id)?.full_name ?? '' })), (l) => String(l.name_id));
  } else if (by === 'month') {
    const ms = [...new Set(lines.map((l) => l.date.slice(0, 7)))].sort();
    rows = grouped(L, lines, ms.map((m) => ({ key: m, label: longMonthLabel(m) })), (l) => l.date.slice(0, 7));
  } else if (by === 'none') {
    let bal = 0;
    rows = lines.map((l) => {
      bal += l.amount;
      return { kind: 'data', depth: 0, cells: lineCells(L, l, bal), drill: txnDrill(l.txn_id, l.type) };
    });
  } else {
    const keys = orderedKeys(L, lines.map((l) => l.key));
    rows = grouped(L, lines, keys.map((k) => ({ key: k, label: itemKeyLabel(L, k) })), (l) => l.key);
  }
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { qty: sumQty(lines), amount: sumAmt(lines), balance: sumAmt(lines) } });
  return { subtitle: rangeSubtitle(p), rows };
}

// ---------------------------------------------------------------------------
// Trip report (replaces the Awk script over invoices)

export interface Trip {
  date: string;
  customer_id: number; // top-level customer
  invoices: { id: number; num: string; total: number }[];
  total: number;
  picks_up: boolean;
}

/**
 * One trip = one top-level customer (jobs roll up) on one invoice date, from invoices only
 * (not credit memos, not finance charges). Invoices of a customer or job flagged "picks up"
 * (on itself or any customer above it) are left out unless includePicksUp.
 */
export function trips(db: DB, L: Lookups, p: Params, includePicksUp: boolean): Trip[] {
  const rows = db
    .prepare(
      `SELECT id, date, num, name_id, total FROM txns
        WHERE type = 'INVOICE' AND is_finance_charge = 0 AND date >= ? AND date <= ? ORDER BY date, id`,
    )
    .all(lo(p), hi(p)) as { id: number; date: string; num: string; name_id: number; total: number }[];
  const f = p.name_ids.length ? nameFilter(L, p) : null;
  const picks = (id: number) => {
    let n = L.names.get(id);
    for (let i = 0; n && i < 50; i++) {
      if (n.picks_up) return true;
      n = n.parent_id !== null ? L.names.get(n.parent_id) : undefined;
    }
    return false;
  };
  const byKey = new Map<string, Trip>();
  for (const r of rows) {
    if (f && !f.has(r.name_id)) continue;
    const pu = picks(r.name_id);
    if (pu && !includePicksUp) continue;
    const root = L.names.get(r.name_id)?.root_id ?? r.name_id;
    const key = `${r.date}|${root}`;
    const t = byKey.get(key) ?? { date: r.date, customer_id: root, invoices: [], total: 0, picks_up: false };
    t.invoices.push({ id: r.id, num: r.num, total: r.total });
    t.total += r.total;
    t.picks_up ||= pu;
    byKey.set(key, t);
  }
  const name = (id: number) => L.names.get(id)?.full_name ?? '';
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byName(name(a.customer_id), name(b.customer_id))));
}

export function tripReport(db: DB, p: Params): Built {
  const L = lookups(db);
  const inc = p.extra.include_picks_up === true;
  const ts = trips(db, L, p, inc);
  const name = (id: number) => L.names.get(id)?.full_name ?? '';
  const mode = p.extra.mode as string;
  const subtitle = rangeSubtitle(p);
  const range = rangeParams(p);

  if (mode === 'detail') {
    const rows: Row[] = ts.map((t) => ({
      kind: 'data',
      depth: 0,
      cells: {
        date: t.date,
        customer: name(t.customer_id),
        invoices: t.invoices.map((i) => i.num).join(', '),
        count: t.invoices.length,
        amount: t.total,
        ...(inc ? { picks_up: t.picks_up ? 'Picks up' : '' } : {}),
      },
      drill: t.invoices.length === 1 ? txnDrill(t.invoices[0].id, 'INVOICE') : reportDrill('sales_by_customer_detail', { from: t.date, to: t.date, name_ids: t.customer_id }),
    }));
    rows.push({ kind: 'total', depth: 0, label: `Total trips: ${ts.length}`, cells: { count: ts.reduce((s, t) => s + t.invoices.length, 0), amount: ts.reduce((s, t) => s + t.total, 0) } });
    const columns = [
      col('date', 'Date', 'date'),
      col('customer', 'Customer'),
      col('invoices', 'Invoices'),
      col('count', '# Inv.', 'qty'),
      col('amount', 'Amount', 'money'),
      ...(inc ? [col('picks_up', 'Picks Up')] : []),
    ];
    return { subtitle, columns, rows };
  }

  if (mode === 'by_month') {
    const per = new Map<string, number>();
    for (const t of ts) per.set(t.date.slice(0, 7), (per.get(t.date.slice(0, 7)) ?? 0) + 1);
    const rows: Row[] = [...per.keys()].sort().map((m) => ({
      kind: 'data',
      depth: 0,
      cells: { month: longMonthLabel(m), trips: per.get(m)! },
      drill: reportDrill('trip_report', { from: `${m}-01`, to: lastDay(m), mode: 'detail', include_picks_up: String(inc), name_ids: p.name_ids }),
    }));
    rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { trips: ts.length } });
    return { subtitle, columns: [col('month', 'Month'), col('trips', 'Trips', 'qty')], rows };
  }

  const ids = [...new Set(ts.map((t) => t.customer_id))].sort((a, b) => byName(name(a), name(b)));
  if (mode === 'grid') {
    const b = txnDateBounds(db, p.today);
    const months = monthsBetween(p.from ?? (ts[0]?.date ?? b.min), p.to ?? (ts[ts.length - 1]?.date ?? b.max));
    const rows: Row[] = ids.map((id) => {
      const mine = ts.filter((t) => t.customer_id === id);
      const cells: Record<string, number | string> = { customer: name(id), total: mine.length };
      for (const m of months) cells[`m${m}`] = mine.filter((t) => t.date.startsWith(m)).length;
      return { kind: 'data', depth: 0, cells, drill: reportDrill('trip_report', { ...range, mode: 'detail', include_picks_up: String(inc), name_ids: id }) };
    });
    const tot: Record<string, number> = { total: ts.length };
    for (const m of months) tot[`m${m}`] = ts.filter((t) => t.date.startsWith(m)).length;
    rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: tot });
    return { subtitle, columns: [col('customer', 'Customer'), ...months.map((m) => col(`m${m}`, monthLabel(m), 'qty')), col('total', 'TOTAL', 'qty')], rows };
  }

  // by_customer
  const rows: Row[] = ids.map((id) => ({
    kind: 'data',
    depth: 0,
    cells: { customer: name(id), trips: ts.filter((t) => t.customer_id === id).length },
    drill: reportDrill('trip_report', { ...range, mode: 'detail', include_picks_up: String(inc), name_ids: id }),
  }));
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { trips: ts.length } });
  return { subtitle, columns: [col('customer', 'Customer'), col('trips', 'Trips', 'qty')], rows };
}

function lastDay(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
