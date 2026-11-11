import {
  amountInWords,
  formatMoney,
  lineAmount,
  todayIso,
  type Account,
  type CheckInput,
  type Item,
  type ItemLine,
  type ItemLineInput,
  type Name,
  type PurchTxn,
} from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import {
  isBlankLine,
  itemMap,
  LineGrid,
  linesForCompare,
  linesTotal,
  newLineKey,
  padLines,
  type GridLine,
  type LineGridHandle,
} from '../controls/LineGrid';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { openQuickReport } from '../reports/open';
import { commitActiveField, isQuietBlur, Mnemonic, refocus, useLiveState } from '../util';
import {
  bankOptions,
  EndingBalance,
  firstBankId,
  isPurchasable,
  nextCheckNum,
  payeeAddress,
  purchaseItems,
  useCheckNumGuard,
} from './checkShared';
import { blankExp, ExpenseGrid, expForCompare, expTotal, isBlankExp, padExp, type ExpenseGridHandle, type ExpRow } from './ExpenseGrid';
import { anyNameQuickFill } from './receivablesShared';
import { openPdf } from './salesDoc';
import './sales.css';
import './banking.css';

interface Form {
  bankId: number | null;
  num: string;
  toPrint: boolean;
  date: string;
  payeeId: number | null;
  /** The check amount as typed, or null = the total of the lines. */
  amount: number | null;
  address: string;
  memo: string;
  expenses: ExpRow[];
  items: GridLine[];
}
type Tab = 'expenses' | 'items';
const MIN_ROWS = 5;

const newForm = (bankId: number | null): Form => ({
  bankId,
  num: '',
  toPrint: false,
  date: todayIso(),
  payeeId: null,
  amount: null,
  address: '',
  memo: '',
  expenses: padExp([], MIN_ROWS),
  items: padLines([], MIN_ROWS),
});

const serialize = (f: Form) =>
  JSON.stringify({ ...f, expenses: expForCompare(f.expenses), items: linesForCompare(f.items) });

/** Stored Items-tab lines as grid rows; an amount other than qty × cost is kept as typed over. */
function itemRows(lines: ItemLine[]): GridLine[] {
  return [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const natural = s.rate !== null ? lineAmount(s.qty, s.rate) : 0;
      return {
        key: newLineKey(),
        itemId: s.item_id,
        description: s.description,
        qty: s.qty,
        rate: s.rate,
        percent: false,
        amount: s.item_id === null ? (s.amount !== 0 ? s.amount : null) : s.amount !== natural ? s.amount : null,
        accountId: null,
      };
    });
}

/** Grid rows to send: blank rows dropped, typed-over amounts kept, the rest computed by the server. */
export function itemLinesToInput(lines: GridLine[]): ItemLineInput[] {
  return lines
    .filter((l) => !isBlankLine(l))
    .map((l) => ({ item_id: l.itemId, description: l.description, qty: l.qty, rate: l.rate, amount: l.amount, name_id: null }));
}

/** Banking > Write Checks (Ctrl+W). Props: { id: number | null, accountId?: number }. */
export function WriteChecks({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const presetBank = (props.accountId as number | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: names } = useData<Name[]>('/api/names');
  const { data: rawItems, error: itemsError } = useData<Item[]>('/api/items');
  const items = useMemo(() => purchaseItems(rawItems), [rawItems]);
  const imap = useMemo(() => itemMap(items), [items]);
  const nameMap = useMemo(() => new Map((names ?? []).map((n) => [n.id, n])), [names]);
  const customers = useMemo(() => names?.filter((n) => n.kind === 'customer'), [names]);

  const [form, setForm, formRef] = useLiveState<Form>(() => newForm(presetBank));
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const autoNum = useRef('');
  const [tab, setTab] = useState<Tab>('expenses');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLInputElement>(null);
  const expRef = useRef<ExpenseGridHandle>(null);
  const itemRef = useRef<LineGridHandle>(null);
  const guard = useCheckNumGuard(desk);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const markClean = () => {
    snapshot.current = serialize(formRef.current);
  };
  // Pay to the Order of: now if it can take focus, else after the next render (fields are disabled while loading).
  const wantPayee = useRef(false);
  const focusPayee = () => {
    const el = rootRef.current?.querySelector<HTMLInputElement>('[data-field="payee"]');
    if (el && !el.disabled) el.focus();
    else wantPayee.current = true;
  };
  useLayoutEffect(() => {
    if (!wantPayee.current || loading) return;
    wantPayee.current = false;
    rootRef.current?.querySelector<HTMLInputElement>('[data-field="payee"]')?.focus();
  });
  const focusNum = () => {
    numRef.current?.focus();
    numRef.current?.select();
  };

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  /** The next number for the bank account, unless she has typed her own (or it is to be printed). */
  const fillNextNum = async (bankId: number | null) => {
    if (bankId === null) return;
    try {
      const num = await nextCheckNum(bankId);
      const f = formRef.current;
      if (f.bankId !== bankId || f.toPrint || txnIdRef.current !== null) return;
      if (f.num !== '' && f.num !== autoNum.current) return;
      const clean = !isDirty();
      autoNum.current = num;
      setForm((cur) => ({ ...cur, num }));
      guard.markOk(bankId, num);
      if (clean) markClean();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const applyTxn = (t: PurchTxn) => {
    const f: Form = {
      bankId: t.account_id,
      num: t.to_print ? '' : t.num,
      toPrint: t.to_print,
      date: t.date,
      payeeId: t.name_id,
      amount: null,
      address: t.address,
      memo: t.memo,
      expenses: padExp(
        [...t.expenses]
          .sort((a, b) => a.seq - b.seq)
          .map((e) => ({ ...blankExp(), accountId: e.account_id, amount: e.amount, memo: e.memo, customerId: e.name_id })),
        MIN_ROWS,
      ),
      items: padLines(itemRows(t.items), MIN_ROWS),
    };
    setForm(f);
    markClean();
    autoNum.current = '';
    guard.markOk(t.account_id, f.num);
    version.current = t.version;
    setTxnId(t.id);
    setTab(t.expenses.length === 0 && t.items.length > 0 ? 'items' : 'expenses');
  };

  const load = async (id: number): Promise<boolean> => {
    try {
      const t = await api.get<PurchTxn>(`/api/txns/${id}`);
      if (t.type !== 'CHECK') {
        setError('That transaction is not a check.');
        return false;
      }
      applyTxn(t);
      setError(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  /** A blank check on the given bank account (default: the one on the form, else the first). */
  const startNew = async (bankId?: number | null) => {
    const bank = bankId !== undefined ? bankId : (formRef.current.bankId ?? presetBank ?? firstBankId(accounts));
    setForm(newForm(bank));
    markClean();
    autoNum.current = '';
    setTxnId(null);
    version.current = undefined;
    setError(null);
    setTab('expenses');
    await fillNextNum(bank);
  };

  // Open once the items (for amounts) and accounts (for the default bank) are in.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || (!items && !itemsError) || !accounts) return;
    opened.current = true;
    const p = propId === null ? startNew(presetBank ?? firstBankId(accounts)) : load(propId);
    void p.finally(() => {
      setLoading(false);
      if (propId === null) focusPayee();
    });
  }, [items, itemsError, accounts]);

  // ---- amounts

  const linesSum = (f: Form) => expTotal(f.expenses) + linesTotal(f.items, imap);
  const unassigned = (key: number) => {
    const f = formRef.current;
    if (f.amount === null) return 0;
    const others = f.expenses.reduce((t, r) => t + (r.key === key ? 0 : (r.amount ?? 0)), 0);
    return f.amount - others - linesTotal(f.items, imap);
  };
  const recalculate = () => {
    commitActiveField();
    set({ amount: null });
  };

  // ---- choosing things

  const chooseBank = (bankId: number | null) => {
    const before = formRef.current;
    set({ bankId });
    if (txnIdRef.current === null && !before.toPrint && (before.num === '' || before.num === autoNum.current)) {
      void fillNextNum(bankId);
    }
  };

  const choosePayee = (id: number | null) => {
    set({ payeeId: id });
    if (id === null) return;
    const n = nameMap.get(id);
    if (n) set({ address: payeeAddress(n) });
    else {
      // Just added by Quick Add: the list has not reloaded yet.
      api.get<Name>(`/api/names/${id}`).then(
        (x) => {
          if (formRef.current.payeeId === id) set({ address: payeeAddress(x) });
        },
        () => undefined,
      );
    }
  };

  const setToPrint = (toPrint: boolean) => {
    if (toPrint) {
      autoNum.current = '';
      set({ toPrint, num: '' });
    } else {
      set({ toPrint });
      if (formRef.current.num === '') void fillNextNum(formRef.current.bankId);
    }
  };

  const checkNum = () => {
    if (isQuietBlur()) return;
    const f = formRef.current;
    if (f.toPrint) return;
    void guard.ensure(f.bankId, f.num, txnIdRef.current).then((ok) => {
      if (!ok) focusNum();
    });
  };

  // ---- saving

  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const id = txnIdRef.current;
    if (f.bankId === null) {
      setError('Choose the bank account to write this check from.');
      return false;
    }
    const noAcct = f.expenses.findIndex((r) => !isBlankExp(r) && r.accountId === null);
    if (noAcct >= 0) {
      setTab('expenses');
      setError(`Choose an account for expense line ${noAcct + 1}.`);
      return false;
    }
    const sum = linesSum(f);
    if (f.amount !== null && f.amount !== sum) {
      setError(
        `The check amount (${formatMoney(f.amount)}) does not equal the total of the expense and item lines (${formatMoney(sum)}). ` +
          `Change the lines, or click Recalculate to make the check ${formatMoney(sum)}.`,
      );
      return false;
    }
    if (!f.toPrint && !(await guard.ensure(f.bankId, f.num, id))) {
      focusNum();
      return false;
    }
    const body: CheckInput = {
      type: 'CHECK',
      date: f.date,
      num: f.toPrint ? '' : f.num.trim(),
      to_print: f.toPrint,
      account_id: f.bankId,
      name_id: f.payeeId,
      address: f.address,
      memo: f.memo,
      ...(id !== null ? { version: version.current } : {}),
      expenses: f.expenses
        .filter((r) => !isBlankExp(r))
        .map((r) => ({ account_id: r.accountId, amount: r.amount ?? 0, memo: r.memo, name_id: r.customerId })),
      items: itemLinesToInput(f.items),
    };
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      const t = await api.get<PurchTxn>(`/api/txns/${r.id}`);
      applyTxn(t);
      setError(null);
      desk.refresh();
      desk.setStatus(`Check${t.num ? ` ${t.num}` : ''} for ${formatMoney(t.total)} saved.`);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const commitAndSave = async (): Promise<{ ok: boolean; field: HTMLElement | null }> => {
    const field = commitActiveField();
    if (!(await settleQuickFill())) return { ok: false, field: null };
    if (!isDirty()) return { ok: true, field };
    return { ok: await persist(), field };
  };

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const { ok, field } = await commitAndSave();
      if (!ok) {
        refocus(field);
        return;
      }
      if (mode === 'close') desk.close(winId);
      else if (mode === 'new') {
        await startNew(formRef.current.bankId);
        focusPayee();
      } else refocus(field);
    } finally {
      busy.current = false;
    }
  };

  /** Unsaved changes before leaving this check: Yes saves, No discards, Cancel stays. */
  const askSave = async (quiet = false): Promise<boolean> => {
    const field = commitActiveField({ quiet });
    if (!quiet && !(await settleQuickFill())) return false;
    if (!isDirty()) return true;
    const i = await desk.messageBox('You have changed the check. Do you want to save the changes?', {
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
      const adj = await api.get<{ prev: number | null; next: number | null }>(`/api/txns/adjacent?type=CHECK&id=${id ?? ''}`);
      const target = dir === 'prev' ? adj.prev : adj.next;
      if (target !== null) {
        await load(target);
        focusPayee();
      } else if (dir === 'next' && id !== null) {
        await startNew();
        focusPayee();
      } else {
        desk.setStatus(dir === 'prev' ? 'This is the first check.' : 'This is the last check.');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const clearOrRevert = async () => {
    if (busy.current || loading) return;
    const id = txnIdRef.current;
    if (id === null) {
      commitActiveField({ quiet: true });
      const f = formRef.current;
      setForm({ ...newForm(f.bankId), num: f.num, toPrint: f.toPrint, date: f.date });
      markClean();
      setError(null);
      focusPayee();
      return;
    }
    commitActiveField({ quiet: true });
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
      desk.setStatus(`Check${formRef.current.num ? ` ${formRef.current.num}` : ''} deleted.`);
      desk.refresh();
      await startNew(formRef.current.bankId);
      focusPayee();
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  /** The saved check's id, saving first if needed; null if it could not be saved. */
  const savedId = async (): Promise<number | null> => {
    if (busy.current || loading) return null;
    busy.current = true;
    try {
      const { ok, field } = await commitAndSave();
      if (!ok) {
        refocus(field);
        return null;
      }
      const id = txnIdRef.current;
      if (id === null) setError('Fill in the check first.');
      return id;
    } finally {
      busy.current = false;
    }
  };

  const print = async () => {
    const id = await savedId();
    if (id === null) return;
    if (!openPdf(id)) desk.setStatus('The browser blocked the new tab. Allow pop-ups for RapidBooks, then print again.');
  };

  const journal = () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus('Save the check first to see its transaction journal.');
    else desk.open('txnjournal', { txnId: id });
  };

  const openRegister = () => {
    const bank = formRef.current.bankId;
    if (bank !== null) desk.open('register', { accountId: bank });
    else desk.setStatus('Choose a bank account first.');
  };

  const showTab = (t: Tab) => {
    commitActiveField();
    setTab(t);
    setTimeout(() => (t === 'expenses' ? expRef.current?.focusCell(0) : itemRef.current?.focusCell(0)), 0);
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    saveNew: () => void save('new'),
    new: () => {
      if (busy.current) return;
      busy.current = true;
      void askSave()
        .then(async (ok) => {
          if (!ok) return;
          await startNew();
          focusPayee();
        })
        .finally(() => (busy.current = false));
    },
    delete: txnId !== null ? () => void remove() : undefined,
    insertLine: () => (tab === 'expenses' ? expRef.current?.insertLine() : itemRef.current?.insertLine()),
    deleteLine: () => (tab === 'expenses' ? expRef.current?.deleteLine() : itemRef.current?.deleteLine()),
    register: openRegister,
    print: () => void print(),
    txnJournal: journal,
    quickReport: () => {
      commitActiveField({ quiet: true });
      const n = formRef.current.payeeId;
      if (n !== null) openQuickReport(desk, { name_id: n });
      else desk.setStatus('Choose a name first, then press Ctrl+Q for its QuickReport.');
    },
    confirmClose: () => (loading ? true : askSave(true)),
  });

  const sum = linesSum(form);
  const amount = form.amount ?? sum;
  const mismatch = form.amount !== null && form.amount !== sum;

  // Window-level Alt keys (letters no menu uses).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act: Record<string, (() => void) | undefined> = {
      KeyP: () => void go('prev'),
      KeyX: () => void go('next'),
      KeyT: mismatch ? recalculate : undefined,
      KeyD: () => setToPrint(!formRef.current.toPrint),
      KeyK: () => showTab('expenses'),
      KeyI: () => showTab('items'),
    };
    const fn = act[e.code];
    if (!fn || loading) return;
    e.preventDefault();
    fn();
  };

  const payeeOptions = useMemo(() => {
    const cur = form.payeeId;
    return (names ?? []).filter((n) => !n.inactive || n.id === cur).map((n) => ({ id: n.id, label: n.full_name }));
  }, [names, form.payeeId]);
  const banks = useMemo(() => bankOptions(accounts, form.bankId), [accounts, form.bankId]);
  const itemFilter = useMemo(() => isPurchasable, []);
  const dis = loading;
  const words = amount > 0 ? amountInWords(amount) : '';

  return (
    <div className="form-window bk-form" ref={rootRef} onKeyDown={onKeyDown}>
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
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={journal} title="Ctrl+Y">
          Journal
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || form.bankId === null} onClick={openRegister} title="Ctrl+R">
          Register
        </button>
      </div>

      {error && <div className="msg-strip error">{error}</div>}

      <div className="bk-bankrow">
        <label className="inline-fields">
          Bank Account
          <span className="bk-bank">
            <Combo
              options={banks}
              value={form.bankId}
              onChange={chooseBank}
              disabled={dis}
              aria-label="Bank Account"
              {...accountQuickFill(desk, { type: 'BANK' })}
            />
          </span>
        </label>
        <EndingBalance accounts={accounts} id={form.bankId} />
      </div>

      <div className="bk-check">
        <div className="bk-check-top">
          <label className="inline-fields">
            No.
            <input
              ref={numRef}
              className="field num-field"
              value={form.toPrint ? 'To Print' : form.num}
              readOnly={form.toPrint}
              maxLength={20}
              disabled={dis}
              onChange={(e) => set({ num: e.target.value })}
              onFocus={(e) => e.target.select()}
              onBlur={checkNum}
            />
          </label>
          <label className="inline-fields">
            Date
            <DateField value={form.date} disabled={dis} onChange={(date) => set({ date })} />
          </label>
        </div>
        <div className="bk-payrow">
          <label className="bk-paylabel" htmlFor={`${winId}-payee`}>
            Pay to the
            <br />
            Order of
          </label>
          <span className="bk-payee">
            <Combo
              id={`${winId}-payee`}
              data-field="payee"
              options={payeeOptions}
              value={form.payeeId}
              onChange={choosePayee}
              disabled={dis}
              {...anyNameQuickFill(desk)}
            />
          </span>
          <span className="bk-dollar">$</span>
          <AmountField
            className={`bk-amount${mismatch ? ' bk-mismatch' : ''}`}
            value={amount}
            disabled={dis}
            aria-label="Check amount"
            onChange={(v) => set({ amount: v })}
          />
        </div>
        <div className="bk-words">
          <span className="bk-words-text">{words ? `${words} ${'*'.repeat(Math.max(3, 60 - words.length))}` : ''}</span>
          <span>Dollars</span>
        </div>
        <div className="bk-addr-row">
          <label className="stack">
            Address
            <textarea
              className="field addr-box"
              rows={4}
              value={form.address}
              disabled={dis}
              onChange={(e) => set({ address: e.target.value })}
            />
          </label>
        </div>
        <label className="inline-fields bk-memo">
          Memo
          <input className="field" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
        </label>
      </div>

      <div className="bk-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          tabIndex={-1}
          aria-selected={tab === 'expenses'}
          className={`bk-tab${tab === 'expenses' ? ' active' : ''}`}
          onClick={() => showTab('expenses')}
          title="Alt+K"
        >
          Expenses <span className="bk-tab-amt">{formatMoney(expTotal(form.expenses))}</span>
        </button>
        <button
          type="button"
          role="tab"
          tabIndex={-1}
          aria-selected={tab === 'items'}
          className={`bk-tab${tab === 'items' ? ' active' : ''}`}
          onClick={() => showTab('items')}
          title="Alt+I"
        >
          <Mnemonic label="&Items" /> <span className="bk-tab-amt">{formatMoney(linesTotal(form.items, imap))}</span>
        </button>
      </div>
      {tab === 'expenses' ? (
        <ExpenseGrid
          ref={expRef}
          rows={form.expenses}
          setRows={(fn) => {
            setError(null);
            setForm((f) => ({ ...f, expenses: fn(f.expenses) }));
          }}
          accounts={accounts}
          customers={customers}
          minRows={MIN_ROWS}
          disabled={dis}
          unassigned={unassigned}
        />
      ) : (
        <div className="bk-items">
          <LineGrid
            ref={itemRef}
            lines={form.items}
            setLines={(fn) => {
              setError(null);
              setForm((f) => ({ ...f, items: fn(f.items) }));
            }}
            items={items}
            itemFilter={itemFilter}
            minRows={MIN_ROWS}
            disabled={dis}
            titles={{ rate: 'Cost' }}
          />
        </div>
      )}

      <div className="button-row">
        <label className="check">
          <input type="checkbox" checked={form.toPrint} disabled={dis} onChange={(e) => setToPrint(e.target.checked)} />
          <Mnemonic label="To be printe&d" />
        </label>
        {mismatch && (
          <span className="bk-mismatch-note">
            The lines total {formatMoney(sum)}.
          </span>
        )}
        <button type="button" className="btn" disabled={dis || !mismatch} onClick={recalculate} title="Alt+T">
          <Mnemonic label="Recalcula&te" />
        </button>
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
