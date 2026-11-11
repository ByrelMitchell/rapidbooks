import { formatMoney, formatRate, formatUsDate, type DocTxn } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { fullName, nameRow } from '../ledger/common';
import { getTxn } from '../ledger/posting';
import {
  companyInfo,
  drawAddressBox,
  drawCompany,
  drawFieldBox,
  drawPageNumbers,
  drawTable,
  drawTitle,
  dollars,
  finish,
  M,
  newDoc,
  RIGHT,
  text,
  type Column,
  type Doc,
} from './layout';

// Invoice and credit memo, laid out like the QuickBooks "Intuit Product Invoice".

const COLUMNS: Column[] = [
  { label: 'Item', width: 82, align: 'left' },
  { label: 'Description', width: 236, align: 'left', wrap: true },
  { label: 'Qty', width: 50, align: 'right' },
  { label: 'Rate', width: 80, align: 'right' },
  { label: 'Amount', width: 92, align: 'right' },
];

export function formatQty(q: number | null): string {
  if (q === null) return '';
  return Number(q.toFixed(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

const pct = (bp: number) => `${Number((bp / 100).toFixed(5))}%`;

/** The file name a document is attached or downloaded as: "Invoice 1234.pdf". */
export function docFileName(t: { type: string; num: string }): string {
  const label = t.type === 'CREDITMEMO' ? 'Credit Memo' : 'Invoice';
  const num = t.num.replace(/[\\/:*?"<>|]/g, '-').trim();
  return `${label}${num ? ` ${num}` : ''}.pdf`;
}

/** Bill-to text: what was typed on the form, else the customer's name and address. */
function billTo(db: DB, t: DocTxn): string {
  if (t.bill_addr.trim()) return t.bill_addr;
  // A job without an address of its own is billed at its customer's.
  let n = t.name_id !== null ? nameRow(db, t.name_id) : undefined;
  while (n && !n.bill_addr.trim() && n.parent_id !== null) n = nameRow(db, n.parent_id);
  if (!n) return '';
  return n.bill_addr.trim() ? n.bill_addr : n.company || fullName(db, n.id);
}

export function loadSalesDoc(db: DB, id: number): DocTxn {
  const t = getTxn(db, id);
  if (t.type !== 'INVOICE' && t.type !== 'CREDITMEMO') {
    throw new AppError(400, 'Only invoices and credit memos can be printed as a form.');
  }
  return t as DocTxn;
}

export async function renderSalesDocPdf(db: DB, id: number): Promise<Buffer> {
  return finish(drawSalesDoc(db, id));
}

/** Draw into `into.doc` from page `into.start` (a combined PDF), or into a new document. */
export function drawSalesDoc(db: DB, id: number, into?: { doc: Doc; start: number }): Doc {
  const t = loadSalesDoc(db, id);
  const isInvoice = t.type === 'INVOICE';
  const title = isInvoice ? 'Invoice' : 'Credit Memo';
  const numLabel = isInvoice ? 'Invoice #' : 'Credit No.';
  const company = companyInfo(db);
  const terms =
    t.terms_id !== null
      ? ((db.prepare('SELECT name FROM terms WHERE id = ?').get(t.terms_id) as { name: string } | undefined)?.name ?? '')
      : '';
  const itemName = db.prepare('SELECT name FROM items WHERE id = ?');

  const doc = into?.doc ?? newDoc(`${title} ${t.num}`);

  const dateBox = (d: Doc, y: number) =>
    drawFieldBox(d, RIGHT - 180, y, [
      { label: 'Date', value: formatUsDate(t.date), width: 90 },
      { label: numLabel, value: t.num, width: 90 },
    ]);

  const header = (d: Doc, page: number): number => {
    drawTitle(d, title);
    if (page > 0) {
      text(d, company.name, M, M, { width: 300, bold: true, size: 12 });
      return dateBox(d, M + 28) + 14;
    }
    drawCompany(d, company);
    dateBox(d, M + 28);
    const boxY = 122;
    if (isInvoice) {
      drawAddressBox(d, M, boxY, 252, 84, 'Bill To', billTo(db, t));
      drawAddressBox(d, RIGHT - 252, boxY, 252, 84, 'Ship To', t.ship_addr);
    } else {
      drawAddressBox(d, M, boxY, 252, 84, 'Customer', billTo(db, t));
    }
    const cells = isInvoice
      ? [
          { label: 'P.O. No.', value: t.po_number, width: 90 },
          { label: 'Terms', value: terms, width: 90 },
          { label: 'Due Date', value: t.due_date ? formatUsDate(t.due_date) : '', width: 80 },
          { label: 'Ship Date', value: t.ship_date ? formatUsDate(t.ship_date) : '', width: 80 },
          { label: 'Ship Via', value: t.ship_via, width: 90 },
        ]
      : [{ label: 'P.O. No.', value: t.po_number, width: 90 }];
    const w = cells.reduce((s, c) => s + c.width, 0);
    return drawFieldBox(d, RIGHT - w, boxY + 96, cells) + 10;
  };

  const rows = t.lines.map((l) => {
    const isSubtotal =
      l.item_id !== null && (db.prepare('SELECT type FROM items WHERE id = ?').get(l.item_id) as { type: string } | undefined)?.type === 'SUBTOTAL';
    const name = l.item_id !== null ? ((itemName.get(l.item_id) as { name: string } | undefined)?.name ?? '') : '';
    const posts = l.item_id !== null || l.account_id !== null;
    return [
      name,
      l.description,
      isSubtotal ? '' : formatQty(l.qty),
      isSubtotal || l.rate === null ? '' : l.rate_is_percent ? pct(l.rate) : formatRate(l.rate),
      posts ? formatMoney(l.amount) : '',
    ];
  });

  const totalRows: [string, string][] = isInvoice
    ? [
        ['Total', dollars(t.total)],
        ['Payments/Credits', dollars(-(t.total - (t.open_balance ?? 0)))],
        ['Balance Due', dollars(t.open_balance ?? 0)],
      ]
    : [['Total', dollars(t.total)]];
  const ROW = 18;
  const reserve = Math.max(totalRows.length * ROW, 54) + 8;

  const { bottom } = drawTable(doc, COLUMNS, rows, header, reserve);

  // Totals, bottom right, boxed; the customer message bottom left.
  const y0 = bottom;
  const labelW = 110;
  const valueW = 92;
  const x0 = RIGHT - labelW - valueW;
  doc.lineWidth(0.75).rect(x0, y0, labelW + valueW, totalRows.length * ROW).stroke();
  totalRows.forEach(([label, value], i) => {
    const y = y0 + i * ROW;
    if (i > 0) doc.moveTo(x0, y).lineTo(x0 + labelW + valueW, y).stroke();
    const last = i === totalRows.length - 1;
    text(doc, label, x0 + 6, y + 5, { width: labelW - 8, bold: last || i === 0, size: last ? 11 : 10 });
    text(doc, value, x0 + labelW, y + 5, { width: valueW - 6, align: 'right', bold: last || i === 0, size: last ? 11 : 10 });
  });
  if (t.message.trim()) {
    doc.font('Helvetica').fontSize(9.5).fillColor('black').text(t.message, M + 2, y0 + 6, {
      width: x0 - M - 16,
      height: reserve - 10,
      ellipsis: true,
    });
  }

  drawPageNumbers(doc, into?.start ?? 0);
  return doc;
}
