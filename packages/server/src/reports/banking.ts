import { formatUsDate } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { CHECK_TYPES } from '../ledger/purchasing';
import {
  accountFilter,
  asOfSubtitle,
  col,
  hi,
  lo,
  lookups,
  rangeSubtitle,
  txnDrill,
  typeLabel,
  type Built,
  type Lookups,
  type Params,
  type Row,
} from './engine';

// Banking: Deposit Detail, Check Detail, Missing Checks, and the cleared / uncleared
// listing she reconciles against by hand.

const inList = (n: number) => `(${Array(n).fill('?').join(', ')})`;
const nm = (L: Lookups, id: number | null) => (id === null ? '' : (L.names.get(id)?.full_name ?? ''));
const an = (L: Lookups, id: number | null) => (id === null ? '' : (L.account.get(id)?.full_name ?? ''));

const BANK_COLS = [
  col('type', 'Type'),
  col('num', 'Num'),
  col('date', 'Date', 'date'),
  col('name', 'Name'),
  col('memo', 'Memo'),
  col('account', 'Account'),
  col('amount', 'Amount', 'money'),
];

function bankFilter(L: Lookups, p: Params) {
  return p.account_ids.length ? accountFilter(L, p) : null;
}

/** Each deposit, with the payments and other lines it is made of. */
export function depositDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const f = bankFilter(L, p);
  const deps = db
    .prepare("SELECT id, date, num, memo, account_id, total FROM txns WHERE type = 'DEPOSIT' AND date >= ? AND date <= ? ORDER BY date, id")
    .all(lo(p), hi(p)) as { id: number; date: string; num: string; memo: string; account_id: number; total: number }[];
  const pays = db.prepare(
    `SELECT t.id, t.date, t.ref_no, t.name_id, t.memo, t.account_id, l.amount FROM links l JOIN txns t ON t.id = l.to_txn
      WHERE l.kind = 'deposit' AND l.from_txn = ? ORDER BY t.date, t.id`,
  );
  const lines = db.prepare('SELECT description, amount, account_id, name_id, ref_no FROM lines WHERE txn_id = ? ORDER BY seq');
  const rows: Row[] = [];
  let total = 0;
  for (const d of deps) {
    if (f && !f.has(d.account_id)) continue;
    total += d.total;
    rows.push({ kind: 'data', depth: 0, cells: { type: 'Deposit', num: d.num, date: d.date, name: '', memo: d.memo, account: an(L, d.account_id), amount: d.total }, drill: txnDrill(d.id, 'DEPOSIT') });
    for (const x of pays.all(d.id) as { id: number; date: string; ref_no: string; name_id: number; memo: string; account_id: number; amount: number }[]) {
      rows.push({ kind: 'data', depth: 1, cells: { type: 'Payment', num: x.ref_no, date: x.date, name: nm(L, x.name_id), memo: x.memo, account: an(L, x.account_id), amount: x.amount }, drill: txnDrill(x.id, 'PAYMENT') });
    }
    for (const l of lines.all(d.id) as { description: string; amount: number; account_id: number; name_id: number | null; ref_no: string }[]) {
      rows.push({ kind: 'data', depth: 1, cells: { type: '', num: l.ref_no, date: d.date, name: nm(L, l.name_id), memo: l.description, account: an(L, l.account_id), amount: l.amount }, drill: txnDrill(d.id, 'DEPOSIT') });
    }
  }
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { amount: total } });
  return { subtitle: rangeSubtitle(p), columns: BANK_COLS, rows };
}

/** Each check, bill payment and paycheck: what it paid for (lines, bills paid, pay lines). */
export function checkDetail(db: DB, p: Params): Built {
  const L = lookups(db);
  const f = bankFilter(L, p);
  const checks = db
    .prepare(
      `SELECT id, type, pay_method, date, num, name_id, memo, account_id, total FROM txns
        WHERE type IN ${inList(CHECK_TYPES.length)} AND date >= ? AND date <= ? ORDER BY date, id`,
    )
    .all(...CHECK_TYPES, lo(p), hi(p)) as { id: number; type: string; pay_method: string; date: string; num: string; name_id: number | null; memo: string; account_id: number; total: number }[];
  const lineQ = db.prepare(
    `SELECT l.item_id, l.description, l.amount, l.account_id, l.name_id, i.name AS item, p.name AS pitem, p.kind
       FROM lines l LEFT JOIN items i ON i.id = l.item_id LEFT JOIN payroll_items p ON p.id = l.payroll_item_id
      WHERE l.txn_id = ? ORDER BY l.seq`,
  );
  const billQ = db.prepare(
    `SELECT t.id, t.num, t.date, t.ap_account_id, l.amount, l.discount FROM links l JOIN txns t ON t.id = l.to_txn
      WHERE l.kind = 'apply' AND l.from_txn = ? ORDER BY t.date, t.id`,
  );
  const rows: Row[] = [];
  let total = 0;
  for (const c of checks) {
    if (f && !f.has(c.account_id)) continue;
    total += c.total;
    rows.push({
      kind: 'data',
      depth: 0,
      cells: { type: typeLabel(c.type, c.pay_method), num: c.num, date: c.date, name: nm(L, c.name_id), memo: c.memo, account: an(L, c.account_id), amount: c.total },
      drill: txnDrill(c.id, c.type),
    });
    if (c.type === 'BILLPMT') {
      for (const b of billQ.all(c.id) as { id: number; num: string; date: string; ap_account_id: number; amount: number; discount: number }[]) {
        rows.push({
          kind: 'data',
          depth: 1,
          cells: { type: 'Bill', num: b.num, date: b.date, name: nm(L, c.name_id), memo: b.discount ? `Discount ${(b.discount / 100).toFixed(2)}` : '', account: an(L, b.ap_account_id), amount: b.amount },
          drill: txnDrill(b.id, 'BILL'),
        });
      }
    } else {
      for (const l of lineQ.all(c.id) as { item_id: number | null; description: string; amount: number; account_id: number | null; name_id: number | null; item: string | null; pitem: string | null; kind: string | null }[]) {
        if (l.kind === 'company') continue; // employer contributions are not paid by the check
        if (l.kind === null && l.account_id === null) continue; // description-only line
        const amt = l.kind === 'deduction' ? -l.amount : l.amount;
        rows.push({
          kind: 'data',
          depth: 1,
          cells: { type: '', num: '', date: c.date, name: nm(L, l.name_id ?? c.name_id), memo: l.pitem ?? (l.item ? `${l.item}${l.description ? ` - ${l.description}` : ''}` : l.description), account: an(L, l.account_id), amount: amt },
          drill: txnDrill(c.id, c.type),
        });
      }
    }
  }
  rows.push({ kind: 'total', depth: 0, label: 'TOTAL', cells: { amount: total } });
  return { subtitle: rangeSubtitle(p), columns: BANK_COLS, rows };
}

/**
 * Missing Checks: per bank account, the checks, bill payments and paychecks with numeric
 * numbers in number order, with a marker row at every gap and before every duplicate.
 */
export function missingChecks(db: DB, p: Params): Built {
  const L = lookups(db);
  const f = bankFilter(L, p);
  const all = db
    .prepare(
      `SELECT id, type, pay_method, date, num, name_id, memo, account_id, total FROM txns
        WHERE type IN ${inList(CHECK_TYPES.length)} AND num GLOB '[0-9]*' AND num NOT GLOB '*[^0-9]*' AND date >= ? AND date <= ?`,
    )
    .all(...CHECK_TYPES, lo(p), hi(p)) as { id: number; type: string; pay_method: string; date: string; num: string; name_id: number | null; memo: string; account_id: number; total: number }[];
  const rows: Row[] = [];
  for (const a of L.accounts) {
    if (f && !f.has(a.id)) continue;
    const list = all.filter((c) => c.account_id === a.id).sort((x, y) => Number(x.num) - Number(y.num) || (x.date < y.date ? -1 : 1) || x.id - y.id);
    if (list.length === 0) continue;
    rows.push({ kind: 'header', depth: 0, label: a.full_name, cells: {} });
    list.forEach((c, i) => {
      if (i > 0) {
        const prev = Number(list[i - 1].num);
        const n = Number(c.num);
        if (n === prev) rows.push({ kind: 'header', depth: 1, label: `*** Duplicate document number ${c.num} ***`, cells: {} });
        else if (n > prev + 1) {
          const gap = n - 1 === prev + 1 ? String(prev + 1) : `${prev + 1} - ${n - 1}`;
          rows.push({ kind: 'header', depth: 1, label: `*** Missing numbers here: ${gap} ***`, cells: {} });
        }
      }
      rows.push({
        kind: 'data',
        depth: 1,
        cells: { type: typeLabel(c.type, c.pay_method), num: c.num, date: c.date, name: nm(L, c.name_id), memo: c.memo, account: a.full_name, amount: -c.total },
        drill: txnDrill(c.id, c.type),
      });
    });
  }
  return { subtitle: rangeSubtitle(p), columns: BANK_COLS, rows };
}

/**
 * A bank (or credit card) account's cleared balance, the uncleared payments and
 * deposits, and the register balance, as of a date. A transaction counts as cleared
 * when all its lines in the account are marked cleared (as the register shows it).
 */
export function clearedListing(db: DB, p: Params): Built {
  const L = lookups(db);
  const id = p.extra.account_id as number | null;
  if (id === null) throw new AppError(400, 'Choose the account for this report.');
  const a = L.account.get(id);
  if (!a) throw new AppError(404, 'That account no longer exists.');
  const groups = db
    .prepare(
      `SELECT t.id, t.type, t.pay_method, t.date, t.num, t.name_id, t.memo, SUM(s.amount) AS amount, MIN(s.cleared) AS cleared
         FROM splits s JOIN txns t ON t.id = s.txn_id
        WHERE s.account_id = ? AND t.date <= ?
        GROUP BY t.id ORDER BY t.date, t.id`,
    )
    .all(id, p.as_of) as { id: number; type: string; pay_method: string; date: string; num: string; name_id: number | null; memo: string; amount: number; cleared: number }[];
  const sign = ['BANK', 'AR', 'OCA', 'FA'].includes(a.type) ? 1 : -1;
  let cleared = 0;
  const pay: typeof groups = [];
  const dep: typeof groups = [];
  for (const g of groups) {
    if (g.cleared) cleared += g.amount;
    else if (g.amount < 0) pay.push(g);
    else if (g.amount > 0) dep.push(g);
  }
  const row = (g: (typeof groups)[number]): Row => ({
    kind: 'data',
    depth: 1,
    cells: { type: typeLabel(g.type, g.pay_method), date: g.date, num: g.num, name: nm(L, g.name_id), memo: g.memo, amount: sign * g.amount },
    drill: txnDrill(g.id, g.type),
  });
  const sum = (l: typeof groups) => l.reduce((t, g) => t + g.amount, 0);
  const rows: Row[] = [
    { kind: 'subtotal', depth: 0, label: 'Cleared Balance', cells: { amount: sign * cleared } },
    { kind: 'header', depth: 0, label: 'Uncleared Checks and Payments', cells: {} },
    ...pay.map(row),
    { kind: 'subtotal', depth: 0, label: 'Total Uncleared Checks and Payments', cells: { amount: sign * sum(pay) } },
    { kind: 'header', depth: 0, label: 'Uncleared Deposits and Other Credits', cells: {} },
    ...dep.map(row),
    { kind: 'subtotal', depth: 0, label: 'Total Uncleared Deposits and Other Credits', cells: { amount: sign * sum(dep) } },
    { kind: 'total', depth: 0, label: `Register Balance as of ${formatUsDate(p.as_of)}`, cells: { amount: sign * (cleared + sum(pay) + sum(dep)) } },
  ];
  return {
    title: `${a.full_name}: Cleared and Uncleared`,
    subtitle: asOfSubtitle(p.as_of),
    columns: [col('type', 'Type'), col('date', 'Date', 'date'), col('num', 'Num'), col('name', 'Name'), col('memo', 'Memo'), col('amount', 'Amount', 'money')],
    rows,
  };
}
