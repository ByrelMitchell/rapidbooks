import {
  formatMoney,
  formatRate,
  formatUsDate,
  isIsoDate,
  presetId,
  resolvePreset,
  type ReportColumn,
  type ReportDef,
  type ReportParamDef,
} from '@rapidbooks/shared';

/**
 * One cell as the report shows it. money: cents with thousands separators and a leading
 * minus (fractions of a cent, as on rate and cost columns, keep their digits);
 * qty: the number as given; percent: two decimals; date: MM/DD/YYYY; missing = blank.
 */
export function formatCell(col: ReportColumn, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    switch (col.kind) {
      case 'money':
        return Number.isInteger(v) ? formatMoney(v) : formatRate(v);
      case 'percent':
        return `${v.toFixed(2)}%`;
      case 'qty':
        return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
      default:
        return String(v);
    }
  }
  if (col.kind === 'date' && isIsoDate(v)) return formatUsDate(v);
  return v;
}

/** Where a column's cells sit: as the column says, else numbers right and the rest left. */
export const columnAlign = (col: ReportColumn): 'left' | 'right' | 'center' =>
  col.align ?? (col.kind === 'money' || col.kind === 'qty' || col.kind === 'percent' ? 'right' : 'left');

// Pure helpers (no React, no DOM) for report parameters: the defaults a report opens with,
// the query string the viewer fetches, what Modify Report changes, Find and graph queries.
// Kept free of browser APIs so the verification script can run them under Node.

/**
 * A report's parameters in query-string form, exactly as the server reads them:
 *   date (a preset id or 'custom') with from / to when custom; as_of (blank = today);
 *   name_ids / item_ids / account_ids / txn_types / columns as comma lists; sort ('-key' = descending);
 *   single ids, enums and booleans ('true' / 'false') under their own keys.
 */
export type ReportParams = Record<string, string>;

const has = (def: ReportDef, kind: ReportParamDef['kind']) => def.params.some((p) => p.kind === kind);
export const hasDateRange = (def: ReportDef) => has(def, 'date_range');
export const hasAsOf = (def: ReportDef) => has(def, 'as_of');
export const canSort = (def: ReportDef) => has(def, 'sort');
export const canChooseColumns = (def: ReportDef) => has(def, 'columns') && def.columns.length > 0;

/** The parameters a report opens with: its default date preset, enum and boolean defaults. */
export function defaultParams(def: ReportDef): ReportParams {
  const p: ReportParams = {};
  for (const d of def.params) {
    if (d.kind === 'date_range') p.date = presetId(String(d.default ?? 'all')) ?? 'all';
    else if (d.kind === 'enum') p[d.key] = String(d.default ?? d.options?.[0]?.value ?? '');
    else if (d.kind === 'boolean') p[d.key] = d.default === true ? 'true' : 'false';
    // as_of: left out = today; filters, columns and sort: left out = none / the default.
  }
  return p;
}

/**
 * The defaults with `over` laid on top (a QuickZoom's params, a memorized report, a QuickReport's id).
 * Explicit from/to without a preset make the range Custom; a preset drops any from/to.
 */
export function mergeParams(def: ReportDef, over?: Record<string, string | number | null | undefined>): ReportParams {
  const p = defaultParams(def);
  if (over) {
    for (const [k, v] of Object.entries(over)) {
      if (v === null || v === undefined) continue;
      p[k] = String(v);
    }
    const explicit = (over.from ?? '') !== '' || (over.to ?? '') !== '';
    if (explicit && (over.date === undefined || over.date === null || over.date === '')) p.date = 'custom';
  }
  if (p.date !== undefined) {
    p.date = presetId(p.date) ?? 'custom';
    if (p.date !== 'custom') {
      delete p.from;
      delete p.to;
    } else {
      p.from = p.from ?? '';
      p.to = p.to ?? '';
    }
  }
  return p;
}

/** The query string (without "?") the viewer fetches for these parameters. */
export function buildQuery(def: ReportDef, params: ReportParams, opts: { csv?: boolean } = {}): string {
  const q = new URLSearchParams();
  const val = (k: string) => (params[k] ?? '').trim();
  for (const d of def.params) {
    switch (d.kind) {
      case 'date_range': {
        const preset = presetId(params.date ?? '') ?? 'custom';
        if (preset === 'custom') {
          q.set('date', 'custom');
          q.set('from', val('from'));
          q.set('to', val('to'));
        } else q.set('date', preset);
        break;
      }
      case 'as_of':
      case 'name_ids':
      case 'item_ids':
      case 'account_ids':
      case 'txn_types':
      case 'account_id':
      case 'name_id':
      case 'item_id':
      case 'columns':
      case 'sort':
        if (val(d.key) !== '') q.set(d.key, val(d.key));
        break;
      case 'enum':
        q.set(d.key, val(d.key) !== '' ? val(d.key) : String(d.default ?? ''));
        break;
      case 'boolean':
        q.set(d.key, val(d.key) === 'true' ? 'true' : val(d.key) === 'false' ? 'false' : d.default === true ? 'true' : 'false');
        break;
    }
  }
  if (opts.csv) q.set('format', 'csv');
  return q.toString();
}

export const reportUrl = (def: ReportDef, params: ReportParams, opts: { csv?: boolean } = {}) => {
  const qs = buildQuery(def, params, opts);
  return `/api/reports/${encodeURIComponent(def.id)}${qs ? `?${qs}` : ''}`;
};

/** The dates a report's range stands for today: from the preset, or the custom dates. */
export function shownRange(params: ReportParams, today: string): { from: string; to: string } {
  const preset = presetId(params.date ?? '') ?? 'custom';
  if (preset === 'custom') return { from: params.from ?? '', to: params.to ?? '' };
  const r = resolvePreset(preset, today);
  return { from: r?.from ?? '', to: r?.to ?? '' };
}

/** The params with one date edited: the range becomes Custom with the dates shown until now. */
export function withDate(params: ReportParams, which: 'from' | 'to', iso: string, today: string): ReportParams {
  const cur = shownRange(params, today);
  return { ...params, date: 'custom', from: which === 'from' ? iso : cur.from, to: which === 'to' ? iso : cur.to };
}

/** The params with a preset chosen (Custom keeps the dates shown until now). */
export function withPreset(params: ReportParams, preset: string, today: string): ReportParams {
  if (preset === 'custom') {
    const cur = shownRange(params, today);
    return { ...params, date: 'custom', from: cur.from, to: cur.to };
  }
  const p: ReportParams = { ...params, date: preset };
  delete p.from;
  delete p.to;
  return p;
}

/** Set or clear one parameter (blank removes it). */
export function withParam(params: ReportParams, key: string, value: string | null): ReportParams {
  const p = { ...params };
  if (value === null || value === '') delete p[key];
  else p[key] = value;
  return p;
}

// ---------------------------------------------------------------------------
// Columns and sorting (Modify Report > Display)

export const idList = (s: string | undefined): number[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n));

export const strList = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** The column keys shown, in order. */
export function shownColumns(def: ReportDef, params: ReportParams): string[] {
  const keys = strList(params.columns).filter((k) => def.columns.some((c) => c.key === k));
  return keys.length ? keys : [...def.default_columns];
}

/**
 * Every column in checklist order: the shown ones in their order, then the rest in the
 * report's own order. `on` = shown.
 */
export function columnChecklist(def: ReportDef, params: ReportParams): { key: string; title: string; on: boolean }[] {
  const shown = shownColumns(def, params);
  const title = (k: string) => def.columns.find((c) => c.key === k)?.title || k;
  return [
    ...shown.map((k) => ({ key: k, title: title(k), on: true })),
    ...def.columns.filter((c) => !shown.includes(c.key)).map((c) => ({ key: c.key, title: c.title || c.key, on: false })),
  ];
}

/** The params with these columns shown in this order (the default set is left implicit). */
export function withColumns(def: ReportDef, params: ReportParams, keys: string[]): ReportParams {
  const same = keys.length === def.default_columns.length && keys.every((k, i) => k === def.default_columns[i]);
  return withParam(params, 'columns', same || keys.length === 0 ? null : keys.join(','));
}

/** The sort column and direction (null = the report's own order). */
export function sortOf(params: ReportParams): { key: string | null; desc: boolean } {
  const s = (params.sort ?? '').trim();
  if (!s) return { key: null, desc: false };
  return s.startsWith('-') ? { key: s.slice(1), desc: true } : { key: s, desc: false };
}

export const withSort = (params: ReportParams, key: string | null, desc: boolean) =>
  withParam(params, 'sort', key ? `${desc ? '-' : ''}${key}` : null);

export const withIds = (params: ReportParams, key: string, ids: (number | string)[]) =>
  withParam(params, key, ids.length ? ids.join(',') : null);

// ---------------------------------------------------------------------------
// Required single-id parameters (the bank account of Cleared and Uncleared Transactions)

export interface PickRow {
  id: number;
  inactive: boolean;
  type?: string; // accounts
  kind?: string; // names
}

/** Fill a required account / name / item the way the viewer does: the first active one that fits. */
export function fillRequired(
  def: ReportDef,
  params: ReportParams,
  lists: { accounts?: PickRow[]; names?: PickRow[]; items?: PickRow[] },
): ReportParams {
  let p = params;
  for (const d of def.params) {
    if (!d.required || (p[d.key] ?? '') !== '') continue;
    let rows: PickRow[] | undefined;
    if (d.kind === 'account_id') rows = lists.accounts?.filter((a) => !d.account_types || d.account_types.includes(a.type ?? ''));
    else if (d.kind === 'name_id') rows = lists.names?.filter((n) => !d.name_kind || n.kind === d.name_kind);
    else if (d.kind === 'item_id') rows = lists.items;
    const pick = rows?.find((r) => !r.inactive) ?? rows?.[0];
    if (pick) p = { ...p, [d.key]: String(pick.id) };
  }
  return p;
}

/** The required parameters still missing (the viewer waits for them instead of fetching). */
export const missingRequired = (def: ReportDef, params: ReportParams) =>
  def.params.filter((d) => d.required && (params[d.key] ?? '') === '');

// ---------------------------------------------------------------------------
// Export file name

/** "Profit & Loss 2026-01-01 to 2026-11-11.csv", "Balance Sheet as of 2026-11-11.csv". */
export function csvFileName(def: ReportDef, title: string, params: ReportParams, today: string): string {
  let when = '';
  if (hasDateRange(def)) {
    const r = shownRange(params, today);
    if (r.from && r.to) when = r.from === r.to ? r.from : `${r.from} to ${r.to}`;
    else if (r.from) when = `from ${r.from}`;
    else if (r.to) when = `through ${r.to}`;
    else when = 'All Dates';
  } else if (hasAsOf(def)) {
    when = `as of ${params.as_of || today}`;
  }
  const name = `${title}${when ? ` ${when}` : ''}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `${name || 'Report'}.csv`;
}

// ---------------------------------------------------------------------------
// Find (Ctrl+F)

export interface FindForm {
  type: string; // '' = any
  nameId: number | null;
  from: string;
  to: string;
  num: string;
  amountMode: 'exact' | 'range';
  amount: number | null; // cents
  amountMin: number | null;
  amountMax: number | null;
  text: string;
  accountId: number | null;
  itemId: number | null;
}

export const emptyFind = (): FindForm => ({
  type: '',
  nameId: null,
  from: '',
  to: '',
  num: '',
  amountMode: 'exact',
  amount: null,
  amountMin: null,
  amountMax: null,
  text: '',
  accountId: null,
  itemId: null,
});

export function findUrl(f: FindForm, limit = 200): string {
  const q = new URLSearchParams();
  if (f.type) q.set('types', f.type);
  if (f.nameId !== null) q.set('name_id', String(f.nameId));
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.num.trim()) q.set('num', f.num.trim());
  if (f.amountMode === 'exact') {
    if (f.amount !== null) q.set('amount', String(Math.round(f.amount)));
  } else {
    if (f.amountMin !== null) q.set('amount_min', String(Math.round(f.amountMin)));
    if (f.amountMax !== null) q.set('amount_max', String(Math.round(f.amountMax)));
  }
  if (f.text.trim()) q.set('text', f.text.trim());
  if (f.accountId !== null) q.set('account_id', String(f.accountId));
  if (f.itemId !== null) q.set('item_id', String(f.itemId));
  q.set('limit', String(limit));
  return `/api/find?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Graphs

export interface GraphQuery {
  date: string; // preset id or 'custom'
  from: string;
  to: string;
}

function rangeQuery(g: GraphQuery, q: URLSearchParams) {
  const preset = presetId(g.date) ?? 'custom';
  if (preset === 'custom') {
    q.set('from', g.from);
    q.set('to', g.to);
  } else q.set('date', preset);
}

export function salesGraphUrl(g: GraphQuery & { by: 'customer' | 'item'; top: number; ids: number[] }): string {
  const q = new URLSearchParams();
  rangeQuery(g, q);
  q.set('by', g.by);
  q.set('top', String(g.top));
  if (g.ids.length) q.set(g.by === 'customer' ? 'name_ids' : 'item_ids', g.ids.join(','));
  return `/api/graphs/sales?${q.toString()}`;
}

export function incomeExpenseUrl(g: GraphQuery): string {
  const q = new URLSearchParams();
  rangeQuery(g, q);
  return `/api/graphs/income-expense?${q.toString()}`;
}

/** First and last day of a "YYYY-MM" month, clipped to the graph's range. */
export function monthRange(ym: string, clip: { from: string; to: string }): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let from = `${ym}-01`;
  let to = `${ym}-${String(last).padStart(2, '0')}`;
  if (clip.from && clip.from > from) from = clip.from;
  if (clip.to && clip.to < to) to = clip.to;
  return { from, to };
}

/** QuickZoom from a sales graph: the detail report for one customer or item over a range. */
export function salesGraphDrill(by: 'customer' | 'item', id: number, range: { from: string; to: string }): { report: string; params: ReportParams } {
  return by === 'customer'
    ? { report: 'sales_by_customer_detail', params: { date: 'custom', from: range.from, to: range.to, name_ids: String(id) } }
    : { report: 'sales_by_item_detail', params: { date: 'custom', from: range.from, to: range.to, item_ids: String(id) } };
}

// ---------------------------------------------------------------------------
// Memorized reports (stored as one JSON string under a company key)

export const MEMORIZED_KEY = 'memorized_reports';

export interface MemorizedReport {
  name: string;
  report_id: string;
  params: ReportParams;
}

export function parseMemorized(json: string | undefined | null): MemorizedReport[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is MemorizedReport => !!x && typeof x === 'object' && typeof x.name === 'string' && typeof x.report_id === 'string')
      .map((x) => ({
        name: x.name,
        report_id: x.report_id,
        params: Object.fromEntries(Object.entries(x.params && typeof x.params === 'object' ? x.params : {}).map(([k, v]) => [k, String(v)])),
      }));
  } catch {
    return [];
  }
}

export const sortMemorized = (list: MemorizedReport[]) =>
  [...list].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
