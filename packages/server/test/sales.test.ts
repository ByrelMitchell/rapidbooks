import {
  ItemInput,
  NameInput,
  TermsInput,
  TxnInput,
  lineAmount,
  percentOf,
  type DocTxn,
  type LineInput,
} from '@rapidbooks/shared';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb, seedDefaults, type DB } from '../src/db';
import { createAccount, listAccounts } from '../src/ledger/accounts';
import { assessFinanceCharges, previewFinanceCharges, setFinanceChargeSettings } from '../src/ledger/finance';
import {
  deleteTxn,
  getRegister,
  getTxn,
  nextFinanceChargeNum,
  nextNum,
  removeApplication,
  saveTxn,
} from '../src/ledger/posting';
import {
  adjacentTxns,
  applyCredits,
  findTxns,
  listCredits,
  listOpenInvoices,
  listPendingPayments,
  listToEmail,
  listToPrint,
} from '../src/ledger/receivables';
import { agingBucket, getStatement, listStatementCustomers } from '../src/ledger/statements';
import { createItem, deleteItem, updateItem } from '../src/lists/items';
import { createName, listNames } from '../src/lists/names';
import { createTerms, deleteTerms } from '../src/lists/terms';
import { loadSmtpConfig } from '../src/mail/config';
import { emailDraft, sendEmailBatch, sendInvoiceEmail, type MailerFactory } from '../src/mail/send';
import { renderSalesDocPdf } from '../src/pdf/invoice';
import { renderStatementPdf } from '../src/pdf/statement';

let db: DB;
let ar: number, uf: number, checking: number, sales: number, parts: number, discAcct: number, fcIncome: number;
let interest: number;
let acme: number, job: number, zeta: number;
let net30: number;
let mach: number, pin: number, sub: number, disc: number, fee: number, grp: number, fixedDisc: number;

const acct = (name: string, type: string) =>
  createAccount(db, { name, type: type as 'INC', parent_id: null, description: '', inactive: false });
const cust = (name: string, extra: Partial<NameInput> = {}) =>
  createName(db, NameInput.parse({ kind: 'customer', name, ...extra }));
const item = (name: string, extra: Partial<ItemInput>) => createItem(db, ItemInput.parse({ name, ...extra }));

type L = Partial<LineInput>;
const L = (item_id: number | null, qty: number | null, rate: number | null, extra: L = {}): L => ({ item_id, qty, rate, ...extra });

function invoice(lines: L[], extra: Record<string, unknown> = {}, id?: number) {
  return saveTxn(db, TxnInput.parse({ type: 'INVOICE', date: '2026-01-10', name_id: acme, lines, ...extra }), id);
}
function creditMemo(lines: L[], extra: Record<string, unknown> = {}, id?: number) {
  return saveTxn(db, TxnInput.parse({ type: 'CREDITMEMO', date: '2026-01-12', name_id: acme, lines, ...extra }), id);
}
function payment(amount: number, applications: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}, id?: number) {
  return saveTxn(
    db,
    TxnInput.parse({ type: 'PAYMENT', date: '2026-01-20', name_id: acme, amount, applications, ...extra }),
    id,
  );
}
function deposit(payment_ids: number[], lines: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}, id?: number) {
  return saveTxn(
    db,
    TxnInput.parse({ type: 'DEPOSIT', date: '2026-01-25', account_id: checking, payment_ids, lines, ...extra }),
    id,
  );
}
/** A quick invoice of one machining line for `cents`. */
const simpleInvoice = (cents: number, extra: Record<string, unknown> = {}) =>
  invoice([L(mach, null, null, { amount: cents })], extra).id;

const doc = (id: number) => getTxn(db, id) as DocTxn;
const splitsOf = (id: number) => getTxn(db, id).splits.map((s) => [s.account_id, s.amount, s.name_id]);
const trialBalance = () => (db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM splits').get() as { n: number }).n;
const txnSums = () =>
  db.prepare('SELECT txn_id, SUM(amount) AS n FROM splits GROUP BY txn_id HAVING n <> 0').all() as unknown[];
const version = (id: number) => getTxn(db, id).version;
const txnRow = (id: number) => db.prepare('SELECT id FROM txns WHERE id = ?').get(id);

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  const byName = new Map(listAccounts(db).map((a) => [a.name, a.id]));
  ar = byName.get('Accounts Receivable')!;
  uf = byName.get('Undeposited Funds')!;
  checking = byName.get('Checking')!;
  sales = byName.get('Sales')!;
  parts = acct('Parts Sales', 'INC');
  discAcct = acct('Discounts Given', 'INC');
  fcIncome = acct('Finance Charge Income', 'OINC');
  interest = acct('Interest Income', 'OINC');
  net30 = createTerms(db, TermsInput.parse({ name: 'Net 30', net_days: 30, discount_pct: 200, discount_days: 10 }));
  acme = cust('Acme', { terms_id: net30, email: 'ap@acme.example', contact: 'Linda Park', bill_addr: 'Acme Fabrication\n1200 Industrial Pkwy\nDayton, OH 45404' });
  job = cust('Press Frame', { parent_id: acme });
  zeta = cust('Zeta Pumps', { email: 'pay@zeta.example' });
  mach = item('Machining', { type: 'SERVICE', rate: 6500, account_id: sales, description: 'CNC machining, per hour' });
  pin = item('Pin', { type: 'PART', rate: 3.75, account_id: parts, description: 'Dowel pin' });
  sub = item('Subtotal', { type: 'SUBTOTAL' });
  disc = item('Repeat Discount', { type: 'DISCOUNT', rate: 1000, rate_is_percent: true, account_id: discAcct });
  fixedDisc = item('Courtesy', { type: 'DISCOUNT', rate: 500, account_id: discAcct });
  fee = item('Expedite', { type: 'OTHER_CHARGE', rate: 500, rate_is_percent: true, account_id: sales });
  grp = item('Kit', { type: 'GROUP', members: [{ item_id: mach, qty: 1 }] });
});

// ---------------------------------------------------------------------------

describe('line arithmetic', () => {
  it('multiplies qty by fractional-cent rates and rounds half away from zero', () => {
    expect(lineAmount(1000, 3.75)).toBe(3750); // 1000 pins at $0.0375
    expect(lineAmount(1, 3.75)).toBe(4); // 3.75 cents -> 4
    expect(lineAmount(3, 0.5)).toBe(2); // 1.5 -> 2
    expect(lineAmount(-1, 2.5)).toBe(-3); // -2.5 -> -3
    expect(lineAmount(7, 3.333)).toBe(23); // 23.331
    expect(lineAmount(2.5, 3.75)).toBe(9); // 9.375
    expect(lineAmount(3, 1.005)).toBe(3); // 3.015 -> 3
    expect(lineAmount(0.1, 5)).toBe(1); // 0.5 -> 1, without 0.1 drift
    expect(lineAmount(null, 1234.5)).toBe(1235); // no qty: the rate
    expect(lineAmount(1e6, 99999.999)).toBe(99999999000);
    expect(percentOf(16750, 1000)).toBe(1675);
    expect(percentOf(4175, 500)).toBe(209); // 208.75
    expect(percentOf(-5, 1000)).toBe(-1); // -0.5
  });

  it('lets item rates hold fractions of a cent, up to three decimals', () => {
    expect(ItemInput.parse({ name: 'X', type: 'PART', rate: 3.75 }).rate).toBe(3.75);
    expect(ItemInput.parse({ name: 'X', type: 'PART', rate: 0.1 + 0.2 }).rate).toBe(0.3);
    expect(() => ItemInput.parse({ name: 'X', type: 'PART', rate: 3.7501 })).toThrow(/five decimal places/);
    expect(() =>
      item('Odd', { type: 'DISCOUNT', rate: 12.5, rate_is_percent: true, account_id: discAcct }),
    ).toThrow(/two decimal places/);
  });
});

describe('invoices', () => {
  it('posts each item line to its account and the total to A/R', () => {
    const { id } = invoice(
      [
        L(mach, 2, 6500, { description: 'Setup and run' }),
        L(null, null, null, { description: 'Per drawing 4471 rev C' }),
        L(pin, 1000, 3.75),
      ],
      { num: '1001', terms_id: net30, po_number: 'PO-77', memo: 'January job' },
    );
    expect(splitsOf(id)).toEqual([
      [ar, 16750, acme],
      [sales, -13000, acme],
      [parts, -3750, acme],
    ]);
    expect(trialBalance()).toBe(0);
    const t = doc(id);
    expect(t).toMatchObject({
      type: 'INVOICE',
      num: '1001',
      total: 16750,
      open_balance: 16750,
      unapplied: null,
      due_date: '2026-02-09', // Net 30 from 01/10
      po_number: 'PO-77',
      ar_account_id: ar,
      is_finance_charge: false,
    });
    expect(t.lines.map((l) => [l.item_id, l.qty, l.rate, l.amount])).toEqual([
      [mach, 2, 6500, 13000],
      [null, null, null, 0],
      [pin, 1000, 3.75, 3750],
    ]);
    expect(t.splits[0].memo).toBe('January job');
  });

  it('lets an explicit amount win, and uses the rate when qty is blank', () => {
    const { id } = invoice([L(mach, 2, 6500, { amount: 12000 }), L(pin, null, 3.75)]);
    expect(doc(id).lines.map((l) => l.amount)).toEqual([12000, 4]);
    expect(doc(id).total).toBe(12004);
  });

  it('computes subtotals and percent discounts on the line above', () => {
    const { id } = invoice([
      L(mach, 2, 6500), // 13000
      L(pin, 1000, 3.75), // 3750
      L(sub, null, null, { amount: 999 }), // ignored: 16750
      L(disc, null, 1000, { rate_is_percent: true }), // 10% of the subtotal: -1675
      L(mach, 1, 6500), // 6500
      L(disc, null, 1000, { rate_is_percent: true }), // 10% of 6500: -650
      L(sub, null, null), // since the last subtotal: -1675 + 6500 - 650 = 4175
      L(fee, null, 500, { rate_is_percent: true }), // 5% of 4175 = 208.75 -> +209
      L(fixedDisc, 1, 500), // fixed discount: always negative, -500
    ]);
    expect(doc(id).lines.map((l) => l.amount)).toEqual([13000, 3750, 16750, -1675, 6500, -650, 4175, 209, -500]);
    // 13000 + 3750 - 1675 + 6500 - 650 + 209 - 500 = 20634; subtotals post nothing.
    expect(doc(id).total).toBe(20634);
    expect(splitsOf(id)).toEqual([
      [ar, 20634, acme],
      [sales, -13000, acme],
      [parts, -3750, acme],
      [discAcct, 1675, acme],
      [sales, -6500, acme],
      [discAcct, 650, acme],
      [sales, -209, acme],
      [discAcct, 500, acme],
    ]);
    expect(trialBalance()).toBe(0);
  });

  it('refuses groups, amounts without items, negative totals and non-customers', () => {
    expect(() => invoice([L(grp, 1, null)])).toThrow(/Kit is a group item/);
    expect(() => invoice([L(null, null, null, { amount: 500 })])).toThrow(/Line 1 has an amount but no item/);
    expect(() => invoice([L(mach, 1, 100), L(fixedDisc, 1, 500)])).toThrow(/cannot be negative.*credit memo/);
    expect(() => invoice([L(mach, 1, 100)], { name_id: null })).toThrow(/Choose a customer/);
    const vend = createName(db, NameInput.parse({ kind: 'vendor', name: 'Steel' }));
    expect(() => invoice([L(mach, 1, 100)], { name_id: vend })).toThrow(/Steel is not a customer/);
    expect(() => invoice([L(mach, 1, 100, { rate_is_percent: true })])).toThrow(/cannot be a percentage/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM txns').get()).toEqual({ n: 0 });
  });

  it('allows a zero total', () => {
    const { id } = invoice([L(null, null, null, { description: 'No charge: warranty rework' }), L(mach, 1, 0)]);
    expect(doc(id).total).toBe(0);
    expect(splitsOf(id)).toEqual([
      [ar, 0, acme],
      [sales, 0, acme],
    ]);
  });

  it('replaces splits and lines on edit and removes them on delete', () => {
    const { id } = invoice([L(mach, 2, 6500), L(pin, 100, 3.75)]);
    const r = invoice([L(mach, 3, 6500)], { version: 1, due_date: '2026-03-01' }, id);
    expect(r.version).toBe(2);
    expect(splitsOf(id)).toEqual([
      [ar, 19500, acme],
      [sales, -19500, acme],
    ]);
    expect(doc(id).lines).toHaveLength(1);
    expect(doc(id).due_date).toBe('2026-03-01');
    expect(() => invoice([L(mach, 1, 1)], { version: 1 }, id)).toThrow(/changed in another window/);
    deleteTxn(db, id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM splits').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM lines').get()).toEqual({ n: 0 });
  });

  it('refuses deleting an item that has been used on a form', () => {
    invoice([L(pin, 1, 3.75)]);
    expect(() => deleteItem(db, pin)).toThrow(/Pin has been used on transactions and cannot be deleted/);
    updateItem(db, pin, ItemInput.parse({ name: 'Pin', type: 'PART', rate: 4.125, account_id: parts }));
    const cod = createTerms(db, TermsInput.parse({ name: 'COD' }));
    invoice([L(pin, 1, 3.75)], { terms_id: cod });
    expect(() => deleteTerms(db, cod)).toThrow(/in use and cannot be deleted/);
  });

  it('numbers invoices and credit memos from one sequence, finance charges separately', () => {
    expect(nextNum(db, 'INVOICE')).toBe('1');
    simpleInvoice(100, { num: '1001' });
    expect(nextNum(db, 'CREDITMEMO')).toBe('1002');
    creditMemo([L(mach, null, null, { amount: 50 })], { num: '1002' });
    expect(nextNum(db, 'INVOICE')).toBe('1003');
    simpleInvoice(100, { num: 'FC 4' });
    expect(nextNum(db, 'INVOICE')).toBe('1003');
    expect(nextFinanceChargeNum(db)).toBe('FC 5');
    expect(nextNum(db, 'GENJRNL')).toBe('1');
  });
});

describe('credit memos', () => {
  it('posts the mirror image of an invoice', () => {
    const { id } = creditMemo([L(mach, 1, 6500), L(disc, null, 1000, { rate_is_percent: true })], { num: '1002' });
    expect(splitsOf(id)).toEqual([
      [ar, -5850, acme],
      [sales, 6500, acme],
      [discAcct, -650, acme],
    ]);
    expect(doc(id)).toMatchObject({ total: 5850, unapplied: 5850, open_balance: null });
    expect(trialBalance()).toBe(0);
  });
});

describe('payments', () => {
  it('posts to Undeposited Funds and A/R, with discounts, and links to invoices', () => {
    const inv1 = simpleInvoice(10000, { num: '1001' });
    const inv2 = simpleInvoice(5000, { num: '1002' });
    const { id } = payment(
      12000,
      [
        { txn_id: inv1, amount: 9800, discount: 200, discount_account_id: discAcct },
        { txn_id: inv2, amount: 1000 },
      ],
      { ref_no: '5521', pay_method: 'Check', memo: 'Thanks' },
    );
    expect(splitsOf(id)).toEqual([
      [uf, 12000, acme],
      [ar, -12000, acme],
      [discAcct, 200, acme],
      [ar, -200, acme],
    ]);
    expect(trialBalance()).toBe(0);
    const p = doc(id);
    expect(p).toMatchObject({ num: '5521', ref_no: '5521', total: 12000, unapplied: 1200, account_id: uf, deposit_id: null });
    expect(p.links_out.map((l) => [l.txn_id, l.num, l.amount, l.discount])).toEqual([
      [inv1, '1001', 9800, 200],
      [inv2, '1002', 1000, 0],
    ]);
    expect(doc(inv1).open_balance).toBe(0);
    expect(doc(inv2).open_balance).toBe(4000);
    expect(doc(inv2).links_in.map((l) => [l.txn_id, l.type, l.num, l.amount])).toEqual([[id, 'PAYMENT', '5521', 1000]]);
    // Customer balance = open invoices - unapplied credit = 4000 - 1200.
    expect(listNames(db).find((n) => n.id === acme)!.balance).toBe(2800);
  });

  it('writes off an invoice with a payment of 0.00 that only takes a discount, kept out of deposits', () => {
    const inv = simpleInvoice(10000, { num: '1001' });
    expect(() => payment(0, [{ txn_id: inv, amount: 0 }])).toThrow(/amount of the payment/);
    const { id } = payment(0, [{ txn_id: inv, amount: 0, discount: 10000, discount_account_id: discAcct }]);
    expect(splitsOf(id)).toEqual([
      [uf, 0, acme],
      [ar, 0, acme],
      [discAcct, 10000, acme],
      [ar, -10000, acme],
    ]);
    expect(trialBalance()).toBe(0);
    expect(doc(inv).open_balance).toBe(0);
    expect(doc(id)).toMatchObject({ total: 0, unapplied: 0 });
    expect(listNames(db).find((n) => n.id === acme)!.balance).toBe(0);
    expect(listPendingPayments(db)).toEqual([]);
  });

  it('refuses over-application, wrong customers, and missing discount accounts', () => {
    const inv = simpleInvoice(10000, { num: '1001' });
    expect(() => payment(5000, [{ txn_id: inv, amount: 6000 }])).toThrow(/You applied \$60.00, but the payment is only \$50.00/);
    expect(() => payment(20000, [{ txn_id: inv, amount: 10001 }])).toThrow(/more than its open balance of \$100.00/);
    expect(() => payment(20000, [{ txn_id: inv, amount: 9900, discount: 200, discount_account_id: discAcct }])).toThrow(
      /payment and discount applied to invoice 1001 \(\$101.00\) is more than its open balance/,
    );
    expect(() => payment(5000, [{ txn_id: inv, amount: 4000, discount: 100 }])).toThrow(/Choose the account for the discount/);
    expect(() => payment(5000, [{ txn_id: inv, amount: 5000 }], { name_id: zeta })).toThrow(
      /Invoice 1001 is for Acme, so a payment from Zeta Pumps cannot be applied/,
    );
    expect(() => payment(0)).toThrow(/amount of the payment/);
    payment(6000, [{ txn_id: inv, amount: 6000 }]);
    expect(() => payment(5000, [{ txn_id: inv, amount: 5000 }])).toThrow(/open balance of \$40.00/);
    expect(txnSums()).toEqual([]);
  });

  it('lets a customer pay its job\'s invoice, but not a job its customer\'s', () => {
    const jobInv = simpleInvoice(3000, { name_id: job, num: '1' });
    const custInv = simpleInvoice(2000, { num: '2' });
    payment(3000, [{ txn_id: jobInv, amount: 3000 }]); // from Acme for Acme:Press Frame
    expect(doc(jobInv).open_balance).toBe(0);
    expect(() => payment(2000, [{ txn_id: custInv, amount: 2000 }], { name_id: job })).toThrow(/is for Acme, so a payment from Acme:Press Frame/);
    payment(500, [{ txn_id: jobInv, amount: 0 }], { name_id: job }); // nothing applied
    expect(listOpenInvoices(db, acme).map((i) => i.num)).toEqual(['2']);
  });

  it('re-applies on edit; deleting the invoice makes the payment a credit and drops its discount', () => {
    const inv = simpleInvoice(10000, { num: '1001' });
    const { id } = payment(9800, [{ txn_id: inv, amount: 9800, discount: 200, discount_account_id: discAcct }]);
    expect(() => invoice([L(mach, null, null, { amount: 9999 })], { version: 1, num: '1001' }, inv)).toThrow(
      /Payments and credits of \$100.00 have been applied to this invoice, so its total cannot be less/,
    );
    expect(() => invoice([L(mach, 1, 10000)], { version: 1, name_id: zeta }, inv)).toThrow(/cannot be moved to Zeta Pumps/);
    invoice([L(mach, 1, 12000)], { version: 1, num: '1001' }, inv); // raising it is fine
    expect(doc(inv).open_balance).toBe(2000);

    // Edit the payment: apply less, no discount.
    payment(9800, [{ txn_id: inv, amount: 5000 }], { version: 1 }, id);
    expect(splitsOf(id)).toEqual([
      [uf, 9800, acme],
      [ar, -9800, acme],
    ]);
    expect(doc(inv).open_balance).toBe(7000);
    payment(9800, [{ txn_id: inv, amount: 9800, discount: 200, discount_account_id: discAcct }], { version: 2 }, id);

    deleteTxn(db, inv);
    const p = doc(id);
    expect(p.links_out).toEqual([]);
    expect(p.unapplied).toBe(9800);
    expect(splitsOf(id)).toEqual([
      [uf, 9800, acme],
      [ar, -9800, acme],
    ]);
    expect(trialBalance()).toBe(0);
    expect(listNames(db).find((n) => n.id === acme)!.balance).toBe(-9800);
    expect(listCredits(db, acme).map((c) => [c.id, c.unapplied])).toEqual([[id, 9800]]);
  });

  it('deleting a payment removes its applications', () => {
    const inv = simpleInvoice(10000);
    const { id } = payment(4000, [{ txn_id: inv, amount: 4000 }]);
    deleteTxn(db, id);
    expect(doc(inv).open_balance).toBe(10000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM links').get()).toEqual({ n: 0 });
  });

  it('deleting a written-off invoice, or unapplying the write-off, deletes the 0.00 payment too', () => {
    const inv = simpleInvoice(10000, { num: '1001' });
    const w = payment(0, [{ txn_id: inv, amount: 0, discount: 10000, discount_account_id: discAcct }]).id;
    deleteTxn(db, inv);
    expect(txnRow(w)).toBeUndefined();
    expect(trialBalance()).toBe(0);
    expect(listNames(db).find((n) => n.id === acme)!.balance).toBe(0);

    const inv2 = simpleInvoice(10000, { num: '1002' });
    const w2 = payment(0, [{ txn_id: inv2, amount: 0, discount: 10000, discount_account_id: discAcct }]).id;
    removeApplication(db, doc(w2).links_out[0].id);
    expect(txnRow(w2)).toBeUndefined();
    expect(doc(inv2).open_balance).toBe(10000);
    expect(db.prepare('SELECT action FROM audit_log WHERE txn_id = ? ORDER BY id').all(w2).slice(-2)).toEqual([
      { action: 'delete' },
      { action: 'unapply' },
    ]);
    expect(txnSums()).toEqual([]);
  });

  it('takes a discount back out of a payment imported as posted, even folded into one A/R line', () => {
    const inv = simpleInvoice(10000, { num: '1001' });
    const inv2 = simpleInvoice(5000, { num: '1002' });
    const { id } = payment(9800, [{ txn_id: inv, amount: 9800, discount: 200, discount_account_id: discAcct }]);
    // As QuickBooks may post it: one A/R line for the payment and the discount.
    db.prepare('DELETE FROM splits WHERE txn_id = ? AND seq >= 2').run(id);
    db.prepare('UPDATE splits SET amount = -10000 WHERE txn_id = ? AND seq = 1').run(id);
    db.prepare('INSERT INTO splits (txn_id, seq, account_id, amount, name_id, memo) VALUES (?, 2, ?, 200, ?, ?)').run(id, discAcct, acme, '');
    db.prepare("UPDATE txns SET import_locked = 1, qb_type = 'Payment' WHERE id = ?").run(id);
    expect(txnSums()).toEqual([]);

    deleteTxn(db, inv);
    expect(splitsOf(id)).toEqual([
      [uf, 9800, acme],
      [ar, -9800, acme],
    ]);
    expect(doc(id).unapplied).toBe(9800);
    expect(trialBalance()).toBe(0);

    // A discount it cannot find: refused with a plain message, nothing changed.
    const { id: p2 } = payment(4900, [{ txn_id: inv2, amount: 4900, discount: 100, discount_account_id: discAcct }]);
    db.prepare('UPDATE splits SET account_id = ? WHERE txn_id = ? AND seq = 2').run(sales, p2);
    db.prepare("UPDATE txns SET import_locked = 1, qb_type = 'Payment' WHERE id = ?").run(p2);
    expect(() => deleteTxn(db, inv2)).toThrow(/cannot find the discount in its lines.*Nothing was changed/);
    expect(doc(inv2).open_balance).toBe(0);
  });
});

describe('a second A/R account', () => {
  it("lists and pays only the invoices in the payment's A/R account", async () => {
    const ar2 = acct('A/R Imported', 'AR');
    const inv1 = simpleInvoice(10000, { num: '1001' });
    const inv2 = simpleInvoice(20000, { num: '1002', ar_account_id: ar2 });
    expect(listOpenInvoices(db, acme, null, ar).map((i) => i.num)).toEqual(['1001']);
    expect(listOpenInvoices(db, acme, null, ar2).map((i) => i.num)).toEqual(['1002']);

    const p = payment(20000, [{ txn_id: inv2, amount: 20000 }], { ar_account_id: ar2 }).id;
    expect(doc(p).ar_account_id).toBe(ar2);
    expect(doc(inv2).open_balance).toBe(0);

    const app = buildApp(db);
    const get = async (q: string) => (await app.inject({ url: `/api/customers/${acme}/open-invoices${q}` })).json().map((i: { num: string }) => i.num);
    expect(await get('')).toEqual(['1001']); // a new payment: the default A/R account
    expect(await get(`?payment_id=${p}`)).toEqual(['1002']); // editing: the payment's own
    expect(await get(`?ar_account_id=${ar2}&payment_id=${p}`)).toEqual(['1002']);
    expect(await get(`?ar_account_id=${ar}`)).toEqual(['1001']);
    expect(doc(inv1).open_balance).toBe(10000);
  });
});

describe('journal edits of transactions imported as posted', () => {
  const lock = (id: number, qb: string) => db.prepare('UPDATE txns SET import_locked = 1, qb_type = ? WHERE id = ?').run(qb, id);
  const journal = (id: number, change: (s: { account_id: number; amount: number; name_id: number | null; memo: string }[]) => void, extra: Record<string, unknown> = {}) => {
    const t = getTxn(db, id);
    const splits = t.splits.map((x) => ({ account_id: x.account_id, amount: x.amount, name_id: x.name_id, memo: x.memo }));
    change(splits);
    return saveTxn(db, TxnInput.parse({ type: 'GENJRNL', date: t.date, num: t.num, name_id: t.name_id, memo: t.memo, version: t.version, splits, ...extra }), id);
  };

  it('keep a deposited payment, a deposit and applications true', () => {
    const inv = simpleInvoice(50000, { num: '1001' });
    const p = payment(50000, [{ txn_id: inv, amount: 30000 }]).id;
    const d = deposit([p]).id;
    lock(p, 'Payment');
    lock(d, 'Deposit');
    lock(inv, 'Invoice');

    // A deposited payment's amount and customer stay as they are.
    expect(() => journal(p, (s) => { s[0].amount = 45000; s[1].amount = -45000; })).toThrow(/has been deposited, so its amount, customer/);
    expect(() => journal(p, (s) => s.forEach((x) => (x.name_id = zeta)), { name_id: zeta })).toThrow(/has been deposited/);
    // Its memo and other lines can still change.
    journal(p, () => {}, { memo: 'Check 552' });
    expect(doc(p).memo).toBe('Check 552');

    // The deposit keeps what it takes out of Undeposited Funds.
    expect(() => journal(d, (s) => { s[0].amount = 45000; s[1].amount = -45000; })).toThrow(/Undeposited Funds lines must still total \$500.00/);

    // An invoice cannot drop below what is applied to it.
    expect(() => journal(inv, (s) => { s[0].amount = 20000; s[1].amount = -20000; })).toThrow(
      /Payments and credits of \$300.00 have been applied to this invoice/,
    );
    journal(inv, (s) => { s[0].amount = 30000; s[1].amount = -30000; });
    expect(doc(inv).open_balance).toBe(0);
    expect(() => journal(inv, (s) => s.forEach((x) => (x.name_id = zeta)), { name_id: zeta })).toThrow(/its name cannot be changed/);

    // A credit memo cannot drop below what of it is applied.
    const inv2 = simpleInvoice(10000, { num: '1002' });
    const cm = creditMemo([L(mach, null, null, { amount: 8000 })], { num: '1003' }).id;
    applyCredits(db, { applications: [{ from_txn: cm, to_txn: inv2, amount: 6000 }] });
    lock(cm, 'Credit Memo');
    expect(() => journal(cm, (s) => { s[0].amount = -5000; s[1].amount = 5000; })).toThrow(/\$60.00 of this credit memo has been applied/);
    expect(trialBalance()).toBe(0);
    expect(txnSums()).toEqual([]);
  });
});

describe('applying credits', () => {
  it('applies credit memos and payment remainders to invoices without posting', () => {
    const inv = simpleInvoice(10000, { num: '1001' });
    const cm = creditMemo([L(mach, null, null, { amount: 3000 })], { num: '1002' }).id;
    const pmt = payment(5000).id;
    const before = db.prepare('SELECT COUNT(*) AS n FROM splits').get();
    applyCredits(db, {
      applications: [
        { from_txn: cm, to_txn: inv, amount: 2500 },
        { from_txn: pmt, to_txn: inv, amount: 5000 },
      ],
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM splits').get()).toEqual(before);
    expect(doc(inv).open_balance).toBe(2500);
    expect(doc(cm).unapplied).toBe(500);
    expect(doc(pmt).unapplied).toBe(0);
    expect(version(cm)).toBe(2);

    expect(() => applyCredits(db, { applications: [{ from_txn: cm, to_txn: inv, amount: 600 }] })).toThrow(
      /Only \$5.00 of that credit memo is left/,
    );
    const cm2 = creditMemo([L(mach, null, null, { amount: 9000 })]).id;
    expect(() => applyCredits(db, { applications: [{ from_txn: cm2, to_txn: inv, amount: 3000 }] })).toThrow(
      /more than the open balance of invoice 1001 \(\$25.00\)/,
    );
    const zInv = simpleInvoice(1000, { name_id: zeta, num: 'Z1' });
    expect(() => applyCredits(db, { applications: [{ from_txn: cm2, to_txn: zInv, amount: 100 }] })).toThrow(
      /Invoice Z1 is for Zeta Pumps, so a credit from Acme cannot be applied/,
    );
    // A second application between the same pair adds to the first.
    applyCredits(db, { applications: [{ from_txn: cm, to_txn: inv, amount: 500 }] });
    expect(doc(inv).links_in.find((l) => l.txn_id === cm)!.amount).toBe(3000);

    // Credit memo edits cannot go below what is applied.
    expect(() => creditMemo([L(mach, null, null, { amount: 2000 })], { version: 3, num: '1002' }, cm)).toThrow(
      /\$30.00 of this credit memo has been applied/,
    );

    const link = doc(inv).links_in.find((l) => l.txn_id === cm)!;
    removeApplication(db, link.id);
    expect(doc(inv).open_balance).toBe(5000);
    expect(listCredits(db, acme).map((c) => [c.type, c.unapplied])).toEqual([
      ['CREDITMEMO', 3000],
      ['CREDITMEMO', 9000],
    ]);
    expect(txnSums()).toEqual([]);
  });
});

describe('deposits', () => {
  it('moves payments out of Undeposited Funds into the bank, with other lines', () => {
    const p1 = payment(10000, [], { ref_no: '101' }).id;
    const p2 = payment(2500, [], { name_id: zeta, ref_no: '7' }).id;
    const direct = payment(700, [], { account_id: checking }).id;
    expect(listPendingPayments(db).map((p) => p.id)).toEqual([p1, p2]);

    const { id } = deposit([p1, p2], [{ account_id: interest, amount: 123, description: 'Interest', pay_method: 'Cash' }], { memo: 'Jan deposit' });
    expect(splitsOf(id)).toEqual([
      [checking, 12623, null],
      [uf, -10000, acme],
      [uf, -2500, zeta],
      [interest, -123, null],
    ]);
    expect(trialBalance()).toBe(0);
    expect(doc(id)).toMatchObject({ total: 12623, payment_ids: [p1, p2], account_id: checking });
    expect(doc(id).lines.map((l) => [l.account_id, l.amount, l.pay_method])).toEqual([[interest, 123, 'Cash']]);
    expect(doc(p1).deposit_id).toBe(id);
    expect(listPendingPayments(db)).toEqual([]);
    expect(listPendingPayments(db, id).map((p) => [p.id, p.in_this_deposit])).toEqual([
      [p1, true],
      [p2, true],
    ]);

    // The Undeposited Funds register shows the deposit as one row.
    const reg = getRegister(db, uf);
    expect(reg.map((r) => [r.type, r.amount, r.balance])).toEqual([
      ['PAYMENT', 10000, 10000],
      ['PAYMENT', 2500, 12500],
      ['DEPOSIT', -12500, 0],
    ]);

    expect(() => deposit([p1])).toThrow(/already in another deposit/);
    expect(() => deposit([direct])).toThrow(/was not received into Undeposited Funds/);
    expect(() => deposit([], [])).toThrow(/at least one payment or line/);
    expect(() => deposit([p1], [], {}, undefined)).toThrow(/already in another deposit/);
    expect(() => deleteTxn(db, p1)).toThrow(/Remove it from the deposit first/);
    expect(() => payment(9000, [], { ref_no: '101', version: 1 }, p1)).toThrow(/Remove it from the deposit first/);
    payment(10000, [], { ref_no: '101', memo: 'memo is fine', version: 1 }, p1);

    // Edit the deposit to drop p2, then delete it: p1 waits again.
    deposit([p1], [], { version: 1 }, id);
    expect(splitsOf(id)).toEqual([
      [checking, 10000, null],
      [uf, -10000, acme],
    ]);
    expect(listPendingPayments(db).map((p) => p.id)).toEqual([p2]);
    deleteTxn(db, id);
    expect(listPendingPayments(db).map((p) => p.id)).toEqual([p1, p2]);
    deleteTxn(db, p1);
    expect(trialBalance()).toBe(0);
  });
});

describe('finance charges', () => {
  it('charges open overdue balances by days late, with a minimum and the last-charge date', () => {
    setFinanceChargeSettings(db, {
      annual_rate_bp: 1800, // 18% a year
      min_charge: 100, // $1.00
      grace_days: 10,
      account_id: fcIncome,
      charge_on_finance_charges: false,
    });
    // Acme: invoice A $1,000.00 dated 01/01, Net 30 -> due 01/31; $400 paid 02/10 -> $600 open.
    const a = simpleInvoice(100000, { date: '2026-01-01', terms_id: net30, num: 'A' });
    payment(40000, [{ txn_id: a, amount: 40000 }], { date: '2026-02-10' });
    // Acme: invoice B $200.00 dated 03/01, due 03/31: not yet late on 03/31.
    simpleInvoice(20000, { date: '2026-03-01', terms_id: net30, num: 'B' });
    // Zeta: $50.00 dated 01/15, due 02/14.
    simpleInvoice(5000, { date: '2026-01-15', terms_id: net30, name_id: zeta, num: 'Z' });

    // As of 03/31:
    //  Acme A: grace ends 01/31 + 10 = 02/10; 02/10 -> 03/31 = 49 days.
    //          60000 × 18% × 49 / 365 = 1449.86 -> $14.50
    //  Zeta Z: grace ends 02/24; 35 days. 5000 × 18% × 35 / 365 = 86.30 -> $0.86,
    //          below the $1.00 minimum -> $1.00
    const p = previewFinanceCharges(db, '2026-03-31');
    expect(p.map((x) => [x.full_name, x.computed, x.charge])).toEqual([
      ['Acme', 1450, 1450],
      ['Zeta Pumps', 86, 100],
    ]);
    expect(p[0].invoices.map((i) => [i.num, i.open_balance, i.from_date, i.days])).toEqual([['A', 60000, '2026-02-10', 49]]);

    const ids = assessFinanceCharges(db, '2026-03-31', [acme, zeta]);
    expect(ids).toHaveLength(2);
    expect(doc(ids[0])).toMatchObject({ num: 'FC 1', is_finance_charge: true, total: 1450, date: '2026-03-31' });
    expect(doc(ids[1]).num).toBe('FC 2');
    expect(splitsOf(ids[0])).toEqual([
      [ar, 1450, acme],
      [fcIncome, -1450, acme],
    ]);

    // As of 04/30, Acme was last charged on 03/31:
    //  A: from max(02/10, 03/31) = 03/31, 30 days: 60000 × 18% × 30/365 = 887.67
    //  B: due 03/31, grace ends 04/10, 20 days:   20000 × 18% × 20/365 = 197.26
    //  FC 1 is skipped (no charges on finance charges).
    //  The exact sum 1084.93 is rounded once -> $10.85.
    const q = previewFinanceCharges(db, '2026-04-30').find((x) => x.name_id === acme)!;
    expect(q.invoices.map((i) => [i.num, i.from_date, i.days, i.charge])).toEqual([
      ['A', '2026-03-31', 30, 888],
      ['B', '2026-04-10', 20, 197],
    ]);
    expect(q.charge).toBe(1085);

    // Charging on finance charges adds FC 1: 1450 × 18% × 20/365 = 14.30; 1084.93 + 14.30 = 1099.23.
    setFinanceChargeSettings(db, { annual_rate_bp: 1800, min_charge: 100, grace_days: 10, account_id: fcIncome, charge_on_finance_charges: true });
    expect(previewFinanceCharges(db, '2026-04-30').find((x) => x.name_id === acme)!.charge).toBe(1099);
    expect(trialBalance()).toBe(0);
  });

  it('needs a finance charge account to assess', () => {
    setFinanceChargeSettings(db, { annual_rate_bp: 1800, min_charge: 0, grace_days: 0, account_id: null, charge_on_finance_charges: false });
    expect(() => assessFinanceCharges(db, '2026-03-31', [acme])).toThrow(/finance charge account/);
  });
});

describe('statements', () => {
  it('puts amounts in aging buckets at the boundaries', () => {
    const asOf = '2026-06-30';
    expect(agingBucket('2026-06-30', asOf)).toBe('current'); // 0 days
    expect(agingBucket('2026-07-15', asOf)).toBe('current'); // not due yet
    expect(agingBucket('2026-05-31', asOf)).toBe('d1_30'); // 30
    expect(agingBucket('2026-05-30', asOf)).toBe('d31_60'); // 31
    expect(agingBucket('2026-05-01', asOf)).toBe('d31_60'); // 60
    expect(agingBucket('2026-04-30', asOf)).toBe('d61_90'); // 61
    expect(agingBucket('2026-04-01', asOf)).toBe('d61_90'); // 90
    expect(agingBucket('2026-03-31', asOf)).toBe('over_90'); // 91
  });

  it('shows balance forward, running balance, ending balance and aging', () => {
    // Seven invoices dated 03/01 with due dates 0, 30, 31, 60, 61, 90 and 91 days before 06/30.
    const dues: [string, number][] = [
      ['2026-06-30', 100],
      ['2026-05-31', 200],
      ['2026-05-30', 400],
      ['2026-05-01', 800],
      ['2026-04-30', 1600],
      ['2026-04-01', 3200],
      ['2026-03-31', 6400],
    ];
    const ids = dues.map(([due, cents], i) => simpleInvoice(cents, { date: '2026-03-01', due_date: due, num: String(100 + i) }));
    // In June: a job invoice, a payment of the 61-day invoice, an unapplied credit memo.
    simpleInvoice(5000, { date: '2026-06-10', name_id: job, num: '200' }); // due 06/10 -> 20 days late
    payment(1600, [{ txn_id: ids[4], amount: 1600 }], { date: '2026-06-15', ref_no: '889' });
    creditMemo([L(mach, null, null, { amount: 300 })], { date: '2026-06-20', num: '201' });
    simpleInvoice(9999, { name_id: zeta, date: '2026-06-05' }); // another customer: not on Acme's statement

    const s = getStatement(db, acme, '2026-06-01', '2026-06-30');
    expect(s.balance_forward).toBe(12700);
    expect(s.rows.map((r) => [r.date, r.type, r.num, r.amount, r.balance])).toEqual([
      ['2026-06-10', 'INVOICE', '200', 5000, 17700],
      ['2026-06-15', 'PAYMENT', '889', -1600, 16100],
      ['2026-06-20', 'CREDITMEMO', '201', -300, 15800],
    ]);
    expect(s.rows[0].description).toBe('Press Frame: INV #200. Due 06/10/2026. Orig. Amount $50.00.');
    expect(s.rows[1].description).toBe('PMT #889.');
    expect(s.ending_balance).toBe(15800);
    expect(s.aging).toEqual({
      current: 100 - 300, // the 0-day invoice less the unapplied credit
      d1_30: 200 + 5000,
      d31_60: 400 + 800,
      d61_90: 3200, // the 1600 one was paid
      over_90: 6400,
    });
    const sum = Object.values(s.aging).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.ending_balance);

    // As of 05/31 the June payment does not count yet: the 1600 invoice is 31 days late.
    const may = getStatement(db, acme, '2026-05-01', '2026-05-31');
    expect(may.rows).toEqual([]);
    expect(may.balance_forward).toBe(12700);
    expect(may.ending_balance).toBe(12700);
    expect(may.aging).toEqual({ current: 100 + 200, d1_30: 400 + 800, d31_60: 1600 + 3200, d61_90: 6400, over_90: 0 });

    const quiet = cust('Quiet Co');
    const both = listStatementCustomers(db, '2026-06-01', '2026-06-30');
    expect(both.map((c) => [c.full_name, c.balance, c.has_activity])).toEqual([
      ['Acme', 15800, true],
      ['Zeta Pumps', 9999, true],
    ]);
    expect(listStatementCustomers(db, '2026-07-01', '2026-07-31').map((c) => [c.full_name, c.has_activity])).toEqual([
      ['Acme', false],
      ['Zeta Pumps', false],
    ]);
    void quiet;
  });
});

describe('lists for the forms', () => {
  it('lists open invoices oldest first, credits, queues, neighbours and numbers', () => {
    const i2 = simpleInvoice(2000, { date: '2026-02-01', num: '2', name_id: job, terms_id: net30 });
    const i1 = simpleInvoice(1000, { date: '2026-01-01', num: '10', to_print: true, to_email: true });
    const i3 = simpleInvoice(3000, { date: '2026-02-01', num: '9' });
    const zi = simpleInvoice(500, { name_id: zeta, num: '11' });
    const pmt = payment(2500, [{ txn_id: i1, amount: 1000 }, { txn_id: i3, amount: 1000 }]).id;

    const open = listOpenInvoices(db, acme);
    expect(open.map((i) => [i.num, i.full_name, i.open_balance])).toEqual([
      ['2', 'Acme:Press Frame', 2000],
      ['9', 'Acme', 2000],
    ]);
    expect(open[0]).toMatchObject({ discount_pct: 200, discount_date: '2026-02-11' });
    // Editing the payment: its own invoices come back with what it applied.
    const forEdit = listOpenInvoices(db, acme, pmt);
    expect(forEdit.map((i) => [i.num, i.open_balance, i.applied_by_payment])).toEqual([
      ['10', 1000, 1000],
      ['2', 2000, 0],
      ['9', 3000, 1000],
    ]);
    expect(listOpenInvoices(db, job).map((i) => i.num)).toEqual(['2']);
    expect(listCredits(db, job).map((c) => [c.type, c.unapplied])).toEqual([['PAYMENT', 500]]); // from the parent
    expect(listCredits(db, zeta)).toEqual([]);

    expect(listToPrint(db).map((d) => d.id)).toEqual([i1]);
    expect(listToEmail(db).map((d) => [d.id, d.email])).toEqual([[i1, 'ap@acme.example']]);

    // Previous/Next by date, then number: 10 (01/01), 2 (02/01), 9 (02/01), 11 (01/10)
    // -> order: 10, 11, 2, 9
    expect(adjacentTxns(db, 'INVOICE', i1)).toEqual({ prev: null, next: zi });
    expect(adjacentTxns(db, 'INVOICE', i2)).toEqual({ prev: zi, next: i3 });
    expect(adjacentTxns(db, 'INVOICE', i3)).toEqual({ prev: i2, next: null });
    expect(adjacentTxns(db, 'INVOICE', null)).toEqual({ prev: i3, next: null });
    expect(findTxns(db, 'INVOICE', '9').map((t) => t.id)).toEqual([i3]);
    expect(findTxns(db, 'INVOICE', '404')).toEqual([]);
  });

  it('keeps the GENJRNL shape and shows documents as single register rows', () => {
    const je = saveTxn(
      db,
      TxnInput.parse({ type: 'GENJRNL', date: '2026-01-01', splits: [{ account_id: ar, amount: 500, name_id: acme }, { account_id: sales, amount: -500 }] }),
    ).id;
    expect(Object.keys(getTxn(db, je)).sort()).toEqual(['date', 'id', 'memo', 'name_id', 'num', 'splits', 'type', 'version']);
    const inv = invoice([L(mach, 1, 1000), L(pin, 100, 3.75)], { num: '7' }).id;
    const inv2 = invoice([L(mach, 1, 1000)], { num: '8' }).id;
    payment(1000, [{ txn_id: inv, amount: 900, discount: 100, discount_account_id: discAcct }]);
    const reg = getRegister(db, ar);
    expect(reg.map((r) => [r.type, r.num, r.amount, r.balance, r.other_account_id])).toEqual([
      ['GENJRNL', '', 500, 500, sales],
      ['INVOICE', '7', 1375, 1875, null], // two income accounts: split
      ['INVOICE', '8', 1000, 2875, sales],
      ['PAYMENT', '', -1100, 1775, null], // payment and discount in one row
    ]);
    void inv2;
  });
});

describe('a long mixed sequence', () => {
  it('stays in balance and customer balances equal open invoices less unapplied credits', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n; // the high bits; an LCG's low bits cycle quickly
    };
    const customers = [acme, job, zeta, cust('Delta', {}), cust('Delta Job', { parent_id: zeta })];
    const items = [mach, pin, sub, disc, fixedDisc, fee];
    const day = () => `2026-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const randomLines = (): L[] => {
      const n = 1 + rnd(5);
      const out: L[] = [L(mach, 1 + rnd(5), 1000 + rnd(9000))];
      for (let i = 0; i < n; i++) {
        const it = items[rnd(items.length)];
        if (it === disc || it === fee) out.push(L(it, null, 500 + rnd(1000), { rate_is_percent: true }));
        else if (it === fixedDisc) out.push(L(it, 1, 1 + rnd(100)));
        else out.push(L(it, rnd(50), it === pin ? 3.75 : 100 + rnd(5000) + rnd(1000) / 1000));
      }
      return out;
    };
    const tryIt = (f: () => void) => {
      try {
        f();
      } catch (e) {
        if (!(e instanceof Error) || (e as { status?: number }).status !== 400) throw e;
      }
    };
    const ofType = (type: string) => (db.prepare('SELECT id FROM txns WHERE type = ?').all(type) as { id: number }[]).map((r) => r.id);

    for (let step = 0; step < 300; step++) {
      const c = customers[rnd(customers.length)];
      const op = rnd(10);
      tryIt(() => {
        if (op <= 2) invoice(randomLines(), { name_id: c, date: day() });
        else if (op === 3) creditMemo([L(mach, 1, 100 + rnd(3000))], { name_id: c, date: day() });
        else if (op === 4) {
          const open = listOpenInvoices(db, c);
          const apps = open.slice(0, 2).map((i) => ({
            txn_id: i.id,
            amount: Math.max(0, i.open_balance - rnd(3) * 100),
            discount: rnd(2) && i.open_balance > 200 ? 50 : 0,
            discount_account_id: discAcct,
          }));
          const applied = apps.reduce((s, a) => s + a.amount, 0);
          payment(applied + rnd(3) * 1000 || 500, apps.filter((a) => a.amount + a.discount <= open.find((i) => i.id === a.txn_id)!.open_balance), { name_id: c, date: day() });
        } else if (op === 5) {
          const credits = listCredits(db, c);
          const open = listOpenInvoices(db, c);
          if (credits.length && open.length) {
            applyCredits(db, {
              applications: [{ from_txn: credits[0].id, to_txn: open[0].id, amount: Math.min(credits[0].unapplied, open[0].open_balance) }],
            });
          }
        } else if (op === 6) {
          const pend = listPendingPayments(db);
          if (pend.length) deposit(pend.slice(0, 1 + rnd(3)).map((p) => p.id), rnd(2) ? [{ account_id: interest, amount: rnd(500) }] : []);
        } else if (op === 7) {
          const invs = ofType('INVOICE');
          if (invs.length) {
            const id = invs[rnd(invs.length)];
            const t = doc(id);
            invoice(randomLines(), { name_id: t.name_id, date: t.date, version: t.version }, id);
          }
        } else if (op === 8) {
          const all = [...ofType('INVOICE'), ...ofType('PAYMENT'), ...ofType('CREDITMEMO'), ...ofType('DEPOSIT')];
          if (all.length) deleteTxn(db, all[rnd(all.length)]);
        } else {
          const pays = ofType('PAYMENT');
          if (pays.length) {
            const id = pays[rnd(pays.length)];
            const t = doc(id);
            const open = listOpenInvoices(db, t.name_id!, id);
            const apps = open.slice(0, 1).map((i) => ({ txn_id: i.id, amount: Math.min(t.total, i.open_balance) }));
            payment(t.total, apps, { name_id: t.name_id, date: t.date, version: t.version }, id);
          }
        }
      });
      expect(txnSums()).toEqual([]);
    }

    expect(trialBalance()).toBe(0);
    expect(ofType('INVOICE').length).toBeGreaterThan(10);
    const actions = new Set((db.prepare('SELECT DISTINCT action FROM audit_log').all() as { action: string }[]).map((r) => r.action));
    expect([...actions].sort()).toEqual(['apply', 'create', 'delete', 'update']);
    expect(ofType('DEPOSIT').length).toBeGreaterThan(0);
    const names = listNames(db, 'customer');
    for (const n of names.filter((x) => x.parent_id === null)) {
      const open = listOpenInvoices(db, n.id).reduce((s, i) => s + i.open_balance, 0);
      const credits = listCredits(db, n.id).reduce((s, c) => s + c.unapplied, 0);
      expect(n.balance, n.full_name).toBe(open - credits);
      expect(getStatement(db, n.id, '2026-01-01', '2026-12-31').ending_balance).toBe(n.balance);
    }
    // Over-application never slipped through.
    const over = db
      .prepare(
        `SELECT t.id FROM txns t WHERE t.type = 'INVOICE'
            AND t.total < (SELECT COALESCE(SUM(amount + discount), 0) FROM links WHERE kind = 'apply' AND to_txn = t.id)
         UNION SELECT t.id FROM txns t WHERE t.type IN ('PAYMENT', 'CREDITMEMO')
            AND t.total < (SELECT COALESCE(SUM(amount), 0) FROM links WHERE kind = 'apply' AND from_txn = t.id)`,
      )
      .all();
    expect(over).toEqual([]);
  });
});

describe('PDFs', () => {
  beforeEach(() => {
    const up = db.prepare('INSERT INTO company (key, value) VALUES (?, ?)');
    up.run('name', 'Acme Machine Works');
    up.run('address', '45 Foundry Rd\nDayton, OH 45402');
  });

  it('renders an invoice, a credit memo and a statement', async () => {
    const inv = invoice([L(mach, 2, 6500, { description: 'Setup and run' }), L(pin, 1000, 3.75)], { num: '1001', message: 'Thank you!' }).id;
    const cm = creditMemo([L(mach, 1, 6500)], { num: '1002' }).id;
    for (const pdf of [await renderSalesDocPdf(db, inv), await renderSalesDocPdf(db, cm), await renderStatementPdf(db, acme, '2026-01-01', '2026-01-31')]) {
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
  });

  it('breaks a 60-line invoice over pages', async () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      L(i % 3 ? mach : pin, i + 1, i % 3 ? 6500 : 3.75, {
        description: i % 7 === 0 ? `Line ${i + 1}: a long description that wraps onto a second and maybe a third line of the description column` : `Line ${i + 1}`,
      }),
    );
    const id = invoice(lines, { num: '2001' }).id;
    const pdf = await renderSalesDocPdf(db, id);
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});

describe('e-mail', () => {
  function captureMailer() {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: { to: { address: string }[]; subject: string; text: string; attachments: { filename: string; content: string; contentType: string }[]; bcc?: unknown }[] = [];
    const send = transport.sendMail.bind(transport);
    transport.sendMail = (async (m: SendMailOptions) => {
      const info = await send(m);
      sent.push(JSON.parse((info as unknown as { message: string }).message));
      return info;
    }) as typeof transport.sendMail;
    const mailer: MailerFactory = () => ({ transport, from: 'Acme Machine <office@acme-machine.example>', bccSelf: true });
    return { mailer, sent };
  }

  beforeEach(() => {
    db.prepare("INSERT INTO company (key, value) VALUES ('name', 'Acme Machine Works')").run();
  });

  it('builds a message with the PDF attached and records it', async () => {
    const id = invoice([L(mach, 1, 6500)], { num: '1234', to_email: true }).id;
    const draft = emailDraft(db, id);
    expect(draft).toMatchObject({
      to: 'ap@acme.example',
      subject: 'Invoice 1234 from Acme Machine Works',
      attachment_name: 'Invoice 1234.pdf',
    });
    expect(draft.body).toMatch(/^Dear Linda Park:/);
    expect(draft.body).toMatch(/\$65.00/);

    const { mailer, sent } = captureMailer();
    await sendInvoiceEmail(db, { txn_id: id, to: draft.to, cc: '', subject: draft.subject, body: draft.body }, mailer);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Invoice 1234 from Acme Machine Works');
    expect(sent[0].attachments[0]).toMatchObject({ filename: 'Invoice 1234.pdf', contentType: 'application/pdf' });
    expect(Buffer.from(sent[0].attachments[0].content, 'base64').subarray(0, 4).toString()).toBe('%PDF');
    expect(sent[0].bcc).toBeTruthy();
    expect(doc(id).to_email).toBe(false);
    expect(doc(id).emailed_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(listToEmail(db)).toEqual([]);
    // A window still holding the old version cannot put it back in the queue unseen.
    expect(() => invoice([L(mach, 1, 6500)], { num: '1234', to_email: true, version: 1 }, id)).toThrow(/changed in another window/);
    expect(version(id)).toBe(2);
  });

  it('sends a batch and reports each result', async () => {
    const ok = invoice([L(mach, 1, 6500)], { num: '1', to_email: true }).id;
    const noEmail = cust('No Mail Co');
    const bad = invoice([L(mach, 1, 6500)], { num: '2', to_email: true, name_id: noEmail }).id;
    const jobInv = invoice([L(mach, 1, 6500)], { num: '3', to_email: true, name_id: job }).id; // uses the parent's address
    const { mailer, sent } = captureMailer();
    const r = await sendEmailBatch(db, [ok, bad, jobInv], mailer);
    expect(r).toEqual([
      { txn_id: ok, num: '1', ok: true, error: null },
      { txn_id: bad, num: '2', ok: false, error: 'No Mail Co has no e-mail address.' },
      { txn_id: jobInv, num: '3', ok: true, error: null },
    ]);
    expect(sent.map((m) => m.to[0].address)).toEqual(['ap@acme.example', 'ap@acme.example']);
  });

  it('says which SMTP setting is missing', () => {
    const none = { RAPIDBOOKS_SMTP_FILE: 'Z:/no/such/smtp.json' };
    expect(loadSmtpConfig(none)).toMatchObject({ ok: false, missing: expect.stringMatching(/SMTP server name is missing.*RAPIDBOOKS_SMTP_HOST/) });
    expect(loadSmtpConfig({ ...none, RAPIDBOOKS_SMTP_HOST: 'mail.example' })).toMatchObject({ missing: expect.stringMatching(/From address/) });
    expect(loadSmtpConfig({ ...none, RAPIDBOOKS_SMTP_HOST: 'mail.example', RAPIDBOOKS_SMTP_FROM: 'a@b', RAPIDBOOKS_SMTP_USER: 'u' })).toMatchObject({
      missing: expect.stringMatching(/password is missing/),
    });
    expect(
      loadSmtpConfig({ ...none, RAPIDBOOKS_SMTP_HOST: 'mail.example', RAPIDBOOKS_SMTP_FROM: 'a@b', RAPIDBOOKS_SMTP_SECURE: 'true' }),
    ).toEqual({ ok: true, config: { host: 'mail.example', port: 465, secure: true, user: '', password: '', from: 'a@b', bcc_self: false } });
  });
});

// ---------------------------------------------------------------------------

describe('http api for sales', () => {
  it('round-trips invoices, payments and lookups', async () => {
    const app = buildApp(db);
    const post = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/txns',
      payload: { type: 'INVOICE', date: '2026-01-10', num: '1001', name_id: acme, terms_id: net30, lines: [{ item_id: mach, qty: 2, rate: 6500 }] },
    });
    expect(post.statusCode).toBe(200);
    const { id } = post.json();
    const got = (await app.inject({ method: 'GET', url: `/api/txns/${id}` })).json();
    expect(got).toMatchObject({ type: 'INVOICE', total: 13000, open_balance: 13000, due_date: '2026-02-09' });
    const put = await app.inject({
      method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' },
      url: `/api/txns/${id}`,
      payload: { type: 'INVOICE', date: '2026-01-10', num: '1001', name_id: acme, version: 1, lines: [{ item_id: grp, qty: 1 }] },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/group item/);
    expect((await app.inject({ method: 'GET', url: '/api/txns/next-num?type=CREDITMEMO' })).json()).toEqual({ num: '1002' });
    expect((await app.inject({ method: 'GET', url: `/api/txns/adjacent?type=INVOICE&id=${id}` })).json()).toEqual({ prev: null, next: null });
    expect((await app.inject({ method: 'GET', url: '/api/txns/adjacent?type=INVOICE' })).json()).toEqual({ prev: id, next: null });
    expect((await app.inject({ method: 'GET', url: '/api/txns/find?type=INVOICE&num=1001' })).json()).toHaveLength(1);

    const pay = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/txns',
      payload: { type: 'PAYMENT', date: '2026-01-20', name_id: acme, amount: 15000, ref_no: '77', applications: [{ txn_id: id, amount: 13000 }] },
    });
    expect(pay.statusCode).toBe(200);
    const pid = pay.json().id;

    // Customers: open invoices, credits, applying, unapplying
    expect((await app.inject({ method: 'GET', url: `/api/customers/${acme}/open-invoices` })).json()).toEqual([]);
    const forEdit = (await app.inject({ method: 'GET', url: `/api/customers/${acme}/open-invoices?payment_id=${pid}` })).json();
    expect(forEdit[0]).toMatchObject({ id, applied_by_payment: 13000 });
    expect((await app.inject({ method: 'GET', url: `/api/customers/${acme}/credits` })).json()[0]).toMatchObject({ id: pid, unapplied: 2000 });
    const inv2 = simpleInvoice(1500, { num: '1003' });
    const apply = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/credits/apply', payload: { applications: [{ from_txn: pid, to_txn: inv2, amount: 1500 }] } });
    expect(apply.statusCode).toBe(200);
    const link = doc(inv2).links_in[0];
    expect((await app.inject({ method: 'DELETE', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/links/${link.id}` })).statusCode).toBe(200);
    const over = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/credits/apply', payload: { applications: [{ from_txn: pid, to_txn: inv2, amount: 2500 }] } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatch(/Only \$20.00 of that payment is left/);

    // Queues and deposits
    expect((await app.inject({ method: 'GET', url: '/api/invoices/to-print' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/invoices/to-email' })).json()).toEqual([]);
    const pending = (await app.inject({ method: 'GET', url: '/api/deposits/pending' })).json();
    expect(pending.map((p: { id: number }) => p.id)).toEqual([pid]);
    const dep = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/txns', payload: { type: 'DEPOSIT', date: '2026-01-21', account_id: checking, payment_ids: [pid] } });
    expect(dep.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/txns/${pid}` });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/Remove it from the deposit first/);
    expect((await app.inject({ method: 'GET', url: `/api/deposits/pending?deposit_id=${dep.json().id}` })).json()[0]).toMatchObject({ in_this_deposit: true });
  });

  it('round-trips finance charges and statements', async () => {
    const app = buildApp(db);
    const put = await app.inject({
      method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/finance-charges/settings',
      payload: { annual_rate_bp: 1800, min_charge: 100, grace_days: 0, account_id: fcIncome },
    });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/finance-charges/settings' })).json()).toEqual({
      annual_rate_bp: 1800, min_charge: 100, grace_days: 0, account_id: fcIncome, charge_on_finance_charges: false,
    });
    simpleInvoice(100000, { date: '2026-01-01', due_date: '2026-01-31' });
    const prev = (await app.inject({ method: 'GET', url: '/api/finance-charges/preview?as_of=2026-03-02' })).json();
    expect(prev).toHaveLength(1);
    expect(prev[0]).toMatchObject({ name_id: acme, charge: 1479 }); // 100000 × 18% × 30/365 = 1479.45
    const assess = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/finance-charges/assess', payload: { as_of: '2026-03-02', customer_ids: [acme] } });
    expect(assess.json().ids).toHaveLength(1);

    const st = (await app.inject({ method: 'GET', url: `/api/statements?customer_id=${acme}&from=2026-03-01&to=2026-03-31` })).json();
    expect(st).toMatchObject({ balance_forward: 100000, ending_balance: 101479 });
    expect((await app.inject({ method: 'GET', url: '/api/statements/customers?from=2026-03-01&to=2026-03-31' })).json()).toHaveLength(1);
    const pdf = await app.inject({ method: 'GET', url: `/api/statements/pdf?customer_id=${acme}&from=2026-03-01&to=2026-03-31` });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const ipdf = await app.inject({ method: 'GET', url: `/api/txns/${assess.json().ids[0]}/pdf` });
    expect(ipdf.headers['content-type']).toBe('application/pdf');
    expect(ipdf.headers['content-disposition']).toBe(`inline; filename="Invoice FC 1.pdf"; filename*=UTF-8''Invoice%20FC%201.pdf`);
    // A name with characters outside Latin-1 (curly apostrophe, em dash) still makes a PDF.
    db.prepare('UPDATE names SET name = ? WHERE id = ?').run('O’Brien’s Garage — East', acme);
    const curly = await app.inject({ method: 'GET', url: `/api/statements/pdf?customer_id=${acme}&from=2026-03-01&to=2026-03-31` });
    expect(curly.statusCode).toBe(200);
    expect(curly.headers['content-disposition']).toBe(
      `inline; filename="Statement O'Brien's Garage - East.pdf"; filename*=UTF-8''Statement%20O%E2%80%99Brien%E2%80%99s%20Garage%20%E2%80%94%20East.pdf`,
    );
    expect((await app.inject({ method: 'GET', url: '/api/statements?customer_id=1&from=2026-03-01&to=bad' })).statusCode).toBe(400);
  });

  it('round-trips e-mail through an injected transport', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const app = buildApp(db, { mailer: () => ({ transport, from: 'office@example.test', bccSelf: false }) });
    const id = invoice([L(mach, 1, 6500)], { num: '55', to_email: true }).id;
    const d = (await app.inject({ method: 'GET', url: `/api/email/defaults/${id}` })).json();
    expect(d).toMatchObject({ to: 'ap@acme.example', subject: 'Invoice 55 from ', attachment_name: 'Invoice 55.pdf' });
    const send = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/email/send', payload: { txn_id: id, to: d.to, subject: d.subject, body: d.body } });
    expect(send.statusCode).toBe(200);
    expect(send.json().ok).toBe(true);
    const batch = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/email/batch', payload: { txn_ids: [id] } });
    expect(batch.json()).toEqual([{ txn_id: id, num: '55', ok: true, error: null }]);
    const tpl = (await app.inject({ method: 'GET', url: '/api/email/templates' })).json();
    expect(tpl.invoice_subject).toBe('Invoice {num} from {company}');
    await app.inject({ method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/email/templates', payload: { ...tpl, invoice_subject: 'Inv {num} - {customer}' } });
    expect((await app.inject({ method: 'GET', url: `/api/email/defaults/${id}` })).json().subject).toBe('Inv 55 - Acme');
    expect((await app.inject({ method: 'GET', url: '/api/email/status' })).statusCode).toBe(200);
  });
});
