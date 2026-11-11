// Make one verified backup into the backup folder from the command line (used by
// deploy/update.sh before an update). Safe whether or not the server is running.
//
//   npx tsx packages/server/src/backup/backup-now.ts

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { loadSettings } from '../settings';
import { BackupService } from './service';

const s = loadSettings();
if (!existsSync(s.dbPath)) {
  console.error(`There is no database at ${s.dbPath}; nothing to back up.`);
  process.exit(1);
}
const db = new Database(s.dbPath, { fileMustExist: true });
const svc = new BackupService({ db, dir: s.backupDir, dirMustExist: s.backupDirConfigured, time: null });
svc
  .run()
  .then((r) => {
    console.log(`Backed up to ${r.path} (${r.size} bytes).`);
    db.close();
  })
  .catch((e: Error) => {
    console.error(e.message);
    db.close();
    process.exit(1);
  });
