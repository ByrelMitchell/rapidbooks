import type { Terms, TermsInput } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';

type TermsRow = Omit<Terms, 'inactive'> & { inactive: number };

const toTerms = (r: TermsRow): Terms => ({ ...r, inactive: !!r.inactive });

export function listTerms(db: DB): Terms[] {
  const rows = db.prepare('SELECT * FROM terms').all() as TermsRow[];
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map(toTerms);
}

export function getTerms(db: DB, id: number): Terms {
  const row = db.prepare('SELECT * FROM terms WHERE id = ?').get(id) as TermsRow | undefined;
  if (!row) throw new AppError(404, 'Those terms no longer exist.');
  return toTerms(row);
}

function nameTaken(e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
    throw new AppError(400, 'There are already terms with that name.');
  }
  throw e;
}

function values(input: TermsInput) {
  return [input.name, input.net_days, input.discount_pct, input.discount_days, input.inactive ? 1 : 0];
}

export function createTerms(db: DB, input: TermsInput): number {
  try {
    const r = db
      .prepare('INSERT INTO terms (name, net_days, discount_pct, discount_days, inactive) VALUES (?, ?, ?, ?, ?)')
      .run(...values(input));
    return Number(r.lastInsertRowid);
  } catch (e) {
    nameTaken(e);
  }
}

export function updateTerms(db: DB, id: number, input: TermsInput) {
  getTerms(db, id);
  try {
    db.prepare(
      'UPDATE terms SET name = ?, net_days = ?, discount_pct = ?, discount_days = ?, inactive = ? WHERE id = ?',
    ).run(...values(input), id);
  } catch (e) {
    nameTaken(e);
  }
}

export function deleteTerms(db: DB, id: number) {
  const t = getTerms(db, id);
  const used = db
    .prepare('SELECT (SELECT COUNT(*) FROM names WHERE terms_id = ?) + (SELECT COUNT(*) FROM txns WHERE terms_id = ?) AS n')
    .get(id, id) as { n: number };
  if (used.n > 0) {
    throw new AppError(400, `The terms "${t.name}" are in use and cannot be deleted. You can make them inactive instead.`);
  }
  db.prepare('DELETE FROM terms WHERE id = ?').run(id);
}
