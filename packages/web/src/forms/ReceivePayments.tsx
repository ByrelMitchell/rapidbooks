import {
  formatMoney,
  formatUsDate,
  todayIso,
  type Account,
  type DocTxn,
  type Name,
  type OpenInvoice,
  type PaymentInput,
} from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField, parseAmount } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { nameQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import { handOffLocked } from './openTxn';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { autoApply, payable, toggleRow, totalApplied, type ApplyRow } from './paymentApply';
import { adjacentTxn, PayMethodField } from './receivablesShared';
import './receivables.css';

interface Row extends ApplyRow {
  id: number;
  num: string;
  date: string;
  total: number;
  fullName: string;
  discountAccountId: number | null;
  discountPct: number;
  discountDate: string | null;
}

interface Form {
  customerId: number | null;
  date: string;
  amount: number | null;
  method: string;
  refNo: string;
  memo: string;
  depositTo: number | null;
  rows: Row[];
}

/** Result of the Discount Info dialog. */
export interface DiscountResult {
  discount: number;
  accountId: number | null;
}

const newForm = (customerId: number | null, depositTo: number | null): Form => ({
  customerId,
  date: todayIso(),
  amount: null,
  method: '',
  refNo: '',
  memo: '',
  depositTo,
  rows: [],
});

/** What counts for "unsaved changes". */
function serialize(f: Form): string {
  return JSON.stringify({
    ...f,
    rows: f.rows.filter((r) => r.payment || r.discount).map((r) => [r.id, r.payment, r.discount, r.discountAccountId]),
  });
}

function toRows(list: OpenInvoice[], applied: boolean, accounts: Map<number, number | null>): Row[] {
  return list.map((o) => ({
    id: o.id,
    num: o.num,
    date: o.date,
    total: o.total,
    fullName: o.full_name,
    due: o.open_balance,
    payment: applied ? o.applied_by_payment : 0,
    discount: applied ? o.discount_by_payment : 0,
    discountAccountId: applied ? accounts.get(o.id) ?? null : null,
    discountPct: o.discount_pct,
    discountDate: o.discount_date,
  }));
}

export function ReceivePayments({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const propCustomer = (props.customerId as number | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: customers } = useData<Name[]>('/api/names?kind=customer');
  const ufId = accounts?.find((a) => a.system_role === 'UNDEPOSITED')?.id ?? null;
  const [form, setForm, formRef] = useLiveState<Form>(() => newForm(propCustomer, null));
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const [depositId, setDepositId] = useState<number | null>(null);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(propId !== null);
  const busy = useRef(false);
  const rowsSeq = useRef(0);
  const curRow = useRef(0);
  const focusReq = useRef<number | 'customer' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const markClean = () => {
    snapshot.current = serialize(formRef.current);
  };

  // Deposit To defaults to Undeposited Funds once the accounts are known.
  useEffect(() => {
    if (ufId === null || txnIdRef.current !== null || formRef.current.depositTo !== null) return;
    const clean = !isDirty();
    setForm((f) => ({ ...f, depositTo: ufId }));
    if (clean) markClean();
  }, [ufId]);

  /** Load the customer's open invoices (for a new customer choice: nothing applied, then auto-apply). */
  const loadRows = async (customerId: number | null) => {
    const seq = ++rowsSeq.current;
    if (customerId === null) {
      setForm((f) => ({ ...f, rows: [] }));
      return;
    }
    try {
      const pid = txnIdRef.current;
      const list = await api.get<OpenInvoice[]>(
        `/api/customers/${customerId}/open-invoices${pid !== null ? `?payment_id=${pid}` : ''}`,
      );
      if (seq !== rowsSeq.current) return;
      setForm((f) => (f.customerId !== customerId ? f : { ...f, rows: autoApply(toRows(list, false, new Map()), f.amount ?? 0) }));
    } catch (e) {
      if (seq === rowsSeq.current) setError(errorMessage(e));
    }
  };

  const startNew = (customerId: number | null = null) => {
    rowsSeq.current++;
    const f = newForm(customerId, ufId);
    setForm(f);
    setTxnId(null);
    setDepositId(null);
    version.current = undefined;
    setError(null);
    curRow.current = 0;
    markClean();
    focusReq.current = 'customer';
    if (customerId !== null) {
      // The invoices arriving is not a change she made.
      void loadRows(customerId).then(() => {
        if (formRef.current.customerId === customerId && formRef.current.amount === null) markClean();
      });
    }
  };

  const load = async (id: number) => {
    setLoading(true);
    rowsSeq.current++;
    try {
      const t = await api.get<DocTxn>(`/api/txns/${id}`);
      if (handOffLocked(desk, winId, t)) return;
      if (t.type !== 'PAYMENT') throw new Error('That transaction is not a payment.');
      const list = await api.get<OpenInvoice[]>(`/api/customers/${t.name_id}/open-invoices?payment_id=${id}`);
      const accts = new Map(t.links_out.filter((l) => l.kind === 'apply').map((l) => [l.txn_id, l.discount_account_id]));
      const f: Form = {
        customerId: t.name_id,
        date: t.date,
        amount: t.total,
        method: t.pay_method,
        refNo: t.ref_no,
        memo: t.memo,
        depositTo: t.account_id,
        rows: toRows(list, true, accts),
      };
      setForm(f);
      setTxnId(id);
      setDepositId(t.deposit_id);
      version.current = t.version;
      setError(null);
      curRow.current = 0;
      markClean();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (propId !== null) void load(propId);
    else startNew(propCustomer);
  }, [propId]);

  useLayoutEffect(() => {
    const req = focusReq.current;
    if (req === null || loading) return;
    focusReq.current = null;
    const sel = req === 'customer' ? '[data-field="customer"]' : `[data-row="${req}"][data-col="pay"]`;
    rootRef.current?.querySelector<HTMLElement>(sel)?.focus();
  });

  const customerOptions = useMemo(
    () =>
      (customers ?? [])
        .filter((c) => !c.inactive || c.id === form.customerId)
        .map((c) => ({ id: c.id, label: c.full_name })),
    [customers, form.customerId],
  );
  const depositOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => (a.type === 'BANK' || a.type === 'OCA') && (!a.inactive || a.id === form.depositTo))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, form.depositTo],
  );
  const customer = customers?.find((c) => c.id === form.customerId) ?? null;

  const edit = (change: (f: Form) => Form) => {
    setError(null);
    setForm(change);
  };

  const setCustomer = (id: number | null) => {
    if (id === formRef.current.customerId) return;
    edit((f) => ({ ...f, customerId: id, rows: [] }));
    curRow.current = 0;
    void loadRows(id);
  };

  const setAmount = (amount: number | null) =>
    edit((f) => ({ ...f, amount, rows: autoApply(f.rows, amount ?? 0) }));

  const setPayment = (i: number, cents: number | null) =>
    edit((f) => {
      const rows = f.rows.map((r) => ({ ...r }));
      const r = rows[i];
      let v = Math.max(0, cents ?? 0);
      if (v > payable(r)) {
        desk.setStatus(`The payment on invoice ${r.num} cannot be more than the ${formatMoney(payable(r))} it owes.`);
        v = payable(r);
      }
      r.payment = v;
      // Applying more than was received raises the amount received, as QuickBooks does.
      const applied = totalApplied(rows);
      return { ...f, rows, amount: applied > (f.amount ?? 0) ? applied : f.amount };
    });

  const toggle = (i: number) =>
    edit((f) => {
      if (!f.rows[i]) return f;
      const r = toggleRow(f.rows, i, f.amount ?? 0);
      return { ...f, rows: r.rows, amount: r.amount === 0 && f.amount === null ? null : r.amount };
    });

  const applyOrClear = () => {
    commitActiveField();
    const f = formRef.current;
    if (totalApplied(f.rows) > 0) edit((x) => ({ ...x, rows: x.rows.map((r) => ({ ...r, payment: 0 })) }));
    else edit((x) => ({ ...x, rows: autoApply(x.rows, x.amount ?? 0) }));
  };

  const openDiscount = async () => {
    commitActiveField();
    const f = formRef.current;
    const i = Math.min(curRow.current, f.rows.length - 1);
    const r = f.rows[i];
    if (!r) {
      desk.setStatus('There is no invoice to give a discount on.');
      return;
    }
    const res = await desk.openForResult<DiscountResult>('pmtdiscount', {
      num: r.num,
      date: r.date,
      total: r.total,
      due: r.due,
      discount: r.discount,
      accountId: r.discountAccountId,
      discountPct: r.discountPct,
      discountDate: r.discountDate,
      paymentDate: f.date,
    });
    if (!res) {
      focusReq.current = i;
      return;
    }
    edit((x) => {
      const rows = x.rows.map((y) => ({ ...y }));
      const row = rows.find((y) => y.id === r.id);
      if (row) {
        row.discount = res.discount;
        row.discountAccountId = res.discount > 0 ? res.accountId : null;
        row.payment = Math.min(row.payment, payable(row));
      }
      return { ...x, rows };
    });
    focusReq.current = i;
  };

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      if (!(await settleQuickFill())) return;
      const f = formRef.current;
      const id = txnIdRef.current;
      if (id === null && !isDirty()) {
        if (mode === 'close') desk.close(winId);
        else refocus(field);
        return;
      }
      const fail = (msg: string) => {
        setError(msg);
        refocus(field);
      };
      if (f.customerId === null) return fail('Choose the customer the payment is received from.');
      const amount = f.amount ?? 0;
      if (amount <= 0) return fail('Enter the amount of the payment.');
      const applied = totalApplied(f.rows);
      if (applied > amount) {
        return fail(`You applied ${formatMoney(applied)}, but the payment is only ${formatMoney(amount)}. Apply less, or raise the payment amount.`);
      }
      const noAcct = f.rows.find((r) => r.discount > 0 && r.discountAccountId === null);
      if (noAcct) return fail(`Choose the account for the discount on invoice ${noAcct.num} (Discount Info).`);
      const unused = amount - applied;
      if (unused > 0) {
        const who = customer?.full_name ?? 'this customer';
        const ok = await desk.confirm(
          `This payment is ${formatMoney(unused)} more than you applied to invoices.\n\nDo you want to leave the unused ${formatMoney(unused)} as a credit for ${who}?`,
          { title: 'Unused Payment', yes: '&Leave as Credit', no: '&Cancel' },
        );
        if (!ok) {
          refocus(field);
          return;
        }
      }
      const body: PaymentInput = {
        type: 'PAYMENT',
        date: f.date,
        num: '',
        name_id: f.customerId,
        memo: f.memo.trim(),
        amount,
        pay_method: f.method.trim(),
        ref_no: f.refNo.trim(),
        account_id: f.depositTo === ufId ? null : f.depositTo,
        ar_account_id: null,
        applications: f.rows
          .filter((r) => r.payment > 0 || r.discount > 0)
          .map((r) => ({
            txn_id: r.id,
            amount: r.payment,
            discount: r.discount,
            discount_account_id: r.discount > 0 ? r.discountAccountId : null,
          })),
        ...(id !== null ? { version: version.current } : {}),
      };
      let r: { id: number; version: number };
      try {
        r =
          id === null
            ? await api.post<{ id: number; version: number }>('/api/txns', body)
            : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      } catch (e) {
        return fail(errorMessage(e));
      }
      desk.refresh();
      desk.setStatus(`Payment of ${formatMoney(amount)} from ${customer?.full_name ?? 'the customer'} saved.`);
      setError(null);
      if (mode === 'close') desk.close(winId);
      else if (mode === 'new') startNew();
      else {
        setTxnId(r.id);
        version.current = r.version;
        markClean();
        refocus(field);
      }
    } finally {
      busy.current = false;
    }
  };

  /** Ask before leaving unsaved changes (closing, Previous/Next, New). */
  const confirmLeave = async () => {
    const field = commitActiveField({ quiet: true });
    if (loading || !isDirty()) return true;
    if (await desk.confirm('This payment has changes that have not been saved. Do you want to discard changes?', { defaultNo: true }))
      return true;
    refocus(field);
    return false;
  };

  const go = async (dir: 'prev' | 'next') => {
    if (!(await confirmLeave())) return;
    try {
      const id = await adjacentTxn('PAYMENT', txnIdRef.current, dir);
      if (id === null) {
        desk.setStatus(dir === 'prev' ? 'There is no earlier payment.' : 'There is no later payment.');
        return;
      }
      await load(id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const clear = () => {
    commitActiveField({ quiet: true });
    startNew();
  };

  const remove = async () => {
    const id = txnIdRef.current;
    if (id === null) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    try {
      await api.del(`/api/txns/${id}`);
      desk.setStatus('Payment deleted.');
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const history = () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus('Save the payment first to see its history.');
    else desk.open('pmthistory', { id });
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    saveNew: () => void save('new'),
    new: () => void confirmLeave().then((ok) => ok && startNew()),
    delete: txnId !== null ? () => void remove() : undefined,
    history,
    confirmClose: confirmLeave,
  });

  // Up/Down move between invoice rows; Space ticks or unticks the current row.
  const onGridKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLInputElement;
    const row = Number(t.dataset.row);
    if (t.dataset.col !== 'pay' || Number.isNaN(row)) return;
    if (e.key === ' ' && !e.shiftKey) {
      e.preventDefault();
      const r = formRef.current.rows[row];
      const typed = t.value.trim() === '' ? null : parseAmount(t.value);
      // Something typed and not yet entered: Space enters it (which ticks the row).
      if (r && typed !== null && typed !== r.payment) setPayment(row, typed);
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

  const deposited = depositId !== null;
  const applied = totalApplied(form.rows);
  const discounts = form.rows.reduce((t, r) => t + r.discount, 0);
  const amountDue = form.rows.reduce((t, r) => t + r.due, 0);
  const origTotal = form.rows.reduce((t, r) => t + r.total, 0);
  const unused = (form.amount ?? 0) - applied;
  const showJob = form.rows.some((r) => r.fullName !== customer?.full_name);

  return (
    <div className="form-window rcv" ref={rootRef}>
      <div className="rcv-head">
        <label htmlFor={`${winId}-cust`}>Received From</label>
        <Combo
          id={`${winId}-cust`}
          className="rcv-wide"
          options={customerOptions}
          value={form.customerId}
          onChange={setCustomer}
          data-field="customer"
          disabled={loading || deposited}
          {...nameQuickFill(desk, 'customer')}
        />
        <span className="rcv-label">Customer Balance</span>
        <span className="readout">{customer ? formatMoney(customer.balance) : ''}</span>
        <label htmlFor={`${winId}-date`}>Date</label>
        <DateField
          id={`${winId}-date`}
          value={form.date}
          onChange={(date) => edit((f) => ({ ...f, date }))}
          disabled={loading}
        />
        <label htmlFor={`${winId}-amt`}>Amount</label>
        <AmountField
          id={`${winId}-amt`}
          className="rcv-amount"
          value={form.amount}
          onChange={setAmount}
          disabled={loading || deposited}
        />
        <label htmlFor={`${winId}-meth`}>Pmt. Method</label>
        <PayMethodField
          id={`${winId}-meth`}
          value={form.method}
          onChange={(method) => edit((f) => ({ ...f, method }))}
          disabled={loading}
        />
        <label htmlFor={`${winId}-ref`}>Check No.</label>
        <input
          id={`${winId}-ref`}
          className="field num-field"
          value={form.refNo}
          maxLength={20}
          disabled={loading}
          onChange={(e) => {
            const refNo = e.target.value;
            edit((f) => ({ ...f, refNo }));
          }}
          onFocus={(e) => e.target.select()}
        />
        <label htmlFor={`${winId}-memo`}>Memo</label>
        <input
          id={`${winId}-memo`}
          className="field"
          value={form.memo}
          disabled={loading}
          onChange={(e) => {
            const memo = e.target.value;
            edit((f) => ({ ...f, memo }));
          }}
        />
        <label htmlFor={`${winId}-dep`}>Deposit To</label>
        <Combo
          id={`${winId}-dep`}
          options={depositOptions}
          value={form.depositTo}
          onChange={(depositTo) => edit((f) => ({ ...f, depositTo }))}
          disabled={loading || deposited}
        />
      </div>
      {deposited && (
        <div className="msg-strip">
          This payment has been deposited. Its customer, amount and deposit account cannot be changed until it is removed
          from the deposit.
        </div>
      )}
      {error && <div className="msg-strip error">{error}</div>}
      <div className="grid-wrap rcv-grid">
        <table className="line-grid">
          <colgroup>
            <col style={{ width: '2rem' }} />
            <col style={{ width: '7rem' }} />
            <col style={{ width: showJob ? '6rem' : '9rem' }} />
            {showJob && <col style={{ width: '10rem' }} />}
            <col />
            <col />
            <col style={{ width: '6rem' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="al-center">✓</th>
              <th>Date</th>
              <th>Number</th>
              {showJob && <th>Job</th>}
              <th className="al-right">Orig. Amt.</th>
              <th className="al-right">Amt. Due</th>
              <th className="al-right">Disc.</th>
              <th className="al-right">Payment</th>
            </tr>
          </thead>
          <tbody onKeyDown={onGridKey}>
            {form.rows.map((r, i) => (
              <tr key={r.id} onFocus={() => (curRow.current = i)}>
                <td className="al-center rcv-check" onClick={() => !loading && toggle(i)}>
                  {r.payment > 0 ? '✓' : ''}
                </td>
                <td className="cell-text">{formatUsDate(r.date)}</td>
                <td className="cell-text">{r.num}</td>
                {showJob && <td className="cell-text">{r.fullName}</td>}
                <td className="cell-text al-right">{formatMoney(r.total)}</td>
                <td className="cell-text al-right">{formatMoney(r.due)}</td>
                <td className="cell-text al-right">{r.discount ? formatMoney(r.discount) : ''}</td>
                <td>
                  <AmountField
                    value={r.payment || null}
                    onChange={(v) => setPayment(i, v)}
                    data-row={i}
                    data-col="pay"
                    aria-label={`Payment on invoice ${r.num}`}
                    disabled={loading}
                  />
                </td>
              </tr>
            ))}
            {form.rows.length === 0 && (
              <tr>
                <td colSpan={showJob ? 8 : 7} className="cell-text grey">
                  {form.customerId === null ? 'Choose a customer to see the open invoices.' : 'This customer has no open invoices.'}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={showJob ? 4 : 3} className="al-right total-label">
                Totals
              </td>
              <td className="al-right total">{formatMoney(origTotal)}</td>
              <td className="al-right total">{formatMoney(amountDue)}</td>
              <td className="al-right total">{discounts ? formatMoney(discounts) : ''}</td>
              <td className="al-right total">{formatMoney(applied)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="rcv-lower">
        <div className="rcv-buttons">
          <button type="button" className="btn" disabled={loading || form.rows.length === 0} onClick={() => void openDiscount()}>
            Discount Info...
          </button>
          <button type="button" className="btn" disabled={loading || form.rows.length === 0} onClick={applyOrClear}>
            {applied > 0 ? 'Clear Payments' : 'Auto Apply'}
          </button>
          <span className="hint">Space ticks the invoice you are on.</span>
        </div>
        <div className="rcv-sums">
          <span>Amounts Due</span>
          <span className="readout">{formatMoney(amountDue)}</span>
          <span>Applied</span>
          <span className="readout">{formatMoney(applied)}</span>
          <span>Discount</span>
          <span className="readout">{formatMoney(discounts)}</span>
          <span>{unused < 0 ? 'Over-applied' : 'Unused Payment'}</span>
          <span className={`readout${unused < 0 ? ' error-text' : ''}`}>{formatMoney(Math.abs(unused))}</span>
        </div>
      </div>
      <div className="button-row">
        <button type="button" className="btn" disabled={loading} onClick={() => void go('prev')}>
          Previous
        </button>
        <button type="button" className="btn" disabled={loading || txnId === null} onClick={() => void go('next')}>
          Next
        </button>
        <button type="button" className="btn" disabled={loading} onClick={history} title="Ctrl+H">
          History
        </button>
        <span className="spacer" />
        <button type="button" className="btn default" disabled={loading} onClick={() => void save('close')}>
          <Mnemonic label="&Save && Close" />
        </button>
        <button type="button" className="btn" disabled={loading} onClick={() => void save('new')}>
          <Mnemonic label="Save && &New" />
        </button>
        {txnId === null ? (
          <button type="button" className="btn" disabled={loading} onClick={clear}>
            Clear
          </button>
        ) : (
          <button type="button" className="btn" disabled={loading} onClick={() => void remove()} title="Ctrl+D">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
