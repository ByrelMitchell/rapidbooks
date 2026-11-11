import { ItemInput, NameInput, PayBillsInput, PayrollItemInput, TermsInput, TxnInput } from '@rapidbooks/shared';
import { openDb, seedDefaults, type DB } from '../src/db';
import { createAccount, listAccounts } from '../src/ledger/accounts';
import { payBills } from '../src/ledger/payables';
import { saveTxn, setCleared } from '../src/ledger/posting';
import { applyCredits } from '../src/ledger/receivables';
import { createItem } from '../src/lists/items';
import { createName } from '../src/lists/names';
import { createPayrollItem } from '../src/lists/payroll';
import { createTerms } from '../src/lists/terms';

/**
 * A small machine shop over two years, with totals worked out by hand (cents):
 *
 * 2025  Income: Sales:Machining 130,000; Sales:Parts 37,500; Sales (own: freight 2,500,
 *       discount -3,600) -1,100 => Total Income 166,400.  COGS: Materials 66,500.
 *       Gross Profit 99,900.  Expense: Discounts Given 1,750; Payroll Taxes 4,960;
 *       Rent 50,000; Utilities 3,000 + Utilities:Electric 12,000; Wages 80,000
 *       => 151,710.  Net Ordinary Income -51,810.  Other Income: Discounts Taken 1,400,
 *       Finance Charge Income 500 (1,900); Other Expense: Interest 2,000.
 *       Net Other Income -100.  Net Income -51,910.
 * 2026  Income: Machining 39,000; Parts 2,500 => 41,500.  COGS 7,000.  Expense: Electric
 *       9,000, Payroll Taxes 4,960, Rent 50,000, Wages 80,000 => 143,960.
 *       Net Income -109,460.
 * As of 2026-03-31: A/R 72,000 (Current -1,000; 31-60 41,500; >90 31,500);
 *       A/P 16,000 (31-60).
 * Trips: 2025-01-15 Acme (1001, 1002), 2025-02-10 Dorn, 2025-02-11 Cole,
 *        2026-01-10 Acme (1008, 1009), 2026-01-12 Dorn => 5 (7 with pick-ups: Baker
 *        2025-01-15 and Cole:Rebuild 2025-02-10).
 * Checks on Checking: 101, 102, 104, 104, 105, 106, 108 (103 and 107 missing, 104 twice).
 */
export interface Fixture {
  db: DB;
  a: Record<string, number>; // accounts by name
  n: Record<string, number>; // names
  i: Record<string, number>; // items
  t: Record<string, number>; // transactions
}

export function buildFixture(): Fixture {
  const db = openDb(':memory:');
  seedDefaults(db);
  const a: Record<string, number> = Object.fromEntries(listAccounts(db).map((x) => [x.name, x.id]));
  const acct = (name: string, type: string, parent: string | null = null) =>
    (a[name] = createAccount(db, { name, type: type as 'INC', parent_id: parent ? a[parent] : null, description: '', inactive: false }));
  acct('Savings', 'BANK');
  acct('Equipment', 'FA');
  acct('Payroll Liabilities', 'OCL');
  acct('Equipment Loan', 'LTL');
  acct('Owner Capital', 'EQUITY');
  acct('Machining', 'INC', 'Sales');
  acct('Parts', 'INC', 'Sales');
  acct('Finance Charge Income', 'OINC');
  acct('Discounts Taken', 'OINC');
  acct('Materials', 'COGS');
  acct('Rent', 'EXP');
  acct('Utilities', 'EXP');
  acct('Electric', 'EXP', 'Utilities');
  acct('Wages', 'EXP');
  acct('Payroll Taxes', 'EXP');
  acct('Discounts Given', 'EXP');
  acct('Interest Expense', 'OEXP');

  const net30 = createTerms(db, TermsInput.parse({ name: 'Net 30', net_days: 30 }));
  const twoTen = createTerms(db, TermsInput.parse({ name: '2% 10 Net 30', net_days: 30, discount_pct: 200, discount_days: 10 }));
  const n: Record<string, number> = {};
  const name = (key: string, kind: string, nm: string, extra: Record<string, unknown> = {}) =>
    (n[key] = createName(db, NameInput.parse({ kind, name: nm, ...extra })));
  name('acme', 'customer', 'Acme', { terms_id: net30, phone: '937-555-0100' });
  name('press', 'customer', 'Press Frame', { parent_id: n.acme, terms_id: net30 });
  name('gearbox', 'customer', 'Gearbox', { parent_id: n.acme, terms_id: net30 });
  name('baker', 'customer', 'Baker Tool', { terms_id: net30, picks_up: true });
  name('cole', 'customer', 'Cole Mfg', { terms_id: net30 });
  name('rebuild', 'customer', 'Rebuild', { parent_id: n.cole, terms_id: net30, picks_up: true });
  name('dorn', 'customer', 'Dorn', { terms_id: net30 });
  name('steel', 'vendor', 'Steel Supply', { terms_id: twoTen, phone: '937-555-0200' });
  name('power', 'vendor', 'Power Co');
  name('dave', 'employee', 'Dave Smith');

  const i: Record<string, number> = {};
  const item = (key: string, extra: Record<string, unknown>) => (i[key] = createItem(db, ItemInput.parse(extra)));
  item('mach', { name: 'Machining', type: 'SERVICE', rate: 6500, account_id: a.Machining });
  item('bar', { name: 'Bar Stock', type: 'PART', rate: 1250, account_id: a.Parts, cost: 700, purchase_account_id: a.Materials });
  item('freight', { name: 'Freight', type: 'OTHER_CHARGE', rate: 2500, account_id: a.Sales });
  item('sub', { name: 'Subtotal', type: 'SUBTOTAL' });
  item('disc', { name: 'Disc 10%', type: 'DISCOUNT', rate: 1000, rate_is_percent: true, account_id: a.Sales });

  const pi = (nm: string, kind: string, extra: Record<string, unknown>) => createPayrollItem(db, PayrollItemInput.parse({ name: nm, kind, ...extra }));
  const wages = pi('Hourly Wages', 'earning', { expense_account_id: a.Wages });
  const fed = pi('Federal Withholding', 'deduction', { liability_account_id: a['Payroll Liabilities'] });
  const ssEmp = pi('Social Security Employee', 'deduction', { liability_account_id: a['Payroll Liabilities'] });
  const ssCo = pi('Social Security Company', 'company', { expense_account_id: a['Payroll Taxes'], liability_account_id: a['Payroll Liabilities'] });

  const t: Record<string, number> = {};
  const save = (key: string, input: Record<string, unknown>, opts = {}) => (t[key] = saveTxn(db, TxnInput.parse(input), undefined, opts).id);
  const line = (item_id: number, qty: number | null, extra: Record<string, unknown> = {}) => ({ item_id, qty, rate: null, ...extra });
  const rated = (item_id: number, qty: number, rate: number) => ({ item_id, qty, rate });

  // ---- 2025 ----
  save('je_open', { type: 'GENJRNL', date: '2025-01-01', num: 'J1', splits: [
    { account_id: a.Checking, amount: 1000000 }, { account_id: a['Owner Capital'], amount: -1000000 },
    { account_id: a.Equipment, amount: 500000 }, { account_id: a['Equipment Loan'], amount: -500000 },
  ] });
  save('po1', { type: 'PURCHORD', date: '2025-01-05', num: 'PO1', name_id: n.steel, lines: [rated(i.bar, 100, 700)] });
  save('inv1001', { type: 'INVOICE', date: '2025-01-15', num: '1001', name_id: n.press, terms_id: net30, po_number: 'A-77', lines: [rated(i.mach, 10, 6500), rated(i.bar, 20, 1250)] });
  save('inv1002', { type: 'INVOICE', date: '2025-01-15', num: '1002', name_id: n.gearbox, terms_id: net30, lines: [rated(i.mach, 2, 6500)] });
  save('inv1003', { type: 'INVOICE', date: '2025-01-15', num: '1003', name_id: n.baker, terms_id: net30, lines: [rated(i.bar, 4, 1250)] });
  save('bill100', { type: 'BILL', date: '2025-01-20', ref_no: 'B-100', name_id: n.steel, terms_id: twoTen, po_ids: [t.po1], items: [rated(i.bar, 100, 700)] });
  save('billP1', { type: 'BILL', date: '2025-02-01', ref_no: 'P-1', name_id: n.power, expenses: [{ account_id: a.Electric, amount: 12000 }] });
  save('bc1', { type: 'BILLCREDIT', date: '2025-02-05', ref_no: 'BC-1', name_id: n.steel, items: [rated(i.bar, 5, 700)] });
  const paid = payBills(db, PayBillsInput.parse({
    date: '2025-02-08', account_id: a.Checking, first_check_num: '101',
    credits: [{ credit_id: t.bc1, bill_id: t.bill100, amount: 3500 }],
    payments: [
      { bill_id: t.billP1, amount: 12000 },
      { bill_id: t.bill100, amount: 65100, discount: 1400, discount_account_id: a['Discounts Taken'] },
    ],
  }));
  t.billpmt101 = paid.payments[0].id;
  t.billpmt102 = paid.payments[1].id;
  save('inv1004', { type: 'INVOICE', date: '2025-02-10', num: '1004', name_id: n.dorn, terms_id: net30, ship_via: 'Truck', lines: [
    rated(i.mach, 4, 6500), rated(i.bar, 8, 1250), line(i.sub, null), { item_id: i.disc, rate: 1000, rate_is_percent: true }, line(i.freight, null, { rate: 2500 }),
  ] });
  save('inv1005', { type: 'INVOICE', date: '2025-02-10', num: '1005', name_id: n.rebuild, terms_id: net30, lines: [rated(i.mach, 1, 6500)] });
  save('inv1006', { type: 'INVOICE', date: '2025-02-11', num: '1006', name_id: n.cole, terms_id: net30, lines: [rated(i.mach, 3, 6500)] });
  save('chk104a', { type: 'CHECK', date: '2025-02-15', num: '104', account_id: a.Checking, memo: 'February rent', expenses: [{ account_id: a.Rent, amount: 50000 }] });
  save('chk104b', { type: 'CHECK', date: '2025-02-20', num: '104', account_id: a.Checking, name_id: n.power, expenses: [{ account_id: a.Utilities, amount: 3000 }] });
  save('cm1007', { type: 'CREDITMEMO', date: '2025-03-01', num: '1007', name_id: n.press, lines: [rated(i.bar, 2, 1250)] });
  applyCredits(db, { applications: [{ from_txn: t.cm1007, to_txn: t.inv1001, amount: 2500 }] });
  save('pmtAcme', { type: 'PAYMENT', date: '2025-03-05', name_id: n.acme, amount: 85750, ref_no: '5521', applications: [
    { txn_id: t.inv1001, amount: 85750, discount: 1750, discount_account_id: a['Discounts Given'] },
  ] });
  save('pmtDorn', { type: 'PAYMENT', date: '2025-03-10', name_id: n.dorn, amount: 34900, ref_no: '881', applications: [{ txn_id: t.inv1004, amount: 34900 }] });
  save('dep1', { type: 'DEPOSIT', date: '2025-03-12', account_id: a.Checking, payment_ids: [t.pmtAcme, t.pmtDorn] });
  save('xfer', { type: 'TRANSFER', date: '2025-03-15', from_account_id: a.Checking, to_account_id: a.Savings, amount: 20000 });
  const payLines = [
    { payroll_item_id: wages, hours: 40, rate: 2000 },
    { payroll_item_id: fed, amount: 8000 },
    { payroll_item_id: ssEmp, amount: 4960 },
    { payroll_item_id: ssCo, amount: 4960 },
  ];
  save('pay105', { type: 'PAYCHECK', date: '2025-03-31', num: '105', account_id: a.Checking, name_id: n.dave, lines: payLines });
  save('fc1', { type: 'INVOICE', date: '2025-03-31', num: 'FC 1', name_id: n.gearbox, due_date: '2025-03-31', memo: 'Finance Charge', lines: [
    { item_id: null, description: 'Finance Charge', amount: 500, account_id: a['Finance Charge Income'] },
  ] }, { isFinanceCharge: true });
  save('po2', { type: 'PURCHORD', date: '2025-04-01', num: 'PO2', name_id: n.steel, lines: [rated(i.bar, 10, 700)] });
  save('je_int', { type: 'GENJRNL', date: '2025-12-31', num: 'J2', memo: 'Loan interest', splits: [
    { account_id: a['Interest Expense'], amount: 2000 }, { account_id: a.Checking, amount: -2000 },
  ] });

  // ---- 2026 ----
  save('bill200', { type: 'BILL', date: '2026-01-05', ref_no: 'B-200', name_id: n.steel, terms_id: twoTen, items: [rated(i.bar, 10, 700)] });
  save('inv1008', { type: 'INVOICE', date: '2026-01-10', num: '1008', name_id: n.press, terms_id: net30, lines: [rated(i.mach, 5, 6500)] });
  save('inv1009', { type: 'INVOICE', date: '2026-01-10', num: '1009', name_id: n.acme, terms_id: net30, lines: [rated(i.bar, 2, 1250)] });
  save('inv1010', { type: 'INVOICE', date: '2026-01-12', num: '1010', name_id: n.dorn, terms_id: net30, lines: [rated(i.mach, 1, 6500)] });
  save('pmtAcme2', { type: 'PAYMENT', date: '2026-01-20', name_id: n.acme, amount: 13000, ref_no: '5600', applications: [{ txn_id: t.inv1002, amount: 13000 }] });
  save('dep2', { type: 'DEPOSIT', date: '2026-01-21', account_id: a.Checking, payment_ids: [t.pmtAcme2] });
  save('pay106', { type: 'PAYCHECK', date: '2026-01-31', num: '106', account_id: a.Checking, name_id: n.dave, lines: payLines });
  save('billP2', { type: 'BILL', date: '2026-02-01', ref_no: 'P-2', name_id: n.power, expenses: [{ account_id: a.Electric, amount: 9000 }] });
  save('pmtDorn2', { type: 'PAYMENT', date: '2026-02-01', name_id: n.dorn, amount: 1000, ref_no: '902' });
  save('chk108', { type: 'CHECK', date: '2026-02-15', num: '108', account_id: a.Checking, memo: 'February rent', expenses: [{ account_id: a.Rent, amount: 50000 }] });

  // Cleared on the bank statement: the opening deposit, checks 101 and 102, the March 2025 deposit.
  const clear = (txn: number) => {
    for (const s of db.prepare('SELECT id FROM splits WHERE txn_id = ? AND account_id = ?').all(txn, a.Checking) as { id: number }[]) setCleared(db, s.id, true);
  };
  [t.je_open, t.billpmt101, t.billpmt102, t.dep1].forEach(clear);

  return { db, a, n, i, t };
}
