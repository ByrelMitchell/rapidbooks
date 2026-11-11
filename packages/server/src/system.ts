import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import type { BackupService } from './backup/service';
import type { DB } from './db';
import { appVersion } from './settings';

export interface ListenInfo {
  host: string;
  port: number;
  tls: boolean;
}

/** The addresses other computers can use to reach the server. */
export function serverUrls(l: ListenInfo): string[] {
  const proto = l.tls ? 'https' : 'http';
  const wildcard = l.host === '0.0.0.0' || l.host === '::' || l.host === '';
  if (!wildcard) return [`${proto}://${l.host.includes(':') ? `[${l.host}]` : l.host}:${l.port}`];
  const urls = [`${proto}://${hostname()}:${l.port}`];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') urls.push(`${proto}://${a.address}:${l.port}`);
  return urls;
}

const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);

/** GET /api/health (no login needed) and GET /api/about (Help > About RapidBooks). */
export function registerSystemRoutes(app: FastifyInstance, db: DB, o: { backup?: BackupService; listen?: ListenInfo }) {
  app.get('/api/health', (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true, version: appVersion(), database: 'ok' };
    } catch {
      return reply.status(503).send({ ok: false, version: appVersion(), database: 'error' });
    }
  });

  app.get('/api/about', (req) => {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const memory = db.memory || db.name === ':memory:';
    const status = o.backup?.status();
    return {
      version: appVersion(),
      node: process.version,
      server: {
        hostname: hostname(),
        urls: o.listen ? serverUrls(o.listen) : [],
        tls: o.listen?.tls ?? req.protocol === 'https',
        // What this browser used to reach it.
        thisAddress: `${req.protocol}://${req.host}`,
      },
      database: {
        path: memory ? '(in memory)' : db.name,
        size: memory ? 0 : fileSize(db.name),
        walSize: memory ? 0 : fileSize(`${db.name}-wal`),
      },
      counts: {
        transactions: count('SELECT COUNT(*) AS n FROM txns'),
        accounts: count('SELECT COUNT(*) AS n FROM accounts'),
        names: count('SELECT COUNT(*) AS n FROM names'),
      },
      backup: status ? { directory: status.directory, lastSuccess: status.lastSuccess, lastError: status.lastError } : null,
    };
  });
}
