import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { restoreBackup } from '../src/backup/restore';
import { backupFileName } from '../src/backup/rotation';
import { BackupService, verifyDatabaseFile } from '../src/backup/service';
import { openDb, seedDefaults, type DB } from '../src/db';
import { pidFileFor } from '../src/pidfile';

let dir: string;
let db: DB;
let dbPath: string;
const quiet = () => undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rb-backup-'));
  dbPath = join(dir, 'data', 'rapidbooks.db');
  db = openDb(dbPath);
  seedDefaults(db);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

const accountIds = (d: Database.Database) =>
  (d.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: number }[]).map((r) => r.id);

// Balanced two-split journal entries written straight to the tables (the backup does not care how).
function writeTxns(d: Database.Database, count: number, seed: number) {
  const ids = accountIds(d);
  const insT = d.prepare("INSERT INTO txns (type, date, num, memo) VALUES ('GENJRNL', '2026-01-15', ?, ?)");
  const insS = d.prepare('INSERT INTO splits (txn_id, seq, account_id, amount) VALUES (?, ?, ?, ?)');
  d.transaction(() => {
    for (let i = 0; i < count; i++) {
      const k = seed + i;
      const id = Number(insT.run(String(k), 'x'.repeat(200)).lastInsertRowid);
      const amt = ((k * 7919) % 100000) + 1;
      insS.run(id, 0, ids[k % ids.length], amt);
      insS.run(id, 1, ids[(k + 3) % ids.length], -amt);
    }
  })();
}

/** Balance per account, counting only transactions up to `maxTxn`. */
const trialBalance = (d: Database.Database, maxTxn: number) =>
  d
    .prepare('SELECT account_id, SUM(amount) AS bal FROM splits WHERE txn_id <= ? GROUP BY account_id ORDER BY account_id')
    .all(maxTxn);

describe('making a backup', () => {
  it('produces a verified, standalone copy that matches the database even while it is being written to', async () => {
    writeTxns(db, 20000, 0); // a few MB, so the online backup takes several steps
    const svc = new BackupService({ db, dir: join(dir, 'backups'), time: null, log: quiet });

    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing) {
        writeTxns(db, 5, 100000 + written);
        written += 5;
        await new Promise((r) => setImmediate(r));
      }
    })();
    const r = await svc.run();
    writing = false;
    await writer;

    expect(written).toBeGreaterThan(0);
    expect(r.file).toMatch(/^rapidbooks-\d{8}-\d{6}\.db$/);
    expect(r.size).toBeGreaterThan(1_000_000);
    expect(readdirSync(join(dir, 'backups'))).toEqual([r.file]); // no temp file left, no -wal/-shm

    const copy = new Database(r.path, { readonly: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      const maxTxn = (copy.prepare('SELECT MAX(id) AS m FROM txns').get() as { m: number }).m;
      expect(maxTxn).toBeGreaterThanOrEqual(20000);
      // The copy is exactly the database as it was at one moment: same trial balance.
      expect(trialBalance(copy, maxTxn)).toEqual(trialBalance(db, maxTxn));
      expect((copy.prepare('SELECT SUM(amount) AS s FROM splits').get() as { s: number }).s).toBe(0);
      expect(copy.prepare('SELECT COUNT(*) AS n FROM txns').get()).toEqual(db.prepare('SELECT COUNT(*) AS n FROM txns WHERE id <= ?').get(maxTxn));
    } finally {
      copy.close();
    }
  });

  it('reports success in the status', async () => {
    const svc = new BackupService({ db, dir: join(dir, 'backups'), time: '02:00', log: quiet });
    const r = await svc.run();
    const s = svc.status();
    expect(s.lastSuccess).toMatchObject({ file: r.file, size: r.size });
    expect(s.lastError).toBeNull();
    expect(s.warning).toBeNull();
    expect(s.backups.map((b) => b.file)).toEqual([r.file]);
    expect(s.directory).toBe(join(dir, 'backups'));
    expect(s.nextRun).toBeNull(); // schedule not started
    svc.start({ catchUpDelayMs: 1e9 });
    expect(new Date(svc.status().nextRun!).getHours()).toBe(2);
    await svc.stop();
  });

  it('gives two backups in the same second different names', async () => {
    const at = new Date(2026, 10, 11, 9, 0, 0);
    const svc = new BackupService({ db, dir: join(dir, 'backups'), time: null, log: quiet, now: () => at });
    const a = await svc.run();
    const b = await svc.run();
    expect(a.file).toBe(backupFileName(at));
    expect(b.file).toBe(backupFileName(new Date(at.getTime() + 1000)));
  });

  it('reports a failure in plain words, and clears it after the next success', async () => {
    const notADir = join(dir, 'not-a-folder');
    writeFileSync(notADir, 'x');
    const bad = new BackupService({ db, dir: notADir, time: null, log: quiet });
    await expect(bad.run()).rejects.toThrow(/is not a folder/);
    let s = bad.status();
    expect(s.lastError?.message).toMatch(/is not a folder/);
    expect(s.warning).toMatch(/last backup failed/i);
    expect(s.lastSuccess).toBeNull();

    // A configured backup folder (another machine's mount) that is not there is not created.
    const mount = join(dir, 'mnt', 'backups');
    const svc = new BackupService({ db, dir: mount, dirMustExist: true, time: null, log: quiet });
    await expect(svc.run()).rejects.toThrow(/does not exist.*network drive/);
    expect(existsSync(mount)).toBe(false);
    expect(svc.status().warning).toMatch(/failed/);

    const app = buildApp(db, { backup: svc });
    const res = await app.inject({ method: 'POST', url: '/api/backup' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/does not exist/);

    // Mount it and try again.
    rmSync(notADir);
    (await import('node:fs')).mkdirSync(mount, { recursive: true });
    await svc.run();
    s = svc.status();
    expect(s.lastError).toBeNull();
    expect(s.warning).toBeNull();
  });

  it('warns when the last backup is more than 3 days old', async () => {
    let now = new Date(2026, 10, 1, 2);
    const svc = new BackupService({ db, dir: join(dir, 'backups'), time: null, log: quiet, now: () => now });
    await svc.run();
    now = new Date(2026, 11 - 1, 4, 1, 59);
    expect(svc.status().warning).toBeNull();
    now = new Date(2026, 11 - 1, 4, 3, 0);
    expect(svc.status().warning).toMatch(/3 days ago/);
  });

  it('serves the routes: run now, status, download', async () => {
    const svc = new BackupService({ db, dir: join(dir, 'backups'), time: null, log: quiet });
    const app = buildApp(db, { backup: svc });
    const run = await app.inject({ method: 'POST', url: '/api/backup' });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ file: expect.stringMatching(/^rapidbooks-/), size: expect.any(Number), durationMs: expect.any(Number) });

    const st = await app.inject({ method: 'GET', url: '/api/backup/status' });
    expect(st.json().lastSuccess.file).toBe(run.json().file);

    const before = readdirSync(tmpdir()).filter((f) => f.startsWith('rapidbooks-download-')).length;
    const dl = await app.inject({ method: 'GET', url: '/api/backup/download' });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="rapidbooks-\d{8}-\d{6}\.db"$/);
    expect(dl.rawPayload.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    expect(Number(dl.headers['content-length'])).toBe(dl.rawPayload.length);
    // The temporary copy is removed once sent.
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith('rapidbooks-download-')).length).toBe(before);
    // A download is not counted as a backup.
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  });
});

describe('restore', () => {
  async function aBackup() {
    writeTxns(db, 10, 0);
    const svc = new BackupService({ db, dir: join(dir, 'backups'), time: null, log: quiet });
    return (await svc.run()).path;
  }

  it('refuses a corrupt or foreign file and leaves the database alone', async () => {
    const good = await aBackup();
    db.close();
    const original = readFileSync(dbPath);

    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, Buffer.alloc(8192, 7));
    expect(() => restoreBackup(garbage, dbPath)).toThrow(/cannot be opened|damaged|not a database/);

    const truncated = join(dir, 'truncated.db');
    writeFileSync(truncated, readFileSync(good).subarray(0, 6000));
    expect(() => restoreBackup(truncated, dbPath)).toThrow();

    const foreign = join(dir, 'foreign.db');
    const f = new Database(foreign);
    f.exec('CREATE TABLE t (x)');
    f.close();
    expect(() => restoreBackup(foreign, dbPath)).toThrow(/not a RapidBooks database/);

    expect(() => restoreBackup(join(dir, 'nope.db'), dbPath)).toThrow(/no backup file/);
    expect(() => verifyDatabaseFile(garbage)).toThrow();

    expect(readFileSync(dbPath).equals(original)).toBe(true);
    expect(readdirSync(join(dir, 'data')).filter((x) => x.includes('before-restore'))).toEqual([]);
  });

  it('refuses while the server is running on that database', async () => {
    const good = await aBackup();
    // Another live process (our parent) recorded as the server.
    writeFileSync(pidFileFor(dbPath), JSON.stringify({ pid: process.ppid, url: 'http://127.0.0.1:3001', started: '' }));
    expect(() => restoreBackup(good, dbPath)).toThrow(/is running on this database/);
  });

  it('restores a good backup and keeps the old database aside', async () => {
    const good = await aBackup();
    writeTxns(db, 5, 500); // made after the backup
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const r = restoreBackup(good, dbPath);
    expect(r.setAside).toMatch(/rapidbooks\.db\.before-restore-\d{8}-\d{6}$/);
    expect(existsSync(r.setAside!)).toBe(true);
    db = openDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS n FROM txns').get()).toEqual({ n: 10 });
    const aside = new Database(r.setAside!, { readonly: true });
    expect(aside.prepare('SELECT COUNT(*) AS n FROM txns').get()).toEqual({ n: 15 });
    aside.close();
  });
});
