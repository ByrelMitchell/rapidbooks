import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db';
import { buildDemo, type DemoSummary } from '../src/demo/build';
import { poReceived } from '../src/ledger/purchasing';
import { REPORTS, runReport } from '../src/reports/registry';

const THROUGH = '2026-11-11';
let db: DB;
let summary: DemoSummary;
const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;

beforeAll(() => {
  db = openDb(':memory:');
  summary = buildDemo(db, { through: THROUGH });
}, 60_000);

describe('the demo company', () => {
  it('covers every kind of transaction over almost two years', () => {
    expect(summary.from).toBe('2025-01-01');
    for (const t of ['INVOICE', 'CREDITMEMO', 'PAYMENT', 'DEPOSIT', 'PURCHORD', 'BILL', 'BILLCREDIT', 'BILLPMT', 'CHECK', 'TRANSFER', 'PAYCHECK', 'GENJRNL']) {
      expect(summary.txns[t], t).toBeGreaterThan(0);
    }
    expect(summary.txns.INVOICE).toBeGreaterThan(500);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM txns WHERE is_finance_charge = 1").n).toBeGreaterThan(0);
    expect(one<{ d: string }>('SELECT MAX(date) AS d FROM txns').d).toBe(THROUGH);
  });

  it('balances, with A/R and A/P left open and the bank above zero', () => {
    expect(one<{ n: number }>('SELECT SUM(amount) AS n FROM splits').n).toBe(0);
    const bal = (role: string) => one<{ b: number }>('SELECT SUM(s.amount) AS b FROM splits s JOIN accounts a ON a.id = s.account_id WHERE a.system_role = ?', role).b;
    expect(bal('AR')).toBeGreaterThan(0);
    expect(bal('AP')).toBeLessThan(0);
    const checking = one<{ b: number }>("SELECT SUM(s.amount) AS b FROM splits s JOIN accounts a ON a.id = s.account_id WHERE a.name LIKE 'Checking%'").b;
    expect(checking).toBeGreaterThan(0);
  });

  it('receives purchase orders line by line, leaving a partly received one open', () => {
    const pos = db.prepare("SELECT id, closed FROM txns WHERE type = 'PURCHORD'").all() as { id: number; closed: number }[];
    const got = pos.map((p) => ({ ...p, r: poReceived(db, p.id) }));
    // Every bill line from a P.O. points at the P.O. line it receives.
    expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM lines WHERE po_txn_id IS NOT NULL').n).toBeGreaterThan(0);
    // Short shipments filled later by a second bill against the same P.O.
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT to_txn FROM links WHERE kind = 'po' GROUP BY to_txn HAVING COUNT(*) > 1)").n).toBeGreaterThan(0);
    const partly = got.filter((p) => p.r.amount > 0 && !p.r.full);
    expect(partly.length).toBeGreaterThan(0);
    for (const p of partly) expect(p.closed).toBe(0);
    for (const p of got.filter((g) => g.r.full)) expect(p.closed).toBe(1);
  });

  it('is the same file every time for the same date', () => {
    const again = openDb(':memory:');
    const s2 = buildDemo(again, { through: THROUGH });
    expect(s2).toEqual(summary);
    const sum = (d: DB) => (d.prepare('SELECT SUM(ABS(amount) * id) AS n FROM splits').get() as { n: number }).n;
    expect(sum(again)).toBe(sum(db));
  }, 60_000);

  it('refuses a company file that already has data', () => {
    expect(() => buildDemo(db, { through: THROUGH })).toThrow(/empty/);
  });

  it('runs every report', () => {
    const checking = one<{ id: number }>("SELECT id FROM accounts WHERE name LIKE 'Checking%'").id;
    for (const r of REPORTS) {
      const out = runReport(db, r.id, { today: THROUGH, from: '2025-01-01', to: THROUGH, account_id: String(checking) });
      expect(out.rows.length, r.id).toBeGreaterThanOrEqual(0);
    }
  });
});
