import { TXN_TYPE_LABELS, type Txn } from '@rapidbooks/shared';
import { api, errorMessage } from '../api';
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

/**
 * The window for a transaction imported "as posted" from QuickBooks (import_locked), and
 * for any QuickBooks type RapidBooks has no form for: its debits and credits, journal style.
 */
export const IMPORTED_WINDOW = 'imported';

/** Extra window props for a type that shares a window kind (a bill credit opens Enter Bills with Credit). */
const TXN_WINDOW_PROPS: Record<string, Record<string, unknown>> = {
  BILLCREDIT: { credit: true },
};

/** "Paycheck 3005", "Sales Receipt SR-1": QuickBooks' own type name when it was imported. */
export function txnLabel(t: Pick<Txn, 'type' | 'num'> & { qb_type?: string }): string {
  const type = t.qb_type || TXN_TYPE_LABELS[t.type] || t.type;
  return `${type}${t.num ? ` ${t.num}` : ''}`;
}

/** The form window (and its props) for a transaction that is not locked; null when RapidBooks has no form for it. */
function formFor(type: string, id: number): { kind: string; props: Record<string, unknown> } | null {
  const kind = TXN_WINDOWS[type];
  if (!kind || !registry[kind]) return null;
  return { kind, props: { id, ...TXN_WINDOW_PROPS[type] } };
}

/**
 * Open a transaction in its form. Registers, reports (QuickZoom), Find and the history
 * windows only know its type, so the transaction is read first: one imported "as posted"
 * from QuickBooks (locked), or of a type that has no form, opens in the imported view
 * instead, and no form ever gets a transaction it could not save.
 */
export async function openTxn(desk: Desktop, type: string, id: number): Promise<boolean> {
  if (!formFor(type, id)) {
    // A QuickBooks type with no RapidBooks form ("Sales Receipt"...): only the imported view can show it.
    desk.open(IMPORTED_WINDOW, { id });
    return true;
  }
  let t: Txn;
  try {
    t = await api.get<Txn>(`/api/txns/${id}`);
  } catch (e) {
    desk.setStatus(errorMessage(e));
    return false;
  }
  const form = t.import_locked ? null : formFor(t.type, id);
  if (!form) desk.open(IMPORTED_WINDOW, { id });
  else if (t.type === 'CHECK' && (t as Txn & { refund?: unknown }).refund) desk.open('refund', { id });
  else desk.open(form.kind, form.props);
  return true;
}

/**
 * Called by every transaction form right after it reads a transaction: when it is locked
 * (imported as posted), the form must not show or save it. The form's window is replaced
 * by the imported view of the same transaction. True when it was handed over (stop loading).
 */
export function handOffLocked(desk: Desktop, winId: string, t: Txn): boolean {
  if (!t.import_locked) return false;
  desk.close(winId);
  desk.open(IMPORTED_WINDOW, { id: t.id });
  desk.setStatus(`${txnLabel(t)} was brought over from QuickBooks exactly as posted, so it opens as a list of its debits and credits.`);
  return true;
}

/**
 * "Are you sure you want to delete this transaction?" (Edit > Delete in every form and the
 * registers). A transaction with a line marked cleared at the bank gets QuickBooks' warning
 * that deleting it changes what the bank account agrees with. Resolves true to delete.
 */
export async function confirmDeleteTxn(desk: Desktop, id: number): Promise<boolean> {
  let cleared = false;
  try {
    const t = await api.get<Txn>(`/api/txns/${id}`);
    cleared = t.splits.some((s) => s.cleared);
  } catch {
    // Not readable now: the delete itself will say what is wrong.
  }
  if (cleared) {
    return desk.confirm(
      'This transaction has been cleared at the bank. If you delete it, your bank balance in RapidBooks will no longer agree with your bank statement. Are you sure you want to delete it?',
      { yes: '&OK', no: '&Cancel', title: 'Delete Cleared Transaction', icon: 'warning' },
    );
  }
  return desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' });
}
