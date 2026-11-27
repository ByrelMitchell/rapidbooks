import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { buildApp } from './app';
import { startupRefusal } from './auth';
import { readAuthFile } from './auth/password';
import { SessionStore } from './auth/sessions';
import { BackupService } from './backup/service';
import { openDb, seedDefaults, type DB } from './db';
import { removePidFile, writePidFile } from './pidfile';
import type { Settings } from './settings';

/** A reason the server will not start, meant to be read by the person starting it. */
export class StartupError extends Error {}

export interface RunningServer {
  app: FastifyInstance;
  db: DB;
  backup: BackupService;
  address: string;
  /** Finish in-flight requests, wait for a running backup, checkpoint the WAL, close the database. */
  close: () => Promise<void>;
}

export async function startServer(
  s: Settings,
  o: { signals?: boolean; log?: (m: string) => void; catchUpDelayMs?: number } = {},
): Promise<RunningServer> {
  const log = o.log ?? ((m: string) => console.log(m));

  let hasPassword: boolean;
  try {
    hasPassword = readAuthFile(s.authFile) !== null;
  } catch (e) {
    throw new StartupError(`The password file cannot be read: ${(e as Error).message}`);
  }
  const refusal = startupRefusal({ host: s.host, hasPassword, noAuth: s.noAuth, authFile: s.authFile });
  if (refusal) throw new StartupError(refusal);

  if (!!s.tlsCert !== !!s.tlsKey)
    throw new StartupError('Set both RAPIDBOOKS_TLS_CERT and RAPIDBOOKS_TLS_KEY to use HTTPS, or neither.');
  let https: { cert: Buffer; key: Buffer } | undefined;
  if (s.tlsCert && s.tlsKey) {
    try {
      https = { cert: readFileSync(s.tlsCert), key: readFileSync(s.tlsKey) };
    } catch (e) {
      throw new StartupError(`The TLS certificate or key cannot be read: ${(e as Error).message}`);
    }
  }

  const db = openDb(s.dbPath);
  seedDefaults(db);
  const backup = new BackupService({ db, dir: s.backupDir, dirMustExist: s.backupDirConfigured, time: s.backupTime, log });
  const auth = hasPassword ? { authFile: s.authFile, sessions: new SessionStore(s.sessionFile), secureCookie: !!https } : undefined;
  if (!hasPassword) log(s.noAuth ? 'No password is set (RAPIDBOOKS_NO_AUTH): RapidBooks is open to anyone who can reach it.' : 'No password is set: RapidBooks is open (loopback only).');

  const app = buildApp(db, {
    webDist: s.webDist,
    auth,
    allowedHosts: s.allowedHosts,
    backup,
    https,
    listen: { host: s.host, port: s.port, tls: !!https },
  });
  let address: string;
  try {
    address = await app.listen({ port: s.port, host: s.host });
  } catch (e) {
    db.close();
    throw new StartupError(`RapidBooks cannot listen on ${s.host}:${s.port}: ${(e as Error).message}`);
  }
  writePidFile(s.dbPath, { pid: process.pid, url: address, started: new Date().toISOString() });
  backup.start({ catchUpDelayMs: o.catchUpDelayMs });
  log(`RapidBooks server listening on ${address} (database: ${s.dbPath}; backups: ${s.backupDir}${s.backupTime ? ` nightly at ${s.backupTime}` : ', nightly backup off'}).`);

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await app.close(); // stops accepting, lets in-flight requests finish
      await backup.stop(); // waits for a backup in progress
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
        removePidFile(s.dbPath);
      }
    })());

  if (o.signals) {
    const onSignal = (sig: string) => {
      log(`${sig} received: finishing requests and closing the database.`);
      setTimeout(() => {
        console.error('Shutdown took too long; exiting anyway.');
        process.exit(1);
      }, 20_000).unref();
      close().then(
        () => {
          log('RapidBooks stopped cleanly.');
          process.exit(0);
        },
        (e) => {
          console.error('Error while stopping:', e);
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  }

  return { app, db, backup, address, close };
}
