import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Open (creating if needed) the database at `path` and bring its schema up to date. */
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))").run(file);
    })();
  }
}

/** Starter chart of accounts for a brand-new company file. The importer skips this. */
export function seedDefaults(db: DB) {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  if (count > 0) return;
  const ins = db.prepare('INSERT INTO accounts (name, type, system_role) VALUES (?, ?, ?)');
  const rows: [string, string, string | null][] = [
    ['Checking', 'BANK', null],
    ['Accounts Receivable', 'AR', 'AR'],
    ['Undeposited Funds', 'OCA', 'UNDEPOSITED'],
    ['Accounts Payable', 'AP', 'AP'],
    ['Opening Bal Equity', 'EQUITY', 'OPENING_EQUITY'],
    ['Retained Earnings', 'EQUITY', 'RETAINED'],
    ['Sales', 'INC', null],
    ['Uncategorized Expenses', 'EXP', null],
  ];
  db.transaction(() => rows.forEach((r) => ins.run(...r)))();
}
