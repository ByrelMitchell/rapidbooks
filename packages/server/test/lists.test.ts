import { ItemInput, ItemPricesInput, NameInput, TermsInput, TxnInput, type NameKind } from '@rapidbooks/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb, seedDefaults, type DB } from '../src/db';
import { deleteAccount, listAccounts } from '../src/ledger/accounts';
import { deleteTxn, saveTxn } from '../src/ledger/posting';
import { changeItemPrices, createItem, deleteItem, getItem, listItems, updateItem } from '../src/lists/items';
import { createName, deleteName, getName, listNames, updateName } from '../src/lists/names';
import { createTerms, deleteTerms, getTerms, listTerms, updateTerms } from '../src/lists/terms';

let db: DB;
let ar: number, ap: number, sales: number, expense: number, checking: number;

const name = (kind: NameKind, n: string, extra: Partial<NameInput> = {}) =>
  createName(db, NameInput.parse({ kind, name: n, ...extra }));

const item = (n: string, extra: Partial<ItemInput> = {}) =>
  createItem(db, ItemInput.parse({ name: n, type: 'SERVICE', account_id: sales, ...extra }));

const journal = (splits: [number, number, number | null][], name_id: number | null = null) =>
  saveTxn(
    db,
    TxnInput.parse({
      type: 'GENJRNL',
      date: '2026-03-01',
      name_id,
      splits: splits.map(([account_id, amount, name_id]) => ({ account_id, amount, name_id })),
    }),
  );

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  const byName = new Map(listAccounts(db).map((a) => [a.name, a.id]));
  ar = byName.get('Accounts Receivable')!;
  ap = byName.get('Accounts Payable')!;
  sales = byName.get('Sales')!;
  expense = byName.get('Uncategorized Expenses')!;
  checking = byName.get('Checking')!;
});

describe('names', () => {
  it('lists alphabetically with jobs under their customer', () => {
    const zeta = name('customer', 'Zeta Pumps');
    const acme = name('customer', 'acme Fab');
    name('customer', 'Press Frame', { parent_id: acme });
    name('customer', 'Base Plate', { parent_id: acme });
    name('vendor', 'Steel Supply');
    expect(listNames(db, 'customer').map((n) => [n.full_name, n.depth])).toEqual([
      ['acme Fab', 0],
      ['acme Fab:Base Plate', 1],
      ['acme Fab:Press Frame', 1],
      ['Zeta Pumps', 0],
    ]);
    expect(listNames(db).map((n) => n.name)).toContain('Steel Supply');
    expect(listNames(db, 'vendor').map((n) => n.name)).toEqual(['Steel Supply']);
    expect(getName(db, zeta).kind).toBe('customer');
  });

  it('round-trips every field', () => {
    const terms = createTerms(db, TermsInput.parse({ name: 'Net 30', net_days: 30 }));
    const input = NameInput.parse({
      kind: 'employee',
      name: 'Dave Smith',
      first_name: 'Dave',
      last_name: 'Smith',
      alt_phone: '555-0101',
      account_no: 'A-1',
      credit_limit: 500000,
      terms_id: terms,
      ssn: '987-65-4321',
      hire_date: '1998-03-15',
      bill_addr: '18 Elm St\nDayton, OH 45402',
      inactive: true,
    });
    const id = createName(db, input);
    expect(getName(db, id)).toMatchObject({ ...input, id, full_name: 'Dave Smith', depth: 0, balance: 0 });
    updateName(db, id, { ...input, release_date: '2026-06-30', inactive: false });
    expect(getName(db, id)).toMatchObject({ release_date: '2026-06-30', inactive: false });
  });

  it('enforces job rules', () => {
    const cust = name('customer', 'Acme');
    const vend = name('vendor', 'Steel Supply');
    expect(() => name('vendor', 'Sub', { parent_id: cust })).toThrow(/Only a customer can have jobs/);
    expect(() => name('customer', 'Job', { parent_id: vend })).toThrow(/must belong to a customer/);
    expect(() => name('customer', 'Job', { parent_id: 9999 })).toThrow(/no longer exists/);
    const job = name('customer', 'Job', { parent_id: cust });
    expect(() => updateName(db, cust, NameInput.parse({ kind: 'customer', name: 'Acme', parent_id: job }))).toThrow(
      /cannot belong to itself/,
    );
    expect(() => updateName(db, vend, NameInput.parse({ kind: 'customer', name: 'Steel Supply' }))).toThrow(
      /Vendor list and cannot be moved/,
    );
    expect(() => NameInput.parse({ kind: 'customer', name: 'A:B' })).toThrow(/colon/);
    expect(() => NameInput.parse({ kind: 'employee', name: 'X', hire_date: '2026-02-30' })).toThrow(/valid date/);
  });

  it('keeps names unique across all lists', () => {
    name('customer', 'Acme');
    expect(() => name('vendor', 'ACME')).toThrow(/"ACME" is already in use on the Customer list/);
    const parent = name('customer', 'Beta');
    name('customer', 'Acme', { parent_id: parent }); // a job may share a name at another level
    const v = name('vendor', 'Steel');
    expect(() => updateName(db, v, NameInput.parse({ kind: 'vendor', name: 'acme' }))).toThrow(/already in use/);
  });

  it('computes A/R and A/P balances, rolling jobs into their customer', () => {
    const acme = name('customer', 'Acme');
    const job = name('customer', 'Press Frame', { parent_id: acme });
    const other = name('customer', 'Other');
    const steel = name('vendor', 'Steel');
    const emp = name('employee', 'Dave');

    journal([[ar, 10000, acme], [sales, -10000, null]]); // name on the split
    journal([[ar, 2500, null], [sales, -2500, null]], job); // name on the transaction
    journal([[checking, 1000, null], [ar, -1000, acme]]); // payment
    journal([[sales, 4000, null], [ar, -4000, null]], other); // credit
    journal([[expense, 7000, steel], [ap, -7000, steel]]);
    journal([[checking, 999, emp], [sales, -999, emp]]); // not A/R or A/P: ignored
    journal([[expense, 300, null], [ap, -300, acme]]); // A/P on a customer: not a receivable

    const bal = new Map(listNames(db).map((n) => [n.id, n.balance]));
    expect(bal.get(job)).toBe(2500);
    expect(bal.get(acme)).toBe(10000 - 1000 + 2500);
    expect(bal.get(other)).toBe(-4000);
    expect(bal.get(steel)).toBe(7000);
    expect(bal.get(emp)).toBe(0);
    expect(getName(db, acme).balance).toBe(11500);
  });

  it('refuses to delete names that are used or have jobs', () => {
    const acme = name('customer', 'Acme');
    const job = name('customer', 'Job', { parent_id: acme });
    expect(() => deleteName(db, acme)).toThrow(/has jobs/);
    const { id } = journal([[ar, 100, null], [sales, -100, null]], job);
    expect(() => deleteName(db, job)).toThrow(/Job has transactions and cannot be deleted. You can make it inactive instead./);
    deleteTxn(db, id);
    const steel = name('vendor', 'Steel');
    journal([[expense, 100, steel], [ap, -100, null]]);
    expect(() => deleteName(db, steel)).toThrow(/has transactions/);
    deleteName(db, job);
    deleteName(db, acme);
    expect(listNames(db, 'customer')).toEqual([]);
    expect(() => deleteName(db, acme)).toThrow(/no longer exists/);
  });
});

describe('terms', () => {
  it('creates, lists, updates and deletes', () => {
    const t = createTerms(db, TermsInput.parse({ name: '2% 10 Net 30', net_days: 30, discount_pct: 200, discount_days: 10 }));
    createTerms(db, TermsInput.parse({ name: 'Due on receipt' }));
    expect(listTerms(db).map((x) => x.name)).toEqual(['2% 10 Net 30', 'Due on receipt']);
    expect(getTerms(db, t)).toEqual({
      id: t, name: '2% 10 Net 30', net_days: 30, discount_pct: 200, discount_days: 10, inactive: false,
    });
    expect(() => createTerms(db, TermsInput.parse({ name: 'due ON receipt' }))).toThrow(/already terms/);
    expect(() => TermsInput.parse({ name: 'X', discount_pct: 10001 })).toThrow(/more than 100%/);
    updateTerms(db, t, TermsInput.parse({ name: '2% 10 Net 45', net_days: 45, discount_pct: 200, discount_days: 10 }));
    expect(getTerms(db, t).net_days).toBe(45);

    const cust = name('customer', 'Acme', { terms_id: t });
    expect(() => deleteTerms(db, t)).toThrow(/in use and cannot be deleted/);
    deleteName(db, cust);
    deleteTerms(db, t);
    expect(() => getTerms(db, t)).toThrow(/no longer exist/);
    expect(() => name('customer', 'Beta', { terms_id: t })).toThrow(/no longer exist/);
  });
});

describe('items', () => {
  it('changes several prices at once, or none when one cannot change', () => {
    const a = item('Machining', { rate: 6500 });
    const b = item('Bar Stock', { type: 'PART', rate: 1250 });
    const pct = item('Repeat', { type: 'DISCOUNT', rate: 1000, rate_is_percent: true });
    expect(changeItemPrices(db, ItemPricesInput.parse({ prices: [{ id: a, rate: 7000 }, { id: b, rate: 13.75 }] }))).toBe(2);
    expect([getItem(db, a).rate, getItem(db, b).rate]).toEqual([7000, 13.75]);
    expect(() => changeItemPrices(db, ItemPricesInput.parse({ prices: [{ id: a, rate: 1 }, { id: pct, rate: 5 }] }))).toThrow(
      /cannot be changed/,
    );
    expect(getItem(db, a).rate).toBe(7000);
  });

  it('lists by type with subitems under their parent', () => {
    const mach = item('Machining', { rate: 6500 });
    item('Setup', { parent_id: mach, rate: 4500 });
    item('Bar Stock', { type: 'PART', rate: 1250 });
    item('Subtotal', { type: 'SUBTOTAL', account_id: sales, rate: 99 });
    item('Repeat', { type: 'DISCOUNT', rate: 1000, rate_is_percent: true });
    item('Anodize', { rate: 2000 });
    const list = listItems(db);
    expect(list.map((i) => [i.full_name, i.depth, i.type_label])).toEqual([
      ['Anodize', 0, 'Service'],
      ['Machining', 0, 'Service'],
      ['Machining:Setup', 1, 'Service'],
      ['Bar Stock', 0, 'Non-inventory Part'],
      ['Subtotal', 0, 'Subtotal'],
      ['Repeat', 0, 'Discount'],
    ]);
    // Subtotals carry no account or rate.
    expect(list.find((i) => i.name === 'Subtotal')).toMatchObject({ account_id: null, rate: 0 });
    expect(list.find((i) => i.name === 'Repeat')).toMatchObject({ rate: 1000, rate_is_percent: true });
  });

  it('validates with friendly messages', () => {
    const mach = item('Machining');
    expect(() => item('X', { account_id: null })).toThrow(/Choose the account/);
    expect(() => item('X', { account_id: 9999 })).toThrow(/account for this item no longer exists/);
    expect(() => item('X', { account_id: ar })).toThrow(/Accounts Receivable or Accounts Payable/);
    expect(() => item('X', { type: 'PART', parent_id: mach })).toThrow(/same type as its parent/);
    expect(() => item('X', { rate_is_percent: true })).toThrow(/must be an amount/);
    expect(() => item('X', { type: 'DISCOUNT', rate: -500 })).toThrow(/positive/);
    expect(() => item('X', { type: 'DISCOUNT', rate: 10001, rate_is_percent: true })).toThrow(/more than 100%/);
    expect(() => item('machining')).toThrow(/already in use/);
    expect(() => item('X', { members: [{ item_id: mach, qty: 1 }] })).toThrow(/Only a group/);
    expect(() =>
      updateItem(db, mach, ItemInput.parse({ name: 'Machining', type: 'SERVICE', account_id: sales, parent_id: mach })),
    ).toThrow(/subitem of itself/);
  });

  it('handles groups', () => {
    const mach = item('Machining', { rate: 6500 });
    const bar = item('Bar Stock', { type: 'PART', rate: 1250 });
    const kit = item('Kit', { type: 'GROUP', members: [{ item_id: mach, qty: 2.5 }, { item_id: bar, qty: 4 }] });
    expect(getItem(db, kit).members).toEqual([
      { item_id: mach, qty: 2.5, seq: 0 },
      { item_id: bar, qty: 4, seq: 1 },
    ]);
    expect(() => item('Kit2', { type: 'GROUP', members: [{ item_id: kit, qty: 1 }] })).toThrow(/cannot contain another group/);
    expect(() => item('Kit3', { type: 'GROUP', members: [{ item_id: 999, qty: 1 }] })).toThrow(/no longer exists/);
    expect(() => updateItem(db, mach, ItemInput.parse({ name: 'Machining', type: 'GROUP' }))).toThrow(/part of a group/);

    updateItem(db, kit, ItemInput.parse({ name: 'Kit', type: 'GROUP', members: [{ item_id: bar, qty: 1 }] }));
    expect(getItem(db, kit).members).toEqual([{ item_id: bar, qty: 1, seq: 0 }]);

    expect(() => deleteItem(db, bar)).toThrow(/part of a group item/);
    deleteItem(db, kit);
    deleteItem(db, bar);
    expect(listItems(db).map((i) => i.name)).toEqual(['Machining']);
  });

  it('refuses to delete an item with subitems, or an account items post to', () => {
    const mach = item('Machining');
    const setup = item('Setup', { parent_id: mach });
    expect(() => deleteItem(db, mach)).toThrow(/has subitems/);
    expect(() => deleteAccount(db, sales)).toThrow(/Items post to this account/);
    deleteItem(db, setup);
    deleteItem(db, mach);
    expect(() => getItem(db, mach)).toThrow(/no longer exists/);
  });
});

describe('http api for lists', () => {
  it('round-trips names', async () => {
    const app = buildApp(db);
    const post = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/names', payload: { kind: 'customer', name: 'Acme' } });
    expect(post.statusCode).toBe(200);
    const { id } = post.json();
    const job = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/names', payload: { kind: 'customer', name: 'Job', parent_id: id } });
    expect(job.statusCode).toBe(200);
    const dup = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/names', payload: { kind: 'vendor', name: 'acme' } });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toMatch(/already in use/);

    const put = await app.inject({ method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/names/${id}`, payload: { kind: 'customer', name: 'Acme Fab', picks_up: true } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/names/${id}` })).json()).toMatchObject({ name: 'Acme Fab', picks_up: true });
    const list = (await app.inject({ method: 'GET', url: '/api/names?kind=customer' })).json();
    expect(list.map((n: { full_name: string }) => n.full_name)).toEqual(['Acme Fab', 'Acme Fab:Job']);
    expect((await app.inject({ method: 'GET', url: '/api/names?kind=vendor' })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/names?kind=bogus' })).statusCode).toBe(400);

    const del = await app.inject({ method: 'DELETE', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/names/${id}` });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/has jobs/);
    expect((await app.inject({ method: 'GET', url: '/api/names/9999' })).statusCode).toBe(404);
  });

  it('round-trips terms', async () => {
    const app = buildApp(db);
    const post = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/terms', payload: { name: 'Net 30', net_days: 30 } });
    const { id } = post.json();
    await app.inject({ method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/terms/${id}`, payload: { name: 'Net 30', net_days: 30, inactive: true } });
    expect((await app.inject({ method: 'GET', url: `/api/terms/${id}` })).json()).toMatchObject({ inactive: true });
    expect((await app.inject({ method: 'GET', url: '/api/terms' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/terms/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/terms' })).json()).toEqual([]);
  });

  it('round-trips items', async () => {
    const app = buildApp(db);
    const bad = await app.inject({ method: 'POST', headers: { 'x-requested-with': 'RapidBooks' }, url: '/api/items', payload: { name: 'Machining', type: 'SERVICE' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Choose the account/);
    const post = await app.inject({
      method: 'POST', headers: { 'x-requested-with': 'RapidBooks' },
      url: '/api/items',
      payload: { name: 'Machining', type: 'SERVICE', account_id: sales, rate: 6500 },
    });
    const { id } = post.json();
    await app.inject({
      method: 'PUT', headers: { 'x-requested-with': 'RapidBooks' },
      url: `/api/items/${id}`,
      payload: { name: 'Machining', type: 'SERVICE', account_id: sales, rate: 7000, description: 'Per hour' },
    });
    expect((await app.inject({ method: 'GET', url: `/api/items/${id}` })).json()).toMatchObject({
      rate: 7000,
      description: 'Per hour',
      type_label: 'Service',
      full_name: 'Machining',
    });
    expect((await app.inject({ method: 'GET', url: '/api/items' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', headers: { 'x-requested-with': 'RapidBooks' }, url: `/api/items/${id}` })).statusCode).toBe(200);
  });
});
