import {
  addDays,
  formatMoney,
  formatUsDate,
  todayIso,
  type Account,
  type PayBillsInput,
  type PayBillsResult,
  type UnpaidBill,
} from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField, parseAmount } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import {
  creditsUsed,
  creditUseElsewhere,
  isSelected,
  mergeRows,
  payMax,
  setCredits,
  setDiscount,
  setPay,
  toggle,
  totals,
  type CreditUse,
  type PayRow,
} from './payBillsMath';
import type { BillDiscountResult } from './PurchaseDialogs';
import { openPdfs, PDF_BLOCKED } from './salesDoc';
import './receivables.css';
import './purchases.css';

interface Row extends PayRow {
  bill: UnpaidBill;
}

interface Form {
  showAll: boolean;
  dueBy: string;
  sort: 'due_date' | 'vendor';
  payDate: string;
  method: 'check' | 'other';
  toPrint: boolean;
  firstNum: string;
  accountId: number | null;
  rows: Row[];
}

const toRows = (list: UnpaidBill[]): Row[] =>
  list.map((b) => ({ id: b.id, bill: b, open: b.open_balance, pay: 0, discount: 0, discountAccountId: null, credits: [] }));

const billLabel = (b: UnpaidBill) => `${b.full_name}${b.ref_no ? `, ref. ${b.ref_no}` : ''}`;

/** Pay Bills (Vendors menu). Creates one bill payment per vendor. */
export function PayBills({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const [form, setForm, formRef] = useLiveState<Form>(() => ({
    showAll: false,
    dueBy: addDays(todayIso(), 10),
    sort: 'due_date',
    payDate: todayIso(),
    method: 'check',
    toPrint: true,
    firstNum: '',
    accountId: null,
    rows: [],
  }));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const seq = useRef(0);
  const curRow = useRef(0);
  const focusReq = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstNumTouched = useRef(false);

  const firstBank = accounts?.find((a) => a.type === 'BANK' && !a.inactive)?.id ?? null;
  useEffect(() => {
    if (firstBank !== null && formRef.current.accountId === null) setForm((f) => ({ ...f, accountId: firstBank }));
  }, [firstBank]);

  /** (Re)load the unpaid bills, keeping what is chosen on bills still listed. */
  const loadRows = async () => {
    const n = ++seq.current;
    const f = formRef.current;
    const q = new URLSearchParams({ sort: f.sort, pay_date: f.payDate });
    if (!f.showAll) q.set('due_on_or_before', f.dueBy);
    try {
      const list = await api.get<UnpaidBill[]>(`/api/bills/unpaid?${q.toString()}`);
      if (n !== seq.current) return;
      setForm((x) => ({ ...x, rows: mergeRows(toRows(list), x.rows) }));
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(errorMessage(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    void loadRows();
  }, [form.showAll, form.dueBy, form.sort, form.payDate]);

  // The starting check number: the next one on the account (until she types her own).
  useEffect(() => {
    const acct = form.accountId;
    if (acct === null || form.method !== 'check' || firstNumTouched.current) return;
    let cancelled = false;
    api.get<{ num: string }>(`/api/txns/next-num?type=BILLPMT&account_id=${acct}`).then(
      ({ num }) => {
        if (!cancelled && !firstNumTouched.current) setForm((f) => ({ ...f, firstNum: num }));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [form.accountId, form.method, desk.dataVersion]);

  useLayoutEffect(() => {
    const r = focusReq.current;
    if (r === null) return;
    focusReq.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${r}"][data-col="pay"]`)?.focus();
  });

  const edit = (change: (f: Form) => Form) => {
    setError(null);
    setForm(change);
  };
  const editRow = (i: number, change: (r: Row) => Row) =>
    edit((f) => {
      if (!f.rows[i]) return f;
      const rows = [...f.rows];
      rows[i] = change(rows[i]);
      return { ...f, rows };
    });

  const payAll = () => {
    commitActiveField();
    edit((f) => ({ ...f, rows: f.rows.map((r) => (isSelected(r) ? { ...r, pay: payMax(r) } : toggle(r))) }));
  };
  const clearAll = () => {
    commitActiveField();
    edit((f) => ({ ...f, rows: f.rows.map((r) => (isSelected(r) ? toggle(r) : r)) }));
  };

  const current = () => {
    const f = formRef.current;
    const i = Math.min(curRow.current, f.rows.length - 1);
    return i >= 0 ? { i, r: f.rows[i] } : null;
  };

  const openDiscount = async () => {
    commitActiveField();
    const c = current();
    if (!c) {
      desk.setStatus('There is no bill to give a discount on.');
      return;
    }
    const { i, r } = c;
    const res = await desk.openForResult<BillDiscountResult>('billdiscount', {
      label: billLabel(r.bill),
      date: r.bill.date,
      total: r.bill.total,
      open: r.open,
      credits: creditsUsed(r),
      discount: r.discount,
      accountId: r.discountAccountId,
      suggested: r.bill.suggested_discount,
      discountPct: r.bill.discount_pct,
      discountDate: r.bill.discount_date,
      payDate: formRef.current.payDate,
    });
    if (res) editRow(i, (x) => (x.id === r.id ? setDiscount(x, res.discount, res.accountId) : x));
    focusReq.current = i;
  };

  const openCredits = async () => {
    commitActiveField();
    const c = current();
    if (!c) {
      desk.setStatus('There is no bill to apply credits to.');
      return;
    }
    const { i, r } = c;
    const res = await desk.openForResult<CreditUse[]>('billcredits', {
      label: billLabel(r.bill),
      vendorId: r.bill.name_id,
      apAccountId: r.bill.ap_account_id,
      open: r.open,
      discount: r.discount,
      current: r.credits,
      elsewhere: [...creditUseElsewhere(formRef.current.rows, r.id).entries()],
    });
    if (res) editRow(i, (x) => (x.id === r.id ? setCredits(x, res) : x));
    focusReq.current = i;
  };

  const isDirty = () => formRef.current.rows.some(isSelected);

  const pay = async (mode: 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      if (!(await settleQuickFill())) return;
      const f = formRef.current;
      const fail = (m: string) => {
        setError(m);
        refocus(field);
      };
      const chosen = f.rows.filter(isSelected);
      if (chosen.length === 0) return fail('Select the bills to pay: Space ticks the bill you are on.');
      if (f.accountId === null) return fail('Choose the account to pay from.');
      const noAcct = chosen.find((r) => r.discount > 0 && r.discountAccountId === null);
      if (noAcct) return fail(`Choose the discount account for ${billLabel(noAcct.bill)} (Set Discount).`);
      if (f.method === 'check' && !f.toPrint && !/^\d+$/.test(f.firstNum.trim()))
        return fail('Enter the first check number (digits only), or choose To be printed.');
      const body: PayBillsInput = {
        date: f.payDate,
        account_id: f.accountId,
        method: f.method,
        to_print: f.method === 'check' && f.toPrint,
        first_check_num: f.method === 'check' && !f.toPrint ? f.firstNum.trim() : '',
        memo: '',
        payments: chosen
          .filter((r) => r.pay > 0 || r.discount > 0)
          .map((r) => ({
            bill_id: r.id,
            amount: r.pay,
            discount: r.discount,
            discount_account_id: r.discount > 0 ? r.discountAccountId : null,
          })),
        credits: chosen.flatMap((r) => r.credits.filter((c) => c.amount > 0).map((c) => ({ credit_id: c.creditId, bill_id: r.id, amount: c.amount }))),
      };
      let res: PayBillsResult;
      try {
        res = await api.post<PayBillsResult>('/api/pay-bills', body);
      } catch (e) {
        return fail(errorMessage(e));
      }
      desk.refresh();
      firstNumTouched.current = false;
      const n = res.payments.length;
      const amount = res.payments.reduce((t, p) => t + p.amount, 0);
      const nums = res.payments.map((p) => p.num).filter(Boolean);
      desk.setStatus(`${n} bill payment${n === 1 ? '' : 's'} of ${formatMoney(amount)} created.`);
      if (n === 0) {
        await desk.alert('The credits were applied. No payments were needed.', { title: 'Payment Summary', icon: 'info' });
      } else {
        const what =
          f.method === 'other'
            ? `${n === 1 ? 'One payment was' : `${n} payments were`} created, for ${formatMoney(amount)} in all.`
            : `${n === 1 ? 'One check was' : `${n} checks were`} created, for ${formatMoney(amount)} in all` +
              (nums.length ? ` (check no. ${nums.join(', ')}).` : f.toPrint ? ', to be printed.' : '.');
        const print = await desk.confirm(`${what}\n\nDo you want to print the check records now?`, {
          title: 'Payment Summary',
          yes: '&Print',
          no: '&Done',
          icon: 'info',
        });
        if (print) {
          if (!openPdfs(res.payments.map((p) => p.id))) desk.setStatus(PDF_BLOCKED);
        }
      }
      if (mode === 'close') desk.close(winId);
      else {
        setForm((x) => ({ ...x, rows: [] }));
        curRow.current = 0;
        await loadRows();
        focusReq.current = 0;
      }
    } finally {
      busy.current = false;
    }
  };

  const confirmLeave = async () => {
    const field = commitActiveField({ quiet: true });
    if (!isDirty()) return true;
    if (await desk.confirm('You have selected bills to pay. Do you want to close Pay Bills without paying them?', { defaultNo: true })) return true;
    refocus(field);
    return false;
  };

  useWindowCommands(winId, {
    save: () => void pay('new'),
    saveClose: () => void pay('close'),
    saveNew: () => void pay('new'),
    confirmClose: confirmLeave,
  });

  // Alt keys (letters no menu uses): Pay All, Clear Selections, Set Discount, Set Credits.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act: Record<string, () => void> = {
      KeyA: payAll,
      KeyI: clearAll,
      KeyD: () => void openDiscount(),
      KeyT: () => void openCredits(),
    };
    const fn = act[e.code];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  // In the Amt. To Pay column: Space ticks/unticks, Up/Down move between bills.
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
      if (r && typed !== null && typed !== r.pay) editRow(row, (x) => setPay(x, typed));
      else editRow(row, toggle);
      requestAnimationFrame(() => t.isConnected && t.select());
      return;
    }
    if (e.shiftKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= formRef.current.rows.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-col="pay"]`)?.focus();
  };

  const accountOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => (a.type === 'BANK' || (form.method === 'other' && a.type === 'CC')) && (!a.inactive || a.id === form.accountId))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, form.method, form.accountId],
  );
  const account = accounts?.find((a) => a.id === form.accountId) ?? null;
  const sums = totals(form.rows);
  const dis = loading;

  return (
    <div className="form-window pb" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="pb-top">
        <fieldset className="groupbox pb-show">
          <legend>Show bills</legend>
          <label className="check">
            <input type="radio" name={`${winId}-show`} checked={!form.showAll} onChange={() => edit((f) => ({ ...f, showAll: false }))} />
            Due on or before
          </label>
          <DateField value={form.dueBy} disabled={form.showAll} onChange={(dueBy) => edit((f) => ({ ...f, dueBy }))} aria-label="Due on or before" />
          <label className="check">
            <input type="radio" name={`${winId}-show`} checked={form.showAll} onChange={() => edit((f) => ({ ...f, showAll: true }))} />
            Show all bills
          </label>
        </fieldset>
        <label className="inline-fields">
          Sort Bills By
          <select className="field" value={form.sort} onChange={(e) => edit((f) => ({ ...f, sort: e.target.value as Form['sort'] }))}>
            <option value="due_date">Due Date</option>
            <option value="vendor">Vendor</option>
          </select>
        </label>
      </div>
      {error && <div className="msg-strip error">{error}</div>}
      <div className="grid-wrap pb-grid">
        <table className="line-grid">
          <colgroup>
            <col style={{ width: '2rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col />
            <col style={{ width: '6rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col style={{ width: '7.5rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col style={{ width: '6.5rem' }} />
            <col style={{ width: '8rem' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="al-center">✓</th>
              <th>Date Due</th>
              <th>Vendor</th>
              <th>Ref. No.</th>
              <th>Disc. Date</th>
              <th className="al-right">Amt. Due</th>
              <th className="al-right">Disc. Used</th>
              <th className="al-right">Credits Used</th>
              <th className="al-right">Amt. To Pay</th>
            </tr>
          </thead>
          <tbody onKeyDown={onGridKey}>
            {form.rows.map((r, i) => {
              const cr = creditsUsed(r);
              return (
                <tr key={r.id} onFocus={() => (curRow.current = i)}>
                  <td className="al-center rcv-check" onClick={() => editRow(i, toggle)}>
                    {isSelected(r) ? '✓' : ''}
                  </td>
                  <td className="cell-text">{formatUsDate(r.bill.due_date)}</td>
                  <td className="cell-text">{r.bill.full_name}</td>
                  <td className="cell-text">{r.bill.ref_no}</td>
                  <td className="cell-text">{r.bill.discount_date ? formatUsDate(r.bill.discount_date) : ''}</td>
                  <td className="cell-text al-right">{formatMoney(r.open)}</td>
                  <td className="cell-text al-right">{r.discount ? formatMoney(r.discount) : ''}</td>
                  <td className="cell-text al-right" title={r.bill.credits_available ? `Vendor credits available: ${formatMoney(r.bill.credits_available)}` : undefined}>
                    {cr ? formatMoney(cr) : r.bill.credits_available ? <span className="grey">avail.</span> : ''}
                  </td>
                  <td>
                    <AmountField
                      value={r.pay || null}
                      onChange={(v) => editRow(i, (x) => setPay(x, v))}
                      data-row={i}
                      data-col="pay"
                      aria-label={`Amount to pay on ${billLabel(r.bill)}`}
                    />
                  </td>
                </tr>
              );
            })}
            {form.rows.length === 0 && (
              <tr>
                <td colSpan={9} className="cell-text grey">
                  {loading ? 'Loading...' : form.showAll ? 'There are no unpaid bills.' : 'No unpaid bills are due by that date. Choose "Show all bills" to see the rest.'}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="al-right total-label">
                Totals
              </td>
              <td className="al-right total">{formatMoney(sums.open)}</td>
              <td className="al-right total">{formatMoney(sums.discount)}</td>
              <td className="al-right total">{formatMoney(sums.credits)}</td>
              <td className="al-right total">{formatMoney(sums.pay)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="rcv-buttons pb-rowbtns">
        <button type="button" className="btn" disabled={dis || form.rows.length === 0} onClick={payAll} title="Alt+A">
          <Mnemonic label="Pay &All Bills" />
        </button>
        <button type="button" className="btn" disabled={dis || form.rows.length === 0} onClick={clearAll} title="Alt+I">
          <Mnemonic label="Clear Select&ions" />
        </button>
        <button type="button" className="btn" disabled={dis || form.rows.length === 0} onClick={() => void openDiscount()} title="Alt+D">
          <Mnemonic label="Set &Discount..." />
        </button>
        <button type="button" className="btn" disabled={dis || form.rows.length === 0} onClick={() => void openCredits()} title="Alt+T">
          <Mnemonic label="Set Credi&ts..." />
        </button>
        <span className="hint">Space ticks the bill you are on.</span>
      </div>
      <div className="pb-lower">
        <label className="stack">
          Payment Date
          <DateField value={form.payDate} onChange={(payDate) => edit((f) => ({ ...f, payDate }))} />
        </label>
        <fieldset className="groupbox pb-method">
          <legend>Payment Method</legend>
          <label className="check">
            <input type="radio" name={`${winId}-meth`} checked={form.method === 'check'} onChange={() =>
                edit((f) => ({
                  ...f,
                  method: 'check',
                  // A check cannot be drawn on a credit card account.
                  accountId: accounts?.find((x) => x.id === f.accountId)?.type === 'BANK' ? f.accountId : firstBank,
                }))
              }
            />
            Check
          </label>
          <div className="pb-sub">
            <label className="check">
              <input
                type="radio"
                name={`${winId}-print`}
                checked={form.toPrint}
                disabled={form.method !== 'check'}
                onChange={() => edit((f) => ({ ...f, toPrint: true }))}
              />
              To be printed
            </label>
            <label className="check">
              <input
                type="radio"
                name={`${winId}-print`}
                checked={!form.toPrint}
                disabled={form.method !== 'check'}
                onChange={() => edit((f) => ({ ...f, toPrint: false }))}
              />
              Assign check no., starting at
            </label>
            <input
              className="field num-field"
              value={form.firstNum}
              maxLength={12}
              disabled={form.method !== 'check' || form.toPrint}
              aria-label="First check number"
              onChange={(e) => {
                firstNumTouched.current = true;
                const firstNum = e.target.value;
                edit((f) => ({ ...f, firstNum }));
              }}
              onFocus={(e) => e.target.select()}
            />
          </div>
          <label className="check">
            <input
              type="radio"
              name={`${winId}-meth`}
              checked={form.method === 'other'}
              onChange={() => edit((f) => ({ ...f, method: 'other' }))}
            />
            Other (credit card, transfer...)
          </label>
        </fieldset>
        <div className="pb-acct">
          <label className="stack">
            Payment Account
            <Combo
              options={accountOptions}
              value={form.accountId}
              onChange={(accountId) => edit((f) => ({ ...f, accountId }))}
              {...accountQuickFill(desk, { type: 'BANK' })}
            />
          </label>
          <div className="pb-bal">
            <span>Ending Balance</span>
            <span className={`readout${account && account.balance - sums.pay < 0 && account.type === 'BANK' ? ' error-text' : ''}`}>
              {account ? formatMoney(account.balance - sums.pay) : ''}
            </span>
          </div>
        </div>
      </div>
      <div className="button-row">
        <span className="spacer" />
        <button type="button" className="btn default" disabled={dis} onClick={() => void pay('close')} title="Alt+S">
          <Mnemonic label="Pay && Clo&se" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void pay('new')} title="Alt+N">
          <Mnemonic label="Pay && &New" />
        </button>
        <button type="button" className="btn" onClick={() => void desk.requestClose(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
