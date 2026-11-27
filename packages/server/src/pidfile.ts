import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

// While the server runs it leaves <database>.server.json beside the database, so the
// restore command can tell that the database is in use and refuse to replace it.
//
// A process number only means something on the machine (or in the container) that wrote
// it: in Docker the restore runs in a container of its own, where the server's process
// is invisible. So the server also touches the file every HEARTBEAT_MS, and a file from
// another host counts as a running server while it is fresh.

export interface ServerMark {
  pid: number;
  url: string;
  started: string;
  /** os.hostname() of the server (in Docker, its container). */
  host?: string;
}

export const HEARTBEAT_MS = 30_000;
/** A file from another host this long untouched is left over from a server that was killed. */
export const STALE_MS = 3 * HEARTBEAT_MS;

let heartbeat: NodeJS.Timeout | null = null;

export const pidFileFor = (dbPath: string) => `${dbPath}.server.json`;

export function writePidFile(dbPath: string, mark: ServerMark) {
  const f = pidFileFor(dbPath);
  try {
    writeFileSync(f, JSON.stringify({ ...mark, host: mark.host ?? hostname() }, null, 2));
  } catch {
    // Not fatal: restore just cannot tell.
    return;
  }
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(f, t, t);
    } catch {
      // ignore
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

export function removePidFile(dbPath: string) {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
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

/**
 * The server recorded as running on this database, if it still is: its process is alive
 * (same host), or its file is fresh (another host or container).
 */
export function runningServer(dbPath: string, now: number = Date.now()): ServerMark | null {
  const f = pidFileFor(dbPath);
  if (!existsSync(f)) return null;
  try {
    const mark = JSON.parse(readFileSync(f, 'utf8')) as ServerMark;
    if (typeof mark.pid !== 'number') return null;
    if (mark.host !== undefined && mark.host !== hostname()) return now - statSync(f).mtimeMs < STALE_MS ? mark : null;
    return mark.pid !== process.pid && alive(mark.pid) ? mark : null;
  } catch {
    return null;
  }
}
