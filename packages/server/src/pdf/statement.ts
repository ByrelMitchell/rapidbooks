import { formatMoney, formatUsDate } from '@rapidbooks/shared';
import type { DB } from '../db';
import { nameRow } from '../ledger/common';
import { getStatement } from '../ledger/statements';
import {
  companyInfo,
  CONTENT_W,
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

// Customer statement, laid out like the QuickBooks "Intuit Standard Statement".

const COLUMNS: Column[] = [
  { label: 'Date', width: 70, align: 'left' },
  { label: 'Transaction', width: 290, align: 'left', wrap: true },
  { label: 'Amount', width: 90, align: 'right' },
  { label: 'Balance', width: 90, align: 'right' },
];

export async function renderStatementPdf(db: DB, customerId: number, from: string, to: string): Promise<Buffer> {
  return finish(drawStatement(db, customerId, from, to));
}

/** Draw into `into.doc` from page `into.start` (a combined PDF), or into a new document. */
export function drawStatement(db: DB, customerId: number, from: string, to: string, into?: { doc: Doc; start: number }): Doc {
  const s = getStatement(db, customerId, from, to);
  const company = companyInfo(db);
  const cust = nameRow(db, customerId)!;
  const toText = s.bill_addr.trim() ? s.bill_addr : cust.company || s.full_name;

  const doc = into?.doc ?? newDoc(`Statement ${s.full_name}`);
  const dateBox = (d: Doc, y: number) => drawFieldBox(d, RIGHT - 100, y, [{ label: 'Date', value: formatUsDate(s.to), width: 100 }]);

  const header = (d: Doc, page: number): number => {
    drawTitle(d, 'Statement');
    if (page > 0) {
      text(d, company.name, M, M, { width: 300, bold: true, size: 12 });
      text(d, s.full_name, M, M + 16, { width: 300, size: 9.5 });
      return dateBox(d, M + 28) + 14;
    }
    drawCompany(d, company);
    dateBox(d, M + 28);
    drawAddressBox(d, M, 122, 252, 84, 'To', toText);
    drawFieldBox(d, RIGHT - 200, 177, [
      { label: 'Amount Due', value: dollars(s.ending_balance), width: 100 },
      { label: 'Amount Enc.', value: '', width: 100 },
    ]);
    return 218;
  };

  const rows: string[][] = [
    [formatUsDate(s.from), 'Balance forward', '', formatMoney(s.balance_forward)],
    ...s.rows.map((r) => [formatUsDate(r.date), r.description, formatMoney(r.amount), formatMoney(r.balance)]),
  ];

  const AGING_H = 31;
  const { bottom } = drawTable(doc, COLUMNS, rows, header, AGING_H + 8);

  // Aging along the bottom, with the amount due at the right.
  const cells = [
    { label: 'CURRENT', value: formatMoney(s.aging.current) },
    { label: '1-30 DAYS PAST DUE', value: formatMoney(s.aging.d1_30) },
    { label: '31-60 DAYS PAST DUE', value: formatMoney(s.aging.d31_60) },
    { label: '61-90 DAYS PAST DUE', value: formatMoney(s.aging.d61_90) },
    { label: 'OVER 90 DAYS PAST DUE', value: formatMoney(s.aging.over_90) },
  ];
  const dueW = 90;
  const w = (CONTENT_W - dueW) / cells.length;
  drawFieldBox(doc, M, bottom + 4, [
    ...cells.map((c) => ({ ...c, width: w, align: 'right' as const })),
    { label: 'Amount Due', value: dollars(s.ending_balance), width: dueW, align: 'right' as const },
  ], 16, 7);

  drawPageNumbers(doc, into?.start ?? 0);
  return doc;
}
