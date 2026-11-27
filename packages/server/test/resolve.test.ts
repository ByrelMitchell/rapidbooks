import { describe, expect, it } from 'vitest';
import { resolveSharedNames, subsetsSumming, type AmbiguousRow, type Period } from '../src/import/resolve';

const A = 1; // e.g. Utilities:electric
const B = 2; // Supplies:electric
let key = 0;
const row = (date: string, amount: number, vendor = 'v'): AmbiguousRow => ({ key: key++, group: 'electric|1,2', candidates: [A, B], date, amount, vendor });
const month = (m: string, a: number, b: number): Period => ({
  from: `2025-${m}-01`,
  to: `2025-${m}-28`,
  amounts: new Map([
    [A, a],
    [B, b],
  ]),
});
const none = () => 0;

describe('subsetsSumming', () => {
  it('finds every subset making the target, negatives included', () => {
    expect(subsetsSumming([5, 3, 2], 5)).toEqual(expect.arrayContaining([[1, 2], [0]]));
    expect(subsetsSumming([5, 3, 2], 5)).toHaveLength(2);
    expect(subsetsSumming([5, -2, 7], 3)).toEqual([[0, 1]]);
    expect(subsetsSumming([4, 4], 3)).toEqual([]);
    expect(subsetsSumming([], 0)).toEqual([[]]);
  });
});

describe('resolveSharedNames', () => {
  it('gives each row the account that makes every period agree', () => {
    const rows = [row('2025-01-05', 100), row('2025-01-09', 40), row('2025-02-03', 90), row('2025-02-20', 15)];
    const { assign, groups } = resolveSharedNames(rows, [month('01', 100, 40), month('02', 90, 15)], none);
    expect(rows.map((r) => assign.get(r.key))).toEqual([A, B, A, B]);
    expect(groups[0]).toMatchObject({ rows: 4, resolved: 4, periods: 2, ambiguous: [], inconsistent: [] });
  });

  it('counts rows already known for an account', () => {
    const rows = [row('2025-01-05', 100), row('2025-01-09', 40)];
    // Account A already has 40 from a row that was not ambiguous: so 100 is B's.
    const fixed = (acct: number) => (acct === A ? 40 : 0);
    const { assign } = resolveSharedNames(rows, [month('01', 80, 100)], fixed);
    expect(rows.map((r) => assign.get(r.key))).toEqual([B, A]);
  });

  it('takes either of two rows of the same vendor and amount, but not of different vendors', () => {
    const same = [row('2025-01-05', 50, 'NIPSCO'), row('2025-01-25', 50, 'NIPSCO')];
    const r1 = resolveSharedNames(same, [month('01', 50, 50)], none);
    expect(new Set(same.map((r) => r1.assign.get(r.key)))).toEqual(new Set([A, B]));
    expect(r1.groups[0].ambiguous).toEqual([]);

    const different = [row('2025-01-05', 50, 'NIPSCO'), row('2025-01-25', 50, "Menard's")];
    const r2 = resolveSharedNames(different, [month('01', 50, 50)], none);
    expect(r2.assign.size).toBe(0);
    expect(r2.groups[0].ambiguous).toEqual(['2025-01']);
  });

  it('puts 0.00 rows with their vendor, and reports periods that cannot agree', () => {
    const rows = [row('2025-01-05', 70, 'Goshen'), row('2025-01-06', 0, 'Goshen'), row('2025-02-05', 10, 'x')];
    const { assign, groups } = resolveSharedNames(rows, [month('01', 0, 70), month('02', 3, 4)], none);
    expect(assign.get(rows[0].key)).toBe(B);
    expect(assign.get(rows[1].key)).toBe(B);
    expect(assign.has(rows[2].key)).toBe(false);
    expect(groups[0].inconsistent).toEqual(['2025-02']);
  });

  it('prefers the shortest period that holds a row (months over the year)', () => {
    const rows = [row('2025-01-05', 100), row('2025-02-05', 100)];
    const year: Period = { from: '2025-01-01', to: '2025-12-31', amounts: new Map([[A, 100], [B, 100]]) };
    const { assign } = resolveSharedNames(rows, [year, month('01', 0, 100), month('02', 100, 0)], none);
    expect(rows.map((r) => assign.get(r.key))).toEqual([B, A]);
  });
});
