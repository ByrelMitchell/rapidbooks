// Set (or change) the RapidBooks password.
//
//   npx tsx packages/server/src/auth/set-password.ts
//
// Asks for the password twice without showing it; or reads it from standard input
// (first line) when that is not a terminal:  echo 'secret' | npx tsx …/set-password.ts
// Writes RAPIDBOOKS_AUTH_FILE (default auth.json next to the database) and logs
// everyone out. Restart RapidBooks afterwards.

import { existsSync, unlinkSync } from 'node:fs';
import { loadSettings } from '../settings';
import { setPassword } from './password';

export const MIN_LENGTH = 6;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

async function main() {
  const s = loadSettings();
  let password: string;
  if (process.stdin.isTTY) {
    console.log(`Setting the RapidBooks password (stored in ${s.authFile}).`);
    password = await readHidden('New password: ');
    const again = await readHidden('Type it again: ');
    if (password !== again) throw new Error('The two passwords are different. Nothing was changed.');
  } else {
    password = await readStdin();
  }
  if (password.length < MIN_LENGTH) throw new Error(`The password must be at least ${MIN_LENGTH} characters. Nothing was changed.`);
  await setPassword(s.authFile, password);
  // A new password logs everyone out.
  if (existsSync(s.sessionFile)) unlinkSync(s.sessionFile);
  console.log(`Password saved in ${s.authFile}.`);
  console.log('Restart RapidBooks for it to take effect:  sudo systemctl restart rapidbooks');
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
