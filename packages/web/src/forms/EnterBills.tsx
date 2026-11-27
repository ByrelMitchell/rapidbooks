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
import { handOffLocked, confirmDeleteTxn } from './openTxn';
import type { WinProps } from '../shell/registry';
import { openQuickReport } from '../reports/open';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import {
  appendLines,
  receiveLines,
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
import { ExpItemTabs, Ribbon, RibbonBig, RibbonGroup, RibbonStart, SaveButtons } from './Ribbon';

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
  /** Purchase order > Enter Bill for this PO: receive that P.O. without asking. */
  const presetPo = (props.poId as number | undefined) ?? null;
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
      if (handOffLocked(desk, winId, t)) return false;
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
  const offerPurchaseOrders = async (vendorId: number, ask = true) => {
    let open: OpenPurchaseOrder[];
    try {
      open = await api.get<OpenPurchaseOrder[]>(`/api/purchase-orders/open?vendor_id=${vendorId}`);
    } catch {
      return;
    }
    const still = () => formRef.current.vendorId === vendorId && !formRef.current.credit && txnIdRef.current === null;
    if (!still()) return;
    if (open.length === 0) {
      if (!ask) desk.setStatus('This vendor has no open purchase orders.');
      return;
    }
    const yes = !ask || await desk.confirm('Open purchase orders exist for this vendor. Do you want to receive against one or more of these orders?', {
      title: 'Open POs Exist',
    });
    if (!yes || !still()) return;
    const ids = await desk.openForResult<number[]>('pochooser', { vendorId });
    if (!ids || ids.length === 0 || !still()) return;
    await receivePurchaseOrders(ids);
  };

  /** Copy what is still to come on these P.O.s to the Items tab, each line tied to its P.O. line. */
  const receivePurchaseOrders = async (ids: number[]) => {
    try {
      const pos = await Promise.all(ids.map((id) => api.get<PurchTxn>(`/api/txns/${id}`)));
      const add = pos.flatMap((p) => receiveLines(p));
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
    chooseVendor(id, presetPo === null);
    if (clean) snapshot.current = serialize(formRef.current);
    if (presetPo !== null) void receivePurchaseOrders([presetPo]);
  }, [vendors, terms, loading, txnId]);

  const setCredit = (credit: boolean) => {
    if (txnIdRef.current !== null || credit === formRef.current.credit) return;
    const f = formRef.current;
    const tid = credit ? null : vendors?.find((x) => x.id === f.vendorId)?.terms_id ?? null;
    set({ credit, poIds: [], termsId: tid, dueDate: dueDate(termsFor(tid), f.date) });
  };

  /** Ribbon > Clear Splits: empty the Expenses and Items lines. */
  const clearSplits = () => {
    commitActiveField({ quiet: true });
    set({ expenses: padExp([], MIN_ROWS), items: padLines([], MIN_ROWS) });
  };

  /** Ribbon > Create a Copy: the same vendor and lines as a new, unsaved bill. */
  const copyDoc = async () => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      if (!(await askSave())) return;
      const src = formRef.current;
      setTxnId(null);
      setDoc(null);
      version.current = undefined;
      setError(null);
      setForm({ ...src, refNo: '', poIds: [] });
      snapshot.current = serialize(newForm(src.credit));
      desk.setStatus(`This is a copy. Save it to record a new ${noun()}.`);
    } finally {
      busy.current = false;
    }
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
          'Correct the lines, or click Recalculate (Alt+T) to make the Amount Due the total of the lines.',
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
    if (!(await confirmDeleteTxn(desk, id))) return;
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

    keys2013: true,
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
    quickReport: () => {
      commitActiveField({ quiet: true });
      const n = formRef.current.vendorId;
      if (n !== null) openQuickReport(desk, { name_id: n });
      else desk.setStatus('Choose a name first, then press Ctrl+Q for its QuickReport.');
    },
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
      KeyT: recalculate,
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

  const vendorId = form.vendorId;
  const mainTab = (
    <>
      <RibbonStart
        disabled={dis}
        onPrev={() => void go('prev')}
        onNext={() => void go('next')}
        onFind={() => desk.open('find')}
        onNew={() => desk.run('new')}
        onSave={() => void save('stay')}
        onDelete={txnId !== null ? () => void remove() : undefined}
        onCopy={() => void copyDoc()}
      />
      <RibbonGroup>
        <RibbonBig
          icon="selectpo"
          label={'Select\nPO'}
          disabled={dis || credit || vendorId === null || txnId !== null}
          onClick={() => vendorId !== null && void offerPurchaseOrders(vendorId, false)}
        />
        <RibbonBig icon="clearsplits" label={'Clear\nSplits'} disabled={dis} onClick={clearSplits} />
        <RibbonBig icon="recalc" label="Recalculate" keys="Alt+T" disabled={dis} onClick={recalculate} />
        <RibbonBig icon="paybill" label={'Pay\nBill'} disabled={dis || credit || txnId === null} onClick={() => desk.open('paybills')} />
      </RibbonGroup>
    </>
  );
  const reportsTab = (
    <RibbonGroup>
      <RibbonBig icon="history" label={'Transaction\nHistory'} keys="Ctrl+H" disabled={dis || txnId === null} onClick={history} />
      <RibbonBig icon="journal" label={'Transaction\nJournal'} keys="Ctrl+Y" disabled={dis || txnId === null} onClick={journal} />
      <RibbonBig icon="register" label={'A/P\nRegister'} keys="Ctrl+R" onClick={openAp} />
      <RibbonBig
        icon="report"
        label={'Vendor\nQuickReport'}
        keys="Ctrl+Q"
        disabled={vendorId === null}
        onClick={() => vendorId !== null && openQuickReport(desk, { name_id: vendorId })}
      />
    </RibbonGroup>
  );

  return (
    <div className="f13 purch-form" onKeyDown={onKeyDown}>
      <Ribbon
        tabs={[
          { label: 'Main', content: mainTab },
          { label: 'Reports', content: reportsTab },
        ]}
      />
      <div className="f13-page">
        <div className="bill13-kind" role="radiogroup" aria-label="Bill or credit">
          <label>
            <input type="radio" name={`${winId}-kind`} checked={!credit} disabled={dis || txnId !== null} onChange={() => setCredit(false)} />
            Bill
          </label>
          <label>
            <input type="radio" name={`${winId}-kind`} checked={credit} disabled={dis || txnId !== null} onChange={() => setCredit(true)} />
            Credit
          </label>
          <span className="spacer" />
          {savedDoc && !credit && <span>{savedDoc.open_balance === 0 ? 'Paid' : `Open balance ${formatMoney(savedDoc.open_balance ?? 0)}`}</span>}
          {savedDoc && credit && <span>Remaining credit {formatMoney(savedDoc.unapplied ?? 0)}</span>}
        </div>

        {error && <div className="msg-strip error">{error}</div>}

        <div className="paper">
          <h2 className="paper-title">{credit ? 'Credit' : 'Bill'}</h2>
          <div className="bill13-grid">
            <label className="cap-left" htmlFor={`${winId}-vendor`}>
              Vendor
            </label>
            <div ref={vendorRef} className="uline">
              <Combo
                id={`${winId}-vendor`}
                options={vendorOptions}
                value={form.vendorId}
                onChange={(id) => chooseVendor(id)}
                disabled={dis}
                {...nameQuickFill(desk, 'vendor')}
              />
            </div>
            <span />
            <label className="cap-left" htmlFor={`${winId}-date`}>
              Date
            </label>
            <span className="uline">
              <DateField
                id={`${winId}-date`}
                value={form.date}
                disabled={dis}
                onChange={(date) => set(credit ? { date } : { date, dueDate: dueDate(termsFor(formRef.current.termsId), date) })}
              />
            </span>

            <label className="cap-left top" htmlFor={`${winId}-addr`}>
              Address
            </label>
            <textarea
              id={`${winId}-addr`}
              className="field addr-box"
              value={form.address}
              disabled={dis}
              onChange={(e) => set({ address: e.target.value })}
            />
            <span />
            <div className="bill13-labels">
              <label className="cap-left" htmlFor={`${winId}-ref`}>
                Ref. No.
              </label>
              <label className="cap-left" htmlFor={`${winId}-amt`}>
                {credit ? 'Credit Amount' : 'Amount Due'}
              </label>
              {!credit && (
                <label className="cap-left" htmlFor={`${winId}-due`}>
                  Bill Due
                </label>
              )}
            </div>
            <div className="bill13-labels uline">
              <input
                id={`${winId}-ref`}
                className="field"
                value={form.refNo}
                maxLength={20}
                disabled={dis}
                onChange={(e) => set({ refNo: e.target.value })}
                onFocus={(e) => e.target.select()}
              />
              <AmountField
                id={`${winId}-amt`}
                className={`amt${mismatch ? ' mismatch' : ''}`}
                value={form.amountDue}
                placeholder={formatMoney(sum)}
                disabled={dis}
                onChange={(amountDue) => set({ amountDue })}
              />
              {!credit && <DateField id={`${winId}-due`} value={form.dueDate} disabled={dis} onChange={(d) => set({ dueDate: d })} />}
            </div>

            {!credit && (
              <>
                <label className="cap-left" htmlFor={`${winId}-terms`}>
                  Terms
                </label>
                <div className="uline bill13-terms">
                  <Combo
                    id={`${winId}-terms`}
                    options={termsOptions}
                    value={form.termsId}
                    disabled={dis}
                    onChange={(termsId) => set({ termsId, dueDate: dueDate(termsFor(termsId), formRef.current.date) })}
                    {...termsQuickFill(desk)}
                  />
                </div>
                <span className="bill13-fill" />
              </>
            )}

            <label className="cap-left" htmlFor={`${winId}-memo`}>
              Memo
            </label>
            <span className="uline wide">
              <input id={`${winId}-memo`} className="field" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
            </span>
          </div>
        </div>

        {mismatch && (
          <div className="msg-strip info">
            The lines come to {formatMoney(sum)}, but the {credit ? 'Credit Amount' : 'Amount Due'} is {formatMoney(form.amountDue ?? 0)} (
            {formatMoney(Math.abs((form.amountDue ?? 0) - sum))} {(form.amountDue ?? 0) > sum ? 'not yet on a line' : 'too much on the lines'}).
            Correct the lines, or click Recalculate (Alt+T).
          </div>
        )}
        {form.poIds.length > 0 && !credit && (
          <div className="f13-note">
            {txnId === null ? 'Receiving against' : 'Received against'}{' '}
            {form.poIds.length === 1 ? 'one purchase order' : `${form.poIds.length} purchase orders`}
            {txnId === null ? '. A purchase order closes when everything on it has been received.' : '.'}
          </div>
        )}

        <ExpItemTabs tab={tab} onTab={showTab} expenses={`$${formatMoney(expSum)}`} items={`$${formatMoney(itemSum)}`} expKey="M" />
        <div className="ei-panel">
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

        <SaveButtons disabled={dis} saved={txnId !== null} onSave={(m) => void save(m)} onClear={() => void clearOrRevert()} />
      </div>
    </div>
  );
}
