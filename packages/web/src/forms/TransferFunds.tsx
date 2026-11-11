import { accountType, formatMoney, todayIso, type Account, type PurchTxn, type TransferInput } from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { EndingBalance, firstBankId } from './checkShared';
import './sales.css';
import './banking.css';

interface Form {
  date: string;
  fromId: number | null;
  toId: number | null;
  amount: number | null;
  memo: string;
}
const DEFAULT_MEMO = 'Funds Transfer';
const newForm = (fromId: number | null = null): Form => ({ date: todayIso(), fromId, toId: null, amount: null, memo: DEFAULT_MEMO });
const serialize = (f: Form) => JSON.stringify(f);

/** Balance sheet accounts other than A/R and A/P: what Transfer Funds can move money between. */
const transferable = (a: Account) => accountType(a.type).balanceSheet && a.type !== 'AR' && a.type !== 'AP';

/** Banking > Transfer Funds. Props: { id: number | null }. */
export function TransferFunds({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const [form, setForm, formRef] = useLiveState<Form>(() => newForm());
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const markClean = () => {
    snapshot.current = serialize(formRef.current);
  };
  const focusFirst = () => {
    wantFocus.current = true;
  };
  useLayoutEffect(() => {
    if (!wantFocus.current || loading) return;
    wantFocus.current = false;
    rootRef.current?.querySelector<HTMLInputElement>('[data-field="date"]')?.focus();
  });

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const startNew = (fromId?: number | null) => {
    setForm(newForm(fromId !== undefined ? fromId : formRef.current.fromId));
    markClean();
    setTxnId(null);
    version.current = undefined;
    setError(null);
    focusFirst();
  };

  const load = async (id: number): Promise<boolean> => {
    try {
      const t = await api.get<PurchTxn>(`/api/txns/${id}`);
      if (t.type !== 'TRANSFER') {
        setError('That transaction is not a transfer.');
        return false;
      }
      setForm({ date: t.date, fromId: t.account_id, toId: t.to_account_id, amount: t.total, memo: t.memo });
      markClean();
      version.current = t.version;
      setTxnId(t.id);
      setError(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !accounts) return;
    opened.current = true;
    if (propId === null) {
      startNew(firstBankId(accounts));
      setLoading(false);
    } else void load(propId).finally(() => setLoading(false));
  }, [accounts]);

  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const id = txnIdRef.current;
    if (f.fromId === null) return fail('Choose the account to transfer funds from.');
    if (f.toId === null) return fail('Choose the account to transfer funds to.');
    if (f.amount === null || f.amount <= 0) return fail('Enter the amount to transfer.');
    const body: TransferInput = {
      type: 'TRANSFER',
      date: f.date,
      num: '',
      name_id: null,
      memo: f.memo,
      ...(id !== null ? { version: version.current } : {}),
      from_account_id: f.fromId,
      to_account_id: f.toId,
      amount: f.amount,
    };
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      setTxnId(r.id);
      version.current = r.version;
      markClean();
      setError(null);
      desk.refresh();
      desk.setStatus(`Transfer of ${formatMoney(f.amount)} saved.`);
      return true;
    } catch (e) {
      return fail(errorMessage(e));
    }
  };
  function fail(msg: string): false {
    setError(msg);
    return false;
  }

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      if (!(await settleQuickFill())) return;
      if (isDirty() && !(await persist())) {
        refocus(field);
        return;
      }
      if (mode === 'close') desk.close(winId);
      else if (mode === 'new') startNew();
      else refocus(field);
    } finally {
      busy.current = false;
    }
  };

  const askSave = async (quiet = false): Promise<boolean> => {
    const field = commitActiveField({ quiet });
    if (!quiet && !(await settleQuickFill())) return false;
    if (!isDirty()) return true;
    const i = await desk.messageBox('You have changed the transfer. Do you want to save the changes?', {
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
      const id = txnIdRef.current;
      const adj = await api.get<{ prev: number | null; next: number | null }>(`/api/txns/adjacent?type=TRANSFER&id=${id ?? ''}`);
      const target = dir === 'prev' ? adj.prev : adj.next;
      if (target !== null) {
        await load(target);
        focusFirst();
      } else if (dir === 'next' && id !== null) startNew();
      else desk.setStatus(dir === 'prev' ? 'This is the first transfer.' : 'This is the last transfer.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const clearOrRevert = async () => {
    if (busy.current || loading) return;
    commitActiveField({ quiet: true });
    const id = txnIdRef.current;
    if (id === null) {
      startNew();
      return;
    }
    if (isDirty() && !(await desk.confirm('Do you want to undo the changes you have made to this transaction?'))) return;
    busy.current = true;
    try {
      await load(id);
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    const id = txnIdRef.current;
    if (id === null || busy.current) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    busy.current = true;
    try {
      await api.del(`/api/txns/${id}`);
      desk.setStatus('Transfer deleted.');
      desk.refresh();
      startNew();
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const journal = () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus('Save the transfer first to see its transaction journal.');
    else desk.open('txnjournal', { txnId: id });
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    saveNew: () => void save('new'),
    new: () => {
      if (busy.current) return;
      busy.current = true;
      void askSave()
        .then((ok) => {
          if (ok) startNew();
        })
        .finally(() => (busy.current = false));
    },
    delete: txnId !== null ? () => void remove() : undefined,
    register: () => {
      const id = formRef.current.fromId;
      if (id !== null) desk.open('register', { accountId: id });
    },
    txnJournal: journal,
    confirmClose: () => (loading ? true : askSave(true)),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || loading) return;
    const fn = e.code === 'KeyP' ? () => void go('prev') : e.code === 'KeyX' ? () => void go('next') : undefined;
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const options = useMemo(() => {
    const keep = new Set([form.fromId, form.toId]);
    return (accounts ?? []).filter((a) => transferable(a) && (!a.inactive || keep.has(a.id))).map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, form.fromId, form.toId]);
  const dis = loading;

  return (
    <div className="form-window bk-form" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="form-toolbar">
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('prev')} title="Alt+P">
          <Mnemonic label="&Previous" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('next')} title="Alt+X">
          <Mnemonic label="Ne&xt" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={journal} title="Ctrl+Y">
          Journal
        </button>
      </div>
      {error && <div className="msg-strip error">{error}</div>}
      <h2 className="bk-title">Transfer Funds Between Accounts</h2>
      <div className="bk-transfer">
        <label htmlFor={`${winId}-date`}>Date</label>
        <div>
          <DateField id={`${winId}-date`} data-field="date" value={form.date} disabled={dis} onChange={(date) => set({ date })} />
        </div>
        <span />
        <label htmlFor={`${winId}-from`}>Transfer Funds From</label>
        <Combo
          id={`${winId}-from`}
          options={options}
          value={form.fromId}
          onChange={(fromId) => set({ fromId })}
          disabled={dis}
          {...accountQuickFill(desk, { type: 'BANK' })}
        />
        <EndingBalance accounts={accounts} id={form.fromId} />
        <label htmlFor={`${winId}-to`}>Transfer Funds To</label>
        <Combo
          id={`${winId}-to`}
          options={options}
          value={form.toId}
          onChange={(toId) => set({ toId })}
          disabled={dis}
          {...accountQuickFill(desk, { type: 'BANK' })}
        />
        <EndingBalance accounts={accounts} id={form.toId} />
        <label htmlFor={`${winId}-amt`}>Transfer Amount $</label>
        <div>
          <AmountField id={`${winId}-amt`} className="bk-xfer-amt" value={form.amount} disabled={dis} onChange={(amount) => set({ amount })} />
        </div>
        <span />
        <label htmlFor={`${winId}-memo`}>Memo</label>
        <input id={`${winId}-memo`} className="field" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
        <span />
      </div>
      <div className="button-row">
        <span className="spacer" />
        <button type="button" className="btn default" disabled={dis} onClick={() => void save('close')} title="Alt+S">
          <Mnemonic label="&Save && Close" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void save('new')} title="Alt+N">
          <Mnemonic label="Save && &New" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void clearOrRevert()}>
          {txnId === null ? 'Clear' : 'Revert'}
        </button>
      </div>
    </div>
  );
}
