import type { CreditMemoInput, DocTxn, InvoiceInput, LineInput } from '@rapidbooks/shared';

/**
 * The input that saves a stored invoice or credit memo back exactly as it is
 * (stored amounts are sent as given), for changing header flags like To be printed.
 */
export function docToInput(t: DocTxn): InvoiceInput | CreditMemoInput {
  const lines: LineInput[] = [...t.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((l) => ({
      item_id: l.item_id,
      description: l.description,
      qty: l.qty,
      rate: l.rate,
      rate_is_percent: l.rate_is_percent,
      amount: l.amount,
      account_id: l.item_id === null ? l.account_id : null,
    }));
  return {
    type: t.type === 'CREDITMEMO' ? 'CREDITMEMO' : 'INVOICE',
    date: t.date,
    num: t.num,
    name_id: t.name_id,
    memo: t.memo,
    version: t.version,
    ar_account_id: t.ar_account_id,
    terms_id: t.terms_id,
    due_date: t.due_date,
    po_number: t.po_number,
    ship_date: t.ship_date,
    ship_via: t.ship_via,
    bill_addr: t.bill_addr,
    ship_addr: t.ship_addr,
    message: t.message,
    to_print: t.to_print,
    to_email: t.to_email,
    lines,
  };
}

/** "Invoice 1234" / "Credit Memo 1234". */
export const docLabel = (type: string, num: string) =>
  `${type === 'CREDITMEMO' ? 'Credit Memo' : 'Invoice'}${num ? ` ${num}` : ''}`;

/** Open a saved document's PDF in a new browser tab. False when the browser blocked the tab. */
export function openPdf(id: number): boolean {
  return window.open(`/api/txns/${id}/pdf`, '_blank') !== null;
}

/** Open several saved forms as ONE combined PDF in a single tab. False when the browser blocked the tab. */
export function openPdfs(ids: number[]): boolean {
  if (ids.length === 1) return openPdf(ids[0]);
  return window.open(`/api/txns/pdf?ids=${ids.join(',')}`, '_blank') !== null;
}

/** The status-bar line when the browser blocked the PDF tab. */
export const PDF_BLOCKED = 'The browser blocked the PDF tab. Allow pop-ups for RapidBooks, then print again.';
