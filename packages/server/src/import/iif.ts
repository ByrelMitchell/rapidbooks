import {
  AccountInput,
  ItemInput,
  NameInput,
  TermsInput,
  parseUsDate,
  type AccountTypeCode,
  type ImportResult,
  type ItemTypeCode,
  type NameKind,
} from '@rapidbooks/shared';
import { ZodError } from 'zod';
import type { DB } from '../db';
import { AppError } from '../errors';
import { createAccount } from '../ledger/accounts';
import { createItem } from '../lists/items';
import { createName } from '../lists/names';
import { createTerms } from '../lists/terms';

// Importer for a QuickBooks list export (File > Utilities > Export > Lists to IIF Files).
//
// IIF is tab-separated Windows-1252 text. A line starting with "!" is a header naming a
// record type and its columns ("!ACCNT\tNAME\tREFNUM\t..."); the data lines that follow
// start with that record type. Column sets differ between QuickBooks versions, so
// fields are always looked up by the header's column names, never by position.

// ---------------------------------------------------------------------------
// Parsing

export interface IifRecord {
  type: string;
  line: number; // 1-based line in the file, for messages
  fields: Record<string, string>;
}

export interface ParsedIif {
  records: IifRecord[];
  /** Every record type seen, in headers or data lines. */
  types: Set<string>;
  warnings: string[];
}

/** Decode the raw file: Windows-1252, unless it carries a UTF-8 byte-order mark. */
export function decodeIif(data: Uint8Array): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));
  return new TextDecoder('windows-1252').decode(data);
}

/**
 * Split IIF text into rows of fields. Fields are separated by tabs and rows by CRLF
 * (or LF). A field that starts with a double quote is quoted: it runs to the next quote
 * that is followed by a tab, a line end or the end of the file, may contain line breaks,
 * and "" inside it stands for one quote. Returns each row with its starting line number.
 */
function tokenize(text: string): { line: number; fields: string[] }[] {
  const rows: { line: number; fields: string[] }[] = [];
  let row: string[] = [];
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const n = text.length;
  const isEnd = (j: number) => j >= n || text[j] === '\t' || text[j] === '\r' || text[j] === '\n';

  const endRow = () => {
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push({ line: rowLine, fields: row });
    row = [];
  };

  while (i <= n) {
    // Read one field starting at i.
    let field = '';
    if (text[i] === '"') {
      const start = i;
      let j = i + 1;
      let closed = false;
      let lines = 0;
      while (j < n) {
        const c = text[j];
        if (c === '"') {
          if (text[j + 1] === '"') {
            field += '"';
            j += 2;
          } else if (isEnd(j + 1)) {
            j += 1;
            closed = true;
            break;
          } else {
            field += c;
            j += 1;
          }
        } else if (c === '\r' && text[j + 1] === '\n') {
          field += '\n';
          lines++;
          j += 2;
        } else {
          if (c === '\n') lines++;
          field += c;
          j += 1;
        }
      }
      if (closed) {
        i = j;
        line += lines;
      } else {
        // An opening quote that never closes is just a character; read the field plainly.
        field = '';
        i = start;
        while (!isEnd(i)) field += text[i++];
      }
    } else {
      while (!isEnd(i)) field += text[i++];
    }
    row.push(field);

    // Delimiter after the field.
    if (i >= n) {
      endRow();
      break;
    }
    if (text[i] === '\t') {
      i++;
    } else {
      i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      endRow();
      rowLine = line;
    }
  }
  return rows;
}

/** Parse IIF text into records whose fields are keyed by their header's column names. */
export function parseIif(text: string): ParsedIif {
  const headers = new Map<string, string[]>();
  const records: IifRecord[] = [];
  const types = new Set<string>();
  const warnings: string[] = [];
  const noHeader = new Set<string>();

  for (const { line, fields } of tokenize(text)) {
    const first = fields[0].trim();
    if (first.startsWith('!')) {
      const type = first.slice(1).toUpperCase();
      types.add(type);
      headers.set(type, fields.map((c) => c.trim().toUpperCase()));
      continue;
    }
    const type = first.toUpperCase();
    types.add(type);
    const cols = headers.get(type);
    if (!cols) {
      if (!noHeader.has(type)) {
        noHeader.add(type);
        warnings.push(`Line ${line}: a ${type} record comes before any !${type} header line, so ${type} records without a header were skipped.`);
      }
      continue;
    }
    const rec: Record<string, string> = {};
    for (let k = 1; k < fields.length; k++) {
      const col = cols[k];
      if (col === undefined) {
        if (fields[k].trim() !== '') warnings.push(`Line ${line}: has more fields than its !${type} header; the extra ones were ignored.`);
        break;
      }
      if (col !== '') rec[col] = fields[k].trim();
    }
    records.push({ type, line, fields: rec });
  }
  return { records, types, warnings };
}

/**
 * Parse a decimal number without floating point: "1,234.56" with places 2 -> 123456.
 * Accepts $, commas, a leading sign or parentheses for negatives; extra decimals round
 * half away from zero. Returns null if the text is not a number.
 */
export function parseDecimal(text: string, places: number): number | null {
  let s = text.trim().replace(/[$,\s]/g, '');
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1];
  }
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  if (m[1] === '-') neg = !neg;
  const frac = (m[3] ?? '').padEnd(places + 1, '0');
  let v = Number(m[2] || '0') * 10 ** places + Number(frac.slice(0, places) || '0');
  if (Number(frac[places]) >= 5) v += 1;
  return neg && v !== 0 ? -v : v;
}

// ---------------------------------------------------------------------------
// Importing

const ACCOUNT_TYPE_MAP: Record<string, AccountTypeCode | null> = {
  BANK: 'BANK',
  AR: 'AR',
  OCASSET: 'OCA',
  FIXASSET: 'FA',
  OASSET: 'OCA',
  AP: 'AP',
  CCARD: 'CC',
  OCLIAB: 'OCL',
  LTLIAB: 'LTL',
  EQUITY: 'EQUITY',
  INC: 'INC',
  COGS: 'COGS',
  EXP: 'EXP',
  EXINC: 'OINC',
  EXEXP: 'OEXP',
  NONPOSTING: null,
};

const ITEM_TYPE_MAP: Record<string, ItemTypeCode> = {
  SERV: 'SERVICE',
  PART: 'PART',
  INVENTORY: 'PART',
  OTHC: 'OTHER_CHARGE',
  SUBT: 'SUBTOTAL',
  DISC: 'DISCOUNT',
  GRP: 'GROUP',
};
const SKIPPED_ITEM_TYPES: Record<string, string> = {
  COMPTAX: 'it is a sales tax item and RapidBooks does not track sales tax',
  STAX: 'it is a sales tax item and RapidBooks does not track sales tax',
  STAXGRP: 'it is a sales tax group and RapidBooks does not track sales tax',
  PMT: 'it is a payment item; payments are recorded with Receive Payments instead',
};

const NAME_RECORDS: { type: string; kind: NameKind; label: string }[] = [
  { type: 'CUST', kind: 'customer', label: 'Customer' },
  { type: 'VEND', kind: 'vendor', label: 'Vendor' },
  { type: 'EMP', kind: 'employee', label: 'Employee' },
  { type: 'OTHERNAME', kind: 'other', label: 'Other name' },
];

const HANDLED = new Set(['HDR', 'ACCNT', 'TERMS', 'INVITEM', ...NAME_RECORDS.map((r) => r.type)]);

const ROLE_DEFAULTS: { role: string; name: string; type: AccountTypeCode }[] = [
  { role: 'AR', name: 'Accounts Receivable', type: 'AR' },
  { role: 'AP', name: 'Accounts Payable', type: 'AP' },
  { role: 'UNDEPOSITED', name: 'Undeposited Funds', type: 'OCA' },
  { role: 'OPENING_EQUITY', name: 'Opening Bal Equity', type: 'EQUITY' },
  { role: 'RETAINED', name: 'Retained Earnings', type: 'EQUITY' },
];

const key = (s: string) => s.toLowerCase();
const depth = (r: IifRecord) => (r.fields.NAME ?? '').split(':').length;
const byDepth = (a: IifRecord, b: IifRecord) => depth(a) - depth(b);
const yes = (s: string | undefined) => (s ?? '').trim().toUpperCase() === 'Y';

/** The message to show for a rejected record, or rethrow if it is a real failure. */
function reason(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof ZodError) return e.issues[0]?.message ?? 'invalid data';
  throw e;
}

function joinLines(...lines: (string | undefined)[]) {
  return lines.map((l) => (l ?? '').trim()).filter((l) => l !== '').join('\n');
}

function address(f: Record<string, string>, prefix: string) {
  return joinLines(...[1, 2, 3, 4, 5].map((i) => f[`${prefix}${i}`]));
}

/**
 * Import a QuickBooks IIF list export into an empty company, all in one database
 * transaction: either everything that can be imported is, or nothing is.
 */
export function importIif(db: DB, data: Uint8Array): ImportResult {
  const parsed = parseIif(decodeIif(data));
  if (![...parsed.types].some((t) => HANDLED.has(t) && t !== 'HDR')) {
    throw new AppError(400, 'This file does not look like a QuickBooks list export (IIF). No accounts, names, items or terms were found in it.');
  }

  const result: ImportResult = {
    counts: { accounts: 0, terms: 0, customers: 0, jobs: 0, vendors: 0, employees: 0, other_names: 0, items: 0 },
    ignored_record_types: [...parsed.types].filter((t) => !HANDLED.has(t)).sort(),
    warnings: [...parsed.warnings],
  };
  const warn = (msg: string) => result.warnings.push(msg);
  const of = (type: string) => parsed.records.filter((r) => r.type === type);

  db.transaction(() => {
    const used = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM accounts) + (SELECT COUNT(*) FROM names)
              + (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM terms) AS n`,
      )
      .get() as { n: number };
    if (used.n > 0) {
      throw new AppError(400, 'Lists can only be imported into a new, empty company file. This one already has accounts, names, items or terms.');
    }

    const accounts = importAccounts(db, of('ACCNT'), result, warn);
    const terms = importTerms(db, of('TERMS'), result, warn);
    importNames(db, parsed.records, terms, result, warn);
    importItems(db, of('INVITEM'), accounts, result, warn);
  })();

  return result;
}

function importAccounts(
  db: DB,
  records: IifRecord[],
  result: ImportResult,
  warn: (m: string) => void,
): Map<string, { id: number; type: AccountTypeCode }> {
  const byFull = new Map<string, { id: number; type: AccountTypeCode }>();
  const roles = new Map<string, number>();
  const nonPosting: string[] = [];
  let numbered = 0;

  for (const r of [...records].sort(byDepth)) {
    const f = r.fields;
    const full = f.NAME ?? '';
    if (full === '') {
      warn(`Line ${r.line}: an account with no name was skipped.`);
      continue;
    }
    const qbType = (f.ACCNTTYPE ?? '').toUpperCase();
    if (!(qbType in ACCOUNT_TYPE_MAP)) {
      warn(`Account "${full}" was skipped: its type "${f.ACCNTTYPE ?? ''}" is not one RapidBooks knows.`);
      continue;
    }
    const type = ACCOUNT_TYPE_MAP[qbType];
    if (type === null) {
      nonPosting.push(full);
      continue;
    }
    if (qbType === 'OASSET') {
      warn(`Account "${full}" is an Other Asset in QuickBooks; RapidBooks has no Other Asset type, so it was imported as an Other Current Asset.`);
    }
    if ((f.ACCNUM ?? '') !== '') numbered++;

    const segs = full.split(':').map((s) => s.trim());
    const leaf = segs[segs.length - 1];
    const parentFull = segs.slice(0, -1).join(':');
    let parent_id: number | null = null;
    if (parentFull) {
      const p = byFull.get(key(parentFull));
      if (!p) warn(`Account "${full}": its parent account "${parentFull}" was not imported, so it was imported as a top-level account "${leaf}".`);
      else if (p.type !== type) warn(`Account "${full}" is not the same type as its parent account, so it was imported as a top-level account "${leaf}".`);
      else parent_id = p.id;
    }

    try {
      const id = createAccount(
        db,
        AccountInput.parse({ name: leaf, type, parent_id, description: f.DESC ?? '', inactive: yes(f.HIDDEN) }),
      );
      byFull.set(key(full), { id, type });
      if (parent_id === null && parentFull) byFull.set(key(leaf), { id, type });
      result.counts.accounts++;

      const extra = (f.EXTRA ?? '').toUpperCase();
      const name = key(leaf);
      const role =
        type === 'AR' ? 'AR'
        : type === 'AP' ? 'AP'
        : type === 'OCA' && (name === 'undeposited funds' || extra === 'UNDEPOSIT') ? 'UNDEPOSITED'
        : type === 'EQUITY' && (name === 'opening bal equity' || extra === 'OPENBAL') ? 'OPENING_EQUITY'
        : type === 'EQUITY' && (name === 'retained earnings' || extra === 'RETEARNINGS') ? 'RETAINED'
        : null;
      if (role && !roles.has(role)) roles.set(role, id);
    } catch (e) {
      warn(`Account "${full}" was skipped: ${reason(e)}`);
    }
  }

  const setRole = db.prepare('UPDATE accounts SET system_role = ? WHERE id = ?');
  for (const d of ROLE_DEFAULTS) {
    let id = roles.get(d.role);
    if (id === undefined) {
      for (const name of [d.name, `${d.name} (RapidBooks)`]) {
        try {
          id = createAccount(db, AccountInput.parse({ name, type: d.type }));
          break;
        } catch (e) {
          reason(e);
        }
      }
      if (id === undefined) throw new AppError(500, `Could not create the ${d.name} account.`);
      byFull.set(key(d.name), { id, type: d.type });
      result.counts.accounts++;
      warn(`The file has no ${d.name} account; RapidBooks created one, because it needs it.`);
    }
    setRole.run(d.role, id);
  }

  if (nonPosting.length > 0) {
    warn(`Skipped ${nonPosting.length} non-posting account(s) (${nonPosting.join(', ')}); RapidBooks keeps purchase orders and estimates outside the ledger.`);
  }
  if (numbered > 0) {
    warn(`${numbered} account(s) have account numbers in QuickBooks; RapidBooks does not use account numbers yet, so they were not imported.`);
  }
  return byFull;
}

function importTerms(db: DB, records: IifRecord[], result: ImportResult, warn: (m: string) => void) {
  const byName = new Map<string, number>();
  for (const r of records) {
    const f = r.fields;
    const name = f.NAME ?? '';
    if ((f.TERMSTYPE ?? '0').trim() === '1') {
      warn(`Terms "${name}" were skipped: they are date-driven (due on a day of the month), which RapidBooks does not support yet.`);
      continue;
    }
    const int = (col: string, alt: string) => {
      const s = f[col] ?? f[alt] ?? '';
      if (s === '') return 0;
      const v = parseDecimal(s, 0);
      if (v === null) warn(`Terms "${name}": "${s}" in ${col} is not a number; used 0.`);
      return v ?? 0;
    };
    const pctText = (f.DISCPER ?? '').replace('%', '');
    const pct = pctText === '' ? 0 : parseDecimal(pctText, 2);
    if (pct === null) warn(`Terms "${name}": the discount "${f.DISCPER}" is not a percentage; used 0%.`);
    try {
      const id = createTerms(
        db,
        TermsInput.parse({
          name,
          net_days: int('STDDUEDAYS', 'DUEDAYS'),
          discount_days: int('STDDISCDAYS', 'DISCDAYS'),
          discount_pct: pct ?? 0,
          inactive: yes(f.HIDDEN),
        }),
      );
      byName.set(key(name), id);
      result.counts.terms++;
    } catch (e) {
      warn(`Terms "${name}" were skipped: ${reason(e)}`);
    }
  }
  return byName;
}

function importNames(
  db: DB,
  all: IifRecord[],
  terms: Map<string, number>,
  result: ImportResult,
  warn: (m: string) => void,
) {
  const customers = new Map<string, number>(); // full name -> id

  for (const { type, kind, label } of NAME_RECORDS) {
    const records = all.filter((r) => r.type === type);
    for (const r of kind === 'customer' ? [...records].sort(byDepth) : records) {
      const f = r.fields;
      const full = f.NAME ?? '';
      if (full === '') {
        warn(`Line ${r.line}: a ${label.toLowerCase()} with no name was skipped.`);
        continue;
      }
      const segs = full.split(':').map((s) => s.trim());
      const leaf = segs[segs.length - 1];
      let parent_id: number | null = null;
      if (segs.length > 1) {
        if (kind !== 'customer') {
          warn(`${label} "${full}" was skipped: only customers can have jobs, and this name contains a colon.`);
          continue;
        }
        const parentFull = segs.slice(0, -1).join(':');
        const p = customers.get(key(parentFull));
        if (p === undefined) {
          warn(`Job "${full}" was skipped: its customer "${parentFull}" was not imported.`);
          continue;
        }
        parent_id = p;
      }

      let terms_id: number | null = null;
      if ((f.TERMS ?? '') !== '') {
        terms_id = terms.get(key(f.TERMS)) ?? null;
        if (terms_id === null) warn(`${label} "${full}": terms "${f.TERMS}" were not found, so the terms were left blank.`);
      }
      let credit_limit: number | null = null;
      if ((f.LIMIT ?? '') !== '') {
        credit_limit = parseDecimal(f.LIMIT, 2);
        if (credit_limit === null) warn(`${label} "${full}": the credit limit "${f.LIMIT}" is not an amount, so it was left blank.`);
        if (credit_limit !== null && credit_limit < 0) credit_limit = null;
      }
      const date = (col: string) => {
        const s = f[col] ?? '';
        if (s === '') return '';
        const iso = parseUsDate(s);
        if (!iso) warn(`${label} "${full}": "${s}" in ${col} is not a date, so it was left blank.`);
        return iso ?? '';
      };

      const isVendor = kind === 'vendor';
      const bill =
        type === 'CUST' ? address(f, 'BADDR')
        : type === 'OTHERNAME' ? address(f, 'BADDR') || address(f, 'ADDR')
        : address(f, 'ADDR');
      const cityLine = joinLines([f.CITY, f.STATE].filter((s) => s).join(', ') + (f.ZIP ? ` ${f.ZIP}` : ''));
      const input = {
        kind,
        name: leaf,
        parent_id,
        company: f.COMPANYNAME ?? '',
        salutation: f.SALUTATION ?? '',
        first_name: f.FIRSTNAME ?? '',
        middle_init: f.MIDINIT ?? '',
        last_name: f.LASTNAME ?? '',
        contact: f.CONT1 ?? '',
        alt_contact: f.CONT2 ?? '',
        phone: f.PHONE1 ?? '',
        alt_phone: f.PHONE2 ?? '',
        fax: f.FAXNUM ?? '',
        email: f.EMAIL ?? '',
        bill_addr: kind === 'employee' ? joinLines(bill, cityLine) : bill,
        ship_addr: type === 'CUST' ? address(f, 'SADDR') : '',
        // Vendors: NOTE is the account number the vendor has for the company.
        notes: isVendor ? (f.NOTEPAD ?? '') : joinLines(f.NOTE, f.NOTEPAD),
        account_no: isVendor ? (f.NOTE ?? '') : '',
        terms_id: kind === 'customer' || isVendor ? terms_id : null,
        credit_limit: kind === 'customer' || isVendor ? credit_limit : null,
        print_as: isVendor ? (f.PRINTAS ?? '') : '',
        tax_id: isVendor ? (f.TAXID ?? '') : '',
        is_1099: isVendor && yes(f['1099']),
        ssn: kind === 'employee' ? (f.SSNO ?? '') : '',
        hire_date: kind === 'employee' ? date('HIREDATE') : '',
        release_date: kind === 'employee' ? date('RELEASEDATE') : '',
        inactive: yes(f.HIDDEN),
      };

      try {
        const id = createName(db, NameInput.parse(input));
        if (kind === 'customer') {
          customers.set(key(full), id);
          result.counts.customers++;
          if (parent_id !== null) result.counts.jobs++;
        } else if (kind === 'vendor') result.counts.vendors++;
        else if (kind === 'employee') result.counts.employees++;
        else result.counts.other_names++;
      } catch (e) {
        warn(`${label} "${full}" was skipped: ${reason(e)}`);
      }
    }
  }
}

function importItems(
  db: DB,
  records: IifRecord[],
  accounts: Map<string, { id: number; type: AccountTypeCode }>,
  result: ImportResult,
  warn: (m: string) => void,
) {
  const byFull = new Map<string, { id: number; type: ItemTypeCode }>();
  const groups: string[] = [];
  const inventory: string[] = [];

  for (const r of [...records].sort(byDepth)) {
    const f = r.fields;
    const full = f.NAME ?? '';
    const qbType = (f.INVITEMTYPE ?? '').toUpperCase();
    if (full === '') {
      warn(`Line ${r.line}: an item with no name was skipped.`);
      continue;
    }
    if (qbType in SKIPPED_ITEM_TYPES) {
      warn(`Item "${full}" was skipped: ${SKIPPED_ITEM_TYPES[qbType]}.`);
      continue;
    }
    const type = ITEM_TYPE_MAP[qbType];
    if (!type) {
      warn(`Item "${full}" was skipped: its type "${f.INVITEMTYPE ?? ''}" is not one RapidBooks knows.`);
      continue;
    }

    const segs = full.split(':').map((s) => s.trim());
    const leaf = segs[segs.length - 1];
    const parentFull = segs.slice(0, -1).join(':');
    let parent_id: number | null = null;
    if (parentFull) {
      const p = byFull.get(key(parentFull));
      if (!p) warn(`Item "${full}": its parent item "${parentFull}" was not imported, so it was imported as a top-level item "${leaf}".`);
      else if (p.type !== type) warn(`Item "${full}" is not the same type as its parent item, so it was imported as a top-level item "${leaf}".`);
      else parent_id = p.id;
    }

    let account_id: number | null = null;
    if (type !== 'SUBTOTAL' && type !== 'GROUP') {
      const acct = accounts.get(key(f.ACCNT ?? ''));
      if (!acct) {
        warn(`Item "${full}" was skipped: its account "${f.ACCNT ?? ''}" was not found among the imported accounts.`);
        continue;
      }
      account_id = acct.id;
    }

    let rate = 0;
    let rate_is_percent = false;
    const price = (f.PRICE ?? '').trim();
    if (price !== '' && type !== 'SUBTOTAL' && type !== 'GROUP') {
      const isPct = price.endsWith('%');
      // Money prices keep up to 5 decimal places of dollars (piece prices like 0.0375),
      // stored as cents with up to 3 decimals; percentages are basis points.
      const raw = parseDecimal(isPct ? price.slice(0, -1) : price, isPct ? 2 : 5);
      const v = raw === null ? null : isPct ? raw : raw / 1000;
      if (v === null) warn(`Item "${full}": the price "${price}" is not an amount, so the rate was left at 0.`);
      else if (isPct && type !== 'DISCOUNT' && type !== 'OTHER_CHARGE') {
        warn(`Item "${full}": a percentage price only works on discount and other charge items, so the rate was left at 0.`);
      } else {
        rate = type === 'DISCOUNT' ? Math.abs(v) : v;
        rate_is_percent = isPct;
      }
    }

    // The purchase side: PURCHASEDESC, COST and COGSACCNT (the expense or COGS account
    // QuickBooks posts purchases of the item to).
    let purchase_description = '';
    let cost = 0;
    let purchase_account_id: number | null = null;
    if (type === 'SERVICE' || type === 'PART' || type === 'OTHER_CHARGE') {
      purchase_description = f.PURCHASEDESC ?? '';
      const costText = (f.COST ?? '').trim();
      if (costText !== '') {
        const raw = parseDecimal(costText, 5);
        if (raw === null) warn(`Item "${full}": the cost "${costText}" is not an amount, so the cost was left at 0.`);
        else cost = raw / 1000;
      }
      const cogs = (f.COGSACCNT ?? '').trim();
      if (cogs !== '') {
        const acct = accounts.get(key(cogs));
        if (!acct) warn(`Item "${full}": its purchase account "${cogs}" was not found among the imported accounts, so it was left blank.`);
        else if (acct.type === 'AR' || acct.type === 'AP') {
          warn(`Item "${full}": its purchase account "${cogs}" is a receivable or payable account, so it was left blank.`);
        } else purchase_account_id = acct.id;
      }
    }

    try {
      const id = createItem(
        db,
        ItemInput.parse({
          name: leaf,
          type,
          parent_id,
          description: f.DESC ?? '',
          rate,
          rate_is_percent,
          account_id,
          inactive: yes(f.HIDDEN),
          purchase_description,
          cost,
          purchase_account_id,
        }),
      );
      byFull.set(key(full), { id, type });
      if (parent_id === null && parentFull) byFull.set(key(leaf), { id, type });
      result.counts.items++;
      if (type === 'GROUP') groups.push(full);
      if (qbType === 'INVENTORY') inventory.push(full);
    } catch (e) {
      warn(`Item "${full}" was skipped: ${reason(e)}`);
    }
  }

  if (inventory.length > 0) {
    warn(`Inventory part(s) ${inventory.join(', ')} were imported as non-inventory parts; RapidBooks does not track inventory.`);
  }
  if (groups.length > 0) {
    warn(`Group item(s) ${groups.join(', ')} were imported empty: a QuickBooks list export does not include which items are in a group. Open each group and add its items.`);
  }
}
