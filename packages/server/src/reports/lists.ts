import { itemType, type ReportColumn } from '@rapidbooks/shared';
import type { DB } from '../db';
import { payrollSummary } from '../ledger/payables';
import { listItems } from '../lists/items';
import { listNames } from '../lists/names';
import { listTerms } from '../lists/terms';
import { balancesByName } from './balances';
import { col, hi, lo, lookups, nameFilter, rangeParams, rangeSubtitle, reportDrill, round, txnDrill, type Built, type Params, type Row } from './engine';

// Employees & Payroll, and the list reports.

// ---------------------------------------------------------------------------
// Payroll

const KIND_ORDER = ['earning', 'deduction', 'company'] as const;

/**
 * Payroll Summary: payroll items down the side (earnings, deductions, employer
 * contributions), one column per employee plus a total. Deductions are shown negative,
 * so Gross Pay + Deductions = Net Pay.
 */
export function payrollSummaryReport(db: DB, p: Params): Built {
  const L = lookups(db);
  const showHours = p.extra.show_hours === true;
  const f = p.name_ids.length ? nameFilter(L, p) : null;
  const rows0 = payrollSummary(db, lo(p), hi(p)).filter((r) => !f || f.has(r.employee_id));
  const emps = [...new Map(rows0.map((r) => [r.employee_id, r.employee])).entries()];
  const items = [...new Map(rows0.map((r) => [r.payroll_item_id, { id: r.payroll_item_id, name: r.payroll_item, kind: r.kind }])).values()];
  const cell = (e: number | 'total', item: number, what: 'amount' | 'hours') => {
    const rs = rows0.filter((r) => r.payroll_item_id === item && (e === 'total' || r.employee_id === e));
    return what === 'hours' ? round(rs.reduce((t, r) => t + r.hours, 0), 6) : rs.reduce((t, r) => t + r.amount, 0);
  };
  const keys: [number | 'total', string][] = [...emps.map(([id]) => [id, `e${id}`] as [number, string]), ['total', 'total']];
  const columns: ReportColumn[] = [col('label', '')];
  for (const [id, k] of keys) {
    const title = id === 'total' ? 'TOTAL' : emps.find((e) => e[0] === id)![1];
    if (showHours) columns.push(col(`${k}_hours`, `${title} Hours`, 'qty'));
    columns.push(col(k, title, 'money'));
  }
  const totals = (kind: string) => {
    const c: Record<string, number> = {};
    for (const [id, k] of keys) {
      const sign = kind === 'deduction' ? -1 : 1;
      c[k] = sign * rows0.filter((r) => r.kind === kind && (id === 'total' || r.employee_id === id)).reduce((t, r) => t + r.amount, 0);
      if (showHours) c[`${k}_hours`] = round(rows0.filter((r) => r.kind === kind && (id === 'total' || r.employee_id === id)).reduce((t, r) => t + r.hours, 0), 6);
    }
    return c;
  };
  const titles: Record<string, [string, string]> = {
    earning: ['Gross Pay', 'Total Gross Pay'],
    deduction: ['Deductions from Gross Pay', 'Total Deductions from Gross Pay'],
    company: ['Employer Taxes and Contributions', 'Total Employer Taxes and Contributions'],
  };
  const rows: Row[] = [];
  for (const kind of KIND_ORDER) {
    const its = items.filter((i) => i.kind === kind);
    if (its.length === 0 && kind !== 'earning') {
      if (kind === 'deduction') rows.push(netRow());
      continue;
    }
    rows.push({ kind: 'header', depth: 0, label: titles[kind][0], cells: {} });
    for (const it of its) {
      const c: Record<string, number> = {};
      for (const [id, k] of keys) {
        c[k] = (kind === 'deduction' ? -1 : 1) * (cell(id, it.id, 'amount') as number);
        if (showHours) c[`${k}_hours`] = cell(id, it.id, 'hours') as number;
      }
      rows.push({ kind: 'data', depth: 1, label: it.name, cells: c, drill: reportDrill('payroll_detail', { ...rangeParams(p), name_ids: p.name_ids }) });
    }
    rows.push({ kind: 'subtotal', depth: 0, label: titles[kind][1], cells: totals(kind) });
    if (kind === 'deduction') rows.push(netRow());
  }
  function netRow(): Row {
    const g = totals('earning');
    const d = totals('deduction');
    return { kind: 'subtotal', depth: 0, label: 'Net Pay', cells: Object.fromEntries(keys.map(([, k]) => [k, (g[k] ?? 0) + (d[k] ?? 0)])) };
  }
  return { subtitle: rangeSubtitle(p), columns, rows };
}

/** Payroll Detail: each paycheck's lines (deductions negative) and its net pay. */
export function payrollDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const f = p.name_ids.length ? nameFilter(L, p) : null;
  const checks = db
    .prepare("SELECT id, date, num, name_id, total, period_from, period_to FROM txns WHERE type = 'PAYCHECK' AND date >= ? AND date <= ? ORDER BY date, id")
    .all(lo(p), hi(p)) as { id: number; date: string; num: string; name_id: number; total: number; period_from: string; period_to: string }[];
  const lineQ = db.prepare(
    `SELECT p.name, p.kind, l.qty, l.rate, l.amount FROM lines l JOIN payroll_items p ON p.id = l.payroll_item_id WHERE l.txn_id = ? ORDER BY l.seq`,
  );
  const rows: Row[] = [];
  let net = 0;
  for (const c of checks) {
    if (f && !f.has(c.name_id)) continue;
    const emp = L.names.get(c.name_id)?.full_name ?? '';
    rows.push({ kind: 'header', depth: 0, label: `${emp} - Check ${c.num || '(to print)'}`, cells: {}, drill: txnDrill(c.id, 'PAYCHECK') });
    for (const l of lineQ.all(c.id) as { name: string; kind: string; qty: number | null; rate: number | null; amount: number }[]) {
      rows.push({
        kind: 'data',
        depth: 1,
        cells: { date: c.date, num: c.num, employee: emp, item: l.name, kind: l.kind === 'earning' ? 'Earning' : l.kind === 'deduction' ? 'Deduction' : 'Company', hours: l.qty, rate: l.rate, amount: l.kind === 'deduction' ? -l.amount : l.amount },
        drill: txnDrill(c.id, 'PAYCHECK'),
      });
    }
    net += c.total;
    rows.push({ kind: 'subtotal', depth: 0, label: 'Net Pay', cells: { amount: c.total } });
  }
  rows.push({ kind: 'total', depth: 0, label: 'Total Net Pay', cells: { amount: net } });
  return {
    subtitle: rangeSubtitle(p),
    columns: [
      col('date', 'Date', 'date'),
      col('num', 'Num'),
      col('employee', 'Employee'),
      col('item', 'Payroll Item'),
      col('kind', 'Kind'),
      col('hours', 'Hours', 'qty'),
      col('rate', 'Rate', 'money'),
      col('amount', 'Amount', 'money'),
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Lists

export const CONTACT_COLUMNS: ReportColumn[] = [
  col('name', 'Name'),
  col('company', 'Company'),
  col('contact', 'Contact'),
  col('phone', 'Phone'),
  col('alt_phone', 'Alt. Phone'),
  col('fax', 'Fax'),
  col('email', 'E-mail'),
  col('bill_addr', 'Bill to'),
  col('ship_addr', 'Ship to'),
  col('account_no', 'Account No.'),
  col('terms', 'Terms'),
  col('picks_up', 'Picks Up', 'text', 'center'),
  col('balance', 'Balance', 'money'),
];

export function contactList(kind: 'customer' | 'vendor') {
  return (db: DB, p: Params): Built => {
    const terms = new Map(listTerms(db).map((t) => [t.id, t.name]));
    const showInactive = p.extra.include_inactive === true;
    const rows: Row[] = listNames(db, kind)
      .filter((n) => showInactive || !n.inactive)
      .map((n) => ({
        kind: 'data' as const,
        depth: n.depth,
        cells: {
          name: n.full_name,
          company: n.company,
          contact: n.contact,
          phone: n.phone,
          alt_phone: n.alt_phone,
          fax: n.fax,
          email: n.email,
          bill_addr: n.bill_addr.replace(/\n/g, ', '),
          ship_addr: n.ship_addr.replace(/\n/g, ', '),
          account_no: n.account_no,
          terms: n.terms_id !== null ? (terms.get(n.terms_id) ?? '') : '',
          picks_up: n.picks_up ? 'Yes' : '',
          balance: n.balance,
        },
        drill: reportDrill('quickreport', { name_id: n.id, date: 'all' }),
      }));
    return { subtitle: '', rows };
  };
}

export function itemPriceList(db: DB, p: Params): Built {
  const showInactive = p.extra.include_inactive === true;
  const rows: Row[] = listItems(db)
    .filter((i) => (showInactive || !i.inactive) && i.type !== 'SUBTOTAL' && i.type !== 'GROUP')
    .map((i) => ({
      kind: 'data' as const,
      depth: i.depth,
      cells: {
        item: i.full_name,
        type: itemType(i.type).label,
        description: i.description,
        price: i.rate_is_percent ? null : i.rate,
        price_pct: i.rate_is_percent ? i.rate / 100 : null,
        cost: i.cost || null,
      },
      drill: reportDrill('quickreport', { item_id: i.id, date: 'all' }),
    }));
  return {
    subtitle: '',
    columns: [col('item', 'Item'), col('type', 'Type'), col('description', 'Description'), col('price', 'Price', 'money'), col('price_pct', 'Price %', 'percent'), col('cost', 'Cost', 'money')],
    rows,
  };
}

export function accountListing(db: DB, p: Params): Built {
  const L = lookups(db);
  const showInactive = p.extra.include_inactive === true;
  const label = (t: string) => ({ BANK: 'Bank', AR: 'Accounts Receivable', OCA: 'Other Current Asset', FA: 'Fixed Asset', AP: 'Accounts Payable', CC: 'Credit Card', OCL: 'Other Current Liability', LTL: 'Long Term Liability', EQUITY: 'Equity', INC: 'Income', COGS: 'Cost of Goods Sold', EXP: 'Expense', OINC: 'Other Income', OEXP: 'Other Expense' })[t] ?? t;
  const bs = (t: string) => ['BANK', 'AR', 'OCA', 'FA', 'AP', 'CC', 'OCL', 'LTL', 'EQUITY'].includes(t);
  const rows: Row[] = L.accounts
    .filter((a) => showInactive || !a.inactive)
    .map((a) => ({
      kind: 'data' as const,
      depth: 0,
      cells: {
        account: a.full_name,
        type: label(a.type),
        balance: bs(a.type) ? (['BANK', 'AR', 'OCA', 'FA'].includes(a.type) ? a.balance : -a.balance) : null,
        description: a.description,
      },
      drill: reportDrill('quickreport', { account_id: a.id, date: 'all' }),
    }));
  return {
    subtitle: '',
    columns: [col('account', 'Account'), col('type', 'Type'), col('balance', 'Balance Total', 'money'), col('description', 'Description')],
    rows,
  };
}

export function termsListing(db: DB): Built {
  const rows: Row[] = listTerms(db).map((t) => ({
    kind: 'data' as const,
    depth: 0,
    cells: { terms: t.name, net_days: t.net_days, discount_pct: t.discount_pct / 100, discount_days: t.discount_days, inactive: t.inactive ? 'Yes' : '' },
  }));
  return {
    subtitle: '',
    columns: [col('terms', 'Terms'), col('net_days', 'Net Due (days)', 'qty'), col('discount_pct', 'Discount %', 'percent'), col('discount_days', 'Discount Days', 'qty'), col('inactive', 'Inactive', 'text', 'center')],
    rows,
  };
}

