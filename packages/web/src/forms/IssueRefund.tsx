import { formatMoney, formatUsDate, todayIso, type Account, type CheckInput, type DocTxn, type Name, type PurchTxn } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';
import { bankOptions, EndingBalance, firstBankId, nextCheckNum, payeeAddress, useCheckNumGuard } from './checkShared';
import './sales.css';
import './banking.css';

interface Form {
  date: string;
  num: string;
  toPrint: boolean;
  bankId: number | null;
  amount: number | null;
  address: string;
  memo: string;
}

/**
 * Issue a Refund (QuickBooks' window of that name): a check paying a customer back what a
 * credit memo, or a payment not applied to invoices, left them. Props: { id: number | null,
 * creditId?: number }: a new refund of that credit, or the refund check with that id.
 */
export function IssueRefund({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: customers } = useData<Name[]>('/api/names?kind=customer');
  const [creditId, setCreditId] = useState<number | null>((props.creditId as number | undefined) ?? null);
  const [credit, setCredit] = useState<DocTxn | null>(null);
  const [mine, setMine] = useState(0); // this refund's own amount, when editing it
  const [form, setForm, formRef] = useLiveState<Form | null>(null);
  const [txnId, setTxnId] = useState<number | null>(propId);
  const version = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const guard = useCheckNumGuard(desk);
  const autoNum = useRef('');

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  // A saved refund: read the check, then the credit it pays back.
  useEffect(() => {
    if (propId === null) return;
    api.get<PurchTxn>(`/api/txns/${propId}`).then(
      (t) => {
        if (!t.refund) {
          setError('That check is not a refund.');
          return;
        }
        version.current = t.version;
        setMine(t.refund.amount);
        setCreditId(t.refund.credit_id);
        setForm({ date: t.date, num: t.num, toPrint: t.to_print, bankId: t.account_id, amount: t.refund.amount, address: t.address, memo: t.memo });
        guard.markOk(t.account_id, t.num);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [propId]);

  useEffect(() => {
    if (creditId === null) return;
    api.get<DocTxn>(`/api/txns/${creditId}`).then(setCredit, (e) => setError(errorMessage(e)));
  }, [creditId]);

  const customer = customers?.find((c) => c.id === credit?.name_id);
  const available = (credit?.unapplied ?? 0) + mine;

  // A new refund: all that is left of the credit, from the first bank account, by the next check.
  useEffect(() => {
    if (propId !== null || form || !credit || !accounts || !customers) return;
    const bankId = firstBankId(accounts);
    setForm({
      date: todayIso(),
      num: '',
      toPrint: false,
      bankId,
      amount: credit.unapplied ?? 0,
      address: payeeAddress(customer),
      memo: `Refund of ${credit.type === 'PAYMENT' ? 'payment' : 'credit memo'}${credit.num ? ` ${credit.num}` : ''}`,
    });
    if (bankId !== null) void fillNum(bankId);
  }, [credit, accounts, customers]);

  const fillNum = async (bankId: number) => {
    try {
      const num = await nextCheckNum(bankId);
      const f = formRef.current;
      if (!f || f.bankId !== bankId || f.toPrint || (f.num !== '' && f.num !== autoNum.current)) return;
      autoNum.current = num;
      setForm((cur) => (cur ? { ...cur, num } : cur));
    } catch {
      // She can type the number.
    }
  };

  const ok = async () => {
    const f = formRef.current;
    if (busy.current || !f || !credit) return;
    const field = commitActiveField();
    const fail = (msg: string) => {
      setError(msg);
      refocus(field);
    };
    if (f.bankId === null) return fail('Choose the bank account to write the refund check from.');
    if (f.amount === null || f.amount <= 0) return fail('Enter the amount to refund.');
    if (f.amount > available) return fail(`Only ${formatMoney(available)} of this credit is left to refund.`);
    busy.current = true;
    try {
      if (!f.toPrint && !(await guard.ensure(f.bankId, f.num, txnId))) return;
      const body: CheckInput = {
        type: 'CHECK',
        date: f.date,
        num: f.toPrint ? '' : f.num.trim(),
        to_print: f.toPrint,
        account_id: f.bankId,
        name_id: credit.name_id,
        address: f.address,
        memo: f.memo,
        ...(txnId !== null ? { version: version.current } : {}),
        expenses: [],
        items: [],
        refund: { credit_id: credit.id, amount: f.amount },
      };
      const r =
        txnId === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${txnId}`, body);
      setTxnId(r.id);
      desk.refresh();
      desk.setStatus(`Refund check${body.num ? ` ${body.num}` : ''} of ${formatMoney(f.amount)} to ${customer?.full_name ?? 'the customer'} saved${f.toPrint ? ', to be printed' : ''}.`);
      desk.close(winId);
    } catch (e) {
      fail(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (txnId === null || busy.current) return;
    if (!(await desk.confirm('Are you sure you want to delete this refund? The credit will be available again.', { yes: '&OK', no: '&Cancel' }))) return;
    busy.current = true;
    try {
      await api.del(`/api/txns/${txnId}`);
      desk.refresh();
      desk.setStatus('Refund deleted.');
      desk.close(winId);
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  useWindowCommands(winId, {
    save: () => void ok(),
    saveClose: () => void ok(),
    delete: txnId !== null ? () => void remove() : undefined,
    register: () => {
      const id = formRef.current?.bankId;
      if (id != null) desk.open('register', { accountId: id });
    },
  });

  const banks = useMemo(() => bankOptions(accounts, form?.bankId ?? null), [accounts, form?.bankId]);
  const creditLabel = credit ? `${credit.type === 'PAYMENT' ? 'Payment' : 'Credit memo'}${credit.num ? ` ${credit.num}` : ''} of ${formatUsDate(credit.date)}` : '';

  return (
    <form
      className="dialog refund13"
      onSubmit={(e) => {
        e.preventDefault();
        void ok();
      }}
    >
      {error && <div className="msg-strip error">{error}</div>}
      <div className="info-grid">
        <span>Refund issued to</span>
        <span>
          <b>{customer?.full_name ?? ''}</b>
        </span>
        <span>For</span>
        <span>{creditLabel}</span>
        <span>Available to refund</span>
        <span>{credit ? formatMoney(available) : ''}</span>
      </div>
      {form && (
        <div className="form-grid dlg-fields">
          <label htmlFor={`${winId}-addr`}>Address</label>
          <textarea id={`${winId}-addr`} className="field addr-box" rows={4} value={form.address} onChange={(e) => set({ address: e.target.value })} />
          <label htmlFor={`${winId}-date`}>Date</label>
          <DateField id={`${winId}-date`} value={form.date} onChange={(date) => set({ date })} />
          <label htmlFor={`${winId}-amt`}>Refund Amount</label>
          <AmountField id={`${winId}-amt`} className="short-amount" value={form.amount} onChange={(amount) => set({ amount })} />
          <label htmlFor={`${winId}-bank`}>Account</label>
          <span className="refund13-bank">
            <Combo
              id={`${winId}-bank`}
              className="bk-bank"
              options={banks}
              value={form.bankId}
              onChange={(bankId) => {
                set({ bankId });
                if (bankId !== null && txnId === null && (form.num === '' || form.num === autoNum.current)) void fillNum(bankId);
              }}
            />
            <EndingBalance accounts={accounts} id={form.bankId} />
          </span>
          <label htmlFor={`${winId}-num`}>Check No.</label>
          <span className="refund13-num">
            <input
              id={`${winId}-num`}
              className="field num-field"
              value={form.toPrint ? '' : form.num}
              disabled={form.toPrint}
              maxLength={20}
              onChange={(e) => set({ num: e.target.value })}
              onFocus={(e) => e.target.select()}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={form.toPrint}
                onChange={(e) => {
                  const toPrint = e.target.checked;
                  set({ toPrint, num: toPrint ? '' : form.num });
                  if (!toPrint && form.bankId !== null) {
                    autoNum.current = '';
                    void fillNum(form.bankId);
                  }
                }}
              />
              To be printed
            </label>
          </span>
          <label htmlFor={`${winId}-memo`}>Memo</label>
          <input id={`${winId}-memo`} className="field" value={form.memo} onChange={(e) => set({ memo: e.target.value })} />
        </div>
      )}
      {!form && !error && <div className="hint">Loading...</div>}
      <div className="button-row right">
        <button type="submit" className="btn default" disabled={!form || !credit}>
          OK
        </button>
        {txnId !== null && (
          <button type="button" className="btn" onClick={() => void remove()}>
            Delete
          </button>
        )}
        <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
