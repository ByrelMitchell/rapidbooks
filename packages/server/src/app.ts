import {
  AccountInput,
  ItemInput,
  NAME_KINDS,
  NameInput,
  TermsInput,
  TxnInput,
  type CompanyInfo,
  type NameKind,
} from '@rapidbooks/shared';
import Fastify, { type FastifyHttpOptions } from 'fastify';
import type { Server } from 'node:http';
import { z, ZodError } from 'zod';
import { installAuth, recordRoutes, type AuthOptions } from './auth';
import { registerBackupRoutes } from './backup/routes';
import type { BackupService } from './backup/service';
import type { DB } from './db';
import { AppError } from './errors';
import { createAccount, deleteAccount, listAccounts, updateAccount } from './ledger/accounts';
import { deleteTxn, getRegister, getTxn, nextNum, saveTxn, setCleared } from './ledger/posting';
import { createItem, deleteItem, getItem, listItems, updateItem } from './lists/items';
import { createName, deleteName, getName, listNames, updateName } from './lists/names';
import { createTerms, deleteTerms, getTerms, listTerms, updateTerms } from './lists/terms';
import type { MailerFactory } from './mail/send';
import { registerPurchaseRoutes } from './routes/purchases';
import { registerReportRoutes } from './routes/reports';
import { registerSalesRoutes } from './routes/sales';
import { registerWebApp } from './static';
import { registerSystemRoutes, type ListenInfo } from './system';

const Id = z.object({ id: z.coerce.number().int() });
const NAME_KIND_CODES = NAME_KINDS.map((k) => k.code) as [NameKind, ...NameKind[]];

export interface AppOptions {
  webDist?: string;
  mailer?: MailerFactory;
  /** Login (packages/server/src/auth). Omitted = open: no password set, loopback only. */
  auth?: AuthOptions;
  /** Backups (packages/server/src/backup): the /api/backup routes exist only when given. */
  backup?: BackupService;
  /** Listen with TLS. */
  https?: { cert: Buffer; key: Buffer };
  /** Where the server listens, for Help > About. */
  listen?: ListenInfo;
}

export function buildApp(db: DB, opts: AppOptions = {}) {
  // (The https server is typed as http here; the routes don't care which it is.)
  const app = Fastify((opts.https ? { https: opts.https } : {}) as FastifyHttpOptions<Server>);
  // Login comes first so its checks cover every route registered after it.
  recordRoutes(app);
  installAuth(app, opts.auth);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid input.' });
    console.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server. Nothing was saved.' });
  });

  // Accounts
  app.get('/api/accounts', () => listAccounts(db));
  app.post('/api/accounts', (req) => ({ id: createAccount(db, AccountInput.parse(req.body)) }));
  app.put('/api/accounts/:id', (req) => {
    updateAccount(db, Id.parse(req.params).id, AccountInput.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/accounts/:id', (req) => {
    deleteAccount(db, Id.parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/accounts/:id/register', (req) => getRegister(db, Id.parse(req.params).id));

  // Transactions
  app.get('/api/txns/next-num', (req) => {
    // account_id (optional): checks, bill payments and paychecks are numbered per bank account.
    const q = z
      .object({ type: z.string(), account_id: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().optional()) })
      .parse(req.query);
    return { num: nextNum(db, q.type, q.account_id ?? null) };
  });
  app.get('/api/txns/:id', (req) => getTxn(db, Id.parse(req.params).id));
  app.post('/api/txns', (req) => saveTxn(db, TxnInput.parse(req.body)));
  app.put('/api/txns/:id', (req) => saveTxn(db, TxnInput.parse(req.body), Id.parse(req.params).id));
  app.delete('/api/txns/:id', (req) => {
    deleteTxn(db, Id.parse(req.params).id);
    return { ok: true };
  });
  app.put('/api/splits/:id/cleared', (req) => {
    setCleared(db, Id.parse(req.params).id, z.object({ cleared: z.boolean() }).parse(req.body).cleared);
    return { ok: true };
  });

  // Names: customers and jobs, vendors, employees, other names
  app.get('/api/names', (req) => {
    const { kind } = z.object({ kind: z.enum(NAME_KIND_CODES).optional() }).parse(req.query);
    return listNames(db, kind);
  });
  app.get('/api/names/:id', (req) => getName(db, Id.parse(req.params).id));
  app.post('/api/names', (req) => ({ id: createName(db, NameInput.parse(req.body)) }));
  app.put('/api/names/:id', (req) => {
    updateName(db, Id.parse(req.params).id, NameInput.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/names/:id', (req) => {
    deleteName(db, Id.parse(req.params).id);
    return { ok: true };
  });

  // Terms
  app.get('/api/terms', () => listTerms(db));
  app.get('/api/terms/:id', (req) => getTerms(db, Id.parse(req.params).id));
  app.post('/api/terms', (req) => ({ id: createTerms(db, TermsInput.parse(req.body)) }));
  app.put('/api/terms/:id', (req) => {
    updateTerms(db, Id.parse(req.params).id, TermsInput.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/terms/:id', (req) => {
    deleteTerms(db, Id.parse(req.params).id);
    return { ok: true };
  });

  // Items
  app.get('/api/items', () => listItems(db));
  app.get('/api/items/:id', (req) => getItem(db, Id.parse(req.params).id));
  app.post('/api/items', (req) => ({ id: createItem(db, ItemInput.parse(req.body)) }));
  app.put('/api/items/:id', (req) => {
    updateItem(db, Id.parse(req.params).id, ItemInput.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/items/:id', (req) => {
    deleteItem(db, Id.parse(req.params).id);
    return { ok: true };
  });

  // Company information
  app.get('/api/company', () => {
    const rows = db.prepare('SELECT key, value FROM company').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value])) as CompanyInfo;
  });
  app.put('/api/company', (req) => {
    const info = z.record(z.string(), z.string()).parse(req.body);
    const up = db.prepare(
      'INSERT INTO company (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    );
    db.transaction(() => Object.entries(info).forEach(([k, v]) => up.run(k, v)))();
    return { ok: true };
  });

  // Sales and receivables: forms' lookups, finance charges, statements, PDFs, e-mail
  registerSalesRoutes(app, db, opts.mailer);

  // Purchases and banking: Pay Bills, check numbers and printing, payroll items
  registerPurchaseRoutes(app, db);

  // Reports, Find, graphs, combined PDFs (Phase 5)
  registerReportRoutes(app, db);

  // Backups, health, Help > About
  if (opts.backup) registerBackupRoutes(app, opts.backup);
  registerSystemRoutes(app, db, { backup: opts.backup, listen: opts.listen });

  // The built web app, with SPA fallback and cache headers (in development Vite serves it instead).
  registerWebApp(app, opts.webDist);

  return app;
}
