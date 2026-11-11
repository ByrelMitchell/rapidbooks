import { TxnInput, type DocTxn, type PurchTxn } from '@rapidbooks/shared';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db';
import { runHistory } from '../src/import/cli';
import { importHistory, type HistoryResult } from '../src/import/history';
import { parseJournal } from '../src/import/journal';
import { reconcile } from '../src/import/reconcile';
import { decodeText, parseAmount, parsePeriodHeader, parseQbDate, tokenize } from '../src/import/table';
import { getTxn, saveTxn } from '../src/ledger/posting';

const dir = join(import.meta.dirname, 'fixtures', 'history');
const fx = (f: string) => readFileSync(join(dir, f));
const iif = fx('lists.iif');
const csv = fx('journal.csv');
const tsv = fx('journal.txt');

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

const scratch = mkdtempSync(join(tmpdir(), 'rb-history-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Helpers

const acct = (full: string) => {
  const rows = db.prepare('SELECT id, name, parent_id FROM accounts').all() as { id: number; name: string; parent_id: number | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const name = (id: number): string => {
    const r = byId.get(id)!;
    return r.parent_id === null ? r.name : `${name(r.parent_id)}:${r.name}`;
  };
  const hit = rows.find((r) => name(r.id) === full);
  if (!hit) throw new Error(`no account ${full}`);
  return hit.id;
};
const acctName = (id: number) => (db.prepare('SELECT name FROM accounts WHERE id = ?').get(id) as { name: string }).name;
const nameOf = (id: number | null) => (id === null ? null : (db.prepare('SELECT name FROM names WHERE id = ?').get(id) as { name: string }).name);
const byTrans = (no: string) => (db.prepare('SELECT id FROM txns WHERE qb_trans_no = ?').get(no) as { id: number }).id;
const txn = (no: string) => getTxn(db, byTrans(no));
/** Splits as [account leaf name, cents, name, cleared]. */
const splits = (no: string) => txn(no).splits.map((s) => [acctName(s.account_id), s.amount, nameOf(s.name_id), s.cleared]);
const row = (no: string) => db.prepare('SELECT * FROM txns WHERE id = ?').get(byTrans(no)) as Record<string, unknown>;

function importCsv(extra: Partial<Parameters<typeof importHistory>[1]> = {}): HistoryResult {
  return importHistory(db, { iif, journal: csv, ...extra });
}

// ---------------------------------------------------------------------------

describe('reading report exports', () => {
  it('parses amounts, dates and periods in the forms QuickBooks writes them', () => {
    expect(parseAmount('1,234.56')).toBe(123456);
    expect(parseAmount('(1,234.56)')).toBe(-123456);
    expect(parseAmount('1,234.56-')).toBe(-123456);
    expect(parseAmount('-$12')).toBe(-1200);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNaN();
    expect(parseQbDate('3/7/03')).toBe('2003-03-07');
    expect(parseQbDate('12/31/99')).toBe('1999-12-31');
    expect(parseQbDate('02/29/2025')).toBeNull();
    expect(parsePeriodHeader('Jan - Dec 25')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(parsePeriodHeader('Jul 1, 24 - Jun 30, 25')).toEqual({ from: '2024-07-01', to: '2025-06-30' });
    expect(parsePeriodHeader('2004')).toEqual({ from: '2004-01-01', to: '2004-12-31' });
  });

  it('splits quoted fields with delimiters, quotes and line breaks, and decodes Windows-1252', () => {
    expect(tokenize('a,"b, ""c""\r\nd",e\r\nf\n', ',').map((r) => [r.line, r.cells])).toEqual([
      [1, ['a', 'b, "c"\nd', 'e']],
      [3, ['f']],
    ]);
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
    expect(decodeText(Buffer.from('﻿café', 'utf8'))).toBe('café');
  });

  it('reads both layouts of the Journal into the same transactions', () => {
    const a = parseJournal(csv);
    const b = parseJournal(tsv);
    expect(a.delimiter).toBe(',');
    expect(b.delimiter).toBe('\t');
    expect(a.txns.length).toBe(27);
    const shape = (j: ReturnType<typeof parseJournal>) =>
      j.txns.map((t) => [t.transNo, t.qbType, t.date, t.num, t.rows.map((r) => [r.account, r.amount, r.name, r.cleared, r.memo])]);
    expect(shape(b)).toEqual(shape(a));
    expect(a.warnings).toEqual([]);
    // The quoted memo with a comma, quotes and a line break.
    expect(a.txns[3].rows[0].memo).toBe('Rush job, per "PO"\nship Friday');
    // Parenthesised / trailing-minus negative credit = a debit.
    expect(a.txns[3].rows[4].amount).toBe(5000);
  });
});

describe('history import (CSV layout, Open Balance column)', () => {
  it('imports every balanced transaction with exactly the Journal splits, in order', () => {
    const r = importCsv();
    expect(r.txnsRead).toBe(27);
    expect(r.txnsImported).toBe(26);
    expect(r.skipped).toEqual([expect.objectContaining({ num: 'GJ-BAD', reason: 'it does not balance in the file: debits 100.00, credits 90.00' })]);

    expect(splits('4')).toEqual([
      ['Accounts Receivable', 107000, 'Acme Tool', false],
      ['Machining Income', -85000, 'Acme Tool', false],
      ['Setup Charges', -15000, 'Acme Tool', false],
      ['Machining Income', -12000, 'Acme Tool', false],
      ['Discounts Given', 5000, 'Acme Tool', false],
    ]);
    expect(txn('4').splits[0].memo).toBe('Rush job, per "PO"\nship Friday');
    expect(splits('12')).toEqual([
      ['Checking', 242234, null, true],
      ['Undeposited Funds', -141000, 'Acme Tool', false],
      ['Undeposited Funds', -100000, 'Baker Mfg', false],
      ['Interest Income', -1234, null, false],
    ]);
    expect(splits('19')).toEqual([
      ['Checking', -53800, 'Steel Supply', false],
      ['Accounts Payable', 55000, 'Steel Supply', false],
      ['Discounts Taken', -1200, 'Steel Supply', false],
    ]);
    expect(splits('22')).toEqual([
      ['Checking', -200000, null, true],
      ['Savings', 200000, null, false],
    ]);
    expect(splits('24')).toEqual([
      ['Checking', -123216, 'Dave Miller', false],
      ['Payroll Expenses', 160000, 'Dave Miller', false],
      ['Payroll Liabilities', -24544, 'Dave Miller', false],
      ['Payroll Liabilities', -9920, 'Dave Miller', false],
      ['Payroll Liabilities', -2320, 'Dave Miller', false],
      ['Payroll Expenses', 9920, 'Dave Miller', false],
      ['Payroll Liabilities', -9920, 'Dave Miller', false],
    ]);
    // Cleared flags on the bank lines.
    expect(splits('20')[0]).toEqual(['Checking', -16510, 'Fastenal', true]);
    expect(splits('3')[0]).toEqual(['Checking', 40000, 'Baker Mfg', true]);
  });

  it('keeps every transaction in balance and the whole ledger at zero', () => {
    importCsv();
    expect((db.prepare('SELECT SUM(amount) AS n FROM splits').get() as { n: number }).n).toBe(0);
    expect(db.prepare('SELECT txn_id FROM splits GROUP BY txn_id HAVING SUM(amount) <> 0').all()).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM splits').get() as { n: number }).n).toBe(72);
  });

  it('fills document headers and lines', () => {
    importCsv();
    const inv = txn('4') as DocTxn;
    expect(inv).toMatchObject({ type: 'INVOICE', num: '1001', date: '2025-01-06', po_number: 'A-778', due_date: '2025-02-05', total: 107000, import_locked: false, qb_type: 'Invoice' });
    expect(db.prepare('SELECT name FROM terms WHERE id = ?').get(inv.terms_id)).toEqual({ name: 'Net 30' });
    expect(inv.lines.map((l) => [l.description, l.qty, l.rate, l.amount])).toEqual([
      ['CNC machining, per hour', 10, 8500, 85000],
      ['Machine setup', 1, 15000, 15000],
      ['6061 plate, 1/2"', 3, 4000, 12000],
      ['Repeat customer, café rate', null, -5000, -5000],
    ]);
    const pay = txn('9') as DocTxn;
    expect(pay).toMatchObject({ type: 'PAYMENT', ref_no: '5512', pay_method: 'Check', total: 141000, account_id: acct('Undeposited Funds') });
    const bill = txn('14') as PurchTxn;
    expect(bill).toMatchObject({ type: 'BILL', ref_no: 'S-4471', due_date: '2025-03-03', total: 39950 });
    expect(bill.items.map((l) => [l.qty, l.rate, l.amount])).toEqual([[100, 325, 32500]]);
    expect(bill.expenses.map((l) => [acctName(l.account_id), l.amount, l.memo])).toEqual([['Shop Supplies', 7450, 'Cutting oil']]);
    const pc = txn('24') as PurchTxn;
    expect(pc).toMatchObject({ type: 'PAYCHECK', num: '3005', total: 123216, account_id: acct('Checking'), import_locked: true });
    expect(nameOf(pc.name_id)).toBe('Dave Miller');
    const xfer = txn('22') as PurchTxn;
    expect(xfer).toMatchObject({ type: 'TRANSFER', account_id: acct('Checking'), to_account_id: acct('Savings'), total: 200000 });
  });

  it('marks documents editable or locked, with the reason', () => {
    const r = importCsv();
    const locked = Object.fromEntries(r.locked.map((l) => [`${l.qbType} ${l.num}`, l.category]));
    expect(locked).toEqual({
      'Invoice 1004': 'Its lines post differently in RapidBooks (an item or account has changed since)',
      'Sales Receipt SR-1': 'No RapidBooks form for this QuickBooks type: Sales Receipt',
      'Paycheck 3005': 'Paycheck: its payroll items are not in the export',
      'Paycheck 3006': 'Paycheck: its payroll items are not in the export',
    });
    expect(r.locked.find((l) => l.num === '1004')!.note).toContain('Machining Income:Setup Charges: QuickBooks 0.00, form -150.00');
    expect(r.editable).toBe(22);
    expect(r.editableRegrouped).toBe(1); // the bill payment with a discount
    expect(row('19').import_locked).toBe(0);
    expect(row('7').import_locked).toBe(1);
    // A type without a form keeps QuickBooks' type name and opens as splits only.
    const sr = txn('23');
    expect(sr.type).toBe('Sales Receipt');
    expect(sr).not.toHaveProperty('lines');
    expect(r.byType.find((c) => c.qbType === 'Paycheck')).toMatchObject({ read: 2, imported: 2, locked: 2, rowsRead: 14 });
  });

  it('creates names and accounts missing from the lists, inactive, with a warning', () => {
    const r = importCsv();
    expect(r.createdNames).toEqual(['Old Customer LLC (customer)']);
    expect(r.createdAccounts).toEqual(['Equipment Repairs (EXP)']);
    expect(db.prepare("SELECT kind, inactive FROM names WHERE name = 'Old Customer LLC'").get()).toEqual({ kind: 'customer', inactive: 1 });
    expect(db.prepare("SELECT type, inactive FROM accounts WHERE name = 'Equipment Repairs'").get()).toEqual({ type: 'EXP', inactive: 1 });
    expect(r.warnings.some((w) => w.includes('Equipment Repairs'))).toBe(true);
  });

  it('derives applications that reproduce the open balances, and links deposits', () => {
    const r = importCsv();
    expect(r.targetsFrom.AR).toBe("the Journal's Open Balance column");
    expect(r.unreproduced).toEqual([]);
    const open = (no: string) => (txn(no) as DocTxn | PurchTxn).open_balance;
    expect([open('2'), open('4'), open('5'), open('6'), open('7'), open('13')]).toEqual([0, 0, 0, 65500, 66000, 8500]);
    expect((txn('11') as DocTxn).unapplied).toBe(50000);
    // One payment paying two invoices, the second for a job of the customer.
    expect((txn('9') as DocTxn).links_out.map((l) => [l.num, l.amount])).toEqual([['1001', 107000], ['1002', 34000]]);
    // Partial payment after a credit memo.
    expect((txn('6') as DocTxn).links_in.map((l) => [l.type, l.amount])).toEqual([['CREDITMEMO', 17000], ['PAYMENT', 100000]]);
    // Bills: everything paid but the power bill; the discount sits on the bill payment's link.
    expect([open('14'), open('15'), open('16')]).toEqual([0, 21240, 0]);
    const disc = db.prepare("SELECT discount, discount_account_id FROM links WHERE kind = 'apply' AND discount > 0").all();
    expect(disc).toEqual([{ discount: 1200, discount_account_id: acct('Discounts Taken') }]);
    // Deposit links.
    const dep = txn('12') as DocTxn;
    expect(dep.payment_ids).toEqual([byTrans('9'), byTrans('10')]);
    expect(dep.lines.map((l) => [acctName(l.account_id!), l.amount])).toEqual([['Interest Income', 1234]]);
    expect((txn('11') as DocTxn).deposit_id).toBeNull();
    expect(r.links).toEqual({ apply: 9, deposit: 2, depositRowsUnmatched: 0 });
  });

  it('reports customers whose open balances cannot be reproduced', () => {
    // Pretend QuickBooks says invoice 1001 is still 100.00 open, which no application can give
    // (the money has to go somewhere and every other invoice is already full).
    const doctored = csv.toString('utf8').replace(',Net 30,2/5/25,,0.00,"1,070.00"', ',Net 30,2/5/25,,100.00,"1,070.00"');
    const r = importHistory(db, { iif, journal: doctored });
    expect(r.unreproduced.map((u) => u.name)).toEqual(['Acme Tool']);
    expect(r.unreproduced[0].detail[0]).toMatch(/payment 5512 .* has 100.00 unapplied; QuickBooks shows 0.00/);
  });

  it('refuses a company file that already has transactions', () => {
    importCsv();
    expect(() => importHistory(db, { iif, journal: csv })).toThrow(/already has transactions/);
  });
});

describe('history import (tab-delimited layout, Open Invoices and Unpaid Bills reports)', () => {
  it('gives the same ledger as the CSV layout and reproduces the reports', () => {
    const r = importHistory(db, { iif, journal: tsv, openInvoices: fx('open-invoices.csv'), unpaidBills: fx('unpaid-bills.csv'), asOf: '2025-03-31' });
    expect(r.targetsFrom).toEqual({ AR: 'the Open Invoices report', AP: 'the Unpaid Bills report' });
    expect(r.unreproduced).toEqual([]);
    const tsvSplits = db.prepare('SELECT t.qb_trans_no, s.seq, s.account_id, s.amount, s.name_id, s.cleared FROM splits s JOIN txns t ON t.id = s.txn_id ORDER BY t.id, s.seq').all();
    const other = openDb(':memory:');
    importHistory(other, { iif, journal: csv });
    expect(other.prepare('SELECT t.qb_trans_no, s.seq, s.account_id, s.amount, s.name_id, s.cleared FROM splits s JOIN txns t ON t.id = s.txn_id ORDER BY t.id, s.seq').all()).toEqual(tsvSplits);
    expect(r.locked.length).toBe(4);
    expect((txn('6') as DocTxn).open_balance).toBe(65500);
    expect((txn('15') as PurchTxn).open_balance).toBe(21240);
  });
});

describe('reconciliation', () => {
  const verify = () => ({
    trialBalance: fx('tb.csv'),
    asOf: '2025-03-31',
    openInvoices: fx('open-invoices.csv'),
    unpaidBills: fx('unpaid-bills.csv'),
    profitLoss: [{ data: fx('pl-2025.csv') }],
  });

  it('passes every comparison on matching QuickBooks reports', () => {
    const h = importCsv();
    const rec = reconcile(db, h, verify());
    const status = Object.fromEntries(rec.sections.filter((s) => s.status !== 'INFO').map((s) => [s.title, s.status]));
    expect(status).toEqual({
      'Transactions skipped': 'FAIL', // the unbalanced General Journal entry
      'Ledger balance': 'PASS',
      Applications: 'PASS',
      'Trial Balance as of 03/31/2025': 'PASS',
      'Open Invoices as of 03/31/2025': 'PASS',
      'Unpaid Bills as of 03/31/2025': 'PASS',
      'Profit & Loss 01/01/2025 - 12/31/2025': 'PASS',
    });
    expect(rec.text).toContain('Retained Earnings');
  });

  it('passes overall when nothing is skipped', () => {
    const clean = csv.toString('utf8').replace(/,26,General Journal[\s\S]*?\r\n\r\n/, '');
    const h = importHistory(db, { iif, journal: clean });
    const rec = reconcile(db, h, { ...verify(), trialBalance: fx('tb.csv') });
    expect(h.skipped).toEqual([]);
    expect(rec.pass).toBe(true);
    expect(rec.text).toContain('OVERALL: PASS');
  });

  it('compares an A/R Aging Summary per customer', () => {
    const h = importCsv();
    const rec = reconcile(db, h, { openInvoices: fx('ar-aging-summary.csv'), openAsOf: '2025-03-31' });
    expect(rec.sections.find((s) => s.title.startsWith('A/R Aging Summary'))!.status).toBe('PASS');
  });

  it('fails with the right differences on a doctored Trial Balance', () => {
    const h = importCsv();
    const tb = fx('tb.csv').toString('utf8').replace('Rent,"1,500.00",', 'Rent,"1,550.00",').replace('Savings,"2,000.00",\n', '');
    const rec = reconcile(db, h, { ...verify(), trialBalance: tb });
    const s = rec.sections.find((x) => x.title.startsWith('Trial Balance'))!;
    expect(s.status).toBe('FAIL');
    expect(s.differences).toEqual([
      'Rent: QuickBooks 1,550.00, RapidBooks 1,500.00, difference -50.00',
      'Savings: QuickBooks 0.00, RapidBooks 2,000.00, difference 2,000.00',
    ]);
    expect(rec.pass).toBe(false);
  });

  it('prints its own trial balance when no QuickBooks one is given', () => {
    const h = importCsv();
    const rec = reconcile(db, h, { asOf: '2025-03-31' });
    const s = rec.sections.find((x) => x.title.startsWith('RapidBooks Trial Balance'))!;
    expect(s.lines.at(-3)).toMatch(/^TOTAL\s+15,374\.98\s+15,374\.98$/);
  });
});

describe('saving imported transactions', () => {
  const invoiceInput = (t: DocTxn): TxnInput =>
    TxnInput.parse({
      type: 'INVOICE',
      date: t.date,
      num: t.num,
      name_id: t.name_id,
      memo: t.memo,
      version: t.version,
      ar_account_id: t.ar_account_id,
      terms_id: t.terms_id,
      due_date: t.due_date,
      po_number: t.po_number,
      ship_date: t.ship_date,
      ship_via: t.ship_via,
      bill_addr: t.bill_addr,
      ship_addr: t.ship_addr,
      message: t.message,
      lines: t.lines.map((l) => ({ item_id: l.item_id, description: l.description, qty: l.qty, rate: l.rate, rate_is_percent: l.rate_is_percent, amount: l.amount, account_id: l.account_id })),
    });
  const full = (no: string) => txn(no).splits.map(({ id: _id, ...s }) => s);

  it('re-saves an editable invoice through its form with identical splits', () => {
    importCsv();
    const before = full('4');
    saveTxn(db, invoiceInput(txn('4') as DocTxn), byTrans('4'));
    expect(full('4')).toEqual(before);
    expect((txn('4') as DocTxn).open_balance).toBe(0);
  });

  it('refuses to save a locked document through its form, but accepts a journal edit of its splits', () => {
    importCsv();
    const inv = txn('7') as DocTxn;
    expect(() => saveTxn(db, invoiceInput(inv), inv.id)).toThrow(/imported from QuickBooks exactly as QuickBooks posted it .*cannot be saved from its form/);
    const pc = txn('24');
    expect(() =>
      saveTxn(db, TxnInput.parse({ type: 'PAYCHECK', date: pc.date, account_id: acct('Checking'), name_id: pc.name_id, version: pc.version, lines: [] }), pc.id),
    ).toThrow(/cannot be saved from its form/);

    // Journal-style edit: move the setup line to the Setup Charges account.
    const s = inv.splits.map((x) => ({ account_id: x.account_id, amount: x.amount, name_id: x.name_id, memo: x.memo }));
    s[1].account_id = acct('Machining Income:Setup Charges');
    const res = saveTxn(db, TxnInput.parse({ type: 'GENJRNL', date: inv.date, num: inv.num, name_id: inv.name_id, memo: inv.memo, version: inv.version, splits: s }), inv.id);
    const after = txn('7') as DocTxn;
    expect(res.version).toBe(inv.version + 1);
    expect(after.type).toBe('INVOICE');
    expect(after.import_locked).toBe(true);
    expect(acctName(after.splits[1].account_id)).toBe('Setup Charges');
    expect(after.open_balance).toBe(66000);
    // Unbalanced edits are refused as usual.
    s[0].amount += 1;
    expect(() => saveTxn(db, TxnInput.parse({ type: 'GENJRNL', date: inv.date, splits: s, version: after.version }), inv.id)).toThrow(/not in balance/);
  });
});

// ---------------------------------------------------------------------------

describe('speed', () => {
  it('imports 60,000 transactions (about 200,000 rows) well within a minute', () => {
    const lines = [',Trans #,Type,Date,Num,Name,Memo,Item,Qty,Sales Price,Account,Clr,Debit,Credit'];
    const custs = ['Acme Tool', 'Baker Mfg', 'Carlson, Inc.', 'Delta Pump'];
    let n = 0;
    let rows = 0;
    const d = (i: number) => `${(i % 12) + 1}/${(i % 28) + 1}/${String(5 + Math.floor(i / 3000)).padStart(2, '0')}`;
    const q = (s: string) => (s.includes(',') ? `"${s}"` : s);
    for (let i = 0; i < 20000; i++) {
      const c = q(custs[i % 4]);
      const amt = ((i % 50) + 1) * 85;
      const money = (c: number) => (c / 100).toFixed(2);
      // invoice: 4 rows
      lines.push(`,${++n},Invoice,${d(i)},${10000 + i},${c},,,,,Accounts Receivable,,${money(amt * 100 + 15000)},`);
      lines.push(`,,,,,${c},Machining,Machining,-${(i % 50) + 1},85.00,Machining Income,,,${money(amt * 100)}`);
      lines.push(`,,,,,${c},Setup,Setup,-1,150.00,Machining Income:Setup Charges,,,150.00`);
      lines.push(`,,,,,${c},,,,,Machining Income,,,0.00`);
      // payment: 2 rows
      lines.push(`,${++n},Payment,${d(i)},${i},${c},,,,,Checking,,${money(amt * 100 + 15000)},`);
      lines.push(`,,,,,${c},,,,,Accounts Receivable,,,${money(amt * 100 + 15000)}`);
      // check: 3 rows
      lines.push(`,${++n},Check,${d(i)},${50000 + i},Fastenal,,,,,Checking,X,,${money(5000 + i)}`);
      lines.push(`,,,,,Fastenal,Supplies,,,,Shop Supplies,,${money(3000)},`);
      lines.push(`,,,,,Fastenal,Rent,,,,Rent,,${money(2000 + i)},`);
      rows += 9;
    }
    expect(n).toBe(60000);
    expect(rows).toBeGreaterThanOrEqual(180000);
    const t0 = Date.now();
    const r = importHistory(db, { iif, journal: lines.join('\r\n') });
    const secs = (Date.now() - t0) / 1000;
    expect(r.txnsImported).toBe(60000);
    expect(r.skipped).toEqual([]);
    expect(r.locked).toEqual([]);
    expect((db.prepare('SELECT SUM(amount) AS n FROM splits').get() as { n: number }).n).toBe(0);
    expect(secs).toBeLessThan(55);
    console.log(`60,000 transactions / ${rows} rows imported in ${secs.toFixed(1)} s`);
  }, 120_000);
});

describe('command line', () => {
  it('imports into a new file, refuses to overwrite it, and renames it with --force', () => {
    const out = join(scratch, 'company.db');
    const report = join(scratch, 'reconciliation.txt');
    const log: string[] = [];
    const err: string[] = [];
    const args = [
      '--iif', join(dir, 'lists.iif'), '--journal', join(dir, 'journal.csv'),
      '--trial-balance', join(dir, 'tb.csv'), '--as-of', '2025-03-31',
      '--open-invoices', join(dir, 'open-invoices.csv'), '--unpaid-bills', join(dir, 'unpaid-bills.csv'),
      '--profit-loss', join(dir, 'pl-2025.csv'),
      '--out', out, '--report', report,
    ];
    // FAIL (exit 1): the unbalanced entry in the fixture is skipped. Everything else passes.
    expect(runHistory(args, (s) => log.push(s), (s) => err.push(s))).toBe(1);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.importing`)).toBe(false);
    const text = readFileSync(report, 'utf8');
    expect(text).toContain('OVERALL: FAIL');
    expect(text).toContain('PASS  Trial Balance as of 03/31/2025');
    const db2 = openDb(out);
    expect((db2.prepare('SELECT COUNT(*) AS n FROM txns').get() as { n: number }).n).toBe(26);
    db2.close();

    expect(runHistory(args, (s) => log.push(s), (s) => err.push(s))).toBe(2);
    expect(err.at(-1)).toMatch(/already exists/);

    expect(runHistory([...args, '--force'], (s) => log.push(s), (s) => err.push(s))).toBe(1);
    expect(readdirSync(scratch).filter((f) => /^company\.db\.before-import-\d{8}-\d{6}$/.test(f))).toHaveLength(1);

    // A clean journal passes (exit 0).
    const clean = join(scratch, 'clean.csv');
    writeFileSync(clean, csv.toString('utf8').replace(/,26,General Journal[\s\S]*?\r\n\r\n/, ''));
    const args2 = args.map((a) => (a === join(dir, 'journal.csv') ? clean : a === out ? join(scratch, 'clean.db') : a));
    expect(runHistory(args2, () => {}, (s) => err.push(s))).toBe(0);
  });
});
