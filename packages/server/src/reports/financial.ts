import type { Account, ReportColumn, ReportDrill } from '@rapidbooks/shared';
import type { DB } from '../db';
import { closingBalances, fyStart, natural, retainedAccount, sumsByAccount, sumsByAccountMonth } from './data';
import {
  asOfSubtitle,
  col,
  hi,
  lo,
  longMonthLabel,
  lookups,
  monthLabel,
  monthsBetween,
  rangeParams,
  rangeSubtitle,
  reportDrill,
  txnDateBounds,
  type Built,
  type Lookups,
  type Params,
  type Row,
} from './engine';

// Company & Financial: Profit & Loss (standard and by month), Balance Sheet, Trial Balance.

/**
 * Rows for the accounts of the given types, sub-accounts indented under their parent:
 *   Parent (header) / children / "Parent - Other" (its own amount) / Total Parent.
 * Accounts whose values are all zero are left out. Returns the rows and the totals.
 */
export function accountTree(
  L: Lookups,
  types: string[],
  vals: (a: Account) => number[],
  keys: string[],
  depth: number,
  drill: (a: Account) => ReportDrill | undefined,
): { rows: Row[]; total: number[] } {
  const kids = new Map<number | null, Account[]>();
  for (const a of L.accounts) {
    const list = kids.get(a.parent_id) ?? [];
    list.push(a);
    kids.set(a.parent_id, list);
  }
  const zero = () => keys.map(() => 0);
  const cells = (v: number[]) => Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  const nonzero = (v: number[]) => v.some((x) => x !== 0);

  const walk = (a: Account, d: number): { rows: Row[]; total: number[] } => {
    const own = vals(a);
    const sub = (kids.get(a.id) ?? []).map((c) => walk(c, d + 1));
    const subRows = sub.flatMap((s) => s.rows);
    const total = own.map((v, i) => v + sub.reduce((t, s) => t + s.total[i], 0));
    if (subRows.length === 0) {
      return nonzero(own) ? { rows: [{ kind: 'data', depth: d, label: a.name, cells: cells(own), drill: drill(a) }], total } : { rows: [], total };
    }
    const rows: Row[] = [{ kind: 'header', depth: d, label: a.name, cells: {}, drill: drill(a) }, ...subRows];
    if (nonzero(own)) rows.push({ kind: 'data', depth: d + 1, label: `${a.name} - Other`, cells: cells(own), drill: drill(a) });
    rows.push({ kind: 'subtotal', depth: d, label: `Total ${a.name}`, cells: cells(total), drill: drill(a) });
    return { rows, total };
  };

  const rows: Row[] = [];
  const total = zero();
  for (const a of L.accounts.filter((x) => x.parent_id === null && types.includes(x.type))) {
    const r = walk(a, depth);
    rows.push(...r.rows);
    r.total.forEach((v, i) => (total[i] += v));
  }
  return { rows, total };
}

// ---------------------------------------------------------------------------
// Profit & Loss

interface PlLayout {
  keys: string[];
  vals: (a: Account) => number[]; // natural sign (income and expense both positive)
  drill: (a: Account) => ReportDrill | undefined;
  niDrill?: ReportDrill;
}

function plRows(L: Lookups, lay: PlLayout): { rows: Row[]; net: number[] } {
  const { keys } = lay;
  const cells = (v: number[]) => Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const add = (a: number[], b: number[]) => a.map((x, i) => x + b[i]);
  const section = (type: string, title: string, totalTitle: string, depth: number) => {
    const t = accountTree(L, [type], lay.vals, keys, depth + 1, lay.drill);
    const rows: Row[] = t.rows.length
      ? [{ kind: 'header', depth, label: title, cells: {} }, ...t.rows, { kind: 'subtotal', depth, label: totalTitle, cells: cells(t.total) }]
      : [];
    return { rows, total: t.total };
  };

  const rows: Row[] = [{ kind: 'header', depth: 0, label: 'Ordinary Income/Expense', cells: {} }];
  const inc = section('INC', 'Income', 'Total Income', 1);
  const cogs = section('COGS', 'Cost of Goods Sold', 'Total COGS', 1);
  const gross = sub(inc.total, cogs.total);
  rows.push(...inc.rows, ...cogs.rows, { kind: 'subtotal', depth: 1, label: 'Gross Profit', cells: cells(gross) });
  const exp = section('EXP', 'Expense', 'Total Expense', 1);
  const ordinary = sub(gross, exp.total);
  rows.push(...exp.rows, { kind: 'subtotal', depth: 0, label: 'Net Ordinary Income', cells: cells(ordinary) });

  const oinc = section('OINC', 'Other Income', 'Total Other Income', 1);
  const oexp = section('OEXP', 'Other Expense', 'Total Other Expense', 1);
  const other = sub(oinc.total, oexp.total);
  if (oinc.rows.length || oexp.rows.length) {
    rows.push({ kind: 'header', depth: 0, label: 'Other Income/Expense', cells: {} }, ...oinc.rows, ...oexp.rows);
    rows.push({ kind: 'subtotal', depth: 0, label: 'Net Other Income', cells: cells(other) });
  }
  const net = add(ordinary, other);
  rows.push({ kind: 'total', depth: 0, label: 'Net Income', cells: cells(net), drill: lay.niDrill });
  return { rows, net };
}

const PL_COLS: ReportColumn[] = [col('label', ''), col('amount', 'Amount', 'money')];

export function profitAndLoss(db: DB, p: Params): Built {
  const L = lookups(db);
  const sums = sumsByAccount(db, lo(p), hi(p));
  const filter = p.account_ids.length ? new Set(p.account_ids) : null;
  const { rows } = plRows(L, {
    keys: ['amount'],
    vals: (a) => [filter && !filter.has(a.id) ? 0 : natural(a, sums.get(a.id) ?? 0)],
    drill: (a) => reportDrill('pl_detail', { ...rangeParams(p), account_ids: a.id }),
  });
  return { subtitle: rangeSubtitle(p), columns: PL_COLS, rows };
}

export function profitAndLossByMonth(db: DB, p: Params): Built {
  const L = lookups(db);
  const b = txnDateBounds(db, p.today);
  const from = p.from ?? b.min;
  const to = p.to ?? b.max;
  const months = monthsBetween(from, to);
  const sums = sumsByAccountMonth(db, from, to);
  const keys = [...months.map((m) => `m${m}`), 'total'];
  const { rows } = plRows(L, {
    keys,
    vals: (a) => {
      const m = sums.get(a.id);
      const v = months.map((ym) => natural(a, m?.get(ym) ?? 0));
      return [...v, v.reduce((t, x) => t + x, 0)];
    },
    drill: (a) => reportDrill('pl_detail', { from, to, account_ids: a.id }),
  });
  const columns: ReportColumn[] = [
    col('label', ''),
    ...months.map((m) => col(`m${m}`, monthLabel(m), 'money')),
    col('total', 'TOTAL', 'money'),
  ];
  return { subtitle: rangeSubtitle({ from, to }), columns, rows };
}

// ---------------------------------------------------------------------------
// Balance Sheet

const BS_COLS: ReportColumn[] = [col('label', ''), col('balance', 'Balance', 'money')];

export function balanceSheet(db: DB, p: Params): Built {
  const L = lookups(db);
  const asOf = p.as_of;
  const { bal, priorNI } = closingBalances(db, L, asOf);
  const startYear = fyStart(asOf);
  const ytd = sumsByAccount(db, startYear, asOf);
  let ni = 0;
  for (const a of L.accounts) if (['INC', 'COGS', 'EXP', 'OINC', 'OEXP'].includes(a.type)) ni -= ytd.get(a.id) ?? 0;

  const v = (a: Account) => [natural(a, bal.get(a.id) ?? 0)];
  const drill = (a: Account) => reportDrill('txn_detail_by_account', { from: '', to: asOf, account_ids: a.id });
  const keys = ['balance'];
  const cell = (n: number) => ({ balance: n });
  const group = (types: string[], title: string, depth: number) => {
    const t = accountTree(L, types, v, keys, depth + 1, drill);
    const rows: Row[] = t.rows.length
      ? [{ kind: 'header', depth, label: title, cells: {} }, ...t.rows, { kind: 'subtotal', depth, label: `Total ${title}`, cells: cell(t.total[0]) }]
      : [];
    return { rows, total: t.total[0] };
  };
  const wrap = (title: string, depth: number, parts: { rows: Row[]; total: number }[]) => {
    const rows = parts.flatMap((x) => x.rows);
    const total = parts.reduce((t, x) => t + x.total, 0);
    return {
      rows: rows.length ? [{ kind: 'header' as const, depth, label: title, cells: {} }, ...rows, { kind: 'subtotal' as const, depth, label: `Total ${title}`, cells: cell(total) }] : [],
      total,
    };
  };

  const rows: Row[] = [];
  // Assets
  const current = wrap('Current Assets', 1, [
    group(['BANK'], 'Checking/Savings', 2),
    group(['AR'], 'Accounts Receivable', 2),
    group(['OCA'], 'Other Current Assets', 2),
  ]);
  const fixed = group(['FA'], 'Fixed Assets', 1);
  const assets = current.total + fixed.total;
  rows.push({ kind: 'header', depth: 0, label: 'ASSETS', cells: {} }, ...current.rows, ...fixed.rows);
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL ASSETS', cells: cell(assets) });

  // Liabilities
  const curLiab = wrap('Current Liabilities', 2, [
    group(['AP'], 'Accounts Payable', 3),
    group(['CC'], 'Credit Cards', 3),
    group(['OCL'], 'Other Current Liabilities', 3),
  ]);
  const ltl = group(['LTL'], 'Long Term Liabilities', 2);
  const liab = wrap('Liabilities', 1, [curLiab, ltl]);

  // Equity: the accounts (Retained Earnings carrying the earlier years' net income), then Net Income.
  const eq = accountTree(L, ['EQUITY'], v, keys, 2, drill);
  const eqRows = [...eq.rows];
  let eqTotal = eq.total[0];
  if (!retainedAccount(L) && priorNI !== 0) {
    eqRows.push({ kind: 'data', depth: 2, label: 'Retained Earnings', cells: cell(priorNI), drill: reportDrill('pl_standard', { from: '', to: `${Number(asOf.slice(0, 4)) - 1}-12-31` }) });
    eqTotal += priorNI;
  }
  if (ni !== 0) {
    eqRows.push({ kind: 'data', depth: 2, label: 'Net Income', cells: cell(ni), drill: reportDrill('pl_standard', { from: startYear, to: asOf }) });
    eqTotal += ni;
  }
  const equity = {
    rows: eqRows.length ? [{ kind: 'header' as const, depth: 1, label: 'Equity', cells: {} }, ...eqRows, { kind: 'subtotal' as const, depth: 1, label: 'Total Equity', cells: cell(eqTotal) }] : [],
    total: eqTotal,
  };
  rows.push({ kind: 'header', depth: 0, label: 'LIABILITIES & EQUITY', cells: {} }, ...liab.rows, ...equity.rows);
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL LIABILITIES & EQUITY', cells: cell(liab.total + equity.total) });
  return { subtitle: asOfSubtitle(asOf), columns: BS_COLS, rows };
}

// ---------------------------------------------------------------------------
// Trial Balance

const TB_COLS: ReportColumn[] = [col('label', ''), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')];

/**
 * Trial Balance as of a date, as QuickBooks prints it: balance-sheet accounts as of the
 * date, income and expense accounts for the fiscal year to date, and Retained Earnings
 * including the net income of earlier years. Debits equal credits.
 */
export function trialBalance(db: DB, p: Params): Built {
  const L = lookups(db);
  const { bal, priorNI } = closingBalances(db, L, p.as_of);
  const rows: Row[] = [];
  let dr = 0;
  let cr = 0;
  const start = fyStart(p.as_of);
  const push = (label: string, v: number, drill?: Row['drill']) => {
    if (v === 0) return;
    if (v > 0) dr += v;
    else cr -= v;
    rows.push({ kind: 'data', depth: 0, label, cells: { debit: v > 0 ? v : null, credit: v < 0 ? -v : null }, drill });
  };
  for (const a of L.accounts) {
    const pl = ['INC', 'COGS', 'EXP', 'OINC', 'OEXP'].includes(a.type);
    push(a.full_name, bal.get(a.id) ?? 0, reportDrill('txn_detail_by_account', { from: pl ? start : '', to: p.as_of, account_ids: a.id }));
  }
  if (!retainedAccount(L)) push('Retained Earnings', -priorNI);
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { debit: dr, credit: cr } });
  return { subtitle: asOfSubtitle(p.as_of), columns: TB_COLS, rows };
}

