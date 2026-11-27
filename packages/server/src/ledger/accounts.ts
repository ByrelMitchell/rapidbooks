import { ACCOUNT_TYPES, type Account, type AccountInput } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

interface AccountRow {
  id: number;
  name: string;
  type: Account['type'];
  parent_id: number | null;
  description: string;
  inactive: number;
  system_role: string | null;
  balance: number;
}

/** All accounts in chart-of-accounts order (by type, sub-accounts under their parent). */
export function listAccounts(db: DB): Account[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.type, a.parent_id, a.description, a.inactive, a.system_role,
              COALESCE((SELECT SUM(amount) FROM splits s WHERE s.account_id = a.id), 0) AS balance
         FROM accounts a`,
    )
    .all() as AccountRow[];

  const typeOrder = new Map<string, number>(ACCOUNT_TYPES.map((t, i) => [t.code, i]));
  const children = new Map<number | null, AccountRow[]>();
  for (const r of rows) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r);
    children.set(r.parent_id, list);
  }
  const byName = (a: AccountRow, b: AccountRow) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

  const out: Account[] = [];
  const walk = (r: AccountRow, depth: number, prefix: string) => {
    const full_name = prefix ? `${prefix}:${r.name}` : r.name;
    out.push({ ...r, inactive: !!r.inactive, depth, full_name });
    for (const c of (children.get(r.id) ?? []).sort(byName)) walk(c, depth + 1, full_name);
  };
  const roots = (children.get(null) ?? []).sort(
    (a, b) => typeOrder.get(a.type)! - typeOrder.get(b.type)! || byName(a, b),
  );
  for (const r of roots) walk(r, 0, '');
  return out;
}

function getRow(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | (Omit<AccountRow, 'balance'>)
    | undefined;
  if (!row) throw new AppError(404, 'That account no longer exists.');
  return row;
}

function checkParent(db: DB, input: AccountInput, selfId: number | null) {
  if (input.parent_id === null) return;
  let p: number | null = input.parent_id;
  const first = getRow(db, p);
  if (first.type !== input.type) {
    throw new AppError(400, 'A subaccount must be the same type as its parent account.');
  }
  while (p !== null) {
    if (p === selfId) throw new AppError(400, 'An account cannot be a subaccount of itself.');
    p = getRow(db, p).parent_id;
  }
}

function nameTaken(e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
    throw new AppError(400, 'That account name is already in use.');
  }
  throw e;
}

export function createAccount(db: DB, input: AccountInput): number {
  checkParent(db, input, null);
  try {
    const r = db
      .prepare('INSERT INTO accounts (name, type, parent_id, description, inactive) VALUES (?, ?, ?, ?, ?)')
      .run(input.name, input.type, input.parent_id, input.description, input.inactive ? 1 : 0);
    return Number(r.lastInsertRowid);
  } catch (e) {
    nameTaken(e);
  }
}

const count = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

/** Whether the finance-charge preferences post to this account. */
const isFinanceChargeAccount = (db: DB, id: number) =>
  count(db, "SELECT COUNT(*) AS n FROM company WHERE key = 'fc_account_id' AND value = ?", String(id)) > 0;

/**
 * Why an account in use cannot become, or stop being, Accounts Receivable or Accounts
 * Payable (as in QuickBooks): its transactions, documents, items or preferences assume
 * its type. Null when nothing uses it.
 */
function receivablePayableUse(db: DB, id: number): string | null {
  if (count(db, 'SELECT COUNT(*) AS n FROM splits WHERE account_id = ?', id) > 0) return 'it has transactions';
  if (count(db, 'SELECT COUNT(*) AS n FROM txns WHERE ar_account_id = ? OR ap_account_id = ? OR account_id = ?', id, id, id) > 0) {
    return 'transactions use it';
  }
  if (count(db, 'SELECT COUNT(*) AS n FROM items WHERE account_id = ? OR purchase_account_id = ?', id, id) > 0) return 'items post to it';
  if (count(db, 'SELECT COUNT(*) AS n FROM payroll_items WHERE expense_account_id = ? OR liability_account_id = ?', id, id) > 0) {
    return 'payroll items post to it';
  }
  if (isFinanceChargeAccount(db, id)) return 'finance charges post to it';
  return null;
}

export function updateAccount(db: DB, id: number, input: AccountInput) {
  const old = getRow(db, id);
  checkParent(db, input, id);
  if (old.type !== input.type) {
    if (old.system_role) throw new AppError(400, 'The type of this account cannot be changed.');
    const kids = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?').get(id) as { n: number };
    if (kids.n > 0) throw new AppError(400, 'Change the type of the subaccounts first.');
    const arAp = (t: string) => t === 'AR' || t === 'AP';
    if (arAp(old.type) || arAp(input.type)) {
      const why = receivablePayableUse(db, id);
      if (why) {
        const label = (t: string) => (t === 'AR' ? 'Accounts Receivable' : t === 'AP' ? 'Accounts Payable' : null);
        const what = label(arAp(old.type) ? old.type : input.type)!;
        throw new AppError(
          400,
          arAp(old.type)
            ? `This ${what} account cannot be changed to another type, because ${why}.`
            : `This account cannot be changed to ${what}, because ${why}.`,
        );
      }
    }
  }
  try {
    db.prepare('UPDATE accounts SET name = ?, type = ?, parent_id = ?, description = ?, inactive = ? WHERE id = ?').run(
      input.name,
      input.type,
      input.parent_id,
      input.description,
      input.inactive ? 1 : 0,
      id,
    );
  } catch (e) {
    nameTaken(e);
  }
}

export function deleteAccount(db: DB, id: number) {
  const row = getRow(db, id);
  if (row.system_role) throw new AppError(400, 'RapidBooks needs this account; it cannot be deleted.');
  const used = db.prepare('SELECT COUNT(*) AS n FROM splits WHERE account_id = ?').get(id) as { n: number };
  if (used.n > 0) {
    throw new AppError(400, 'This account has transactions and cannot be deleted. You can make it inactive instead.');
  }
  const kids = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?').get(id) as { n: number };
  if (kids.n > 0) throw new AppError(400, 'This account has subaccounts and cannot be deleted.');
  const items = db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE account_id = ? OR purchase_account_id = ?')
    .get(id, id) as { n: number };
  if (items.n > 0) {
    throw new AppError(400, 'Items post to this account, so it cannot be deleted. Change those items first.');
  }
  const payroll = db
    .prepare('SELECT COUNT(*) AS n FROM payroll_items WHERE expense_account_id = ? OR liability_account_id = ?')
    .get(id, id) as { n: number };
  if (payroll.n > 0) {
    throw new AppError(400, 'Payroll items post to this account, so it cannot be deleted. Change those payroll items first.');
  }
  if (isFinanceChargeAccount(db, id)) {
    throw new AppError(
      400,
      'Finance charges post to this account, so it cannot be deleted. Choose another account in Finance Charge Settings (in Assess Finance Charges) first.',
    );
  }
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}
