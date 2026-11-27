import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { setPassword } from '../src/auth/password';
import { SessionStore } from '../src/auth/sessions';
import { openDb, type DB } from '../src/db';

let dir: string;
let dist: string;
let db: DB;
const INDEX = '<!doctype html><html><head><script type="module" src="/assets/index-AbC123.js"></script></head><body><div id="root"></div></body></html>';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rb-static-'));
  dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'index-AbC123.js'), 'console.log("app")');
  writeFileSync(join(dist, 'assets', 'index-XyZ789.css'), 'body{}');
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('serving the built web app', () => {
  it('serves index.html uncached and hashed assets for a year', async () => {
    const app = buildApp(db, { webDist: dist });
    const root = await app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toMatch(/text\/html/);
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.body).toBe(INDEX);

    const js = await app.inject({ url: '/assets/index-AbC123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject({ url: '/assets/index-XyZ789.css' })).headers['cache-control']).toBe('public, max-age=31536000, immutable');

    // Unhashed files at the top level are revalidated.
    expect((await app.inject({ url: '/favicon.svg' })).headers['cache-control']).toBe('no-cache');

    // index.html by name, with an ETag so revalidation is cheap.
    const named = await app.inject({ url: '/index.html' });
    expect(named.headers['cache-control']).toBe('no-cache');
    expect(named.headers.etag).toBeTruthy();
    expect((await app.inject({ url: '/', headers: { 'if-none-match': String(named.headers.etag) } })).statusCode).toBe(304);
  });

  it('answers unknown non-/api paths with index.html, and unknown /api paths and assets with 404', async () => {
    const app = buildApp(db, { webDist: dist });
    for (const url of ['/customers', '/reports/profit-and-loss?from=2026-01-01', '/a/b/c']) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toBe(INDEX);
      expect(r.headers['cache-control']).toBe('no-cache');
    }
    const api = await app.inject({ url: '/api/no-such-thing' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/json/);
    expect((await app.inject({ url: '/assets/index-OLD000.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/customers' })).statusCode).toBe(404);
    // The API itself still works.
    expect((await app.inject({ url: '/api/accounts' })).statusCode).toBe(200);
  });

  it('serves the page (for the login screen) without a session while the API needs one', async () => {
    const authFile = join(dir, 'auth.json');
    await setPassword(authFile, 'secret1');
    const app = buildApp(db, { webDist: dist, auth: { authFile, sessions: new SessionStore(null) } });
    expect((await app.inject({ url: '/' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/assets/index-AbC123.js' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/customers' })).body).toBe(INDEX);
    expect((await app.inject({ url: '/api/accounts' })).statusCode).toBe(401);
  });

  it('does nothing without a build', async () => {
    const app = buildApp(db, { webDist: join(dir, 'missing') });
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
  });
});
