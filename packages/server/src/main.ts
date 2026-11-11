import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb, seedDefaults } from './db';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

const dbPath = process.env.RAPIDBOOKS_DB ?? resolve(root, 'data/rapidbooks.db');
const port = Number(process.env.PORT ?? 3001);
// Loopback by default; set HOST=0.0.0.0 (or the LAN address) when deploying.
const host = process.env.HOST ?? '127.0.0.1';

const db = openDb(dbPath);
seedDefaults(db);

const app = buildApp(db, { webDist: resolve(root, 'packages/web/dist') });
app.listen({ port, host }).then((addr) => {
  console.log(`RapidBooks server listening on ${addr} (database: ${dbPath})`);
});
