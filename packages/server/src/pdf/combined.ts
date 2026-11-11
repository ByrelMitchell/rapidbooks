import type { DB } from '../db';
import { AppError } from '../errors';
import { drawCheckRecord, isPurchasePrintable, loadPurchasePrintable } from './check';
import { drawSalesDoc, loadSalesDoc } from './invoice';
import { combinedDoc } from './layout';
import { drawPurchaseOrder } from './purchase';
import { drawStatement } from './statement';

// Several documents in one PDF, each starting on a new page with its own page numbers.

/** Statements for several customers, in the order given. */
export function renderStatementsPdf(db: DB, customerIds: number[], from: string, to: string): Promise<Buffer> {
  if (customerIds.length === 0) throw new AppError(400, 'Choose at least one customer.');
  return combinedDoc('Statements', customerIds.length, (doc, i, start) => {
    drawStatement(db, customerIds[i], from, to, { doc, start });
  });
}

/** Invoices, credit memos, purchase orders and check records, in the order given. */
export function renderTxnsPdf(db: DB, ids: number[]): Promise<Buffer> {
  if (ids.length === 0) throw new AppError(400, 'Choose at least one form to print.');
  // Load (and so check) them all before drawing anything.
  const docs = ids.map((id) => {
    const type = (db.prepare('SELECT type FROM txns WHERE id = ?').get(id) as { type: string } | undefined)?.type;
    if (!type) throw new AppError(404, 'One of those transactions no longer exists.');
    if (isPurchasePrintable(type)) return { id, purch: loadPurchasePrintable(db, id) };
    loadSalesDoc(db, id);
    return { id, purch: null };
  });
  return combinedDoc('Forms', docs.length, (doc, i, start) => {
    const d = docs[i];
    if (d.purch === null) drawSalesDoc(db, d.id, { doc, start });
    else if (d.purch.type === 'PURCHORD') drawPurchaseOrder(db, d.purch, { doc, start });
    else drawCheckRecord(db, d.purch, { doc, start });
  });
}
