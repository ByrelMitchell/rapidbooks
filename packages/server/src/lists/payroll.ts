import { PAYROLL_ITEM_KINDS, type PayrollItem, type PayrollItemInput } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

// Payroll items for manual paychecks: earnings, deductions and company contributions,
// each with the accounts it posts to. There are no tax tables; she types every amount.

type Row = Omit<PayrollItem, 'inactive' | 'kind_label'> & { inactive: number };

const kindInfo = (kind: string) => PAYROLL_ITEM_KINDS.find((k) => k.code === kind)!;
const toItem = (r: Row): PayrollItem => ({ ...r, inactive: !!r.inactive, kind_label: kindInfo(r.kind).label });

/** In list order: earnings, deductions, company contributions; by name within each. */
export function listPayrollItems(db: DB): PayrollItem[] {
  const order = new Map<string, number>(PAYROLL_ITEM_KINDS.map((k, i) => [k.code, i]));
  const rows = db.prepare('SELECT * FROM payroll_items').all() as Row[];
  return rows
    .sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map(toItem);
}

export function getPayrollItem(db: DB, id: number): PayrollItem {
  const r = db.prepare('SELECT * FROM payroll_items WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new AppError(404, 'That payroll item no longer exists.');
  return toItem(r);
}

function normalize(db: DB, input: PayrollItemInput): PayrollItemInput {
  const k = kindInfo(input.kind);
  const out = { ...input };
  const check = (id: number | null, what: string) => {
    if (id === null) throw new AppError(400, `Choose the ${what} account for this ${k.label.toLowerCase()} item.`);
    const a = db.prepare('SELECT type FROM accounts WHERE id = ?').get(id) as { type: string } | undefined;
    if (!a) throw new AppError(400, `The ${what} account for this payroll item no longer exists.`);
    if (a.type === 'AR' || a.type === 'AP') {
      throw new AppError(400, 'A payroll item cannot post to an Accounts Receivable or Accounts Payable account.');
    }
  };
  if (k.needsExpense) check(input.expense_account_id, 'expense');
  else out.expense_account_id = null;
  if (k.needsLiability) check(input.liability_account_id, 'liability');
  else out.liability_account_id = null;
  return out;
}

function nameTaken(e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
    throw new AppError(400, 'There is already a payroll item with that name.');
  }
  throw e;
}

const values = (i: PayrollItemInput) => [i.name, i.kind, i.expense_account_id, i.liability_account_id, i.inactive ? 1 : 0];

export function createPayrollItem(db: DB, input: PayrollItemInput): number {
  const item = normalize(db, input);
  try {
    const r = db
      .prepare('INSERT INTO payroll_items (name, kind, expense_account_id, liability_account_id, inactive) VALUES (?, ?, ?, ?, ?)')
      .run(...values(item));
    return Number(r.lastInsertRowid);
  } catch (e) {
    nameTaken(e);
  }
}

const used = (db: DB, id: number) => !!db.prepare('SELECT 1 FROM lines WHERE payroll_item_id = ? LIMIT 1').get(id);

export function updatePayrollItem(db: DB, id: number, input: PayrollItemInput) {
  const old = getPayrollItem(db, id);
  const item = normalize(db, input);
  if (old.kind !== item.kind && used(db, id)) {
    throw new AppError(400, `${old.name} has been used on paychecks, so whether it is an earning, deduction or company contribution cannot be changed.`);
  }
  try {
    db.prepare('UPDATE payroll_items SET name = ?, kind = ?, expense_account_id = ?, liability_account_id = ?, inactive = ? WHERE id = ?').run(
      ...values(item),
      id,
    );
  } catch (e) {
    nameTaken(e);
  }
}

export function deletePayrollItem(db: DB, id: number) {
  const item = getPayrollItem(db, id);
  if (used(db, id)) {
    throw new AppError(400, `${item.name} has been used on paychecks and cannot be deleted. You can make it inactive instead.`);
  }
  db.prepare('DELETE FROM payroll_items WHERE id = ?').run(id);
}
