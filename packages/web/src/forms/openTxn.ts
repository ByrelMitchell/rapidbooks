import type { Desktop } from '../shell/desktop';
import { registry } from '../shell/registry';

/** Open a window kind, or say so in the status bar if that window is not built yet. */
export function openWindow(desk: Desktop, kind: string, props: Record<string, unknown>, feature: string): boolean {
  if (!registry[kind]) {
    desk.setStatus(`${feature} is not available yet.`);
    return false;
  }
  desk.open(kind, props);
  return true;
}

/** Window kind that opens each transaction type (registers, history, reports). */
export const TXN_WINDOWS: Record<string, string> = {
  GENJRNL: 'journal',
  INVOICE: 'invoice',
  CREDITMEMO: 'creditmemo',
  PAYMENT: 'payment',
  DEPOSIT: 'deposit',
  PURCHORD: 'purchaseorder',
  BILL: 'bill',
  BILLCREDIT: 'bill',
  BILLPMT: 'billpmt',
  CHECK: 'check',
  TRANSFER: 'transfer',
  PAYCHECK: 'paycheck',
};

/** Extra window props for a type that shares a window kind (a bill credit opens Enter Bills with Credit). */
const TXN_WINDOW_PROPS: Record<string, Record<string, unknown>> = {
  BILLCREDIT: { credit: true },
};

/** Open a transaction in its form; false (with a status message) if that kind cannot be opened yet. */
export function openTxn(desk: Desktop, type: string, id: number): boolean {
  const kind = TXN_WINDOWS[type];
  if (!kind || !registry[kind]) {
    desk.setStatus('This kind of transaction cannot be opened yet.');
    return false;
  }
  desk.open(kind, { id, ...TXN_WINDOW_PROPS[type] });
  return true;
}
