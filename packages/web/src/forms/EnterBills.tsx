import {
  dueDate,
  formatMoney,
  todayIso,
  type Account,
  type BillCreditInput,
  type BillInput,
  type Item,
  type Name,
  type OpenPurchaseOrder,
  type PurchTxn,
  type Terms,
} from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { itemMap, LineGrid, linesForCompare, linesTotal, padLines, type GridLine, type LineGridHandle } from '../controls/LineGrid';
import { nameQuickFill, termsQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import {
  appendLines,
  copyItemLines,
  ExpenseGrid,
  expForCompare,
  expFromStored,
  expToInput,
  expTotal,
  gridFromItemLines,
  isPurchasable,
  itemLinesToInput,
  nameOptions,
  padExp,
  purchLabel,
  vendorAddress,
  type ExpenseGridHandle,
  type ExpLine,
} from './purchaseShared';
import './sales.css';
import './purchases.css';

interface Form {
  credit: boolean;
  vendorId: number | null;
  date: string;
  refNo: string;
  /** What she typed as Amount Due; null = not typed (the total of the lines). */
  amountDue: number | null;
  termsId: number | null;
  dueDate: string;
  memo: string;
  address: string;
  expenses: ExpLine[];
  items: GridLine[];
  /** Purchase orders received on this bill (closed when it is saved). */
  poIds: number[];
}

type Tab = 'expenses' | 'items';
const MIN_ROWS = 5;
const ITEM_TITLES = { item: 'Item', description: 'Description', qty: 'Qty', rate: 'Cost', amount: 'Amount' };

const newForm = (credit: boolean): Form => {
  const date = todayIso();
  return {
    credit,
    vendorId: null,
    date,
    refNo: '',
    amountDue: null,
    termsId: null,
    dueDate: date,
    memo: '',
    address: '',
    expenses: padExp([], MIN_ROWS),
    items: padLines([], MIN_ROWS),
    poIds: [],
  };
};

const serialize = (f: Form) => JSON.stringify({ ...f, expenses: expForCompare(f.expenses), items: linesForCompare(f.items) });

/**
 * Enter Bills: a bill or (Credit selected) a bill credit, with Expenses and Items tabs.
 * Props: { id: number | null, vendorId?, credit? }.
 */
export function EnterBills({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const presetVendor = (props.vendorId as number | undefined) ?? null;
  const presetCredit = !!props.credit;
  const desk = useDesktop();
  const { data: vendors } = useData<Name[]>('/api/names?kind=vendor');
  const { data: customers } = useData<Name[]>('/api/names?kind=customer');
  const { data: terms } = useData<Terms[]>('/api/terms');
  const { data: items, error: itemsError } = useData<Item[]>('/api/items');
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const imap = useMemo(() => itemMap(items), [items]);

  const [form, setForm, formRef] = useLiveState<Form>(() => newForm(presetCredit));
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const [doc, setDoc] = useState<PurchTxn | null>(null);
  const [tab, setTab] = useState<Tab>('expenses');
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(propId !== null);
  const busy = useRef(false);
  const expRef = useRef<ExpenseGridHandle>(null);
  const itemRef = useRef<LineGridHandle>(null);
  const vendorRef = useRef<HTMLDivElement>(null);
  const pendingVendor = useRef<number | null>(presetVendor);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const focusVendor = () => vendorRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  const noun = () => (formRef.current.credit ? 'credit' : 'bill');
  const type = () => (formRef.current.credit ? 'BILLCREDIT' : 'BILL');
  const linesSum = (f: Form) => expTotal(f.expenses) + linesTotal(f.items, imap);

  const applyDoc = (t: PurchTxn) => {
    const f: Form = {
      credit: t.type === 'BILLCREDIT',
      vendorId: t.name_id,
      date: t.date,
      refNo: t.ref_no,
      amountDue: t.total,
      termsId: t.terms_id,
      dueDate: t.due_date || t.date,
      memo: t.memo,
      address: t.address,
      expenses: padExp(expFromStored(t.expenses), MIN_ROWS),
      items: padLines(gridFromItemLines(t.items), MIN_ROWS),
      poIds: t.po_ids,
    };
    setForm(f);
    snapshot.current = serialize(f);
    version.current = t.version;
    setDoc(t);
    setTxnId(t.id);
    setTab(t.expenses.length === 0 && t.items.length > 0 ? 'items' : 'expenses');
  };

  const load = async (id: number): Promise<boolean> => {
    try {
      const t = await api.get<PurchTxn>(`/api/txns/${id}`);
      if (t.type !== 'BILL' && t.type !== 'BILLCREDIT') {
        setError('That transaction is not a bill or a bill credit.');
        return false;
      }
      applyDoc(t);
      setError(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const startNew = (credit = formRef.current.credit) => {
    const f = newForm(credit);
    setForm(f);
    snapshot.current = serialize(f);
    setTxnId(null);
    setDoc(null);
    version.current = undefined;
    setError(null);
    setTab('expenses');
  };

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || (!items && !itemsError)) return;
    opened.current = true;
    if (propId !== null) void load(propId).finally(() => setLoading(false));
  }, [items, itemsError]);

  // Payments and credits applied elsewhere change the open balance: show the current figures.
  const firstVersion = useRef(desk.dataVersion);
  useEffect(() => {
    if (desk.dataVersion === firstVersion.current) return;
    const id = txnIdRef.current;
    if (id === null || busy.current) return;
    let cancelled = false;
    api.get<PurchTxn>(`/api/txns/${id}`).then(
      (t) => {
        if (cancelled || busy.current || txnIdRef.current !== id) return;
        if (isDirty()) setDoc(t);
        else applyDoc(t);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [desk.dataVersion]);

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setExpenses = (fn: (prev: ExpLine[]) => ExpLine[]) => {
    setError(null);
    setForm((f) => ({ ...f, expenses: fn(f.expenses) }));
  };
  const setItems = (fn: (prev: GridLine[]) => GridLine[]) => {
    setError(null);
    setForm((f) => ({ ...f, items: fn(f.items) }));
  };
  const termsFor = (id: number | null) => (id !== null ? terms?.find((t) => t.id === id) ?? null : null);

  /** Receive against open purchase orders: ask, let her choose, copy their lines to the Items tab. */
  const offerPurchaseOrders = async (vendorId: number) => {
    let open: OpenPurchaseOrder[];
    try {
      open = await api.get<OpenPurchaseOrder[]>(`/api/purchase-orders/open?vendor_id=${vendorId}`);
    } catch {
      return;
    }
    const still = () => formRef.current.vendorId === vendorId && !formRef.current.credit && txnIdRef.current === null;
    if (open.length === 0 || !still()) return;
    const yes = await desk.confirm('Open purchase orders exist for this vendor. Do you want to receive against one or more of these orders?', {
      title: 'Open POs Exist',
    });
    if (!yes || !still()) return;
    const ids = await desk.openForResult<number[]>('pochooser', { vendorId });
    if (!ids || ids.length === 0 || !still()) return;
    try {
      const pos = await Promise.all(ids.map((id) => api.get<PurchTxn>(`/api/txns/${id}`)));
      const add = pos.flatMap((p) => copyItemLines(p.items));
      setForm((f) => ({ ...f, items: appendLines(f.items, add, MIN_ROWS), poIds: [...new Set([...f.poIds, ...ids])] }));
      setTab('items');
      requestAnimationFrame(() => itemRef.current?.focusCell(0, 'qty'));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Vendor chosen: address, terms and due date from the vendor; on a new bill, offer its open P.O.s. */
  const chooseVendor = (id: number | null, ask = true) => {
    const changed = id !== formRef.current.vendorId;
    set({ vendorId: id });
    if (id === null || !changed) return;
    const v = vendors?.find((x) => x.id === id);
    const patch: Partial<Form> = { address: vendorAddress(v), poIds: [] };
    if (!formRef.current.credit) {
      patch.termsId = v?.terms_id ?? null;
      patch.dueDate = dueDate(termsFor(patch.termsId), formRef.current.date);
    }
    set(patch);
    if (ask && txnIdRef.current === null && !formRef.current.credit) void offerPurchaseOrders(id);
  };

  useEffect(() => {
    const id = pendingVendor.current;
    if (id === null || !vendors || !terms || loading || txnId !== null) return;
    pendingVendor.current = null;
    const clean = !isDirty();
    chooseVendor(id);
    if (clean) snapshot.current = serialize(formRef.current);
  }, [vendors, terms, loading, txnId]);

  const setCredit = (credit: boolean) => {
    if (txnIdRef.current !== null || credit === formRef.current.credit) return;
    const f = formRef.current;
    const tid = credit ? null : vendors?.find((x) => x.id === f.vendorId)?.terms_id ?? null;
    set({ credit, poIds: [], termsId: tid, dueDate: dueDate(termsFor(tid), f.date) });
  };

  const recalculate = () => {
    commitActiveField();
    set({ amountDue: linesSum(formRef.current) });
  };

  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const id = txnIdRef.current;
    if (f.vendorId === null) {
      setError(`Choose the vendor for this ${noun()}.`);
      return false;
    }
    const sum = linesSum(f);
    if (f.amountDue !== null && f.amountDue !== sum) {
      setError(
        `The Amount Due (${formatMoney(f.amountDue)}) is not the total of the expense and item lines (${formatMoney(sum)}). ` +
          'Correct the lines, or click Recalculate (Alt+A) to make the Amount Due the total of the lines.',
      );
      return false;
    }
    const common = {
      date: f.date,
      num: '',
      ref_no: f.refNo.trim(),
      name_id: f.vendorId,
      memo: f.memo,
      ...(id !== null ? { version: version.current } : {}),
      ap_account_id: doc?.ap_account_id ?? null,
      address: f.address,
      expenses: expToInput(f.expenses),
      items: itemLinesToInput(f.items),
    };
    const body: BillInput | BillCreditInput = f.credit
      ? { type: 'BILLCREDIT', ...common, terms_id: null, due_date: '' }
      : { type: 'BILL', ...common, terms_id: f.termsId, due_date: f.dueDate, po_ids: f.poIds };
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      const t = await api.get<PurchTxn>(`/api/txns/${r.id}`);
      applyDoc(t);
      setError(null);
      desk.refresh();
      desk.setStatus(`${purchLabel(t.type, t.ref_no)} saved.`);
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
        startNew();
        focusVendor();
      } else refocus(field);
    } finally {
      busy.current = false;
    }
  };

  const askSave = async (quiet = false): Promise<boolean> => {
    const field = commitActiveField({ quiet });
    if (!quiet && !(await settleQuickFill())) return false;
    if (!isDirty()) return true;
    const i = await desk.messageBox(`You have changed the ${noun()}. Do you want to save the changes?`, {
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
      const adj = await api.get<{ prev: number | null; next: number | null }>(`/api/txns/adjacent?type=${type()}&id=${id ?? ''}`);
      const target = dir === 'prev' ? adj.prev : adj.next;
      if (target !== null) {
        await load(target);
        focusVendor();
      } else if (dir === 'next' && id !== null) {
        startNew();
        focusVendor();
      } else desk.setStatus(dir === 'prev' ? `This is the first ${noun()}.` : `This is the last ${noun()}.`);
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
      startNew();
      focusVendor();
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
      desk.setStatus(`${purchLabel(type(), formRef.current.refNo)} deleted.`);
      desk.refresh();
      startNew();
      focusVendor();
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const needSaved = (what: string, fn: (id: number) => void) => () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus(`Save the ${noun()} first to see its ${what}.`);
    else fn(id);
  };
  const history = needSaved('history', (id) => desk.open('txnhistory', { txnId: id }));
  const journal = needSaved('transaction journal', (id) => desk.open('txnjournal', { txnId: id }));

  const openAp = () => {
    const ap = doc?.ap_account_id ?? accounts?.find((a) => a.type === 'AP' && a.system_role === 'AP')?.id ?? accounts?.find((a) => a.type === 'AP')?.id;
    if (ap !== undefined) desk.open('register', { accountId: ap });
    else desk.setStatus('There is no Accounts Payable account yet.');
  };

  const showTab = (t: Tab) => {
    setTab(t);
    requestAnimationFrame(() => (t === 'items' ? itemRef.current?.focusCell(0, 'item') : expRef.current?.focusCell(0, 'account')));
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
          if (!ok) return;
          startNew();
          focusVendor();
        })
        .finally(() => (busy.current = false));
    },
    delete: txnId !== null ? () => void remove() : undefined,
    insertLine: () => (tab === 'items' ? itemRef.current?.insertLine() : expRef.current?.insertLine()),
    deleteLine: () => (tab === 'items' ? itemRef.current?.deleteLine() : expRef.current?.deleteLine()),
    register: openAp,
    history,
    txnJournal: journal,
    confirmClose: () => (loading ? true : askSave(true)),
  });

  // Window Alt keys (letters no menu uses): Previous, Next, Expenses tab, Items tab, Recalculate.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act: Record<string, (() => void) | undefined> = {
      KeyP: () => void go('prev'),
      KeyX: () => void go('next'),
      KeyM: () => showTab('expenses'),
      KeyI: () => showTab('items'),
      KeyA: recalculate,
    };
    const fn = act[e.code];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const vendorOptions = useMemo(() => nameOptions(vendors, [form.vendorId]), [vendors, form.vendorId]);
  const customerOptions = useMemo(() => nameOptions(customers, form.items.map((l) => l.nameId)), [customers, form.items]);
  const termsOptions = useMemo(
    () => (terms ?? []).filter((t) => !t.inactive || t.id === form.termsId).map((t) => ({ id: t.id, label: t.name })),
    [terms, form.termsId],
  );

  const expSum = expTotal(form.expenses);
  const itemSum = linesTotal(form.items, imap);
  const sum = expSum + itemSum;
  const mismatch = form.amountDue !== null && form.amountDue !== sum;
  const savedDoc = txnId !== null ? doc : null;
  const dis = loading;
  const credit = form.credit;

  return (
    <div className="form-window sales-form purch-form" onKeyDown={onKeyDown}>
      <div className="form-toolbar">
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('prev')} title="Alt+P">
          <Mnemonic label="&Previous" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('next')} title="Alt+X">
          <Mnemonic label="Ne&xt" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={history} title="Ctrl+H">
          History
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={journal} title="Ctrl+Y">
          Journal
        </button>
        <span className="pb-radios" role="radiogroup" aria-label="Bill or credit">
          <label className="check">
            <input type="radio" name={`${winId}-kind`} checked={!credit} disabled={dis || txnId !== null} onChange={() => setCredit(false)} />
            Bill
          </label>
          <label className="check">
            <input type="radio" name={`${winId}-kind`} checked={credit} disabled={dis || txnId !== null} onChange={() => setCredit(true)} />
            Credit
          </label>
        </span>
        {savedDoc && !credit && savedDoc.open_balance === 0 && <span className="fc-flag">Paid</span>}
      </div>

      {error && <div className="msg-strip error">{error}</div>}

      <div className="bill-top">
        <h2 className="sf-title">{credit ? 'Credit' : 'Bill'}</h2>
        <div className="bill-grid">
          <label htmlFor={`${winId}-vendor`}>Vendor</label>
          <div ref={vendorRef}>
            <Combo
              id={`${winId}-vendor`}
              options={vendorOptions}
              value={form.vendorId}
              onChange={(id) => chooseVendor(id)}
              disabled={dis}
              {...nameQuickFill(desk, 'vendor')}
            />
          </div>
          <label htmlFor={`${winId}-date`}>Date</label>
          <DateField
            id={`${winId}-date`}
            value={form.date}
            disabled={dis}
            onChange={(date) => set(credit ? { date } : { date, dueDate: dueDate(termsFor(formRef.current.termsId), date) })}
          />

          <label htmlFor={`${winId}-addr`}>Address</label>
          <textarea id={`${winId}-addr`} className="field addr-box" rows={4} value={form.address} disabled={dis} onChange={(e) => set({ address: e.target.value })} />
          <label htmlFor={`${winId}-ref`}>Ref. No.</label>
          <div className="bill-stack">
            <input
              id={`${winId}-ref`}
              className="field num-field"
              value={form.refNo}
              maxLength={20}
              disabled={dis}
              onChange={(e) => set({ refNo: e.target.value })}
              onFocus={(e) => e.target.select()}
            />
            <label className="bill-sub" htmlFor={`${winId}-amt`}>
              {credit ? 'Credit Amount' : 'Amount Due'}
            </label>
            <AmountField
              id={`${winId}-amt`}
              className="bill-amount"
              value={form.amountDue}
              placeholder={formatMoney(sum)}
              disabled={dis}
              onChange={(amountDue) => set({ amountDue })}
            />
          </div>

          {!credit && (
            <>
              <label htmlFor={`${winId}-terms`}>Terms</label>
              <Combo
                id={`${winId}-terms`}
                options={termsOptions}
                value={form.termsId}
                disabled={dis}
                onChange={(termsId) => set({ termsId, dueDate: dueDate(termsFor(termsId), formRef.current.date) })}
                {...termsQuickFill(desk)}
              />
              <label htmlFor={`${winId}-due`}>Bill Due</label>
              <DateField id={`${winId}-due`} value={form.dueDate} disabled={dis} onChange={(d) => set({ dueDate: d })} />
            </>
          )}

          <label htmlFor={`${winId}-memo`}>Memo</label>
          <input id={`${winId}-memo`} className="field bill-memo" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
        </div>
      </div>

      {mismatch && (
        <div className="msg-strip info">
          The lines come to {formatMoney(sum)}, but the {credit ? 'Credit Amount' : 'Amount Due'} is {formatMoney(form.amountDue ?? 0)} (
          {formatMoney(Math.abs((form.amountDue ?? 0) - sum))} {(form.amountDue ?? 0) > sum ? 'not yet on a line' : 'too much on the lines'}).
          Correct the lines, or click Recalculate.
        </div>
      )}
      {form.poIds.length > 0 && !credit && (
        <div className="hint">
          Receiving against {form.poIds.length === 1 ? 'one purchase order' : `${form.poIds.length} purchase orders`}; saving the bill closes{' '}
          {form.poIds.length === 1 ? 'it' : 'them'}.
        </div>
      )}

      <div className="bill-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'expenses'}
          className={`bill-tab${tab === 'expenses' ? ' active' : ''}`}
          tabIndex={-1}
          onClick={() => showTab('expenses')}
          title="Alt+M"
        >
          Expenses <span className="tab-amt">{formatMoney(expSum)}</span>
          <span className="tab-key">Alt+M</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'items'}
          className={`bill-tab${tab === 'items' ? ' active' : ''}`}
          tabIndex={-1}
          onClick={() => showTab('items')}
          title="Alt+I"
        >
          <Mnemonic label="&Items" /> <span className="tab-amt">{formatMoney(itemSum)}</span>
        </button>
      </div>
      <div className="bill-tabpanel">
        {tab === 'expenses' ? (
          <ExpenseGrid
            ref={expRef}
            lines={form.expenses}
            setLines={setExpenses}
            accounts={accounts}
            customers={customers}
            remaining={() => {
              const f = formRef.current;
              return f.amountDue === null ? 0 : f.amountDue - linesSum(f);
            }}
            minRows={MIN_ROWS}
            disabled={dis}
          />
        ) : (
          <LineGrid
            ref={itemRef}
            lines={form.items}
            setLines={setItems}
            items={items}
            accounts={accounts}
            itemFilter={isPurchasable}
            minRows={MIN_ROWS}
            disabled={dis}
            titles={ITEM_TITLES}
            purchase
            customers={customerOptions}
          />
        )}
      </div>

      <div className="sf-foot">
        <div className="sf-foot-left">
          <div className="inline-fields">
            <button type="button" className="btn" disabled={dis} onClick={recalculate} title="Alt+A">
              <Mnemonic label="Recalcul&ate" />
            </button>
          </div>
        </div>
        <table className="sf-totals">
          <tbody>
            <tr>
              <th>Total of lines</th>
              <td className={`total${mismatch ? ' unbalanced' : ''}`}>{formatMoney(sum)}</td>
            </tr>
            {savedDoc && !credit && (
              <tr>
                <th>Open Balance</th>
                <td className="total">{formatMoney(savedDoc.open_balance ?? 0)}</td>
              </tr>
            )}
            {savedDoc && credit && (
              <tr>
                <th>Remaining Credit</th>
                <td className="total">{formatMoney(savedDoc.unapplied ?? 0)}</td>
              </tr>
            )}
          </tbody>
        </table>
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
