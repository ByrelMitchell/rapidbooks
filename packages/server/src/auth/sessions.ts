import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writePrivateFile } from './password';

// Login sessions: kept in memory and mirrored to a small JSON file so a restart of the
// server does not log her out. The file holds SHA-256 hashes of the tokens, not the
// tokens themselves. Expiry slides: every use pushes it 30 days ahead.

export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
/** Don't rewrite the file on every request: only when the expiry moves this much. */
const PERSIST_EVERY_MS = 3_600_000;

interface Session {
  created: number;
  expires: number;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Session>;
      const t = this.now();
      for (const [h, s] of Object.entries(data))
        if (typeof s?.expires === 'number' && s.expires > t) this.sessions.set(h, { created: s.created, expires: s.expires });
    } catch (e) {
      console.error(`Could not read the sessions file ${this.file}: ${(e as Error).message}. Everyone will need to log in again.`);
    }
  }

  private save() {
    if (!this.file) return;
    try {
      const t = this.now();
      const out: Record<string, Session> = {};
      for (const [h, s] of this.sessions) if (s.expires > t) out[h] = s;
      writePrivateFile(this.file, JSON.stringify(out));
    } catch (e) {
      console.error(`Could not save the sessions file ${this.file}: ${(e as Error).message}`);
    }
  }

  /** A new session; returns its token (for the cookie). */
  create(): string {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(hashToken(token), { created: t, expires: t + SESSION_MS });
    this.save();
    return token;
  }

  /**
   * Is the token a live session? Slides its expiry. `refreshed` is true when the
   * expiry moved enough that the cookie should be sent again.
   */
  touch(token: string | undefined): { valid: boolean; refreshed: boolean } {
    if (!token) return { valid: false, refreshed: false };
    const h = hashToken(token);
    const s = this.sessions.get(h);
    const t = this.now();
    if (!s) return { valid: false, refreshed: false };
    if (s.expires <= t) {
      this.sessions.delete(h);
      this.save();
      return { valid: false, refreshed: false };
    }
    const expires = t + SESSION_MS;
    if (expires - s.expires >= PERSIST_EVERY_MS) {
      s.expires = expires;
      this.save();
      return { valid: true, refreshed: true };
    }
    return { valid: true, refreshed: false };
  }

  destroy(token: string | undefined) {
    if (!token) return;
    if (this.sessions.delete(hashToken(token))) this.save();
  }

  get size() {
    return this.sessions.size;
  }
}
