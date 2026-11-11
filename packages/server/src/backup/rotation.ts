// Backup file names and the rotation policy. Pure functions: no file system, no clock.

const NAME_RE = /^rapidbooks-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

const p2 = (n: number) => String(n).padStart(2, '0');

/** rapidbooks-YYYYMMDD-HHMMSS.db, in local time. */
export function backupFileName(at: Date): string {
  return (
    `rapidbooks-${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}` +
    `-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}.db`
  );
}

/** The local time a backup was taken, from its name; null for anything that is not one of ours. */
export function parseBackupName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const at = new Date(y, mo - 1, d, h, mi, s);
  // Reject impossible dates (20261399-...) rather than letting Date roll them over.
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || at.getHours() !== h || at.getMinutes() !== mi || at.getSeconds() !== s)
    return null;
  return at;
}

export const KEEP_DAILY_DAYS = 14;
export const KEEP_WEEKLY_WEEKS = 8;
export const KEEP_MONTHLY_MONTHS = 24;

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Monday 00:00 local of the week containing `d`, as a key. */
function weekKey(d: Date): string {
  const back = (d.getDay() + 6) % 7; // Monday = 0
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  return `${mon.getFullYear()}-${mon.getMonth()}-${mon.getDate()}`;
}

const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;

/**
 * Which backups to delete. The policy:
 *  - every backup taken in the last 14 days (taken at or after now minus 14 days) is kept;
 *  - for the 8 weeks before that, one per calendar week (Monday to Sunday): the oldest
 *    one of that week still in this range;
 *  - before that and back to 24 months before now, one per calendar month: the oldest
 *    one of that month still in this range;
 *  - anything older is deleted;
 *  - the newest backup is never deleted, however old;
 *  - names that do not match rapidbooks-YYYYMMDD-HHMMSS.db are never touched.
 *
 * Keeping the oldest in each week/month makes the choice stable as time passes: a
 * backup kept today is not replaced tomorrow by a younger one of the same week.
 */
export function backupsToDelete(names: readonly string[], now: Date): string[] {
  const parsed = names
    .map((name) => ({ name, at: parseBackupName(name) }))
    .filter((b): b is { name: string; at: Date } => b.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.name < b.name ? -1 : 1));
  if (parsed.length === 0) return [];

  const dailyFrom = addDays(now, -KEEP_DAILY_DAYS);
  const weeklyFrom = addDays(dailyFrom, -7 * KEEP_WEEKLY_WEEKS);
  const monthlyFrom = new Date(now);
  monthlyFrom.setMonth(monthlyFrom.getMonth() - KEEP_MONTHLY_MONTHS);

  const keep = new Set<string>([parsed[parsed.length - 1].name]); // the newest, always
  const weeks = new Set<string>();
  const months = new Set<string>();
  // Oldest first, so the first one seen in a week or month is the one kept.
  for (const b of parsed) {
    if (b.at >= dailyFrom) keep.add(b.name);
    else if (b.at >= weeklyFrom) {
      const k = weekKey(b.at);
      if (!weeks.has(k)) {
        weeks.add(k);
        keep.add(b.name);
      }
    } else if (b.at >= monthlyFrom) {
      const k = monthKey(b.at);
      if (!months.has(k)) {
        months.add(k);
        keep.add(b.name);
      }
    }
  }
  return parsed.filter((b) => !keep.has(b.name)).map((b) => b.name);
}

/** The next time the nightly backup is due: today at HH:MM local if still ahead, else tomorrow. */
export function nextRunAt(now: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}
