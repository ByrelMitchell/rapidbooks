import {
  addDays,
  formatMoney,
  formatUsDate,
  todayIso,
  type Account,
  type PayBillsInput,
  type PayBillsResult,
  type Terms,
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
  // The highlighted bill (Discount & Credit Information), and Filter By's vendor.
  const [hi, setHi] = useState(0);
  const [vendorFilter, setVendorFilter] = useState<number | null>(null);
  const setHighlight = (i: number) => {
    curRow.current = i;
    setHi(i);
  };
  const { data: terms } = useData<Terms[]>('/api/terms');
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

  const pay = async (mode: 'close' | 'new' | 'summary') => {
    let next: 'close' | 'new' = mode === 'new' ? 'new' : 'close';
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
        // QuickBooks 2013's Payment Summary: Pay More Bills, Print Checks, Done.
        const i = await desk.messageBox(`${what}\n\nDo you want to print the check records now?`, {
          title: 'Payment Summary',
          icon: 'info',
          buttons: ['Pay &More Bills', '&Print Checks', '&Done'],
          defaultButton: 2,
          cancelButton: 2,
        });
        const print = i === 1;
        if (i === 0) next = 'new';
        else if (mode === 'summary') next = 'close';
        if (print) {
          if (!openPdfs(res.payments.map((p) => p.id))) desk.setStatus(PDF_BLOCKED);
        }
      }
      if (next === 'close') desk.close(winId);
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
    save: () => void pay('summary'),
    saveClose: () => void pay('summary'),
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
    // The next row that is shown (Filter By may hide some).
    const step = e.key === 'ArrowDown' ? 1 : -1;
    let next = row + step;
    while (next >= 0 && next < formRef.current.rows.length && !rootRef.current?.querySelector(`[data-row="${next}"][data-col="pay"]`)) next += step;
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
  const shown = (r: Row) => vendorFilter === null || r.bill.name_id === vendorFilter;
  const hiRow = form.rows[hi] && shown(form.rows[hi]) ? form.rows[hi] : null;
  const anySelected = form.rows.some(isSelected);
  const vendorChoices = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of form.rows) seen.set(r.bill.name_id, r.bill.full_name);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [form.rows]);
  const termsName = (id: number | null) => (id === null ? '' : terms?.find((t) => t.id === id)?.name ?? '');

  return (
    <div className="f13 pb" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="f13-page">
        <fieldset className="sec13 pb13-select">
          <legend>Select Bills To Be Paid</legend>
          <div className="pb13-top">
            <span>Show bills</span>
            <div className="pb13-show">
              <label className="check">
                <input type="radio" name={`${winId}-show`} checked={!form.showAll} onChange={() => edit((f) => ({ ...f, showAll: false }))} />
                Due on or before
                <DateField value={form.dueBy} disabled={form.showAll} onChange={(dueBy) => edit((f) => ({ ...f, dueBy }))} aria-label="Due on or before" />
              </label>
              <label className="check">
                <input type="radio" name={`${winId}-show`} checked={form.showAll} onChange={() => edit((f) => ({ ...f, showAll: true }))} />
                Show all bills
              </label>
            </div>
            <div className="pb13-filters">
              <label htmlFor={`${winId}-filter`}>Filter By</label>
              <select id={`${winId}-filter`} className="field" value={vendorFilter ?? ''} onChange={(e) => setVendorFilter(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">All vendors</option>
                {vendorChoices.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <label htmlFor={`${winId}-sort`}>Sort By</label>
              <select id={`${winId}-sort`} className="field" value={form.sort} onChange={(e) => edit((f) => ({ ...f, sort: e.target.value as Form['sort'] }))}>
                <option value="due_date">Due Date</option>
                <option value="vendor">Vendor</option>
              </select>
            </div>
          </div>
          {error && <div className="msg-strip error">{error}</div>}
          <div className="grid-wrap pb13-grid">
            <table className="line-grid">
              <colgroup>
                <col style={{ width: '2rem' }} />
                <col style={{ width: '7%' }} />
                <col />
                <col style={{ width: '8%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '22%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="al-center">✓</th>
                  <th>Date Due</th>
                  <th>Vendor</th>
                  <th>Ref. No.</th>
                  <th>Disc. Date</th>
                  <th>Amt. Due</th>
                  <th>Disc. Used</th>
                  <th>Credits Used</th>
                  <th>Amt. To Pay</th>
                </tr>
              </thead>
              <tbody onKeyDown={onGridKey}>
                {form.rows.map((r, i) => {
                  if (!shown(r)) return null;
                  const cr = creditsUsed(r);
                  return (
                    <tr key={r.id} className="pb13-row" onFocus={() => setHighlight(i)} onMouseDown={() => setHi(i)}>
                      <td className="al-center rcv-check" onClick={() => editRow(i, toggle)}>
                        {isSelected(r) ? '✓' : ''}
                      </td>
                      <td className="cell-text">{formatUsDate(r.bill.due_date)}</td>
                      <td className="cell-text">{r.bill.full_name}</td>
                      <td className="cell-text al-right">{r.bill.ref_no}</td>
                      <td className="cell-text">{r.bill.discount_date ? formatUsDate(r.bill.discount_date) : ''}</td>
                      <td className="cell-text al-right">{formatMoney(r.open)}</td>
                      <td className="cell-text al-right">{formatMoney(r.discount)}</td>
                      <td className="cell-text al-right">{formatMoney(cr)}</td>
                      <td>
                        <AmountField
                          value={r.pay}
                          onChange={(v) => editRow(i, (x) => setPay(x, v))}
                          data-row={i}
                          data-col="pay"
                          aria-label={`Amount to pay on ${billLabel(r.bill)}`}
                        />
                      </td>
                    </tr>
                  );
                })}
                {form.rows.filter(shown).length === 0 && (
                  <tr>
                    <td colSpan={9} className="cell-text grey">
                      {loading ? 'Loading...' : form.showAll ? 'There are no unpaid bills.' : 'No unpaid bills are due by that date. Choose "Show all bills" to see the rest.'}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="al-right">
                    Totals
                  </td>
                  <td className="al-right">{formatMoney(sums.open)}</td>
                  <td className="al-right">{formatMoney(sums.discount)}</td>
                  <td className="al-right">{formatMoney(sums.credits)}</td>
                  <td className="al-right">{formatMoney(sums.pay)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="pb13-rowbtns">
            {anySelected ? (
              <button type="button" className="btn" disabled={dis} onClick={clearAll} title="Alt+I">
                <Mnemonic label="Clear Select&ions" />
              </button>
            ) : (
              <button type="button" className="btn" disabled={dis || form.rows.length === 0} onClick={payAll} title="Alt+A">
                <Mnemonic label="Select &All Bills" />
              </button>
            )}
            <span className="hint">Space ticks the bill you are on.</span>
          </div>
        </fieldset>

        <fieldset className="sec13 pb13-info">
          <legend>Discount &amp; Credit Information for Highlighted Bill</legend>
          <div className="pb13-info-grid">
            <span>Vendor</span>
            <span>{hiRow?.bill.full_name ?? ''}</span>
            <span>Terms</span>
            <span>{hiRow ? termsName(hiRow.bill.terms_id) : ''}</span>
            <span>Total Credits Available</span>
            <b>{formatMoney(hiRow?.bill.credits_available ?? 0)}</b>
            <span>Bill Ref. No.</span>
            <span>{hiRow?.bill.ref_no ?? ''}</span>
            <span>Sugg. Discount</span>
            <b>{formatMoney(hiRow?.bill.suggested_discount ?? 0)}</b>
            <span />
            <span />
          </div>
          <div className="pb13-info-btns">
            <button type="button" className="btn" disabled={!hiRow} onClick={() => hiRow && desk.open('bill', { id: hiRow.id })}>
              Go to Bill
            </button>
            <button type="button" className="btn" disabled={dis || !hiRow} onClick={() => void openDiscount()} title="Alt+D">
              <Mnemonic label="Set &Discount" />
            </button>
            <button type="button" className="btn" disabled={dis || !hiRow} onClick={() => void openCredits()} title="Alt+T">
              <Mnemonic label="Set Credi&ts" />
            </button>
          </div>
        </fieldset>

        <fieldset className="sec13 pb13-pay">
          <legend>Payment</legend>
          <div className="pb13-pay-grid">
            <label className="cap">
              <span>Date</span>
              <DateField value={form.payDate} onChange={(payDate) => edit((f) => ({ ...f, payDate }))} />
            </label>
            <label className="cap">
              <span>Method</span>
              <select
                className="field"
                value={form.method}
                onChange={(e) => {
                  const method = e.target.value as Form['method'];
                  edit((f) => ({
                    ...f,
                    method,
                    // A check cannot be drawn on a credit card account.
                    accountId: method === 'check' && accounts?.find((x) => x.id === f.accountId)?.type !== 'BANK' ? firstBank : f.accountId,
                  }));
                }}
              >
                <option value="check">Check</option>
                <option value="other">Credit Card / Other</option>
              </select>
            </label>
            <div className="pb13-printopts">
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
                Assign check number
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
              </label>
            </div>
            <div className="pb13-acct">
              <label className="cap">
                <span>Account</span>
                <Combo
                  options={accountOptions}
                  value={form.accountId}
                  onChange={(accountId) => edit((f) => ({ ...f, accountId }))}
                  aria-label="Payment account"
                  {...accountQuickFill(desk, { type: 'BANK' })}
                />
              </label>
              <div className="pb13-bal">
                <b>Ending Balance</b>
                <b className={account && account.balance - sums.pay < 0 && account.type === 'BANK' ? 'error-text' : undefined}>
                  {account ? formatMoney(account.balance - sums.pay) : ''}
                </b>
              </div>
            </div>
          </div>
        </fieldset>

        <div className="f13-buttons">
          <button type="button" className="btn primary" disabled={dis || !anySelected} onClick={() => void pay('summary')} title="Alt+S">
            <Mnemonic label="Pay &Selected Bills" />
          </button>
          <button type="button" className="btn" onClick={() => void desk.requestClose(winId)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
