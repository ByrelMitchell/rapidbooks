// Restore a backup over the RapidBooks database.
//
//   npx tsx packages/server/src/backup/restore.ts <backup-file> [--db path]
//
// Stop the server first (sudo systemctl stop rapidbooks). The current database is not
// deleted: it is renamed aside as <database>.before-restore-YYYYMMDD-HHMMSS.
// See docs/DEPLOY.md, "Restoring a backup".

import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runningServer } from '../pidfile';
import { loadSettings } from '../settings';
import { backupFileName } from './rotation';
import { verifyDatabaseFile } from './service';

export interface RestoreResult {
  restored: string;
  from: string;
  /** Where the previous database was moved, or null if there was none. */
  setAside: string | null;
}

/** Throws with a plain message if it cannot or must not restore. */
export function restoreBackup(backupFile: string, dbPath: string): RestoreResult {
  const from = resolve(backupFile);
  if (!existsSync(from) || !statSync(from).isFile()) throw new Error(`There is no backup file at ${from}.`);

  const server = runningServer(dbPath);
  if (server)
    throw new Error(
      `RapidBooks is running on this database (process ${server.pid}, ${server.url}). Stop it first:\n` +
        `  sudo systemctl stop rapidbooks\n` +
        `If you are sure it is not running, delete ${dbPath}.server.json and try again.`,
    );

  // Check the backup before touching anything.
  verifyDatabaseFile(from);

  // Copy it in under a temporary name and check the copy too.
  const dir = dirname(dbPath);
  const tmp = join(dir, `.${basename(dbPath)}.restoring`);
  copyFileSync(from, tmp);
  try {
    verifyDatabaseFile(tmp);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }

  // Move the current database (and any -wal/-shm that belong to it) aside.
  let setAside: string | null = null;
  if (existsSync(dbPath)) {
    const stamp = backupFileName(new Date()).slice('rapidbooks-'.length, -'.db'.length);
    setAside = `${dbPath}.before-restore-${stamp}`;
    renameSync(dbPath, setAside);
    for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) renameSync(dbPath + ext, setAside + ext);
  } else {
    for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
  }
  renameSync(tmp, dbPath);
  return { restored: dbPath, from, setAside };
}

function main(argv: string[]) {
  const args = [...argv];
  let dbArg: string | null = null;
  const i = args.indexOf('--db');
  if (i >= 0) {
    dbArg = args[i + 1] ?? null;
    args.splice(i, 2);
  }
  if (args.length !== 1 || !dbArg && i >= 0) {
    console.error('Usage: npx tsx packages/server/src/backup/restore.ts <backup-file> [--db path]');
    process.exit(2);
  }
  const dbPath = resolve(dbArg ?? loadSettings().dbPath);
  try {
    const r = restoreBackup(args[0], dbPath);
    console.log(`Restored ${r.from}\n     to ${r.restored}`);
    if (r.setAside) console.log(`The database that was there has been kept as ${r.setAside}`);
    console.log('Start RapidBooks again: sudo systemctl start rapidbooks');
  } catch (e) {
    console.error(`Nothing was restored. ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
