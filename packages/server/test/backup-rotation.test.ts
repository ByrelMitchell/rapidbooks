import { describe, expect, it } from 'vitest';
import { backupFileName, backupsToDelete, nextRunAt, parseBackupName } from '../src/backup/rotation';

// All dates are local time, like the file names.
const d = (y: number, mo: number, day: number, h = 2, mi = 0, s = 0) => new Date(y, mo - 1, day, h, mi, s);
const n = (date: Date) => backupFileName(date);
// Wednesday 11 November 2026, noon.
const NOW = d(2026, 11, 11, 12);

describe('backup names', () => {
  it('formats and parses rapidbooks-YYYYMMDD-HHMMSS.db', () => {
    expect(n(d(2026, 3, 4, 5, 6, 7))).toBe('rapidbooks-20260304-050607.db');
    expect(parseBackupName('rapidbooks-20260304-050607.db')).toEqual(d(2026, 3, 4, 5, 6, 7));
  });
  it('rejects anything else', () => {
    for (const name of [
      'rapidbooks-20260304-050607.db.partial',
      '.rapidbooks-20260304-050607.db.ab12.partial',
      'Rapidbooks-20260304-050607.db',
      'rapidbooks-2026034-050607.db',
      'rapidbooks-20261399-000000.db',
      'rapidbooks-20260230-000000.db',
      'rapidbooks-20260304-250000.db',
      'notes.txt',
    ])
      expect(parseBackupName(name)).toBeNull();
  });
});

describe('backupsToDelete', () => {
  it('does nothing with no backups', () => {
    expect(backupsToDelete([], NOW)).toEqual([]);
  });

  it('never touches files that do not match the pattern', () => {
    const odd = ['notes.txt', 'rapidbooks-20200101-020000.db.partial', 'rapidbooks-20201399-020000.db', 'RAPIDBOOKS-20200101-020000.db', 'rapidbooks.db'];
    expect(backupsToDelete([...odd, n(d(2020, 1, 1)), n(d(2026, 11, 10))], NOW)).toEqual([n(d(2020, 1, 1))]);
  });

  it('never deletes the newest backup, however old', () => {
    expect(backupsToDelete([n(d(2019, 1, 1))], NOW)).toEqual([]);
    expect(backupsToDelete([n(d(2019, 1, 1)), n(d(2019, 2, 1))], NOW)).toEqual([n(d(2019, 1, 1))]);
  });

  it('keeps every backup of the last 14 days, including several a day', () => {
    const names: string[] = [];
    for (let i = 0; i < 14; i++) {
      names.push(n(d(2026, 11, 11 - i, 2)), n(d(2026, 11, 11 - i, 0, 30)));
    }
    names.push(n(d(2026, 10, 28, 12, 0, 0))); // exactly 14 days before now
    expect(backupsToDelete(names, NOW)).toEqual([]);
  });

  it('the 14-day boundary: older than that, only one per week is kept', () => {
    // Week Mon 26 Oct – Sun 1 Nov 2026 straddles the boundary (Wed 28 Oct 12:00).
    const names = [
      n(d(2026, 10, 26)), // weekly range, oldest of its week: kept
      n(d(2026, 10, 27)), // weekly range: deleted
      n(d(2026, 10, 28, 11, 59, 59)), // one second too old for the daily range: deleted
      n(d(2026, 10, 28, 12, 0, 0)), // exactly 14 days: kept
      n(d(2026, 10, 29)), // daily: kept
    ];
    expect(backupsToDelete(names, NOW).sort()).toEqual([n(d(2026, 10, 27)), n(d(2026, 10, 28, 11, 59, 59))].sort());
  });

  it('weeks run Monday to Sunday', () => {
    const names = [
      n(d(2026, 10, 18, 23, 59, 59)), // Sunday: oldest of week 12–18 Oct (only one): kept
      n(d(2026, 10, 19, 0, 0, 0)), // Monday: oldest of week 19–25 Oct: kept
      n(d(2026, 10, 19, 2)), // same week: deleted
      n(d(2026, 10, 25, 23)), // Sunday, same week: deleted
      n(d(2026, 11, 10)),
    ];
    expect(backupsToDelete(names, NOW).sort()).toEqual([n(d(2026, 10, 19, 2)), n(d(2026, 10, 25, 23))].sort());
  });

  it('the 8-week boundary: older than 14 days + 8 weeks, only one per month is kept', () => {
    // Weekly range starts Wed 2 Sep 2026 12:00 (now - 14 days - 56 days).
    const names = [
      n(d(2026, 9, 1)), // monthly range, oldest of September there: kept
      n(d(2026, 9, 2, 11, 59, 59)), // monthly range, September again: deleted
      n(d(2026, 9, 2, 12, 0, 0)), // exactly at the boundary: weekly range, week of 31 Aug: kept
      n(d(2026, 9, 3)), // same week: deleted
      n(d(2026, 11, 10)),
    ];
    expect(backupsToDelete(names, NOW).sort()).toEqual([n(d(2026, 9, 2, 11, 59, 59)), n(d(2026, 9, 3))].sort());
  });

  it('keeps the oldest backup of each month, back 24 months', () => {
    const names = [
      n(d(2026, 1, 1)),
      n(d(2026, 1, 15)),
      n(d(2026, 1, 31, 23, 59, 59)),
      n(d(2026, 2, 1, 0, 0, 0)),
      n(d(2026, 2, 2)),
      n(d(2026, 11, 10)),
    ];
    expect(backupsToDelete(names, NOW).sort()).toEqual([n(d(2026, 1, 15)), n(d(2026, 1, 31, 23, 59, 59)), n(d(2026, 2, 2))].sort());
  });

  it('the 24-month boundary', () => {
    const names = [
      n(d(2024, 11, 11, 11, 59, 59)), // just over 24 months: deleted
      n(d(2024, 11, 11, 12, 0, 0)), // exactly 24 months: kept (oldest of Nov 2024 in range)
      n(d(2024, 11, 20)), // same month: deleted
      n(d(2024, 12, 1)), // kept
      n(d(2026, 11, 10)),
    ];
    expect(backupsToDelete(names, NOW).sort()).toEqual([n(d(2024, 11, 11, 11, 59, 59)), n(d(2024, 11, 20))].sort());
  });

  it('is stable when run every night for three years', () => {
    let files: string[] = [];
    const first = d(2024, 1, 1, 2);
    let prevKept = new Set<string>();
    for (let day = 0; day < 3 * 366; day++) {
      const now = new Date(first);
      now.setDate(now.getDate() + day);
      const name = n(now);
      files.push(name);
      const del = backupsToDelete(files, now);
      expect(del).not.toContain(name);
      files = files.filter((f) => !del.includes(f));
      // Nothing kept yesterday reappears; nothing kept is replaced by something new except tonight's.
      for (const f of files) expect(prevKept.has(f) || f === name).toBe(true);
      prevKept = new Set(files);
    }
    // 14 daily + about 8 weekly + about 24 monthly.
    expect(files.length).toBeGreaterThanOrEqual(14 + 8 + 22);
    expect(files.length).toBeLessThanOrEqual(14 + 10 + 25);
    const last = new Date(first);
    last.setDate(last.getDate() + 3 * 366 - 1);
    // Every one of the last 14 nights is there.
    for (let i = 0; i < 14; i++) {
      const t = new Date(last);
      t.setDate(t.getDate() - i);
      expect(files).toContain(n(t));
    }
    // One backup in each of the months from 3 to 23 months ago.
    const months = new Set(files.map((f) => f.slice(11, 17)));
    for (let m = 3; m <= 23; m++) {
      const t = new Date(last.getFullYear(), last.getMonth() - m, 1);
      expect(months.has(`${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}`)).toBe(true);
    }
  });
});

describe('nextRunAt', () => {
  it('is today when the time is still ahead, otherwise tomorrow', () => {
    expect(nextRunAt(d(2026, 11, 11, 1, 59, 59), '02:00')).toEqual(d(2026, 11, 11, 2));
    expect(nextRunAt(d(2026, 11, 11, 2, 0, 0), '02:00')).toEqual(d(2026, 11, 12, 2));
    expect(nextRunAt(d(2026, 12, 31, 23), '02:00')).toEqual(d(2027, 1, 1, 2));
    expect(nextRunAt(d(2026, 11, 11, 12), '23:30')).toEqual(d(2026, 11, 11, 23, 30));
  });
});
