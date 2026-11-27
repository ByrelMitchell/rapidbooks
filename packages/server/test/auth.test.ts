import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { CSRF_VALUE, FREE_ATTEMPTS, isLoopback, LoginThrottle, registeredRoutes, startupRefusal, type AuthOptions } from '../src/auth';
import { hashPassword, setPassword, verifyPassword } from '../src/auth/password';
import { SessionStore } from '../src/auth/sessions';
import { BackupService } from '../src/backup/service';
import { openDb, seedDefaults, type DB } from '../src/db';
import { AppError } from '../src/errors';
import { startServer, StartupError } from '../src/server';
import { loadSettings } from '../src/settings';

const PASSWORD = 'correct horse';
const H = { 'x-requested-with': CSRF_VALUE };

let dir: string;
let db: DB;
let authFile: string;
let sessionFile: string;
let clock: number;
const now = () => clock;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rb-auth-'));
  authFile = join(dir, 'auth.json');
  sessionFile = join(dir, 'sessions.json');
  await setPassword(authFile, PASSWORD);
  db = openDb(join(dir, 'rapidbooks.db'));
  seedDefaults(db);
  clock = Date.UTC(2026, 10, 11, 12);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(extra: Partial<AuthOptions> = {}): FastifyInstance {
  return buildApp(db, {
    auth: { authFile, sessions: new SessionStore(sessionFile, now), now, ...extra },
    backup: new BackupService({ db, dir: join(dir, 'backups'), time: null, log: () => undefined }),
    mailer: () => {
      throw new AppError(400, 'No e-mail in tests.');
    },
  });
}

const cookieOf = (res: LightMyRequestResponse) => {
  const sc = res.headers['set-cookie'];
  const line = Array.isArray(sc) ? sc[0] : sc;
  return line!.split(';')[0];
};

async function login(a: FastifyInstance, password = PASSWORD) {
  return a.inject({ method: 'POST', url: '/api/login', headers: H, payload: { password } });
}

describe('password hashing', () => {
  it('hashes with scrypt and a random salt, and verifies', async () => {
    const h1 = await hashPassword('s3cret!');
    const h2 = await hashPassword('s3cret!');
    expect(h1).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword('s3cret!', h1)).toBe(true);
    expect(await verifyPassword('s3cret!', h2)).toBe(true);
    expect(await verifyPassword('s3cret', h1)).toBe(false);
    expect(await verifyPassword('', h1)).toBe(false);
    expect(await verifyPassword('s3cret!', 'plain-text')).toBe(false);
    expect(await verifyPassword('s3cret!', 'scrypt$1$1$1$AAAA$AAAA')).toBe(false);
  });
});

describe('login', () => {
  it('sets an HttpOnly, SameSite=Strict, 30-day session cookie; Secure over TLS', async () => {
    const res = await login(app());
    expect(res.statusCode).toBe(200);
    const sc = String(res.headers['set-cookie']);
    expect(sc).toMatch(/^rb_session=[A-Za-z0-9_-]{40,};/);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    expect(sc).toContain('Max-Age=2592000');
    expect(sc).toContain('Path=/');
    expect(sc).not.toContain('Secure');
    expect(String((await login(app({ secureCookie: true }))).headers['set-cookie'])).toContain('; Secure');
  });

  it('refuses a wrong password, and reports the session state', async () => {
    const a = app();
    const bad = await login(a, 'wrong');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toMatch(/not correct/);
    expect((await a.inject({ url: '/api/session' })).json()).toEqual({ authenticated: false, authRequired: true });
    const cookie = cookieOf(await login(a));
    expect((await a.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({ authenticated: true, authRequired: true });
    const out = await a.inject({ method: 'POST', url: '/api/logout', headers: { ...H, cookie } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await a.inject({ url: '/api/accounts', headers: { cookie } })).statusCode).toBe(401);
  });

  it('every /api route except health, login, logout and session needs a session', async () => {
    const a = app();
    await a.ready();
    const cookie = cookieOf(await login(a));
    const routes = registeredRoutes(a).filter((r) => r.url.startsWith('/api'));
    expect(routes.length).toBeGreaterThan(60);
    const open = new Set(['/api/health', '/api/login', '/api/logout', '/api/session']);
    expect(routes.filter((r) => open.has(r.url)).length).toBeGreaterThanOrEqual(4);
    for (const r of routes) {
      if (open.has(r.url)) continue;
      const url = r.url.replace(/:[A-Za-z_]+/g, '1').replace(/\*/g, 'x');
      const method = r.method as 'GET';
      const without = await a.inject({ method, url, headers: H });
      expect(without.statusCode, `${r.method} ${r.url} without a session`).toBe(401);
      const withIt = await a.inject({ method, url, headers: { ...H, cookie } });
      expect([401, 403], `${r.method} ${r.url} with a session (got ${withIt.statusCode})`).not.toContain(withIt.statusCode);
    }
    // And the open ones answer without a session.
    expect((await a.inject({ url: '/api/health' })).json()).toMatchObject({ ok: true, database: 'ok', version: expect.any(String) });
    // Unknown /api paths are refused too, rather than leaking whether they exist.
    expect((await a.inject({ url: '/api/no-such-thing' })).statusCode).toBe(401);
    expect((await a.inject({ url: '/%61pi/accounts' })).statusCode).toBe(401);
  });

  it('a session survives a rebuilt app (server restart) when the session file is shared', async () => {
    const cookie = cookieOf(await login(app()));
    expect(existsSync(sessionFile)).toBe(true);
    const restarted = app();
    expect((await restarted.inject({ url: '/api/accounts', headers: { cookie } })).statusCode).toBe(200);
    // Without the file, it would not.
    const other = buildApp(db, { auth: { authFile, sessions: new SessionStore(join(dir, 'other.json'), now), now } });
    expect((await other.inject({ url: '/api/accounts', headers: { cookie } })).statusCode).toBe(401);
  });

  it('the 30-day expiry slides with use', async () => {
    const a = app();
    const cookie = cookieOf(await login(a));
    const day = 86_400_000;
    clock += 29 * day;
    const r1 = await a.inject({ url: '/api/accounts', headers: { cookie } });
    expect(r1.statusCode).toBe(200);
    expect(String(r1.headers['set-cookie'])).toContain('Max-Age=2592000'); // cookie renewed too
    clock += 29 * day;
    expect((await a.inject({ url: '/api/accounts', headers: { cookie } })).statusCode).toBe(200);
    clock += 31 * day;
    expect((await a.inject({ url: '/api/accounts', headers: { cookie } })).statusCode).toBe(401);
  });

  it(`after ${FREE_ATTEMPTS} wrong passwords from an address, makes it wait longer and longer`, async () => {
    const a = app();
    for (let i = 0; i < FREE_ATTEMPTS; i++) expect((await login(a, 'nope')).statusCode).toBe(401);
    // Locked for 1 second, even for the right password.
    let r = await login(a);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    expect(r.json().error).toMatch(/Wait 1 second/);
    clock += 1001;
    expect((await login(a, 'nope')).statusCode).toBe(401);
    r = await login(a, 'nope');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('2');
    clock += 2001;
    expect((await login(a, 'nope')).statusCode).toBe(401);
    expect((await login(a)).headers['retry-after']).toBe('4');
    // Another address is not affected.
    expect((await a.inject({ method: 'POST', url: '/api/login', headers: H, payload: { password: PASSWORD }, remoteAddress: '10.0.0.9' })).statusCode).toBe(200);
    clock += 4001;
    expect((await login(a)).statusCode).toBe(200);
    // Success resets the count.
    expect((await login(a, 'nope')).statusCode).toBe(401);
    expect((await login(a, 'nope')).statusCode).toBe(401);
  });

  it('requires the X-Requested-With header on state-changing requests', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: '/api/login', payload: { password: PASSWORD } })).statusCode).toBe(403);
    const cookie = cookieOf(await login(a));
    const acct = { name: 'Petty Cash', type: 'BANK' };
    const noHeader = await a.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: acct });
    expect(noHeader.statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/accounts', headers: { cookie, 'x-requested-with': 'XMLHttpRequest' }, payload: acct })).statusCode).toBe(403);
    expect((await a.inject({ method: 'DELETE', url: '/api/accounts/1', headers: { cookie } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/accounts', headers: { ...H, cookie }, payload: acct })).statusCode).toBe(200);
    // Reads don't need it.
    expect((await a.inject({ url: '/api/accounts', headers: { cookie } })).statusCode).toBe(200);
  });

  it('runs open when no password is set (buildApp without auth)', async () => {
    const a = buildApp(db);
    expect((await a.inject({ url: '/api/accounts' })).statusCode).toBe(200);
    expect((await a.inject({ url: '/api/session' })).json()).toEqual({ authenticated: true, authRequired: false });
  });

  it('open, still requires X-Requested-With, and answers only to addresses, localhost and allowed names', async () => {
    const a = buildApp(db, { allowedHosts: ['books.lan'] });
    const acct = { name: 'Petty Cash', type: 'BANK' };
    expect((await a.inject({ method: 'POST', url: '/api/accounts', payload: acct })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/accounts', headers: H, payload: acct })).statusCode).toBe(200);
    for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001', '192.168.1.20:3001', 'books.lan:3001', 'LOCALHOST']) {
      expect((await a.inject({ url: '/api/accounts', headers: { host } })).statusCode, host).toBe(200);
    }
    // A page that rebound its own name to 127.0.0.1 (DNS rebinding) is refused, reads too.
    for (const host of ['evil.example:3001', 'evil.example', '127.0.0.1.evil.example']) {
      const r = await a.inject({ url: '/api/backup/download', headers: { host } });
      expect(r.statusCode, host).toBe(403);
      expect(r.json().error).toMatch(/does not answer to the name/);
    }
    expect((await a.inject({ method: 'DELETE', url: '/api/accounts/1', headers: { ...H, host: 'evil.example' } })).statusCode).toBe(403);
    // The web app itself (not /api) still loads, so the message can be seen.
    expect((await a.inject({ url: '/', headers: { host: 'evil.example' } })).statusCode).not.toBe(403);
  });

  it(`a burst of logins sent at once gets no more than ${FREE_ATTEMPTS} guesses`, () => {
    const t = new LoginThrottle(now);
    const let_through = Array.from({ length: 50 }, () => t.begin('10.0.0.5')).filter((w) => w === 0).length;
    expect(let_through).toBe(FREE_ATTEMPTS);
    for (let i = 0; i < FREE_ATTEMPTS; i++) t.failed('10.0.0.5');
    expect(t.begin('10.0.0.5')).toBeGreaterThan(0);
  });

  it('forgets addresses that have been quiet for an hour', () => {
    const t = new LoginThrottle(now);
    for (let i = 0; i < 100; i++) {
      t.begin(`10.0.${i}.1`);
      t.failed(`10.0.${i}.1`);
    }
    expect(t.size).toBe(100);
    clock += 3_600_001;
    t.begin('10.9.9.9');
    expect(t.size).toBe(1);
  });
});

describe('start-up', () => {
  it('knows loopback addresses', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3', '::ffff:127.0.0.1']) expect(isLoopback(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.20', 'books.lan', '']) expect(isLoopback(h)).toBe(false);
  });

  it('refuses to start open on a non-loopback host, unless told to', () => {
    const base = { hasPassword: false, noAuth: false, authFile: '/var/lib/rapidbooks/auth.json' };
    expect(startupRefusal({ ...base, host: '0.0.0.0' })).toMatch(/set-password/);
    expect(startupRefusal({ ...base, host: '192.168.1.20' })).toMatch(/RAPIDBOOKS_NO_AUTH=1/);
    expect(startupRefusal({ ...base, host: '127.0.0.1' })).toBeNull();
    expect(startupRefusal({ ...base, host: '0.0.0.0', hasPassword: true })).toBeNull();
    expect(startupRefusal({ ...base, host: '0.0.0.0', noAuth: true })).toBeNull();
  });

  it('startServer: refuses 0.0.0.0 without a password, starts on loopback without one, starts on 0.0.0.0 with one', async () => {
    const env = (extra: Record<string, string>) =>
      loadSettings({ RAPIDBOOKS_DB: join(dir, 'srv', 'rapidbooks.db'), PORT: '0', RAPIDBOOKS_BACKUP_TIME: 'off', RAPIDBOOKS_WEB_DIST: join(dir, 'nodist'), ...extra });
    const log = () => undefined;
    await expect(startServer(env({ HOST: '0.0.0.0' }), { log })).rejects.toThrow(StartupError);
    await expect(startServer(env({ HOST: '0.0.0.0' }), { log })).rejects.toThrow(/no password has been set/);

    const open = await startServer(env({ HOST: '127.0.0.1' }), { log });
    expect((await open.app.inject({ url: '/api/accounts' })).statusCode).toBe(200);
    await open.close();

    await setPassword(join(dir, 'srv', 'auth.json'), PASSWORD);
    const locked = await startServer(env({ HOST: '0.0.0.0' }), { log });
    expect((await locked.app.inject({ url: '/api/accounts' })).statusCode).toBe(401);
    // Graceful close checkpoints and closes the database.
    await locked.close();
    expect(locked.db.open).toBe(false);
    expect(existsSync(join(dir, 'srv', 'rapidbooks.db.server.json'))).toBe(false);
  });
});
