import { formatMoney, formatUsDate, type Account, type BillPaymentInput, type Name, type PurchTxn, type UnpaidBill } from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField, parseAmount } from '../controls/AmountField';
import { DateField } from '../controls/DateField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { adjacentTxn } from './receivablesShared';
import { openPdf } from './salesDoc';
import './receivables.css';
import './purchases.css';

interface Row {
  bill: UnpaidBill;
  /** Open balance apart from this payment. */
  open: number;
  pay: number;
  /** This payment's discount on the bill (kept as stored). */
  discount: number;
  discountAccountId: number | null;
}

interface Form {
  date: string;
  num: string;
  toPrint: boolean;
  memo: string;
  rows: Row[];
}

const serialize = (f: Form) => JSON.stringify({ ...f, rows: f.rows.map((r) => [r.bill.id, r.pay]) });
const maxPay = (r: Row) => Math.max(0, r.open - r.discount);

/** One saved bill payment (what the register opens for BILLPMT). Props: { id }. */
export function BillPayment({ winId, props }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: vendors } = useData<Name[]>('/api/names?kind=vendor');
  const [txnId, setTxnId, txnIdRef] = useLiveState<number>(props.id as number);
  const [txn, setTxn] = useState<PurchTxn | null>(null);
  const [form, setForm, formRef] = useLiveState<Form>({ date: '', num: '', toPrint: false, memo: '', rows: [] });
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const focusReq = useRef<number | 'date' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;

  const load = async (id: number) => {
    setLoading(true);
    try {
      const t = await api.get<PurchTxn>(`/api/txns/${id}`);
      if (t.type !== 'BILLPMT') throw new Error('That transaction is not a bill payment.');
      const list = await api.get<UnpaidBill[]>(`/api/bills/unpaid?vendor_id=${t.name_id}&payment_id=${id}&pay_date=${t.date}`);
      const accts = new Map(t.links_out.filter((l) => l.kind === 'apply').map((l) => [l.txn_id, l.discount_account_id]));
      // The bills this payment paid first, then the vendor's other open bills (sorted by due date).
      const rows: Row[] = list
        .map((b) => ({
          bill: b,
          open: b.open_balance,
          pay: b.applied_by_payment,
          discount: b.discount_by_payment,
          discountAccountId: accts.get(b.id) ?? null,
        }))
        .sort((a, b) => Number(b.pay + b.discount > 0) - Number(a.pay + a.discount > 0));
      const f: Form = { date: t.date, num: t.num, toPrint: t.to_print, memo: t.memo, rows };
      setForm(f);
      snapshot.current = serialize(f);
      setTxn(t);
      setTxnId(id);
      setError(null);
      focusReq.current = 'date';
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(props.id as number);
  }, [props.id]);

  useLayoutEffect(() => {
    const r = focusReq.current;
    if (r === null || loading) return;
    focusReq.current = null;
    const sel = r === 'date' ? '[data-field="date"]' : `[data-row="${r}"][data-col="pay"]`;
    rootRef.current?.querySelector<HTMLElement>(sel)?.focus();
  });

  const edit = (change: (f: Form) => Form) => {
    setError(null);
    setForm(change);
  };
  const setPay = (i: number, v: number | null) =>
    edit((f) => {
      const rows = [...f.rows];
      const r = rows[i];
      if (!r) return f;
      let pay = Math.max(0, v ?? 0);
      if (pay > maxPay(r)) {
        desk.setStatus(`The payment on ${r.bill.ref_no ? `bill ${r.bill.ref_no}` : 'that bill'} cannot be more than the ${formatMoney(maxPay(r))} it owes.`);
        pay = maxPay(r);
      }
      rows[i] = { ...r, pay };
      return { ...f, rows };
    });
  const toggle = (i: number) => {
    const r = formRef.current.rows[i];
    if (r) setPay(i, r.pay > 0 ? 0 : maxPay(r));
  };

  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const t = txn;
    if (!t) return false;
    const applied = f.rows.reduce((s, r) => s + r.pay, 0);
    if (applied === 0 && !f.rows.some((r) => r.discount > 0)) {
      setError('A bill payment must pay at least one bill. To remove it, delete it (Ctrl+D).');
      return false;
    }
    const body: BillPaymentInput = {
      type: 'BILLPMT',
      date: f.date,
      num: f.toPrint ? '' : f.num.trim(),
      to_print: t.pay_method !== 'other' && f.toPrint,
      name_id: t.name_id,
      memo: f.memo,
      version: t.version,
      account_id: t.account_id,
      ap_account_id: t.ap_account_id,
      pay_method: t.pay_method === 'other' ? 'other' : 'check',
      address: t.address,
      amount: applied,
      applications: f.rows
        .filter((r) => r.pay > 0 || r.discount > 0)
        .map((r) => ({ txn_id: r.bill.id, amount: r.pay, discount: r.discount, discount_account_id: r.discount > 0 ? r.discountAccountId : null })),
    };
    try {
      await api.put(`/api/txns/${t.id}`, body);
      desk.refresh();
      desk.setStatus(`Bill payment of ${formatMoney(applied)} saved.`);
      await load(t.id);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const save = async (mode: 'stay' | 'close') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      if (isDirty() && !(await persist())) {
        refocus(field);
        return;
      }
      if (mode === 'close') desk.close(winId);
      else refocus(field);
    } finally {
      busy.current = false;
    }
  };

  const askSave = async (quiet = false): Promise<boolean> => {
    const field = commitActiveField({ quiet });
    if (loading || !isDirty()) return true;
    const i = await desk.messageBox('You have changed the bill payment. Do you want to save the changes?', {
      title: 'Recording Transaction',
      icon: 'question',
      buttons: ['&Yes', '&No', '&Cancel'],
      cancelButton: 2,
    });
    if (i === 1) return true;
    if (i === 0 && (await persist())) return true;
    refocus(field);
    return false;
  };

  const go = async (dir: 'prev' | 'next') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      if (!(await askSave())) return;
      const id = await adjacentTxn('BILLPMT', txnIdRef.current, dir);
      if (id === null) desk.setStatus(dir === 'prev' ? 'This is the first bill payment.' : 'This is the last bill payment.');
      else await load(id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (busy.current) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    busy.current = true;
    try {
      await api.del(`/api/txns/${txnIdRef.current}`);
      desk.setStatus('Bill payment deleted. The bills it paid are open again.');
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const print = async () => {
    if (busy.current || loading) return;
    if (isDirty() && !(await askSave())) return;
    if (!openPdf(txnIdRef.current)) desk.setStatus('The browser blocked the new tab. Allow pop-ups for RapidBooks, then print again.');
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    delete: () => void remove(),
    print: () => void print(),
    history: () => desk.open('txnhistory', { txnId: txnIdRef.current }),
    txnJournal: () => desk.open('txnjournal', { txnId: txnIdRef.current }),
    register: () => txn?.account_id && desk.open('register', { accountId: txn.account_id }),
    confirmClose: () => askSave(true),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const fn = e.code === 'KeyP' ? () => void go('prev') : e.code === 'KeyX' ? () => void go('next') : undefined;
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const onGridKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLInputElement;
    const row = Number(t.dataset.row);
    if (t.dataset.col !== 'pay' || Number.isNaN(row)) return;
    if (e.key === ' ' && !e.shiftKey) {
      e.preventDefault();
      const r = formRef.current.rows[row];
      const typed = t.value.trim() === '' ? null : parseAmount(t.value);
      if (r && typed !== null && typed !== r.pay) setPay(row, typed);
      else toggle(row);
      requestAnimationFrame(() => t.isConnected && t.select());
      return;
    }
    if (e.shiftKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= formRef.current.rows.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-col="pay"]`)?.focus();
  };

  const vendor = vendors?.find((v) => v.id === txn?.name_id);
  const bank = accounts?.find((a) => a.id === txn?.account_id);
  const applied = form.rows.reduce((s, r) => s + r.pay, 0);
  const discounts = form.rows.reduce((s, r) => s + r.discount, 0);
  const isCheck = txn?.pay_method !== 'other';
  const dis = loading || !txn;

  return (
    <div className="form-window bp" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="form-toolbar">
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('prev')} title="Alt+P">
          <Mnemonic label="&Previous" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('next')} title="Alt+X">
          <Mnemonic label="Ne&xt" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void print()} title="Ctrl+P">
          Print
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => desk.open('txnjournal', { txnId })} title="Ctrl+Y">
          Journal
        </button>
      </div>
      {error && <div className="msg-strip error">{error}</div>}
      <div className="bp-head">
        <span className="bp-label">Bank Account</span>
        <span className="readout bp-text">{bank?.full_name ?? ''}</span>
        <span className="bp-label">Ending Balance</span>
        <span className="readout">{bank ? formatMoney(bank.balance) : ''}</span>

        <span className="bp-label">Pay to the Order of</span>
        <span className="readout bp-text">{vendor?.full_name ?? ''}</span>
        <span className="bp-label">Amount</span>
        <span className="readout bp-amount">{formatMoney(applied)}</span>

        <label className="bp-label" htmlFor={`${winId}-date`}>
          Date
        </label>
        <DateField id={`${winId}-date`} data-field="date" value={form.date} disabled={dis} onChange={(date) => edit((f) => ({ ...f, date }))} />
        <label className="bp-label" htmlFor={`${winId}-num`}>
          {isCheck ? 'Check No.' : 'No.'}
        </label>
        <span className="inline-fields">
          <input
            id={`${winId}-num`}
            className="field num-field"
            value={form.toPrint ? '' : form.num}
            maxLength={20}
            disabled={dis || form.toPrint}
            onChange={(e) => {
              const num = e.target.value;
              edit((f) => ({ ...f, num }));
            }}
            onFocus={(e) => e.target.select()}
          />
          {isCheck && (
            <label className="check">
              <input type="checkbox" checked={form.toPrint} disabled={dis} onChange={(e) => {
                const toPrint = e.target.checked;
                edit((f) => ({ ...f, toPrint }));
              }} />
              To be printed
            </label>
          )}
        </span>

        <label className="bp-label" htmlFor={`${winId}-memo`}>
          Memo
        </label>
        <input
          id={`${winId}-memo`}
          className="field bp-memo"
          value={form.memo}
          disabled={dis}
          onChange={(e) => {
            const memo = e.target.value;
            edit((f) => ({ ...f, memo }));
          }}
        />
      </div>
      <div className="grid-wrap pb-grid">
        <table className="line-grid">
          <colgroup>
            <col style={{ width: '2rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col />
            <col style={{ width: '7.5rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col style={{ width: '8rem' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="al-center">✓</th>
              <th>Bill Date</th>
              <th>Date Due</th>
              <th>Ref. No.</th>
              <th className="al-right">Amt. Due</th>
              <th className="al-right">Discount</th>
              <th className="al-right">Amt. Paid</th>
            </tr>
          </thead>
          <tbody onKeyDown={onGridKey}>
            {form.rows.map((r, i) => (
              <tr key={r.bill.id}>
                <td className="al-center rcv-check" onClick={() => !dis && toggle(i)}>
                  {r.pay > 0 || r.discount > 0 ? '✓' : ''}
                </td>
                <td className="cell-text">{formatUsDate(r.bill.date)}</td>
                <td className="cell-text">{formatUsDate(r.bill.due_date)}</td>
                <td className="cell-text">{r.bill.ref_no}</td>
                <td className="cell-text al-right">{formatMoney(r.open)}</td>
                <td className="cell-text al-right">{r.discount ? formatMoney(r.discount) : ''}</td>
                <td>
                  <AmountField
                    value={r.pay || null}
                    onChange={(v) => setPay(i, v)}
                    data-row={i}
                    data-col="pay"
                    disabled={dis}
                    aria-label={`Amount paid on ${r.bill.ref_no ? `bill ${r.bill.ref_no}` : `the bill of ${formatUsDate(r.bill.date)}`}`}
                  />
                </td>
              </tr>
            ))}
            {form.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="cell-text grey">
                  {loading ? 'Loading...' : 'There are no bills for this vendor.'}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="al-right total-label">
                Totals
              </td>
              <td className="al-right total">{discounts ? formatMoney(discounts) : ''}</td>
              <td className="al-right total">{formatMoney(applied)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="hint">Space ticks the bill you are on. The check amount is the total paid.</div>
      <div className="button-row">
        <span className="spacer" />
        <button type="button" className="btn default" disabled={dis} onClick={() => void save('close')} title="Alt+S">
          <Mnemonic label="&Save && Close" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void save('stay')} title="Ctrl+Enter">
          Save
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void remove()} title="Ctrl+D">
          Delete
        </button>
      </div>
    </div>
  );
}
