import { formatMoney } from '@rapidbooks/shared';
import PDFDocument from 'pdfkit';
import type { DB } from '../db';

// Shared drawing helpers for the printed forms: US Letter, built-in Helvetica,
// laid out like the classic QuickBooks product invoice.

export type Doc = PDFKit.PDFDocument;

export const PAGE_W = 612;
export const PAGE_H = 792;
export const M = 36; // side margins, half an inch
export const RIGHT = PAGE_W - M;
export const CONTENT_W = PAGE_W - 2 * M;
export const FOOTER_Y = PAGE_H - 30; // "Page n of m"
export const BODY_BOTTOM = PAGE_H - 44; // nothing but the footer below this

const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SHADE = '#e6e6e6';

export function newDoc(title: string): Doc {
  return new PDFDocument({
    size: 'LETTER',
    margins: { top: M, left: M, right: M, bottom: 12 },
    bufferPages: true,
    info: { Title: title, Producer: 'RapidBooks', Creator: 'RapidBooks' },
  });
}

/** Finish the document and collect its bytes. */
export function finish(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export interface CompanyHeader {
  name: string;
  address: string;
  phone: string;
  fax: string;
  email: string;
}

/** Dollars for the printed totals: "$1,234.50", "-$500.00". */
export const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${formatMoney(Math.abs(cents))}`;

export function companyInfo(db: DB): CompanyHeader {
  const rows = db.prepare('SELECT key, value FROM company').all() as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return {
    name: m.get('name') ?? '',
    address: m.get('address') ?? '',
    phone: m.get('phone') ?? '',
    fax: m.get('fax') ?? '',
    email: m.get('email') ?? '',
  };
}

/** Plain text at a point, clipped to one line of the given width. */
export function text(
  doc: Doc,
  s: string,
  x: number,
  y: number,
  opts: { width: number; align?: 'left' | 'right' | 'center'; bold?: boolean; size?: number },
) {
  doc
    .font(opts.bold ? BOLD : FONT)
    .fontSize(opts.size ?? 9)
    .fillColor('black')
    .text(s, x, y, { width: opts.width, align: opts.align ?? 'left', lineBreak: false, ellipsis: true, height: (opts.size ?? 9) + 2 });
}

/** Company name and address, top left. Returns the y below it. */
export function drawCompany(doc: Doc, c: CompanyHeader, y = M): number {
  let yy = y;
  if (c.name) {
    text(doc, c.name, M, yy, { width: 300, bold: true, size: 12 });
    yy += 15;
  }
  const lines = [...c.address.split('\n'), c.phone ? `Phone ${c.phone}` : '', c.fax ? `Fax ${c.fax}` : '']
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (const l of lines) {
    text(doc, l, M, yy, { width: 300, size: 9.5 });
    yy += 11.5;
  }
  return yy;
}

/** The form title, top right. */
export function drawTitle(doc: Doc, title: string, y = M) {
  text(doc, title, RIGHT - 250, y - 2, { width: 250, align: 'right', bold: true, size: 20 });
}

const HEAD_H = 13;

/**
 * A boxed row of labelled cells: a shaded header row with the labels and a row below
 * with the values. Returns the y below the box.
 */
export function drawFieldBox(
  doc: Doc,
  x: number,
  y: number,
  cells: { label: string; value: string; width: number; align?: 'left' | 'right' | 'center' }[],
  valueH = 16,
  labelSize = 8,
): number {
  const w = cells.reduce((s, c) => s + c.width, 0);
  doc.save().rect(x, y, w, HEAD_H).fill(SHADE).restore();
  doc.lineWidth(0.75).rect(x, y, w, HEAD_H + valueH).stroke();
  doc.moveTo(x, y + HEAD_H).lineTo(x + w, y + HEAD_H).stroke();
  let cx = x;
  cells.forEach((c, i) => {
    if (i > 0) doc.moveTo(cx, y).lineTo(cx, y + HEAD_H + valueH).stroke();
    text(doc, c.label, cx + 2, y + 3, { width: c.width - 4, align: 'center', size: labelSize });
    text(doc, c.value, cx + 4, y + HEAD_H + (valueH - 9) / 2, { width: c.width - 8, align: c.align ?? 'center' });
    cx += c.width;
  });
  return y + HEAD_H + valueH;
}

/** A box with a shaded caption and multi-line contents (Bill To, Ship To). */
export function drawAddressBox(doc: Doc, x: number, y: number, w: number, h: number, caption: string, body: string) {
  doc.save().rect(x, y, w, HEAD_H).fill(SHADE).restore();
  doc.lineWidth(0.75).rect(x, y, w, h).stroke();
  doc.moveTo(x, y + HEAD_H).lineTo(x + w, y + HEAD_H).stroke();
  text(doc, caption, x + 4, y + 3, { width: w - 8, size: 8 });
  const lines = body.split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l !== '' || (i > 0 && i < a.length - 1));
  let yy = y + HEAD_H + 4;
  for (const l of lines) {
    if (yy + 11 > y + h) break;
    text(doc, l, x + 6, yy, { width: w - 12, size: 9.5 });
    yy += 11;
  }
}

export interface Column {
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
  wrap?: boolean; // the one column whose text wraps
}

const CELL_PAD = 4;
const ROW_GAP = 3;

/**
 * A ruled table that flows over pages. `header(doc, page)` draws what goes above the
 * table on each page and returns the y where the table starts. `reserve` is the space
 * kept free below the table on the last page (for totals). Returns the page count and
 * the y where the space below the table begins on the last page.
 */
export function drawTable(
  doc: Doc,
  columns: Column[],
  rows: string[][],
  header: (doc: Doc, pageIndex: number) => number,
  reserve: number,
): { bottom: number } {
  const totalW = columns.reduce((s, c) => s + c.width, 0);
  const xs: number[] = [];
  columns.reduce((x, c) => (xs.push(x), x + c.width), M);

  let page = 0;
  let top = header(doc, page);
  const drawHead = () => {
    doc.save().rect(M, top, totalW, HEAD_H + 2).fill(SHADE).restore();
    columns.forEach((c, i) =>
      text(doc, c.label, xs[i] + CELL_PAD, top + 3.5, { width: c.width - 2 * CELL_PAD, align: 'center', size: 8.5 }),
    );
  };
  const frame = (bottom: number) => {
    doc.lineWidth(0.75).rect(M, top, totalW, bottom - top).stroke();
    doc.moveTo(M, top + HEAD_H + 2).lineTo(M + totalW, top + HEAD_H + 2).stroke();
    for (let i = 1; i < columns.length; i++) doc.moveTo(xs[i], top).lineTo(xs[i], bottom).stroke();
  };

  drawHead();
  let y = top + HEAD_H + 2 + ROW_GAP + 1;
  doc.font(FONT).fontSize(9);
  for (const row of rows) {
    const h = Math.max(
      ...columns.map((c, i) =>
        c.wrap && row[i] ? doc.font(FONT).fontSize(9).heightOfString(row[i], { width: c.width - 2 * CELL_PAD }) : 10,
      ),
    );
    if (y + h + ROW_GAP > BODY_BOTTOM) {
      frame(BODY_BOTTOM);
      doc.addPage();
      page++;
      top = header(doc, page);
      drawHead();
      y = top + HEAD_H + 2 + ROW_GAP + 1;
    }
    columns.forEach((c, i) => {
      const v = row[i] ?? '';
      if (v === '') return;
      doc.font(FONT).fontSize(9).fillColor('black');
      if (c.wrap) doc.text(v, xs[i] + CELL_PAD, y, { width: c.width - 2 * CELL_PAD, align: c.align });
      else text(doc, v, xs[i] + CELL_PAD, y, { width: c.width - 2 * CELL_PAD, align: c.align });
    });
    y += h + ROW_GAP;
  }

  // The last page: the table runs down to the totals.
  let bottom = BODY_BOTTOM - reserve;
  if (y > bottom) {
    frame(BODY_BOTTOM);
    doc.addPage();
    page++;
    top = header(doc, page);
    drawHead();
    bottom = Math.max(top + HEAD_H + 40, BODY_BOTTOM - reserve);
  }
  frame(bottom);
  return { bottom };
}

/** "Page n of m" at the foot of every page. */
export function drawPageNumbers(doc: Doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    text(doc, `Page ${i + 1} of ${range.count}`, M, FOOTER_Y, { width: CONTENT_W, align: 'center', size: 8.5 });
  }
}
