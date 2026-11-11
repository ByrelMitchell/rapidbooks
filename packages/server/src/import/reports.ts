import { GRAND_TOTAL, norm, PARENT_OTHER, PL_COMPUTED, PL_NET_INCOME, SUBTOTAL_LABEL, TYPE_MAP, VERIFY_COLUMNS } from './layout';
import { cleanAccountName } from './journal';
import { decodeText, detectDelimiter, isBlankRow, mapHeader, parseAmount, parsePeriodHeader, parseQbDate, tokenize, type TableRow } from './table';

// Reading the optional QuickBooks verification reports: Trial Balance, Open Invoices /
// A/R Aging Summary, Unpaid Bills Detail / A/P Aging Summary, Profit & Loss.
//
// These are "grouped" reports: a customer, vendor or parent account appears on a row of
// its own in a leading, unlabelled column; the rows under it are indented one column
// further; a "Total ..." row closes the group; a "TOTAL" row ends the report.

type VerifyField = keyof typeof VERIFY_COLUMNS;

interface Grouped {
  header: string[];
  col: Partial<Record<VerifyField, number>>;
  labelCols: number[]; // unlabelled leading columns, in order
  rows: { line: number; cells: string[]; label: string; depth: number; path: string[] }[];
}

/**
 * Find the header row with `isHeader`, then walk the rows keeping the stack of group
 * labels. Each returned row has its own label (if any), its depth (which unlabelled
 * column the label is in) and the labels of the groups it is in.
 */
function readGrouped(data: Uint8Array | string, isHeader: (cells: string[]) => boolean, what: string): Grouped {
  const text = typeof data === 'string' ? data : decodeText(data);
  const rows = tokenize(text, detectDelimiter(text));
  const h = rows.findIndex((r, i) => i < 200 && isHeader(r.cells));
  if (h < 0) throw new Error(`This file does not look like a QuickBooks ${what} export: its column headings were not found.`);
  const header = rows[h].cells.map((c) => c.trim());
  const col = mapHeader(header, VERIFY_COLUMNS);
  const mapped = new Set(Object.values(col) as number[]);
  const width = Math.max(...rows.slice(h).map((r) => r.cells.length));
  const labelCols: number[] = [];
  for (let i = 0; i < width; i++) if ((header[i] ?? '') === '' && !mapped.has(i)) labelCols.push(i);
  if (col.account !== undefined) labelCols.unshift(col.account);
  if (col.name !== undefined && col.type === undefined) labelCols.unshift(col.name);

  const out: Grouped['rows'] = [];
  const stack: string[] = [];
  for (const r of rows.slice(h + 1) as TableRow[]) {
    if (isBlankRow(r.cells)) continue;
    let label = '';
    let depth = 0;
    for (let k = 0; k < labelCols.length; k++) {
      const v = (r.cells[labelCols[k]] ?? '').trim();
      if (v !== '') {
        label = v;
        depth = k;
        break;
      }
    }
    out.push({ line: r.line, cells: r.cells, label, depth, path: label === '' ? [...stack] : stack.slice(0, depth) });
    // Is it a group heading (a label and nothing else)?
    const others = r.cells.some((c, i) => i !== labelCols[depth] && c.trim() !== '');
    if (label !== '' && !others && !SUBTOTAL_LABEL.test(label) && !GRAND_TOTAL.test(label)) {
      stack.length = depth;
      stack[depth] = label;
    } else if (SUBTOTAL_LABEL.test(label)) {
      stack.length = Math.min(stack.length, depth); // "Total X" closes group X
    }
  }
  return { header, col, labelCols, rows: out };
}

const cell = (cells: string[], i: number | undefined) => (i === undefined ? '' : (cells[i] ?? '').trim());

// ---------------------------------------------------------------------------
// Open Invoices / Unpaid Bills (detail) and A/R / A/P Aging Summary

export interface OpenDoc {
  line: number;
  qbType: string;
  mapped: string | null; // RapidBooks type of qbType, if any
  date: string | null;
  num: string;
  name: string; // Customer:Job or vendor (full name)
  open: number; // cents as QuickBooks shows it: positive for documents, negative for credits
}

export interface OpenDocsReport {
  format: 'detail' | 'summary';
  docs: OpenDoc[]; // detail
  balances: { line: number; name: string; total: number }[]; // summary (per name, jobs separately)
  warnings: string[];
}

export function parseOpenDocs(data: Uint8Array | string, what: string): OpenDocsReport {
  const g = readGrouped(
    data,
    (cells) => {
      const m = mapHeader(cells, VERIFY_COLUMNS);
      return (m.type !== undefined && m.openBalance !== undefined) || (m.current !== undefined && m.total !== undefined);
    },
    what,
  );
  const warnings: string[] = [];
  if (g.col.type !== undefined && g.col.openBalance !== undefined) {
    const docs: OpenDoc[] = [];
    for (const r of g.rows) {
      const qbType = cell(r.cells, g.col.type);
      if (qbType === '') continue;
      const open = parseAmount(cell(r.cells, g.col.openBalance));
      if (open === null || Number.isNaN(open)) {
        warnings.push(`Line ${r.line}: the open balance "${cell(r.cells, g.col.openBalance)}" cannot be read; the line was ignored.`);
        continue;
      }
      const name = g.col.name !== undefined && cell(r.cells, g.col.name) !== '' ? cell(r.cells, g.col.name) : r.path.join(':');
      docs.push({
        line: r.line,
        qbType,
        mapped: TYPE_MAP[norm(qbType)]?.type ?? null,
        date: parseQbDate(cell(r.cells, g.col.date)),
        num: cell(r.cells, g.col.num),
        name,
        open,
      });
    }
    return { format: 'detail', docs, balances: [], warnings };
  }
  const balances: OpenDocsReport['balances'] = [];
  for (const r of g.rows) {
    if (r.label === '' || SUBTOTAL_LABEL.test(r.label) || GRAND_TOTAL.test(r.label)) continue;
    const total = parseAmount(cell(r.cells, g.col.total));
    if (total === null || Number.isNaN(total)) continue;
    const label = r.label.replace(PARENT_OTHER, '');
    const name = PARENT_OTHER.test(r.label) ? r.path.join(':') || label : [...r.path, label].join(':');
    balances.push({ line: r.line, name, total });
  }
  return { format: 'summary', docs: [], balances, warnings };
}

// ---------------------------------------------------------------------------
// Trial Balance

export interface AccountLine {
  line: number;
  label: string; // as printed, account number removed
  path: string[]; // labels of the groups above it (parent accounts in an indented layout)
  amounts: number[]; // cents; TB: one value, debit positive; P&L: one per period
}

export function parseTrialBalance(data: Uint8Array | string): { lines: AccountLine[]; warnings: string[] } {
  const g = readGrouped(
    data,
    (cells) => {
      const m = mapHeader(cells, VERIFY_COLUMNS);
      return m.debit !== undefined && m.credit !== undefined;
    },
    'Trial Balance',
  );
  const warnings: string[] = [];
  const lines: AccountLine[] = [];
  for (const r of g.rows) {
    if (r.label === '' || GRAND_TOTAL.test(r.label) || SUBTOTAL_LABEL.test(r.label)) continue;
    const dr = parseAmount(cell(r.cells, g.col.debit));
    const cr = parseAmount(cell(r.cells, g.col.credit));
    if (dr === null && cr === null) continue;
    if (Number.isNaN(dr) || Number.isNaN(cr)) {
      warnings.push(`Line ${r.line}: an amount of "${r.label}" cannot be read; the line was ignored.`);
      continue;
    }
    lines.push({ line: r.line, label: cleanAccountName(r.label), path: r.path.map(cleanAccountName), amounts: [(dr ?? 0) - (cr ?? 0)] });
  }
  return { lines, warnings };
}

// ---------------------------------------------------------------------------
// Profit & Loss

export interface ProfitLoss {
  periods: { from: string; to: string }[];
  lines: AccountLine[]; // amounts as QuickBooks shows them: income and expenses positive
  netIncome: (number | null)[];
  warnings: string[];
}

/**
 * Periods come from the amount columns' headings ("Jan - Dec 25", "2025"); a single
 * column headed "TOTAL" (or anything else) uses `fallback`, the period given on the
 * command line. A "TOTAL" column next to period columns is ignored.
 */
export function parseProfitLoss(data: Uint8Array | string, fallback?: { from: string; to: string }): ProfitLoss {
  const isHeader = (cells: string[]) => cells.some((c) => parsePeriodHeader(c) !== null || norm(c) === 'total');
  const g = readGrouped(data, isHeader, 'Profit & Loss');
  const periodCols: { col: number; from: string; to: string }[] = [];
  g.header.forEach((h, i) => {
    const p = parsePeriodHeader(h);
    if (p) periodCols.push({ col: i, ...p });
  });
  if (periodCols.length === 0) {
    const total = g.header.findIndex((h) => norm(h) === 'total');
    if (total < 0 || !fallback) {
      throw new Error('The Profit & Loss export has no column for a whole year; give its period with --pl-from and --pl-to.');
    }
    periodCols.push({ col: total, ...fallback });
  }
  // The headings are not label columns.
  const amountCols = new Set(periodCols.map((p) => p.col));
  const warnings: string[] = [];
  const lines: AccountLine[] = [];
  const netIncome: (number | null)[] = periodCols.map(() => null);
  for (const r of g.rows) {
    if (r.label === '' || GRAND_TOTAL.test(r.label) || SUBTOTAL_LABEL.test(r.label)) continue;
    const amounts = periodCols.map((p) => parseAmount(cell(r.cells, p.col)));
    if (amounts.every((a) => a === null)) continue;
    if (amounts.some((a) => a !== null && Number.isNaN(a))) {
      warnings.push(`Line ${r.line}: an amount of "${r.label}" cannot be read; the line was ignored.`);
      continue;
    }
    if (PL_NET_INCOME.test(r.label)) {
      amounts.forEach((a, i) => (netIncome[i] = a ?? 0));
      continue;
    }
    if (PL_COMPUTED.test(r.label)) continue;
    if (amountCols.has(g.labelCols[r.depth])) continue;
    lines.push({ line: r.line, label: cleanAccountName(r.label), path: r.path.map(cleanAccountName), amounts: amounts.map((a) => a ?? 0) });
  }
  return { periods: periodCols.map(({ from, to }) => ({ from, to })), lines, netIncome, warnings };
}
