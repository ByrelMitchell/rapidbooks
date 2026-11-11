import { addDays } from './dates';

// Reports (Phase 5): the one generic report shape every report is returned in, the
// registry entry describing each report, the date-range presets, Find and graphs.

// ---------------------------------------------------------------------------
// Date-range presets. The fiscal year is the calendar year; weeks run Sunday to
// Saturday, as in QuickBooks.

export const DATE_PRESETS = [
  { id: 'all', label: 'All' },
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This Week' },
  { id: 'this_week_to_date', label: 'This Week-to-date' },
  { id: 'this_month', label: 'This Month' },
  { id: 'this_month_to_date', label: 'This Month-to-date' },
  { id: 'this_fiscal_quarter', label: 'This Fiscal Quarter' },
  { id: 'this_fiscal_quarter_to_date', label: 'This Fiscal Quarter-to-date' },
  { id: 'this_fiscal_year', label: 'This Fiscal Year' },
  { id: 'this_fiscal_year_to_date', label: 'This Fiscal Year-to-date' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_week', label: 'Last Week' },
  { id: 'last_month', label: 'Last Month' },
  { id: 'last_fiscal_quarter', label: 'Last Fiscal Quarter' },
  { id: 'last_fiscal_year', label: 'Last Fiscal Year' },
  { id: 'custom', label: 'Custom' },
] as const;
export type DatePresetId = (typeof DATE_PRESETS)[number]['id'];

export interface DateRange {
  from: string | null; // null = from the beginning
  to: string | null; // null = through the end
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const ymd = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
};

/** The preset id for an id or a label ("This Month-to-date", "this_month_to_date"), or null. */
export function presetId(name: string): DatePresetId | null {
  const n = name.trim().toLowerCase();
  const p = DATE_PRESETS.find((x) => x.id === n || x.label.toLowerCase() === n);
  return p ? p.id : null;
}

/**
 * The dates a preset stands for on `today` (ISO). 'all' is { from: null, to: null };
 * 'custom' and unknown names give null (the caller supplies explicit dates).
 */
export function resolvePreset(name: string, today: string): DateRange | null {
  const id = presetId(name);
  if (id === null || id === 'custom') return null;
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const weekStart = addDays(today, -dow);
  const q = Math.floor((m - 1) / 3); // 0..3
  const qStart = ymd(y, q * 3 + 1, 1);
  const qEnd = ymd(y, q * 3 + 4, 0);
  switch (id) {
    case 'all':
      return { from: null, to: null };
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const yd = addDays(today, -1);
      return { from: yd, to: yd };
    }
    case 'this_week':
      return { from: weekStart, to: addDays(weekStart, 6) };
    case 'this_week_to_date':
      return { from: weekStart, to: today };
    case 'last_week':
      return { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };
    case 'this_month':
      return { from: ymd(y, m, 1), to: ymd(y, m + 1, 0) };
    case 'this_month_to_date':
      return { from: ymd(y, m, 1), to: today };
    case 'last_month':
      return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) };
    case 'this_fiscal_quarter':
      return { from: qStart, to: qEnd };
    case 'this_fiscal_quarter_to_date':
      return { from: qStart, to: today };
    case 'last_fiscal_quarter':
      return { from: ymd(y, q * 3 - 2, 1), to: ymd(y, q * 3 + 1, 0) };
    case 'this_fiscal_year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'this_fiscal_year_to_date':
      return { from: `${y}-01-01`, to: today };
    case 'last_fiscal_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  }
}

// ---------------------------------------------------------------------------
// The generic report

export type ReportColumnKind = 'text' | 'money' | 'qty' | 'date' | 'percent';

export interface ReportColumn {
  key: string;
  title: string;
  /**
   * money: integer cents. qty: a plain number (quantities, hours, counts).
   * percent: a plain number of percent, two decimals (12.5 = 12.5%). date: ISO date.
   */
  kind: ReportColumnKind;
  align?: 'left' | 'right' | 'center'; // default: right for numbers, left otherwise
}

/** Where double-clicking a row goes: a transaction, or another report with these query parameters. */
export type ReportDrill =
  | { txn: { id: number; type: string } }
  | { report: string; params: Record<string, string> };

export interface ReportRow {
  /**
   * header: a section or group title (its label is in the first column).
   * data: an ordinary row. subtotal / total: sums (total = the report's grand total).
   * blank: an empty spacer row.
   */
  kind: 'header' | 'data' | 'subtotal' | 'total' | 'blank';
  depth: number; // indentation level, 0 = flush left
  cells: Record<string, string | number | null>; // keyed by column key; missing or null = blank
  drill?: ReportDrill;
}

export type ReportParamValue = string | number | boolean | number[] | string[] | null;

export interface Report {
  id: string;
  title: string;
  subtitle: string; // "January 1 through March 31, 2026", "As of March 31, 2026", "All Transactions"
  columns: ReportColumn[]; // the columns shown, in order
  rows: ReportRow[];
  /** The normalised parameters used: from/to resolved from the preset, as_of, filters, columns, sort... */
  params: Record<string, ReportParamValue>;
}

export const REPORT_GROUPS = [
  'Company & Financial',
  'Customers & Receivables',
  'Sales',
  'Vendors & Payables',
  'Purchases',
  'Banking',
  'Employees & Payroll',
  'Lists',
  'Accountant',
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/**
 * A parameter a report accepts. In the query string:
 *   date_range   date=<preset id or label>, or from=YYYY-MM-DD&to=YYYY-MM-DD (either may be blank)
 *   as_of        as_of=YYYY-MM-DD
 *   name_ids / item_ids / account_ids: comma-separated ids (a customer includes its jobs)
 *   txn_types    comma-separated type codes (INVOICE, CHECK, ...)
 *   account_id / name_id / item_id: one id
 *   enum         one of options[].value
 *   boolean      true / false
 *   columns      comma-separated column keys, in display order
 *   sort         a column key, '-' in front for descending
 */
export interface ReportParamDef {
  key: string; // 'date' for date_range (with 'from' and 'to'), else the query key
  label: string;
  kind:
    | 'date_range'
    | 'as_of'
    | 'name_ids'
    | 'item_ids'
    | 'account_ids'
    | 'txn_types'
    | 'account_id'
    | 'name_id'
    | 'item_id'
    | 'enum'
    | 'boolean'
    | 'columns'
    | 'sort';
  /** date_range: a preset id; as_of: 'today'; enum: a value; boolean: true/false; others null. */
  default: string | boolean | null;
  options?: { value: string; label: string }[]; // enum
  name_kind?: 'customer' | 'vendor' | 'employee' | 'other'; // name_ids / name_id: which list to choose from
  account_types?: string[]; // account_ids / account_id: which account types to offer
  required?: boolean;
}

export interface ReportDef {
  id: string;
  title: string;
  group: ReportGroup;
  description: string;
  params: ReportParamDef[];
  /** Every column the report can show (choose and order them with `columns`); empty when fixed. */
  columns: ReportColumn[];
  default_columns: string[]; // keys shown when `columns` is not given
}

/** Type names as QuickBooks prints them in the Type column of its reports. */
export const REPORT_TYPE_LABELS: Record<string, string> = {
  GENJRNL: 'General Journal',
  INVOICE: 'Invoice',
  CREDITMEMO: 'Credit Memo',
  PAYMENT: 'Payment',
  DEPOSIT: 'Deposit',
  PURCHORD: 'Purchase Order',
  BILL: 'Bill',
  BILLCREDIT: 'Credit',
  BILLPMT: 'Bill Pmt -Check',
  CHECK: 'Check',
  TRANSFER: 'Transfer',
  PAYCHECK: 'Paycheck',
};

// ---------------------------------------------------------------------------
// Find (Ctrl+F): GET /api/find

export interface FindRow {
  id: number;
  type: string; // type code
  type_label: string; // as in reports
  date: string;
  num: string;
  name_id: number | null;
  name: string; // Customer:Job
  account: string; // the transaction's main account (A/R, A/P, the bank...)
  memo: string;
  amount: number; // cents: the transaction total
}

export interface FindResult {
  rows: FindRow[]; // newest first
  more: boolean; // more matches exist than were returned
}

// ---------------------------------------------------------------------------
// Graphs: GET /api/graphs/sales and /api/graphs/income-expense. All values in cents.

export interface GraphSeries {
  name: string;
  id: number | null; // the customer or item id; null for "Other" and computed series
  values: number[]; // one per label
}

export interface GraphData {
  labels: string[]; // "Jan 2026", ...
  keys: string[]; // "2026-01", ... (one per label)
  series: GraphSeries[];
}

export interface SalesGraph extends GraphData {
  by: 'customer' | 'item';
  from: string;
  to: string;
  /** Totals for the whole range, for a pie or bar chart: one label per series. */
  breakdown: { labels: string[]; values: number[]; ids: (number | null)[] };
  total: number;
}
