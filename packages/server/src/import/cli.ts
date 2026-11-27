// Import QuickBooks data into a new RapidBooks company file.
//
// Full history (lists + every transaction), with a reconciliation report:
//
//   npx tsx packages/server/src/import/cli.ts --iif lists.iif --journal journal.csv [--journal journal-2.csv ...]
//       [--trial-balance tb.csv --as-of 2026-10-31] [--fiscal-year-start 1]
//       [--open-invoices oi.csv] [--unpaid-bills ub.csv] [--open-as-of 2026-10-31]
//       [--profit-loss pl-2025.csv [--pl-from 2025-01-01 --pl-to 2025-12-31]] ...
//       [--out data/rapidbooks.db] [--force] [--report reconciliation.txt]
//
// The database is built in a temporary file next to --out and moved into place at the
// end. An existing --out is never overwritten unless --force is given, and then it is
// first renamed with a timestamp. Exit status: 0 = PASS, 1 = FAIL or error, 2 = usage.
//
// Lists only (the original Phase 2 importer):
//
//   npx tsx packages/server/src/import/cli.ts <file.iif> [--db path]

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIsoDate } from '@rapidbooks/shared';
import { openDb } from '../db';
import { AppError } from '../errors';
import { importHistory } from './history';
import { importIif } from './iif';
import { reconcile, type ReconcileInput } from './reconcile';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const defaultDb = () => process.env.RAPIDBOOKS_DB ?? resolve(root, 'data/rapidbooks.db');

const USAGE = `Usage:
  npx tsx packages/server/src/import/cli.ts --iif lists.iif --journal journal.csv [--journal journal-2.csv ...]
      [--trial-balance tb.csv --as-of YYYY-MM-DD] [--fiscal-year-start MONTH]
      [--open-invoices oi.csv] [--unpaid-bills ub.csv] [--open-as-of YYYY-MM-DD]
      [--profit-loss pl.csv [--pl-from YYYY-MM-DD --pl-to YYYY-MM-DD]] ...
      [--out data/rapidbooks.db] [--force] [--report reconciliation.txt]
  npx tsx packages/server/src/import/cli.ts lists.iif [--db path]   (lists only)`;

function read(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch {
    throw new AppError(1, `Cannot read ${file}.`);
  }
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const SIDE_FILES = ['-wal', '-shm'];

function moveDb(from: string, to: string) {
  renameSync(from, to);
  for (const s of SIDE_FILES) if (existsSync(from + s)) renameSync(from + s, to + s);
}

function removeDb(path: string) {
  for (const s of ['', ...SIDE_FILES]) rmSync(path + s, { force: true });
}

export function runHistory(argv: string[], log: (s: string) => void = console.log, err: (s: string) => void = console.error): number {
  const opt: Record<string, string> = {};
  const pl: { file: string; from?: string; to?: string }[] = [];
  const journals: string[] = [];
  let force = false;
  const VALUED = ['--iif', '--journal', '--trial-balance', '--as-of', '--fiscal-year-start', '--open-invoices', '--unpaid-bills', '--open-as-of', '--out', '--report'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (VALUED.includes(a) || a === '--profit-loss' || a === '--pl-from' || a === '--pl-to') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        err(`${a} needs a value.\n${USAGE}`);
        return 2;
      }
      if (a === '--profit-loss') pl.push({ file: v });
      else if (a === '--journal') journals.push(v);
      else if (a === '--pl-from' || a === '--pl-to') {
        if (pl.length === 0) {
          err(`${a} must follow --profit-loss.`);
          return 2;
        }
        pl[pl.length - 1][a === '--pl-from' ? 'from' : 'to'] = v;
      } else opt[a] = v;
    } else {
      err(`Unexpected argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!opt['--iif'] || journals.length === 0) {
    err(`Both --iif and --journal are needed.\n${USAGE}`);
    return 2;
  }
  for (const k of ['--as-of', '--open-as-of']) {
    if (opt[k] && !isIsoDate(opt[k])) {
      err(`${k} must be a date written YYYY-MM-DD, for example 2026-10-31.`);
      return 2;
    }
  }
  for (const p of pl) {
    if ((p.from && !isIsoDate(p.from)) || (p.to && !isIsoDate(p.to))) {
      err('--pl-from and --pl-to must be dates written YYYY-MM-DD.');
      return 2;
    }
  }
  const fy = opt['--fiscal-year-start'] ? Number(opt['--fiscal-year-start']) : 1;
  if (!Number.isInteger(fy) || fy < 1 || fy > 12) {
    err('--fiscal-year-start is the number of the first month of the fiscal year, 1 to 12.');
    return 2;
  }

  const out = resolve(opt['--out'] ?? defaultDb());
  if (existsSync(out) && !force) {
    err(`${out} already exists. RapidBooks never overwrites a company file: give another --out, or add --force to rename the old file (with a timestamp) and import anyway.`);
    return 2;
  }

  const temp = `${out}.importing`;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    const files = {
      iif: read(opt['--iif']),
      journal: journals.map((f) => ({ name: f, data: read(f) })),
      tb: opt['--trial-balance'] ? read(opt['--trial-balance']) : undefined,
      oi: opt['--open-invoices'] ? read(opt['--open-invoices']) : undefined,
      ub: opt['--unpaid-bills'] ? read(opt['--unpaid-bills']) : undefined,
      pl: pl.map((p) => ({ data: read(p.file), from: p.from, to: p.to })),
    };
    removeDb(temp);
    db = openDb(temp); // deliberately no seedDefaults(): the chart of accounts comes from the lists
    const openAsOf = opt['--open-as-of'] ?? opt['--as-of'];
    const h = importHistory(db, { iif: files.iif, journal: files.journal, openInvoices: files.oi, unpaidBills: files.ub, asOf: openAsOf, profitLoss: files.pl });
    const input: ReconcileInput = {
      trialBalance: files.tb,
      asOf: opt['--as-of'],
      fiscalYearStartMonth: fy,
      openInvoices: files.oi,
      unpaidBills: files.ub,
      openAsOf,
      profitLoss: files.pl,
    };
    const rec = reconcile(db, h, input);
    db.close();
    db = null;

    let moved = '';
    if (existsSync(out)) {
      moved = `${out}.before-import-${stamp()}`;
      moveDb(out, moved);
    }
    moveDb(temp, out);

    const head = [`Imported ${opt['--iif']} and ${journals.join(', ')} into ${out}.`];
    if (moved) head.push(`The previous company file was renamed to ${moved}.`);
    const text = `${head.join('\n')}\n\n${rec.text}`;
    log(text);
    if (opt['--report']) {
      writeFileSync(resolve(opt['--report']), text.replace(/\n/g, '\r\n'));
      log(`The reconciliation was also written to ${resolve(opt['--report'])}.`);
    }
    return rec.pass ? 0 : 1;
  } catch (e) {
    if (db) db.close();
    removeDb(temp);
    if (e instanceof AppError || (e instanceof Error && /does not look like|has no column/.test(e.message))) {
      err(`Nothing was imported: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

function runLists(argv: string[]): number {
  let file: string | undefined;
  let dbPath = defaultDb();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      const p = argv[++i];
      if (!p) {
        console.error('--db needs a path.');
        return 2;
      }
      dbPath = resolve(p);
    } else if (!file) file = argv[i];
    else {
      console.error(`Unexpected argument: ${argv[i]}`);
      return 2;
    }
  }
  if (!file) {
    console.error(USAGE);
    return 2;
  }

  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    console.error(`Cannot read ${file}.`);
    return 1;
  }

  // Deliberately no seedDefaults(): the chart of accounts comes from the file.
  const db = openDb(dbPath);
  try {
    const r = importIif(db, data);
    console.log(`Imported ${file} into ${dbPath}`);
    console.log('');
    const rows: [string, number][] = [
      ['Accounts', r.counts.accounts],
      ['Terms', r.counts.terms],
      ['Customers', r.counts.customers],
      ['  of which jobs', r.counts.jobs],
      ['Vendors', r.counts.vendors],
      ['Employees', r.counts.employees],
      ['Other names', r.counts.other_names],
      ['Items', r.counts.items],
    ];
    for (const [label, n] of rows) console.log(`  ${label.padEnd(18)}${String(n).padStart(6)}`);
    if (r.ignored_record_types.length > 0) {
      console.log('');
      console.log(`Ignored record types: ${r.ignored_record_types.join(', ')}`);
    }
    if (r.warnings.length > 0) {
      console.log('');
      console.log(`Warnings (${r.warnings.length}):`);
      for (const w of r.warnings) console.log(`  - ${w}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof AppError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  } finally {
    db.close();
  }
}

function main(argv: string[]): number {
  return argv.some((a) => a === '--journal' || a === '--iif') ? runHistory(argv) : runLists(argv);
}

// Run only when executed directly (tests import runHistory).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
