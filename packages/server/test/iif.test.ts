import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, seedDefaults, type DB } from '../src/db';
import { decodeIif, importIif, parseDecimal, parseIif } from '../src/import/iif';
import { listAccounts } from '../src/ledger/accounts';
import { listItems } from '../src/lists/items';
import { listNames } from '../src/lists/names';
import { listTerms } from '../src/lists/terms';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'sample.iif'));

/** Build a small IIF file from rows of fields (CRLF, Windows-1252). */
const iif = (...rows: string[][]) => Buffer.from(rows.map((r) => r.join('\t')).join('\r\n') + '\r\n', 'latin1');

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('IIF parsing', () => {
  it('maps fields by header name and handles quotes, CRLF and Windows-1252', () => {
    const text = decodeIif(
      Buffer.concat([
        iif(['!CUST', 'NAME', 'PHONE1', 'NOTE'], ['CUST', '"Smith, Bob"', '555-1212', '"He said ""hi"""']),
        Buffer.from([0x43, 0x55, 0x53, 0x54, 0x09, 0x4d, 0x92, 0x73, 0x0d, 0x0a]), // CUST\tM’s
        iif(['!CUST', 'PHONE1', 'NAME'], ['CUST', '555-9999', 'Reordered']),
      ]),
    );
    const { records } = parseIif(text);
    expect(records.map((r) => r.fields)).toEqual([
      { NAME: 'Smith, Bob', PHONE1: '555-1212', NOTE: 'He said "hi"' },
      { NAME: 'M’s' },
      { NAME: 'Reordered', PHONE1: '555-9999' },
    ]);
  });

  it('keeps line breaks inside quoted fields and survives a stray quote', () => {
    const { records } = parseIif('!CUST\tNAME\tNOTEPAD\r\nCUST\tA\t"line 1\r\nline 2"\r\nCUST\t"B\t3/4" bar\r\n');
    expect(records.map((r) => [r.line, r.fields])).toEqual([
      [2, { NAME: 'A', NOTEPAD: 'line 1\nline 2' }],
      [4, { NAME: '"B', NOTEPAD: '3/4" bar' }],
    ]);
  });

  it('warns about data lines without a header', () => {
    const { records, warnings } = parseIif('CUST\tAcme\r\n');
    expect(records).toEqual([]);
    expect(warnings[0]).toMatch(/before any !CUST header/);
  });

  it('parses money and percentages without floating point drift', () => {
    expect(parseDecimal('12.50', 2)).toBe(1250);
    expect(parseDecimal('"1,234.56"'.replace(/"/g, ''), 2)).toBe(123456);
    expect(parseDecimal('-0.29', 2)).toBe(-29);
    expect(parseDecimal('0.285', 2)).toBe(29);
    expect(parseDecimal('1.005', 2)).toBe(101);
    expect(parseDecimal('(45.10)', 2)).toBe(-4510);
    expect(parseDecimal('$19.99', 2)).toBe(1999);
    expect(parseDecimal('100', 2)).toBe(10000);
    expect(parseDecimal('.5', 2)).toBe(50);
    expect(parseDecimal('2.0', 2)).toBe(200); // 2.0% -> basis points
    expect(parseDecimal('abc', 2)).toBeNull();
    expect(parseDecimal('', 2)).toBeNull();
  });
});

describe('IIF import of the sample file', () => {
  it('imports every list', () => {
    const r = importIif(db, fixture);
    expect(r.counts).toEqual({
      accounts: 19,
      terms: 3,
      customers: 4,
      jobs: 1,
      vendors: 2,
      employees: 1,
      other_names: 1,
      items: 7,
    });
    expect(r.ignored_record_types).toEqual(['CTYPE']);

    const accts = listAccounts(db);
    const acct = (full: string) => accts.find((a) => a.full_name === full)!;
    expect(acct('Utilities:Electric')).toMatchObject({ type: 'EXP', depth: 1 });
    expect(acct('Checking')).toMatchObject({ description: 'Main operating account, First National', balance: 0 });
    expect(acct('Security Deposits').type).toBe('OCA');
    expect(acct('Interest Income').type).toBe('OINC');
    expect(acct('Old Tooling').inactive).toBe(true);
    expect(accts.find((a) => a.name === 'Purchase Orders')).toBeUndefined();
    expect(Object.fromEntries(accts.filter((a) => a.system_role).map((a) => [a.system_role, a.name]))).toEqual({
      AR: 'Accounts Receivable',
      AP: 'Accounts Payable',
      UNDEPOSITED: 'Undeposited Funds',
      OPENING_EQUITY: 'Opening Bal Equity',
      RETAINED: 'Retained Earnings',
    });
    // Opening balances are not imported; history comes from the Journal later.
    expect(db.prepare('SELECT COUNT(*) AS n FROM splits').get()).toEqual({ n: 0 });

    const terms = listTerms(db);
    expect(terms.find((t) => t.name === '2% 10 Net 30')).toMatchObject({ net_days: 30, discount_days: 10, discount_pct: 200 });

    const names = listNames(db);
    const byFull = (full: string) => names.find((n) => n.full_name === full)!;
    const acme = byFull('Acme Fabrication');
    expect(acme).toMatchObject({
      kind: 'customer',
      company: 'Acme Fabrication, Inc.',
      bill_addr: 'Acme Fabrication, Inc.\n1200 Industrial Pkwy\nDayton, OH 45404',
      ship_addr: 'Acme Fabrication\nDock 3\n1200 Industrial Pkwy\nDayton, OH 45404',
      phone: '937-555-0100',
      alt_phone: '937-555-0101',
      contact: 'Linda Park',
      first_name: 'Linda',
      credit_limit: 500000,
      terms_id: terms.find((t) => t.name === 'Net 30')!.id,
      notes: 'Wants packing slips in the box.',
    });
    expect(byFull('Acme Fabrication:Press Frame')).toMatchObject({ parent_id: acme.id, depth: 1 });
    expect(byFull('Müller Tool & Die')).toMatchObject({ contact: 'Hans Müller', notes: 'Picks up Fridays' });
    expect(byFull('Riverside Pumps')).toMatchObject({ inactive: true, terms_id: null });
    expect(byFull('Steel Supply Co')).toMatchObject({
      kind: 'vendor',
      account_no: 'ACCT-4471',
      print_as: 'Steel Supply Company',
      credit_limit: 1000000,
    });
    expect(byFull("Joe's Deburring")).toMatchObject({ is_1099: true, tax_id: '123-45-6789' });
    expect(byFull('Dave Smith')).toMatchObject({
      kind: 'employee',
      ssn: '987-65-4321',
      hire_date: '1998-03-15',
      bill_addr: '18 Elm St\nDayton, OH 45402',
    });
    expect(byFull('Owner')).toMatchObject({ kind: 'other', notes: 'Owner draws' });
    expect(names.filter((n) => n.name === 'Acme Fabrication')).toHaveLength(1);

    const items = listItems(db);
    const it = (full: string) => items.find((i) => i.full_name === full)!;
    expect(it('Machining')).toMatchObject({ type: 'SERVICE', rate: 6500, description: 'CNC machining, per hour', account_id: acct('Machining Income').id });
    expect(it('Machining:Setup')).toMatchObject({ rate: 4500, depth: 1 });
    expect(it('Bar Stock')).toMatchObject({ type: 'PART', rate: 1250, description: '1/2" steel bar stock, per foot' });
    expect(it('Repeat Discount')).toMatchObject({ type: 'DISCOUNT', rate: 1000, rate_is_percent: true });
    expect(it('Subtotal')).toMatchObject({ type: 'SUBTOTAL', account_id: null });
    expect(it('Fixture Kit')).toMatchObject({ type: 'GROUP', members: [] });
    expect(items.find((i) => i.name === 'Ohio Sales Tax')).toBeUndefined();

    const w = r.warnings.join('\n');
    expect(w).toMatch(/Vendor "Acme Fabrication" was skipped: .*already in use on the Customer list/);
    expect(w).toMatch(/Customer "Riverside Pumps": terms "Net 45" were not found/);
    expect(w).toMatch(/Item "Ohio Sales Tax" was skipped: it is a sales tax item/);
    expect(w).toMatch(/Fixture Kit were imported empty/);
    expect(w).toMatch(/Security Deposits" is an Other Asset/);
    expect(w).toMatch(/non-posting account\(s\) \(Purchase Orders, Estimates\)/);
  });

  it('requires an empty company and leaves nothing behind on failure', () => {
    seedDefaults(db);
    expect(() => importIif(db, fixture)).toThrow(/new, empty company/);
    expect(listNames(db)).toEqual([]);
  });

  it('rejects a file that is not an IIF list export', () => {
    expect(() => importIif(db, Buffer.from('hello, world\r\n'))).toThrow(/does not look like/);
  });
});

describe('IIF import edge cases', () => {
  it('creates missing system accounts and maps by column name in any order', () => {
    const r = importIif(
      db,
      iif(
        ['!ACCNT', 'ACCNTTYPE', 'NAME', 'ACCNUM'],
        ['ACCNT', 'BANK', 'Checking', '1000'],
        ['ACCNT', 'AR', 'Receivables'],
        ['ACCNT', 'AR', 'Receivables 2'],
        ['ACCNT', 'BOGUS', 'Strange'],
        ['ACCNT', 'EXP', 'Missing:Child'],
      ),
    );
    const roles = Object.fromEntries(
      listAccounts(db).filter((a) => a.system_role).map((a) => [a.system_role, [a.name, a.type]]),
    );
    expect(roles).toEqual({
      AR: ['Receivables', 'AR'],
      AP: ['Accounts Payable', 'AP'],
      UNDEPOSITED: ['Undeposited Funds', 'OCA'],
      OPENING_EQUITY: ['Opening Bal Equity', 'EQUITY'],
      RETAINED: ['Retained Earnings', 'EQUITY'],
    });
    expect(listAccounts(db).find((a) => a.name === 'Child')).toMatchObject({ depth: 0 });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/"Strange" was skipped: its type "BOGUS"/);
    expect(w).toMatch(/parent account "Missing" was not imported/);
    expect(w).toMatch(/no Accounts Payable account; RapidBooks created one/);
    expect(w).toMatch(/1 account\(s\) have account numbers/);
  });

  it('skips items and jobs that cannot be placed, and date-driven terms', () => {
    const r = importIif(
      db,
      iif(
        ['!ACCNT', 'NAME', 'ACCNTTYPE'],
        ['ACCNT', 'Sales', 'INC'],
        ['!TERMS', 'NAME', 'DUEDAYS', 'DISCDAYS', 'DISCPER', 'TERMSTYPE'],
        ['TERMS', 'Net 15', '15', '', '', '0'],
        ['TERMS', '10th of month', '10', '', '', '1'],
        ['!CUST', 'NAME', 'LIMIT'],
        ['CUST', 'Ghost:Job', ''],
        ['CUST', 'Acme', 'lots'],
        ['!VEND', 'NAME'],
        ['VEND', 'Bad:Vendor'],
        ['!INVITEM', 'NAME', 'INVITEMTYPE', 'ACCNT', 'PRICE'],
        ['INVITEM', 'Labor', 'SERV', 'No Such Account', '10'],
        ['INVITEM', 'Rod', 'INVENTORY', 'Sales', '3.333'],
        ['INVITEM', 'Rod:Short', 'SERV', 'Sales', '1'],
        ['INVITEM', 'Fee', 'OTHC', 'Sales', '5%'],
        ['INVITEM', 'Pay', 'PMT', '', ''],
        ['INVITEM', 'Thing', 'ASSEMBLY', 'Sales', ''],
      ),
    );
    expect(listTerms(db).map((t) => [t.name, t.net_days])).toEqual([['Net 15', 15]]);
    expect(r.counts).toMatchObject({ customers: 1, jobs: 0, vendors: 0, items: 3 });
    expect(listNames(db)[0]).toMatchObject({ name: 'Acme', credit_limit: null });
    const items = listItems(db);
    expect(items.find((i) => i.name === 'Rod')).toMatchObject({ type: 'PART', rate: 333 });
    expect(items.find((i) => i.name === 'Short')).toMatchObject({ type: 'SERVICE', depth: 0 });
    expect(items.find((i) => i.name === 'Fee')).toMatchObject({ rate: 500, rate_is_percent: true });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/"10th of month" were skipped: they are date-driven/);
    expect(w).toMatch(/Job "Ghost:Job" was skipped/);
    expect(w).toMatch(/credit limit "lots" is not an amount/);
    expect(w).toMatch(/Vendor "Bad:Vendor" was skipped: only customers can have jobs/);
    expect(w).toMatch(/Item "Labor" was skipped: its account "No Such Account" was not found/);
    expect(w).toMatch(/Rod were imported as non-inventory parts/);
    expect(w).toMatch(/"Rod:Short" is not the same type as its parent/);
    expect(w).toMatch(/Item "Pay" was skipped: it is a payment item/);
    expect(w).toMatch(/Item "Thing" was skipped: its type "ASSEMBLY"/);
  });
});
