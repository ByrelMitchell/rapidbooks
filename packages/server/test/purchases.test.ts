import {
  amountInWords,
  ItemInput,
  NameInput,
  PayBillsInput,
  PayrollItemInput,
  TermsInput,
  TxnInput,
  type PurchTxn,
} from '@rapidbooks/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb, seedDefaults, type DB } from '../src/db';
import { importIif } from '../src/import/iif';
import { createAccount, listAccounts } from '../src/ledger/accounts';
import {
  assignCheckNumbers,
  checkNumUse,
  lastPaycheck,
  listChecksToPrint,
  listOpenPurchaseOrders,
  listUnpaidBills,
  listVendorCredits,
  payBills,
  payrollSummary,
} from '../src/ledger/payables';
import { deleteTxn, getRegister, getTxn, nextNum, removeApplication, saveTxn } from '../src/ledger/posting';
import { adjacentTxns, findTxns, listCredits, listOpenInvoices } from '../src/ledger/receivables';
import { createItem, getItem, listItems, updateItem } from '../src/lists/items';
import { createName, deleteName, listNames } from '../src/lists/names';
import { createPayrollItem, deletePayrollItem, listPayrollItems } from '../src/lists/payroll';
import { createTerms } from '../src/lists/terms';
import { renderPurchasePdf } from '../src/pdf/check';

let db: DB;
let checking: number, savings: number, card: number, ap: number, sales: number;
let materials: number, supplies: number, rent: number, discTaken: number, wagesAcct: number, taxAcct: number, liab: number;
let net30: number;
let steel: number, deburr: number, acme: number, job: number, dave: number;
let bar: number, labor: number;
let wages: number, ot: number, fed: number, ssEmp: number, medi: number, ssCo: number;

const acct = (name: string, type: string) =>
  createAccount(db, { name, type: type as 'INC', parent_id: null, description: '', inactive: false });
const name = (kind: string, n: string, extra: Partial<NameInput> = {}) => createName(db, NameInput.parse({ kind, name: n, ...extra }));
const item = (n: string, extra: Record<string, unknown>) => createItem(db, ItemInput.parse({ name: n, ...extra }));
const payItem = (n: string, kind: string, extra: Record<string, unknown> = {}) =>
  createPayrollItem(db, PayrollItemInput.parse({ name: n, kind, ...extra }));

const save = (input: Record<string, unknown>, id?: number) => saveTxn(db, TxnInput.parse(input), id);
const bill = (extra: Record<string, unknown> = {}, id?: number) => save({ type: 'BILL', date: '2026-03-02', name_id: steel, ...extra }, id);
const billCredit = (extra: Record<string, unknown> = {}, id?: number) =>
  save({ type: 'BILLCREDIT', date: '2026-03-04', name_id: steel, ...extra }, id);
const check = (extra: Record<string, unknown> = {}, id?: number) => save({ type: 'CHECK', date: '2026-03-06', account_id: checking, ...extra }, id);
const po = (extra: Record<string, unknown> = {}, id?: number) => save({ type: 'PURCHORD', date: '2026-03-01', name_id: steel, ...extra }, id);
const transfer = (extra: Record<string, unknown> = {}, id?: number) =>
  save({ type: 'TRANSFER', date: '2026-03-07', from_account_id: checking, to_account_id: savings, amount: 50000, ...extra }, id);
const paycheck = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, id?: number) =>
  save({ type: 'PAYCHECK', date: '2026-03-13', account_id: checking, name_id: dave, lines, ...extra }, id);
const pay = (input: Record<string, unknown>) => payBills(db, PayBillsInput.parse({ date: '2026-03-10', account_id: checking, ...input }));
/** A bill of one expense line. */
const simpleBill = (cents: number, extra: Record<string, unknown> = {}) => bill({ expenses: [{ account_id: supplies, amount: cents }], ...extra }).id;

const doc = (id: number) => getTxn(db, id) as PurchTxn;
const splitsOf = (id: number) => getTxn(db, id).splits.map((s) => [s.account_id, s.amount, s.name_id]);
const trialBalance = () => (db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM splits').get() as { n: number }).n;
const txnSums = () => db.prepare('SELECT txn_id, SUM(amount) AS n FROM splits GROUP BY txn_id HAVING n <> 0').all() as unknown[];
const vendorBalance = (id: number) => listNames(db, 'vendor').find((n) => n.id === id)!.balance;
const openOf = (id: number) => doc(id).open_balance;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  const byName = new Map(listAccounts(db).map((a) => [a.name, a.id]));
  checking = byName.get('Checking')!;
  ap = byName.get('Accounts Payable')!;
  sales = byName.get('Sales')!;
  savings = acct('Savings', 'BANK');
  card = acct('Visa', 'CC');
  materials = acct('Materials', 'COGS');
  supplies = acct('Shop Supplies', 'EXP');
  rent = acct('Rent', 'EXP');
  discTaken = acct('Discounts Taken', 'OINC');
  wagesAcct = acct('Wages', 'EXP');
  taxAcct = acct('Payroll Taxes', 'EXP');
  liab = acct('Payroll Liabilities', 'OCL');
  net30 = createTerms(db, TermsInput.parse({ name: '2% 10 Net 30', net_days: 30, discount_pct: 200, discount_days: 10 }));
  steel = name('vendor', 'Steel Supply', { terms_id: net30, bill_addr: 'Steel Supply Co\n9 Mill St\nDayton, OH 45402', print_as: 'Steel Supply Company' });
  deburr = name('vendor', "Joe's Deburring", { bill_addr: "Joe's Deburring\n4 Canal St\nPiqua, OH 45356" });
  acme = name('customer', 'Acme');
  job = name('customer', 'Press Frame', { parent_id: acme });
  dave = name('employee', 'Dave Smith', { bill_addr: 'Dave Smith\n18 Elm St\nDayton, OH 45402' });
  bar = item('Bar Stock', { type: 'PART', rate: 1250, account_id: sales, cost: 710, purchase_account_id: materials, purchase_description: '1/2" bar, per foot' });
  labor = item('Machining', { type: 'SERVICE', rate: 6500, account_id: sales });
  wages = payItem('Hourly Wages', 'earning', { expense_account_id: wagesAcct });
  ot = payItem('Overtime', 'earning', { expense_account_id: wagesAcct });
  fed = payItem('Federal Withholding', 'deduction', { liability_account_id: liab });
  ssEmp = payItem('Social Security Employee', 'deduction', { liability_account_id: liab });
  medi = payItem('Medicare Employee', 'deduction', { liability_account_id: liab });
  ssCo = payItem('Social Security Company', 'company', { expense_account_id: taxAcct, liability_account_id: liab });
});

// ---------------------------------------------------------------------------

describe('amount in words', () => {
  it('writes the check amount line', () => {
    expect(amountInWords(5)).toBe('Zero and 05/100');
    expect(amountInWords(100)).toBe('One and 00/100');
    expect(amountInWords(1999)).toBe('Nineteen and 99/100');
    expect(amountInWords(10000)).toBe('One hundred and 00/100');
    expect(amountInWords(123456)).toBe('One thousand two hundred thirty-four and 56/100');
    expect(amountInWords(100000000)).toBe('One million and 00/100');
    expect(amountInWords(2100)).toBe('Twenty-one and 00/100');
    expect(amountInWords(100001010)).toBe('One million ten and 10/100');
    expect(amountInWords(98765432)).toBe('Nine hundred eighty-seven thousand six hundred fifty-four and 32/100');
  });
});

describe('items: the purchase side', () => {
  it('stores cost, purchase description and account, and keeps them when an update leaves them out', () => {
    expect(getItem(db, bar)).toMatchObject({ cost: 710, purchase_account_id: materials, purchase_description: '1/2" bar, per foot' });
    expect(getItem(db, labor)).toMatchObject({ cost: 0, purchase_account_id: null, purchase_description: '' });
    // An older caller that knows nothing of the purchase side.
    updateItem(db, bar, ItemInput.parse({ name: 'Bar Stock', type: 'PART', rate: 1300, account_id: sales }));
    expect(getItem(db, bar)).toMatchObject({ rate: 1300, cost: 710, purchase_account_id: materials });
    updateItem(db, bar, ItemInput.parse({ name: 'Bar Stock', type: 'PART', rate: 1300, account_id: sales, cost: 3.75, purchase_account_id: null }));
    expect(getItem(db, bar)).toMatchObject({ cost: 3.75, purchase_account_id: null });
    const sub = item('Subtotal', { type: 'SUBTOTAL', cost: 100, purchase_account_id: materials });
    expect(getItem(db, sub)).toMatchObject({ cost: 0, purchase_account_id: null });
    expect(() => item('Bad', { type: 'PART', account_id: sales, purchase_account_id: ap })).toThrow(/Accounts Payable/);
  });

  it('imports PURCHASEDESC, COST and COGSACCNT from IIF', () => {
    const fresh = openDb(':memory:');
    const iif = [
      '!ACCNT\tNAME\tACCNTTYPE',
      'ACCNT\tSales\tINC',
      'ACCNT\tMaterials\tCOGS',
      '!INVITEM\tNAME\tINVITEMTYPE\tDESC\tPURCHASEDESC\tACCNT\tCOGSACCNT\tPRICE\tCOST',
      'INVITEM\tBar\tPART\tBar stock\t1/2 inch bar\tSales\tMaterials\t12.50\t7.10',
      'INVITEM\tPin\tPART\tPin\t\tSales\tNo Such\t0.05\t0.0375',
      'INVITEM\tSubtotal\tSUBT\tSubtotal\t\t\t\t\t',
    ].join('\r\n');
    const r = importIif(fresh, new TextEncoder().encode(iif));
    const items = listItems(fresh);
    const materialsId = listAccounts(fresh).find((a) => a.name === 'Materials')!.id;
    expect(items.find((i) => i.name === 'Bar')).toMatchObject({ purchase_description: '1/2 inch bar', cost: 710, purchase_account_id: materialsId });
    expect(items.find((i) => i.name === 'Pin')).toMatchObject({ cost: 3.75, purchase_account_id: null });
    expect(r.warnings.join('\n')).toMatch(/Item "Pin": its purchase account "No Such" was not found/);
  });
});

describe('purchase orders', () => {
  it('write no splits, stay out of registers, and keep the ledger at zero', () => {
    expect(nextNum(db, 'PURCHORD')).toBe('1');
    const id = po({
      num: '1',
      ship_addr: 'Acme Machine\n45 Foundry Rd',
      expected_date: '2026-03-10',
      message: 'Please confirm by fax.',
      lines: [{ item_id: bar, qty: 100, rate: 710, description: 'Bar stock' }, { description: 'Cut to 12" lengths' }, {}],
    }).id;
    const t = doc(id);
    expect(t).toMatchObject({ type: 'PURCHORD', num: '1', total: 71000, closed: false, expected_date: '2026-03-10', splits: [] });
    expect(t.items.map((l) => [l.item_id, l.qty, l.rate, l.amount, l.account_id])).toEqual([
      [bar, 100, 710, 71000, null],
      [null, null, null, 0, null],
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM splits WHERE txn_id = ?').get(id)).toEqual({ n: 0 });
    for (const a of listAccounts(db)) expect(getRegister(db, a.id).filter((r) => r.txn_id === id)).toEqual([]);
    expect(trialBalance()).toBe(0);
    expect(txnSums()).toEqual([]);
    expect(nextNum(db, 'PURCHORD')).toBe('2');
    expect(listOpenPurchaseOrders(db, steel).map((p) => [p.id, p.total, p.full_name])).toEqual([[id, 71000, 'Steel Supply']]);
    expect(listOpenPurchaseOrders(db, deburr)).toEqual([]);
    // Edit and delete.
    po({ num: '1', version: 1, lines: [{ item_id: bar, qty: 10, rate: 710 }] }, id);
    expect(doc(id)).toMatchObject({ total: 7100, version: 2, splits: [] });
    deleteTxn(db, id);
    expect(listOpenPurchaseOrders(db)).toEqual([]);
    expect(() => po({ name_id: acme })).toThrow(/not a vendor/);
    expect(() => po({ lines: [{ amount: 500 }] })).toThrow(/amount but no item/);
  });

  it('are closed by a bill received against them, and reopen when the bill goes', () => {
    const p1 = po({ num: '1', lines: [{ item_id: bar, qty: 100, rate: 710 }] }).id;
    const b = bill({ po_ids: [p1], items: [{ item_id: bar, qty: 100, rate: 710 }] }).id;
    expect(doc(p1)).toMatchObject({ closed: true, bill_ids: [b] });
    expect(doc(b).po_ids).toEqual([p1]);
    expect(listOpenPurchaseOrders(db, steel)).toEqual([]);
    deleteTxn(db, b);
    expect(doc(p1)).toMatchObject({ closed: false, bill_ids: [] });

    // Editing the bill to drop the P.O. reopens it too.
    const b2 = bill({ po_ids: [p1], items: [{ item_id: bar, qty: 100, rate: 710 }] }).id;
    expect(doc(p1).closed).toBe(true);
    bill({ version: doc(b2).version, items: [{ item_id: bar, qty: 100, rate: 710 }] }, b2);
    expect(doc(p1).closed).toBe(false);

    const other = po({ name_id: deburr, lines: [{ item_id: bar, qty: 1, rate: 710 }] }).id;
    expect(() => simpleBill(100, { po_ids: [other] })).toThrow(/is for Joe's Deburring/);
    po({ num: '1', closed: true, version: doc(p1).version, lines: [{ item_id: bar, qty: 100, rate: 710 }] }, p1);
    expect(() => simpleBill(100, { po_ids: [p1] })).toThrow(/Purchase order 1 is already closed/);
    expect(trialBalance()).toBe(0);
  });
});

describe('bills and bill credits', () => {
  it('post Dr each line, Cr A/P, with due dates from the terms', () => {
    const { id } = bill({
      ref_no: '4471',
      terms_id: net30,
      memo: 'March steel',
      expenses: [
        { account_id: supplies, amount: 4500, memo: 'Cutting fluid' },
        { account_id: rent, amount: 100000, name_id: job },
        {}, // a blank row
      ],
      items: [{ item_id: bar, qty: 20, rate: 710 }],
    });
    expect(splitsOf(id)).toEqual([
      [ap, -118700, steel],
      [supplies, 4500, steel],
      [rent, 100000, job],
      [materials, 14200, steel],
    ]);
    const t = doc(id);
    expect(t).toMatchObject({ type: 'BILL', num: '4471', ref_no: '4471', total: 118700, open_balance: 118700, due_date: '2026-04-01', ap_account_id: ap });
    expect(t.expenses.map((l) => [l.account_id, l.amount, l.memo, l.name_id])).toEqual([
      [supplies, 4500, 'Cutting fluid', null],
      [rent, 100000, '', job],
    ]);
    expect(t.items.map((l) => [l.item_id, l.qty, l.rate, l.amount, l.account_id])).toEqual([[bar, 20, 710, 14200, materials]]);
    expect(bill({ due_date: '2026-03-20', expenses: [{ account_id: supplies, amount: 1 }] }).id).toBeGreaterThan(id);
    expect(vendorBalance(steel)).toBe(118701);

    // Edit regenerates the splits; delete removes them.
    const r = bill({ ref_no: '4471', version: 1, expenses: [{ account_id: supplies, amount: 2500 }] }, id);
    expect(r.version).toBe(2);
    expect(splitsOf(id)).toEqual([[ap, -2500, steel], [supplies, 2500, steel]]);
    expect(trialBalance()).toBe(0);
    deleteTxn(db, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM splits WHERE txn_id = ?').get(id)).toEqual({ n: 0 });
    expect(trialBalance()).toBe(0);
  });

  it('refuses items without a purchase account, AR/AP lines, empty and negative bills, and non-vendors', () => {
    expect(() => bill({ items: [{ item_id: labor, qty: 1, rate: 100 }] })).toThrow(/Machining has no purchase account/);
    expect(() => bill({ expenses: [{ account_id: ap, amount: 100 }] })).toThrow(/Accounts Payable/);
    expect(() => bill({})).toThrow(/at least one expense or item line/);
    expect(() => bill({ expenses: [{ account_id: supplies, amount: -100 }] })).toThrow(/use a bill credit/);
    expect(() => bill({ name_id: acme, expenses: [{ account_id: supplies, amount: 100 }] })).toThrow(/Acme is not a vendor/);
    expect(() => bill({ expenses: [{ account_id: supplies, amount: 100, name_id: steel }] })).toThrow(/not a customer or job/);
    expect(() => bill({ ap_account_id: checking, expenses: [{ account_id: supplies, amount: 100 }] })).toThrow(/not an Accounts Payable account/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM txns').get()).toEqual({ n: 0 });
  });

  it('posts a bill credit as the mirror image', () => {
    const { id } = billCredit({ ref_no: 'CR-9', expenses: [{ account_id: supplies, amount: 2500 }], items: [{ item_id: bar, qty: 1, rate: 710 }] });
    expect(splitsOf(id)).toEqual([[ap, 3210, steel], [supplies, -2500, steel], [materials, -710, steel]]);
    expect(doc(id)).toMatchObject({ type: 'BILLCREDIT', total: 3210, unapplied: 3210, due_date: '', open_balance: null });
    expect(vendorBalance(steel)).toBe(-3210);
    expect(listVendorCredits(db, steel).map((c) => [c.type, c.unapplied])).toEqual([['BILLCREDIT', 3210]]);
  });
});

describe('pay bills', () => {
  let b1: number, b2: number, b3: number, c1: number;
  beforeEach(() => {
    b1 = simpleBill(100000, { ref_no: 'A1', terms_id: net30 }); // due 04/01, 2% until 03/12
    b2 = simpleBill(50000, { ref_no: 'A2', date: '2026-03-05', due_date: '2026-04-15' });
    b3 = bill({ name_id: deburr, ref_no: 'D1', date: '2026-03-03', due_date: '2026-05-01', expenses: [{ account_id: supplies, amount: 30000 }] }).id;
    c1 = billCredit({ ref_no: 'CR1', expenses: [{ account_id: supplies, amount: 5000 }] }).id;
  });

  it('lists unpaid bills by due date or vendor, with the suggested discount', () => {
    const byDue = listUnpaidBills(db, { pay_date: '2026-03-10' });
    expect(byDue.map((b) => [b.ref_no, b.due_date, b.open_balance, b.suggested_discount, b.credits_available])).toEqual([
      ['A1', '2026-04-01', 100000, 2000, 5000],
      ['A2', '2026-04-15', 50000, 0, 5000],
      ['D1', '2026-05-01', 30000, 0, 0],
    ]);
    expect(byDue[0]).toMatchObject({ discount_pct: 200, discount_date: '2026-03-12', full_name: 'Steel Supply' });
    expect(listUnpaidBills(db, { sort: 'vendor' }).map((b) => b.ref_no)).toEqual(['D1', 'A1', 'A2']);
    expect(listUnpaidBills(db, { due_on_or_before: '2026-04-01' }).map((b) => b.ref_no)).toEqual(['A1']);
    expect(listUnpaidBills(db, { vendor_id: deburr }).map((b) => b.ref_no)).toEqual(['D1']);
    expect(listUnpaidBills(db, { pay_date: '2026-03-13' })[0].suggested_discount).toBe(0); // past the discount date
  });

  it('writes one payment per vendor with discounts and credits, numbered in vendor order', () => {
    const r = pay({
      first_check_num: '1001',
      memo: 'March bills',
      payments: [
        { bill_id: b1, amount: 98000, discount: 2000, discount_account_id: discTaken },
        { bill_id: b2, amount: 20000 },
        { bill_id: b3, amount: 30000 },
      ],
      credits: [{ credit_id: c1, bill_id: b2, amount: 5000 }],
    });
    expect(r.payments.map((p) => [p.name_id, p.num, p.amount])).toEqual([
      [deburr, '1001', 30000],
      [steel, '1002', 118000],
    ]);
    const [pj, ps] = r.payments.map((p) => p.id);
    expect(splitsOf(pj)).toEqual([[checking, -30000, deburr], [ap, 30000, deburr]]);
    expect(splitsOf(ps)).toEqual([
      [checking, -118000, steel],
      [ap, 118000, steel],
      [ap, 2000, steel],
      [discTaken, -2000, steel],
    ]);
    expect(doc(ps)).toMatchObject({ type: 'BILLPMT', num: '1002', pay_method: 'check', total: 118000, unapplied: 0, account_id: checking, ap_account_id: ap, memo: 'March bills' });
    expect(doc(ps).address).toMatch(/^Steel Supply Co\n/);
    expect(doc(ps).links_out.map((l) => [l.kind, l.txn_id, l.amount, l.discount])).toEqual([
      ['apply', b1, 98000, 2000],
      ['apply', b2, 20000, 0],
    ]);
    expect([openOf(b1), openOf(b2), openOf(b3)]).toEqual([0, 25000, 0]);
    expect(doc(c1).unapplied).toBe(0);
    expect(doc(b2).links_in.map((l) => [l.type, l.amount])).toEqual([['BILLCREDIT', 5000], ['BILLPMT', 20000]]);
    expect(listUnpaidBills(db).map((b) => [b.ref_no, b.open_balance])).toEqual([['A2', 25000]]);
    expect(vendorBalance(steel)).toBe(25000);
    expect(vendorBalance(deburr)).toBe(0);
    expect(trialBalance()).toBe(0);

    // The bank register shows each payment as one row; A/P shows payment + discount as one.
    expect(getRegister(db, checking).map((x) => [x.type, x.num, x.amount])).toEqual([
      ['BILLPMT', '1001', -30000],
      ['BILLPMT', '1002', -118000],
    ]);
    expect(getRegister(db, ap).find((x) => x.txn_id === ps)!.amount).toBe(120000);

    // Deleting a payment reopens its bills; the credit stays applied.
    deleteTxn(db, ps);
    expect([openOf(b1), openOf(b2)]).toEqual([100000, 45000]);
    expect(vendorBalance(steel)).toBe(145000);
    expect(trialBalance()).toBe(0);
  });

  it('marks checks to be printed, or pays by other means without a number', () => {
    const r = pay({ to_print: true, payments: [{ bill_id: b1, amount: 1000 }, { bill_id: b3, amount: 1000 }] });
    expect(r.payments.map((p) => p.num)).toEqual(['', '']);
    expect(listChecksToPrint(db).map((c) => c.id)).toEqual(r.payments.map((p) => p.id));
    const o = pay({ method: 'other', account_id: card, payments: [{ bill_id: b2, amount: 1000 }] });
    expect(doc(o.payments[0].id)).toMatchObject({ num: '', pay_method: 'other', to_print: false, account_id: card });
    expect(splitsOf(o.payments[0].id)).toEqual([[card, -1000, steel], [ap, 1000, steel]]);
    expect(() => pay({ account_id: card, payments: [{ bill_id: b2, amount: 1000 }] })).toThrow(/not a bank account/);
  });

  it('refuses over-payment, cross-vendor credits and payments, and leaves nothing behind', () => {
    const links = () => (db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number }).n;
    expect(() => pay({ payments: [{ bill_id: b2, amount: 50001 }] })).toThrow(/more than its open balance of \$500.00/);
    expect(() => pay({ payments: [{ bill_id: b2, amount: 46000 }], credits: [{ credit_id: c1, bill_id: b2, amount: 5000 }] })).toThrow(
      /more than its open balance of \$450.00/,
    );
    expect(links()).toBe(0); // the credit applied first was rolled back too
    const c2 = billCredit({ name_id: deburr, expenses: [{ account_id: supplies, amount: 100 }] }).id;
    expect(() => pay({ credits: [{ credit_id: c2, bill_id: b2, amount: 100 }] })).toThrow(/not from the same vendor/);
    expect(() => pay({ credits: [{ credit_id: c1, bill_id: b2, amount: 5001 }] })).toThrow(/Only \$50.00 of credit CR1/);
    expect(() => pay({ payments: [{ bill_id: b1, amount: 100, discount: 100 }] })).toThrow(/Choose the account for the discount/);
    expect(() => pay({ payments: [] })).toThrow(/at least one bill/);
    expect(() =>
      save({ type: 'BILLPMT', date: '2026-03-10', name_id: deburr, account_id: checking, amount: 100, applications: [{ txn_id: b1, amount: 100 }] }),
    ).toThrow(/Bill A1 from Steel Supply is not from Joe's Deburring/);
    expect(() =>
      save({ type: 'BILLPMT', date: '2026-03-10', name_id: steel, account_id: checking, amount: 100, applications: [{ txn_id: b1, amount: 200 }] }),
    ).toThrow(/applied \$2.00 to bills, but the payment is only \$1.00/);
    expect(links()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM txns WHERE type = 'BILLPMT'").get()).toEqual({ n: 0 });
  });

  it('deleting a bill leaves its payment unapplied, drops the discount, and the payment can be applied later', () => {
    const r = pay({ first_check_num: '7', payments: [{ bill_id: b1, amount: 98000, discount: 2000, discount_account_id: discTaken }] });
    const p = r.payments[0].id;
    deleteTxn(db, b1);
    expect(splitsOf(p)).toEqual([[checking, -98000, steel], [ap, 98000, steel]]);
    expect(doc(p)).toMatchObject({ unapplied: 98000, num: '7' });
    expect(listVendorCredits(db, steel).map((c) => [c.type, c.unapplied])).toEqual([
      ['BILLCREDIT', 5000],
      ['BILLPMT', 98000],
    ]);
    expect(vendorBalance(steel)).toBe(50000 - 5000 - 98000);
    pay({ credits: [{ credit_id: p, bill_id: b2, amount: 50000 }] });
    expect(openOf(b2)).toBe(0);
    expect(doc(p).unapplied).toBe(48000);
    expect(vendorBalance(steel)).toBe(-5000 - 48000);
    expect(trialBalance()).toBe(0);
  });

  it('edits a bill payment, lists bills for editing, and removes one application', () => {
    const p = pay({ payments: [{ bill_id: b1, amount: 30000 }, { bill_id: b2, amount: 10000, discount: 500, discount_account_id: discTaken }] }).payments[0].id;
    const forEdit = listUnpaidBills(db, { payment_id: p, vendor_id: steel });
    expect(forEdit.map((b) => [b.ref_no, b.open_balance, b.applied_by_payment, b.discount_by_payment])).toEqual([
      ['A1', 100000, 30000, 0],
      ['A2', 50000, 10000, 500],
    ]);
    const t = doc(p);
    save(
      { type: 'BILLPMT', date: t.date, num: t.num, name_id: steel, account_id: checking, amount: 40000, version: t.version, applications: [{ txn_id: b1, amount: 40000 }] },
      p,
    );
    expect(splitsOf(p)).toEqual([[checking, -40000, steel], [ap, 40000, steel]]);
    expect([openOf(b1), openOf(b2)]).toEqual([60000, 50000]);
    // A discount application removed on its own reposts the payment.
    save(
      {
        type: 'BILLPMT', date: t.date, num: t.num, name_id: steel, account_id: checking, amount: 40000, version: t.version + 1,
        applications: [{ txn_id: b1, amount: 30000 }, { txn_id: b2, amount: 10000, discount: 500, discount_account_id: discTaken }],
      },
      p,
    );
    removeApplication(db, doc(p).links_out.find((l) => l.txn_id === b2)!.id);
    expect(splitsOf(p)).toEqual([[checking, -40000, steel], [ap, 40000, steel]]);
    expect(doc(p).unapplied).toBe(10000);
    expect(trialBalance()).toBe(0);
  });
});

describe('checks', () => {
  it('post Dr each line, Cr the bank', () => {
    const { id } = check({
      num: nextNum(db, 'CHECK', checking),
      name_id: deburr,
      memo: 'Abrasives',
      expenses: [{ account_id: supplies, amount: 12345, memo: 'Belts' }],
      items: [{ item_id: bar, qty: 2, rate: 710, name_id: job }],
    });
    expect(splitsOf(id)).toEqual([[checking, -13765, deburr], [supplies, 12345, deburr], [materials, 1420, job]]);
    expect(doc(id)).toMatchObject({ type: 'CHECK', num: '1', total: 13765, account_id: checking, to_print: false });
    // A check to a customer or with no payee at all.
    expect(splitsOf(check({ name_id: acme, expenses: [{ account_id: sales, amount: 500 }] }).id)).toEqual([[checking, -500, acme], [sales, 500, acme]]);
    expect(splitsOf(check({ expenses: [{ account_id: rent, amount: 700 }] }).id)).toEqual([[checking, -700, null], [rent, 700, null]]);
    check({ num: '1', version: 1, name_id: deburr, expenses: [{ account_id: supplies, amount: 100 }] }, id);
    expect(splitsOf(id)).toEqual([[checking, -100, deburr], [supplies, 100, deburr]]);
    deleteTxn(db, id);
    expect(trialBalance()).toBe(0);
    expect(() => check({ account_id: sales, expenses: [{ account_id: rent, amount: 1 }] })).toThrow(/Sales is not a bank account/);
    expect(() => check({ expenses: [{ account_id: ap, amount: 1 }] })).toThrow(/Pay Bills/);
    expect(() => check({ expenses: [] })).toThrow(/at least one/);
    expect(() => check({ expenses: [{ account_id: rent, amount: -1 }] })).toThrow(/cannot be negative/);
  });

  it('numbers checks, bill payments and paychecks from one sequence per bank account', () => {
    expect(nextNum(db, 'CHECK', checking)).toBe('1');
    const c = check({ num: '101', expenses: [{ account_id: rent, amount: 100 }] }).id;
    expect(nextNum(db, 'CHECK', checking)).toBe('102');
    expect(nextNum(db, 'BILLPMT', checking)).toBe('102');
    expect(nextNum(db, 'CHECK', savings)).toBe('1');
    const b = simpleBill(5000);
    const r = pay({ payments: [{ bill_id: b, amount: 5000 }] }); // no first number: the next one
    expect(r.payments[0].num).toBe('102');
    expect(nextNum(db, 'PAYCHECK', checking)).toBe('103');
    paycheck([{ payroll_item_id: wages, amount: 10000 }], { num: '103' });
    expect(nextNum(db, 'CHECK', checking)).toBe('104');
    check({ account_id: savings, num: '5000', expenses: [{ account_id: rent, amount: 100 }] });
    expect(nextNum(db, 'CHECK', checking)).toBe('104');
    expect(nextNum(db, 'CHECK', savings)).toBe('5001');
    expect(nextNum(db, 'CHECK')).toBe('5001'); // no account: across all

    // Duplicate numbers are reported, not refused.
    expect(checkNumUse(db, checking, '101')).toMatchObject({ used: true, txns: [{ id: c, type: 'CHECK' }] });
    expect(checkNumUse(db, checking, '102').txns.map((x) => x.type)).toEqual(['BILLPMT']);
    expect(checkNumUse(db, checking, '101', c)).toEqual({ used: false, txns: [] });
    expect(checkNumUse(db, savings, '101').used).toBe(false);
    const dup = check({ num: '101', expenses: [{ account_id: rent, amount: 100 }] }).id;
    expect(checkNumUse(db, checking, '101').txns.map((x) => x.id).sort()).toEqual([c, dup].sort());
    expect(findTxns(db, 'CHECK', '101')).toHaveLength(2);
  });

  it('queues checks to be printed and assigns numbers from N', () => {
    const a = check({ to_print: true, num: '55', name_id: deburr, expenses: [{ account_id: rent, amount: 100 }] }).id;
    const b = paycheck([{ payroll_item_id: wages, amount: 10000 }], { to_print: true }).id;
    check({ num: '9', expenses: [{ account_id: rent, amount: 100 }] });
    expect(doc(a)).toMatchObject({ num: '', to_print: true });
    expect(listChecksToPrint(db).map((c) => [c.id, c.type, c.full_name, c.amount])).toEqual([
      [a, 'CHECK', "Joe's Deburring", 100],
      [b, 'PAYCHECK', 'Dave Smith', 10000],
    ]);
    expect(listChecksToPrint(db, savings)).toEqual([]);
    const v = doc(a).version;
    expect(assignCheckNumbers(db, { txn_ids: [b, a], first_num: '500' })).toEqual([
      { id: b, num: '500' },
      { id: a, num: '501' },
    ]);
    expect(doc(a)).toMatchObject({ num: '501', to_print: false, version: v + 1 });
    expect(listChecksToPrint(db)).toEqual([]);
    const bl = simpleBill(100);
    expect(() => assignCheckNumbers(db, { txn_ids: [bl], first_num: '1' })).toThrow(/Only checks/);
  });

  it('keeps leading zeros and every digit of check numbers', () => {
    const a = check({ to_print: true, expenses: [{ account_id: rent, amount: 100 }] }).id;
    const b = check({ to_print: true, expenses: [{ account_id: rent, amount: 100 }] }).id;
    expect(assignCheckNumbers(db, { txn_ids: [a, b], first_num: '000099' }).map((x) => x.num)).toEqual(['000099', '000100']);
    const b1 = simpleBill(100);
    const b2 = simpleBill(100, { name_id: deburr });
    const r = pay({ first_check_num: '90071992547409919', payments: [{ bill_id: b1, amount: 100 }, { bill_id: b2, amount: 100 }] });
    expect(r.payments.map((p) => p.num).sort()).toEqual(['90071992547409919', '90071992547409920']);
  });

  it('a customer on a purchase order line cannot be deleted, with the usual message', () => {
    const lonely = name('customer', 'Only On A PO');
    po({ lines: [{ item_id: bar, qty: 1, rate: 710, name_id: lonely }] });
    expect(() => deleteName(db, lonely)).toThrow(/Only On A PO has transactions and cannot be deleted/);
  });
});

describe('transfers', () => {
  it('post Dr to, Cr from, and refuse the same account or no amount', () => {
    const { id } = transfer({ memo: 'To savings' });
    expect(splitsOf(id)).toEqual([[checking, -50000, null], [savings, 50000, null]]);
    expect(doc(id)).toMatchObject({ type: 'TRANSFER', account_id: checking, to_account_id: savings, total: 50000, memo: 'To savings' });
    transfer({ amount: 60000, from_account_id: savings, to_account_id: checking, version: 1 }, id);
    expect(splitsOf(id)).toEqual([[savings, -60000, null], [checking, 60000, null]]);
    expect(getRegister(db, savings).map((r) => [r.type, r.amount, r.other_account_id])).toEqual([['TRANSFER', -60000, checking]]);
    expect(() => transfer({ to_account_id: checking })).toThrow(/two different accounts/);
    expect(() => transfer({ amount: 0 })).toThrow(/amount to transfer/);
    expect(() => transfer({ to_account_id: rent })).toThrow(/income or expense account/);
    expect(() => transfer({ to_account_id: ap })).toThrow(/Accounts Payable/);
    deleteTxn(db, id);
    expect(trialBalance()).toBe(0);
  });
});

describe('paychecks', () => {
  /*
   * Worked example: Dave's paycheck for the two weeks ending 03/13/2026.
   *   Hourly Wages     80 h  x $25.00  = $2,000.00   earning   Dr Wages
   *   Overtime          4 h  x $37.50  =   $150.00   earning   Dr Wages
   *   Gross pay                          $2,150.00
   *   Federal Withholding                 $210.00   deduction Cr Payroll Liabilities
   *   Social Security Employee 6.2%       $133.30   deduction Cr Payroll Liabilities
   *   Medicare Employee 1.45% (31.175)     $31.18   deduction Cr Payroll Liabilities (she types it)
   *   Net pay = 2,150.00 - 210.00 - 133.30 - 31.18 = $1,775.52     Cr Checking
   *   Social Security Company             $133.30   company   Dr Payroll Taxes, Cr Payroll Liabilities
   * Debits 2,000.00 + 150.00 + 133.30 = 2,283.30
   * Credits 1,775.52 + 210.00 + 133.30 + 31.18 + 133.30 = 2,283.30
   */
  const example = [
    { payroll_item_id: 0, hours: 80, rate: 2500 },
    { payroll_item_id: 0, hours: 4, rate: 3750 },
    { payroll_item_id: 0, amount: 21000 },
    { payroll_item_id: 0, amount: 13330 },
    { payroll_item_id: 0, amount: 3118 },
    { payroll_item_id: 0, amount: 13330 },
  ];
  const lines = () => [wages, ot, fed, ssEmp, medi, ssCo].map((id, i) => ({ ...example[i], payroll_item_id: id }));

  it('posts the worked example exactly', () => {
    const { id } = paycheck(lines(), { num: '1', period_from: '2026-02-28', period_to: '2026-03-13', memo: 'Pay period ending 03/13' });
    expect(splitsOf(id)).toEqual([
      [checking, -177552, dave],
      [wagesAcct, 200000, dave],
      [wagesAcct, 15000, dave],
      [liab, -21000, dave],
      [liab, -13330, dave],
      [liab, -3118, dave],
      [taxAcct, 13330, dave],
      [liab, -13330, dave],
    ]);
    const t = doc(id);
    expect(t).toMatchObject({ type: 'PAYCHECK', total: 177552, period_from: '2026-02-28', period_to: '2026-03-13' });
    expect(t.paycheck).toEqual({ earnings: 215000, deductions: 37448, company: 13330, net: 177552 });
    expect(t.pay_lines.map((l) => [l.name, l.kind, l.hours, l.rate, l.amount])).toEqual([
      ['Hourly Wages', 'earning', 80, 2500, 200000],
      ['Overtime', 'earning', 4, 3750, 15000],
      ['Federal Withholding', 'deduction', null, null, 21000],
      ['Social Security Employee', 'deduction', null, null, 13330],
      ['Medicare Employee', 'deduction', null, null, 3118],
      ['Social Security Company', 'company', null, null, 13330],
    ]);
    expect(getRegister(db, checking).map((r) => [r.type, r.amount])).toEqual([['PAYCHECK', -177552]]);
    // Paying the liabilities is just a check to the liability account.
    check({ name_id: acme, expenses: [{ account_id: liab, amount: 21000 + 13330 * 2 + 3118 }] });
    expect(listAccounts(db).find((a) => a.id === liab)!.balance).toBe(0);
    // Edit and delete.
    paycheck([{ payroll_item_id: wages, hours: 10, rate: 2500 }], { version: 1 }, id);
    expect(splitsOf(id)).toEqual([[checking, -25000, dave], [wagesAcct, 25000, dave]]);
    deleteTxn(db, id);
    expect(trialBalance()).toBe(0);
  });

  it('refuses negative net pay and non-employees', () => {
    expect(() => paycheck([{ payroll_item_id: wages, amount: 10000 }, { payroll_item_id: fed, amount: 10001 }])).toThrow(
      /Net pay cannot be negative: deductions of \$100.01 are more than earnings of \$100.00/,
    );
    expect(() => paycheck([{ payroll_item_id: wages, amount: 100 }], { name_id: steel })).toThrow(/not an employee/);
    expect(() => paycheck([])).toThrow(/at least one/);
    expect(() => paycheck([{ payroll_item_id: 9999, amount: 100 }])).toThrow(/no longer exists/);
    // Net pay of exactly zero is allowed.
    expect(splitsOf(paycheck([{ payroll_item_id: wages, amount: 100 }, { payroll_item_id: fed, amount: 100 }]).id)).toEqual([
      [checking, 0, dave],
      [wagesAcct, 100, dave],
      [liab, -100, dave],
    ]);
  });

  it('summarizes year to date and finds the last paycheck', () => {
    const ann = name('employee', 'Ann Lee');
    const p1 = paycheck(lines(), { date: '2026-03-13' }).id;
    const p2 = paycheck(lines(), { date: '2026-03-27' }).id;
    paycheck([{ payroll_item_id: wages, hours: 10, rate: 2000 }], { name_id: ann, date: '2026-03-27' });
    paycheck(lines(), { date: '2025-12-31' }); // last year
    expect(lastPaycheck(db, dave)!.id).toBe(p2);
    expect(lastPaycheck(db, ann)!.total).toBe(20000);
    expect(lastPaycheck(db, name('employee', 'New Hire'))).toBeNull();

    const ytd = payrollSummary(db, '2026-01-01', '2026-12-31');
    expect(ytd.map((r) => [r.employee, r.payroll_item, r.kind, r.hours, r.amount])).toEqual([
      ['Ann Lee', 'Hourly Wages', 'earning', 10, 20000],
      ['Dave Smith', 'Hourly Wages', 'earning', 160, 400000],
      ['Dave Smith', 'Overtime', 'earning', 8, 30000],
      ['Dave Smith', 'Federal Withholding', 'deduction', 0, 42000],
      ['Dave Smith', 'Medicare Employee', 'deduction', 0, 6236],
      ['Dave Smith', 'Social Security Employee', 'deduction', 0, 26660],
      ['Dave Smith', 'Social Security Company', 'company', 0, 26660],
    ]);
    expect(payrollSummary(db, '2026-01-01', '2026-03-13', dave).find((r) => r.payroll_item_id === wages)!.amount).toBe(200000);
    expect(payrollSummary(db, '2026-01-01', '2026-03-13', dave, p1).find((r) => r.payroll_item_id === wages)!.amount).toBe(200000);
  });

  it('keeps a payroll item list with accounts and refuses deleting used items', () => {
    expect(listPayrollItems(db).map((p) => [p.name, p.kind_label])).toEqual([
      ['Hourly Wages', 'Earning'],
      ['Overtime', 'Earning'],
      ['Federal Withholding', 'Deduction'],
      ['Medicare Employee', 'Deduction'],
      ['Social Security Employee', 'Deduction'],
      ['Social Security Company', 'Company Contribution'],
    ]);
    expect(() => payItem('Bonus', 'earning')).toThrow(/Choose the expense account/);
    expect(() => payItem('X', 'company', { expense_account_id: taxAcct })).toThrow(/Choose the liability account/);
    expect(() => payItem('hourly wages', 'earning', { expense_account_id: wagesAcct })).toThrow(/already a payroll item/);
    const ded = payItem('Garnishment', 'deduction', { liability_account_id: liab, expense_account_id: wagesAcct });
    expect(listPayrollItems(db).find((p) => p.id === ded)!.expense_account_id).toBeNull();
    paycheck([{ payroll_item_id: wages, amount: 100 }]);
    expect(() => deletePayrollItem(db, wages)).toThrow(/used on paychecks/);
    deletePayrollItem(db, ded);
  });
});

describe('lookups', () => {
  it('reads back, steps through and finds the new types like the sales forms', () => {
    const b1 = simpleBill(100, { ref_no: '20', date: '2026-03-02' });
    const b2 = simpleBill(100, { ref_no: '10', date: '2026-03-02' });
    const b3 = simpleBill(100, { ref_no: '5', date: '2026-03-01' });
    expect(adjacentTxns(db, 'BILL', b2)).toEqual({ prev: b3, next: b1 });
    expect(adjacentTxns(db, 'BILL', null)).toEqual({ prev: b1, next: null });
    expect(findTxns(db, 'BILL', '10').map((t) => t.id)).toEqual([b2]);
    const keys = Object.keys(doc(b1)).sort();
    for (const k of ['address', 'expenses', 'items', 'pay_lines', 'links_in', 'links_out', 'open_balance', 'unapplied', 'paycheck', 'po_ids']) {
      expect(keys).toContain(k);
    }
  });
});

describe('PDFs', () => {
  beforeEach(() => {
    const up = db.prepare('INSERT INTO company (key, value) VALUES (?, ?)');
    up.run('name', 'Acme Machine Works');
    up.run('address', '45 Foundry Rd\nDayton, OH 45402');
  });

  it('renders a purchase order and check records for checks, bill payments and paychecks', async () => {
    const p = po({ num: '1', lines: [{ item_id: bar, qty: 100, rate: 710, description: 'Bar stock' }], message: 'Thanks' }).id;
    const c = check({ num: '1001', name_id: deburr, expenses: [{ account_id: supplies, amount: 123456 }], items: [{ item_id: bar, qty: 2, rate: 710 }] }).id;
    const b = simpleBill(50000, { ref_no: 'A1' });
    const bp = pay({ first_check_num: '1002', payments: [{ bill_id: b, amount: 49000, discount: 1000, discount_account_id: discTaken }] }).payments[0].id;
    const pc = paycheck([{ payroll_item_id: wages, hours: 80, rate: 2500 }, { payroll_item_id: fed, amount: 21000 }, { payroll_item_id: ssCo, amount: 12400 }], { num: '1003' }).id;
    for (const id of [p, c, bp, pc]) {
      const pdf = await renderPurchasePdf(db, id);
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
    await expect(renderPurchasePdf(db, b)).rejects.toThrow(/can be printed/);
  });
});

// ---------------------------------------------------------------------------

describe('a long mixed sequence of sales and purchases', () => {
  it('stays in balance; vendor and customer balances equal open documents less unapplied credits', () => {
    let seed = 4242;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n;
    };
    const lee = name('vendor', 'Lee Tool');
    const vendors = [steel, deburr, lee];
    const customers = [acme, job, name('customer', 'Zeta')];
    const mach = createItem(db, ItemInput.parse({ name: 'Mach', type: 'SERVICE', rate: 6500, account_id: sales }));
    const day = () => `2026-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const ofType = (type: string) => (db.prepare('SELECT id FROM txns WHERE type = ?').all(type) as { id: number }[]).map((r) => r.id);
    const tryIt = (f: () => void) => {
      try {
        f();
      } catch (e) {
        if (!(e instanceof Error) || (e as { status?: number }).status !== 400) throw e;
      }
    };
    const purchaseLines = () => ({
      expenses: rnd(2) ? [{ account_id: [supplies, rent][rnd(2)], amount: 100 + rnd(50000), name_id: rnd(4) ? null : job }] : [],
      items: [{ item_id: bar, qty: 1 + rnd(40), rate: 700 + rnd(100) + rnd(1000) / 1000 }],
    });

    for (let step = 0; step < 400; step++) {
      const v = vendors[rnd(vendors.length)];
      const c = customers[rnd(customers.length)];
      const op = rnd(16);
      tryIt(() => {
        if (op <= 2) bill({ name_id: v, date: day(), terms_id: rnd(2) ? net30 : null, ...purchaseLines() });
        else if (op === 3) billCredit({ name_id: v, date: day(), expenses: [{ account_id: supplies, amount: 100 + rnd(20000) }] });
        else if (op <= 5) {
          const open = listUnpaidBills(db, { vendor_id: rnd(3) ? v : null });
          const chosen = open.slice(0, 1 + rnd(4));
          const credits = listVendorCredits(db, v);
          const target = chosen.find((b) => b.name_id === v);
          pay({
            date: day(),
            method: rnd(4) ? 'check' : 'other',
            to_print: rnd(3) === 0,
            payments: chosen.map((b) => {
              const discount = rnd(3) === 0 ? Math.min(100, b.open_balance) : 0;
              return { bill_id: b.id, amount: Math.max(0, b.open_balance - discount - rnd(2) * 100), discount, discount_account_id: discTaken };
            }),
            credits: credits.length && target && rnd(2) ? [{ credit_id: credits[0].id, bill_id: target.id, amount: Math.min(credits[0].unapplied, 1 + rnd(target.open_balance)) }] : [],
          });
        } else if (op === 6) {
          const bills = ofType('BILL');
          if (bills.length) {
            const id = bills[rnd(bills.length)];
            const t = doc(id);
            bill({ name_id: t.name_id, date: t.date, version: t.version, ...purchaseLines() }, id);
          }
        } else if (op === 7) {
          const all = [...ofType('BILL'), ...ofType('BILLPMT'), ...ofType('BILLCREDIT'), ...ofType('CHECK'), ...ofType('PURCHORD'), ...ofType('INVOICE'), ...ofType('PAYMENT')];
          if (all.length) deleteTxn(db, all[rnd(all.length)]);
        } else if (op === 8) check({ date: day(), name_id: rnd(2) ? v : null, num: nextNum(db, 'CHECK', checking), ...purchaseLines() });
        else if (op === 9) transfer({ date: day(), amount: 1 + rnd(100000), from_account_id: rnd(2) ? checking : savings, to_account_id: rnd(2) ? savings : checking });
        else if (op === 10) paycheck(lines2(), { date: day() });
        else if (op === 11) {
          const p = po({ name_id: v, date: day(), lines: [{ item_id: bar, qty: 1 + rnd(9), rate: 710 }] }).id;
          if (rnd(2)) bill({ name_id: v, date: day(), po_ids: [p], items: [{ item_id: bar, qty: 1, rate: 710 }] });
        } else if (op === 12) {
          save({ type: 'INVOICE', date: day(), name_id: c, lines: [{ item_id: mach, qty: 1 + rnd(5), rate: 1000 + rnd(9000) }] });
        } else if (op === 13) {
          const open = listOpenInvoices(db, c);
          const apps = open.slice(0, 2).map((i) => ({ txn_id: i.id, amount: i.open_balance }));
          save({ type: 'PAYMENT', date: day(), name_id: c, amount: apps.reduce((s, a) => s + a.amount, 0) + rnd(2) * 500 || 500, applications: apps });
        } else if (op === 14) {
          const pays = ofType('BILLPMT');
          if (pays.length) {
            const id = pays[rnd(pays.length)];
            const t = doc(id);
            const apps = t.links_out.filter((l) => l.kind === 'apply').map((l) => ({ txn_id: l.txn_id, amount: Math.max(0, l.amount - rnd(2) * 50), discount: l.discount, discount_account_id: l.discount_account_id }));
            save({ type: 'BILLPMT', date: t.date, num: t.num, name_id: t.name_id, account_id: t.account_id, pay_method: t.pay_method || 'check', amount: t.total, version: t.version, applications: apps }, id);
          }
        } else {
          const links = db.prepare("SELECT id FROM links WHERE kind = 'apply'").all() as { id: number }[];
          if (links.length) removeApplication(db, links[rnd(links.length)].id);
        }
      });
      expect(txnSums()).toEqual([]);
    }

    expect(trialBalance()).toBe(0);
    for (const t of ['BILL', 'BILLPMT', 'BILLCREDIT', 'CHECK', 'PURCHORD', 'PAYCHECK', 'TRANSFER', 'INVOICE']) {
      expect(ofType(t).length, t).toBeGreaterThan(0);
    }
    for (const n of listNames(db, 'vendor')) {
      const open = listUnpaidBills(db, { vendor_id: n.id }).reduce((s, b) => s + b.open_balance, 0);
      const credits = listVendorCredits(db, n.id).reduce((s, c) => s + c.unapplied, 0);
      expect(n.balance, n.name).toBe(open - credits);
    }
    for (const n of listNames(db, 'customer').filter((x) => x.parent_id === null)) {
      const open = listOpenInvoices(db, n.id).reduce((s, i) => s + i.open_balance, 0);
      const credits = listCredits(db, n.id).reduce((s, c) => s + c.unapplied, 0);
      expect(n.balance, n.name).toBe(open - credits);
    }
    // Over-application never slipped through; purchase orders never posted.
    const over = db
      .prepare(
        `SELECT t.id FROM txns t WHERE t.type = 'BILL'
            AND t.total < (SELECT COALESCE(SUM(amount + discount), 0) FROM links WHERE kind = 'apply' AND to_txn = t.id)
         UNION SELECT t.id FROM txns t WHERE t.type IN ('BILLPMT', 'BILLCREDIT')
            AND t.total < (SELECT COALESCE(SUM(amount), 0) FROM links WHERE kind = 'apply' AND from_txn = t.id)
         UNION SELECT s.txn_id FROM splits s JOIN txns t ON t.id = s.txn_id WHERE t.type = 'PURCHORD'`,
      )
      .all();
    expect(over).toEqual([]);
    // A closed P.O. always has a bill, unless she closed it by hand (never in this run).
    const orphan = db
      .prepare("SELECT id FROM txns t WHERE type = 'PURCHORD' AND closed = 1 AND NOT EXISTS (SELECT 1 FROM links WHERE kind = 'po' AND to_txn = t.id)")
      .all();
    expect(orphan).toEqual([]);

    function lines2() {
      return [
        { payroll_item_id: wages, hours: 1 + rnd(80), rate: 1500 + rnd(2000) },
        { payroll_item_id: fed, amount: rnd(5000) },
        { payroll_item_id: ssCo, amount: rnd(3000) },
      ];
    }
  });
});

// ---------------------------------------------------------------------------

describe('http api for purchases and banking', () => {
  it('round-trips purchase orders, bills, PDFs and lookups through /api/txns', async () => {
    const app = buildApp(db);
    const num = (await app.inject({ method: 'GET', url: '/api/txns/next-num?type=PURCHORD' })).json().num;
    const p = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/txns', payload: { type: 'PURCHORD', date: '2026-03-01', num, name_id: steel, lines: [{ item_id: bar, qty: 10, rate: 710 }] } });
    expect(p.statusCode).toBe(200);
    const poId = p.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/purchase-orders/open?vendor_id=${steel}` })).json()).toEqual([
      expect.objectContaining({ id: poId, num: '1', total: 7100 }),
    ]);
    const b = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/txns',
      payload: { type: 'BILL', date: '2026-03-02', ref_no: 'X1', name_id: steel, terms_id: net30, po_ids: [poId], items: [{ item_id: bar, qty: 10, rate: 710 }] },
    });
    expect(b.statusCode).toBe(200);
    const got = (await app.inject({ method: 'GET', url: `/api/txns/${b.json().id}` })).json();
    expect(got).toMatchObject({ type: 'BILL', total: 7100, open_balance: 7100, due_date: '2026-04-01', po_ids: [poId] });
    expect((await app.inject({ method: 'GET', url: `/api/txns/${poId}` })).json()).toMatchObject({ closed: true, splits: [] });
    const pdf = await app.inject({ method: 'GET', url: `/api/txns/${poId}/pdf` });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/Purchase Order 1\.pdf/);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await app.inject({ method: 'GET', url: '/api/txns/find?type=BILL&num=X1' })).json()).toHaveLength(1);
    const bad = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/txns', payload: { type: 'BILL', date: '2026-03-02', name_id: steel, items: [{ item_id: labor, qty: 1, rate: 1 }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/no purchase account/);
    const tr = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/txns', payload: { type: 'TRANSFER', date: '2026-03-02', from_account_id: checking, to_account_id: savings, amount: 100 } });
    expect(tr.statusCode).toBe(200);
  });

  it('round-trips pay bills, credits and check printing', async () => {
    const app = buildApp(db);
    const b = simpleBill(10000, { ref_no: 'B1', terms_id: net30 });
    const c = billCredit({ expenses: [{ account_id: supplies, amount: 1000 }] }).id;
    const unpaid = (await app.inject({ method: 'GET', url: '/api/bills/unpaid?due_on_or_before=2026-12-31&sort=vendor&pay_date=2026-03-05' })).json();
    expect(unpaid).toEqual([expect.objectContaining({ id: b, open_balance: 10000, suggested_discount: 200, credits_available: 1000 })]);
    expect((await app.inject({ method: 'GET', url: `/api/vendors/${steel}/credits` })).json()).toEqual([expect.objectContaining({ id: c, unapplied: 1000 })]);
    const r = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/pay-bills',
      payload: {
        date: '2026-03-05', account_id: checking, method: 'check', to_print: true,
        payments: [{ bill_id: b, amount: 8800, discount: 200, discount_account_id: discTaken }],
        credits: [{ credit_id: c, bill_id: b, amount: 1000 }],
      },
    });
    expect(r.statusCode).toBe(200);
    const pid = r.json().payments[0].id;
    expect(r.json()).toEqual({ payments: [{ id: pid, name_id: steel, num: '', amount: 8800 }] });
    expect((await app.inject({ method: 'GET', url: '/api/bills/unpaid' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/checks/to-print?account_id=${checking}` })).json()).toEqual([
      expect.objectContaining({ id: pid, type: 'BILLPMT', amount: 8800 }),
    ]);
    expect((await app.inject({ method: 'GET', url: `/api/txns/next-num?type=CHECK&account_id=${checking}` })).json()).toEqual({ num: '1' });
    const as = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/checks/assign-numbers', payload: { txn_ids: [pid], first_num: '3001' } });
    expect(as.json()).toEqual({ assigned: [{ id: pid, num: '3001' }] });
    expect((await app.inject({ method: 'GET', url: `/api/checks/num-used?account_id=${checking}&num=3001` })).json()).toMatchObject({ used: true });
    expect((await app.inject({ method: 'GET', url: `/api/checks/num-used?account_id=${checking}&num=3001&exclude_id=${pid}` })).json()).toEqual({ used: false, txns: [] });
    const pdf = await app.inject({ method: 'GET', url: `/api/txns/${pid}/pdf` });
    expect(pdf.headers['content-disposition']).toMatch(/Bill Payment 3001\.pdf/);
    const over = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/pay-bills', payload: { date: '2026-03-05', account_id: checking, payments: [{ bill_id: b, amount: 1 }] } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatch(/more than its open balance of \$0.00/);
  });

  it('round-trips payroll items, paychecks and the year-to-date summary', async () => {
    const app = buildApp(db);
    const created = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/payroll-items', payload: { name: 'Bonus', kind: 'earning', expense_account_id: wagesAcct } });
    expect(created.statusCode).toBe(200);
    const bonus = created.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/payroll-items/${bonus}` })).json()).toMatchObject({ name: 'Bonus', kind_label: 'Earning' });
    expect((await app.inject({ method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/payroll-items/${bonus}`, payload: { name: 'Holiday Bonus', kind: 'earning', expense_account_id: wagesAcct } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/payroll-items' })).json().map((p: { name: string }) => p.name)).toContain('Holiday Bonus');
    expect((await app.inject({ method: 'GET', url: `/api/employees/${dave}/last-paycheck` })).json()).toEqual({ paycheck: null });
    const pc = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/txns',
      payload: { type: 'PAYCHECK', date: '2026-03-13', account_id: checking, name_id: dave, num: '10', lines: [{ payroll_item_id: bonus, amount: 50000 }, { payroll_item_id: fed, amount: 5000 }] },
    });
    expect(pc.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/employees/${dave}/last-paycheck` })).json().paycheck).toMatchObject({ id: pc.json().id, total: 45000 });
    const sum = (await app.inject({ method: 'GET', url: `/api/payroll/summary?from=2026-01-01&to=2026-12-31&employee_id=${dave}` })).json();
    expect(sum.map((r: { payroll_item: string; amount: number }) => [r.payroll_item, r.amount])).toEqual([['Holiday Bonus', 50000], ['Federal Withholding', 5000]]);
    const pdf = await app.inject({ method: 'GET', url: `/api/txns/${pc.json().id}/pdf` });
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const del = await app.inject({ method: 'DELETE', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/payroll-items/${bonus}` });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/used on paychecks/);
  });
});
