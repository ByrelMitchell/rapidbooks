import { amountInWords, formatMoney, formatRate, formatUsDate, type PurchTxn } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { fullName } from '../ledger/common';
import { payrollSummary } from '../ledger/payables';
import { getTxn } from '../ledger/posting';
import { renderPurchaseOrderPdf } from './purchase';
import { formatQty } from './invoice';
import {
  companyInfo,
  CONTENT_W,
  drawCompany,
  drawFieldBox,
  drawPageNumbers,
  drawTable,
  dollars,
  finish,
  M,
  newDoc,
  RIGHT,
  text,
  type Column,
  type Doc,
} from './layout';

// Plain-paper check records for her files (CHECK, BILLPMT, PAYCHECK): the check face
// with the amount in figures and words, then a voucher (lines, bills paid, or pay stub).
// Printing on real check stock is out of scope.

const TITLE = 'CHECK RECORD - NOT NEGOTIABLE';

/** Purchase and banking documents that print: purchase orders and check records. */
export function isPurchasePrintable(type: string) {
  return type === 'PURCHORD' || type === 'CHECK' || type === 'BILLPMT' || type === 'PAYCHECK';
}

/** The file name a purchase order or check record is downloaded as. */
export function purchaseFileName(t: { type: string; num: string; date: string }): string {
  const num = t.num.replace(/[\\/:*?"<>|]/g, '-').trim();
  if (t.type === 'PURCHORD') return `Purchase Order${num ? ` ${num}` : ''}.pdf`;
  const label = t.type === 'PAYCHECK' ? 'Paycheck' : t.type === 'BILLPMT' ? 'Bill Payment' : 'Check';
  return `${label} ${num || formatUsDate(t.date).replace(/\//g, '-')}.pdf`;
}

export function loadPurchasePrintable(db: DB, id: number): PurchTxn {
  const t = getTxn(db, id);
  if (!isPurchasePrintable(t.type)) {
    throw new AppError(400, 'Only invoices, credit memos, purchase orders, checks, bill payments and paychecks can be printed as a form.');
  }
  return t as PurchTxn;
}

export async function renderPurchasePdf(db: DB, id: number): Promise<Buffer> {
  const t = loadPurchasePrintable(db, id);
  return t.type === 'PURCHORD' ? renderPurchaseOrderPdf(db, t) : renderCheckRecordPdf(db, t);
}

interface PayeeRow {
  name: string;
  kind: string;
  company: string;
  print_as: string;
  bill_addr: string;
}

const COL_CHECK: Column[] = [
  { label: 'Account / Item', width: 140, align: 'left' },
  { label: 'Description / Memo', width: 210, align: 'left', wrap: true },
  { label: 'Customer:Job', width: 110, align: 'left' },
  { label: 'Amount', width: 80, align: 'right' },
];
const COL_BILLS: Column[] = [
  { label: 'Ref. No.', width: 100, align: 'left' },
  { label: 'Bill Date', width: 80, align: 'center' },
  { label: 'Due Date', width: 80, align: 'center' },
  { label: 'Original Amount', width: 100, align: 'right' },
  { label: 'Discount', width: 80, align: 'right' },
  { label: 'Amount Paid', width: 100, align: 'right' },
];
const COL_STUB: Column[] = [
  { label: 'Payroll Item', width: 200, align: 'left' },
  { label: 'Hours', width: 70, align: 'right' },
  { label: 'Rate', width: 80, align: 'right' },
  { label: 'Current', width: 95, align: 'right' },
  { label: 'YTD Amount', width: 95, align: 'right' },
];

export async function renderCheckRecordPdf(db: DB, t: PurchTxn): Promise<Buffer> {
  return finish(drawCheckRecord(db, t));
}

/** Draw into `into.doc` from page `into.start` (a combined PDF), or into a new document. */
export function drawCheckRecord(db: DB, t: PurchTxn, into?: { doc: Doc; start: number }): Doc {
  const company = companyInfo(db);
  const bank = t.account_id !== null ? fullAccountName(db, t.account_id) : '';
  const payee =
    t.name_id !== null ? (db.prepare('SELECT name, kind, company, print_as, bill_addr FROM names WHERE id = ?').get(t.name_id) as PayeeRow | undefined) : undefined;
  const payeeName = payee ? (payee.print_as.trim() || fullName(db, t.name_id)) : '';
  const address = t.address.trim() ? t.address : (payee?.bill_addr ?? '');
  const checkNo = t.to_print ? 'To Print' : t.num;

  const doc = into?.doc ?? newDoc(`${TITLE} ${t.num}`);

  /** The check face. Returns the y below it. */
  const face = (d: Doc): number => {
    drawCompany(d, company);
    text(d, TITLE, RIGHT - 320, M - 1, { width: 320, align: 'right', bold: true, size: 13 });
    drawFieldBox(d, RIGHT - 300, M + 24, [
      { label: 'Bank Account', value: bank, width: 140 },
      { label: 'Check No.', value: checkNo, width: 80 },
      { label: 'Date', value: formatUsDate(t.date), width: 80 },
    ]);

    const top = 118;
    const h = 150;
    d.lineWidth(0.75).rect(M, top, CONTENT_W, h).stroke();
    let y = top + 12;
    text(d, 'Pay to the', M + 10, y, { width: 70, size: 8 });
    text(d, 'Order of', M + 10, y + 9, { width: 70, size: 8 });
    text(d, payeeName, M + 70, y + 4, { width: 330, size: 11, bold: true });
    d.moveTo(M + 68, y + 18).lineTo(RIGHT - 130, y + 18).stroke();
    // Amount in figures, boxed, right.
    d.lineWidth(0.75).rect(RIGHT - 120, y - 2, 110, 22).stroke();
    text(d, `**${formatMoney(t.total)}`, RIGHT - 116, y + 4, { width: 100, align: 'right', bold: true, size: 11 });

    y += 32;
    const words = `${amountInWords(t.total)}`;
    text(d, `${words} ${'*'.repeat(Math.max(3, 70 - words.length))}`, M + 10, y, { width: CONTENT_W - 80, size: 10 });
    text(d, 'Dollars', RIGHT - 60, y, { width: 50, size: 10 });
    d.moveTo(M + 8, y + 13).lineTo(RIGHT - 64, y + 13).stroke();

    y += 24;
    const lines = address.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
    const addr = payeeName && !lines.some((l) => l.toLowerCase() === payeeName.toLowerCase()) ? [payeeName, ...lines] : lines;
    addr.slice(0, 5).forEach((l, i) => text(d, l, M + 70, y + i * 11, { width: 260, size: 9.5 }));

    const memoY = top + h - 22;
    text(d, 'Memo', M + 10, memoY, { width: 40, size: 8 });
    text(d, t.memo, M + 46, memoY - 1, { width: 290, size: 9.5 });
    d.moveTo(M + 44, memoY + 10).lineTo(M + 340, memoY + 10).stroke();
    text(d, 'NOT NEGOTIABLE', RIGHT - 190, memoY - 4, { width: 180, align: 'center', bold: true, size: 14 });
    return top + h + 16;
  };

  /** Later pages: a short heading. */
  const shortHeader = (d: Doc): number => {
    text(d, `${TITLE}  -  Check No. ${checkNo}  -  ${formatUsDate(t.date)}  -  ${payeeName}`, M, M, { width: CONTENT_W, bold: true, size: 10 });
    return M + 20;
  };

  let voucherTitle = '';
  let columns: Column[];
  let rows: string[][];
  let totals: [string, string][] = [];

  if (t.type === 'CHECK') {
    voucherTitle = 'Check Voucher';
    columns = COL_CHECK;
    const acct = (id: number | null) => (id !== null ? fullAccountName(db, id) : '');
    const itemName = db.prepare('SELECT name FROM items WHERE id = ?');
    rows = [
      ...t.expenses.map((l) => [acct(l.account_id), l.memo, fullName(db, l.name_id), formatMoney(l.amount)]),
      ...t.items.map((l) => {
        const name = l.item_id !== null ? ((itemName.get(l.item_id) as { name: string } | undefined)?.name ?? '') : '';
        const qty = l.qty !== null && l.rate !== null ? `${formatQty(l.qty)} @ ${formatRate(l.rate)}` : '';
        return [name, [l.description, qty].filter((s) => s).join('  -  '), fullName(db, l.name_id), l.item_id !== null ? formatMoney(l.amount) : ''];
      }),
    ];
    if (t.refund) {
      // A refund has no lines: say what it pays back.
      const c = db.prepare('SELECT type, num, date FROM txns WHERE id = ?').get(t.refund.credit_id) as { type: string; num: string; date: string } | undefined;
      const what = c ? `Refund of ${c.type === 'PAYMENT' ? 'payment' : 'credit memo'}${c.num ? ` ${c.num}` : ''} of ${formatUsDate(c.date)}` : 'Refund';
      const ar = db.prepare('SELECT ar_account_id FROM txns WHERE id = ?').get(t.id) as { ar_account_id: number | null };
      // Her memo too, unless it only says the same (the window starts it as "Refund of credit memo 1905").
      const memo = t.memo.trim() && !what.toLowerCase().startsWith(t.memo.trim().toLowerCase()) ? t.memo.trim() : '';
      rows.push([acct(ar.ar_account_id), [what, memo].filter((s) => s).join('  -  '), fullName(db, t.name_id), formatMoney(t.refund.amount)]);
    }
    totals = [['Check Amount', dollars(t.total)]];
  } else if (t.type === 'BILLPMT') {
    voucherTitle = 'Bill Payment Voucher';
    columns = COL_BILLS;
    const getBill = db.prepare('SELECT num, date, due_date, total FROM txns WHERE id = ?');
    const apps = t.links_out.filter((l) => l.kind === 'apply');
    rows = apps.map((l) => {
      const b = getBill.get(l.txn_id) as { num: string; date: string; due_date: string; total: number };
      return [b.num, formatUsDate(b.date), formatUsDate(b.due_date), formatMoney(b.total), l.discount ? formatMoney(l.discount) : '', formatMoney(l.amount)];
    });
    const discount = apps.reduce((s, l) => s + l.discount, 0);
    const applied = apps.reduce((s, l) => s + l.amount, 0);
    if (discount) totals.push(['Total Discount', dollars(discount)]);
    if (applied !== t.total) totals.push(['Unapplied', dollars(t.total - applied)]);
    totals.push(['Check Amount', dollars(t.total)]);
  } else {
    voucherTitle = 'Pay Stub';
    columns = COL_STUB;
    const year = t.date.slice(0, 4);
    const ytd = new Map(
      payrollSummary(db, `${year}-01-01`, t.date, t.name_id, t.id).map((r) => [r.payroll_item_id, r.amount]),
    );
    const section = (kind: 'earning' | 'deduction' | 'company', label: string) => {
      const ls = t.pay_lines.filter((l) => l.kind === kind);
      if (ls.length === 0) return [] as string[][];
      const sign = kind === 'deduction' ? -1 : 1;
      const out: string[][] = [[label.toUpperCase(), '', '', '', '']];
      const seen = new Set<number>();
      for (const l of ls) {
        out.push([
          `   ${l.name}`,
          l.hours !== null ? formatQty(l.hours) : '',
          l.rate !== null ? formatRate(l.rate) : '',
          formatMoney(sign * l.amount),
          seen.has(l.payroll_item_id) ? '' : formatMoney(sign * (ytd.get(l.payroll_item_id) ?? 0)),
        ]);
        seen.add(l.payroll_item_id);
      }
      const cur = ls.reduce((s, l) => s + l.amount, 0);
      const ytdTotal = [...seen].reduce((s, id) => s + (ytd.get(id) ?? 0), 0);
      out.push([`   Total ${label.toLowerCase()}`, '', '', formatMoney(sign * cur), formatMoney(sign * ytdTotal)]);
      return out;
    };
    rows = [
      ...section('earning', 'Earnings'),
      ...section('deduction', 'Deductions'),
      ...section('company', 'Company Contributions'),
    ];
    const pc = t.paycheck!;
    const ytdNet = [...ytd.entries()].reduce((s, [id, amt]) => {
      const kind = (db.prepare('SELECT kind FROM payroll_items WHERE id = ?').get(id) as { kind: string } | undefined)?.kind;
      return s + (kind === 'earning' ? amt : kind === 'deduction' ? -amt : 0);
    }, 0);
    totals = [['Net Pay', dollars(pc.net)], ['YTD Net Pay', dollars(ytdNet)]];
  }

  const ROW = 18;
  const reserve = totals.length * ROW + 8;
  const header = (d: Doc, page: number): number => {
    const y = page === 0 ? face(d) : shortHeader(d);
    text(d, voucherTitle, M, y, { width: 200, bold: true, size: 11 });
    // The payee and bank are on the check face; a pay stub also names the employee and period.
    if (t.type === 'PAYCHECK') {
      const period = t.period_from || t.period_to ? `Pay period ${formatUsDate(t.period_from)} - ${formatUsDate(t.period_to)}` : '';
      const info = [fullName(db, t.name_id), period].filter((s) => s).join('    ');
      text(d, info, M + 200, y + 1, { width: CONTENT_W - 200, align: 'right', size: 9.5 });
    }
    return y + 18;
  };
  const { bottom } = drawTable(doc, columns, rows, header, reserve);

  const labelW = 110;
  const valueW = 95;
  const x0 = RIGHT - labelW - valueW;
  doc.lineWidth(0.75).rect(x0, bottom, labelW + valueW, totals.length * ROW).stroke();
  totals.forEach(([label, value], i) => {
    const y = bottom + i * ROW;
    if (i > 0) doc.moveTo(x0, y).lineTo(x0 + labelW + valueW, y).stroke();
    text(doc, label, x0 + 6, y + 5, { width: labelW - 8, bold: i === 0, size: 10 });
    text(doc, value, x0 + labelW, y + 5, { width: valueW - 6, align: 'right', bold: i === 0, size: 10 });
  });

  drawPageNumbers(doc, into?.start ?? 0);
  return doc;
}

function fullAccountName(db: DB, id: number): string {
  const parts: string[] = [];
  let p: number | null = id;
  const get = db.prepare('SELECT name, parent_id FROM accounts WHERE id = ?');
  while (p !== null) {
    const r = get.get(p) as { name: string; parent_id: number | null } | undefined;
    if (!r) break;
    parts.unshift(r.name);
    p = r.parent_id;
  }
  return parts.join(':');
}
