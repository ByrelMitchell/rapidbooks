import type { Account, ReportColumn } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { accountsByTxn, dayBefore, fyStart, loadSplits, natural, netIncome, splitLabel, sumsByAccount, type SplitRow } from './data';
import {
  accountFilter,
  blankRow,
  col,
  hi,
  isPL,
  lo,
  lookups,
  nameFilter,
  rangeSubtitle,
  txnDrill,
  typeLabel,
  type Built,
  type Lookups,
  type Params,
  type Row,
} from './engine';

// Accountant reports: General Ledger, Transaction Detail by Account, Profit & Loss
// Detail, Journal, Transaction List by Date, Audit Trail, and the QuickReports.

const CLR = '✓';

export const DETAIL_COLUMNS: ReportColumn[] = [
  col('trans_no', 'Trans #', 'qty'),
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('name', 'Name'),
  col('memo', 'Memo'),
  col('account', 'Account'),
  col('clr', 'Clr', 'text', 'center'),
  col('split', 'Split'),
  col('debit', 'Debit', 'money'),
  col('credit', 'Credit', 'money'),
  col('amount', 'Amount', 'money'),
  col('balance', 'Balance', 'money'),
];

interface DetailOpts {
  accounts: Account[]; // in the order to show them
  beginning: boolean; // carry the balance before `from` (General Ledger, QuickReport)
}

/** The debit-positive balance of an account before `from`, the way the General Ledger carries it. */
function openingBalance(db: DB, L: Lookups, a: Account, from: string | null, before: Map<number, number>, fyBefore: Map<number, number>, priorNI: number): number {
  if (!from) return 0;
  if (isPL(a.type)) return fyBefore.get(a.id) ?? 0;
  let v = before.get(a.id) ?? 0;
  if (a.system_role === 'RETAINED') v -= priorNI;
  return v;
}

/**
 * One group per account: a header (with the opening balance when `beginning`), a row per
 * split in range (amount and balance in the account's natural sign), and a total.
 */
function accountDetailRows(db: DB, L: Lookups, p: Params, o: DetailOpts): { rows: Row[]; debit: number; credit: number; byAccount: Map<number, { amount: number; ending: number }> } {
  const splits = loadSplits(db, lo(p), hi(p));
  const accts = accountsByTxn(splits);
  const names = p.name_ids.length ? nameFilter(L, p) : null;
  const types = p.txn_types.length ? new Set(p.txn_types) : null;
  const byAcct = new Map<number, SplitRow[]>();
  for (const s of splits) {
    if (names && (s.name_id === null || !names.has(s.name_id))) continue;
    if (types && !types.has(s.type)) continue;
    const list = byAcct.get(s.account_id) ?? [];
    list.push(s);
    byAcct.set(s.account_id, list);
  }

  let before = new Map<number, number>();
  let fyBefore = new Map<number, number>();
  let priorNI = 0;
  if (o.beginning && p.from) {
    const prev = dayBefore(p.from);
    before = sumsByAccount(db, '0000-01-01', prev);
    fyBefore = sumsByAccount(db, fyStart(p.from), prev);
    priorNI = netIncome(db, L, '0000-01-01', dayBefore(fyStart(p.from)));
  }

  const rows: Row[] = [];
  let debit = 0;
  let credit = 0;
  const byAccount = new Map<number, { amount: number; ending: number }>();
  for (const a of o.accounts) {
    const list = byAcct.get(a.id) ?? [];
    const open = o.beginning ? natural(a, openingBalance(db, L, a, p.from, before, fyBefore, priorNI)) : 0;
    if (list.length === 0 && open === 0) continue;
    rows.push({ kind: 'header', depth: 0, label: a.full_name, cells: o.beginning ? { balance: open } : {} });
    let bal = open;
    let dr = 0;
    let cr = 0;
    for (const s of list) {
      const amt = natural(a, s.amount);
      bal += amt;
      if (s.amount > 0) dr += s.amount;
      else cr -= s.amount;
      rows.push({
        kind: 'data',
        depth: 1,
        cells: {
          trans_no: s.txn_id,
          type: typeLabel(s.type, s.pay_method),
          date: s.date,
          num: s.num,
          name: s.name_id !== null ? (L.names.get(s.name_id)?.full_name ?? '') : '',
          memo: s.memo,
          account: a.full_name,
          clr: s.cleared ? CLR : '',
          split: splitLabel(L, accts.get(s.txn_id), a.id),
          debit: s.amount > 0 ? s.amount : null,
          credit: s.amount < 0 ? -s.amount : null,
          amount: amt,
          balance: bal,
        },
        drill: txnDrill(s.txn_id, s.type),
      });
    }
    debit += dr;
    credit += cr;
    byAccount.set(a.id, { amount: bal - open, ending: bal });
    rows.push({ kind: 'subtotal', depth: 0, label: `Total ${a.full_name}`, cells: { debit: dr, credit: cr, amount: bal - open, balance: bal } });
  }
  return { rows, debit, credit, byAccount };
}

function chosenAccounts(L: Lookups, p: Params, types?: string[]): Account[] {
  const f = p.account_ids.length ? accountFilter(L, p) : null;
  return L.accounts.filter((a) => (!f || f.has(a.id)) && (!types || types.includes(a.type)));
}

export function generalLedger(db: DB, p: Params): Built {
  const L = lookups(db);
  const d = accountDetailRows(db, L, p, { accounts: chosenAccounts(L, p), beginning: true });
  const rows = [...d.rows, { kind: 'total' as const, depth: 0, label: 'TOTAL', cells: { debit: d.debit, credit: d.credit } }];
  return { subtitle: rangeSubtitle(p), rows };
}

export function txnDetailByAccount(db: DB, p: Params): Built {
  const L = lookups(db);
  const d = accountDetailRows(db, L, p, { accounts: chosenAccounts(L, p), beginning: false });
  const rows = [...d.rows, { kind: 'total' as const, depth: 0, label: 'TOTAL', cells: { debit: d.debit, credit: d.credit } }];
  return { subtitle: rangeSubtitle(p), rows };
}

/** Profit & Loss Detail: the P&L accounts' transactions, by section, down to Net Income. */
export function profitAndLossDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const sections: [string, string][] = [
    ['INC', 'Income'],
    ['COGS', 'Cost of Goods Sold'],
    ['EXP', 'Expense'],
    ['OINC', 'Other Income'],
    ['OEXP', 'Other Expense'],
  ];
  const rows: Row[] = [];
  let net = 0;
  for (const [type, title] of sections) {
    const d = accountDetailRows(db, L, p, { accounts: chosenAccounts(L, p, [type]), beginning: false });
    if (d.rows.length === 0) continue;
    const total = [...d.byAccount.values()].reduce((t, x) => t + x.amount, 0);
    net += type === 'INC' || type === 'OINC' ? total : -total;
    rows.push({ kind: 'header', depth: 0, label: title, cells: {} });
    rows.push(...d.rows.map((r) => ({ ...r, depth: r.depth + 1 })));
    rows.push({ kind: 'subtotal', depth: 0, label: `Total ${title}`, cells: { amount: total } });
  }
  rows.push({ kind: 'total', depth: 0, label: 'Net Income', cells: { amount: net } });
  return { subtitle: rangeSubtitle(p), rows };
}

// ---------------------------------------------------------------------------
// Journal

export const JOURNAL_COLUMNS: ReportColumn[] = [
  col('trans_no', 'Trans #', 'qty'),
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('name', 'Name'),
  col('memo', 'Memo'),
  col('account', 'Account'),
  col('debit', 'Debit', 'money'),
  col('credit', 'Credit', 'money'),
];

/**
 * Every transaction in range with all its splits, in date then transaction order. Like
 * QuickBooks, Trans #, Type, Date and Num are printed on a transaction's first line, and
 * each transaction ends with a line of its debit and credit totals.
 */
export function journal(db: DB, p: Params): Built {
  const L = lookups(db);
  const splits = loadSplits(db, lo(p), hi(p));
  const names = p.name_ids.length ? nameFilter(L, p) : null;
  const accts = p.account_ids.length ? accountFilter(L, p) : null;
  const types = p.txn_types.length ? new Set(p.txn_types) : null;
  const byTxn = new Map<number, SplitRow[]>();
  for (const s of splits) {
    const list = byTxn.get(s.txn_id) ?? [];
    list.push(s);
    byTxn.set(s.txn_id, list);
  }
  const rows: Row[] = [];
  let dr = 0;
  let cr = 0;
  for (const list of byTxn.values()) {
    const t = list[0];
    if (types && !types.has(t.type)) continue;
    if (names && !list.some((s) => s.name_id !== null && names.has(s.name_id)) && !(t.txn_name_id !== null && names.has(t.txn_name_id))) continue;
    if (accts && !list.some((s) => accts.has(s.account_id))) continue;
    let tdr = 0;
    let tcr = 0;
    list.forEach((s, i) => {
      if (s.amount > 0) tdr += s.amount;
      else tcr -= s.amount;
      rows.push({
        kind: 'data',
        depth: 0,
        cells: {
          trans_no: i === 0 ? s.txn_id : null,
          type: i === 0 ? typeLabel(s.type, s.pay_method) : null,
          date: i === 0 ? s.date : null,
          num: i === 0 ? s.num : null,
          name: s.name_id !== null ? (L.names.get(s.name_id)?.full_name ?? '') : '',
          memo: s.memo,
          account: L.account.get(s.account_id)?.full_name ?? '',
          debit: s.amount > 0 ? s.amount : null,
          credit: s.amount < 0 ? -s.amount : null,
        },
        drill: txnDrill(s.txn_id, s.type),
      });
    });
    dr += tdr;
    cr += tcr;
    rows.push({ kind: 'subtotal', depth: 0, cells: { debit: tdr, credit: tcr }, drill: txnDrill(t.txn_id, t.type) });
  }
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { debit: dr, credit: cr } });
  return { subtitle: rangeSubtitle(p), rows };
}

// ---------------------------------------------------------------------------
// Transaction List by Date (and the name QuickReport)

export interface TxnHead {
  id: number;
  type: string;
  date: string;
  num: string;
  name_id: number | null;
  memo: string;
  pay_method: string;
  account_id: number | null;
  ar_account_id: number | null;
  ap_account_id: number | null;
  due_date: string;
  total: number;
}

/** The account a transaction is "in" (as QuickBooks shows it in lists and Find). */
export function mainAccount(t: TxnHead, firstSplitAccount: number | null): number | null {
  switch (t.type) {
    case 'INVOICE':
    case 'CREDITMEMO':
      return t.ar_account_id;
    case 'BILL':
    case 'BILLCREDIT':
      return t.ap_account_id;
    case 'PURCHORD':
      return null;
    case 'GENJRNL':
      return firstSplitAccount;
    default:
      return t.account_id;
  }
}

export const TXN_LIST_COLUMNS: ReportColumn[] = [
  col('trans_no', 'Trans #', 'qty'),
  col('type', 'Type'),
  col('date', 'Date', 'date'),
  col('num', 'Num'),
  col('name', 'Name'),
  col('memo', 'Memo'),
  col('account', 'Account'),
  col('clr', 'Clr', 'text', 'center'),
  col('split', 'Split'),
  col('due_date', 'Due Date', 'date'),
  col('amount', 'Amount', 'money'),
];

/** One row per transaction: its main account, the other account (or -SPLIT-), and the amount in that account. */
function txnListRows(db: DB, L: Lookups, p: Params, keep: (t: TxnHead, splits: SplitRow[]) => boolean, depth = 0): Row[] {
  const heads = db
    .prepare(
      `SELECT id, type, date, num, name_id, memo, pay_method, account_id, ar_account_id, ap_account_id, due_date, total
         FROM txns WHERE date >= ? AND date <= ? ORDER BY date, id`,
    )
    .all(lo(p), hi(p)) as TxnHead[];
  const splits = loadSplits(db, lo(p), hi(p));
  const byTxn = new Map<number, SplitRow[]>();
  for (const s of splits) {
    const list = byTxn.get(s.txn_id) ?? [];
    list.push(s);
    byTxn.set(s.txn_id, list);
  }
  const types = p.txn_types.length ? new Set(p.txn_types) : null;
  const rows: Row[] = [];
  for (const t of heads) {
    if (types && !types.has(t.type)) continue;
    const ss = byTxn.get(t.id) ?? [];
    if (!keep(t, ss)) continue;
    const main = mainAccount(t, ss[0]?.account_id ?? null);
    const a = main !== null ? L.account.get(main) : undefined;
    const mine = ss.filter((s) => s.account_id === main);
    const amount = a && mine.length ? natural(a, mine.reduce((x, s) => x + s.amount, 0)) : t.total;
    const set = new Set(ss.map((s) => s.account_id));
    rows.push({
      kind: 'data',
      depth,
      cells: {
        trans_no: t.id,
        type: typeLabel(t.type, t.pay_method),
        date: t.date,
        num: t.num,
        name: t.name_id !== null ? (L.names.get(t.name_id)?.full_name ?? '') : '',
        memo: t.memo,
        account: a?.full_name ?? '',
        clr: mine.length && mine.every((s) => s.cleared) ? CLR : '',
        split: main !== null ? splitLabel(L, set, main) : '',
        due_date: t.due_date || null,
        amount,
      },
      drill: txnDrill(t.id, t.type),
    });
  }
  return rows;
}

export function txnListByDate(db: DB, p: Params): Built {
  const L = lookups(db);
  const names = p.name_ids.length ? nameFilter(L, p) : null;
  const accts = p.account_ids.length ? accountFilter(L, p) : null;
  const rows = txnListRows(db, L, p, (t, ss) => {
    if (names && !(t.name_id !== null && names.has(t.name_id)) && !ss.some((s) => s.name_id !== null && names.has(s.name_id))) return false;
    if (accts && !ss.some((s) => accts.has(s.account_id))) return false;
    return true;
  });
  return { subtitle: rangeSubtitle(p), rows };
}

// ---------------------------------------------------------------------------
// Audit trail

export function auditTrail(db: DB, p: Params): Built {
  const L = lookups(db);
  const rows = db
    .prepare(`SELECT id, at, action, txn_id, detail FROM audit_log WHERE SUBSTR(at, 1, 10) >= ? AND SUBSTR(at, 1, 10) <= ? ORDER BY id`)
    .all(lo(p), hi(p)) as { id: number; at: string; action: string; txn_id: number | null; detail: string }[];
  const exists = db.prepare('SELECT type FROM txns WHERE id = ?');
  const out: Row[] = rows.map((r) => {
    let d: Record<string, unknown> = {};
    try {
      const v = JSON.parse(r.detail);
      if (v && typeof v === 'object') d = v as Record<string, unknown>;
    } catch {
      /* free text */
    }
    const nameId = typeof d.name_id === 'number' ? d.name_id : null;
    const amount = typeof d.total === 'number' ? d.total : typeof d.amount === 'number' ? d.amount : null;
    const type = typeof d.type === 'string' ? d.type : '';
    const live = r.txn_id !== null ? (exists.get(r.txn_id) as { type: string } | undefined) : undefined;
    const row: Row = {
      kind: 'data',
      depth: 0,
      cells: {
        at: r.at,
        action: r.action,
        trans_no: r.txn_id,
        type: type ? typeLabel(type) : '',
        date: typeof d.date === 'string' ? d.date : null,
        num: typeof d.num === 'string' ? d.num : '',
        name: nameId !== null ? (L.names.get(nameId)?.full_name ?? '') : '',
        amount,
      },
    };
    if (live && r.txn_id !== null) row.drill = txnDrill(r.txn_id, live.type);
    return row;
  });
  return {
    subtitle: rangeSubtitle(p),
    columns: [
      col('at', 'Entered/Last Modified (UTC)'),
      col('action', 'Action'),
      col('trans_no', 'Trans #', 'qty'),
      col('type', 'Type'),
      col('date', 'Date', 'date'),
      col('num', 'Num'),
      col('name', 'Name'),
      col('amount', 'Amount', 'money'),
    ],
    rows: out,
  };
}

// ---------------------------------------------------------------------------
// QuickReport (Ctrl+Q): an account, a name or an item

export function quickReport(db: DB, p: Params): Built {
  const L = lookups(db);
  const accountId = p.extra.account_id as number | null;
  const nameId = p.extra.name_id as number | null;
  const itemId = p.extra.item_id as number | null;
  const given = [accountId, nameId, itemId].filter((x) => x !== null).length;
  if (given !== 1) throw new AppError(400, 'Choose one account, name or item for the QuickReport.');

  if (accountId !== null) {
    const a = L.account.get(accountId);
    if (!a) throw new AppError(404, 'That account no longer exists.');
    const set = accountFilter(L, { ...p, account_ids: [accountId] });
    const d = accountDetailRows(db, L, { ...p, account_ids: [accountId] }, { accounts: L.accounts.filter((x) => set.has(x.id)), beginning: true });
    const pick = ['type', 'date', 'num', 'name', 'memo', 'clr', 'split', 'amount', 'balance'];
    return {
      title: `${a.full_name} QuickReport`,
      subtitle: rangeSubtitle(p),
      columns: DETAIL_COLUMNS.filter((c) => pick.includes(c.key)),
      rows: [...d.rows, { kind: 'total', depth: 0, label: 'TOTAL', cells: {} }],
    };
  }

  if (nameId !== null) {
    const n = L.names.get(nameId);
    if (!n) throw new AppError(404, 'That name no longer exists.');
    const set = nameFilter(L, { ...p, name_ids: [nameId] });
    const rows = txnListRows(db, L, p, (t, ss) => (t.name_id !== null && set.has(t.name_id)) || ss.some((s) => s.name_id !== null && set.has(s.name_id)), 1);
    const pick = ['type', 'date', 'num', 'memo', 'account', 'clr', 'split', 'amount'];
    return {
      title: `${n.full_name} QuickReport`,
      subtitle: rangeSubtitle(p),
      columns: TXN_LIST_COLUMNS.filter((c) => pick.includes(c.key)),
      rows: [{ kind: 'header', depth: 0, label: n.full_name, cells: {} }, ...rows, blankRow()],
    };
  }

  const it = L.items.get(itemId!);
  if (!it) throw new AppError(404, 'That item no longer exists.');
  const lines = db
    .prepare(
      `SELECT t.id, t.type, t.date, t.num, t.name_id, t.pay_method, l.description, l.qty, l.rate, l.rate_is_percent, l.amount
         FROM lines l JOIN txns t ON t.id = l.txn_id
        WHERE l.item_id = ? AND t.date >= ? AND t.date <= ?
        ORDER BY t.date, t.id, l.seq`,
    )
    .all(itemId, lo(p), hi(p)) as {
    id: number;
    type: string;
    date: string;
    num: string;
    name_id: number | null;
    pay_method: string;
    description: string;
    qty: number | null;
    rate: number | null;
    rate_is_percent: number;
    amount: number;
  }[];
  let qty = 0;
  let amount = 0;
  const rows: Row[] = [{ kind: 'header', depth: 0, label: it.full_name, cells: {} }];
  for (const l of lines) {
    const sign = l.type === 'CREDITMEMO' || l.type === 'BILLCREDIT' ? -1 : 1;
    qty += sign * (l.qty ?? 0);
    amount += sign * l.amount;
    rows.push({
      kind: 'data',
      depth: 1,
      cells: {
        type: typeLabel(l.type, l.pay_method),
        date: l.date,
        num: l.num,
        name: l.name_id !== null ? (L.names.get(l.name_id)?.full_name ?? '') : '',
        memo: l.description,
        qty: l.qty === null ? null : sign * l.qty,
        rate: l.rate_is_percent ? null : l.rate,
        amount: sign * l.amount,
      },
      drill: txnDrill(l.id, l.type),
    });
  }
  rows.push({ kind: 'total', depth: 0, label: `Total ${it.full_name}`, cells: { qty, amount } });
  return {
    title: `${it.full_name} QuickReport`,
    subtitle: rangeSubtitle(p),
    columns: [
      col('type', 'Type'),
      col('date', 'Date', 'date'),
      col('num', 'Num'),
      col('name', 'Name'),
      col('memo', 'Memo'),
      col('qty', 'Qty', 'qty'),
      col('rate', 'Rate', 'money'),
      col('amount', 'Amount', 'money'),
    ],
    rows,
  };
}

