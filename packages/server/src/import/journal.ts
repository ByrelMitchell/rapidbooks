import { ACCOUNT_NUMBER_PREFIX, GRAND_TOTAL, JOURNAL_COLUMNS, JOURNAL_HEADER_REQUIRED, NOT_CLEARED, norm, type JournalField } from './layout';
import { decodeText, detectDelimiter, isBlankRow, mapHeader, parseAmount, parseNumber, parseQbDate, tokenize, type TableRow } from './table';

// Reading the QuickBooks Journal report export into transactions and their splits.
//
// One report row per split. The first row of a transaction carries Trans #, Type, Date
// and Num; later rows may repeat them or leave them blank. A transaction ends at a row
// with a different Trans #, a blank line, or its total row (no account, amounts only).
// Title lines above the header, blank spacer columns and the grand TOTAL row are ignored.

export interface JournalRow {
  line: number;
  account: string; // full colon-separated name, account number removed
  amount: number; // cents, debit positive
  name: string;
  memo: string;
  cleared: boolean;
  item: string;
  itemDesc: string;
  qty: number | null;
  price: { value: number; percent: boolean } | null;
  po: string;
  terms: string;
  dueDate: string | null;
  shipDate: string | null;
  via: string;
  openBalance: number | null;
  paid: string;
  address: string;
  payMeth: string;
  source: string;
  num: string;
}

export interface JournalTxn {
  line: number; // where it starts in the file
  file?: string; // which file, when several Journal files are read together
  transNo: string;
  qbType: string; // as written ("Bill Pmt -Check")
  date: string | null; // ISO; null if missing/unreadable
  rawDate: string;
  num: string;
  rows: JournalRow[];
  problems: string[]; // reasons it cannot be imported (bad amount...)
}

export interface ParsedJournal {
  txns: JournalTxn[];
  rowsRead: number; // split rows
  columns: JournalField[]; // which columns were found
  delimiter: ',' | '\t';
  warnings: string[];
}

// QuickBooks 2013 writes the Item column as "Name (Description)", or "(Description)"
// for a line with no item; long values may be cut off, closing parenthesis included.
// Return the item name alone: the text before the "(" whose remainder is the row's
// Item Description (spacing ignored). Without a matching description, unchanged.
export function itemName(item: string, desc: string): string {
  const ws = (s: string) => s.replace(/\s+/g, ' ').trim();
  const d = ws(desc);
  if (d === '') return item;
  for (let i = item.indexOf('('); i >= 0; i = item.indexOf('(', i + 1)) {
    let rest = ws(item.slice(i + 1));
    if (rest.endsWith(')') && ws(rest.slice(0, -1)) === d) return item.slice(0, i).trim();
    rest = rest.replace(/\.{3}$/, '').trim();
    if (rest.length >= 10 && !item.trimEnd().endsWith(')') && d.startsWith(rest)) return item.slice(0, i).trim();
  }
  return item;
}

export function cleanAccountName(s: string): string {
  return s
    .split(':')
    .map((seg) => seg.replace(ACCOUNT_NUMBER_PREFIX, '').trim())
    .join(':');
}

function findHeader(rows: TableRow[]): number {
  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const map = mapHeader(rows[i].cells, JOURNAL_COLUMNS);
    if (JOURNAL_HEADER_REQUIRED.every((alts) => alts.some((f) => map[f] !== undefined))) return i;
  }
  return -1;
}

export function parseJournal(data: Uint8Array | string): ParsedJournal {
  const text = typeof data === 'string' ? data : decodeText(data);
  const delimiter = detectDelimiter(text);
  const rows = tokenize(text, delimiter);
  const h = findHeader(rows);
  if (h < 0) {
    throw new Error(
      'This file does not look like a QuickBooks Journal report export: no header row with Account, Debit/Credit and Type/Date columns was found.',
    );
  }
  const col = mapHeader(rows[h].cells, JOURNAL_COLUMNS);
  const headerKey = rows[h].cells.map(norm).join('|');
  const warnings: string[] = [];
  const get = (cells: string[], f: JournalField) => {
    const i = col[f];
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };
  // Raw (untrimmed) for memos and addresses, keeping inner line breaks.
  const getText = (cells: string[], f: JournalField) => {
    const i = col[f];
    return i === undefined ? '' : (cells[i] ?? '').replace(/\r\n?/g, '\n').trim();
  };

  const txns: JournalTxn[] = [];
  let cur: JournalTxn | null = null;
  let rowsRead = 0;
  // Columns that are not one of ours: a "TOTAL" there marks the grand total row.
  const known = new Set(Object.values(col) as number[]);

  for (let r = h + 1; r < rows.length; r++) {
    const { cells, line } = rows[r];
    if (isBlankRow(cells)) {
      cur = null;
      continue;
    }
    if (cells.map(norm).join('|') === headerKey) continue; // header repeated (page break)
    const account = cleanAccountName(get(cells, 'account'));
    const debitText = get(cells, 'debit');
    const creditText = get(cells, 'credit');
    const amountText = get(cells, 'amount');
    const hasAmount = debitText !== '' || creditText !== '' || amountText !== '';
    const transNo = get(cells, 'trans');
    const type = get(cells, 'type');
    const rawDate = get(cells, 'date');
    const num = get(cells, 'num');

    if (account === '') {
      const label = cells.find((c, i) => !known.has(i) && c.trim() !== '') ?? '';
      if (GRAND_TOTAL.test(label.trim()) || cells.some((c) => GRAND_TOTAL.test(c.trim()))) {
        cur = null;
        continue;
      }
      if (hasAmount) {
        // The transaction's total row.
        if (cur) {
          const dr = cur.rows.reduce((t, x) => t + (x.amount > 0 ? x.amount : 0), 0);
          const total = parseAmount(debitText || amountText);
          if (total !== null && !Number.isNaN(total) && total !== dr && cur.problems.length === 0) {
            warnings.push(`Line ${line}: the total row of transaction ${cur.transNo || cur.num || cur.rawDate} (${(total / 100).toFixed(2)}) differs from the sum of its debits (${(dr / 100).toFixed(2)}).`);
          }
        }
        cur = null;
        continue;
      }
      // A row without account or amount: a heading or a line of text. Nothing to import.
      continue;
    }

    rowsRead++;
    const startsNew =
      cur === null ||
      (col.trans !== undefined ? transNo !== '' && transNo !== cur.transNo : (type !== '' && type !== cur.qbType) || (rawDate !== '' && rawDate !== cur.rawDate) || (num !== '' && num !== cur.num));
    if (startsNew) {
      cur = {
        line,
        transNo,
        qbType: type,
        date: parseQbDate(rawDate),
        rawDate,
        num,
        rows: [],
        problems: [],
      };
      txns.push(cur);
    }
    const t = cur!;
    if (t.qbType === '' && type !== '') t.qbType = type;
    if (t.rawDate === '' && rawDate !== '') {
      t.rawDate = rawDate;
      t.date = parseQbDate(rawDate);
    }
    if (t.num === '' && num !== '') t.num = num;

    let amount: number;
    if (col.debit !== undefined || col.credit !== undefined) {
      const dr = parseAmount(debitText) ?? 0;
      const cr = parseAmount(creditText) ?? 0;
      amount = dr - cr;
      if (Number.isNaN(amount)) t.problems.push(`line ${line}: the amount "${debitText || creditText}" cannot be read`);
    } else {
      amount = parseAmount(amountText) ?? 0;
      if (Number.isNaN(amount)) t.problems.push(`line ${line}: the amount "${amountText}" cannot be read`);
    }

    const date = (f: JournalField) => {
      const s = get(cells, f);
      return s === '' ? null : parseQbDate(s);
    };
    const qty = parseNumber(get(cells, 'qty'));
    const street = [getText(cells, 'street1'), getText(cells, 'street2'), [get(cells, 'city'), get(cells, 'state')].filter((s) => s).join(', ') + (get(cells, 'zip') ? ` ${get(cells, 'zip')}` : '')]
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .join('\n');
    const ob = parseAmount(get(cells, 'openBalance'));
    t.rows.push({
      line,
      account,
      amount: Number.isNaN(amount) ? 0 : amount,
      name: get(cells, 'name'),
      memo: getText(cells, 'memo'),
      cleared: !NOT_CLEARED.has(get(cells, 'clr').toLowerCase()),
      item: itemName(get(cells, 'item'), getText(cells, 'itemDesc')),
      itemDesc: getText(cells, 'itemDesc'),
      qty: qty ? qty.value : null,
      price: parseNumber(get(cells, 'price')),
      po: get(cells, 'po'),
      terms: get(cells, 'terms'),
      dueDate: date('dueDate'),
      shipDate: date('shipDate'),
      via: get(cells, 'via'),
      openBalance: ob === null || Number.isNaN(ob) ? null : ob,
      paid: get(cells, 'paid'),
      address: getText(cells, 'address') || street,
      payMeth: get(cells, 'payMeth'),
      source: get(cells, 'source'),
      num,
    });
  }

  // QuickBooks ends every transaction with its total row and the report with TOTAL. A
  // file that stops inside an unbalanced transaction was cut off (an export row limit).
  if (cur && cur.problems.length === 0) {
    const sum = cur.rows.reduce((t, x) => t + x.amount, 0);
    if (sum !== 0) {
      const dr = cur.rows.reduce((t, x) => t + (x.amount > 0 ? x.amount : 0), 0);
      const cr = dr - sum;
      cur.problems.push(
        `the file ends in the middle of this transaction (debits ${(dr / 100).toFixed(2)}, credits ${(cr / 100).toFixed(2)}): the export was cut off and everything after this is missing. Export the Journal in shorter date ranges and give each file with its own --journal`,
      );
      warnings.push(`The file stops at line ${cur.line} in the middle of a transaction, without the report's TOTAL row: it looks cut off. Everything after that is missing.`);
    }
  }

  return {
    txns,
    rowsRead,
    columns: (Object.keys(col) as JournalField[]).filter((k) => col[k] !== undefined),
    delimiter,
    warnings,
  };
}

export interface JournalFile {
  name: string;
  data: Uint8Array | string;
}

export interface JournalFileSummary {
  name: string;
  txns: number;
  rows: number;
  delimiter: ',' | '\t';
  first: string | null; // earliest and latest transaction dates (ISO)
  last: string | null;
}

export interface ParsedJournals extends ParsedJournal {
  files: JournalFileSummary[];
  /** Transactions found in more than one file (overlapping date ranges), imported once. */
  duplicates: number;
}

const signature = (t: JournalTxn) => JSON.stringify([norm(t.qbType), t.date, t.num, t.rows.map((r) => [r.account.toLowerCase(), r.amount, r.name.toLowerCase()])]);

/**
 * Several Journal exports (one per date range) read as one Journal. The files are taken
 * in date order. A transaction in two files (overlapping ranges) is kept once; the same
 * Trans # with different lines in two files gets a problem, so it is skipped and shown.
 * Columns: those every file has. Each transaction's `file` says where it came from.
 */
export function parseJournals(files: JournalFile[]): ParsedJournals {
  const parsed = files.map((f) => {
    try {
      return { name: f.name, j: parseJournal(f.data) };
    } catch (e) {
      throw e instanceof Error && files.length > 1 ? new Error(`${f.name}: ${e.message}`) : e;
    }
  });
  const dates = (j: ParsedJournal) => j.txns.map((t) => t.date).filter((d): d is string => d !== null).sort();
  const summaries = parsed.map(({ name, j }): JournalFileSummary => {
    const d = dates(j);
    return { name, txns: j.txns.length, rows: j.rowsRead, delimiter: j.delimiter, first: d[0] ?? null, last: d[d.length - 1] ?? null };
  });
  const order = parsed.map((p, i) => i).sort((a, b) => (summaries[a].first ?? '9999').localeCompare(summaries[b].first ?? '9999') || a - b);

  const multi = files.length > 1;
  const txns: JournalTxn[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, { t: JournalTxn; file: number; sig: string }>();
  let duplicates = 0;
  let rowsRead = 0;
  for (const i of order) {
    const { name, j } = parsed[i];
    for (const w of j.warnings) warnings.push(multi ? `${name}: ${w}` : w);
    for (const t of j.txns) {
      if (multi) t.file = name;
      const sig = signature(t);
      const key = t.transNo !== '' ? `#${t.transNo}` : sig;
      const prev = seen.get(key);
      if (prev && prev.file !== i) {
        if (prev.sig === sig) {
          duplicates++;
          continue;
        }
        t.problems.push(`Trans # ${t.transNo} is also in ${prev.t.file} (line ${prev.t.line}) with different lines; that one was imported`);
      } else if (!prev) seen.set(key, { t, file: i, sig });
      rowsRead += t.rows.length;
      txns.push(t);
    }
  }
  const columns = parsed.length === 0 ? [] : parsed[0].j.columns.filter((c) => parsed.every((p) => p.j.columns.includes(c)));
  return {
    txns,
    rowsRead,
    columns,
    delimiter: parsed[0]?.j.delimiter ?? ',',
    warnings,
    files: order.map((i) => summaries[i]),
    duplicates,
  };
}
