import type { Report, ReportRow } from '@rapidbooks/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { listAccounts } from '../src/ledger/accounts';
import { getTxn } from '../src/ledger/posting';
import { getStatement } from '../src/ledger/statements';
import { toCsv } from '../src/reports/engine';
import { find, incomeExpenseGraph, salesGraph } from '../src/reports/find';
import { listReports, REPORTS, runReport } from '../src/reports/registry';
import { buildFixture, type Fixture } from './reports-fixture';

let F: Fixture;
const TODAY = '2026-11-11';
const run = (id: string, q: Record<string, string | number> = {}): Report =>
  runReport(F.db, id, { today: TODAY, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) });
const Y25 = { from: '2025-01-01', to: '2025-12-31' };
const Y26 = { from: '2026-01-01', to: '2026-12-31' };

/** The first row whose label (any text cell) is `label`. */
function row(r: Report, label: string): ReportRow {
  const found = r.rows.find((x) => Object.values(x.cells).includes(label));
  if (!found) throw new Error(`No row "${label}" in ${r.id}: ${r.rows.map((x) => Object.values(x.cells)[0]).join(' | ')}`);
  return found;
}
const cell = (r: Report, label: string, key: string) => row(r, label).cells[key];
const total = (r: Report) => r.rows.find((x) => x.kind === 'total')!;
const balanceOf = (name: string, asOf: string) =>
  (F.db.prepare('SELECT COALESCE(SUM(s.amount), 0) AS n FROM splits s JOIN txns t ON t.id = s.txn_id WHERE s.account_id = ? AND t.date <= ?').get(F.a[name], asOf) as { n: number }).n;
const typeBalance = (type: string, asOf: string) =>
  (F.db.prepare('SELECT COALESCE(SUM(s.amount), 0) AS n FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id WHERE a.type = ? AND t.date <= ?').get(type, asOf) as { n: number }).n;

beforeAll(() => {
  F = buildFixture();
});

describe('the registry', () => {
  it('lists every report with its group, parameters and columns', () => {
    const defs = listReports();
    expect(defs.length).toBe(REPORTS.length);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    for (const d of defs) {
      expect(d.title).not.toBe('');
      expect('run' in d).toBe(false);
      for (const k of d.default_columns) expect(d.columns.some((c) => c.key === k)).toBe(true);
    }
    expect(defs.map((d) => d.id)).toContain('trip_report');
  });
});

describe('Profit & Loss', () => {
  it('has each section and net income to the cent for 2025', () => {
    const r = run('pl_standard', Y25);
    expect(r.subtitle).toBe('January 1 through December 31, 2025');
    expect(cell(r, 'Machining', 'amount')).toBe(130000);
    expect(cell(r, 'Parts', 'amount')).toBe(37500);
    expect(cell(r, 'Sales - Other', 'amount')).toBe(-1100);
    expect(cell(r, 'Total Sales', 'amount')).toBe(166400);
    expect(cell(r, 'Total Income', 'amount')).toBe(166400);
    expect(cell(r, 'Total COGS', 'amount')).toBe(66500);
    expect(cell(r, 'Gross Profit', 'amount')).toBe(99900);
    expect(cell(r, 'Electric', 'amount')).toBe(12000);
    expect(cell(r, 'Utilities - Other', 'amount')).toBe(3000);
    expect(cell(r, 'Total Utilities', 'amount')).toBe(15000);
    expect(cell(r, 'Total Expense', 'amount')).toBe(151710);
    expect(cell(r, 'Net Ordinary Income', 'amount')).toBe(-51810);
    expect(cell(r, 'Total Other Income', 'amount')).toBe(1900);
    expect(cell(r, 'Total Other Expense', 'amount')).toBe(2000);
    expect(cell(r, 'Net Other Income', 'amount')).toBe(-100);
    expect(total(r).cells.amount).toBe(-51910);
    // Accounts with nothing in the period are left out.
    expect(r.rows.some((x) => x.cells.label === 'Uncategorized Expenses')).toBe(false);
  });

  it('has net income to the cent for 2026, without other income/expense', () => {
    const r = run('pl_standard', Y26);
    expect(cell(r, 'Total Income', 'amount')).toBe(41500);
    expect(cell(r, 'Total COGS', 'amount')).toBe(7000);
    expect(cell(r, 'Total Expense', 'amount')).toBe(143960);
    expect(r.rows.some((x) => x.cells.label === 'Other Income/Expense')).toBe(false);
    expect(total(r).cells.amount).toBe(-109460);
  });

  it('by month: the months add up to the total, and the totals match the standard report', () => {
    for (const y of [Y25, Y26]) {
      const m = run('pl_by_month', y);
      const s = run('pl_standard', y);
      expect(m.columns.length).toBe(14); // label, 12 months, total
      const months = m.columns.filter((c) => c.key.startsWith('m')).map((c) => c.key);
      for (const r of m.rows) {
        if (r.kind === 'header' || r.kind === 'blank') continue;
        const sum = months.reduce((t, k) => t + (r.cells[k] as number), 0);
        expect(sum).toBe(r.cells.total);
        expect(cell(s, r.cells.label as string, 'amount')).toBe(r.cells.total);
      }
    }
  });

  it('detail: the account totals and net income agree with the standard report', () => {
    const d = run('pl_detail', Y25);
    expect(total(d).cells.amount).toBe(-51910);
    expect(cell(d, 'Total Income', 'amount')).toBe(166400);
    expect(cell(d, 'Total Sales:Machining', 'amount')).toBe(130000);
  });
});

describe('Balance Sheet', () => {
  const dates = ['2025-01-01', '2025-02-28', '2025-12-31', '2026-01-01', '2026-03-31', '2026-12-31'];
  it('balances on every date, across the year boundary', () => {
    for (const asOf of dates) {
      const r = run('balance_sheet', { as_of: asOf });
      expect(cell(r, 'TOTAL ASSETS', 'balance'), asOf).toBe(cell(r, 'TOTAL LIABILITIES & EQUITY', 'balance'));
    }
  });

  it('rolls the earlier years net income into Retained Earnings', () => {
    const end25 = run('balance_sheet', { as_of: '2025-12-31' });
    expect(cell(end25, 'Net Income', 'balance')).toBe(-51910);
    expect(end25.rows.some((x) => x.cells.label === 'Retained Earnings')).toBe(false);
    const start26 = run('balance_sheet', { as_of: '2026-01-01' });
    expect(cell(start26, 'Retained Earnings', 'balance')).toBe(-51910);
    expect(start26.rows.some((x) => x.cells.label === 'Net Income')).toBe(false);
    const mar26 = run('balance_sheet', { as_of: '2026-03-31' });
    expect(cell(mar26, 'Retained Earnings', 'balance')).toBe(-51910);
    expect(cell(mar26, 'Net Income', 'balance')).toBe(-109460);
    expect(cell(mar26, 'Total Accounts Receivable', 'balance')).toBe(72000);
    expect(cell(mar26, 'Total Accounts Payable', 'balance')).toBe(16000);
    expect(cell(mar26, 'Equipment Loan', 'balance')).toBe(500000);
    expect(cell(mar26, 'Owner Capital', 'balance')).toBe(1000000);
    expect(cell(mar26, 'Total Equity', 'balance')).toBe(1000000 - 51910 - 109460);
  });
});

describe('Trial Balance', () => {
  it('debits equal credits and agree with the account balances', () => {
    for (const asOf of ['2025-06-30', '2025-12-31', '2026-03-31']) {
      const r = run('trial_balance', { as_of: asOf });
      const t = total(r).cells;
      expect(t.debit, asOf).toBe(t.credit);
      const year = `${asOf.slice(0, 4)}-01-01`;
      for (const a of listAccounts(F.db)) {
        const pl = ['INC', 'COGS', 'EXP', 'OINC', 'OEXP'].includes(a.type);
        let want = pl ? balanceOf(a.name, asOf) - balanceOf(a.name, `${Number(year.slice(0, 4)) - 1}-12-31`) : balanceOf(a.name, asOf);
        if (a.system_role === 'RETAINED' && asOf >= '2026-01-01') want += 51910; // 2025 net loss is a debit
        const rr = r.rows.find((x) => x.cells.label === a.full_name);
        const got = rr ? ((rr.cells.debit as number | null) ?? 0) - ((rr.cells.credit as number | null) ?? 0) : 0;
        expect(got, `${a.full_name} ${asOf}`).toBe(want);
      }
    }
  });

  it('the General Ledger ending balances equal the Trial Balance', () => {
    const tb = run('trial_balance', { as_of: '2026-03-31' });
    const gl = run('general_ledger', { from: '2026-01-01', to: '2026-03-31' });
    const accts = new Map(listAccounts(F.db).map((a) => [a.full_name, a]));
    let compared = 0;
    for (const r of gl.rows.filter((x) => x.kind === 'subtotal')) {
      const name = (r.cells.type as string).replace(/^Total /, '');
      const a = accts.get(name)!;
      const debitNormal = ['BANK', 'AR', 'OCA', 'FA', 'COGS', 'EXP', 'OEXP'].includes(a.type);
      const tr = tb.rows.find((x) => x.cells.label === name);
      const tbDp = tr ? ((tr.cells.debit as number | null) ?? 0) - ((tr.cells.credit as number | null) ?? 0) : 0;
      expect(r.cells.balance, name).toBe(debitNormal ? tbDp : -tbDp);
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
    // ... and every account with a Trial Balance line has a General Ledger group.
    for (const tr of tb.rows.filter((x) => x.kind === 'data')) {
      expect(gl.rows.some((x) => x.kind === 'subtotal' && x.cells.type === `Total ${tr.cells.label}`), String(tr.cells.label)).toBe(true);
    }
  });
});

describe('Journal', () => {
  it('debits equal credits per transaction and in total', () => {
    const r = run('journal', { date: 'all' });
    expect(r.columns.map((c) => c.title)).toEqual(['Trans #', 'Type', 'Date', 'Num', 'Name', 'Memo', 'Account', 'Debit', 'Credit']);
    for (const s of r.rows.filter((x) => x.kind === 'subtotal')) expect(s.cells.debit).toBe(s.cells.credit);
    const allDebits = (F.db.prepare('SELECT SUM(amount) AS n FROM splits WHERE amount > 0').get() as { n: number }).n;
    expect(total(r).cells.debit).toBe(allDebits);
    expect(total(r).cells.credit).toBe(allDebits);
    const first = r.rows.find((x) => x.kind === 'data' && x.cells.type === 'Bill Pmt -Check')!;
    expect(first.cells.num).toBe('101');
  });

  it('filters by type', () => {
    const r = run('journal', { date: 'all', txn_types: 'PAYCHECK' });
    expect(r.rows.filter((x) => x.kind === 'data' && x.cells.type === 'Paycheck').length).toBe(2);
    expect(r.rows.some((x) => x.cells.type === 'Invoice')).toBe(false);
  });
});

describe('Receivables', () => {
  const asOf = '2026-03-31';
  it('A/R aging total = A/R balance = customer balances, and the buckets are right', () => {
    const r = run('ar_aging_summary', { as_of: asOf });
    const t = total(r).cells;
    expect(t.total).toBe(72000);
    expect(t.current).toBe(-1000);
    expect(t.d31_60).toBe(41500);
    expect(t.over_90).toBe(31500);
    expect(t.d1_30).toBe(0);
    expect(typeBalance('AR', asOf)).toBe(72000);
    expect(total(run('customer_balance_summary', { as_of: asOf })).cells.balance).toBe(72000);
    expect(total(run('ar_aging_detail', { as_of: asOf })).cells.open_balance).toBe(72000);
    expect(total(run('open_invoices', { as_of: asOf })).cells.open_balance).toBe(72000);
    // Jobs under their customer.
    expect(cell(r, 'Press Frame', 'total')).toBe(32500);
    expect(cell(r, 'Total Acme', 'total')).toBe(32500 + 2500 + 500);
  });

  it('agrees with the aging printed on each customer statement', () => {
    const r = run('ar_aging_summary', { as_of: asOf });
    for (const [key, label] of [['acme', 'Total Acme'], ['dorn', 'Dorn'], ['baker', 'Baker Tool'], ['cole', 'Total Cole Mfg']]) {
      const s = getStatement(F.db, F.n[key], '2026-03-01', asOf);
      const c = row(r, label).cells;
      expect({ current: c.current, d1_30: c.d1_30, d31_60: c.d31_60, d61_90: c.d61_90, over_90: c.over_90 }, label).toEqual(s.aging);
      expect(c.total).toBe(s.ending_balance);
    }
  });

  it('a customer balance detail ends at the balance', () => {
    const r = run('customer_balance_detail', { date: 'all', name_ids: F.n.acme });
    expect(total(r).cells.balance).toBe(32500 + 2500 + 500); // 1008, 1009 and the finance charge
    // Payments were received from Acme itself, so they show under Acme, not under the job.
    expect(cell(r, 'Total Acme:Press Frame', 'balance')).toBe(90000 - 2500 + 32500);
  });

  it('the aging moves invoices between columns as the date moves', () => {
    const r = run('ar_aging_summary', { as_of: '2026-02-20' });
    expect(total(r).cells.d1_30).toBe(41500);
    expect(total(r).cells.total).toBe(typeBalance('AR', '2026-02-20'));
  });
});

describe('Payables', () => {
  it('A/P aging total = A/P balance = vendor balances = unpaid bills', () => {
    const asOf = '2026-03-31';
    const r = run('ap_aging_summary', { as_of: asOf });
    expect(total(r).cells.total).toBe(16000);
    expect(total(r).cells.d31_60).toBe(16000);
    expect(-typeBalance('AP', asOf)).toBe(16000);
    expect(total(run('vendor_balance_summary', { as_of: asOf })).cells.balance).toBe(16000);
    expect(total(run('unpaid_bills', { as_of: asOf })).cells.open_balance).toBe(16000);
    expect(total(run('ap_aging_detail', { as_of: asOf })).cells.open_balance).toBe(16000);
    // Before the bill payments: the bill less the credit is open.
    const feb = run('ap_aging_summary', { as_of: '2025-02-06' });
    expect(total(feb).cells.total).toBe(-typeBalance('AP', '2025-02-06'));
    expect(total(feb).cells.total).toBe(70000 + 12000 - 3500);
  });

  it('purchases by vendor and by item, from bills, credits and checks', () => {
    const v = run('purchases_by_vendor_summary', Y25);
    expect(cell(v, 'Steel Supply', 'amount')).toBe(70000 - 3500);
    expect(total(v).cells.amount).toBe(66500);
    const withExp = run('purchases_by_vendor_summary', { ...Y25, include_expense_lines: 'true' });
    expect(total(withExp).cells.amount).toBe(66500 + 12000 + 50000 + 3000);
    const it = run('purchases_by_item_summary', Y25);
    expect(cell(it, 'Bar Stock', 'qty')).toBe(95);
    expect(cell(it, 'Bar Stock', 'avg')).toBe(700);
    expect(total(run('purchases_by_item_detail', Y25)).cells.amount).toBe(66500);
    expect(total(run('purchases_by_vendor_detail', Y25)).cells.amount).toBe(66500);
  });

  it('open purchase orders', () => {
    const r = run('open_purchase_orders', { date: 'all' });
    expect(r.rows.filter((x) => x.kind === 'data').map((x) => x.cells.num)).toEqual(['PO2']);
    expect(total(r).cells.amount).toBe(7000);
  });
});

describe('Sales', () => {
  const incomeFromInvoices = (from: string, to: string) =>
    -(F.db
      .prepare(
        `SELECT SUM(s.amount) AS n FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id
          WHERE t.type IN ('INVOICE', 'CREDITMEMO') AND a.type IN ('INC', 'OINC') AND t.date BETWEEN ? AND ?`,
      )
      .get(from, to) as { n: number }).n;

  it('sales by customer = sales by item = income from invoices in the P&L', () => {
    for (const y of [Y25, Y26]) {
      const c = total(run('sales_by_customer_summary', y)).cells.amount;
      const i = total(run('sales_by_item_summary', y)).cells.amount;
      expect(c).toBe(i);
      expect(c).toBe(incomeFromInvoices(y.from, y.to));
      expect(total(run('sales_by_customer_detail', y)).cells.amount).toBe(c);
      expect(total(run('sales_by_item_detail', y)).cells.amount).toBe(c);
    }
    expect(total(run('sales_by_customer_summary', Y25)).cells.amount).toBe(166900);
  });

  it('sales by item: qty, amount, share and average price; discounts under their item; no subtotal', () => {
    const r = run('sales_by_item_summary', Y25);
    expect(cell(r, 'Bar Stock', 'qty')).toBe(30);
    expect(cell(r, 'Bar Stock', 'amount')).toBe(37500);
    expect(cell(r, 'Bar Stock', 'avg')).toBe(1250);
    expect(cell(r, 'Disc 10%', 'amount')).toBe(-3600);
    expect(cell(r, 'Machining', 'pct')).toBe(77.89); // 130,000 / 166,900
    expect(r.rows.some((x) => x.cells.label === 'Subtotal')).toBe(false);
    expect(cell(r, 'Finance Charge Income (no item)', 'amount')).toBe(500);
  });

  it('sales by customer rolls jobs up under the customer; credit memos are negative', () => {
    const r = run('sales_by_customer_summary', Y25);
    expect(cell(r, 'Press Frame', 'amount')).toBe(90000 - 2500);
    expect(cell(r, 'Gearbox', 'amount')).toBe(13000 + 500);
    expect(cell(r, 'Total Acme', 'amount')).toBe(101000);
  });

  it('the customizable item report: filters, columns and totals by customer or month', () => {
    const r = run('sales_by_item_detail', { ...Y25, name_ids: F.n.acme, item_ids: F.i.bar, total_by: 'customer', columns: 'date,num,po_no,customer,qty,rate,amount,ship_date,via' });
    expect(r.columns.map((c) => c.key)).toEqual(['date', 'num', 'po_no', 'customer', 'qty', 'rate', 'amount', 'ship_date', 'via']);
    expect(cell(r, 'Total Acme:Press Frame', 'amount')).toBe(25000 - 2500);
    expect(cell(r, 'Total Acme:Press Frame', 'qty')).toBe(18);
    expect(r.rows.find((x) => x.cells.num === '1001')!.cells.po_no).toBe('A-77');
    const m = run('sales_by_item_detail', { ...Y25, total_by: 'month' });
    expect(cell(m, 'Total January 2025', 'amount')).toBe(90000 + 13000 + 5000);
    expect(() => run('sales_by_item_detail', { ...Y25, columns: 'date,bogus' })).toThrow(/bogus/);
    const sorted = run('sales_by_item_detail', { ...Y25, total_by: 'none', sort: '-amount' });
    const amounts = sorted.rows.filter((x) => x.kind === 'data').map((x) => x.cells.amount as number);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });
});

describe('Trip report', () => {
  it('one trip per customer per invoice date; jobs roll up; pick-ups and finance charges left out', () => {
    const r = run('trip_report', { date: 'all' });
    const data = r.rows.filter((x) => x.kind === 'data');
    expect(data.map((x) => [x.cells.date, x.cells.customer, x.cells.invoices])).toEqual([
      ['2025-01-15', 'Acme', '1001, 1002'],
      ['2025-02-10', 'Dorn', '1004'],
      ['2025-02-11', 'Cole Mfg', '1006'],
      ['2026-01-10', 'Acme', '1008, 1009'],
      ['2026-01-12', 'Dorn', '1010'],
    ]);
    expect(data[0].cells.amount).toBe(103000);
    expect(total(r).cells.customer).toBe('Total trips: 5');
  });

  it('summaries per customer, per month and as a grid', () => {
    const c = run('trip_report', { date: 'all', mode: 'by_customer' });
    expect(cell(c, 'Acme', 'trips')).toBe(2);
    expect(cell(c, 'Dorn', 'trips')).toBe(2);
    expect(cell(c, 'Cole Mfg', 'trips')).toBe(1);
    expect(total(c).cells.trips).toBe(5);
    const m = run('trip_report', { ...Y25, mode: 'by_month' });
    expect(cell(m, 'January 2025', 'trips')).toBe(1);
    expect(cell(m, 'February 2025', 'trips')).toBe(2);
    const g = run('trip_report', { ...Y25, mode: 'grid' });
    expect(g.columns.length).toBe(14);
    expect(total(g).cells.total).toBe(3);
    expect(total(g).cells['m2025-02']).toBe(2);
  });

  it('can include the customers who pick up, for checking', () => {
    const r = run('trip_report', { date: 'all', include_picks_up: 'true' });
    expect(total(r).cells.customer).toBe('Total trips: 7');
    expect(r.rows.filter((x) => x.cells.picks_up === 'Picks up').map((x) => x.cells.customer)).toEqual(['Baker Tool', 'Cole Mfg']);
  });
});

describe('Banking', () => {
  it('missing checks: gaps and duplicates per bank account', () => {
    const r = run('missing_checks', { date: 'all' });
    const labels = r.rows.filter((x) => x.kind === 'header').map((x) => x.cells.type);
    expect(labels).toEqual(['Checking', '*** Missing numbers here: 103 ***', '*** Duplicate document number 104 ***', '*** Missing numbers here: 107 ***']);
    expect(r.rows.filter((x) => x.kind === 'data').map((x) => x.cells.num)).toEqual(['101', '102', '104', '104', '105', '106', '108']);
  });

  it('deposit detail and check detail', () => {
    const d = run('deposit_detail', { date: 'all' });
    expect(total(d).cells.amount).toBe(120650 + 13000);
    expect(d.rows.filter((x) => x.cells.type === 'Payment').length).toBe(3);
    const c = run('check_detail', Y25);
    expect(total(c).cells.amount).toBe(12000 + 65100 + 50000 + 3000 + 67040);
    // The paycheck's lines add up to the check.
    const i = c.rows.findIndex((x) => x.cells.type === 'Paycheck');
    expect((c.rows[i + 1].cells.amount as number) + (c.rows[i + 2].cells.amount as number) + (c.rows[i + 3].cells.amount as number)).toBe(67040);
    const bp = c.rows.findIndex((x) => x.cells.num === '102');
    expect(c.rows[bp + 1].cells).toMatchObject({ type: 'Bill', num: 'B-100', amount: 65100 });
  });

  it('cleared balance + uncleared = register balance', () => {
    const r = run('bank_cleared', { account_id: F.a.Checking, as_of: '2026-12-31' });
    expect(cell(r, 'Cleared Balance', 'amount')).toBe(1000000 - 12000 - 65100 + 120650);
    expect(total(r).cells.amount).toBe(balanceOf('Checking', '2026-12-31'));
    const unc = r.rows.filter((x) => x.kind === 'data').reduce((t, x) => t + (x.cells.amount as number), 0);
    expect((cell(r, 'Cleared Balance', 'amount') as number) + unc).toBe(total(r).cells.amount);
  });
});

describe('Payroll', () => {
  it('payroll summary per employee and item', () => {
    const r = run('payroll_summary', Y25);
    const e = `e${F.n.dave}`;
    expect(r.columns.map((c) => c.key)).toEqual(['label', e, 'total']);
    expect(cell(r, 'Hourly Wages', e)).toBe(80000);
    expect(cell(r, 'Federal Withholding', 'total')).toBe(-8000);
    expect(cell(r, 'Total Gross Pay', 'total')).toBe(80000);
    expect(cell(r, 'Total Deductions from Gross Pay', 'total')).toBe(-12960);
    expect(cell(r, 'Net Pay', 'total')).toBe(67040);
    expect(cell(r, 'Total Employer Taxes and Contributions', 'total')).toBe(4960);
    const h = run('payroll_summary', { date: 'all', show_hours: 'true' });
    expect(cell(h, 'Hourly Wages', 'total_hours')).toBe(80);
    expect(total(run('payroll_detail', { date: 'all' })).cells.amount).toBe(2 * 67040);
  });
});

describe('Lists, QuickReport, audit trail', () => {
  it('lists', () => {
    expect(cell(run('customer_contact_list'), 'Acme', 'phone')).toBe('937-555-0100');
    expect(cell(run('customer_contact_list'), 'Baker Tool', 'picks_up')).toBe('Yes');
    expect(cell(run('vendor_contact_list'), 'Steel Supply', 'phone')).toBe('937-555-0200');
    expect(cell(run('item_price_list'), 'Bar Stock', 'price')).toBe(1250);
    expect(cell(run('item_price_list'), 'Disc 10%', 'price_pct')).toBe(10);
    expect(cell(run('account_listing'), 'Sales:Machining', 'type')).toBe('Income');
    expect(cell(run('terms_listing'), '2% 10 Net 30', 'discount_pct')).toBe(2);
  });

  it('QuickReport of an account, a name, an item', () => {
    const a = run('quickreport', { account_id: F.a.Rent });
    expect(a.title).toBe('Rent QuickReport');
    expect(cell(a, 'Total Rent', 'balance')).toBe(100000);
    const n = run('quickreport', { name_id: F.n.acme });
    expect(n.rows.filter((x) => x.kind === 'data').length).toBe(10); // 4 invoices, finance charge, credit memo, 2 payments, 2 deposits
    const i = run('quickreport', { item_id: F.i.bar, ...Y25 });
    expect(total(i).cells.qty).toBe(20 + 4 + 8 - 2 + 100 + 100 - 5 + 10);
    expect(() => run('quickreport', {})).toThrow(/one account, name or item/);
  });

  it('transaction list by date and audit trail', () => {
    const t = run('txn_list_by_date', Y25);
    const inv = t.rows.find((x) => x.cells.num === '1004' && x.cells.type === 'Invoice')!;
    expect(inv.cells).toMatchObject({ account: 'Accounts Receivable', split: '-SPLIT-', amount: 34900 });
    const chk = t.rows.find((x) => x.cells.type === 'Check' && x.cells.memo === 'February rent')!;
    expect(chk.cells).toMatchObject({ account: 'Checking', split: 'Rent', amount: -50000 });
    const audit = run('audit_trail', { date: 'all' });
    expect(audit.rows.filter((x) => x.cells.action === 'create').length).toBeGreaterThan(25);
  });
});

describe('drill-down', () => {
  it('every drill target resolves to an existing report or transaction', () => {
    const queries: [string, Record<string, string | number>][] = [
      ['pl_standard', Y25], ['pl_by_month', Y25], ['pl_detail', Y25], ['balance_sheet', { as_of: '2026-03-31' }],
      ['trial_balance', { as_of: '2026-03-31' }], ['ar_aging_summary', { as_of: '2026-03-31' }], ['ar_aging_detail', { as_of: '2026-03-31' }],
      ['open_invoices', { as_of: '2026-03-31' }], ['customer_balance_summary', { as_of: '2026-03-31' }], ['customer_balance_detail', {}],
      ['sales_by_customer_summary', Y25], ['sales_by_customer_detail', Y25], ['sales_by_item_summary', Y25], ['sales_by_item_detail', Y25],
      ['trip_report', { date: 'all' }], ['trip_report', { date: 'all', mode: 'by_customer' }], ['trip_report', { date: 'all', mode: 'by_month' }],
      ['trip_report', { date: 'all', mode: 'grid' }], ['ap_aging_summary', { as_of: '2026-03-31' }], ['ap_aging_detail', { as_of: '2026-03-31' }],
      ['unpaid_bills', { as_of: '2026-03-31' }], ['vendor_balance_summary', { as_of: '2026-03-31' }], ['vendor_balance_detail', {}],
      ['vendor_contact_list', {}], ['purchases_by_vendor_summary', Y25], ['purchases_by_vendor_detail', Y25], ['purchases_by_item_summary', Y25],
      ['purchases_by_item_detail', Y25], ['open_purchase_orders', {}], ['deposit_detail', { date: 'all' }], ['check_detail', { date: 'all' }],
      ['missing_checks', {}], ['bank_cleared', { account_id: F.a.Checking }], ['payroll_summary', { date: 'all' }], ['payroll_detail', { date: 'all' }],
      ['customer_contact_list', {}], ['item_price_list', {}], ['account_listing', {}], ['terms_listing', {}], ['general_ledger', Y25],
      ['journal', Y25], ['txn_list_by_date', Y25], ['txn_detail_by_account', Y25], ['audit_trail', { date: 'all' }], ['quickreport', { name_id: F.n.acme }],
    ];
    // Every report is covered.
    expect(new Set(queries.map(([id]) => id)).size).toBe(REPORTS.length);
    const seen = new Set<string>();
    let txns = 0;
    let reports = 0;
    for (const [id, q] of queries) {
      for (const r of run(id, q).rows) {
        if (!r.drill) continue;
        const key = JSON.stringify(r.drill);
        if (seen.has(key)) continue;
        seen.add(key);
        if ('txn' in r.drill) {
          expect(getTxn(F.db, r.drill.txn.id).type).toBe(r.drill.txn.type);
          txns++;
        } else {
          const target = run(r.drill.report, r.drill.params);
          expect(target.id).toBe(r.drill.report);
          reports++;
        }
      }
    }
    expect(txns).toBeGreaterThan(30);
    expect(reports).toBeGreaterThan(30);
  });

  it('a summary drills to the detail with the same total', () => {
    const s = run('sales_by_customer_summary', Y25);
    const d = row(s, 'Total Acme').drill as { report: string; params: Record<string, string> };
    expect(d.report).toBe('sales_by_customer_detail');
    expect(total(run(d.report, d.params)).cells.amount).toBe(101000);
    const pl = run('pl_standard', Y25);
    const pd = row(pl, 'Total Utilities').drill as { report: string; params: Record<string, string> };
    expect(total(run(pd.report, pd.params)).cells.amount).toBe(-15000); // net income of just those expenses
  });
});

/** A small CSV parser (RFC 4180), for reading the export back. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let rowv: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      rowv.push(f);
      f = '';
    } else if (ch === '\r') continue;
    else if (ch === '\n') {
      rowv.push(f);
      out.push(rowv);
      rowv = [];
      f = '';
    } else f += ch;
  }
  return out;
}

describe('CSV and the HTTP API', () => {
  it('serves the registry and reports, and CSV parses back to the same numbers', async () => {
    const app = buildApp(F.db);
    const list = (await app.inject({ method: 'GET', url: '/api/reports' })).json();
    expect(list.length).toBe(REPORTS.length);
    const json = (await app.inject({ method: 'GET', url: '/api/reports/pl_standard?from=2025-01-01&to=2025-12-31' })).json() as Report;
    expect(json.params).toMatchObject({ date: 'custom', from: '2025-01-01', to: '2025-12-31' });
    const res = await app.inject({ method: 'GET', url: '/api/reports/pl_standard?from=2025-01-01&to=2025-12-31&format=csv' });
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(res.body.slice(1));
    expect(rows[0]).toEqual(['', 'Amount']);
    for (const r of json.rows) {
      const label = String(r.cells.label ?? '');
      const csvRow = rows.find((x) => x[0].trim() === label);
      if (typeof r.cells.amount === 'number') expect(Math.round(Number(csvRow![1]) * 100), label).toBe(r.cells.amount);
    }
    expect(rows.find((x) => x[0] === 'Net Income')![1]).toBe('-519.10');

    // Quoting: commas and quotes in text.
    const csv = toCsv({ id: 'x', title: 'x', subtitle: '', params: {}, columns: [{ key: 'a', title: 'A, "B"', kind: 'text' }, { key: 'm', title: 'M', kind: 'money' }], rows: [{ kind: 'data', depth: 0, cells: { a: 'Smith, "Jr"\nLine 2', m: -5 } }] });
    expect(parseCsv(csv.slice(1))).toEqual([['A, "B"', 'M'], ['Smith, "Jr"\nLine 2', '-0.05']]);

    const bad = await app.inject({ method: 'GET', url: '/api/reports/no_such' });
    expect(bad.statusCode).toBe(404);
    const badDate = await app.inject({ method: 'GET', url: '/api/reports/pl_standard?from=2025-13-01' });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.json().error).toMatch(/not a valid date/);
  });

  it('combined PDFs: one per document, each on its own pages', async () => {
    const app = buildApp(F.db);
    const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
    const st = await app.inject({ method: 'GET', url: `/api/statements/pdf?customer_ids=${F.n.acme},${F.n.dorn},${F.n.cole}&from=2025-01-01&to=2026-03-31` });
    expect(st.statusCode).toBe(200);
    expect(st.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages(st.rawPayload)).toBeGreaterThanOrEqual(3);
    const ids = [F.t.inv1001, F.t.cm1007, F.t.po2, F.t.chk104a, F.t.billpmt102, F.t.pay105];
    const tx = await app.inject({ method: 'GET', url: `/api/txns/pdf?ids=${ids.join(',')}` });
    expect(tx.statusCode).toBe(200);
    expect(tx.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages(tx.rawPayload)).toBeGreaterThanOrEqual(ids.length);
    // The single-document routes still work.
    const one = await app.inject({ method: 'GET', url: `/api/txns/${F.t.inv1001}/pdf` });
    expect(one.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages(one.rawPayload)).toBe(1);
    const single = await app.inject({ method: 'GET', url: `/api/statements/pdf?customer_id=${F.n.acme}&from=2025-01-01&to=2026-03-31` });
    expect(pages(single.rawPayload)).toBe(1);
    const nope = await app.inject({ method: 'GET', url: `/api/txns/pdf?ids=${F.t.je_open}` });
    expect(nope.statusCode).toBe(400);
  });
});

describe('Find', () => {
  const q = (over: Partial<Parameters<typeof find>[1]>) =>
    find(F.db, { types: [], name_id: null, from: null, to: null, num: null, amount: null, amount_min: null, amount_max: null, text: null, account_id: null, item_id: null, limit: 200, ...over });
  it('filters by number, amount, type, text, name, account and item; newest first', () => {
    expect(q({ num: '1004' }).rows.map((r) => r.id)).toEqual([F.t.inv1004]);
    expect(q({ amount: 34900 }).rows.map((r) => r.id).sort()).toEqual([F.t.inv1004, F.t.pmtDorn].sort());
    expect(q({ amount: 34900, types: ['INVOICE'] }).rows.map((r) => r.id)).toEqual([F.t.inv1004]);
    expect(q({ text: 'february rent' }).rows.map((r) => r.id)).toEqual([F.t.chk108, F.t.chk104a]);
    const acme = q({ name_id: F.n.acme });
    expect(acme.rows.length).toBe(10);
    expect(acme.rows[0].date >= acme.rows[acme.rows.length - 1].date).toBe(true);
    expect(q({ account_id: F.a.Rent }).rows.length).toBe(2);
    expect(q({ account_id: F.a.Utilities }).rows.length).toBe(3); // with the Electric sub-account
    expect(q({ item_id: F.i.disc }).rows.map((r) => r.id)).toEqual([F.t.inv1004]);
    expect(q({ from: '2026-01-01', amount_min: 10000, amount_max: 60000 }).rows.length).toBe(4); // 32,500, 13,000 twice, 50,000
    const inv = q({ num: '1004' }).rows[0];
    expect(inv).toMatchObject({ type: 'INVOICE', type_label: 'Invoice', account: 'Accounts Receivable', name: 'Dorn', amount: 34900 });
    const lim = q({ limit: 3 });
    expect(lim.rows.length).toBe(3);
    expect(lim.more).toBe(true);
    expect(q({ num: '1004' }).more).toBe(false);
  });

  it('is served at /api/find', async () => {
    const app = buildApp(F.db);
    const r = (await app.inject({ method: 'GET', url: '/api/find?types=CHECK&text=rent' })).json();
    expect(r.rows.length).toBe(2);
  });
});

describe('Graphs', () => {
  it('sales series add up to the sales reports, by customer and by item', () => {
    for (const by of ['customer', 'item'] as const) {
      const g = salesGraph(F.db, { from: Y25.from, to: Y25.to, today: TODAY, by, top: 2, name_ids: [], item_ids: [] });
      expect(g.labels.length).toBe(12);
      expect(g.series.length).toBe(3);
      expect(g.series[2].name).toBe('Other');
      const sum = g.series.reduce((t, s) => t + s.values.reduce((a, b) => a + b, 0), 0);
      expect(sum).toBe(166900);
      expect(g.total).toBe(166900);
      expect(g.breakdown.values.reduce((a, b) => a + b, 0)).toBe(166900);
    }
    const c = salesGraph(F.db, { from: Y25.from, to: Y25.to, today: TODAY, by: 'customer', top: 10, name_ids: [], item_ids: [] });
    expect(c.series.find((s) => s.name === 'Acme')!.values.reduce((a, b) => a + b, 0)).toBe(101000);
    const only = salesGraph(F.db, { from: Y25.from, to: Y25.to, today: TODAY, by: 'item', top: 10, name_ids: [F.n.dorn], item_ids: [] });
    expect(only.total).toBe(34900);
  });

  it('income vs expense by month nets to the P&L', () => {
    const g = incomeExpenseGraph(F.db, { ...Y25, today: TODAY });
    const net = g.series.find((s) => s.name === 'Net Income')!.values.reduce((a, b) => a + b, 0);
    expect(net).toBe(-51910);
    expect(g.series[0].values.reduce((a, b) => a + b, 0)).toBe(166400 + 1900);
  });

  it('is served at /api/graphs', async () => {
    const app = buildApp(F.db);
    const g = (await app.inject({ method: 'GET', url: '/api/graphs/sales?from=2025-01-01&to=2025-12-31&by=item&top=3' })).json();
    expect(g.series.length).toBe(4);
    const ie = (await app.inject({ method: 'GET', url: '/api/graphs/income-expense?date=last_fiscal_year&today=2026-11-11' })).json();
    expect(ie.keys[0]).toBe('2025-01');
  });
});
