import type { DB } from '../db';
import type { HistoryResult } from './history';
import { PARENT_OTHER } from './layout';
import { parseOpenDocs, parseProfitLoss, parseTrialBalance, type AccountLine, type OpenDocsReport } from './reports';

// The reconciliation report: what was read and imported, and RapidBooks' figures compared
// line by line with whatever QuickBooks verification reports were supplied.

export interface ReconcileInput {
  trialBalance?: Uint8Array | string;
  /** Trial Balance date (default: the last transaction's date). */
  asOf?: string;
  /** First month of the fiscal year (1 = January): P&L accounts in a Trial Balance are year-to-date. */
  fiscalYearStartMonth?: number;
  openInvoices?: Uint8Array | string;
  unpaidBills?: Uint8Array | string;
  /** The date of the Open Invoices / Unpaid Bills reports (default: asOf). */
  openAsOf?: string;
  profitLoss?: { data: Uint8Array | string; from?: string; to?: string }[];
}

export interface Section {
  title: string;
  status: 'PASS' | 'FAIL' | 'INFO';
  lines: string[];
  differences: string[];
}

export interface Reconciliation {
  pass: boolean;
  sections: Section[];
  text: string;
}

const PL_TYPES = new Set(['INC', 'COGS', 'EXP', 'OINC', 'OEXP']);
const CREDIT_PL = new Set(['INC', 'OINC']);

const money = (c: number) => {
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return c < 0 ? `-${s}` : s;
};
const usDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};
const row = (cells: (string | number)[], widths: number[]) =>
  cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');

interface Acct {
  id: number;
  type: string;
  full: string;
  role: string | null;
}

function accounts(db: DB): { list: Acct[]; byFull: Map<string, Acct> } {
  const rows = db.prepare('SELECT id, name, type, parent_id, system_role FROM accounts').all() as {
    id: number;
    name: string;
    type: string;
    parent_id: number | null;
    system_role: string | null;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const full = (id: number): string => {
    const r = byId.get(id)!;
    return r.parent_id === null ? r.name : `${full(r.parent_id)}:${r.name}`;
  };
  const list = rows.map((r) => ({ id: r.id, type: r.type, full: full(r.id), role: r.system_role }));
  list.sort((a, b) => a.full.localeCompare(b.full));
  return { list, byFull: new Map(list.map((a) => [a.full.toLowerCase(), a])) };
}

/** The account a report line names: its label, with as many of the group labels above it as make a known account. */
function resolve(line: AccountLine, byFull: Map<string, Acct>): Acct | undefined {
  const other = PARENT_OTHER.test(line.label);
  const label = line.label.replace(PARENT_OTHER, '');
  const path = other && line.path.length > 0 && line.path[line.path.length - 1].toLowerCase() === label.toLowerCase() ? line.path.slice(0, -1) : line.path;
  for (let k = 0; k <= path.length; k++) {
    const hit = byFull.get([...path.slice(k), label].join(':').toLowerCase());
    if (hit) return hit;
  }
  const leaf = label.split(':').pop()!.toLowerCase();
  const leaves = [...byFull.values()].filter((a) => a.full.split(':').pop()!.toLowerCase() === leaf);
  return leaves.length === 1 ? leaves[0] : undefined;
}

function nameMap(db: DB): Map<number, string> {
  const rows = db.prepare('SELECT id, name, parent_id FROM names').all() as { id: number; name: string; parent_id: number | null }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const full = (id: number): string => {
    const r = byId.get(id)!;
    return r.parent_id === null ? r.name : `${full(r.parent_id)}:${r.name}`;
  };
  return new Map(rows.map((r) => [r.id, full(r.id)]));
}

const lastDate = (db: DB) => (db.prepare('SELECT MAX(date) AS d FROM txns').get() as { d: string | null }).d ?? '1900-01-01';

// ---------------------------------------------------------------------------

/** RapidBooks' trial balance as of a date, QuickBooks style: P&L accounts year to date, prior years' profit in Retained Earnings. */
export function trialBalance(db: DB, asOf: string, fyStartMonth = 1): Map<number, number> {
  const [y, m] = asOf.split('-').map(Number);
  const fyYear = m >= fyStartMonth ? y : y - 1;
  const fyStart = `${fyYear}-${String(fyStartMonth).padStart(2, '0')}-01`;
  const rows = db
    .prepare(
      `SELECT a.id, a.type, a.system_role,
              COALESCE(SUM(CASE WHEN t.date <= ? THEN s.amount END), 0) AS all_time,
              COALESCE(SUM(CASE WHEN t.date >= ? AND t.date <= ? THEN s.amount END), 0) AS ytd,
              COALESCE(SUM(CASE WHEN t.date < ? THEN s.amount END), 0) AS prior
         FROM accounts a LEFT JOIN splits s ON s.account_id = a.id LEFT JOIN txns t ON t.id = s.txn_id
        GROUP BY a.id`,
    )
    .all(asOf, fyStart, asOf, fyStart) as { id: number; type: string; system_role: string | null; all_time: number; ytd: number; prior: number }[];
  const out = new Map<number, number>();
  let priorProfit = 0;
  let retained: number | null = null;
  for (const r of rows) {
    if (PL_TYPES.has(r.type)) {
      out.set(r.id, r.ytd);
      priorProfit += r.prior;
    } else out.set(r.id, r.all_time);
    if (r.system_role === 'RETAINED') retained = r.id;
  }
  if (retained !== null) out.set(retained, (out.get(retained) ?? 0) + priorProfit);
  return out;
}

interface OpenDocRow {
  name: string;
  kind: 'doc' | 'credit';
  type: string;
  num: string;
  date: string;
  open: number; // positive for documents, negative for unapplied credits
}

/** Open invoices and unapplied payments/credits (AR), or open bills and unapplied bill credits/payments (AP), as of a date. */
export function openDocs(db: DB, side: 'AR' | 'AP', asOf: string): OpenDocRow[] {
  const names = nameMap(db);
  const [docType, creditTypes] = side === 'AR' ? ['INVOICE', ['PAYMENT', 'CREDITMEMO']] : ['BILL', ['BILLCREDIT', 'BILLPMT']];
  const applied = (col: 'to_txn' | 'from_txn', withDiscount: boolean) =>
    new Map(
      (
        db
          .prepare(
            `SELECT l.${col} AS id, SUM(l.amount${withDiscount ? ' + l.discount' : ''}) AS n
               FROM links l JOIN txns f ON f.id = l.from_txn JOIN txns t ON t.id = l.to_txn
              WHERE l.kind = 'apply' AND MAX(f.date, t.date) <= ? GROUP BY l.${col}`,
          )
          .all(asOf) as { id: number; n: number }[]
      ).map((r) => [r.id, r.n]),
    );
  const toDoc = applied('to_txn', true);
  const fromCredit = applied('from_txn', false);
  const txns = db
    .prepare(`SELECT id, type, num, date, name_id, total FROM txns WHERE type IN (?, ?, ?) AND date <= ? ORDER BY date, id`)
    .all(docType, ...creditTypes, asOf) as { id: number; type: string; num: string; date: string; name_id: number | null; total: number }[];
  const out: OpenDocRow[] = [];
  for (const t of txns) {
    const isDoc = t.type === docType;
    const open = isDoc ? t.total - (toDoc.get(t.id) ?? 0) : -(t.total - (fromCredit.get(t.id) ?? 0));
    if (open === 0) continue;
    out.push({ name: t.name_id === null ? '' : (names.get(t.name_id) ?? ''), kind: isDoc ? 'doc' : 'credit', type: t.type, num: t.num, date: t.date, open });
  }
  return out;
}

/**
 * Balance per name (own, jobs separately) as QuickBooks ages it, as of a date: the open
 * documents and unapplied credits of the name (so a customer's payment applied to its
 * job's invoice counts for neither), plus any other posting to A/R or A/P (journal
 * entries...). Customers debit, vendors credit positive.
 */
function nameBalances(db: DB, side: 'AR' | 'AP', asOf: string): Map<string, number> {
  const names = nameMap(db);
  const docTypes = side === 'AR' ? ['INVOICE', 'PAYMENT', 'CREDITMEMO'] : ['BILL', 'BILLCREDIT', 'BILLPMT'];
  const rows = db
    .prepare(
      `SELECT COALESCE(s.name_id, t.name_id) AS name_id, SUM(s.amount) AS n
         FROM splits s JOIN txns t ON t.id = s.txn_id JOIN accounts a ON a.id = s.account_id
        WHERE a.type = ? AND t.date <= ? AND t.type NOT IN (?, ?, ?) GROUP BY 1`,
    )
    .all(side, asOf, ...docTypes) as { name_id: number | null; n: number }[];
  const out = new Map<string, number>();
  for (const d of openDocs(db, side, asOf)) out.set(d.name.toLowerCase(), (out.get(d.name.toLowerCase()) ?? 0) + d.open);
  for (const r of rows) {
    const k = r.name_id === null ? '(no name)' : (names.get(r.name_id) ?? '?');
    out.set(k.toLowerCase(), (out.get(k.toLowerCase()) ?? 0) + (side === 'AR' ? r.n : -r.n));
  }
  return out;
}

// ---------------------------------------------------------------------------

function compareTrialBalance(db: DB, data: Uint8Array | string, asOf: string, fy: number): Section {
  const { list, byFull } = accounts(db);
  const tb = parseTrialBalance(data);
  const ours = trialBalance(db, asOf, fy);
  const theirs = new Map<number, number>();
  const differences: string[] = [...tb.warnings];
  for (const l of tb.lines) {
    const a = resolve(l, byFull);
    if (!a) {
      differences.push(`"${[...l.path, l.label].join(':')}" (line ${l.line}, ${money(l.amounts[0])}) is not an account in RapidBooks`);
      continue;
    }
    theirs.set(a.id, (theirs.get(a.id) ?? 0) + l.amounts[0]);
  }
  const w = [Math.max(30, ...list.map((a) => a.full.length)), 14, 14, 14];
  const lines = [row(['Account', 'QuickBooks', 'RapidBooks', 'Difference'], w), row(['', '(debit +)', '(debit +)', ''], w)];
  let tq = 0;
  let tr = 0;
  for (const a of list) {
    const q = theirs.get(a.id) ?? 0;
    const r = ours.get(a.id) ?? 0;
    if (q === 0 && r === 0) continue;
    tq += q;
    tr += r;
    const mark = q !== r ? '  <-- differs' : '';
    lines.push(row([a.full, money(q), money(r), money(r - q)], w) + mark);
    if (q !== r) differences.push(`${a.full}: QuickBooks ${money(q)}, RapidBooks ${money(r)}, difference ${money(r - q)}`);
  }
  lines.push(row(['Total', money(tq), money(tr), money(tr - tq)], w));
  return { title: `Trial Balance as of ${usDate(asOf)}`, status: differences.length ? 'FAIL' : 'PASS', lines, differences };
}

function ourTrialBalance(db: DB, asOf: string, fy: number): Section {
  const { list } = accounts(db);
  const ours = trialBalance(db, asOf, fy);
  const w = [Math.max(30, ...list.map((a) => a.full.length)), 14, 14];
  const lines = [row(['Account', 'Debit', 'Credit'], w)];
  let dr = 0;
  let cr = 0;
  for (const a of list) {
    const v = ours.get(a.id) ?? 0;
    if (v === 0) continue;
    if (v > 0) dr += v;
    else cr -= v;
    lines.push(row([a.full, v > 0 ? money(v) : '', v < 0 ? money(-v) : ''], w));
  }
  lines.push(row(['TOTAL', money(dr), money(cr)], w));
  lines.push('', 'No QuickBooks Trial Balance was given: compare these figures with QuickBooks by eye.');
  return { title: `RapidBooks Trial Balance as of ${usDate(asOf)}`, status: 'INFO', lines, differences: [] };
}

function compareOpenDocs(db: DB, side: 'AR' | 'AP', data: Uint8Array | string, asOf: string): Section {
  const what = side === 'AR' ? 'Open Invoices' : 'Unpaid Bills';
  const report: OpenDocsReport = parseOpenDocs(data, what);
  const differences: string[] = [...report.warnings];
  const lines: string[] = [];
  if (report.format === 'summary') {
    const ours = nameBalances(db, side, asOf);
    const theirs = new Map<string, { name: string; total: number }>();
    for (const b of report.balances) {
      const k = b.name.toLowerCase();
      const e = theirs.get(k) ?? { name: b.name, total: 0 };
      e.total += b.total;
      theirs.set(k, e);
    }
    const all = new Set([...theirs.keys(), ...[...ours].filter(([, v]) => v !== 0).map(([k]) => k)]);
    const w = [36, 14, 14, 14];
    lines.push(row([side === 'AR' ? 'Customer:Job' : 'Vendor', 'QuickBooks', 'RapidBooks', 'Difference'], w));
    for (const k of [...all].sort()) {
      const q = theirs.get(k)?.total ?? 0;
      const r = ours.get(k) ?? 0;
      lines.push(row([theirs.get(k)?.name ?? k, money(q), money(r), money(r - q)], w) + (q !== r ? '  <-- differs' : ''));
      if (q !== r) differences.push(`${theirs.get(k)?.name ?? k}: QuickBooks ${money(q)}, RapidBooks ${money(r)}`);
    }
    return { title: `${side === 'AR' ? 'A/R' : 'A/P'} Aging Summary (balance per name) as of ${usDate(asOf)}`, status: differences.length ? 'FAIL' : 'PASS', lines, differences };
  }

  const ours = openDocs(db, side, asOf);
  const used = new Set<OpenDocRow>();
  const kindOf = (mapped: string | null) => (mapped === 'INVOICE' || mapped === 'BILL' ? 'doc' : 'credit');
  const w = [52, 14, 14];
  lines.push(row(['Document', 'QuickBooks', 'RapidBooks'], w));
  const label = (name: string, type: string, num: string, date: string) => `${name}: ${type} ${num} ${date ? usDate(date) : ''}`.replace(/\s+/g, ' ');
  for (const d of report.docs) {
    const kind = kindOf(d.mapped);
    const cands = ours.filter((o) => !used.has(o) && o.kind === kind && o.name.toLowerCase() === d.name.toLowerCase());
    const hit =
      cands.find((o) => o.num === d.num && o.date === d.date) ??
      cands.find((o) => d.num !== '' && o.num === d.num) ??
      cands.find((o) => o.date === d.date && o.open === d.open);
    if (hit) used.add(hit);
    const r = hit?.open ?? 0;
    lines.push(row([label(d.name, d.qbType, d.num, d.date ?? ''), money(d.open), hit ? money(r) : '(none)'], w) + (r !== d.open ? '  <-- differs' : ''));
    if (r !== d.open) differences.push(`${label(d.name, d.qbType, d.num, d.date ?? '')}: QuickBooks ${money(d.open)} open, RapidBooks ${hit ? money(r) : 'has no such open document'}`);
  }
  for (const o of ours) {
    if (used.has(o)) continue;
    lines.push(row([label(o.name, o.type, o.num, o.date), '(none)', money(o.open)], w) + '  <-- differs');
    differences.push(`${label(o.name, o.type, o.num, o.date)}: open ${money(o.open)} in RapidBooks, not in QuickBooks' report`);
  }
  const tq = report.docs.reduce((t, d) => t + d.open, 0);
  const tr = ours.reduce((t, o) => t + o.open, 0);
  lines.push(row(['Total', money(tq), money(tr)], w));
  return { title: `${what} as of ${usDate(asOf)}`, status: differences.length ? 'FAIL' : 'PASS', lines, differences };
}

function compareProfitLoss(db: DB, data: Uint8Array | string, fallback?: { from: string; to: string }): Section[] {
  const { list, byFull } = accounts(db);
  const pl = parseProfitLoss(data, fallback);
  const byId = new Map(list.map((a) => [a.id, a]));
  return pl.periods.map((p, pi) => {
    const differences: string[] = pi === 0 ? [...pl.warnings] : [];
    const sums = new Map(
      (
        db
          .prepare('SELECT s.account_id AS id, SUM(s.amount) AS n FROM splits s JOIN txns t ON t.id = s.txn_id WHERE t.date >= ? AND t.date <= ? GROUP BY s.account_id')
          .all(p.from, p.to) as { id: number; n: number }[]
      ).map((r) => [r.id, r.n]),
    );
    const ours = new Map<number, number>();
    let net = 0;
    for (const [id, n] of sums) {
      const a = byId.get(id)!;
      if (!PL_TYPES.has(a.type)) continue;
      ours.set(id, CREDIT_PL.has(a.type) ? -n : n);
      net -= n;
    }
    const theirs = new Map<number, number>();
    for (const l of pl.lines) {
      const a = resolve(l, byFull);
      if (!a) {
        if (l.amounts[pi] !== 0) differences.push(`"${[...l.path, l.label].join(':')}" (line ${l.line}, ${money(l.amounts[pi])}) is not an account in RapidBooks`);
        continue;
      }
      theirs.set(a.id, (theirs.get(a.id) ?? 0) + l.amounts[pi]);
    }
    const w = [Math.max(30, ...list.map((a) => a.full.length)), 14, 14, 14];
    const lines = [row(['Account', 'QuickBooks', 'RapidBooks', 'Difference'], w)];
    for (const a of list) {
      if (!PL_TYPES.has(a.type)) continue;
      const q = theirs.get(a.id) ?? 0;
      const r = ours.get(a.id) ?? 0;
      if (q === 0 && r === 0) continue;
      lines.push(row([a.full, money(q), money(r), money(r - q)], w) + (q !== r ? '  <-- differs' : ''));
      if (q !== r) differences.push(`${a.full}: QuickBooks ${money(q)}, RapidBooks ${money(r)}`);
    }
    const qn = pl.netIncome[pi];
    lines.push(row(['Net Income', qn === null ? '(not shown)' : money(qn), money(net), qn === null ? '' : money(net - qn)], w));
    if (qn !== null && qn !== net) differences.push(`Net Income: QuickBooks ${money(qn)}, RapidBooks ${money(net)}`);
    return { title: `Profit & Loss ${usDate(p.from)} - ${usDate(p.to)}`, status: differences.length ? 'FAIL' : 'PASS', lines, differences } as Section;
  });
}

// ---------------------------------------------------------------------------

export function reconcile(db: DB, h: HistoryResult, input: ReconcileInput): Reconciliation {
  const sections: Section[] = [];
  const asOf = input.asOf ?? lastDate(db);
  const fy = input.fiscalYearStartMonth ?? 1;

  // What was read and imported.
  {
    const w = [24, 18, 7, 9, 8, 7, 10, 10];
    const lines = [
      `Journal: ${h.txnsRead} transactions in ${h.rowsRead} rows (${h.delimiter}-delimited; columns found: ${h.journalColumns.join(', ')}).`,
      `Lists: ${h.lists.counts.accounts} accounts, ${h.lists.counts.customers} customers and jobs, ${h.lists.counts.vendors} vendors, ${h.lists.counts.employees} employees, ${h.lists.counts.other_names} other names, ${h.lists.counts.items} items, ${h.lists.counts.terms} terms.`,
      '',
      row(['QuickBooks type', 'RapidBooks type', 'Read', 'Imported', 'Skipped', 'Locked', 'Rows read', 'Rows imp.'], w),
    ];
    for (const c of h.byType) lines.push(row([c.qbType, c.rbType, c.read, c.imported, c.skipped, c.locked, c.rowsRead, c.rowsImported], w));
    lines.push(row(['Total', '', h.txnsRead, h.txnsImported, h.skipped.length, h.locked.length, h.rowsRead, h.rowsImported], w));
    lines.push('', `Editable documents: ${h.editable}${h.editableRegrouped ? ` (of which ${h.editableRegrouped} post the same per account but split lines differently than QuickBooks did)` : ''}. Locked: ${h.locked.length}.`);
    lines.push(`Import took ${h.seconds.toFixed(1)} s.`);
    sections.push({ title: 'Transactions read and imported', status: 'INFO', lines, differences: [] });
  }

  sections.push({
    title: 'Transactions skipped',
    status: h.skipped.length ? 'FAIL' : 'PASS',
    lines: h.skipped.length ? [] : ['None.'],
    differences: h.skipped.map((s) => `line ${s.line}: ${s.qbType || '(no type)'}${s.transNo ? ` Trans # ${s.transNo}` : ''}${s.num ? ` no. ${s.num}` : ''} of ${s.date || '(no date)'}: ${s.reason}`),
  });

  {
    const lines: string[] = [];
    const byCat = new Map<string, Map<string, number>>();
    for (const l of h.locked) {
      const m = byCat.get(l.category) ?? new Map<string, number>();
      m.set(l.qbType, (m.get(l.qbType) ?? 0) + 1);
      byCat.set(l.category, m);
    }
    for (const [cat, m] of byCat) lines.push(`${cat}: ${[...m].map(([t, n]) => `${n} ${t}`).join(', ')}`);
    if (h.locked.length) {
      lines.push('', 'Each locked transaction:');
      for (const l of h.locked) lines.push(`  ${usDate(l.date)} ${l.qbType}${l.num ? ` ${l.num}` : ''}: ${l.note}`);
    } else lines.push('None.');
    sections.push({ title: 'Locked transactions (imported as posted; open as a journal view)', status: 'INFO', lines, differences: [] });
  }

  {
    const lines: string[] = [];
    if (h.createdAccounts.length) lines.push(`Accounts created (inactive): ${h.createdAccounts.join('; ')}`);
    if (h.createdNames.length) lines.push(`Names created (inactive): ${h.createdNames.join('; ')}`);
    for (const w of [...h.lists.warnings.map((m) => `Lists: ${m}`), ...h.warnings]) lines.push(`- ${w}`);
    if (!lines.length) lines.push('None.');
    sections.push({ title: 'Warnings', status: 'INFO', lines, differences: [] });
  }

  {
    const sum = (db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM splits').get() as { n: number }).n;
    const bad = (db.prepare('SELECT COUNT(*) AS n FROM (SELECT txn_id FROM splits GROUP BY txn_id HAVING SUM(amount) <> 0)').get() as { n: number }).n;
    sections.push({
      title: 'Ledger balance',
      status: sum === 0 && bad === 0 ? 'PASS' : 'FAIL',
      lines: [`Sum of all splits: ${money(sum)} (must be 0.00). Transactions out of balance: ${bad}.`],
      differences: sum === 0 && bad === 0 ? [] : [`The splits sum to ${money(sum)}; ${bad} transaction(s) out of balance.`],
    });
  }

  {
    const lines = [
      `Payment/credit applications derived: ${h.links.apply}, aiming at open balances from: receivables ${h.targetsFrom.AR}; payables ${h.targetsFrom.AP}.`,
      `Deposits linked to payments: ${h.links.deposit}; Undeposited Funds deposit lines with no matching payment (kept as plain deposit lines): ${h.links.depositRowsUnmatched}.`,
    ];
    const differences = h.unreproduced.flatMap((u) => u.detail.map((d) => `${u.side === 'AR' ? 'Customer' : 'Vendor'} ${u.name}: ${d}`));
    const hasTargets = h.targetsFrom.AR !== 'none (oldest first)' || h.targetsFrom.AP !== 'none (oldest first)';
    sections.push({ title: 'Applications', status: !hasTargets ? 'INFO' : differences.length ? 'FAIL' : 'PASS', lines, differences });
  }

  sections.push(input.trialBalance !== undefined ? compareTrialBalance(db, input.trialBalance, asOf, fy) : ourTrialBalance(db, asOf, fy));
  const openAsOf = input.openAsOf ?? asOf;
  if (input.openInvoices !== undefined) sections.push(compareOpenDocs(db, 'AR', input.openInvoices, openAsOf));
  if (input.unpaidBills !== undefined) sections.push(compareOpenDocs(db, 'AP', input.unpaidBills, openAsOf));
  for (const p of input.profitLoss ?? []) sections.push(...compareProfitLoss(db, p.data, p.from && p.to ? { from: p.from, to: p.to } : undefined));

  const pass = sections.every((s) => s.status !== 'FAIL');
  const out: string[] = ['RapidBooks history import: reconciliation with QuickBooks', '='.repeat(58), ''];
  out.push('Summary:');
  for (const s of sections) if (s.status !== 'INFO') out.push(`  ${s.status.padEnd(5)} ${s.title}${s.differences.length ? ` (${s.differences.length} difference${s.differences.length > 1 ? 's' : ''})` : ''}`);
  out.push('', `OVERALL: ${pass ? 'PASS' : 'FAIL'}`, '');
  for (const s of sections) {
    out.push(`${s.status === 'INFO' ? '' : `[${s.status}] `}${s.title}`, '-'.repeat(Math.min(78, s.title.length + (s.status === 'INFO' ? 0 : 7))));
    out.push(...s.lines);
    if (s.differences.length) {
      out.push('', 'Differences:');
      for (const d of s.differences) out.push(`  * ${d}`);
    }
    out.push('');
  }
  return { pass, sections, text: out.join('\n') };
}
