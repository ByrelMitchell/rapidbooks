import { formatMoney, formatRate, formatUsDate, type PurchTxn } from '@rapidbooks/shared';
import type { DB } from '../db';
import { fullName, nameRow } from '../ledger/common';
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
import { formatQty } from './invoice';

// Purchase order, laid out like the QuickBooks "Custom Purchase Order": Vendor and Ship
// To boxes, Date / P.O. No., then Item | Description | Qty | Rate | Amount and the total.

const COLUMNS: Column[] = [
  { label: 'Item', width: 82, align: 'left' },
  { label: 'Description', width: 236, align: 'left', wrap: true },
  { label: 'Qty', width: 50, align: 'right' },
  { label: 'Rate', width: 80, align: 'right' },
  { label: 'Amount', width: 92, align: 'right' },
];

/** Vendor box: what was typed on the form, else the vendor's name and address. */
function vendorBox(db: DB, t: PurchTxn): string {
  if (t.address.trim()) return t.address;
  const n = t.name_id !== null ? nameRow(db, t.name_id) : undefined;
  if (!n) return '';
  return n.bill_addr.trim() ? n.bill_addr : n.company || fullName(db, n.id);
}

export async function renderPurchaseOrderPdf(db: DB, t: PurchTxn): Promise<Buffer> {
  const company = companyInfo(db);
  const itemName = db.prepare('SELECT name FROM items WHERE id = ?');
  const doc = newDoc(`Purchase Order ${t.num}`);
  // With nothing typed in Ship To, the goods come to the company.
  const shipTo = t.ship_addr.trim() ? t.ship_addr : [company.name, company.address].filter((s) => s.trim()).join('\n');

  const dateBox = (d: Doc, y: number) =>
    drawFieldBox(d, RIGHT - 180, y, [
      { label: 'Date', value: formatUsDate(t.date), width: 90 },
      { label: 'P.O. No.', value: t.num, width: 90 },
    ]);

  const header = (d: Doc, page: number): number => {
    drawTitle(d, 'Purchase Order');
    if (page > 0) {
      text(d, company.name, M, M, { width: 300, bold: true, size: 12 });
      return dateBox(d, M + 28) + 14;
    }
    drawCompany(d, company);
    dateBox(d, M + 28);
    const boxY = 122;
    drawAddressBox(d, M, boxY, 252, 84, 'Vendor', vendorBox(db, t));
    drawAddressBox(d, RIGHT - 252, boxY, 252, 84, 'Ship To', shipTo);
    return boxY + 84 + 18;
  };

  const rows = t.items.map((l) => [
    l.item_id !== null ? ((itemName.get(l.item_id) as { name: string } | undefined)?.name ?? '') : '',
    l.description,
    formatQty(l.qty),
    l.rate === null ? '' : formatRate(l.rate),
    l.item_id !== null ? formatMoney(l.amount) : '',
  ]);

  const ROW = 20;
  const reserve = t.message.trim() ? 40 : ROW + 8; // the total box, and room for the vendor message
  const { bottom } = drawTable(doc, COLUMNS, rows, header, reserve);

  const labelW = 110;
  const valueW = 92;
  const x0 = RIGHT - labelW - valueW;
  doc.lineWidth(0.75).rect(x0, bottom, labelW + valueW, ROW).stroke();
  text(doc, 'Total', x0 + 6, bottom + 5, { width: labelW - 8, bold: true, size: 11 });
  text(doc, dollars(t.total), x0 + labelW, bottom + 5, { width: valueW - 6, align: 'right', bold: true, size: 11 });
  if (t.message.trim()) {
    doc.font('Helvetica').fontSize(9.5).fillColor('black').text(t.message, M + 2, bottom + 6, {
      width: x0 - M - 16,
      height: reserve - 10,
      ellipsis: true,
    });
  }

  drawPageNumbers(doc);
  return finish(doc);
}
