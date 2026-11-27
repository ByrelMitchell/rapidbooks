import {
  dueDate,
  formatUsDate,
  lineAmount,
  type BillCreditInput,
  type BillInput,
  type BillPaymentInput,
  type CheckInput,
  type ExpenseLine,
  type ExpenseLineInput,
  type ItemLine,
  type ItemLineInput,
  type PayLine,
  type PaycheckInput,
  type PaycheckTotals,
  type PayrollItemKind,
  type PurchaseOrderInput,
  type PurchLink,
  type PurchTxn,
  type TransferInput,
  type Txn,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { accountRow, appliedFrom, appliedTo, cap, fullName, money, nameRow, systemAccount, txnRow, type NameRow, type TxnHeaderRow } from './common';
import { blankHeader, type Built, type BuiltLink, type BuiltSplit, type Old, type StoredLine } from './posting';

// Builders for purchases and banking: purchase orders, bills, bill credits, bill
// payments, checks, transfers and paychecks. Like the Phase 3 builders in posting.ts,
// they only compute splits, header fields, lines and links; saveTxn writes them.

/** Purchase and banking transaction types (GET /api/txns/:id returns a PurchTxn for these). */
export const PURCH_TYPES = new Set(['PURCHORD', 'BILL', 'BILLCREDIT', 'BILLPMT', 'CHECK', 'TRANSFER', 'PAYCHECK']);

/** Types that are checks drawn on a bank account; they share one number sequence per account. */
export const CHECK_TYPES: string[] = ['CHECK', 'BILLPMT', 'PAYCHECK'];

// ---------------------------------------------------------------------------
// Lookups and messages

/** "bill 4471 from Steel Supply", or "the bill of 01/10/2026 from Steel Supply". */
export function billName(db: DB, t: { type: string; num: string; date: string; name_id: number | null }): string {
  const what = t.type === 'BILLCREDIT' ? 'credit' : t.type === 'BILLPMT' ? 'bill payment' : 'bill';
  const from = t.name_id !== null ? ` from ${fullName(db, t.name_id)}` : '';
  return t.num ? `${what} ${t.num}${from}` : `the ${what} of ${formatUsDate(t.date)}${from}`;
}

export function requireVendor(db: DB, id: number | null): NameRow {
  if (id === null) throw new AppError(400, 'Choose a vendor.');
  const n = nameRow(db, id);
  if (!n) throw new AppError(400, 'That vendor no longer exists.');
  if (n.kind !== 'vendor') throw new AppError(400, `${n.name} is not a vendor. Choose a vendor.`);
  return n;
}

function apAccount(db: DB, id: number | null): number {
  if (id === null) return systemAccount(db, 'AP');
  const a = accountRow(db, id);
  if (!a) throw new AppError(400, 'That Accounts Payable account no longer exists.');
  if (a.type !== 'AP') throw new AppError(400, `${a.name} is not an Accounts Payable account.`);
  return id;
}

/** The account a check, bill payment or paycheck is drawn on. */
function bankAccount(db: DB, id: number | null, what: string, allowCreditCard = false): number {
  if (id === null) throw new AppError(400, `Choose the bank account for the ${what}.`);
  const a = accountRow(db, id);
  if (!a) throw new AppError(400, `The bank account for the ${what} no longer exists.`);
  if (a.type !== 'BANK' && !(allowCreditCard && a.type === 'CC')) {
    throw new AppError(400, `${a.name} is not a bank account${allowCreditCard ? ' or credit card account' : ''}. Choose the account to pay from.`);
  }
  return id;
}

/** A Customer:Job on a line, if any. */
function lineCustomer(db: DB, id: number | null, where: string): number | null {
  if (id === null) return null;
  const n = nameRow(db, id);
  if (!n) throw new AppError(400, `The customer:job on ${where} no longer exists.`);
  if (n.kind !== 'customer') throw new AppError(400, `${n.name} on ${where} is not a customer or job.`);
  return id;
}

const PURCHASABLE = new Set(['SERVICE', 'PART', 'OTHER_CHARGE']);

interface PurchItemRow {
  id: number;
  name: string;
  type: string;
  purchase_account_id: number | null;
}

/**
 * Item lines: each amount (qty × cost unless given) and, when `posting`, the item's
 * purchase account. Blank rows (no item, no description, no amount) are dropped.
 */
function computeItemLines(db: DB, lines: ItemLineInput[], posting: boolean, receiving: Set<number> = new Set()): StoredLine[] {
  const getItem = db.prepare('SELECT id, name, type, purchase_account_id FROM items WHERE id = ?');
  const poLine = db.prepare('SELECT item_id FROM lines WHERE txn_id = ? AND seq = ?');
  const out: StoredLine[] = [];
  lines.forEach((l, i) => {
    const where = `item line ${i + 1}`;
    const amount = l.amount ?? (l.rate !== null ? lineAmount(l.qty, l.rate) : 0);
    const base: StoredLine = {
      item_id: l.item_id,
      description: l.description,
      qty: l.qty,
      rate: l.rate,
      rate_is_percent: false,
      amount,
      account_id: null,
      name_id: lineCustomer(db, l.name_id, where),
      ref_no: '',
      pay_method: '',
    };
    if (l.item_id === null) {
      if (amount !== 0) throw new AppError(400, `Item line ${i + 1} has an amount but no item. Choose an item for it.`);
      if (l.description.trim() === '' && l.name_id === null) return; // a blank row
      out.push({ ...base, qty: null, rate: null, amount: 0 });
      return;
    }
    const item = getItem.get(l.item_id) as PurchItemRow | undefined;
    if (!item) throw new AppError(400, `The item on ${where} no longer exists.`);
    if (!PURCHASABLE.has(item.type)) {
      throw new AppError(400, `${item.name} is a ${item.type === 'GROUP' ? 'group' : item.type.toLowerCase()} item and cannot be used on purchase forms. Use service, non-inventory part or other charge items.`);
    }
    if (posting) {
      if (item.purchase_account_id === null) {
        throw new AppError(400, `${item.name} has no purchase account. Edit the item and choose the expense or cost of goods sold account its purchases post to.`);
      }
      base.account_id = item.purchase_account_id;
    }
    // A bill line receiving a purchase order line: kept only while it is still that P.O.'s
    // line for the same item (she may have changed the item since copying it).
    if (l.po_txn_id !== null && l.po_seq !== null && receiving.has(l.po_txn_id)) {
      const ordered = poLine.get(l.po_txn_id, l.po_seq) as { item_id: number | null } | undefined;
      if (ordered && ordered.item_id === l.item_id) {
        base.po_txn_id = l.po_txn_id;
        base.po_seq = l.po_seq;
      }
    }
    out.push(base);
  });
  return out;
}

/** Expense lines; blank rows (no account and no amount) are dropped. */
function computeExpenseLines(db: DB, lines: ExpenseLineInput[]): StoredLine[] {
  const out: StoredLine[] = [];
  lines.forEach((l, i) => {
    if (l.account_id === null && l.amount === 0) return;
    if (l.account_id === null) throw new AppError(400, `Choose an account for expense line ${i + 1}.`);
    const a = accountRow(db, l.account_id);
    if (!a) throw new AppError(400, `The account on expense line ${i + 1} no longer exists.`);
    if (a.type === 'AR' || a.type === 'AP') {
      throw new AppError(400, `Expense line ${i + 1} cannot post to an Accounts Receivable or Accounts Payable account. Use Receive Payments or Pay Bills instead.`);
    }
    out.push({
      item_id: null,
      description: l.memo,
      qty: null,
      rate: null,
      rate_is_percent: false,
      amount: l.amount,
      account_id: l.account_id,
      name_id: lineCustomer(db, l.name_id, `expense line ${i + 1}`),
      ref_no: '',
      pay_method: '',
    });
  });
  return out;
}

/** One split per posting line: sign = +1 debits the lines (bill, check), -1 credits them. */
function lineSplits(lines: StoredLine[], sign: number, payee: number | null): BuiltSplit[] {
  return lines
    .filter((l) => l.account_id !== null)
    .map((l) => ({ account_id: l.account_id!, amount: sign * l.amount, name_id: l.name_id ?? payee, memo: l.description }));
}

const sumOf = (lines: StoredLine[]) => lines.reduce((t, l) => t + l.amount, 0);

// ---------------------------------------------------------------------------
// PURCHORD

export function buildPurchaseOrder(db: DB, input: PurchaseOrderInput, old: Old): Built {
  const vendor = requireVendor(db, input.name_id);
  const lines = computeItemLines(db, input.lines, false);
  if (old) {
    // Bill lines point at the P.O. lines they received by position: those lines must stay put.
    for (const r of poLineReceipts(db, old.id)) {
      if (r.received_qty === 0 && r.received_amount === 0) continue;
      const now = lines[r.seq];
      if (!now || now.item_id !== r.item_id) {
        const item = r.item_id !== null ? (db.prepare('SELECT name FROM items WHERE id = ?').get(r.item_id) as { name: string } | undefined)?.name : null;
        throw new AppError(
          400,
          `Line ${r.seq + 1}${item ? ` (${item})` : ''} has been received on a bill, so it cannot be removed, moved or changed to another item.`,
        );
      }
    }
    if (old.name_id !== vendor.id && db.prepare("SELECT 1 FROM links WHERE kind = 'po' AND to_txn = ?").get(old.id)) {
      throw new AppError(400, 'This purchase order has been received on a bill, so it cannot be moved to another vendor.');
    }
  }
  const total = sumOf(lines);
  if (total < 0) throw new AppError(400, 'The total of a purchase order cannot be negative.');
  const header = blankHeader(input);
  Object.assign(header, {
    name_id: vendor.id,
    bill_addr: input.address,
    ship_addr: input.ship_addr,
    expected_date: input.expected_date,
    message: input.message,
    closed: input.closed ? 1 : 0,
    to_print: input.to_print ? 1 : 0,
    total,
  });
  // Received on bills: received in full closes it (she may have ordered fewer); a P.O. closed
  // because it was received in full opens again when more is ordered, unless she says otherwise.
  const wasFull = old ? poReceived(db, old.id).full : false;
  const afterSave = (id: number) => {
    if (!db.prepare("SELECT 1 FROM links WHERE kind = 'po' AND to_txn = ?").get(id)) return;
    const now = poReceived(db, id).full;
    const keptBox = !!old && input.closed === !!old.closed;
    const closed = now ? 1 : wasFull && keptBox ? 0 : input.closed ? 1 : 0;
    db.prepare('UPDATE txns SET closed = ? WHERE id = ?').run(closed, id);
  };
  // Non-posting: no splits at all.
  return { splits: [], header, lines, minSplits: 0, afterSave };
}

// ---------------------------------------------------------------------------
// Receiving purchase orders

interface PoLineReceipt {
  seq: number;
  item_id: number | null;
  qty: number | null;
  rate: number | null;
  amount: number;
  received_qty: number;
  received_amount: number;
}

/** Each line of a purchase order, with how much the bills' lines pointing at it have received. */
export function poLineReceipts(db: DB, poId: number): PoLineReceipt[] {
  return db
    .prepare(
      `SELECT l.seq, l.item_id, l.qty, l.rate, l.amount,
              COALESCE(SUM(COALESCE(b.qty, 0)), 0) AS received_qty, COALESCE(SUM(b.amount), 0) AS received_amount
         FROM lines l LEFT JOIN lines b ON b.po_txn_id = l.txn_id AND b.po_seq = l.seq
        WHERE l.txn_id = ?
        GROUP BY l.id ORDER BY l.seq`,
    )
    .all(poId) as PoLineReceipt[];
}

/** A line is received in full when its quantity is (or, without a quantity, its amount). Text lines need nothing. */
const lineDone = (l: PoLineReceipt) =>
  l.item_id === null || (l.qty !== null && l.qty > 0 ? l.received_qty >= l.qty - 1e-9 : l.received_amount >= l.amount);

/** The amount of a line not yet received. */
function lineRemaining(l: PoLineReceipt): number {
  if (lineDone(l)) return 0;
  if (l.qty !== null && l.qty > 0) return Math.round((l.amount * (l.qty - l.received_qty)) / l.qty);
  return l.amount - l.received_amount;
}

/**
 * What bills have received of a purchase order: in full or not, the amount received, and the
 * amount still to come. A P.O. on a bill whose lines point at none of its lines (bills made
 * before lines were received one by one) counts as received in full, as it did then.
 */
export function poReceived(db: DB, poId: number): { full: boolean; amount: number; remaining: number } {
  const po = txnRow(db, poId);
  if (!po) return { full: false, amount: 0, remaining: 0 };
  const linked = db.prepare("SELECT 1 FROM links WHERE kind = 'po' AND to_txn = ?").get(poId);
  if (!linked) return { full: false, amount: 0, remaining: po.total };
  if (!db.prepare('SELECT 1 FROM lines WHERE po_txn_id = ? LIMIT 1').get(poId)) return { full: true, amount: po.total, remaining: 0 };
  const lines = poLineReceipts(db, poId);
  return {
    full: lines.every(lineDone),
    amount: lines.reduce((t, l) => t + l.received_amount, 0),
    remaining: lines.reduce((t, l) => t + lineRemaining(l), 0),
  };
}

/** The amount received of each purchase order, before a change to the bills receiving them. */
export function poReceiptSnapshot(db: DB, ids: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const id of ids) if (!out.has(id)) out.set(id, poReceived(db, id).amount);
  return out;
}

/**
 * After bills receiving these purchase orders changed: a P.O. now received in full closes; one
 * that received less than before (a bill edited or deleted) and is no longer in full reopens.
 * One she closed by hand stays closed while nothing it received is taken away.
 */
export function settlePurchaseOrders(db: DB, before: Map<number, number>) {
  for (const [id, was] of before) {
    const po = txnRow(db, id);
    if (!po || po.type !== 'PURCHORD') continue;
    const now = poReceived(db, id);
    if (now.full && !po.closed) db.prepare('UPDATE txns SET closed = 1, version = version + 1 WHERE id = ?').run(id);
    else if (!now.full && po.closed && now.amount < was) db.prepare('UPDATE txns SET closed = 0, version = version + 1 WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------------------
// BILL and BILLCREDIT

export function buildBill(db: DB, input: BillInput | BillCreditInput, old: Old): Built {
  const isBill = input.type === 'BILL';
  const vendor = requireVendor(db, input.name_id);
  const ap = apAccount(db, input.ap_account_id);

  let terms: { net_days: number } | null = null;
  if (input.terms_id !== null) {
    terms = db.prepare('SELECT net_days FROM terms WHERE id = ?').get(input.terms_id) as { net_days: number } | null;
    if (!terms) throw new AppError(400, 'Those terms no longer exist.');
  }

  const receiving = new Set(input.type === 'BILL' ? input.po_ids : []);
  const lines = [...computeExpenseLines(db, input.expenses), ...computeItemLines(db, input.items, true, receiving)];
  if (lines.length === 0) throw new AppError(400, 'Enter at least one expense or item line.');
  const total = sumOf(lines);
  if (total < 0) {
    throw new AppError(
      400,
      isBill ? 'The total of a bill cannot be negative. To record a vendor credit, use a bill credit.' : 'The total of a bill credit cannot be negative.',
    );
  }

  if (old) {
    // Keep what is already applied valid.
    const linked = db
      .prepare(
        `SELECT f.name_id AS from_name, t.name_id AS to_name FROM links l JOIN txns f ON f.id = l.from_txn JOIN txns t ON t.id = l.to_txn
          WHERE l.kind = 'apply' AND (l.to_txn = ? OR l.from_txn = ?)`,
      )
      .all(old.id, old.id) as { from_name: number; to_name: number }[];
    if (linked.length > 0) {
      const what = isBill ? 'bill' : 'bill credit';
      const applied = isBill ? appliedTo(db, old.id) : appliedFrom(db, old.id);
      if (total < applied) {
        throw new AppError(
          400,
          isBill
            ? `Payments and credits of ${money(applied)} have been applied to this bill, so its total cannot be less than that. Remove some of them first (in Pay Bills).`
            : `${money(applied)} of this bill credit has been applied to bills, so its total cannot be less than that.`,
        );
      }
      if (ap !== old.ap_account_id) {
        throw new AppError(400, `Payments or credits have been applied to this ${what}, so its Accounts Payable account cannot be changed.`);
      }
      if (vendor.id !== old.name_id) {
        throw new AppError(400, `Payments or credits have been applied to this ${what}, so it cannot be moved to another vendor.`);
      }
    }
  }

  // Purchase orders received on this bill.
  const poLinks: BuiltLink[] = [];
  const oldPos =
    old && isBill
      ? (db.prepare("SELECT to_txn FROM links WHERE kind = 'po' AND from_txn = ?").all(old.id) as { to_txn: number }[]).map((r) => r.to_txn)
      : [];
  if (isBill) {
    const seen = new Set<number>();
    for (const id of input.po_ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const po = txnRow(db, id);
      if (!po || po.type !== 'PURCHORD') throw new AppError(400, 'One of the purchase orders on this bill no longer exists.');
      const poName = po.num ? `Purchase order ${po.num}` : `The purchase order of ${formatUsDate(po.date)}`;
      if (po.name_id !== vendor.id) {
        throw new AppError(400, `${poName} is for ${fullName(db, po.name_id)}, so it cannot be received on a bill from ${fullName(db, vendor.id)}.`);
      }
      if (po.closed && !oldPos.includes(id)) throw new AppError(400, `${poName} is already closed.`);
      // The amount received from it on this bill; all of it when no line says which P.O. line it is.
      const mine = lines.filter((l) => l.po_txn_id === id);
      poLinks.push({ to_txn: id, amount: mine.length > 0 ? sumOf(mine) : po.total, discount: 0, discount_account_id: null });
    }
  }

  const header = blankHeader({ ...input, num: input.ref_no });
  Object.assign(header, {
    name_id: vendor.id,
    ref_no: input.ref_no,
    terms_id: input.terms_id,
    due_date: isBill ? input.due_date || dueDate(terms, input.date) : '',
    bill_addr: input.address,
    ap_account_id: ap,
    total,
  });

  // Bill: Cr A/P, Dr each line's account. Bill credit: the mirror image.
  const sign = isBill ? 1 : -1;
  const splits: BuiltSplit[] = [
    { account_id: ap, amount: -sign * total, name_id: vendor.id, memo: input.memo },
    ...lineSplits(lines, sign, vendor.id),
  ];

  const built: Built = { splits, header, lines, minSplits: 1 };
  if (isBill) {
    built.links = { kind: 'po', list: poLinks };
    // What the P.O.s on it (now or before) had received, before this save changes it.
    const before = poReceiptSnapshot(db, [...oldPos, ...poLinks.map((l) => l.to_txn)]);
    built.afterSave = () => settlePurchaseOrders(db, before);
  }
  return built;
}

// ---------------------------------------------------------------------------
// BILLPMT

export function buildBillPayment(db: DB, input: BillPaymentInput, old: Old): Built {
  const vendor = requireVendor(db, input.name_id);
  if (input.amount < 0) throw new AppError(400, 'The amount of a bill payment cannot be negative.');
  const bank = bankAccount(db, input.account_id, 'bill payment', input.pay_method === 'other');
  const ap = apAccount(db, input.ap_account_id);

  const seen = new Set<number>();
  const links: BuiltLink[] = [];
  let applied = 0;
  for (const a of input.applications) {
    if (a.amount === 0 && a.discount === 0) continue;
    if (seen.has(a.txn_id)) throw new AppError(400, 'The same bill is listed twice in the payment.');
    seen.add(a.txn_id);
    const bill = txnRow(db, a.txn_id);
    if (!bill) throw new AppError(400, 'One of the bills this payment is for no longer exists.');
    if (bill.type !== 'BILL') throw new AppError(400, 'A bill payment can only pay bills.');
    if (bill.name_id !== vendor.id) {
      throw new AppError(400, `${cap(billName(db, bill))} is not from ${fullName(db, vendor.id)}, so this payment cannot pay it.`);
    }
    if (bill.ap_account_id !== ap) {
      throw new AppError(400, `${cap(billName(db, bill))} is in a different Accounts Payable account than this payment.`);
    }
    const open = bill.total - appliedTo(db, bill.id, old?.id ?? null);
    if (a.amount + a.discount > open) {
      throw new AppError(
        400,
        `The ${a.discount > 0 ? 'payment and discount' : 'payment'} for ${billName(db, bill)} (${money(a.amount + a.discount)}) is more than its open balance of ${money(open)}.`,
      );
    }
    if (a.discount > 0) {
      if (a.discount_account_id === null) throw new AppError(400, `Choose the account for the discount on ${billName(db, bill)}.`);
      const da = accountRow(db, a.discount_account_id);
      if (!da) throw new AppError(400, 'The discount account no longer exists.');
      if (da.type === 'AR' || da.type === 'AP') {
        throw new AppError(400, 'A discount cannot be posted to an Accounts Receivable or Accounts Payable account.');
      }
    }
    applied += a.amount;
    links.push({ to_txn: bill.id, amount: a.amount, discount: a.discount, discount_account_id: a.discount > 0 ? a.discount_account_id : null });
  }
  if (applied > input.amount) {
    throw new AppError(400, `You applied ${money(applied)} to bills, but the payment is only ${money(input.amount)}.`);
  }

  const header = blankHeader({ ...input, num: input.to_print ? '' : input.num });
  Object.assign(header, {
    name_id: vendor.id,
    to_print: input.to_print ? 1 : 0,
    pay_method: input.pay_method,
    bill_addr: input.address,
    account_id: bank,
    ap_account_id: ap,
    total: input.amount,
  });

  // Dr A/P, Cr bank; each discount: Dr A/P, Cr discount account.
  const splits: BuiltSplit[] = [
    { account_id: bank, amount: -input.amount, name_id: vendor.id, memo: input.memo },
    { account_id: ap, amount: input.amount, name_id: vendor.id, memo: input.memo },
  ];
  for (const l of links) {
    if (l.discount === 0) continue;
    const memo = `Discount on ${billName(db, txnRow(db, l.to_txn) as TxnHeaderRow).replace(/ from .*$/, '')}`;
    splits.push({ account_id: ap, amount: l.discount, name_id: vendor.id, memo });
    splits.push({ account_id: l.discount_account_id!, amount: -l.discount, name_id: vendor.id, memo });
  }
  return { splits, header, links: { kind: 'apply', list: links }, minSplits: 2 };
}

// ---------------------------------------------------------------------------
// CHECK

/** The credit memo or payment a refund check pays back (the "apply" link into it), if it is one. */
export function refundOf(db: DB, checkId: number): { credit_id: number; amount: number } | null {
  const r = db
    .prepare(
      `SELECT l.from_txn AS credit_id, l.amount FROM links l JOIN txns f ON f.id = l.from_txn
        WHERE l.kind = 'apply' AND l.to_txn = ? AND f.type IN ('CREDITMEMO', 'PAYMENT') ORDER BY l.id LIMIT 1`,
    )
    .get(checkId) as { credit_id: number; amount: number } | undefined;
  return r ?? null;
}

/**
 * Issue a Refund: a check that pays a customer back what a credit memo (or a payment not
 * applied to invoices) left them. Dr A/R for the customer, Cr the bank; the credit is applied
 * to the check, as QuickBooks does, so it is no longer available for invoices.
 */
function buildRefund(db: DB, input: CheckInput, refund: { credit_id: number; amount: number }, old: Old): Built {
  const bank = bankAccount(db, input.account_id, 'refund');
  const credit = txnRow(db, refund.credit_id);
  if (!credit || (credit.type !== 'CREDITMEMO' && credit.type !== 'PAYMENT')) {
    throw new AppError(400, 'The credit memo or payment being refunded no longer exists.');
  }
  if (credit.name_id === null || credit.ar_account_id === null) throw new AppError(400, 'That credit has no customer to refund.');
  if (old) {
    const was = refundOf(db, old.id);
    if (!was || was.credit_id !== credit.id) throw new AppError(400, 'This check cannot be made into a refund of another credit. Delete it and issue a new refund.');
  }
  if (input.expenses.some((e) => e.account_id !== null || e.amount !== 0) || input.items.some((l) => l.item_id !== null)) {
    throw new AppError(400, 'A refund check has no expense or item lines.');
  }
  const what = credit.type === 'PAYMENT' ? 'payment' : 'credit memo';
  const mine = old ? (refundOf(db, old.id)?.amount ?? 0) : 0;
  const available = credit.total - appliedFrom(db, credit.id) + mine;
  if (refund.amount <= 0) throw new AppError(400, 'Enter the amount to refund.');
  if (refund.amount > available) {
    throw new AppError(400, `Only ${money(available)} of that ${what} is left to refund.`);
  }
  const customer = credit.name_id;
  const header = blankHeader({ ...input, name_id: customer, num: input.to_print ? '' : input.num });
  Object.assign(header, {
    to_print: input.to_print ? 1 : 0,
    bill_addr: input.address,
    account_id: bank,
    ar_account_id: credit.ar_account_id,
    total: refund.amount,
  });
  const splits: BuiltSplit[] = [
    { account_id: bank, amount: -refund.amount, name_id: customer, memo: input.memo },
    { account_id: credit.ar_account_id, amount: refund.amount, name_id: customer, memo: input.memo },
  ];
  return {
    splits,
    header,
    lines: [],
    minSplits: 2,
    afterSave: (txnId) => {
      // The credit is applied to the refund (the link runs from the credit, like any application).
      db.prepare("DELETE FROM links WHERE kind = 'apply' AND to_txn = ?").run(txnId);
      db.prepare("INSERT INTO links (from_txn, to_txn, kind, amount) VALUES (?, ?, 'apply', ?)").run(credit.id, txnId, refund.amount);
      // The credit's own form now shows a different amount left.
      db.prepare('UPDATE txns SET version = version + 1 WHERE id = ?').run(credit.id);
    },
  };
}

export function buildCheck(db: DB, input: CheckInput, old: Old): Built {
  if (input.refund) return buildRefund(db, input, input.refund, old);
  if (old && refundOf(db, old.id)) {
    throw new AppError(400, 'This check is a refund of a customer credit. Open it from the credit memo (or the register) to change it.');
  }
  const bank = bankAccount(db, input.account_id, 'check');
  if (input.name_id !== null && !nameRow(db, input.name_id)) throw new AppError(400, 'The payee no longer exists.');
  const lines = [...computeExpenseLines(db, input.expenses), ...computeItemLines(db, input.items, true)];
  if (lines.length === 0) throw new AppError(400, 'Enter at least one expense or item line.');
  const total = sumOf(lines);
  if (total < 0) throw new AppError(400, 'The amount of a check cannot be negative. To record money coming in, use a deposit.');

  const header = blankHeader({ ...input, num: input.to_print ? '' : input.num });
  Object.assign(header, {
    to_print: input.to_print ? 1 : 0,
    bill_addr: input.address,
    account_id: bank,
    total,
  });
  // Cr bank, Dr each line's account.
  const splits: BuiltSplit[] = [
    { account_id: bank, amount: -total, name_id: input.name_id, memo: input.memo },
    ...lineSplits(lines, 1, input.name_id),
  ];
  return { splits, header, lines, minSplits: 2 };
}

// ---------------------------------------------------------------------------
// TRANSFER

export function buildTransfer(db: DB, input: TransferInput, _old: Old): Built {
  if (input.from_account_id === null) throw new AppError(400, 'Choose the account to transfer funds from.');
  if (input.to_account_id === null) throw new AppError(400, 'Choose the account to transfer funds to.');
  if (input.from_account_id === input.to_account_id) throw new AppError(400, 'Choose two different accounts to transfer between.');
  for (const [id, dir] of [[input.from_account_id, 'from'], [input.to_account_id, 'to']] as const) {
    const a = accountRow(db, id);
    if (!a) throw new AppError(400, `The account to transfer ${dir} no longer exists.`);
    if (a.type === 'AR' || a.type === 'AP') {
      throw new AppError(400, 'Funds cannot be transferred to or from an Accounts Receivable or Accounts Payable account.');
    }
    if (['INC', 'COGS', 'EXP', 'OINC', 'OEXP'].includes(a.type)) {
      throw new AppError(400, `${a.name} is an income or expense account. Transfer Funds moves money between balance sheet accounts such as bank accounts.`);
    }
  }
  if (input.amount <= 0) throw new AppError(400, 'Enter the amount to transfer.');
  const header = blankHeader({ ...input, name_id: null });
  Object.assign(header, { account_id: input.from_account_id, to_account_id: input.to_account_id, total: input.amount });
  // Dr to, Cr from.
  const splits: BuiltSplit[] = [
    { account_id: input.from_account_id, amount: -input.amount, name_id: null, memo: input.memo },
    { account_id: input.to_account_id, amount: input.amount, name_id: null, memo: input.memo },
  ];
  return { splits, header, minSplits: 2 };
}

// ---------------------------------------------------------------------------
// PAYCHECK

interface PayrollItemRow {
  id: number;
  name: string;
  kind: PayrollItemKind;
  expense_account_id: number | null;
  liability_account_id: number | null;
}

export function buildPaycheck(db: DB, input: PaycheckInput, _old: Old): Built {
  if (input.name_id === null) throw new AppError(400, 'Choose an employee.');
  const emp = nameRow(db, input.name_id);
  if (!emp) throw new AppError(400, 'That employee no longer exists.');
  if (emp.kind !== 'employee') throw new AppError(400, `${emp.name} is not an employee. Choose an employee.`);
  const bank = bankAccount(db, input.account_id, 'paycheck');
  if (input.lines.length === 0) throw new AppError(400, 'Enter at least one earnings line.');

  const getItem = db.prepare('SELECT id, name, kind, expense_account_id, liability_account_id FROM payroll_items WHERE id = ?');
  const lines: StoredLine[] = [];
  const posting: BuiltSplit[] = [];
  const totals = { earning: 0, deduction: 0, company: 0 };
  input.lines.forEach((l, i) => {
    const p = getItem.get(l.payroll_item_id) as PayrollItemRow | undefined;
    if (!p) throw new AppError(400, `The payroll item on line ${i + 1} no longer exists.`);
    const amount = l.amount ?? (l.hours !== null && l.rate !== null ? lineAmount(l.hours, l.rate) : 0);
    const needs = (id: number | null, what: string) => {
      if (id === null) throw new AppError(400, `The payroll item ${p.name} has no ${what} account. Edit it in the Payroll Item list.`);
      return id;
    };
    totals[p.kind] += amount;
    const memo = p.name;
    if (amount !== 0) {
      if (p.kind === 'earning') posting.push({ account_id: needs(p.expense_account_id, 'expense'), amount, name_id: emp.id, memo });
      else if (p.kind === 'deduction') posting.push({ account_id: needs(p.liability_account_id, 'liability'), amount: -amount, name_id: emp.id, memo });
      else {
        posting.push({ account_id: needs(p.expense_account_id, 'expense'), amount, name_id: emp.id, memo });
        posting.push({ account_id: needs(p.liability_account_id, 'liability'), amount: -amount, name_id: emp.id, memo });
      }
    }
    lines.push({
      item_id: null,
      description: '',
      qty: l.hours,
      rate: l.rate,
      rate_is_percent: false,
      amount,
      account_id: null,
      name_id: null,
      ref_no: '',
      pay_method: '',
      payroll_item_id: p.id,
    });
  });

  const net = totals.earning - totals.deduction;
  if (net < 0) {
    throw new AppError(400, `Net pay cannot be negative: deductions of ${money(totals.deduction)} are more than earnings of ${money(totals.earning)}.`);
  }

  const header = blankHeader({ ...input, num: input.to_print ? '' : input.num });
  Object.assign(header, {
    name_id: emp.id,
    to_print: input.to_print ? 1 : 0,
    bill_addr: input.address,
    account_id: bank,
    period_from: input.period_from,
    period_to: input.period_to,
    total: net,
  });
  // Cr bank for net pay; then each line's postings.
  const splits: BuiltSplit[] = [{ account_id: bank, amount: -net, name_id: emp.id, memo: input.memo }, ...posting];
  return { splits, header, lines, minSplits: 1 };
}

// ---------------------------------------------------------------------------
// Reading back

interface LineRow {
  id: number;
  seq: number;
  item_id: number | null;
  description: string;
  qty: number | null;
  rate: number | null;
  amount: number;
  account_id: number | null;
  name_id: number | null;
  payroll_item_id: number | null;
  po_txn_id: number | null;
  po_seq: number | null;
  p_name: string | null;
  p_kind: PayrollItemKind | null;
}

function purchLinks(db: DB, id: number, dir: 'out' | 'in'): PurchLink[] {
  const [mine, other] = dir === 'out' ? ['from_txn', 'to_txn'] : ['to_txn', 'from_txn'];
  return db
    .prepare(
      `SELECT l.id, l.kind, o.id AS txn_id, o.type, o.num, o.date, o.name_id, l.amount, l.discount, l.discount_account_id
         FROM links l JOIN txns o ON o.id = l.${other}
        WHERE l.${mine} = ?
        ORDER BY o.date, o.id`,
    )
    .all(id) as PurchLink[];
}

export function paycheckTotals(lines: { kind: PayrollItemKind; amount: number }[]): PaycheckTotals {
  const sum = (k: PayrollItemKind) => lines.filter((l) => l.kind === k).reduce((t, l) => t + l.amount, 0);
  const earnings = sum('earning');
  const deductions = sum('deduction');
  return { earnings, deductions, company: sum('company'), net: earnings - deductions };
}

export function getPurchTxn(db: DB, row: TxnHeaderRow, base: Txn): PurchTxn {
  const id = row.id;
  const rows = db
    .prepare(
      `SELECT l.id, l.seq, l.item_id, l.description, l.qty, l.rate, l.amount, l.account_id, l.name_id, l.payroll_item_id,
              l.po_txn_id, l.po_seq, p.name AS p_name, p.kind AS p_kind
         FROM lines l LEFT JOIN payroll_items p ON p.id = l.payroll_item_id
        WHERE l.txn_id = ? ORDER BY l.seq`,
    )
    .all(id) as LineRow[];
  const expenses: ExpenseLine[] = [];
  const items: ItemLine[] = [];
  const pay_lines: PayLine[] = [];
  const receipts = row.type === 'PURCHORD' ? new Map(poLineReceipts(db, id).map((l) => [l.seq, l])) : null;
  for (const r of rows) {
    if (r.payroll_item_id !== null) {
      pay_lines.push({ id: r.id, seq: r.seq, payroll_item_id: r.payroll_item_id, name: r.p_name ?? '', kind: r.p_kind!, hours: r.qty, rate: r.rate, amount: r.amount });
    } else if (r.item_id === null && r.account_id !== null) {
      expenses.push({ id: r.id, seq: r.seq, account_id: r.account_id, amount: r.amount, memo: r.description, name_id: r.name_id });
    } else {
      items.push({
        id: r.id, seq: r.seq, item_id: r.item_id, description: r.description, qty: r.qty, rate: r.rate, amount: r.amount,
        name_id: r.name_id, account_id: r.account_id, po_txn_id: r.po_txn_id, po_seq: r.po_seq,
        received_qty: receipts ? receipts.get(r.seq)?.received_qty ?? 0 : null,
        received_amount: receipts?.get(r.seq)?.received_amount ?? 0,
      });
    }
  }
  const links_out = purchLinks(db, id, 'out');
  const links_in = purchLinks(db, id, 'in');
  const t = row.type as PurchTxn['type'];
  return {
    ...base,
    type: t,
    account_id: row.account_id,
    to_account_id: row.to_account_id,
    ap_account_id: row.ap_account_id,
    terms_id: row.terms_id,
    due_date: row.due_date,
    ref_no: row.ref_no,
    address: row.bill_addr,
    ship_addr: row.ship_addr,
    expected_date: row.expected_date,
    message: row.message,
    closed: !!row.closed,
    to_print: !!row.to_print,
    pay_method: (row.pay_method === 'check' || row.pay_method === 'other' ? row.pay_method : '') as PurchTxn['pay_method'],
    period_from: row.period_from,
    period_to: row.period_to,
    expenses,
    items,
    pay_lines,
    links_out,
    links_in,
    total: row.total,
    open_balance: t === 'BILL' ? row.total - appliedTo(db, id) : null,
    unapplied: t === 'BILLCREDIT' || t === 'BILLPMT' ? row.total - appliedFrom(db, id) : null,
    po_ids: t === 'BILL' ? links_out.filter((l) => l.kind === 'po').map((l) => l.txn_id) : [],
    bill_ids: t === 'PURCHORD' ? links_in.filter((l) => l.kind === 'po').map((l) => l.txn_id) : [],
    paycheck: t === 'PAYCHECK' ? paycheckTotals(pay_lines) : null,
    refund: t === 'CHECK' ? refundOf(db, id) : null,
  };
}
