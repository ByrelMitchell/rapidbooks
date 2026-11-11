// Build the demo company (Miami Valley Precision, a made-up Dayton machine shop) into a
// new company file:
//
//   npm run demo -- [--out data/demo.db] [--through YYYY-MM-DD] [--seed N] [--force]
//
// Activity runs from January 1 of the year before --through (default: today) up to
// --through. The file is built next to --out and moved into place at the end; an
// existing --out is never overwritten unless --force is given. Then open it with
//
//   RAPIDBOOKS_DB=data/demo.db npm run dev:server

import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMoney, isIsoDate, todayIso } from '@rapidbooks/shared';
import { openDb } from '../db';
import { buildDemo } from './build';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const USAGE = 'Usage: npm run demo -- [--out data/demo.db] [--through YYYY-MM-DD] [--seed N] [--force]';

function main() {
  const args = process.argv.slice(2);
  let out = resolve(root, 'data/demo.db');
  let through = todayIso();
  let seed: number | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      const v = args[++i];
      if (v === undefined) fail(`${a} needs a value.`);
      return v;
    };
    if (a === '--out') out = resolve(val());
    else if (a === '--through') through = val();
    else if (a === '--seed') seed = Number(val());
    else if (a === '--force') force = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return;
    } else fail(`Unknown argument ${a}.\n${USAGE}`);
  }
  if (!isIsoDate(through)) fail('--through must be a date like 2026-11-11.');
  if (seed !== undefined && !Number.isInteger(seed)) fail('--seed must be a whole number.');
  if (existsSync(out) && !force) fail(`${out} already exists. Give another --out, or add --force to replace it.`);

  const temp = `${out}.building`;
  for (const f of [temp, `${temp}-wal`, `${temp}-shm`]) rmSync(f, { force: true });
  const db = openDb(temp);
  let summary;
  try {
    summary = buildDemo(db, { through, seed });
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  for (const f of [out, `${out}-wal`, `${out}-shm`]) rmSync(f, { force: true });
  renameSync(temp, out);
  for (const f of [`${temp}-wal`, `${temp}-shm`]) rmSync(f, { force: true });

  const check = openDb(out);
  const tb = check.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM splits').get() as { n: number };
  const bank = check
    .prepare("SELECT a.name, COALESCE(SUM(s.amount), 0) AS b FROM accounts a LEFT JOIN splits s ON s.account_id = a.id WHERE a.type = 'BANK' GROUP BY a.id ORDER BY a.name")
    .all() as { name: string; b: number }[];
  const open = check
    .prepare(
      `SELECT a.name, SUM(s.amount) AS b FROM splits s JOIN accounts a ON a.id = s.account_id
        WHERE a.type IN ('AR', 'AP') GROUP BY a.id ORDER BY a.name`,
    )
    .all() as { name: string; b: number }[];
  check.close();

  console.log(`Demo company written to ${out}`);
  console.log(`  ${summary.from} to ${summary.through}: ${summary.accounts} accounts, ${summary.customers} customers and jobs, ${summary.vendors} vendors, ${summary.employees} employees, ${summary.items} items`);
  console.log(`  Transactions: ${Object.entries(summary.txns).map(([t, n]) => `${n} ${t}`).join(', ')}`);
  for (const r of [...bank, ...open]) console.log(`  ${r.name}: ${formatMoney(Math.abs(r.b))}${r.b < 0 && !['Accounts Payable'].includes(r.name) ? ' (negative)' : ''}`);
  if (tb.n !== 0) fail('The ledger does not balance. This is a bug in the demo builder.');
  console.log(`Open it with:  RAPIDBOOKS_DB=${out} npm run dev:server`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

main();
