import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DB } from '../db';
import { backupFileName, backupsToDelete, nextRunAt, parseBackupName } from './rotation';

export interface BackupResult {
  file: string;
  path: string;
  size: number;
  durationMs: number;
  at: string; // ISO
}

export interface BackupFileInfo {
  file: string;
  size: number;
  at: string; // ISO, from the file name
}

export interface BackupStatus {
  directory: string;
  lastSuccess: BackupFileInfo | null;
  lastAttempt: string | null;
  /** The most recent attempt failed (cleared by the next success). */
  lastError: { at: string; message: string } | null;
  /** Backups were made but old ones could not be cleaned up. */
  rotationError: string | null;
  backups: BackupFileInfo[];
  /** "HH:MM", or null when the nightly backup is switched off. */
  schedule: string | null;
  nextRun: string | null;
  running: boolean;
  /** True when the last success is more than 3 days old (or there is none) or the last attempt failed. */
  warning: string | null;
}

export interface BackupOptions {
  db: DB;
  dir: string;
  /** The folder must already exist (a configured mount): never create it. */
  dirMustExist?: boolean;
  /** "HH:MM" local, or null for no nightly run. */
  time?: string | null;
  now?: () => Date;
  log?: (msg: string) => void;
}

export const STALE_DAYS = 3;
const CATCH_UP_HOURS = 26;
const DAY = 86_400_000;

/** A plain-words explanation of a file system error. */
export function describeError(e: unknown, dir: string): string {
  const err = e as NodeJS.ErrnoException;
  switch (err?.code) {
    case 'ENOENT':
      return `The backup folder ${dir} does not exist. If it is on another computer, check that the network drive is connected.`;
    case 'EACCES':
    case 'EPERM':
      return `RapidBooks is not allowed to write to the backup folder ${dir}.`;
    case 'ENOSPC':
      return `The backup folder ${dir} is full: there is no room for another backup.`;
    case 'EROFS':
      return `The backup folder ${dir} is read-only.`;
    case 'ENOTDIR':
    case 'EEXIST':
      return `The backup folder ${dir} is not a folder.`;
    default:
      return err?.message ? `The backup failed: ${err.message}` : `The backup failed: ${String(e)}`;
  }
}

/**
 * Copy the open database to `dest` with SQLite's online backup API (consistent even
 * while it is being written to), make the copy a standalone single file, and check it.
 * The copy is written to a temporary name beside `dest` and renamed only when verified.
 */
export async function copyDatabase(db: DB, dest: string): Promise<void> {
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomBytes(4).toString('hex')}.partial`);
  try {
    await db.backup(tmp);
    verifyDatabaseFile(tmp, { fixJournal: true });
    renameSync(tmp, dest);
  } catch (e) {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // best effort
      }
    }
    throw e;
  }
}

/**
 * Open a database file and check it: PRAGMA integrity_check must say ok and it must
 * be a RapidBooks database. With fixJournal, also switch it out of WAL mode so the
 * file stands alone (no -wal/-shm needed). Throws with a plain message otherwise.
 */
export function verifyDatabaseFile(path: string, opts: { fixJournal?: boolean } = {}): void {
  let copy: Database.Database;
  try {
    copy = new Database(path, { readonly: !opts.fixJournal, fileMustExist: true });
  } catch (e) {
    throw new Error(`${path} cannot be opened as a database: ${(e as Error).message}`);
  }
  try {
    if (opts.fixJournal) copy.pragma('journal_mode = DELETE');
    const rows = copy.pragma('integrity_check') as { integrity_check: string }[];
    const result = rows.map((r) => r.integrity_check).join('; ');
    if (result !== 'ok') throw new Error(`${path} failed the integrity check: ${result}`);
    const tables = new Set(
      (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of ['schema_migrations', 'accounts', 'txns', 'splits'])
      if (!tables.has(t)) throw new Error(`${path} is not a RapidBooks database (no ${t} table).`);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(msg.includes(path) ? msg : `${path} is damaged or is not a database: ${msg}`);
  } finally {
    copy.close();
  }
}

/** The backups in `dir`, newest first. Files that do not match the naming pattern are ignored. */
export function listBackups(dir: string): BackupFileInfo[] {
  const out: BackupFileInfo[] = [];
  for (const file of readdirSync(dir)) {
    const at = parseBackupName(file);
    if (!at) continue;
    try {
      const st = statSync(join(dir, file));
      if (st.isFile()) out.push({ file, size: st.size, at: at.toISOString() });
    } catch {
      // vanished meanwhile
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export class BackupService {
  readonly dir: string;
  readonly time: string | null;
  private readonly db: DB;
  private readonly dirMustExist: boolean;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private lastAttempt: Date | null = null;
  private lastError: { at: Date; message: string } | null = null;
  private rotationError: string | null = null;
  private current: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private timer: NodeJS.Timeout | null = null;
  private next: Date | null = null;

  constructor(o: BackupOptions) {
    this.db = o.db;
    this.dir = o.dir;
    this.dirMustExist = !!o.dirMustExist;
    this.time = o.time === undefined ? '02:00' : o.time;
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? ((m) => console.log(m));
  }

  private ensureDir() {
    if (this.dirMustExist) {
      if (!existsSync(this.dir)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } else mkdirSync(this.dir, { recursive: true });
    if (!statSync(this.dir).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
  }

  /** Runs one at a time: a request while one is running waits for it and then makes its own. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    const p = this.current.then(fn, fn).finally(() => this.busy--);
    this.current = p.catch(() => undefined);
    return p;
  }

  /** Make a verified backup into the backup folder now, then rotate old ones. */
  run(): Promise<BackupResult> {
    return this.serial(async () => {
      const started = Date.now();
      const at = this.now();
      this.lastAttempt = at;
      try {
        this.ensureDir();
        // Two backups in the same second get consecutive seconds, so names stay unique and sortable.
        let when = new Date(at);
        let file = backupFileName(when);
        while (existsSync(join(this.dir, file))) {
          when = new Date(when.getTime() + 1000);
          file = backupFileName(when);
        }
        const path = join(this.dir, file);
        await copyDatabase(this.db, path);
        const size = statSync(path).size;
        this.lastError = null;
        this.rotate();
        const r = { file, path, size, durationMs: Date.now() - started, at: when.toISOString() };
        this.log(`Backup ${file} written to ${this.dir} (${size} bytes, ${r.durationMs} ms).`);
        return r;
      } catch (e) {
        const message = describeError(e, this.dir);
        this.lastError = { at, message };
        this.log(`Backup FAILED: ${message}`);
        throw new Error(message);
      }
    });
  }

  private rotate() {
    try {
      const names = readdirSync(this.dir);
      for (const f of backupsToDelete(names, this.now())) unlinkSync(join(this.dir, f));
      this.rotationError = null;
    } catch (e) {
      this.rotationError = `Old backups could not be cleaned up: ${(e as Error).message}`;
      this.log(this.rotationError);
    }
  }

  /** A fresh verified copy in the system temp folder, for downloading. The caller deletes it. */
  makeDownloadCopy(): Promise<{ path: string; file: string; size: number }> {
    return this.serial(async () => {
      const file = backupFileName(this.now());
      const path = join(tmpdir(), `rapidbooks-download-${randomBytes(6).toString('hex')}.db`);
      await copyDatabase(this.db, path);
      return { path, file, size: statSync(path).size };
    });
  }

  status(): BackupStatus {
    let backups: BackupFileInfo[] = [];
    let listError: string | null = null;
    try {
      backups = listBackups(this.dir);
    } catch (e) {
      listError = describeError(e, this.dir);
    }
    const lastSuccess = backups[0] ?? null;
    const now = this.now();
    const lastError = this.lastError ?? (listError ? { at: now, message: listError } : null);
    let warning: string | null = null;
    if (lastError) warning = `The last backup failed. ${lastError.message}`;
    else if (!lastSuccess) warning = 'RapidBooks has not been backed up yet.';
    else {
      const days = (now.getTime() - new Date(lastSuccess.at).getTime()) / DAY;
      if (days > STALE_DAYS) warning = `The last backup was ${Math.floor(days)} days ago.`;
    }
    return {
      directory: this.dir,
      lastSuccess,
      lastAttempt: this.lastAttempt?.toISOString() ?? null,
      lastError: lastError ? { at: lastError.at.toISOString(), message: lastError.message } : null,
      rotationError: this.rotationError,
      backups,
      schedule: this.time,
      nextRun: this.next?.toISOString() ?? null,
      running: this.busy > 0,
      warning,
    };
  }

  /** Start the nightly schedule, and catch up now if the last good backup is over 26 hours old. */
  start(opts: { catchUpDelayMs?: number } = {}) {
    if (!this.time || this.timer) return;
    const time = this.time;
    this.next = nextRunAt(this.now(), time);
    const last = this.status().lastSuccess;
    const stale = !last || this.now().getTime() - new Date(last.at).getTime() > CATCH_UP_HOURS * 3_600_000;
    if (stale) {
      // A little after start-up, so the server is answering first.
      const t = setTimeout(() => void this.run().catch(() => undefined), opts.catchUpDelayMs ?? 15_000);
      t.unref();
    }
    // A minute tick rather than one long timeout: survives clock changes and suspend.
    this.timer = setInterval(() => {
      if (this.next && this.now() >= this.next) {
        this.next = nextRunAt(this.now(), time);
        void this.run().catch(() => undefined);
      }
    }, 60_000);
    this.timer.unref();
  }

  /** Stop the schedule and wait for a backup in progress to finish. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.next = null;
    await this.current;
  }
}
