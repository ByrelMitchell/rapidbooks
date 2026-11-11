import type { RegisterRow, Split, Txn, TxnInput } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

// The posting engine. Every transaction type has a builder that turns the form's
// input into ledger splits; saveTxn checks they balance and writes them. Nothing
// else writes to the splits table.

interface BuiltSplit {
  account_id: number;
  amount: number; // cents, debit-positive
  name_id: number | null;
  memo: string;
}

type Builder = (input: TxnInput) => BuiltSplit[];

const builders: Record<TxnInput['type'], Builder> = {
  GENJRNL: (input) => input.splits.map((s) => ({ ...s })),
};

function validate(db: DB, splits: BuiltSplit[]) {
  if (splits.length < 2) throw new AppError(400, 'A transaction needs at least two lines.');
  const sum = splits.reduce((t, s) => t + s.amount, 0);
  if (sum !== 0) {
    throw new AppError(400, 'The transaction is not in balance. Make sure the debits equal the credits.');
  }
  const exists = db.prepare('SELECT 1 FROM accounts WHERE id = ?');
  for (const s of splits) {
    if (!exists.get(s.account_id)) throw new AppError(400, 'One of the accounts on this transaction no longer exists.');
  }
}

/** Create a transaction (no id) or replace an existing one (id given; input.version must match). */
export function saveTxn(db: DB, input: TxnInput, id?: number): { id: number; version: number } {
  const splits = builders[input.type](input);
  validate(db, splits);

  return db.transaction(() => {
    let version = 1;
    let oldSplits: { seq: number; account_id: number; amount: number; cleared: number }[] = [];
    let txnId: number;

    if (id === undefined) {
      const r = db
        .prepare('INSERT INTO txns (type, date, num, name_id, memo) VALUES (?, ?, ?, ?, ?)')
        .run(input.type, input.date, input.num, input.name_id, input.memo);
      txnId = Number(r.lastInsertRowid);
    } else {
      const old = db.prepare('SELECT type, version FROM txns WHERE id = ?').get(id) as
        | { type: string; version: number }
        | undefined;
      if (!old) throw new AppError(404, 'That transaction no longer exists.');
      if (old.type !== input.type) throw new AppError(400, 'The type of a transaction cannot be changed.');
      if (input.version !== old.version) {
        throw new AppError(409, 'This transaction was changed in another window. Reopen it and try again.');
      }
      version = old.version + 1;
      txnId = id;
      oldSplits = db
        .prepare('SELECT seq, account_id, amount, cleared FROM splits WHERE txn_id = ?')
        .all(id) as typeof oldSplits;
      db.prepare(
        "UPDATE txns SET date = ?, num = ?, name_id = ?, memo = ?, version = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(input.date, input.num, input.name_id, input.memo, version, id);
      db.prepare('DELETE FROM splits WHERE txn_id = ?').run(id);
    }

    const ins = db.prepare(
      'INSERT INTO splits (txn_id, seq, account_id, amount, name_id, memo, cleared) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    splits.forEach((s, seq) => {
      // A line that still has the same account and amount keeps its cleared mark.
      const was = oldSplits.find((o) => o.seq === seq);
      const cleared = was && was.account_id === s.account_id && was.amount === s.amount ? was.cleared : 0;
      ins.run(txnId, seq, s.account_id, s.amount, s.name_id, s.memo, cleared);
    });

    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
      id === undefined ? 'create' : 'update',
      txnId,
      JSON.stringify(input),
    );
    return { id: txnId, version };
  })();
}

export function getTxn(db: DB, id: number): Txn {
  const t = db.prepare('SELECT id, type, date, num, name_id, memo, version FROM txns WHERE id = ?').get(id) as
    | Omit<Txn, 'splits'>
    | undefined;
  if (!t) throw new AppError(404, 'That transaction no longer exists.');
  const splits = (
    db
      .prepare('SELECT id, seq, account_id, amount, name_id, memo, cleared FROM splits WHERE txn_id = ? ORDER BY seq')
      .all(id) as (Omit<Split, 'cleared'> & { cleared: number })[]
  ).map((s) => ({ ...s, cleared: !!s.cleared }));
  return { ...t, splits };
}

export function deleteTxn(db: DB, id: number) {
  db.transaction(() => {
    const before = getTxn(db, id);
    db.prepare('DELETE FROM txns WHERE id = ?').run(id);
    db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
      'delete',
      id,
      JSON.stringify(before),
    );
  })();
}

export function setCleared(db: DB, splitId: number, cleared: boolean) {
  const r = db.prepare('UPDATE splits SET cleared = ? WHERE id = ?').run(cleared ? 1 : 0, splitId);
  if (r.changes === 0) throw new AppError(404, 'That transaction no longer exists.');
}

/** The next number for a transaction type: one more than the highest numeric number in use. */
export function nextNum(db: DB, type: string): string {
  const r = db
    .prepare("SELECT MAX(CAST(num AS INTEGER)) AS n FROM txns WHERE type = ? AND num GLOB '[0-9]*'")
    .get(type) as { n: number | null };
  return String((r.n ?? 0) + 1);
}

/** Every split posted to an account, oldest first, with a running balance. */
export function getRegister(db: DB, accountId: number): RegisterRow[] {
  const rows = db
    .prepare(
      `SELECT s.id AS split_id, t.id AS txn_id, t.date, t.num, t.type,
              n.name AS name,
              CASE WHEN s.memo <> '' THEN s.memo ELSE t.memo END AS memo,
              s.amount, s.cleared,
              (SELECT COUNT(*) FROM splits o WHERE o.txn_id = t.id) AS n_splits,
              (SELECT o.account_id FROM splits o WHERE o.txn_id = t.id AND o.id <> s.id ORDER BY o.seq LIMIT 1) AS other
         FROM splits s
         JOIN txns t ON t.id = s.txn_id
         LEFT JOIN names n ON n.id = COALESCE(s.name_id, t.name_id)
        WHERE s.account_id = ?
        ORDER BY t.date, t.id, s.seq`,
    )
    .all(accountId) as (Omit<RegisterRow, 'cleared' | 'balance' | 'other_account_id'> & {
    cleared: number;
    n_splits: number;
    other: number | null;
  })[];

  let balance = 0;
  return rows.map(({ n_splits, other, cleared, ...r }) => {
    balance += r.amount;
    return { ...r, cleared: !!cleared, other_account_id: n_splits === 2 ? other : null, balance };
  });
}
