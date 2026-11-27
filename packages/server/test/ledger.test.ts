import { TxnInput } from '@rapidbooks/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb, seedDefaults, type DB } from '../src/db';
import { createAccount, deleteAccount, listAccounts, updateAccount } from '../src/ledger/accounts';
import { deleteTxn, getRegister, getTxn, nextNum, saveTxn, setCleared } from '../src/ledger/posting';

let db: DB;
let checking: number, sales: number, expense: number;

const journal = (splits: [number, number][], extra: Partial<TxnInput> = {}) =>
  TxnInput.parse({
    type: 'GENJRNL',
    date: '2026-01-15',
    splits: splits.map(([account_id, amount]) => ({ account_id, amount })),
    ...extra,
  });

const trialBalance = () => (db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM splits').get() as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  const byName = new Map(listAccounts(db).map((a) => [a.name, a.id]));
  checking = byName.get('Checking')!;
  sales = byName.get('Sales')!;
  expense = byName.get('Uncategorized Expenses')!;
});

describe('posting', () => {
  it('saves a balanced journal entry and reads it back', () => {
    const { id } = saveTxn(db, journal([[checking, 10000], [sales, -10000]], { num: '1', memo: 'first' }));
    const t = getTxn(db, id);
    expect(t).toMatchObject({ type: 'GENJRNL', date: '2026-01-15', num: '1', memo: 'first', version: 1 });
    expect(t.splits.map((s) => [s.account_id, s.amount])).toEqual([[checking, 10000], [sales, -10000]]);
    expect(trialBalance()).toBe(0);
  });

  it('rejects entries that do not balance, are too short, or use a missing account', () => {
    expect(() => saveTxn(db, journal([[checking, 10000], [sales, -9999]]))).toThrow(/not in balance/);
    expect(() => saveTxn(db, journal([[checking, 0]]))).toThrow(/at least two/);
    expect(() => saveTxn(db, journal([[checking, 500], [99999, -500]]))).toThrow(/no longer exists/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM txns').get()).toEqual({ n: 0 });
  });

  it('replaces splits on edit, bumps the version, and stays balanced', () => {
    const { id } = saveTxn(db, journal([[checking, 10000], [sales, -10000]]));
    const r = saveTxn(db, journal([[checking, 7000], [expense, 3000], [sales, -10000]], { version: 1 }), id);
    expect(r.version).toBe(2);
    expect(getTxn(db, id).splits).toHaveLength(3);
    expect(trialBalance()).toBe(0);
  });

  it('refuses a stale edit', () => {
    const { id } = saveTxn(db, journal([[checking, 10000], [sales, -10000]]));
    saveTxn(db, journal([[checking, 500], [sales, -500]], { version: 1 }), id);
    expect(() => saveTxn(db, journal([[checking, 900], [sales, -900]], { version: 1 }), id)).toThrow(
      /changed in another window/,
    );
    expect(getTxn(db, id).splits[0].amount).toBe(500);
  });

  it('keeps the cleared mark on unchanged lines only', () => {
    const { id } = saveTxn(db, journal([[checking, 10000], [sales, -10000]]));
    for (const s of getTxn(db, id).splits) setCleared(db, s.id, true);
    saveTxn(db, journal([[checking, 10000], [expense, -10000]], { version: 1 }), id);
    expect(getTxn(db, id).splits.map((s) => s.cleared)).toEqual([true, false]);
  });

  it('deletes a transaction with its splits and logs it', () => {
    const { id } = saveTxn(db, journal([[checking, 10000], [sales, -10000]]));
    deleteTxn(db, id);
    expect(() => getTxn(db, id)).toThrow(/no longer exists/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM splits').get()).toEqual({ n: 0 });
    const log = db.prepare('SELECT action FROM audit_log ORDER BY id').all();
    expect(log).toEqual([{ action: 'create' }, { action: 'delete' }]);
  });

  it('numbers entries one past the highest in use', () => {
    expect(nextNum(db, 'GENJRNL')).toBe('1');
    saveTxn(db, journal([[checking, 100], [sales, -100]], { num: '41' }));
    saveTxn(db, journal([[checking, 100], [sales, -100]], { num: 'ADJ' }));
    expect(nextNum(db, 'GENJRNL')).toBe('42');
  });
});

describe('register', () => {
  it('lists splits oldest first with a running balance and the other account', () => {
    saveTxn(db, journal([[checking, 10000], [sales, -10000]], { date: '2026-02-01' }));
    saveTxn(db, journal([[expense, 2500], [checking, -2500]], { date: '2026-01-10' }));
    saveTxn(db, journal([[checking, 300], [sales, -200], [expense, -100]], { date: '2026-03-01' }));
    const rows = getRegister(db, checking);
    expect(rows.map((r) => [r.date, r.amount, r.balance, r.other_account_id])).toEqual([
      ['2026-01-10', -2500, -2500, expense],
      ['2026-02-01', 10000, 7500, sales],
      ['2026-03-01', 300, 7800, null],
    ]);
  });
});

describe('accounts', () => {
  it('lists in chart order with sub-accounts and balances', () => {
    const sub = createAccount(db, { name: 'Payroll', type: 'BANK', parent_id: checking, description: '', inactive: false });
    saveTxn(db, journal([[sub, 4200], [sales, -4200]]));
    const list = listAccounts(db);
    expect(list.slice(0, 3).map((a) => [a.full_name, a.depth])).toEqual([
      ['Checking', 0],
      ['Checking:Payroll', 1],
      ['Accounts Receivable', 0],
    ]);
    expect(list.find((a) => a.id === sub)!.balance).toBe(4200);
    expect(list.find((a) => a.id === sales)!.balance).toBe(-4200);
  });

  it('enforces naming and parent rules', () => {
    const base = { description: '', inactive: false, parent_id: null };
    expect(() => createAccount(db, { ...base, name: 'checking', type: 'BANK' })).toThrow(/already in use/);
    expect(() => createAccount(db, { ...base, name: 'Sub', type: 'EXP', parent_id: checking })).toThrow(/same type/);
    expect(() => updateAccount(db, checking, { ...base, name: 'Checking', type: 'BANK', parent_id: checking })).toThrow(
      /subaccount of itself/,
    );
  });

  it('will not delete accounts that are in use, have subaccounts, or are system accounts', () => {
    saveTxn(db, journal([[checking, 100], [sales, -100]]));
    expect(() => deleteAccount(db, checking)).toThrow(/has transactions/);
    const ar = listAccounts(db).find((a) => a.system_role === 'AR')!;
    expect(() => deleteAccount(db, ar.id)).toThrow(/cannot be deleted/);
    createAccount(db, { name: 'Shop', type: 'EXP', parent_id: expense, description: '', inactive: false });
    expect(() => deleteAccount(db, expense)).toThrow(/subaccounts/);
  });
});

describe('http api', () => {
  it('round-trips a journal entry and reports errors as messages', async () => {
    const app = buildApp(db);
    const bad = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/txns',
      payload: { type: 'GENJRNL', date: '2026-02-30', splits: [] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/valid date/);

    const res = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/txns',
      payload: journal([[checking, 1234], [sales, -1234]]),
    });
    expect(res.statusCode).toBe(200);
    const reg = await app.inject({ method: 'GET', url: `/api/accounts/${checking}/register` });
    expect(reg.json()).toHaveLength(1);
    expect(reg.json()[0].balance).toBe(1234);

    const put = await app.inject({ method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/company', payload: { name: 'Acme Machine' } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/company' })).json()).toEqual({ name: 'Acme Machine' });
  });
});
