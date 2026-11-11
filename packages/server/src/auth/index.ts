import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readAuthFile, verifyPassword } from './password';
import { SESSION_DAYS, type SessionStore } from './sessions';

// Login for the whole installation: one shared password, a session cookie, a 401 for
// every /api route except health/login/logout/session without one, a growing delay
// after repeated wrong passwords, and a required X-Requested-With header on every
// state-changing /api request (a simple CSRF defence: a form on another site cannot
// add a custom header, and a script on another site cannot send one without CORS).

export const SESSION_COOKIE = 'rb_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'RapidBooks';

export interface AuthOptions {
  /** auth.json; re-read at each login so a new password works at once. */
  authFile: string;
  sessions: SessionStore;
  /** Mark the cookie Secure (the server is listening with TLS). */
  secureCookie?: boolean;
  now?: () => number;
}

/** Routes that answer without a session. */
const PUBLIC = new Set(['GET /api/health', 'HEAD /api/health', 'POST /api/login', 'POST /api/logout', 'GET /api/session', 'HEAD /api/session']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---- Every route registered on an app, so a test can check them all ----

const routeLists = new WeakMap<FastifyInstance, { method: string; url: string }[]>();

/** Must be called before any route is registered. */
export function recordRoutes(app: FastifyInstance) {
  const list: { method: string; url: string }[] = [];
  routeLists.set(app, list);
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) list.push({ method: String(m), url: r.url ?? r.path });
  });
}

export function registeredRoutes(app: FastifyInstance): { method: string; url: string }[] {
  return [...(routeLists.get(app) ?? [])];
}

// ---- Wrong-password throttle ----

export const FREE_ATTEMPTS = 5;
const MAX_DELAY_MS = 60_000;
const FORGET_MS = 3_600_000;

/** After 5 wrong passwords from an address, each further try must wait 1 s, 2 s, 4 s … up to a minute. */
export class LoginThrottle {
  private entries = new Map<string, { failures: number; pending: number; until: number; last: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** 0 = go ahead (the attempt is now counted as pending); otherwise ms to wait. */
  begin(ip: string): number {
    const t = this.now();
    let e = this.entries.get(ip);
    if (e && t - e.last > FORGET_MS && e.pending === 0) {
      this.entries.delete(ip);
      e = undefined;
    }
    if (!e) {
      e = { failures: 0, pending: 0, until: 0, last: t };
      this.entries.set(ip, e);
    }
    if (t < e.until) return e.until - t;
    // Past the free attempts, one try at a time.
    if (e.failures >= FREE_ATTEMPTS && e.pending > 0) return 1000;
    e.pending++;
    e.last = t;
    return 0;
  }

  failed(ip: string) {
    const e = this.entries.get(ip);
    if (!e) return;
    e.pending = Math.max(0, e.pending - 1);
    e.failures++;
    e.last = this.now();
    if (e.failures >= FREE_ATTEMPTS) e.until = e.last + Math.min(MAX_DELAY_MS, 1000 * 2 ** (e.failures - FREE_ATTEMPTS));
  }

  succeeded(ip: string) {
    this.entries.delete(ip);
  }
}

// ---- Cookies, by hand ----

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return undefined;
}

function sessionCookie(token: string, secure: boolean, maxAge = SESSION_DAYS * 86_400) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

const pathOf = (req: FastifyRequest) => {
  const raw = req.url.split('?')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Is this an API request (by its matched route, or by its path when nothing matched)? */
function isApi(req: FastifyRequest): boolean {
  const route = req.routeOptions?.url;
  return (route !== undefined && route.startsWith('/api')) || pathOf(req).toLowerCase().startsWith('/api');
}

/**
 * Install login. With `opts` undefined the server runs open (no password set, bound to
 * loopback): /api/session says so and every route answers without a session.
 */
export function installAuth(app: FastifyInstance, opts: AuthOptions | undefined) {
  const now = opts?.now ?? Date.now;
  const throttle = new LoginThrottle(now);
  const secure = (req: FastifyRequest) => !!opts?.secureCookie || req.protocol === 'https';

  if (opts) {
    const { sessions } = opts;
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isApi(req)) return;
      if (!SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
        return reply.status(403).send({ error: 'This request did not come from the RapidBooks window, so it was refused.' });
      }
      const route = req.routeOptions?.url;
      if (route !== undefined && PUBLIC.has(`${req.method} ${route}`)) return;
      const token = readCookie(req, SESSION_COOKIE);
      const s = sessions.touch(token);
      if (!s.valid) return reply.status(401).send({ error: 'Please log in to RapidBooks.', login: true });
      if (s.refreshed && token) reply.header('set-cookie', sessionCookie(token, secure(req)));
    });
  }

  app.get('/api/session', (req, reply) => {
    if (!opts) return { authenticated: true, authRequired: false };
    const token = readCookie(req, SESSION_COOKIE);
    const s = opts.sessions.touch(token);
    if (s.refreshed && token) reply.header('set-cookie', sessionCookie(token, secure(req)));
    return { authenticated: s.valid, authRequired: true };
  });

  app.post('/api/login', async (req, reply) => {
    if (!opts) return { ok: true, authRequired: false };
    const ip = req.ip;
    const wait = throttle.begin(ip);
    if (wait > 0) {
      const secs = Math.ceil(wait / 1000);
      return reply
        .status(429)
        .header('Retry-After', String(secs))
        .send({ error: `Too many wrong passwords. Wait ${secs} second${secs === 1 ? '' : 's'}, then try again.`, retryAfter: secs });
    }
    const body = z.object({ password: z.string().max(1024) }).safeParse(req.body);
    let ok = false;
    if (body.success) {
      let file;
      try {
        file = readAuthFile(opts.authFile);
      } catch (e) {
        throttle.succeeded(ip);
        return reply.status(500).send({ error: (e as Error).message });
      }
      if (!file) {
        throttle.succeeded(ip);
        return reply.status(503).send({ error: 'The RapidBooks password file is missing. Ask for the password to be set again.' });
      }
      ok = await verifyPassword(body.data.password, file.hash);
    }
    if (!ok) {
      throttle.failed(ip);
      return reply.status(401).send({ error: 'That password is not correct.' });
    }
    throttle.succeeded(ip);
    const token = opts.sessions.create();
    reply.header('set-cookie', sessionCookie(token, secure(req)));
    return { ok: true, authRequired: true };
  });

  app.post('/api/logout', (req, reply) => {
    if (!opts) return { ok: true };
    opts.sessions.destroy(readCookie(req, SESSION_COOKIE));
    reply.header('set-cookie', sessionCookie('', secure(req), 0));
    return { ok: true };
  });
}

// ---- Start-up rule ----

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * May the server start? Open (no password) only on loopback, unless RAPIDBOOKS_NO_AUTH=1.
 * Returns the reason it must not, or null.
 */
export function startupRefusal(o: { host: string; hasPassword: boolean; noAuth: boolean; authFile: string }): string | null {
  if (o.hasPassword || o.noAuth || isLoopback(o.host)) return null;
  return [
    `RapidBooks will not start: it is set to listen on ${o.host}, which other computers can reach,`,
    `and no password has been set (there is no ${o.authFile}).`,
    '',
    'Set the password first:',
    '  cd /opt/rapidbooks && sudo -u rapidbooks npx tsx packages/server/src/auth/set-password.ts',
    '(or: sudo rapidbooks-admin set-password), then start RapidBooks again.',
    '',
    'To run without a password anyway, set RAPIDBOOKS_NO_AUTH=1.',
  ].join('\n');
}
