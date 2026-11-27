import {
  dueDate,
  formatUsDate,
  lineAmount,
  percentOf,
  type AnyTxn,
  type BillPaymentInput,
  type CreditMemoInput,
  type DepositInput,
  type DocTxn,
  type GenJrnlInput,
  type InvoiceInput,
  type LineInput,
  type PaymentInput,
  type RegisterRow,
  type Split,
  type Txn,
  type TxnInput,
  type TxnLine,
  type TxnLink,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import {
  accountRow,
  appliedFrom,
  appliedTo,
  canPay,
  cap,
  invName,
  depositOf,
  fullName,
  money,
  requireCustomer,
  systemAccount,
  txnRow,
  type TxnHeaderRow,
} from './common';
import {
  buildBill,
  buildBillPayment,
  buildCheck,
  buildPaycheck,
  buildPurchaseOrder,
  buildTransfer,
  CHECK_TYPES,
  getPurchTxn,
  PURCH_TYPES,
  reopenPurchaseOrders,
} from './purchasing';

// The posting engine. Every transaction type has a builder that turns the form's
// input into ledger splits (plus, for documents, the header fields, lines and links
// to store); saveTxn checks they balance and writes them. Nothing else writes to the
// splits table.

export interface BuiltSplit {
  account_id: number;
  amount: number; // cents, debit-positive
  name_id: number | null;
  memo: string;
}

/** Columns of txns written on every save. */
export interface Header {
  date: string;
  num: string;
  name_id: number | null;
  memo: string;
  terms_id: number | null;
  due_date: string;
  po_number: string;
  ship_date: string;
  ship_via: string;
  bill_addr: string;
  ship_addr: string;
  message: string;
  to_print: number;
  to_email: number;
  pay_method: string;
  ref_no: string;
  account_id: number | null;
  ar_account_id: number | null;
  total: number;
  ap_account_id: number | null;
  to_account_id: number | null;
  expected_date: string;
  closed: number;
  period_from: string;
  period_to: string;
}

export interface StoredLine {
  item_id: number | null;
  description: string;
  qty: number | null;
  rate: number | null;
  rate_is_percent: boolean;
  amount: number;
  account_id: number | null;
  name_id: number | null;
  ref_no: string;
  pay_method: string;
  payroll_item_id?: number | null;
}

export interface BuiltLink {
  to_txn: number;
  amount: number;
  discount: number;
  discount_account_id: number | null;
}

export interface Built {
  splits: BuiltSplit[];
  header: Header;
  lines?: StoredLine[]; // replaces the stored lines when present
  links?: { kind: 'apply' | 'deposit' | 'po'; list: BuiltLink[] }; // replaces outgoing links of that kind
  minSplits: number; // 0 for a non-posting document (purchase orders)
  /** Runs inside the save, after splits, lines and links are written (no ledger writes). */
  afterSave?: (txnId: number) => void;
}

/** The transaction being replaced, when editing. */
export type Old = TxnHeaderRow | undefined;

export const blankHeader = (input: { date: string; num: string; name_id: number | null; memo: string }): Header => ({
  date: input.date,
  num: input.num,
  name_id: input.name_id,
  memo: input.memo,
  terms_id: null,
  due_date: '',
  po_number: '',
  ship_date: '',
  ship_via: '',
  bill_addr: '',
  ship_addr: '',
  message: '',
  to_print: 0,
  to_email: 0,
  pay_method: '',
  ref_no: '',
  account_id: null,
  ar_account_id: null,
  total: 0,
  ap_account_id: null,
  to_account_id: null,
  expected_date: '',
  closed: 0,
  period_from: '',
  period_to: '',
});

// ---------------------------------------------------------------------------
// GENJRNL

function buildJournal(_db: DB, input: GenJrnlInput): Built {
  const splits = input.splits.map((s) => ({ ...s }));
  const header = blankHeader(input);
  header.total = splits.reduce((t, s) => t + (s.amount > 0 ? s.amount : 0), 0);
  return { splits, header, minSplits: 2 };
}

// ---------------------------------------------------------------------------
// INVOICE and CREDITMEMO

interface ItemInfo {
  id: number;
  name: string;
  type: string;
  account_id: number | null;
}

interface ComputedLine extends StoredLine {
  posts_to: number | null; // account credited (invoice) or debited (credit memo); null = posts nothing
}

/**
 * Work out each line's amount and where it posts:
 *  - item line: qty × rate (rounded half away from zero) unless an amount is given;
 *  - SUBTOTAL: the sum of the lines above it back to the previous subtotal;
 *  - percent DISCOUNT / OTHER_CHARGE: that percentage of the line just above (or of
 *    that subtotal); discounts are always negative;
 *  - description-only line: nothing.
 */
export function computeLines(db: DB, lines: LineInput[]): ComputedLine[] {
  const getItem = db.prepare('SELECT id, name, type, account_id FROM items WHERE id = ?');
  const out: ComputedLine[] = [];
  let sinceSubtotal = 0;

  lines.forEach((l, i) => {
    const n = i + 1;
    const base: StoredLine = {
      item_id: l.item_id,
      description: l.description,
      qty: l.qty,
      rate: l.rate,
      rate_is_percent: l.rate_is_percent,
      amount: 0,
      account_id: null,
      name_id: null,
      ref_no: '',
      pay_method: '',
    };
    let posts_to: number | null = null;
    let isSubtotal = false;
    const plain = () => l.amount ?? (l.rate !== null ? lineAmount(l.qty, l.rate) : 0);

    if (l.item_id === null) {
      if (l.rate_is_percent) throw new AppError(400, `Line ${n} has a percentage but no item. Choose a discount or other charge item for it.`);
      if (l.account_id !== null) {
        const a = accountRow(db, l.account_id);
        if (!a) throw new AppError(400, `The account on line ${n} no longer exists.`);
        if (a.type === 'AR' || a.type === 'AP') {
          throw new AppError(400, `Line ${n} cannot post to an Accounts Receivable or Accounts Payable account.`);
        }
        base.account_id = l.account_id;
        base.amount = plain();
        posts_to = l.account_id;
      } else {
        if (plain() !== 0) throw new AppError(400, `Line ${n} has an amount but no item. Choose an item for it.`);
        base.qty = null;
        base.rate = null;
      }
    } else {
      const item = getItem.get(l.item_id) as ItemInfo | undefined;
      if (!item) throw new AppError(400, `The item on line ${n} no longer exists.`);
      if (item.type === 'GROUP') {
        throw new AppError(400, `${item.name} is a group item. Its items must be listed on the form instead of the group itself.`);
      }
      if (item.type === 'SUBTOTAL') {
        isSubtotal = true;
        base.qty = null;
        base.rate = null;
        base.rate_is_percent = false;
        base.amount = sinceSubtotal;
      } else if (l.rate_is_percent) {
        if (item.type !== 'DISCOUNT' && item.type !== 'OTHER_CHARGE') {
          throw new AppError(400, `${item.name} cannot be a percentage. Only discount and other charge items can.`);
        }
        const above = out.length > 0 ? out[out.length - 1].amount : 0;
        const pct = l.rate ?? 0;
        base.qty = null;
        base.amount = item.type === 'DISCOUNT' ? -percentOf(above, Math.abs(pct)) : percentOf(above, pct);
        posts_to = item.account_id;
      } else {
        base.amount = plain();
        if (item.type === 'DISCOUNT') base.amount = -Math.abs(base.amount);
        posts_to = item.account_id;
      }
      if (item.type !== 'SUBTOTAL' && posts_to === null) {
        throw new AppError(400, `${item.name} has no account to post to. Edit the item and choose one.`);
      }
    }

    if (isSubtotal) sinceSubtotal = 0;
    else sinceSubtotal += base.amount;
    out.push({ ...base, posts_to });
  });
  return out;
}

function arAccount(db: DB, id: number | null): number {
  if (id === null) return systemAccount(db, 'AR');
  const a = accountRow(db, id);
  if (!a) throw new AppError(400, 'That Accounts Receivable account no longer exists.');
  if (a.type !== 'AR') throw new AppError(400, `${a.name} is not an Accounts Receivable account.`);
  return id;
}

function buildSalesDoc(db: DB, input: InvoiceInput | CreditMemoInput, old: Old): Built {
  const isInvoice = input.type === 'INVOICE';
  const cust = requireCustomer(db, input.name_id);
  const ar = arAccount(db, input.ar_account_id);

  let terms: { net_days: number } | null = null;
  if (input.terms_id !== null) {
    terms = db.prepare('SELECT net_days FROM terms WHERE id = ?').get(input.terms_id) as { net_days: number } | null;
    if (!terms) throw new AppError(400, 'Those terms no longer exist.');
  }

  const lines = computeLines(db, input.lines);
  const posting = lines.filter((l) => l.posts_to !== null);
  const total = posting.reduce((t, l) => t + l.amount, 0);
  if (total < 0) {
    throw new AppError(
      400,
      isInvoice
        ? 'The total of an invoice cannot be negative. To give a customer credit, use a credit memo.'
        : 'The total of a credit memo cannot be negative.',
    );
  }

  if (old) {
    // Keep what is already applied valid.
    const links = db
      .prepare(
        `SELECT l.from_txn, l.to_txn, f.name_id AS from_name, t.name_id AS to_name, f.type AS from_type, f.num AS from_num
           FROM links l JOIN txns f ON f.id = l.from_txn JOIN txns t ON t.id = l.to_txn
          WHERE l.kind = 'apply' AND (l.to_txn = ? OR l.from_txn = ?)`,
      )
      .all(old.id, old.id) as { from_txn: number; to_txn: number; from_name: number; to_name: number }[];
    if (links.length > 0) {
      const applied = isInvoice ? appliedTo(db, old.id) : appliedFrom(db, old.id);
      if (total < applied) {
        throw new AppError(
          400,
          isInvoice
            ? `Payments and credits of ${money(applied)} have been applied to this invoice, so its total cannot be less than that. Remove some of them first (in Receive Payments).`
            : `${money(applied)} of this credit memo has been applied to invoices, so its total cannot be less than that. Remove some of those applications first.`,
        );
      }
      if (ar !== old.ar_account_id) {
        throw new AppError(400, `Payments or credits have been applied to this ${isInvoice ? 'invoice' : 'credit memo'}, so its Accounts Receivable account cannot be changed.`);
      }
      for (const l of links) {
        const ok = isInvoice ? canPay(db, l.from_name, cust.id) : canPay(db, cust.id, l.to_name);
        if (!ok) {
          throw new AppError(
            400,
            `Payments or credits from another customer are applied to this ${isInvoice ? 'invoice' : 'credit memo'}, so it cannot be moved to ${fullName(db, cust.id)}. Remove those applications first.`,
          );
        }
      }
    }
  }

  const header = blankHeader(input);
  Object.assign(header, {
    terms_id: input.terms_id,
    due_date: isInvoice ? input.due_date || dueDate(terms, input.date) : input.due_date,
    po_number: input.po_number,
    ship_date: input.ship_date,
    ship_via: input.ship_via,
    bill_addr: input.bill_addr,
    ship_addr: input.ship_addr,
    message: input.message,
    to_print: input.to_print ? 1 : 0,
    to_email: input.to_email ? 1 : 0,
    ar_account_id: ar,
    total,
  });

  // Invoice: Dr A/R, Cr each line's account. Credit memo: the mirror image.
  const sign = isInvoice ? 1 : -1;
  const splits: BuiltSplit[] = [{ account_id: ar, amount: sign * total, name_id: cust.id, memo: input.memo }];
  for (const l of posting) {
    splits.push({ account_id: l.posts_to!, amount: -sign * l.amount, name_id: cust.id, memo: l.description });
  }
  return { splits, header, lines: lines.map(({ posts_to: _p, ...l }) => l), minSplits: 1 };
}

// ---------------------------------------------------------------------------
// PAYMENT

function buildPayment(db: DB, input: PaymentInput, old: Old): Built {
  const cust = requireCustomer(db, input.name_id);
  // A payment of 0.00 is allowed when it only takes discounts (QuickBooks' way to write off an invoice),
  // and is kept as it is once deposited, even after its invoice is gone (see repostPayment).
  const writeOff = input.applications.some((a) => a.discount > 0) || (old !== undefined && depositOf(db, old.id) !== null);
  if (input.amount < 0 || (input.amount === 0 && !writeOff)) {
    throw new AppError(400, 'Enter the amount of the payment.');
  }
  const depositTo = input.account_id ?? systemAccount(db, 'UNDEPOSITED');
  const dep = accountRow(db, depositTo);
  if (!dep) throw new AppError(400, 'The account to deposit to no longer exists.');
  if (dep.type === 'AR' || dep.type === 'AP') {
    throw new AppError(400, 'A payment cannot be deposited to an Accounts Receivable or Accounts Payable account.');
  }
  const ar = arAccount(db, input.ar_account_id);

  if (old) {
    const deposit = depositOf(db, old.id);
    if (deposit !== null && (input.amount !== old.total || depositTo !== old.account_id || cust.id !== old.name_id)) {
      throw new AppError(
        400,
        'This payment has been deposited, so its amount, customer and deposit account cannot be changed. Remove it from the deposit first.',
      );
    }
  }

  const seen = new Set<number>();
  const links: BuiltLink[] = [];
  let applied = 0;
  for (const a of input.applications) {
    if (a.amount === 0 && a.discount === 0) continue;
    if (seen.has(a.txn_id)) throw new AppError(400, 'The same invoice is listed twice in the payment.');
    seen.add(a.txn_id);
    const inv = txnRow(db, a.txn_id);
    if (!inv) throw new AppError(400, 'One of the invoices this payment is applied to no longer exists.');
    if (inv.type !== 'INVOICE') throw new AppError(400, 'A payment can only be applied to invoices.');
    if (!canPay(db, cust.id, inv.name_id!)) {
      throw new AppError(
        400,
        `${cap(invName(inv))} is for ${fullName(db, inv.name_id)}, so a payment from ${fullName(db, cust.id)} cannot be applied to it.`,
      );
    }
    if (inv.ar_account_id !== ar) {
      throw new AppError(400, `${cap(invName(inv))} is in a different Accounts Receivable account than this payment.`);
    }
    const open = inv.total - appliedTo(db, inv.id, old?.id ?? null);
    if (a.amount + a.discount > open) {
      throw new AppError(
        400,
        `The ${a.discount > 0 ? 'payment and discount' : 'payment'} applied to ${invName(inv)} (${money(a.amount + a.discount)}) is more than its open balance of ${money(open)}.`,
      );
    }
    if (a.discount > 0) {
      if (a.discount_account_id === null) throw new AppError(400, `Choose the account for the discount on ${invName(inv)}.`);
      const da = accountRow(db, a.discount_account_id);
      if (!da) throw new AppError(400, 'The discount account no longer exists.');
      if (da.type === 'AR' || da.type === 'AP') {
        throw new AppError(400, 'A discount cannot be posted to an Accounts Receivable or Accounts Payable account.');
      }
    }
    applied += a.amount;
    links.push({
      to_txn: inv.id,
      amount: a.amount,
      discount: a.discount,
      discount_account_id: a.discount > 0 ? a.discount_account_id : null,
    });
  }
  if (applied > input.amount) {
    throw new AppError(400, `You applied ${money(applied)}, but the payment is only ${money(input.amount)}. Apply less, or raise the payment amount.`);
  }

  const header = blankHeader({ ...input, num: input.ref_no });
  Object.assign(header, {
    pay_method: input.pay_method,
    ref_no: input.ref_no,
    account_id: depositTo,
    ar_account_id: ar,
    total: input.amount,
  });

  // Dr deposit-to, Cr A/R; each discount: Dr discount account, Cr A/R.
  const splits: BuiltSplit[] = [
    { account_id: depositTo, amount: input.amount, name_id: cust.id, memo: input.memo },
    { account_id: ar, amount: -input.amount, name_id: cust.id, memo: input.memo },
  ];
  for (const l of links) {
    if (l.discount === 0) continue;
    const memo = `Discount on ${invName(txnRow(db, l.to_txn) as TxnHeaderRow)}`;
    splits.push({ account_id: l.discount_account_id!, amount: l.discount, name_id: cust.id, memo });
    splits.push({ account_id: ar, amount: -l.discount, name_id: cust.id, memo });
  }
  return { splits, header, links: { kind: 'apply', list: links }, minSplits: 2 };
}

// ---------------------------------------------------------------------------
// DEPOSIT

function buildDeposit(db: DB, input: DepositInput, old: Old): Built {
  if (input.account_id === null) throw new AppError(400, 'Choose the account to deposit to.');
  const bank = accountRow(db, input.account_id);
  if (!bank) throw new AppError(400, 'The account to deposit to no longer exists.');
  const uf = systemAccount(db, 'UNDEPOSITED');
  if (bank.id === uf) throw new AppError(400, 'Choose a bank account to deposit to, not Undeposited Funds.');
  if (bank.type === 'AR' || bank.type === 'AP') {
    throw new AppError(400, 'A deposit cannot go into an Accounts Receivable or Accounts Payable account.');
  }

  const splits: BuiltSplit[] = [];
  const links: BuiltLink[] = [];
  let total = 0;
  const seen = new Set<number>();
  for (const pid of input.payment_ids) {
    if (seen.has(pid)) throw new AppError(400, 'The same payment is listed twice in the deposit.');
    seen.add(pid);
    const p = txnRow(db, pid);
    if (!p || p.type !== 'PAYMENT') throw new AppError(400, 'One of the payments in this deposit no longer exists.');
    const who = fullName(db, p.name_id);
    if (p.account_id !== uf) {
      throw new AppError(400, `The payment from ${who} was not received into Undeposited Funds, so it cannot be put in a deposit.`);
    }
    const inDeposit = depositOf(db, pid);
    if (inDeposit !== null && inDeposit !== old?.id) {
      throw new AppError(400, `The payment from ${who}${p.ref_no ? ` (check ${p.ref_no})` : ''} is already in another deposit.`);
    }
    total += p.total;
    links.push({ to_txn: pid, amount: p.total, discount: 0, discount_account_id: null });
    splits.push({ account_id: uf, amount: -p.total, name_id: p.name_id, memo: input.memo });
  }

  const lines: StoredLine[] = [];
  input.lines.forEach((l, i) => {
    if (l.account_id === null && l.amount === 0) return; // a blank row
    if (l.account_id === null) throw new AppError(400, `Choose the account that line ${i + 1} of the deposit comes from.`);
    const a = accountRow(db, l.account_id);
    if (!a) throw new AppError(400, `The account on line ${i + 1} of the deposit no longer exists.`);
    if (l.name_id !== null && !db.prepare('SELECT 1 FROM names WHERE id = ?').get(l.name_id)) {
      throw new AppError(400, `The name on line ${i + 1} of the deposit no longer exists.`);
    }
    total += l.amount;
    lines.push({
      item_id: null,
      description: l.description,
      qty: null,
      rate: null,
      rate_is_percent: false,
      amount: l.amount,
      account_id: l.account_id,
      name_id: l.name_id,
      ref_no: l.ref_no,
      pay_method: l.pay_method,
    });
    splits.push({ account_id: l.account_id, amount: -l.amount, name_id: l.name_id, memo: l.description });
  });

  if (links.length === 0 && lines.length === 0) throw new AppError(400, 'A deposit needs at least one payment or line.');
  if (total < 0) throw new AppError(400, 'The deposit total cannot be negative.');

  splits.unshift({ account_id: bank.id, amount: total, name_id: null, memo: input.memo });
  const header = blankHeader({ ...input, name_id: null });
  header.account_id = bank.id;
  header.total = total;
  return { splits, header, lines, links: { kind: 'deposit', list: links }, minSplits: 2 };
}

// ---------------------------------------------------------------------------

type Builders = { [K in TxnInput['type']]: (db: DB, input: Extract<TxnInput, { type: K }>, old: Old) => Built };

const builders: Builders = {
  GENJRNL: buildJournal,
  INVOICE: buildSalesDoc,
  CREDITMEMO: buildSalesDoc,
  PAYMENT: buildPayment,
  DEPOSIT: buildDeposit,
  PURCHORD: buildPurchaseOrder,
  BILL: buildBill,
  BILLCREDIT: buildBill,
  BILLPMT: buildBillPayment,
  CHECK: buildCheck,
  TRANSFER: buildTransfer,
  PAYCHECK: buildPaycheck,
};

function build(db: DB, input: TxnInput, old: Old): Built {
  return (builders[input.type] as (db: DB, input: TxnInput, old: Old) => Built)(db, input, old);
}

function validate(db: DB, splits: BuiltSplit[], minSplits: number) {
  if (splits.length < minSplits) throw new AppError(400, 'A transaction needs at least two lines.');
  const sum = splits.reduce((t, s) => t + s.amount, 0);
  if (sum !== 0) {
    throw new AppError(400, 'The transaction is not in balance. Make sure the debits equal the credits.');
  }
  const exists = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
  for (const s of splits) {
    if (!Number.isInteger(s.amount)) throw new Error('posting: split amount is not whole cents');
    if (!exists.get(s.account_id)) throw new AppError(400, 'One of the accounts on this transaction no longer exists.');
  }
}

const HEADER_COLS = [
  'date', 'num', 'name_id', 'memo', 'terms_id', 'due_date', 'po_number', 'ship_date', 'ship_via', 'bill_addr',
  'ship_addr', 'message', 'to_print', 'to_email', 'pay_method', 'ref_no', 'account_id', 'ar_account_id', 'total',
  'ap_account_id', 'to_account_id', 'expected_date', 'closed', 'period_from', 'period_to',
] as const;

interface SaveOpts {
  /** Internal: re-post without a version check (a payment whose invoice was deleted). */
  repost?: boolean;
  /** Internal: mark a new invoice as a finance charge. */
  isFinanceCharge?: boolean;
}

/** Create a transaction (no id) or replace an existing one (id given; input.version must match). */
export function saveTxn(db: DB, input: TxnInput, id?: number, opts: SaveOpts = {}): { id: number; version: number } {
  return db.transaction(() => {
    let version = 1;
    let oldSplits: { seq: number; account_id: number; amount: number; cleared: number }[] = [];
    let txnId: number;
    let old: Old;

    if (id !== undefined) {
      old = txnRow(db, id);
      if (!old) throw new AppError(404, 'That transaction no longer exists.');
      if (old.import_locked) return saveLockedSplits(db, old, input, opts);
      if (old.type !== input.type) throw new AppError(400, 'The type of a transaction cannot be changed.');
      if (!opts.repost && input.version !== old.version) {
        throw new AppError(409, 'This transaction was changed in another window. Reopen it and try again.');
      }
    }

    const built = build(db, input, old);
    validate(db, built.splits, built.minSplits);
    const h = built.header;
    const values = HEADER_COLS.map((c) => h[c]);

    if (old === undefined) {
      const r = db
        .prepare(
          `INSERT INTO txns (type, ${HEADER_COLS.join(', ')}, is_finance_charge)
           VALUES (?, ${HEADER_COLS.map(() => '?').join(', ')}, ?)`,
        )
        .run(input.type, ...values, opts.isFinanceCharge ? 1 : 0);
      txnId = Number(r.lastInsertRowid);
    } else {
      version = old.version + 1;
      txnId = old.id;
      oldSplits = db
        .prepare('SELECT seq, account_id, amount, cleared FROM splits WHERE txn_id = ?')
        .all(txnId) as typeof oldSplits;
      db.prepare(
        `UPDATE txns SET ${HEADER_COLS.map((c) => `${c} = ?`).join(', ')}, version = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(...values, version, txnId);
      db.prepare('DELETE FROM splits WHERE txn_id = ?').run(txnId);
    }

    const ins = db.prepare(
      'INSERT INTO splits (txn_id, seq, account_id, amount, name_id, memo, cleared) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    built.splits.forEach((s, seq) => {
      // A line that still has the same account and amount keeps its cleared mark.
      const was = oldSplits.find((o) => o.seq === seq);
      const cleared = was && was.account_id === s.account_id && was.amount === s.amount ? was.cleared : 0;
      ins.run(txnId, seq, s.account_id, s.amount, s.name_id, s.memo, cleared);
    });

    if (built.lines) {
      db.prepare('DELETE FROM lines WHERE txn_id = ?').run(txnId);
      const insLine = db.prepare(
        `INSERT INTO lines (txn_id, seq, item_id, description, qty, rate, rate_is_percent, amount, account_id, name_id, ref_no,
                            pay_method, payroll_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      built.lines.forEach((l, seq) =>
        insLine.run(
          txnId, seq, l.item_id, l.description, l.qty, l.rate, l.rate_is_percent ? 1 : 0, l.amount, l.account_id,
          l.name_id, l.ref_no, l.pay_method, l.payroll_item_id ?? null,
        ),
      );
    }
    if (built.links) {
      db.prepare('DELETE FROM links WHERE from_txn = ? AND kind = ?').run(txnId, built.links.kind);
      const insLink = db.prepare(
        'INSERT INTO links (from_txn, to_txn, kind, amount, discount, discount_account_id) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const l of built.links.list) {
        insLink.run(txnId, l.to_txn, built.links.kind, l.amount, l.discount, l.discount_account_id);
      }
    }
    built.afterSave?.(txnId);

    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
      opts.repost ? 'repost' : old === undefined ? 'create' : 'update',
      txnId,
      JSON.stringify(input),
    );
    return { id: txnId, version };
  })();
}

/** A discount that an apply link took, and that goes away with the link. */
interface DroppedDiscount {
  discount: number;
  discount_account_id: number | null;
}

/**
 * Rebuild a payment's splits after some of its applications went away (`dropped`: the
 * discounts those took). A 0.00 write-off left with nothing to write off goes too.
 */
function repostPayment(db: DB, id: number, dropped: DroppedDiscount[]) {
  const p = txnRow(db, id)!;
  const apps = db
    .prepare("SELECT to_txn AS txn_id, amount, discount, discount_account_id FROM links WHERE kind = 'apply' AND from_txn = ? ORDER BY id")
    .all(id) as PaymentInput['applications'];
  if (p.type === 'PAYMENT' && p.total === 0 && apps.length === 0 && depositOf(db, id) === null) {
    const before = getTxn(db, id);
    db.prepare('DELETE FROM txns WHERE id = ?').run(id);
    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run('delete', id, JSON.stringify(before));
    return;
  }
  if (p.import_locked) return dropLockedDiscounts(db, p, dropped);
  if (p.type === 'BILLPMT') return repostBillPayment(db, p, apps);
  const input: PaymentInput = {
    type: 'PAYMENT',
    date: p.date,
    num: p.num,
    name_id: p.name_id,
    memo: p.memo,
    amount: p.total,
    pay_method: p.pay_method,
    ref_no: p.ref_no,
    account_id: p.account_id,
    ar_account_id: p.ar_account_id,
    applications: apps,
  };
  saveTxn(db, input, id, { repost: true });
}

function repostBillPayment(db: DB, p: TxnHeaderRow, apps: BillPaymentInput['applications']) {
  const input: BillPaymentInput = {
    type: 'BILLPMT',
    date: p.date,
    num: p.num,
    to_print: !!p.to_print,
    name_id: p.name_id,
    memo: p.memo,
    account_id: p.account_id,
    ap_account_id: p.ap_account_id,
    pay_method: p.pay_method === 'other' ? 'other' : 'check',
    address: p.bill_addr,
    amount: p.total,
    applications: apps,
  };
  saveTxn(db, input, p.id, { repost: true });
}

/**
 * A payment imported exactly as QuickBooks posted it cannot be rebuilt from its form, so
 * each dropped discount is taken back out of its splits directly: the discount account
 * line and the A/R (A/P) line each shrink by the discount, and go when they reach zero.
 * QuickBooks may have folded the discount into a larger A/R or A/P line, so a line that
 * is larger than the discount is reduced rather than removed.
 */
function dropLockedDiscounts(db: DB, p: TxnHeaderRow, dropped: DroppedDiscount[]) {
  type S = { seq: number; account_id: number; amount: number; name_id: number | null; memo: string; cleared: number };
  const splits = db
    .prepare('SELECT seq, account_id, amount, name_id, memo, cleared FROM splits WHERE txn_id = ? ORDER BY seq')
    .all(p.id) as S[];
  // Payment: Dr discount, Cr A/R. Bill payment: Dr A/P, Cr discount.
  const sign = p.type === 'BILLPMT' ? -1 : 1;
  const key = p.type === 'BILLPMT' ? p.ap_account_id : p.ar_account_id;
  const take = (account: number | null, amount: number): boolean => {
    const fits = splits.filter((s) => s.account_id === account && Math.sign(s.amount) === Math.sign(amount) && Math.abs(s.amount) >= Math.abs(amount));
    const s = fits.find((x) => x.amount === amount) ?? fits[0];
    if (!s) return false;
    s.amount -= amount;
    s.cleared = 0;
    return true;
  };
  for (const d of dropped) {
    if (d.discount === 0) continue;
    if (!take(d.discount_account_id, sign * d.discount) || !take(key, -sign * d.discount)) {
      const what = p.qb_type || TXN_TYPE_LABELS_LOWER[p.type] || p.type;
      throw new AppError(
        400,
        `The ${what.toLowerCase()}${p.num ? ` ${p.num}` : ''} of ${formatUsDate(p.date)} took a discount here. It was imported from QuickBooks exactly as QuickBooks posted it, and RapidBooks cannot find the discount in its lines to take it back out. Nothing was changed. To go ahead, delete that ${what.toLowerCase()} first and enter it again.`,
      );
    }
  }
  const kept = splits.filter((s) => s.amount !== 0);
  validate(db, kept, 2);
  db.prepare('DELETE FROM splits WHERE txn_id = ?').run(p.id);
  const ins = db.prepare('INSERT INTO splits (txn_id, seq, account_id, amount, name_id, memo, cleared) VALUES (?, ?, ?, ?, ?, ?, ?)');
  kept.forEach((s, seq) => ins.run(p.id, seq, s.account_id, s.amount, s.name_id, s.memo, s.cleared));
  db.prepare("UPDATE txns SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(p.id);
  db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run('repost', p.id, JSON.stringify({ dropped }));
}

const LINE_COLS =
  'id, seq, item_id, description, qty, rate, rate_is_percent, amount, account_id, name_id, ref_no, pay_method';

function linksOf(db: DB, id: number, dir: 'out' | 'in'): TxnLink[] {
  const [mine, other] = dir === 'out' ? ['from_txn', 'to_txn'] : ['to_txn', 'from_txn'];
  return db
    .prepare(
      `SELECT l.id, l.kind, o.id AS txn_id, o.type, o.num, o.date, o.name_id, l.amount, l.discount, l.discount_account_id
         FROM links l JOIN txns o ON o.id = l.${other}
        WHERE l.${mine} = ?
        ORDER BY o.date, o.id`,
    )
    .all(id) as TxnLink[];
}

export function getTxn(db: DB, id: number): AnyTxn {
  const row = txnRow(db, id);
  if (!row) throw new AppError(404, 'That transaction no longer exists.');
  const splits = (
    db
      .prepare('SELECT id, seq, account_id, amount, name_id, memo, cleared FROM splits WHERE txn_id = ? ORDER BY seq')
      .all(id) as (Omit<Split, 'cleared'> & { cleared: number })[]
  ).map((s) => ({ ...s, cleared: !!s.cleared }));
  const base: Txn = {
    id: row.id,
    type: row.type,
    date: row.date,
    num: row.num,
    name_id: row.name_id,
    memo: row.memo,
    version: row.version,
    splits,
  };
  if (row.import_locked || row.qb_type) {
    // Imported from QuickBooks (see importWriter below).
    Object.assign(base, {
      import_locked: !!row.import_locked,
      import_note: row.import_note ?? '',
      qb_type: row.qb_type ?? '',
      qb_trans_no: row.qb_trans_no ?? '',
    });
  }
  if (row.type === 'GENJRNL') return base;
  if (PURCH_TYPES.has(row.type)) return getPurchTxn(db, row, base);
  // A QuickBooks type RapidBooks has no form for (imported as posted): splits only.
  if (!DOC_TYPES.has(row.type)) return base;

  const lines = (db.prepare(`SELECT ${LINE_COLS} FROM lines WHERE txn_id = ? ORDER BY seq`).all(id) as (Omit<
    TxnLine,
    'rate_is_percent'
  > & { rate_is_percent: number })[]).map((l) => ({ ...l, rate_is_percent: !!l.rate_is_percent }));
  const links_out = linksOf(db, id, 'out');
  const links_in = linksOf(db, id, 'in');
  const t = row.type as DocTxn['type'];
  const doc: DocTxn = {
    ...base,
    type: t,
    ar_account_id: row.ar_account_id,
    account_id: row.account_id,
    terms_id: row.terms_id,
    due_date: row.due_date,
    po_number: row.po_number,
    ship_date: row.ship_date,
    ship_via: row.ship_via,
    bill_addr: row.bill_addr,
    ship_addr: row.ship_addr,
    message: row.message,
    to_print: !!row.to_print,
    to_email: !!row.to_email,
    emailed_at: row.emailed_at,
    pay_method: row.pay_method,
    ref_no: row.ref_no,
    is_finance_charge: !!row.is_finance_charge,
    lines,
    links_out,
    links_in,
    total: row.total,
    open_balance: t === 'INVOICE' ? row.total - appliedTo(db, id) : null,
    unapplied: t === 'PAYMENT' || t === 'CREDITMEMO' ? row.total - appliedFrom(db, id) : null,
    deposit_id: t === 'PAYMENT' ? depositOf(db, id) : null,
    payment_ids: t === 'DEPOSIT' ? links_out.filter((l) => l.kind === 'deposit').map((l) => l.txn_id) : [],
  };
  return doc;
}

export function deleteTxn(db: DB, id: number) {
  db.transaction(() => {
    const before = getTxn(db, id);
    if (before.type === 'PAYMENT' && depositOf(db, id) !== null) {
      throw new AppError(400, 'This payment has been deposited. Remove it from the deposit first, then delete it.');
    }
    // Payments that took a discount on this invoice or bill must drop the discount posting.
    const repost = new Map<number, DroppedDiscount[]>();
    if (before.type === 'INVOICE' || before.type === 'BILL') {
      const rows = db
        .prepare("SELECT from_txn, discount, discount_account_id FROM links WHERE kind = 'apply' AND to_txn = ? AND discount <> 0")
        .all(id) as (DroppedDiscount & { from_txn: number })[];
      for (const r of rows) repost.set(r.from_txn, [...(repost.get(r.from_txn) ?? []), r]);
    }
    // Purchase orders received on this bill reopen.
    const pos =
      before.type === 'BILL'
        ? (db.prepare("SELECT to_txn FROM links WHERE kind = 'po' AND from_txn = ?").all(id) as { to_txn: number }[]).map((r) => r.to_txn)
        : [];
    db.prepare('DELETE FROM txns WHERE id = ?').run(id); // splits, lines and links go with it
    for (const [p, dropped] of repost) repostPayment(db, p, dropped);
    reopenPurchaseOrders(db, pos);
    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
      'delete',
      id,
      JSON.stringify(before),
    );
  })();
}

/**
 * Remove one payment or credit application (an "apply" link). No ledger posting
 * changes, except that a discount taken on that invoice is reversed.
 */
export function removeApplication(db: DB, linkId: number) {
  db.transaction(() => {
    const l = db.prepare('SELECT * FROM links WHERE id = ?').get(linkId) as
      | { id: number; from_txn: number; kind: string; discount: number; discount_account_id: number | null }
      | undefined;
    if (!l) throw new AppError(404, 'That application no longer exists.');
    if (l.kind === 'deposit') throw new AppError(400, 'To take a payment out of a deposit, edit the deposit.');
    if (l.kind === 'po') throw new AppError(400, 'To unlink a purchase order from a bill, edit the bill.');
    db.prepare('DELETE FROM links WHERE id = ?').run(linkId);
    if (l.discount !== 0) repostPayment(db, l.from_txn, [l]);
    else db.prepare('UPDATE txns SET version = version + 1 WHERE id = ?').run(l.from_txn);
    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
      'unapply',
      l.from_txn,
      JSON.stringify(l),
    );
  })();
}

export function setCleared(db: DB, splitId: number, cleared: boolean) {
  const s = db
    .prepare('SELECT s.txn_id, s.account_id, t.type FROM splits s JOIN txns t ON t.id = s.txn_id WHERE s.id = ?')
    .get(splitId) as { txn_id: number; account_id: number; type: string } | undefined;
  if (!s) throw new AppError(404, 'That transaction no longer exists.');
  if (s.type === 'GENJRNL') {
    db.prepare('UPDATE splits SET cleared = ? WHERE id = ?').run(cleared ? 1 : 0, splitId);
  } else {
    // Documents show one register row per account, so the mark covers all of its splits there.
    db.prepare('UPDATE splits SET cleared = ? WHERE txn_id = ? AND account_id = ?').run(
      cleared ? 1 : 0,
      s.txn_id,
      s.account_id,
    );
  }
}

/**
 * The next number for a transaction type: one more than the highest numeric number in
 * use. Invoices and credit memos share one sequence, as in QuickBooks. Checks, bill
 * payments and paychecks share one sequence per bank account (all bank accounts when
 * accountId is not given).
 */
export function nextNum(db: DB, type: string, accountId: number | null = null): string {
  const isCheck = CHECK_TYPES.includes(type);
  const types = type === 'INVOICE' || type === 'CREDITMEMO' ? ['INVOICE', 'CREDITMEMO'] : isCheck ? CHECK_TYPES : [type];
  const acct = isCheck ? accountId : null;
  const r = db
    .prepare(
      `SELECT MAX(CAST(num AS INTEGER)) AS n FROM txns
        WHERE type IN (${types.map(() => '?').join(', ')}) AND num GLOB '[0-9]*'
          AND (? IS NULL OR account_id = ?)`,
    )
    .get(...types, acct, acct) as { n: number | null };
  return String((r.n ?? 0) + 1);
}

/** The next finance-charge number: "FC 1", "FC 2", ... */
export function nextFinanceChargeNum(db: DB): string {
  const r = db
    .prepare("SELECT MAX(CAST(SUBSTR(num, 4) AS INTEGER)) AS n FROM txns WHERE type = 'INVOICE' AND num GLOB 'FC [0-9]*'")
    .get() as { n: number | null };
  return `FC ${(r.n ?? 0) + 1}`;
}

/**
 * Every split posted to an account, oldest first, with a running balance. A document
 * (invoice, payment, deposit...) shows as one row per account it touches, so an
 * invoice is one A/R row and a deposit one Undeposited Funds row.
 */
export function getRegister(db: DB, accountId: number): RegisterRow[] {
  const rows = db
    .prepare(
      `SELECT s.id AS split_id, t.id AS txn_id, t.date, t.num, t.type,
              n.name AS name,
              CASE WHEN s.memo <> '' THEN s.memo ELSE t.memo END AS memo,
              t.memo AS txn_memo,
              s.amount, s.cleared,
              (SELECT COUNT(*) FROM splits o WHERE o.txn_id = t.id) AS n_splits,
              (SELECT o.account_id FROM splits o WHERE o.txn_id = t.id AND o.id <> s.id ORDER BY o.seq LIMIT 1) AS other,
              (SELECT COUNT(DISTINCT o.account_id) FROM splits o WHERE o.txn_id = t.id AND o.account_id <> s.account_id) AS n_other,
              (SELECT MIN(o.account_id) FROM splits o WHERE o.txn_id = t.id AND o.account_id <> s.account_id) AS other_doc
         FROM splits s
         JOIN txns t ON t.id = s.txn_id
         LEFT JOIN names n ON n.id = COALESCE(s.name_id, t.name_id)
        WHERE s.account_id = ?
        ORDER BY t.date, t.id, s.seq`,
    )
    .all(accountId) as (Omit<RegisterRow, 'cleared' | 'balance' | 'other_account_id'> & {
    cleared: number;
    n_splits: number;
    other: number | null;
    n_other: number;
    other_doc: number | null;
    txn_memo: string;
  })[];

  const out: RegisterRow[] = [];
  let balance = 0;
  for (const { n_splits, other, n_other, other_doc, cleared, txn_memo, ...r } of rows) {
    balance += r.amount;
    const prev = out[out.length - 1];
    if (r.type !== 'GENJRNL' && prev && prev.txn_id === r.txn_id) {
      prev.amount += r.amount;
      prev.balance = balance;
      prev.cleared = prev.cleared && !!cleared;
      continue;
    }
    if (r.type === 'GENJRNL') {
      out.push({ ...r, cleared: !!cleared, other_account_id: n_splits === 2 ? other : null, balance });
    } else {
      // A document's row shows its header memo and the other account when there is only one.
      out.push({ ...r, memo: txn_memo || r.memo, cleared: !!cleared, other_account_id: n_other === 1 ? other_doc : null, balance });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// History import (import/history.ts): the raw path.
//
// QuickBooks' own postings are written verbatim, so the ledger matches QuickBooks to the
// cent even where RapidBooks' builders would post differently. This is still the posting
// engine: every transaction's splits are checked to sum to zero before they are written.
// Afterwards each document is run through its ordinary builder (rebuild); when the
// builder reproduces the splits the document is an ordinary editable one, otherwise it
// is marked import_locked and can only be edited as raw splits (saveLockedSplits).

const DOC_TYPES = new Set(['INVOICE', 'CREDITMEMO', 'PAYMENT', 'DEPOSIT']);

export interface ImportSplit extends BuiltSplit {
  cleared: boolean;
}

export interface ImportTxn {
  type: string; // a RapidBooks type, or QuickBooks' type name for types without a form
  header: Header;
  splits: ImportSplit[]; // in QuickBooks' order
  is_finance_charge?: boolean;
  qb_type: string;
  qb_trans_no: string;
}

export interface ImportLink {
  from_txn: number;
  to_txn: number;
  kind: 'apply' | 'deposit' | 'po';
  amount: number;
  discount: number;
  discount_account_id: number | null;
}

/** Prepared statements for writing imported transactions; use inside one database transaction. */
export function importWriter(db: DB) {
  const accountIds = new Set((db.prepare('SELECT id FROM accounts').all() as { id: number }[]).map((r) => r.id));
  const accountExists = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
  const insTxn = db.prepare(
    `INSERT INTO txns (type, ${HEADER_COLS.join(', ')}, is_finance_charge, qb_type, qb_trans_no)
     VALUES (?, ${HEADER_COLS.map(() => '?').join(', ')}, ?, ?, ?)`,
  );
  const insSplit = db.prepare(
    'INSERT INTO splits (txn_id, seq, account_id, amount, name_id, memo, cleared) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const delLines = db.prepare('DELETE FROM lines WHERE txn_id = ?');
  const insLine = db.prepare(
    `INSERT INTO lines (txn_id, seq, item_id, description, qty, rate, rate_is_percent, amount, account_id, name_id, ref_no,
                        pay_method, payroll_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insLink = db.prepare(
    'INSERT INTO links (from_txn, to_txn, kind, amount, discount, discount_account_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const setLock = db.prepare('UPDATE txns SET import_locked = ?, import_note = ? WHERE id = ?');

  return {
    /** Write the header and splits exactly as given. Throws if they do not sum to zero. */
    txn(t: ImportTxn): number {
      if (t.splits.length === 0) throw new AppError(400, 'A transaction needs at least one split.');
      let sum = 0;
      for (const s of t.splits) {
        if (!Number.isInteger(s.amount)) throw new Error('posting: split amount is not whole cents');
        if (!accountIds.has(s.account_id)) {
          if (!accountExists.get(s.account_id)) throw new AppError(400, 'One of the accounts on this transaction does not exist.');
          accountIds.add(s.account_id);
        }
        sum += s.amount;
      }
      if (sum !== 0) throw new AppError(400, 'The transaction is not in balance.');
      const h = t.header;
      const r = insTxn.run(t.type, ...HEADER_COLS.map((c) => h[c]), t.is_finance_charge ? 1 : 0, t.qb_type, t.qb_trans_no);
      const id = Number(r.lastInsertRowid);
      t.splits.forEach((s, seq) => insSplit.run(id, seq, s.account_id, s.amount, s.name_id, s.memo, s.cleared ? 1 : 0));
      return id;
    },
    /** Replace a transaction's document lines. */
    lines(id: number, lines: StoredLine[]) {
      delLines.run(id);
      lines.forEach((l, seq) =>
        insLine.run(
          id, seq, l.item_id, l.description, l.qty, l.rate, l.rate_is_percent ? 1 : 0, l.amount, l.account_id, l.name_id,
          l.ref_no, l.pay_method, l.payroll_item_id ?? null,
        ),
      );
    },
    links(list: ImportLink[]) {
      for (const l of list) insLink.run(l.from_txn, l.to_txn, l.kind, l.amount, l.discount, l.discount_account_id);
    },
    lock(id: number, note: string) {
      setLock.run(1, note, id);
    },
    /**
     * What the document's ordinary builder makes of `input`, as if the stored transaction
     * `id` were being re-saved. Writes nothing; throws the builder's AppError if it refuses.
     */
    rebuild(input: TxnInput, id: number): Built {
      return build(db, input, txnRow(db, id));
    },
  };
}

/**
 * Saving a transaction that was imported as posted (import_locked). Its form cannot
 * rebuild its splits, so only a journal-style edit is accepted: type GENJRNL with the
 * splits, date, num, name and memo. The transaction keeps its type, lines and links.
 */
function saveLockedSplits(db: DB, old: TxnHeaderRow, input: TxnInput, opts: SaveOpts): { id: number; version: number } {
  if (input.type !== 'GENJRNL') {
    const what = old.qb_type || TXN_TYPE_LABELS_LOWER[old.type] || old.type;
    throw new AppError(
      400,
      `This ${what.toLowerCase()} was imported from QuickBooks exactly as QuickBooks posted it${old.import_note ? ` (${old.import_note})` : ''}, so it cannot be saved from its form. Its lines can be changed in the journal view instead.`,
    );
  }
  if (!opts.repost && input.version !== old.version) {
    throw new AppError(409, 'This transaction was changed in another window. Reopen it and try again.');
  }
  const splits = input.splits.map((s) => ({ ...s }));
  validate(db, splits, 2);
  const key = old.account_id ?? old.ar_account_id ?? old.ap_account_id;
  const total =
    key !== null
      ? Math.abs(splits.filter((s) => s.account_id === key).reduce((t, s) => t + s.amount, 0))
      : splits.reduce((t, s) => t + (s.amount > 0 ? s.amount : 0), 0);
  const oldSplits = db.prepare('SELECT seq, account_id, amount, cleared FROM splits WHERE txn_id = ?').all(old.id) as {
    seq: number;
    account_id: number;
    amount: number;
    cleared: number;
  }[];
  const version = old.version + 1;
  db.prepare(
    "UPDATE txns SET date = ?, num = ?, name_id = ?, memo = ?, total = ?, version = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(input.date, input.num, input.name_id, input.memo, total, version, old.id);
  db.prepare('DELETE FROM splits WHERE txn_id = ?').run(old.id);
  const ins = db.prepare(
    'INSERT INTO splits (txn_id, seq, account_id, amount, name_id, memo, cleared) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  splits.forEach((s, seq) => {
    const was = oldSplits.find((o) => o.seq === seq);
    const cleared = was && was.account_id === s.account_id && was.amount === s.amount ? was.cleared : 0;
    ins.run(old.id, seq, s.account_id, s.amount, s.name_id, s.memo, cleared);
  });
  db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run('update', old.id, JSON.stringify(input));
  return { id: old.id, version };
}

const TXN_TYPE_LABELS_LOWER: Record<string, string> = {
  INVOICE: 'invoice',
  CREDITMEMO: 'credit memo',
  PAYMENT: 'payment',
  DEPOSIT: 'deposit',
  BILL: 'bill',
  BILLCREDIT: 'bill credit',
  BILLPMT: 'bill payment',
  CHECK: 'check',
  TRANSFER: 'transfer',
  PAYCHECK: 'paycheck',
};
