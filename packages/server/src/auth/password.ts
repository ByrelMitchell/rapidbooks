import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The installation's one password, stored as a scrypt hash in a small JSON file next
// to the database (never in the database: backups get copied around).

const PARAMS = { N: 32768, r: 8, p: 1 };
const KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, salt, keylen, opts, (err, key) => (err ? rej(err) : res(key))));
}
const maxmem = (o: { N: number; r: number }) => 256 * o.N * o.r;

/** "scrypt$N$r$p$<salt base64>$<hash base64>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFC'), salt, KEYLEN, { ...PARAMS, maxmem: maxmem(PARAMS) });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check of a password against a stored hash. False for a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length < 16) return false;
  const key = await scryptAsync(password.normalize('NFC'), salt, expected.length, { N, r, p, maxmem: maxmem({ N, r }) });
  return timingSafeEqual(key, expected);
}

export interface AuthFile {
  hash: string;
  set_at: string;
}

/** The stored password hash, or null when no password has been set. Throws if the file is unreadable or invalid. */
export function readAuthFile(path: string): AuthFile | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<AuthFile>;
  if (typeof data.hash !== 'string' || !data.hash.startsWith('scrypt$'))
    throw new Error(`${path} does not contain a password hash. Run the set-password command again.`);
  return { hash: data.hash, set_at: String(data.set_at ?? '') };
}

/** Write atomically, readable only by the owner. */
export function writePrivateFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function setPassword(path: string, password: string) {
  const file: AuthFile = { hash: await hashPassword(password), set_at: new Date().toISOString() };
  writePrivateFile(path, `${JSON.stringify(file, null, 2)}\n`);
}
