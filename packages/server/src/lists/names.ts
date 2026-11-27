import { NAME_KINDS, type Name, type NameInput, type NameKind } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

// Customers (and their jobs), vendors, employees and other names. They share one
// table and one name space, as in QuickBooks.

interface NameRow extends Omit<Name, 'full_name' | 'depth' | 'balance' | 'picks_up' | 'is_1099' | 'inactive'> {
  picks_up: number;
  is_1099: number;
  inactive: number;
}

const COLUMNS = [
  'kind', 'name', 'parent_id', 'company', 'salutation', 'first_name', 'middle_init', 'last_name',
  'contact', 'alt_contact', 'phone', 'alt_phone', 'fax', 'email', 'bill_addr', 'ship_addr', 'notes',
  'account_no', 'terms_id', 'credit_limit', 'picks_up', 'print_as', 'tax_id', 'is_1099', 'ssn',
  'hire_date', 'release_date', 'inactive', 'job_title', 'mobile', 'cc_email', 'website', 'other_contact',
] as const;

const kindLabel = (kind: string) => NAME_KINDS.find((k) => k.code === kind)?.label ?? 'Name';

/** Open A/R (customers) or A/P (vendors) per name id, before rolling jobs up into customers. */
function ownBalances(db: DB): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(s.name_id, t.name_id) AS name_id, a.type, SUM(s.amount) AS total
         FROM splits s
         JOIN txns t ON t.id = s.txn_id
         JOIN accounts a ON a.id = s.account_id
        WHERE a.type IN ('AR', 'AP') AND COALESCE(s.name_id, t.name_id) IS NOT NULL
        GROUP BY 1, 2`,
    )
    .all() as { name_id: number; type: 'AR' | 'AP'; total: number }[];
  const kinds = new Map(
    (db.prepare('SELECT id, kind FROM names').all() as { id: number; kind: string }[]).map((r) => [r.id, r.kind]),
  );
  const out = new Map<number, number>();
  for (const r of rows) {
    const kind = kinds.get(r.name_id);
    if (kind === 'customer' && r.type === 'AR') out.set(r.name_id, (out.get(r.name_id) ?? 0) + r.total);
    if (kind === 'vendor' && r.type === 'AP') out.set(r.name_id, (out.get(r.name_id) ?? 0) - r.total);
  }
  return out;
}

/** Names in list order (alphabetical, jobs under their customer), optionally of one kind. */
export function listNames(db: DB, kind?: NameKind): Name[] {
  const rows = (
    kind
      ? db.prepare('SELECT * FROM names WHERE kind = ?').all(kind)
      : db.prepare('SELECT * FROM names').all()
  ) as NameRow[];
  const own = ownBalances(db);

  const children = new Map<number | null, NameRow[]>();
  for (const r of rows) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r);
    children.set(r.parent_id, list);
  }
  const byName = (a: NameRow, b: NameRow) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

  const out: Name[] = [];
  // Returns the balance of r including its jobs.
  const walk = (r: NameRow, depth: number, prefix: string): number => {
    const full_name = prefix ? `${prefix}:${r.name}` : r.name;
    const entry: Name = {
      ...r,
      picks_up: !!r.picks_up,
      is_1099: !!r.is_1099,
      inactive: !!r.inactive,
      full_name,
      depth,
      balance: own.get(r.id) ?? 0,
    };
    out.push(entry);
    for (const c of (children.get(r.id) ?? []).sort(byName)) entry.balance += walk(c, depth + 1, full_name);
    return entry.balance;
  };
  for (const r of (children.get(null) ?? []).sort(byName)) walk(r, 0, '');
  return out;
}

export function getName(db: DB, id: number): Name {
  const n = listNames(db).find((x) => x.id === id);
  if (!n) throw new AppError(404, 'That name no longer exists.');
  return n;
}

function getRow(db: DB, id: number): NameRow {
  const row = db.prepare('SELECT * FROM names WHERE id = ?').get(id) as NameRow | undefined;
  if (!row) throw new AppError(404, 'That name no longer exists.');
  return row;
}

function check(db: DB, input: NameInput, selfId: number | null) {
  if (input.parent_id !== null) {
    if (input.kind !== 'customer') throw new AppError(400, 'Only a customer can have jobs.');
    let p: number | null = input.parent_id;
    const parent = db.prepare('SELECT kind FROM names WHERE id = ?').get(p) as { kind: string } | undefined;
    if (!parent) throw new AppError(400, 'The customer for this job no longer exists.');
    if (parent.kind !== 'customer') throw new AppError(400, 'A job must belong to a customer.');
    while (p !== null) {
      if (p === selfId) throw new AppError(400, 'A job cannot belong to itself.');
      p = getRow(db, p).parent_id;
    }
  }
  if (input.terms_id !== null && !db.prepare('SELECT 1 FROM terms WHERE id = ?').get(input.terms_id)) {
    throw new AppError(400, 'Those terms no longer exist.');
  }
}

function nameTaken(db: DB, input: NameInput, e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
    const other = db
      .prepare('SELECT kind FROM names WHERE COALESCE(parent_id, 0) = ? AND name = ? COLLATE NOCASE')
      .get(input.parent_id ?? 0, input.name) as { kind: string } | undefined;
    const where = other ? ` on the ${kindLabel(other.kind)} list` : '';
    throw new AppError(400, `The name "${input.name}" is already in use${where}. Names must be unique across customers, vendors, employees and other names.`);
  }
  throw e;
}

function values(input: NameInput) {
  return COLUMNS.map((c) => {
    const v = input[c];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
}

export function createName(db: DB, input: NameInput): number {
  check(db, input, null);
  try {
    const r = db
      .prepare(`INSERT INTO names (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`)
      .run(...values(input));
    return Number(r.lastInsertRowid);
  } catch (e) {
    nameTaken(db, input, e);
  }
}

export function updateName(db: DB, id: number, input: NameInput) {
  const old = getRow(db, id);
  if (old.kind !== input.kind) {
    throw new AppError(400, `This name is on the ${kindLabel(old.kind)} list and cannot be moved to another list.`);
  }
  check(db, input, id);
  try {
    db.prepare(`UPDATE names SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values(input), id);
  } catch (e) {
    nameTaken(db, input, e);
  }
}

export function deleteName(db: DB, id: number) {
  const row = getRow(db, id);
  const used = db
    .prepare(
      // lines: a Customer:Job on a purchase order line, which posts no splits.
      `SELECT EXISTS (SELECT 1 FROM txns WHERE name_id = ?) OR EXISTS (SELECT 1 FROM splits WHERE name_id = ?)
              OR EXISTS (SELECT 1 FROM lines WHERE name_id = ?) AS used`,
    )
    .get(id, id, id) as { used: number };
  if (used.used) {
    throw new AppError(400, `${row.name} has transactions and cannot be deleted. You can make it inactive instead.`);
  }
  const jobs = db.prepare('SELECT COUNT(*) AS n FROM names WHERE parent_id = ?').get(id) as { n: number };
  if (jobs.n > 0) throw new AppError(400, `${row.name} has jobs and cannot be deleted. Delete the jobs first.`);
  db.prepare('DELETE FROM names WHERE id = ?').run(id);
}
