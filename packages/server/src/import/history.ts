import {
  dueDate,
  NameInput,
  type AccountTypeCode,
  type ImportResult,
  type TxnInput,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { createAccount } from '../ledger/accounts';
import { systemAccount } from '../ledger/common';
import { blankHeader, importWriter, type Built, type Header, type ImportLink, type ImportSplit, type StoredLine } from '../ledger/posting';
import { createName } from '../lists/names';
import { importIif } from './iif';
import { parseJournals, type JournalFile, type JournalFileSummary, type JournalRow, type JournalTxn } from './journal';
import { CREDIT_QB_TYPES, norm, PAID_VALUES, TYPE_MAP } from './layout';
import { parseOpenDocs, type OpenDocsReport } from './reports';

// The history importer: a fresh company from QuickBooks' list export (IIF) and its
// Journal report export. See docs/IMPORT.md.
//
//  1. Lists from the IIF file (importIif).
//  2. Every Journal transaction becomes one RapidBooks transaction whose splits are the
//     Journal's rows, verbatim, in order (the posting engine's raw import path).
//  3. Payment and credit applications (which no export contains) are derived, aiming at
//     the open balances QuickBooks reports; deposits are linked to the payments in them.
//  4. Each document gets its header and lines, and is run through its ordinary builder.
//     If the builder reproduces the Journal's splits the document is an ordinary,
//     editable one; otherwise it is kept as posted and locked (import_locked).
//
// Everything happens in one database transaction.

export interface HistoryInput {
  iif: Uint8Array;
  /** The Journal export, or several (one per date range), read as one. */
  journal: Uint8Array | string | JournalFile[];
  /** Open Invoices (or A/R Aging Summary) export: the target open balances of invoices. */
  openInvoices?: Uint8Array | string;
  /** Unpaid Bills Detail (or A/P Aging Summary) export. */
  unpaidBills?: Uint8Array | string;
  /** The date those two reports are as of (default: the last transaction's date). */
  asOf?: string;
}

export interface TypeCount {
  qbType: string;
  rbType: string;
  read: number;
  imported: number;
  skipped: number;
  locked: number;
  rowsRead: number;
  rowsImported: number;
}

export interface Skipped {
  line: number;
  file?: string;
  transNo: string;
  qbType: string;
  date: string;
  num: string;
  reason: string;
}

export interface LockedTxn {
  id: number;
  qbType: string;
  date: string;
  num: string;
  category: string;
  note: string;
}

export interface HistoryResult {
  lists: ImportResult;
  journalColumns: string[];
  delimiter: string;
  /** One entry per Journal file, in date order. */
  journalFiles: JournalFileSummary[];
  /** Transactions found in two Journal files (overlapping dates), imported once. */
  journalDuplicates: number;
  rowsRead: number;
  txnsRead: number;
  txnsImported: number;
  rowsImported: number;
  byType: TypeCount[];
  skipped: Skipped[];
  locked: LockedTxn[];
  editable: number;
  /** Documents whose builder posts the same per account but splits lines differently. */
  editableRegrouped: number;
  links: { apply: number; deposit: number; depositRowsUnmatched: number };
  /** Customers / vendors whose QuickBooks open balances could not be reproduced. */
  unreproduced: { side: 'AR' | 'AP'; name: string; detail: string[] }[];
  targetsFrom: { AR: string; AP: string };
  createdAccounts: string[];
  createdNames: string[];
  warnings: string[];
  asOf: string;
  seconds: number;
  /** Seconds per phase (parse, lists, write, applications, check). */
  phases: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Lookups

interface AccountInfo {
  id: number;
  type: string;
  full: string;
}
interface NameInfo {
  id: number;
  kind: string;
  full: string;
  parent: number | null;
}
interface ItemInfo {
  id: number;
  type: string;
  account_id: number | null;
  purchase_account_id: number | null;
}

/**
 * Lookup key of an account or item name: lower case, and the inch mark " written as '
 * (the IIF list export writes 1' dia bar where the Journal has 1" dia bar).
 */
const nameKey = (s: string) => s.toLowerCase().replace(/"/g, "'");

class Lookups {
  accounts = new Map<string, AccountInfo>(); // lower full name
  accountById = new Map<number, AccountInfo>();
  leafAccounts = new Map<string, AccountInfo[]>();
  names = new Map<string, NameInfo>();
  nameById = new Map<number, NameInfo>();
  items = new Map<string, ItemInfo>();
  leafItems = new Map<string, ItemInfo[]>();
  terms = new Map<string, { id: number; net_days: number }>();

  constructor(private db: DB) {
    const accts = db.prepare('SELECT id, name, type, parent_id FROM accounts').all() as { id: number; name: string; type: string; parent_id: number | null }[];
    const byId = new Map(accts.map((a) => [a.id, a]));
    const full = (id: number): string => {
      const a = byId.get(id)!;
      return a.parent_id === null ? a.name : `${full(a.parent_id)}:${a.name}`;
    };
    for (const a of accts) this.addAccount({ id: a.id, type: a.type, full: full(a.id) });

    const names = db.prepare('SELECT id, name, kind, parent_id FROM names').all() as { id: number; name: string; kind: string; parent_id: number | null }[];
    const nById = new Map(names.map((n) => [n.id, n]));
    const nfull = (id: number): string => {
      const n = nById.get(id)!;
      return n.parent_id === null ? n.name : `${nfull(n.parent_id)}:${n.name}`;
    };
    for (const n of names) this.addName({ id: n.id, kind: n.kind, full: nfull(n.id), parent: n.parent_id });

    const items = db.prepare('SELECT id, name, type, parent_id, account_id, purchase_account_id FROM items').all() as (ItemInfo & { name: string; parent_id: number | null })[];
    const iById = new Map(items.map((i) => [i.id, i]));
    const ifull = (id: number): string => {
      const i = iById.get(id)!;
      return i.parent_id === null ? i.name : `${ifull(i.parent_id)}:${i.name}`;
    };
    for (const i of items) {
      const info = { id: i.id, type: i.type, account_id: i.account_id, purchase_account_id: i.purchase_account_id };
      this.items.set(nameKey(ifull(i.id)), info);
      const leaf = nameKey(i.name);
      this.leafItems.set(leaf, [...(this.leafItems.get(leaf) ?? []), info]);
    }
    for (const t of db.prepare('SELECT id, name, net_days FROM terms').all() as { id: number; name: string; net_days: number }[]) {
      this.terms.set(t.name.toLowerCase(), { id: t.id, net_days: t.net_days });
    }
  }

  /** Accounts the import had to create; found only when nothing on the lists matches. */
  created = new Map<string, AccountInfo>();

  addAccount(a: AccountInfo, created = false) {
    this.accountById.set(a.id, a);
    if (created) {
      this.created.set(nameKey(a.full), a);
      return;
    }
    this.accounts.set(nameKey(a.full), a);
    const leaf = nameKey(a.full.split(':').pop()!);
    this.leafAccounts.set(leaf, [...(this.leafAccounts.get(leaf) ?? []), a]);
  }

  addName(n: NameInfo) {
    this.names.set(n.full.toLowerCase(), n);
    this.nameById.set(n.id, n);
  }

  /**
   * The account a Journal row names. A last name alone ("tooling") that several accounts
   * share is narrowed by the row's Account Type, then by the accounts its item posts to.
   */
  findAccount(full: string, type = '', hint: (number | null)[] = []): AccountInfo | undefined {
    const k = nameKey(full);
    const hit = this.accounts.get(k);
    if (k.includes(':')) return hit ?? this.created.get(k);
    // A name without a colon may be a top-level account or the last part of any account:
    // narrow by the row's Account Type, then the exact capitalisation (the Journal keeps
    // each account's own: "Swiss" vs "swiss"), then the accounts the row's item posts to.
    let leaf = this.leafAccounts.get(k) ?? [];
    const narrow = (keep: (a: AccountInfo) => boolean) => {
      const n = leaf.filter(keep);
      if (n.length) leaf = n;
    };
    if (leaf.length > 1 && type) narrow((a) => a.type === type);
    if (leaf.length > 1) narrow((a) => a.full.split(':').pop()!.replace(/"/g, "'") === full.trim().replace(/"/g, "'"));
    if (leaf.length > 1 && hint.length) narrow((a) => hint.includes(a.id));
    if (leaf.length === 1) return leaf[0];
    if (hit && leaf.includes(hit)) return hit; // still several: the top-level one, as written
    return this.created.get(k);
  }

  findItem(full: string): ItemInfo | undefined {
    const k = nameKey(full);
    const hit = this.items.get(k);
    if (hit) return hit;
    const leaf = this.leafItems.get(k.split(':').pop()!);
    return leaf && leaf.length === 1 ? leaf[0] : undefined;
  }

  /** The name and all its ancestors' ids. */
  ancestors(id: number): number[] {
    const out: number[] = [];
    let p: number | null = id;
    while (p !== null && !out.includes(p)) {
      out.push(p);
      p = this.nameById.get(p)?.parent ?? null;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Planning one transaction

interface Plan {
  qb: JournalTxn;
  type: string; // RapidBooks type (or QuickBooks' name for types without a form)
  qbType: string;
  date: string;
  header: Header;
  splits: ImportSplit[];
  rows: JournalRow[];
  isFinanceCharge: boolean;
  payMethod: string; // bill payments: 'check' | 'other'
  id: number;
  /** Set when the transaction is locked whatever its builder says. */
  lockCategory?: string;
  lockNote?: string;
  /** A/R or A/P role for applications. */
  role?: Role;
}

interface Role {
  side: 'AR' | 'AP';
  kind: 'doc' | 'credit';
  nameId: number;
  account: number; // the A/R or A/P account
  amount: number; // doc total, or credit amount incl. discount
  discount: number; // payments: discount part of amount
  discountAccount: number | null;
  target: number | null; // QuickBooks' open balance (doc) or unapplied amount (credit); null = unknown
  remaining: number;
  plan: Plan;
  order: number;
}

const CATEGORY = {
  paycheck: 'Paycheck: its payroll items are not in the export',
  noForm: 'No RapidBooks form for this QuickBooks type',
  refused: 'The form would refuse it as it stands',
  differs: 'Its lines post differently in RapidBooks (an item or account has changed since)',
  shape: 'Its rows do not have the shape the form expects',
};

const AR_TYPES = new Set(['INVOICE', 'CREDITMEMO', 'PAYMENT']);
const AP_TYPES = new Set(['BILL', 'BILLCREDIT', 'BILLPMT']);

const money = (c: number) => {
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return c < 0 ? `-${s}` : s;
};

function numKey(num: string): [number, string] {
  const m = /^\d+/.exec(num);
  return [m ? Number(m[0]) : Number.MAX_SAFE_INTEGER, num];
}
function byDateNum(a: Role, b: Role) {
  if (a.plan.date !== b.plan.date) return a.plan.date < b.plan.date ? -1 : 1;
  const [an, as] = numKey(a.plan.header.num);
  const [bn, bs] = numKey(b.plan.header.num);
  if (an !== bn) return an - bn;
  if (as !== bs) return as < bs ? -1 : 1;
  return a.order - b.order;
}

// ---------------------------------------------------------------------------

export function importHistory(db: DB, input: HistoryInput): HistoryResult {
  const started = Date.now();
  const has = db.prepare('SELECT COUNT(*) AS n FROM txns').get() as { n: number };
  if (has.n > 0) throw new AppError(400, 'History can only be imported into a new, empty company file. This one already has transactions.');

  let mark = Date.now();
  const phase = (name: string) => {
    const now = Date.now();
    result.phases[name] = (now - mark) / 1000;
    mark = now;
  };
  const journal = parseJournals(Array.isArray(input.journal) ? input.journal : [{ name: 'journal', data: input.journal }]);
  const openInv = input.openInvoices !== undefined ? parseOpenDocs(input.openInvoices, 'Open Invoices') : null;
  const unpaid = input.unpaidBills !== undefined ? parseOpenDocs(input.unpaidBills, 'Unpaid Bills') : null;

  const warnCounts = new Map<string, number>();
  const warn = (m: string) => warnCounts.set(m, (warnCounts.get(m) ?? 0) + 1);
  journal.warnings.forEach(warn);
  openInv?.warnings.forEach(warn);
  unpaid?.warnings.forEach(warn);

  const result: HistoryResult = {
    lists: { counts: { accounts: 0, terms: 0, customers: 0, jobs: 0, vendors: 0, employees: 0, other_names: 0, items: 0 }, ignored_record_types: [], warnings: [] },
    journalColumns: journal.columns,
    journalFiles: journal.files,
    journalDuplicates: journal.duplicates,
    delimiter: journal.delimiter === '\t' ? 'tab' : 'comma',
    rowsRead: journal.rowsRead,
    txnsRead: journal.txns.length,
    txnsImported: 0,
    rowsImported: 0,
    byType: [],
    skipped: [],
    locked: [],
    editable: 0,
    editableRegrouped: 0,
    links: { apply: 0, deposit: 0, depositRowsUnmatched: 0 },
    unreproduced: [],
    targetsFrom: { AR: 'none', AP: 'none' },
    createdAccounts: [],
    createdNames: [],
    warnings: [],
    asOf: '',
    seconds: 0,
    phases: {},
  };
  phase('parse');
  const counts = new Map<string, TypeCount>();
  const countOf = (qbType: string, rbType: string) => {
    const k = qbType || '(no type)';
    let c = counts.get(k);
    if (!c) {
      c = { qbType: k, rbType, read: 0, imported: 0, skipped: 0, locked: 0, rowsRead: 0, rowsImported: 0 };
      counts.set(k, c);
    }
    return c;
  };

  // The builders prepare their SQL on every call; over tens of thousands of documents
  // compiling it again dominates the import, so statements are reused while it runs.
  const prepare = db.prepare;
  const statements = new Map<string, ReturnType<DB['prepare']>>();
  db.prepare = ((sql: string) => {
    let s = statements.get(sql);
    if (!s) {
      s = prepare.call(db, sql);
      statements.set(sql, s);
    }
    return s;
  }) as DB['prepare'];
  try {
    run();
  } finally {
    db.prepare = prepare;
  }

  result.byType = [...counts.values()].sort((a, b) => b.read - a.read || a.qbType.localeCompare(b.qbType));
  result.warnings = [...warnCounts].map(([m, n]) => (n > 1 ? `${m} (${n} times)` : m));
  result.seconds = (Date.now() - started) / 1000;
  return result;

  function run() {
  db.transaction(() => {
    result.lists = importIif(db, input.iif);
    const L = new Lookups(db);
    const uf = systemAccount(db, 'UNDEPOSITED');
    const W = importWriter(db);

    // --- Which transactions can be imported at all.
    const good: { qb: JournalTxn; type: string; map: (typeof TYPE_MAP)[string] | undefined }[] = [];
    for (const qb of journal.txns) {
      const map = TYPE_MAP[norm(qb.qbType)];
      const type = map?.type ?? (qb.qbType || 'Journal');
      const c = countOf(qb.qbType, map?.type ?? '(journal-style)');
      c.read++;
      c.rowsRead += qb.rows.length;
      const skip = (reason: string) => {
        c.skipped++;
        result.skipped.push({ line: qb.line, file: qb.file, transNo: qb.transNo, qbType: qb.qbType, date: qb.rawDate, num: qb.num, reason });
      };
      if (qb.problems.length > 0) {
        skip(qb.problems.join('; '));
        continue;
      }
      if (qb.date === null) {
        skip(qb.rawDate === '' ? 'it has no date' : `its date "${qb.rawDate}" cannot be read`);
        continue;
      }
      const dr = qb.rows.reduce((t, r) => t + (r.amount > 0 ? r.amount : 0), 0);
      const cr = qb.rows.reduce((t, r) => t + (r.amount < 0 ? -r.amount : 0), 0);
      if (dr !== cr) {
        skip(`it does not balance in the file: debits ${money(dr)}, credits ${money(cr)}`);
        continue;
      }
      good.push({ qb, type, map });
    }

    // --- Names not on the lists: decide their kind from how they are used, then create them.
    const votes = new Map<string, { full: string; kind: Set<string> }>();
    const vote = (name: string, kind: string) => {
      if (name === '' || L.names.has(name.toLowerCase())) return;
      const k = name.toLowerCase();
      const v = votes.get(k) ?? { full: name, kind: new Set<string>() };
      v.kind.add(kind);
      votes.set(k, v);
    };
    const kindOfType = (t: string) =>
      AR_TYPES.has(t) ? 'customer' : AP_TYPES.has(t) ? 'vendor' : t === 'PAYCHECK' ? 'employee' : 'other';
    // Accounts used on each row, for the type of an account that has to be created.
    for (const { qb, type } of good) {
      const head = qb.rows[0].name || qb.rows[0].source;
      vote(head, kindOfType(type));
      for (const r of qb.rows) {
        const a = L.findAccount(r.account, r.accountType);
        if (a?.type === 'AR') vote(r.name, 'customer');
        else if (a?.type === 'AP') vote(r.name, 'vendor');
        else vote(r.name, 'other');
      }
    }
    const order = ['customer', 'vendor', 'employee', 'other'];
    const pending = [...votes.values()].sort((a, b) => a.full.split(':').length - b.full.split(':').length);
    for (const v of pending) {
      if (L.names.has(v.full.toLowerCase())) continue;
      const segs = v.full.split(':').map((s) => s.trim());
      const kind = segs.length > 1 ? 'customer' : order.find((k) => v.kind.has(k))!;
      let parent: number | null = null;
      for (let i = 0; i < segs.length; i++) {
        const full = segs.slice(0, i + 1).join(':');
        const hit = L.names.get(full.toLowerCase());
        if (hit) {
          parent = hit.id;
          continue;
        }
        const id = createName(db, NameInput.parse({ kind, name: segs[i] || '(blank)', parent_id: parent, inactive: true }));
        L.addName({ id, kind, full, parent });
        result.createdNames.push(`${full} (${kind})`);
        parent = id;
      }
    }

    const nameId = (s: string): number | null => (s === '' ? null : (L.names.get(s.toLowerCase())?.id ?? null));

    // --- Accounts not on the lists.
    const guessType = (full: string, type: string, rowIndex: number, amount: number): AccountTypeCode => {
      const k = full.toLowerCase();
      if (k.includes('receivable')) return 'AR';
      if (k.includes('payable')) return 'AP';
      if (k.includes('undeposited')) return 'OCA';
      const first = rowIndex === 0;
      switch (type) {
        case 'INVOICE':
        case 'CREDITMEMO':
          return first ? 'AR' : 'INC';
        case 'BILL':
        case 'BILLCREDIT':
          return first ? 'AP' : 'EXP';
        case 'CHECK':
        case 'BILLPMT':
        case 'PAYCHECK':
        case 'DEPOSIT':
        case 'TRANSFER':
          return first ? 'BANK' : type === 'DEPOSIT' ? 'INC' : 'EXP';
        case 'PAYMENT':
          return amount > 0 ? 'BANK' : 'AR';
        default:
          return amount > 0 ? 'EXP' : 'INC';
      }
    };
    const accountId = (r: JournalRow, type: string, rowIndex: number): number => {
      const full = r.account;
      const item = r.item ? L.findItem(r.item) : undefined;
      const hit = L.findAccount(full, r.accountType, item ? [item.account_id, item.purchase_account_id] : []);
      if (hit) return hit.id;
      const segs = full.split(':').map((s) => s.trim());
      let parent: AccountInfo | undefined;
      for (let i = 0; i < segs.length; i++) {
        const f = segs.slice(0, i + 1).join(':');
        const h = L.accounts.get(nameKey(f)) ?? L.created.get(nameKey(f));
        if (h) {
          parent = h;
          continue;
        }
        const own = i === segs.length - 1 ? (r.accountType as AccountTypeCode) : undefined;
        const t = own || ((parent?.type as AccountTypeCode | undefined) ?? guessType(full, type, rowIndex, r.amount));
        const id = createAccount(db, { name: segs[i] || '(blank)', type: t, parent_id: parent?.id ?? null, description: 'Created by the QuickBooks history import', inactive: true });
        parent = { id, type: t, full: f };
        L.addAccount(parent, true);
        result.createdAccounts.push(`${f} (${t})`);
        warn(`Account "${f}" is not in the list export (renamed or deleted since?); it was created as an inactive ${t} account. Check its type in the chart of accounts.`);
      }
      return parent!.id;
    };

    phase("lists");
    // --- Plan and write every transaction (header and splits, verbatim).
    const plans: Plan[] = [];
    for (const { qb, type, map } of good) {
      const rows = qb.rows;
      const splits: ImportSplit[] = rows.map((r, i) => ({
        account_id: accountId(r, type, i),
        amount: r.amount,
        name_id: nameId(r.name),
        memo: r.memo,
        cleared: r.cleared,
      }));
      const first = rows[0];
      const headName = nameId(first.name || first.source);
      const header = blankHeader({ date: qb.date!, num: qb.num, name_id: headName, memo: first.memo });
      const plan: Plan = {
        qb,
        type,
        qbType: qb.qbType,
        date: qb.date!,
        header,
        splits,
        rows,
        isFinanceCharge: !!map?.financeCharge,
        payMethod: map?.payMethod ?? '',
        id: 0,
      };
      fillHeader(plan, L, uf);
      plan.id = W.txn({ type, header: plan.header, splits, is_finance_charge: plan.isFinanceCharge, qb_type: qb.qbType, qb_trans_no: qb.transNo });
      plans.push(plan);
      const c = countOf(qb.qbType, map?.type ?? '(journal-style)');
      c.imported++;
      c.rowsImported += rows.length;
      result.txnsImported++;
      result.rowsImported += rows.length;
    }

    phase("write");
    // --- Applications.
    const asOf = input.asOf ?? plans.reduce((m, p) => (p.date > m ? p.date : m), '0000-00-00');
    result.asOf = asOf;
    const roles: Role[] = [];
    plans.forEach((p, order) => {
      const r = roleOf(p, L, order);
      if (r) {
        p.role = r;
        roles.push(r);
      }
    });
    result.targetsFrom.AR = setTargets(roles, 'AR', openInv, journal.columns, asOf, L, warn, 'Open Invoices');
    result.targetsFrom.AP = setTargets(roles, 'AP', unpaid, journal.columns, asOf, L, warn, 'Unpaid Bills');
    const applyLinks = allocate(roles, L, result);
    const depositLinks = linkDeposits(plans, uf, result);
    W.links(applyLinks);
    W.links(depositLinks);
    result.links.apply = applyLinks.length;
    result.links.deposit = depositLinks.length;
    const linksFrom = new Map<number, ImportLink[]>();
    for (const l of [...applyLinks, ...depositLinks]) linksFrom.set(l.from_txn, [...(linksFrom.get(l.from_txn) ?? []), l]);

    phase("applications");
    // --- Document detail, then check each document against its builder.
    const missingItems = new Map<string, number>();
    for (const p of plans) {
      const c = counts.get(p.qbType || '(no type)')!;
      const lock = (category: string, note: string, lines: StoredLine[]) => {
        W.lock(p.id, note);
        if (lines.length) W.lines(p.id, lines);
        c.locked++;
        result.locked.push({ id: p.id, qbType: p.qbType, date: p.date, num: p.header.num, category, note });
      };
      if (p.lockCategory) {
        lock(p.lockCategory, p.lockNote ?? p.lockCategory, []);
        continue;
      }
      if (p.type === 'GENJRNL') {
        result.editable++;
        continue;
      }
      const variants = inputsFor(p, L, linksFrom.get(p.id) ?? [], uf, missingItems);
      if (typeof variants === 'string') {
        lock(CATEGORY.shape, variants, []);
        continue;
      }
      let outcome: { ok: true; built: Built; regrouped: boolean } | { ok: false; category: string; note: string } = {
        ok: false,
        category: CATEGORY.shape,
        note: 'no form input could be made',
      };
      for (const v of variants) {
        let built: Built;
        try {
          built = W.rebuild(v, p.id);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          if (outcome.ok === false && outcome.category === CATEGORY.shape) outcome = { ok: false, category: CATEGORY.refused, note: e.message };
          continue;
        }
        const cmp = compareSplits(p.splits, built.splits, L);
        if (cmp.same) {
          outcome = { ok: true, built, regrouped: cmp.regrouped };
          break;
        }
        if (outcome.ok === false && outcome.category !== CATEGORY.differs) outcome = { ok: false, category: CATEGORY.differs, note: cmp.note };
      }
      if (outcome.ok) {
        if (outcome.built.lines) W.lines(p.id, outcome.built.lines);
        result.editable++;
        if (outcome.regrouped) result.editableRegrouped++;
      } else {
        lock(outcome.category, outcome.note, fallbackLines(p, L));
      }
    }
    phase("check");
    for (const [item, n] of missingItems) {
      warn(`Item "${item}" is not on the item list; ${n} line(s) using it were imported as plain account lines.`);
    }

    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
      'import',
      null,
      JSON.stringify({ transactions: result.txnsImported, rows: result.rowsImported, skipped: result.skipped.length, locked: result.locked.length }),
    );
  })();
  }
}

// ---------------------------------------------------------------------------
// Header fields

function fillHeader(p: Plan, L: Lookups, uf: number) {
  const h = p.header;
  const rows = p.rows;
  const first = rows[0];
  const acct = (i: number) => L.accountById.get(p.splits[i].account_id)!;
  const firstOfType = (t: string) => p.splits.findIndex((s) => L.accountById.get(s.account_id)?.type === t);
  const sumOn = (id: number) => p.splits.filter((s) => s.account_id === id).reduce((t, s) => t + s.amount, 0);
  const terms = first.terms ? L.terms.get(first.terms.toLowerCase()) ?? null : null;
  const address = rows.find((r) => r.address)?.address ?? '';
  const debits = p.splits.reduce((t, s) => t + (s.amount > 0 ? s.amount : 0), 0);
  h.total = debits;

  switch (p.type) {
    case 'INVOICE':
    case 'CREDITMEMO': {
      const ar = firstOfType('AR');
      if (ar >= 0) {
        h.ar_account_id = p.splits[ar].account_id;
        h.total = Math.abs(sumOn(h.ar_account_id));
      }
      h.terms_id = terms?.id ?? null;
      h.due_date = first.dueDate ?? (p.type === 'INVOICE' ? dueDate(terms, p.date) : '');
      h.po_number = rows.find((r) => r.po)?.po ?? '';
      h.ship_date = rows.find((r) => r.shipDate)?.shipDate ?? '';
      h.ship_via = rows.find((r) => r.via)?.via ?? '';
      h.bill_addr = address;
      break;
    }
    case 'PAYMENT': {
      const ar = firstOfType('AR');
      if (ar >= 0) h.ar_account_id = p.splits[ar].account_id;
      const dep = p.splits.findIndex((s) => s.amount > 0 && L.accountById.get(s.account_id)?.type !== 'AR');
      if (dep >= 0) {
        h.account_id = p.splits[dep].account_id;
        h.total = p.splits[dep].amount;
      }
      h.pay_method = rows.find((r) => r.payMeth)?.payMeth ?? '';
      h.ref_no = p.qb.num;
      break;
    }
    case 'DEPOSIT':
      h.name_id = null;
      h.account_id = p.splits[0].account_id;
      h.total = p.splits[0].amount;
      break;
    case 'BILL':
    case 'BILLCREDIT': {
      const ap = firstOfType('AP');
      if (ap >= 0) {
        h.ap_account_id = p.splits[ap].account_id;
        h.total = Math.abs(sumOn(h.ap_account_id));
      }
      h.ref_no = p.qb.num;
      h.terms_id = terms?.id ?? null;
      h.due_date = p.type === 'BILL' ? (first.dueDate ?? dueDate(terms, p.date)) : '';
      h.bill_addr = address;
      break;
    }
    case 'BILLPMT': {
      const ap = firstOfType('AP');
      if (ap >= 0) h.ap_account_id = p.splits[ap].account_id;
      h.account_id = p.splits[0].account_id;
      h.total = -p.splits[0].amount;
      h.pay_method = p.payMethod || 'check';
      h.bill_addr = address;
      break;
    }
    case 'CHECK': {
      h.account_id = p.splits[0].account_id;
      h.total = -p.splits[0].amount;
      h.bill_addr = address;
      // A refund check to a customer debits A/R; QuickBooks applies the customer's
      // payments and credits to it like an invoice.
      const ar = firstOfType('AR');
      if (ar >= 0 && p.header.name_id !== null && sumOn(p.splits[ar].account_id) > 0) h.ar_account_id = p.splits[ar].account_id;
      break;
    }
    case 'TRANSFER': {
      h.name_id = null;
      const from = p.splits.find((s) => s.amount < 0);
      const to = p.splits.find((s) => s.amount > 0);
      h.account_id = from?.account_id ?? null;
      h.to_account_id = to?.account_id ?? null;
      h.total = to?.amount ?? 0;
      break;
    }
    case 'PAYCHECK':
      h.account_id = p.splits[0].account_id;
      h.total = -p.splits[0].amount;
      h.bill_addr = address;
      p.lockCategory = CATEGORY.paycheck;
      p.lockNote = `a paycheck: its payroll items are not in QuickBooks' export, so it was imported as posted (net pay ${money(h.total)} from ${acct(0).full})`;
      break;
    case 'GENJRNL':
      break;
    default:
      // A QuickBooks type without a RapidBooks form: journal-style, under its own type name.
      h.account_id = p.splits[0].account_id;
      if (CREDIT_QB_TYPES.has(norm(p.qbType))) {
        const ar = firstOfType('AR');
        const ap = firstOfType('AP');
        if (ar >= 0) h.ar_account_id = p.splits[ar].account_id;
        else if (ap >= 0) h.ap_account_id = p.splits[ap].account_id;
      }
      p.lockCategory = `${CATEGORY.noForm}: ${p.qbType}`;
      p.lockNote = `QuickBooks type "${p.qbType}" has no form in RapidBooks, so it was imported as posted`;
  }
}

// ---------------------------------------------------------------------------
// Applications

function roleOf(p: Plan, L: Lookups, order: number): Role | undefined {
  const credit = CREDIT_QB_TYPES.has(norm(p.qbType));
  const refund = p.type === 'CHECK' && p.header.ar_account_id !== null;
  const side =
    AR_TYPES.has(p.type) || refund || (credit && p.header.ar_account_id !== null)
      ? 'AR'
      : AP_TYPES.has(p.type) || (credit && p.header.ap_account_id !== null)
        ? 'AP'
        : null;
  if (!side || p.header.name_id === null) return undefined;
  const account = side === 'AR' ? p.header.ar_account_id : p.header.ap_account_id;
  if (account === null) return undefined;
  const onAccount = p.splits.filter((s) => s.account_id === account).reduce((t, s) => t + s.amount, 0);
  const kind: Role['kind'] = p.type === 'INVOICE' || p.type === 'BILL' || refund ? 'doc' : 'credit';
  // A/R docs are debits, A/R credits credits; A/P the other way round.
  const amount = side === 'AR' ? (kind === 'doc' ? onAccount : -onAccount) : kind === 'doc' ? -onAccount : onAccount;
  if (amount <= 0) return undefined;
  let discount = 0;
  let discountAccount: number | null = null;
  if (p.type === 'PAYMENT' || p.type === 'BILLPMT') {
    discount = Math.max(0, amount - p.header.total);
    if (discount > 0) {
      const sign = p.type === 'PAYMENT' ? 1 : -1;
      const d = p.splits.find(
        (s, i) => s.account_id !== account && s.account_id !== p.header.account_id && Math.sign(s.amount) === sign && i > 0,
      );
      discountAccount = d?.account_id ?? null;
    }
  }
  void L;
  return { side, kind, nameId: p.header.name_id, account, amount, discount, discountAccount, target: null, remaining: amount, plan: p, order };
}

/**
 * The open balances QuickBooks reports, as targets for the allocation: from the
 * verification report when given (anything dated on or before asOf that it does not list
 * is fully applied), else from the Journal's Open Balance or Paid column.
 */
function setTargets(
  roles: Role[],
  side: 'AR' | 'AP',
  report: OpenDocsReport | null,
  columns: string[],
  asOf: string,
  L: Lookups,
  warn: (m: string) => void,
  what: string,
): string {
  const mine = roles.filter((r) => r.side === side);
  if (report && report.format === 'detail') {
    const index = new Map<string, Role[]>();
    const keyOf = (name: string, kind: string, num: string, date: string) => `${name.toLowerCase()}|${kind}|${num.toLowerCase()}|${date}`;
    for (const r of mine) {
      const name = L.nameById.get(r.nameId)?.full ?? '';
      for (const k of [keyOf(name, r.kind, r.plan.header.num, r.plan.date), keyOf(name, r.kind, r.plan.header.num, ''), keyOf(name, r.kind, '', r.plan.date)]) {
        index.set(k, [...(index.get(k) ?? []), r]);
      }
    }
    for (const r of mine) if (r.plan.date <= asOf) r.target = 0;
    for (const d of report.docs) {
      const kind = d.mapped === 'INVOICE' || d.mapped === 'BILL' ? 'doc' : 'credit';
      const tries = [keyOf(d.name, kind, d.num, d.date ?? ''), keyOf(d.name, kind, d.num, ''), keyOf(d.name, kind, '', d.date ?? '')];
      let hit: Role | undefined;
      for (const k of tries) {
        const c = (index.get(k) ?? []).filter((r) => !(r as Role & { matched?: boolean }).matched);
        if (c.length >= 1) {
          hit = c[0];
          break;
        }
      }
      if (!hit) {
        warn(`${what} report line ${d.line} (${d.qbType} ${d.num} of ${d.date ?? '?'} for ${d.name}, ${money(d.open)}) matches no imported transaction.`);
        continue;
      }
      (hit as Role & { matched?: boolean }).matched = true;
      hit.target = Math.abs(d.open);
    }
    return `the ${what} report`;
  }
  if (columns.includes('openBalance')) {
    for (const r of mine) {
      const acctRow = r.plan.rows.find((row, i) => r.plan.splits[i].account_id === r.account && row.openBalance !== null);
      const any = acctRow ?? r.plan.rows.find((row) => row.openBalance !== null);
      if (any) r.target = Math.abs(any.openBalance!);
    }
    return "the Journal's Open Balance column";
  }
  if (columns.includes('paid')) {
    for (const r of mine) {
      const paid = r.plan.rows.find((row) => row.paid !== '')?.paid ?? '';
      if (PAID_VALUES.has(paid.toLowerCase())) r.target = 0;
    }
    return "the Journal's Paid column (paid documents only)";
  }
  return 'none (oldest first)';
}

/**
 * Apply credits (payments, credit memos, bill payments, bill credits) to documents
 * (invoices, bills): most specific name first (jobs before their customer), then oldest
 * credit first, each to the oldest open document it may pay, never more than the
 * document's capacity (its total less the open balance QuickBooks says it still has).
 */
function allocate(roles: Role[], L: Lookups, result: HistoryResult): ImportLink[] {
  const links: ImportLink[] = [];
  for (const r of roles) r.remaining = r.amount - Math.min(r.amount, r.target ?? 0);
  const problems = new Map<string, { side: 'AR' | 'AP'; name: string; detail: string[] }>();
  const problem = (r: Role, msg: string) => {
    const top = L.ancestors(r.nameId).pop()!;
    const name = L.nameById.get(top)?.full ?? '?';
    const k = `${r.side}|${name}`;
    const e = problems.get(k) ?? { side: r.side, name, detail: [] };
    e.detail.push(msg);
    problems.set(k, e);
  };
  for (const r of roles) {
    if (r.target !== null && r.target > r.amount) {
      problem(r, `${describe(r, L)} is ${money(r.amount)} but QuickBooks shows ${money(r.target)} open`);
    }
  }

  // Documents by (side, account, name), oldest first.
  const docs = new Map<string, Role[]>();
  for (const r of roles) {
    if (r.kind !== 'doc') continue;
    const k = `${r.side}|${r.account}|${r.nameId}`;
    docs.set(k, [...(docs.get(k) ?? []), r]);
  }
  for (const list of docs.values()) list.sort(byDateNum);
  // Names below each name (itself, its jobs, their jobs).
  const below = new Map<number, number[]>();
  for (const n of L.nameById.values()) {
    for (const a of L.ancestors(n.id)) below.set(a, [...(below.get(a) ?? []), n.id]);
  }
  const eligible = new Map<string, Role[]>();
  const eligibleFor = (c: Role): Role[] => {
    const k = `${c.side}|${c.account}|${c.nameId}`;
    let list = eligible.get(k);
    if (!list) {
      const ids = c.side === 'AR' ? (below.get(c.nameId) ?? [c.nameId]) : [c.nameId];
      list = ids.flatMap((id) => docs.get(`${c.side}|${c.account}|${id}`) ?? []).sort(byDateNum);
      eligible.set(k, list);
    }
    return list;
  };
  const depth = (id: number) => L.ancestors(id).length;
  const credits = roles
    .filter((r) => r.kind === 'credit')
    .sort((a, b) => depth(b.nameId) - depth(a.nameId) || byDateNum(a, b));
  const start = new Map<Role[], number>();
  for (const c of credits) {
    if (c.remaining <= 0) continue;
    const list = eligibleFor(c);
    let i = start.get(list) ?? 0;
    while (i < list.length && list[i].remaining <= 0) i++;
    start.set(list, i);
    let discountLeft = c.discount;
    for (let j = i; j < list.length && c.remaining > 0; j++) {
      const d = list[j];
      if (d.remaining <= 0) continue;
      const amt = Math.min(c.remaining, d.remaining);
      c.remaining -= amt;
      d.remaining -= amt;
      const disc = Math.min(discountLeft, amt);
      discountLeft -= disc;
      links.push({
        from_txn: c.plan.id,
        to_txn: d.plan.id,
        kind: 'apply',
        amount: amt - disc,
        discount: disc,
        discount_account_id: disc > 0 ? c.discountAccount : null,
      });
    }
  }
  for (const r of roles) {
    if (r.target === null || r.remaining === 0) continue;
    const isOpen = r.target + r.remaining;
    problem(
      r,
      r.kind === 'doc'
        ? `${describe(r, L)} stays open ${money(isOpen)}; QuickBooks shows ${money(r.target)}`
        : `${describe(r, L)} has ${money(isOpen)} unapplied; QuickBooks shows ${money(r.target)}`,
    );
  }
  result.unreproduced = [...problems.values()].sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
  return links;
}

const DOC_LABEL: Record<string, string> = {
  INVOICE: 'invoice',
  CREDITMEMO: 'credit memo',
  PAYMENT: 'payment',
  BILL: 'bill',
  BILLCREDIT: 'bill credit',
  BILLPMT: 'bill payment',
  Discount: 'discount',
  CHECK: 'refund check',
};

function describe(r: Role, L: Lookups): string {
  const p = r.plan;
  const [y, m, d] = p.date.split('-');
  return `${DOC_LABEL[p.type] ?? p.type}${p.header.num ? ` ${p.header.num}` : ''} of ${m}/${d}/${y} (${L.nameById.get(r.nameId)?.full ?? ''}, ${money(r.amount)})`;
}

/** Link each deposit's Undeposited Funds rows to earlier payments of the same customer and amount, oldest first. */
function linkDeposits(plans: Plan[], uf: number, result: HistoryResult): ImportLink[] {
  const byKey = new Map<string, Plan[]>();
  for (const p of plans) {
    if (p.type !== 'PAYMENT' || p.header.account_id !== uf || p.lockCategory) continue;
    for (const k of [`${p.header.name_id}|${p.header.total}`, `*|${p.header.total}`]) byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  for (const list of byKey.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const used = new Set<number>();
  const links: ImportLink[] = [];
  const deposits = plans.filter((p) => p.type === 'DEPOSIT').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  for (const d of deposits) {
    d.splits.forEach((s, i) => {
      if (i === 0 || s.account_id !== uf || s.amount >= 0) return;
      const list = byKey.get(`${s.name_id ?? '*'}|${-s.amount}`) ?? [];
      const hit = list.find((p) => !used.has(p.id) && p.date <= d.date);
      if (!hit) {
        result.links.depositRowsUnmatched++;
        return;
      }
      used.add(hit.id);
      links.push({ from_txn: d.id, to_txn: hit.id, kind: 'deposit', amount: hit.header.total, discount: 0, discount_account_id: null });
      (d as Plan & { depositRows?: Set<number> }).depositRows ??= new Set();
      (d as Plan & { depositRows?: Set<number> }).depositRows!.add(i);
    });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Form inputs for the builder check

const rate3 = (v: number) => Math.round(v * 100 * 1000) / 1000; // dollars -> cents, 3 decimals

/**
 * The form input(s) to try for a document, most faithful first. A string means the
 * rows do not have the shape the form needs (the transaction is locked with that note).
 */
function inputsFor(p: Plan, L: Lookups, links: ImportLink[], uf: number, missing: Map<string, number>): TxnInput[] | string {
  const h = p.header;
  const base = { date: p.date, num: h.num, name_id: h.name_id, memo: h.memo };
  const rest = p.rows.map((r, i) => ({ r, s: p.splits[i], i }));
  const noteMissing = (item: string) => missing.set(item, (missing.get(item) ?? 0) + 1);
  const customerOn = (nameId: number | null) =>
    nameId !== null && nameId !== h.name_id && L.nameById.get(nameId)?.kind === 'customer' ? nameId : null;

  switch (p.type) {
    case 'INVOICE':
    case 'CREDITMEMO': {
      if (h.ar_account_id === null) return 'it has no Accounts Receivable line';
      const sign = p.type === 'INVOICE' ? -1 : 1;
      const lineRows = rest.filter(({ s }) => s.account_id !== h.ar_account_id);
      const make = (percent: boolean) =>
        lineRows.map(({ r, s }) => {
          const amount = sign * s.amount;
          const desc = r.itemDesc || r.memo;
          const item = r.item ? L.findItem(r.item) : undefined;
          if (r.item && !item && percent) noteMissing(r.item);
          if (item) {
            const isPct = !!r.price?.percent && percent;
            let qty = r.qty;
            if (qty !== null && r.price && !r.price.percent && Math.sign(qty * r.price.value) === -Math.sign(amount)) qty = -qty;
            return {
              item_id: item.id,
              description: desc,
              qty: isPct ? null : qty,
              rate: r.price ? (isPct ? Math.round(Math.abs(r.price.value) * 100) : r.price.percent ? null : rate3(r.price.value)) : null,
              rate_is_percent: isPct,
              amount,
              account_id: null,
            };
          }
          if (amount === 0 && !r.item) return { item_id: null, description: desc, qty: null, rate: null, rate_is_percent: false, amount: null, account_id: null };
          return {
            item_id: null,
            description: r.item ? `${r.item}${desc ? `: ${desc}` : ''}` : desc,
            qty: null,
            rate: null,
            rate_is_percent: false,
            amount,
            account_id: s.account_id,
          };
        });
      const doc = (percent: boolean): TxnInput => ({
        type: p.type as 'INVOICE',
        ...base,
        ar_account_id: h.ar_account_id,
        terms_id: h.terms_id,
        due_date: h.due_date,
        po_number: h.po_number,
        ship_date: h.ship_date,
        ship_via: h.ship_via,
        bill_addr: h.bill_addr,
        ship_addr: h.ship_addr,
        message: '',
        to_print: false,
        to_email: false,
        lines: make(percent),
      });
      const hasPct = lineRows.some(({ r }) => r.price?.percent);
      return hasPct ? [doc(true), doc(false)] : [doc(true)];
    }
    case 'PAYMENT':
      if (h.account_id === null || h.ar_account_id === null) return 'it has no deposit-to or Accounts Receivable line';
      return [
        {
          type: 'PAYMENT',
          ...base,
          num: '',
          amount: h.total,
          pay_method: h.pay_method,
          ref_no: h.ref_no,
          account_id: h.account_id,
          ar_account_id: h.ar_account_id,
          applications: links
            .filter((l) => l.kind === 'apply')
            .map((l) => ({ txn_id: l.to_txn, amount: l.amount, discount: l.discount, discount_account_id: l.discount_account_id })),
        },
      ];
    case 'DEPOSIT': {
      if (h.account_id === uf) return 'it is a deposit into Undeposited Funds';
      const depRows = (p as Plan & { depositRows?: Set<number> }).depositRows ?? new Set<number>();
      return [
        {
          type: 'DEPOSIT',
          ...base,
          name_id: null,
          account_id: h.account_id,
          payment_ids: links.filter((l) => l.kind === 'deposit').map((l) => l.to_txn),
          lines: rest
            .filter(({ i }) => i > 0 && !depRows.has(i))
            .map(({ r, s }) => ({ name_id: s.name_id, account_id: s.account_id, description: r.memo, ref_no: '', pay_method: r.payMeth, amount: -s.amount })),
        },
      ];
    }
    case 'BILL':
    case 'BILLCREDIT':
    case 'CHECK': {
      const isCheck = p.type === 'CHECK';
      const head = isCheck ? 0 : p.splits.findIndex((s) => s.account_id === h.ap_account_id);
      if (head < 0) return 'it has no Accounts Payable line';
      if (isCheck && p.splits[0].amount > 0) return 'its first line (the bank account) is not a credit';
      const sign = p.type === 'BILLCREDIT' ? -1 : 1;
      const expenses: { account_id: number; amount: number; memo: string; name_id: number | null }[] = [];
      const items: { item_id: number; description: string; qty: number | null; rate: number | null; amount: number; name_id: number | null }[] = [];
      for (const { r, s, i } of rest) {
        if (i === head || (!isCheck && s.account_id === h.ap_account_id)) continue;
        const amount = sign * s.amount;
        const item = r.item ? L.findItem(r.item) : undefined;
        if (r.item && !item) noteMissing(r.item);
        if (item && ['SERVICE', 'PART', 'OTHER_CHARGE'].includes(item.type)) {
          let qty = r.qty;
          if (qty !== null && r.price && Math.sign(qty * r.price.value) === -Math.sign(amount)) qty = -qty;
          items.push({
            item_id: item.id,
            description: r.itemDesc || r.memo,
            qty,
            rate: r.price && !r.price.percent ? rate3(r.price.value) : null,
            amount,
            name_id: customerOn(s.name_id),
          });
        } else {
          expenses.push({ account_id: s.account_id, amount, memo: r.memo, name_id: customerOn(s.name_id) });
        }
      }
      if (isCheck) {
        return [{ type: 'CHECK', ...base, to_print: false, account_id: h.account_id, address: h.bill_addr, expenses, items }];
      }
      const bill = {
        ...base,
        num: '',
        ref_no: h.ref_no,
        ap_account_id: h.ap_account_id,
        terms_id: h.terms_id,
        due_date: h.due_date,
        address: h.bill_addr,
        expenses,
        items,
      };
      return [p.type === 'BILL' ? { type: 'BILL', ...bill, po_ids: [] } : { type: 'BILLCREDIT', ...bill }];
    }
    case 'BILLPMT':
      if (h.ap_account_id === null) return 'it has no Accounts Payable line';
      return [
        {
          type: 'BILLPMT',
          ...base,
          to_print: false,
          account_id: h.account_id,
          ap_account_id: h.ap_account_id,
          pay_method: h.pay_method === 'other' ? 'other' : 'check',
          address: h.bill_addr,
          amount: h.total,
          applications: links.map((l) => ({ txn_id: l.to_txn, amount: l.amount, discount: l.discount, discount_account_id: l.discount_account_id })),
        },
      ];
    case 'TRANSFER':
      if (p.splits.length !== 2) return `a transfer of ${p.splits.length} lines (the form has two)`;
      return [
        {
          type: 'TRANSFER',
          ...base,
          name_id: null,
          from_account_id: h.account_id,
          to_account_id: h.to_account_id,
          amount: h.total,
        },
      ];
    default:
      return 'no form';
  }
}

/** Lines stored on a locked document, for display: one per non-header row. */
function fallbackLines(p: Plan, L: Lookups): StoredLine[] {
  const h = p.header;
  const headAccount = h.ar_account_id ?? h.ap_account_id ?? h.account_id;
  const out: StoredLine[] = [];
  p.rows.forEach((r, i) => {
    const s = p.splits[i];
    if (s.account_id === headAccount) return;
    const item = r.item ? L.findItem(r.item) : undefined;
    const sign = p.type === 'INVOICE' || p.type === 'DEPOSIT' || p.type === 'BILLCREDIT' ? -1 : 1;
    out.push({
      item_id: item?.id ?? null,
      description: r.itemDesc || r.memo || (item ? '' : r.item),
      qty: r.qty,
      rate: r.price && !r.price.percent ? rate3(r.price.value) : null,
      rate_is_percent: false,
      amount: sign * s.amount,
      account_id: s.account_id,
      name_id: s.name_id,
      ref_no: '',
      pay_method: '',
    });
  });
  return out;
}

/**
 * Do the builder's splits post the same as the Journal's? Same multiset of (account,
 * amount), zero lines ignored; failing that, the same net per account ("regrouped": one
 * Journal line became two in RapidBooks, e.g. a discount on a bill payment).
 */
function compareSplits(
  journal: { account_id: number; amount: number }[],
  built: { account_id: number; amount: number }[],
  L: Lookups,
): { same: boolean; regrouped: boolean; note: string } {
  const key = (s: { account_id: number; amount: number }) => `${s.account_id}|${s.amount}`;
  const a = journal.filter((s) => s.amount !== 0).map(key).sort();
  const b = built.filter((s) => s.amount !== 0).map(key).sort();
  if (a.length === b.length && a.every((k, i) => k === b[i])) return { same: true, regrouped: false, note: '' };
  const net = (list: { account_id: number; amount: number }[]) => {
    const m = new Map<number, number>();
    for (const s of list) m.set(s.account_id, (m.get(s.account_id) ?? 0) + s.amount);
    return m;
  };
  const na = net(journal);
  const nb = net(built);
  const diffs: string[] = [];
  for (const id of new Set([...na.keys(), ...nb.keys()])) {
    const x = na.get(id) ?? 0;
    const y = nb.get(id) ?? 0;
    if (x !== y) diffs.push(`${L.accountById.get(id)?.full ?? id}: QuickBooks ${money(x)}, form ${money(y)}`);
  }
  if (diffs.length === 0) return { same: true, regrouped: true, note: '' };
  return { same: false, regrouped: false, note: `its form would post differently (${diffs.join('; ')})` };
}
