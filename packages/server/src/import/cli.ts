// Import a QuickBooks list export into a new RapidBooks company file.
//
//   npx tsx packages/server/src/import/cli.ts <file.iif> [--db path]
//
// The database defaults to data/rapidbooks.db (as the server uses). It is created if
// missing, and must not already contain any accounts, names, items or terms.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db';
import { AppError } from '../errors';
import { importIif } from './iif';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function main(argv: string[]): number {
  let file: string | undefined;
  let dbPath = process.env.RAPIDBOOKS_DB ?? resolve(root, 'data/rapidbooks.db');
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
    console.error('Usage: npx tsx packages/server/src/import/cli.ts <file.iif> [--db path]');
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

process.exitCode = main(process.argv.slice(2));
