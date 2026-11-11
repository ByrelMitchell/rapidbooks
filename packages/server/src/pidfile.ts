import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// While the server runs it leaves <database>.server.json beside the database, so the
// restore command can tell that the database is in use and refuse to replace it.

export interface ServerMark {
  pid: number;
  url: string;
  started: string;
}

export const pidFileFor = (dbPath: string) => `${dbPath}.server.json`;

export function writePidFile(dbPath: string, mark: ServerMark) {
  try {
    writeFileSync(pidFileFor(dbPath), JSON.stringify(mark, null, 2));
  } catch {
    // Not fatal: restore just cannot tell.
  }
}

export function removePidFile(dbPath: string) {
  try {
    const f = pidFileFor(dbPath);
    if (!existsSync(f)) return;
    const mark = JSON.parse(readFileSync(f, 'utf8')) as ServerMark;
    if (mark.pid === process.pid) unlinkSync(f);
  } catch {
    // ignore
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to another user (the service user).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The server recorded as running on this database, if its process is still alive. */
export function runningServer(dbPath: string): ServerMark | null {
  const f = pidFileFor(dbPath);
  if (!existsSync(f)) return null;
  try {
    const mark = JSON.parse(readFileSync(f, 'utf8')) as ServerMark;
    return typeof mark.pid === 'number' && mark.pid !== process.pid && alive(mark.pid) ? mark : null;
  } catch {
    return null;
  }
}
