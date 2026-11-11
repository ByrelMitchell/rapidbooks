import {
  ACCOUNT_TYPES,
  isIsoDate,
  presetId,
  REPORT_TYPE_LABELS,
  resolvePreset,
  todayIso,
  type Account,
  type Report,
  type ReportColumn,
  type ReportDef,
  type ReportDrill,
  type ReportParamDef,
  type ReportParamValue,
  type ReportRow,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { listAccounts } from '../ledger/accounts';

// The report engine: parameters, the rows a report builds, choosing/ordering columns,
// sorting, and CSV. Every report is derived from splits, lines and links.

/** A row as a report builds it: `label` goes into the first text column when the report is finished. */
export type Row = ReportRow & { label?: string };

export interface Built {
  subtitle: string;
  columns?: ReportColumn[]; // reports with fixed (or computed) columns; customizable reports use the def's
  rows: Row[];
  title?: string; // overrides the def's title (QuickReport: "Acme QuickReport")
}

export interface Def extends ReportDef {
  run(db: DB, p: Params): Built;
}

export const LOW = '0000-01-01';
export const HIGH = '9999-12-31';

export interface Params {
  today: string;
  preset: string | null;
  from: string | null;
  to: string | null;
  as_of: string;
  name_ids: number[];
  item_ids: number[];
  account_ids: number[];
  txn_types: string[];
  columns: string[] | null;
  sort: string | null;
  /** Other parameters (enum, boolean, single ids), already defaulted. */
  extra: Record<string, string | boolean | number | null>;
  /** Normalised parameters, for Report.params. */
  normalised: Record<string, ReportParamValue>;
}

/** from/to with the open ends filled in, for SQL. */
export const lo = (p: { from: string | null }) => p.from ?? LOW;
export const hi = (p: { to: string | null }) => p.to ?? HIGH;

const ids = (s: string | undefined, what: string): number[] => {
  if (s === undefined || s.trim() === '') return [];
  return s.split(',').map((x) => {
    const n = Number(x.trim());
    if (!Number.isInteger(n)) throw new AppError(400, `The ${what} filter is not a list of ids.`);
    return n;
  });
};
const list = (s: string | undefined) => (s === undefined || s.trim() === '' ? [] : s.split(',').map((x) => x.trim()).filter((x) => x));
const date = (s: string, label: string) => {
  if (!isIsoDate(s)) throw new AppError(400, `${label} is not a valid date.`);
  return s;
};

export function parseParams(def: ReportDef, q: Record<string, string | undefined>): Params {
  const today = q.today && isIsoDate(q.today) ? q.today : todayIso();
  const p: Params = {
    today,
    preset: null,
    from: null,
    to: null,
    as_of: today,
    name_ids: ids(q.name_ids, 'name'),
    item_ids: ids(q.item_ids, 'item'),
    account_ids: ids(q.account_ids, 'account'),
    txn_types: list(q.txn_types).map((t) => t.toUpperCase()),
    columns: q.columns !== undefined && q.columns.trim() !== '' ? list(q.columns) : null,
    sort: q.sort && q.sort.trim() ? q.sort.trim() : null,
    extra: {},
    normalised: {},
  };
  for (const t of p.txn_types) {
    if (!REPORT_TYPE_LABELS[t]) throw new AppError(400, `${t} is not a transaction type.`);
  }
  const n = p.normalised;
  for (const d of def.params) {
    switch (d.kind) {
      case 'date_range': {
        const hasExplicit = (q.from ?? '') !== '' || (q.to ?? '') !== '' || (q.date !== undefined && presetId(q.date) === 'custom');
        if (hasExplicit) {
          p.preset = 'custom';
          p.from = q.from ? date(q.from, 'The From date') : null;
          p.to = q.to ? date(q.to, 'The To date') : null;
        } else {
          const name = q.date && q.date.trim() ? q.date : String(d.default ?? 'all');
          const r = resolvePreset(name, today);
          if (!r) throw new AppError(400, `"${name}" is not a date range.`);
          p.preset = presetId(name);
          p.from = r.from;
          p.to = r.to;
        }
        if (p.from && p.to && p.from > p.to) throw new AppError(400, 'The From date is after the To date.');
        n.date = p.preset;
        n.from = p.from;
        n.to = p.to;
        break;
      }
      case 'as_of':
        p.as_of = q.as_of ? date(q.as_of, 'The As of date') : today;
        n.as_of = p.as_of;
        break;
      case 'name_ids':
        n.name_ids = p.name_ids;
        break;
      case 'item_ids':
        n.item_ids = p.item_ids;
        break;
      case 'account_ids':
        n.account_ids = p.account_ids;
        break;
      case 'txn_types':
        n.txn_types = p.txn_types;
        break;
      case 'columns':
        n.columns = p.columns;
        break;
      case 'sort':
        n.sort = p.sort;
        break;
      case 'account_id':
      case 'name_id':
      case 'item_id': {
        const v = q[d.key];
        let id: number | null = null;
        if (v !== undefined && v !== '') {
          id = Number(v);
          if (!Number.isInteger(id)) throw new AppError(400, `${d.label} is not an id.`);
        }
        if (id === null && d.required) throw new AppError(400, `Choose the ${d.label.toLowerCase()} for this report.`);
        p.extra[d.key] = id;
        n[d.key] = id;
        break;
      }
      case 'boolean': {
        const v = q[d.key];
        const b = v === undefined || v === '' ? d.default === true : v === 'true' || v === '1' || v === 'yes';
        p.extra[d.key] = b;
        n[d.key] = b;
        break;
      }
      case 'enum': {
        const v = q[d.key] && q[d.key] !== '' ? q[d.key]! : String(d.default);
        if (!d.options?.some((o) => o.value === v)) throw new AppError(400, `"${v}" is not a choice for ${d.label}.`);
        p.extra[d.key] = v;
        n[d.key] = v;
        break;
      }
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Subtitles

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string, withYear = true) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
};
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3)} ${ym.slice(0, 4)}`;
export const longMonthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

export function rangeSubtitle(p: { from: string | null; to: string | null }): string {
  if (!p.from && !p.to) return 'All Transactions';
  if (!p.from) return `Through ${longDate(p.to!)}`;
  if (!p.to) return `From ${longDate(p.from)}`;
  if (p.from === p.to) return longDate(p.from);
  const sameYear = p.from.slice(0, 4) === p.to.slice(0, 4);
  return `${longDate(p.from, !sameYear)} through ${longDate(p.to)}`;
}
export const asOfSubtitle = (asOf: string) => `As of ${longDate(asOf)}`;

/** Months YYYY-MM from the month of `from` through the month of `to`. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 1200; i++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > end) break;
    out.push(ym);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** The first and last transaction dates, for open-ended ranges that need real dates. */
export function txnDateBounds(db: DB, today: string): { min: string; max: string } {
  const r = db.prepare("SELECT MIN(date) AS min, MAX(date) AS max FROM txns WHERE type <> 'PURCHORD'").get() as {
    min: string | null;
    max: string | null;
  };
  return { min: r.min ?? today, max: r.max ?? today };
}

// ---------------------------------------------------------------------------
// Finishing a report: columns, sorting, labels

function compare(a: unknown, b: unknown): number {
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  if (blank(a) && blank(b)) return 0;
  if (blank(a)) return 1;
  if (blank(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base', numeric: true });
}

export function finish(def: Def, p: Params, built: Built): Report {
  let columns: ReportColumn[];
  if (def.columns.length > 0) {
    const keys = p.columns ?? def.default_columns;
    columns = [];
    for (const k of keys) {
      const c = def.columns.find((x) => x.key === k);
      if (!c) throw new AppError(400, `This report has no "${k}" column.`);
      if (!columns.includes(c)) columns.push(c);
    }
    if (columns.length === 0) throw new AppError(400, 'Choose at least one column.');
  } else {
    columns = built.columns ?? [];
  }

  let rows = built.rows;
  if (p.sort) {
    const desc = p.sort.startsWith('-');
    const key = desc ? p.sort.slice(1) : p.sort;
    const avail = def.columns.length > 0 ? def.columns : columns;
    if (!avail.some((c) => c.key === key)) throw new AppError(400, `This report cannot be sorted by "${key}".`);
    // Sort each run of data rows at the same depth, leaving headers and totals in place.
    const out: Row[] = [];
    let run: Row[] = [];
    const flush = () => {
      run.sort((a, b) => (desc ? -1 : 1) * compare(a.cells[key], b.cells[key]));
      out.push(...run);
      run = [];
    };
    for (const r of rows) {
      if (r.kind === 'data' && (run.length === 0 || run[0].depth === r.depth)) run.push(r);
      else {
        flush();
        if (r.kind === 'data') run.push(r);
        else out.push(r);
      }
    }
    flush();
    rows = out;
  }

  const keys = new Set(columns.map((c) => c.key));
  const labelKey = (columns.find((c) => c.kind === 'text') ?? columns[0])?.key;
  const finalRows: ReportRow[] = rows.map((r) => {
    const cells: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(r.cells)) if (keys.has(k)) cells[k] = v;
    if (r.label !== undefined && labelKey !== undefined && (cells[labelKey] === undefined || cells[labelKey] === null || cells[labelKey] === '')) {
      cells[labelKey] = r.label;
    }
    const out: ReportRow = { kind: r.kind, depth: r.depth, cells };
    if (r.drill) out.drill = r.drill;
    return out;
  });

  return {
    id: def.id,
    title: built.title ?? def.title,
    subtitle: built.subtitle,
    columns,
    rows: finalRows,
    params: { ...p.normalised, ...(p.columns === null && def.columns.length > 0 ? { columns: def.default_columns } : {}) },
  };
}

// ---------------------------------------------------------------------------
// CSV

/** Cents as a plain number with two decimals ("-1234.50"); fractions of a cent keep their digits. */
export function centsToPlain(c: number): string {
  if (Number.isInteger(c)) {
    const neg = c < 0;
    const a = Math.abs(c);
    return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
  }
  let s = (c / 100).toFixed(5);
  while (s.endsWith('0') && !/\.\d\d$/.test(s)) s = s.slice(0, -1);
  return s;
}

const csvField = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The report as CSV: a header row of column titles, then every row. UTF-8 with a BOM, CRLF line ends. */
export function toCsv(r: Report): string {
  const lines: string[] = [r.columns.map((c) => csvField(c.title)).join(',')];
  for (const row of r.rows) {
    const cells = r.columns.map((c, i) => {
      const v = row.cells[c.key];
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number') {
        if (c.kind === 'money') return centsToPlain(v);
        if (c.kind === 'percent') return v.toFixed(2);
        return String(v);
      }
      const s = i === 0 && row.depth > 0 ? `${'  '.repeat(row.depth)}${v}` : v;
      return csvField(s);
    });
    lines.push(cells.join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Lookups shared by the reports

export interface Lookups {
  accounts: Account[]; // chart order
  account: Map<number, Account>;
  names: Map<number, NameInfo>;
  items: Map<number, ItemInfo>;
}

export interface NameInfo {
  id: number;
  kind: string;
  name: string;
  full_name: string;
  parent_id: number | null;
  root_id: number;
  picks_up: boolean;
  inactive: boolean;
}

export interface ItemInfo {
  id: number;
  name: string;
  full_name: string;
  type: string;
  parent_id: number | null;
  order: number; // item-list order
}

export function lookups(db: DB): Lookups {
  const accounts = listAccounts(db);
  const nrows = db.prepare('SELECT id, kind, name, parent_id, picks_up, inactive FROM names').all() as {
    id: number;
    kind: string;
    name: string;
    parent_id: number | null;
    picks_up: number;
    inactive: number;
  }[];
  const byId = new Map(nrows.map((r) => [r.id, r]));
  const names = new Map<number, NameInfo>();
  for (const r of nrows) {
    const parts = [r.name];
    let root = r;
    for (let i = 0; i < 50 && root.parent_id !== null && byId.has(root.parent_id); i++) {
      root = byId.get(root.parent_id)!;
      parts.unshift(root.name);
    }
    names.set(r.id, {
      id: r.id,
      kind: r.kind,
      name: r.name,
      full_name: parts.join(':'),
      parent_id: r.parent_id,
      root_id: root.id,
      picks_up: !!r.picks_up,
      inactive: !!r.inactive,
    });
  }
  const irows = db.prepare('SELECT id, name, type, parent_id FROM items').all() as {
    id: number;
    name: string;
    type: string;
    parent_id: number | null;
  }[];
  const iById = new Map(irows.map((r) => [r.id, r]));
  const items = new Map<number, ItemInfo>();
  for (const r of irows) {
    const parts = [r.name];
    let p = r;
    for (let i = 0; i < 50 && p.parent_id !== null && iById.has(p.parent_id); i++) {
      p = iById.get(p.parent_id)!;
      parts.unshift(p.name);
    }
    items.set(r.id, { id: r.id, name: r.name, full_name: parts.join(':'), type: r.type, parent_id: r.parent_id, order: 0 });
  }
  const typeOrder = new Map<string, number>([['SERVICE', 0], ['PART', 1], ['OTHER_CHARGE', 2], ['SUBTOTAL', 3], ['GROUP', 4], ['DISCOUNT', 5]]);
  [...items.values()]
    .sort((a, b) => {
      const ra = rootItem(items, a);
      const rb = rootItem(items, b);
      return (typeOrder.get(ra.type) ?? 9) - (typeOrder.get(rb.type) ?? 9) || a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' });
    })
    .forEach((it, i) => (it.order = i));
  return { accounts, account: new Map(accounts.map((a) => [a.id, a])), names, items };
}

function rootItem(items: Map<number, ItemInfo>, it: ItemInfo): ItemInfo {
  let r = it;
  for (let i = 0; i < 50 && r.parent_id !== null && items.has(r.parent_id); i++) r = items.get(r.parent_id)!;
  return r;
}

/** The ids and all their descendants (jobs of customers, sub-accounts, sub-items). */
export function withDescendants(ids: number[], parentOf: Map<number, { parent_id: number | null }>): Set<number> {
  const out = new Set(ids);
  if (ids.length === 0) return out;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, r] of parentOf) {
      if (!out.has(id) && r.parent_id !== null && out.has(r.parent_id)) {
        out.add(id);
        grew = true;
      }
    }
  }
  return out;
}

export const nameFilter = (L: Lookups, p: Params) => withDescendants(p.name_ids, L.names);
export const itemFilter = (L: Lookups, p: Params) => withDescendants(p.item_ids, L.items);
export const accountFilter = (L: Lookups, p: Params) => withDescendants(p.account_ids, L.account);

export const typeLabel = (type: string, payMethod = '') =>
  type === 'BILLPMT' && payMethod === 'other' ? 'Bill Pmt -CCard' : (REPORT_TYPE_LABELS[type] ?? type);

export const debitNormal = (type: string) => ACCOUNT_TYPES.find((t) => t.code === type)?.debitNormal ?? true;
export const isPL = (type: string) => ['INC', 'COGS', 'EXP', 'OINC', 'OEXP'].includes(type);

export const txnDrill = (id: number, type: string): ReportDrill => ({ txn: { id, type } });
export const reportDrill = (report: string, params: Record<string, string | number | null | undefined | number[]>): ReportDrill => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return { report, params: out };
};
/** Drill parameters for a date range (explicit dates, so the target shows the same period). */
export const rangeParams = (p: { from: string | null; to: string | null }) =>
  p.from || p.to ? { from: p.from ?? '', to: p.to ?? '' } : { date: 'all' };

export const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** Round half away from zero to `places` decimals. */
export const round = (x: number, places = 2) => {
  const f = 10 ** places;
  const r = Math.round(Math.abs(x) * f + 1e-9) / f;
  return x < 0 ? -r : r;
};

/** Divide cents, rounding half away from zero. */
export const divCents = (a: number, b: number) => (b === 0 ? null : round(a / b, 0));

export const pct = (part: number, whole: number) => (whole === 0 ? null : round((part / whole) * 100, 2));

export const blankRow = (): Row => ({ kind: 'blank', depth: 0, cells: {} });

/** "Bill", "Invoice", ... for a column definition list. */
export function col(key: string, title: string, kind: ReportColumn['kind'] = 'text', align?: ReportColumn['align']): ReportColumn {
  return align ? { key, title, kind, align } : { key, title, kind };
}

// Parameter definitions used by many reports.
export const P = {
  range: (def = 'this_month_to_date'): ReportParamDef => ({ key: 'date', label: 'Dates', kind: 'date_range', default: def }),
  asOf: (): ReportParamDef => ({ key: 'as_of', label: 'As of', kind: 'as_of', default: 'today' }),
  names: (kind?: ReportParamDef['name_kind'], label = 'Names'): ReportParamDef => ({ key: 'name_ids', label, kind: 'name_ids', default: null, ...(kind ? { name_kind: kind } : {}) }),
  items: (): ReportParamDef => ({ key: 'item_ids', label: 'Items', kind: 'item_ids', default: null }),
  accounts: (types?: string[]): ReportParamDef => ({ key: 'account_ids', label: 'Accounts', kind: 'account_ids', default: null, ...(types ? { account_types: types } : {}) }),
  types: (): ReportParamDef => ({ key: 'txn_types', label: 'Transaction types', kind: 'txn_types', default: null }),
  columns: (): ReportParamDef => ({ key: 'columns', label: 'Columns', kind: 'columns', default: null }),
  sort: (): ReportParamDef => ({ key: 'sort', label: 'Sort by', kind: 'sort', default: null }),
  bool: (key: string, label: string, def = false): ReportParamDef => ({ key, label, kind: 'boolean', default: def }),
  choice: (key: string, label: string, options: [string, string][], def: string): ReportParamDef => ({
    key,
    label,
    kind: 'enum',
    default: def,
    options: options.map(([value, l]) => ({ value, label: l })),
  }),
};
