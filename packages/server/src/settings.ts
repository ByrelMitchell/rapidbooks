import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every setting the server reads from the environment, in one place. In production they
// come from /etc/rapidbooks.env (see deploy/rapidbooks.env.example and docs/DEPLOY.md).

/** The repository / install root (…/rapidbooks). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Settings {
  dbPath: string;
  /** The directory holding the database; the default home of backups, auth.json, sessions.json. */
  dataDir: string;
  host: string;
  port: number;
  webDist: string;
  backupDir: string;
  /** True when RAPIDBOOKS_BACKUP_DIR was given: the folder must already exist (a mount). */
  backupDirConfigured: boolean;
  /** "HH:MM" local time, or null when nightly backups are switched off. */
  backupTime: string | null;
  authFile: string;
  sessionFile: string;
  noAuth: boolean;
  /** Without a password: names besides addresses, localhost and this machine's name that the server answers to. */
  allowedHosts: string[];
  tlsCert: string | null;
  tlsKey: string | null;
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

export function parseBackupTime(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  if (s === '') return '02:00';
  if (/^(off|none|no|false|0)$/i.test(s)) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`RAPIDBOOKS_BACKUP_TIME must look like 02:00 (24-hour local time) or "off"; it is "${s}".`);
  }
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const dbPath = resolve(env.RAPIDBOOKS_DB || resolve(APP_ROOT, 'data/rapidbooks.db'));
  const dataDir = dirname(dbPath);
  const opt = (name: string) => (env[name] && env[name]!.trim() !== '' ? env[name]!.trim() : null);
  return {
    dbPath,
    dataDir,
    // Loopback by default; set HOST=0.0.0.0 (or the LAN address) when deploying.
    host: opt('HOST') ?? '127.0.0.1',
    port: Number(opt('PORT') ?? 3001),
    webDist: resolve(opt('RAPIDBOOKS_WEB_DIST') ?? resolve(APP_ROOT, 'packages/web/dist')),
    backupDir: resolve(opt('RAPIDBOOKS_BACKUP_DIR') ?? resolve(dataDir, 'backups')),
    backupDirConfigured: opt('RAPIDBOOKS_BACKUP_DIR') !== null,
    backupTime: parseBackupTime(env.RAPIDBOOKS_BACKUP_TIME),
    authFile: resolve(opt('RAPIDBOOKS_AUTH_FILE') ?? resolve(dataDir, 'auth.json')),
    sessionFile: resolve(opt('RAPIDBOOKS_SESSION_FILE') ?? resolve(dataDir, 'sessions.json')),
    noAuth: truthy(env.RAPIDBOOKS_NO_AUTH),
    allowedHosts: (opt('RAPIDBOOKS_ALLOWED_HOSTS') ?? '').split(/[\s,]+/).filter((h) => h !== ''),
    tlsCert: opt('RAPIDBOOKS_TLS_CERT'),
    tlsKey: opt('RAPIDBOOKS_TLS_KEY'),
  };
}

let version: string | null = null;
/** The RapidBooks version, from the root package.json. */
export function appVersion(): string {
  if (version === null) {
    try {
      version = String((JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0');
    } catch {
      version = '0.0.0';
    }
  }
  return version;
}
