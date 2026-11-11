import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// SMTP settings. They live outside the database (environment variables and/or a JSON
// file), because database backups get copied around and must not carry the password.
// See docs/EMAIL.md.

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = TLS from the start (port 465); false = STARTTLS when offered (587/25)
  user: string;
  password: string;
  from: string; // "Acme Machine <office@acme.example>"
  bcc_self: boolean; // send a copy to the from address
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export function smtpConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAPIDBOOKS_SMTP_FILE ? resolve(env.RAPIDBOOKS_SMTP_FILE) : resolve(root, 'config/smtp.json');
}

const truthy = (v: unknown) => v === true || (typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim()));

/**
 * Read the SMTP settings: the JSON file first, then RAPIDBOOKS_SMTP_* environment
 * variables, which win. Returns the settings, or the reason they are not usable.
 */
export function loadSmtpConfig(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; config: SmtpConfig } | { ok: false; missing: string } {
  const file = smtpConfigFile(env);
  let json: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, missing: `E-mail is not set up: ${file} is not valid JSON.` };
    }
  }
  const pick = (key: string, envName: string): string => {
    const e = env[envName];
    if (e !== undefined && e !== '') return e;
    const v = json[key];
    return v === undefined || v === null ? '' : String(v);
  };
  const host = pick('host', 'RAPIDBOOKS_SMTP_HOST').trim();
  const secureText = pick('secure', 'RAPIDBOOKS_SMTP_SECURE');
  const secure = truthy(secureText);
  const portText = pick('port', 'RAPIDBOOKS_SMTP_PORT').trim();
  const user = pick('user', 'RAPIDBOOKS_SMTP_USER').trim();
  const password = pick('password', 'RAPIDBOOKS_SMTP_PASSWORD');
  const from = pick('from', 'RAPIDBOOKS_SMTP_FROM').trim();
  const bcc_self = truthy(pick('bcc_self', 'RAPIDBOOKS_SMTP_BCC_SELF'));

  const where = (key: string, envName: string) => `Set ${envName}, or "${key}" in ${file}. See docs/EMAIL.md.`;
  if (!host) return { ok: false, missing: `E-mail is not set up: the SMTP server name is missing. ${where('host', 'RAPIDBOOKS_SMTP_HOST')}` };
  if (!from) return { ok: false, missing: `E-mail is not set up: the From address is missing. ${where('from', 'RAPIDBOOKS_SMTP_FROM')}` };
  if (user && !password) {
    return { ok: false, missing: `E-mail is not set up: the SMTP password is missing. ${where('password', 'RAPIDBOOKS_SMTP_PASSWORD')}` };
  }
  let port = secure ? 465 : 587;
  if (portText) {
    port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { ok: false, missing: `E-mail is not set up: the SMTP port "${portText}" is not a port number. ${where('port', 'RAPIDBOOKS_SMTP_PORT')}` };
    }
  }
  return { ok: true, config: { host, port, secure, user, password, from, bcc_self } };
}
