import {
  dueDate,
  formatMoney,
  todayIso,
  type Account,
  type AvailableCredit,
  type CreditMemoInput,
  type DocTxn,
  type InvoiceInput,
  type Item,
  type Name,
  type Terms,
} from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import {
  expandGroups,
  itemMap,
  LineGrid,
  linesForCompare,
  linesFromTxn,
  linesToInput,
  linesTotal,
  padLines,
  type GridLine,
  type LineGridHandle,
} from '../controls/LineGrid';
import { nameQuickFill, termsQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { openWindow } from './openTxn';
import { docLabel, openPdf } from './salesDoc';
import './sales.css';

type DocType = 'INVOICE' | 'CREDITMEMO';

interface Form {
  customerId: number | null;
  date: string;
  num: string;
  billAddr: string;
  shipAddr: string;
  po: string;
  termsId: number | null;
  dueDate: string;
  shipDate: string;
  via: string;
  lines: GridLine[];
  message: string;
  memo: string;
  toPrint: boolean;
  toEmail: boolean;
}

const MIN_ROWS = 6;

const TEXT: Record<DocType, { noun: string; numLabel: string; kind: string }> = {
  INVOICE: { noun: 'invoice', numLabel: 'Invoice #', kind: 'invoice' },
  CREDITMEMO: { noun: 'credit memo', numLabel: 'Credit No.', kind: 'creditmemo' },
};

const newForm = (num = ''): Form => {
  const date = todayIso();
  return {
    customerId: null,
    date,
    num,
    billAddr: '',
    shipAddr: '',
    po: '',
    termsId: null,
    dueDate: date,
    shipDate: '',
    via: '',
    lines: padLines([], MIN_ROWS),
    message: '',
    memo: '',
    toPrint: false,
    toEmail: false,
  };
};

/** What counts for "unsaved changes": everything but blank rows and row identity. */
const serialize = (f: Form) => JSON.stringify({ ...f, lines: linesForCompare(f.lines) });

/** The first non-empty value up the customer:job chain (a job without an address uses its customer's). */
function inherited<T>(names: Map<number, Name>, id: number, get: (n: Name) => T, empty: (v: T) => boolean): T | undefined {
  let n = names.get(id);
  for (let guard = 0; n && guard < 20; guard++) {
    const v = get(n);
    if (!empty(v)) return v;
    n = n.parent_id !== null ? names.get(n.parent_id) : undefined;
  }
  return undefined;
}

/** Create Invoices and Create Credit Memos/Refunds: one form, parameterised by type. */
export function SalesForm({ winId, props, type }: WinProps & { type: DocType }) {
  const propId = (props.id as number | null | undefined) ?? null;
  const presetCustomer = (props.customerId as number | undefined) ?? null;
  const isInvoice = type === 'INVOICE';
  const text = TEXT[type];
  const desk = useDesktop();
  const { data: customers } = useData<Name[]>('/api/names?kind=customer');
  const { data: terms } = useData<Terms[]>('/api/terms');
  const { data: items, error: itemsError } = useData<Item[]>('/api/items');
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const imap = useMemo(() => itemMap(items), [items]);
  const names = useMemo(() => new Map((customers ?? []).map((n) => [n.id, n])), [customers]);

  const [form, setForm, formRef] = useLiveState<Form>(() => newForm());
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const [doc, setDoc, docRef] = useLiveState<DocTxn | null>(null);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(propId !== null);
  const busy = useRef(false);
  const gridRef = useRef<LineGridHandle>(null);
  const customerRef = useRef<HTMLDivElement>(null);
  const pendingCustomer = useRef<number | null>(presetCustomer);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const focusCustomer = () => customerRef.current?.querySelector<HTMLInputElement>('input')?.focus();

  /** Show a stored document. Row keys are kept by position so the field being edited stays put. */
  const applyDoc = (t: DocTxn) => {
    const prev = formRef.current.lines;
    const lines = padLines(linesFromTxn(t.lines, imap), MIN_ROWS).map((l, i) => (prev[i] ? { ...l, key: prev[i].key } : l));
    const f: Form = {
      customerId: t.name_id,
      date: t.date,
      num: t.num,
      billAddr: t.bill_addr,
      shipAddr: t.ship_addr,
      po: t.po_number,
      termsId: t.terms_id,
      dueDate: t.due_date || t.date,
      shipDate: t.ship_date,
      via: t.ship_via,
      lines,
      message: t.message,
      memo: t.memo,
      toPrint: t.to_print,
      toEmail: t.to_email,
    };
    setForm(f);
    snapshot.current = serialize(f);
    version.current = t.version;
    setDoc(t);
    setTxnId(t.id);
  };

  const load = async (id: number): Promise<boolean> => {
    try {
      const t = await api.get<DocTxn>(`/api/txns/${id}`);
      if (t.type !== type) {
        setError(`That transaction is a ${t.type === 'INVOICE' ? 'invoice' : t.type.toLowerCase()}, not a ${text.noun}.`);
        return false;
      }
      applyDoc(t);
      setError(null);
      setNote(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  /** A blank form with the next number. */
  const startNew = async () => {
    const f = newForm();
    setForm(f);
    snapshot.current = serialize(f);
    setTxnId(null);
    setDoc(null);
    version.current = undefined;
    setError(null);
    setNote(null);
    try {
      const { num } = await api.get<{ num: string }>(`/api/txns/next-num?type=${type}`);
      if (formRef.current.num === '' && txnIdRef.current === null) {
        const untouched = !isDirty();
        setForm((cur) => ({ ...cur, num }));
        if (untouched) snapshot.current = serialize(formRef.current);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Open on the given document, or a new one. Waits for the items so stored amounts can be told from typed-over ones.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || (!items && !itemsError)) return;
    opened.current = true;
    if (propId === null) void startNew();
    else void load(propId).finally(() => setLoading(false));
  }, [items, itemsError]);

  // After saves elsewhere (payments, applied credits, e-mail sent), show the current figures.
  const firstVersion = useRef(desk.dataVersion);
  useEffect(() => {
    if (desk.dataVersion === firstVersion.current) return;
    const id = txnIdRef.current;
    if (id === null || busy.current) return;
    let cancelled = false;
    api.get<DocTxn>(`/api/txns/${id}`).then(
      (t) => {
        if (cancelled || busy.current || txnIdRef.current !== id) return;
        if (isDirty()) setDoc(t);
        else applyDoc(t);
      },
      () => {
        // Deleted elsewhere, or the server is away: keep what is on screen.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [desk.dataVersion]);

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const setLines = (fn: (prev: GridLine[]) => GridLine[]) => {
    setError(null);
    setForm((f) => ({ ...f, lines: fn(f.lines) }));
  };
  const termsFor = (id: number | null) => (id !== null ? terms?.find((t) => t.id === id) ?? null : null);

  /** Customer:Job chosen: Bill To, Ship To and Terms from the customer; tell about available credits. */
  const chooseCustomer = (id: number | null) => {
    set({ customerId: id });
    setNote(null);
    if (id === null) return;
    const bill = inherited(names, id, (n) => n.bill_addr, (v) => !v.trim()) ?? '';
    const ship = inherited(names, id, (n) => n.ship_addr, (v) => !v.trim()) ?? '';
    const patch: Partial<Form> = { billAddr: bill, shipAddr: ship };
    if (isInvoice) {
      const tid = inherited(names, id, (n) => n.terms_id, (v) => v === null) ?? null;
      patch.termsId = tid;
      patch.dueDate = dueDate(termsFor(tid), formRef.current.date);
    }
    set(patch);
    if (isInvoice) {
      api.get<AvailableCredit[]>(`/api/customers/${id}/credits`).then(
        (credits) => {
          if (formRef.current.customerId !== id || credits.length === 0) return;
          const sum = credits.reduce((t, c) => t + c.unapplied, 0);
          setNote(
            `${names.get(id)?.full_name ?? 'This customer'} has ${formatMoney(sum)} in available credits. ` +
              'Save the invoice, then use Apply Credits to apply them.',
          );
        },
        () => undefined,
      );
    }
  };

  // A new invoice opened for a customer (Customer:Job List, Receive Payments...).
  useEffect(() => {
    const id = pendingCustomer.current;
    if (id === null || !opened.current || !customers || !terms || loading || txnId !== null) return;
    pendingCustomer.current = null;
    chooseCustomer(id);
    snapshot.current = serialize(formRef.current);
  }, [customers, terms, loading, txnId, items, itemsError]);

  /** Save what is on the form. The caller has committed the active field and settled Quick Fill. */
  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const id = txnIdRef.current;
    if (f.customerId === null) {
      setError(`Choose a customer:job for this ${text.noun}.`);
      return false;
    }
    const lines = expandGroups(f.lines, imap);
    const body: InvoiceInput | CreditMemoInput = {
      type,
      date: f.date,
      num: f.num.trim(),
      name_id: f.customerId,
      memo: f.memo,
      ...(id !== null ? { version: version.current } : {}),
      ar_account_id: docRef.current?.ar_account_id ?? null,
      terms_id: isInvoice ? f.termsId : null,
      due_date: isInvoice ? f.dueDate : '',
      po_number: f.po,
      ship_date: isInvoice ? f.shipDate : '',
      ship_via: isInvoice ? f.via : '',
      bill_addr: f.billAddr,
      ship_addr: isInvoice ? f.shipAddr : '',
      message: f.message,
      to_print: f.toPrint,
      to_email: f.toEmail,
      lines: linesToInput(lines, imap),
    };
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      const t = await api.get<DocTxn>(`/api/txns/${r.id}`);
      applyDoc(t);
      setError(null);
      setNote(null);
      desk.refresh();
      desk.setStatus(`${docLabel(type, t.num)} saved.`);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  /** Commit the field being typed in and any Quick Add, then save if there are unsaved changes. */
  const commitAndSave = async (): Promise<{ ok: boolean; field: HTMLElement | null; saved: boolean }> => {
    const field = commitActiveField();
    if (!(await settleQuickFill())) return { ok: false, field: null, saved: false };
    if (!isDirty()) return { ok: true, field, saved: false };
    const ok = await persist();
    return { ok, field, saved: ok };
  };

  /** After the first save of an invoice with a balance: offer to apply the customer's credits. */
  const offerCredits = async (customerId: number): Promise<boolean> => {
    if (!isInvoice || (docRef.current?.open_balance ?? 0) <= 0) return false;
    try {
      const credits = await api.get<AvailableCredit[]>(`/api/customers/${customerId}/credits`);
      if (credits.length === 0) return false;
      const sum = credits.reduce((t, c) => t + c.unapplied, 0);
      return await desk.confirm(
        `This customer has ${formatMoney(sum)} in available credits. Do you want to apply them to this invoice now?`,
        { title: 'Available Credits' },
      );
    } catch {
      return false;
    }
  };

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const wasNew = txnIdRef.current === null;
      const { ok, field, saved } = await commitAndSave();
      if (!ok) {
        refocus(field);
        return;
      }
      const id = txnIdRef.current;
      const cust = formRef.current.customerId;
      let applyFor: number | null = null;
      if (saved && wasNew && id !== null && cust !== null && (await offerCredits(cust))) applyFor = id;
      if (mode === 'close') desk.close(winId);
      else if (mode === 'new') {
        await startNew();
        focusCustomer();
      } else refocus(field);
      if (applyFor !== null) desk.open('applycredits', { invoiceId: applyFor });
    } finally {
      busy.current = false;
    }
  };

  /**
   * Unsaved changes before leaving this document: Yes saves, No discards, Cancel stays.
   * Resolves whether to go on.
   */
  const askSave = async (quiet = false): Promise<boolean> => {
    const field = commitActiveField({ quiet });
    if (!quiet && !(await settleQuickFill())) return false;
    if (!isDirty()) return true;
    const i = await desk.messageBox(`You have changed the ${text.noun}. Do you want to save the changes?`, {
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
      const adj = await api.get<{ prev: number | null; next: number | null }>(
        `/api/txns/adjacent?type=${type}&id=${id ?? ''}`,
      );
      const target = dir === 'prev' ? adj.prev : adj.next;
      if (target !== null) {
        await load(target);
        focusCustomer();
      } else if (dir === 'next' && id !== null) {
        // Past the last one: a new, blank form (as QuickBooks does).
        await startNew();
        focusCustomer();
      } else {
        desk.setStatus(dir === 'prev' ? `This is the first ${text.noun}.` : `This is the last ${text.noun}.`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  /** Clear (a new form) or Revert (a saved one: back to what is stored). */
  const clearOrRevert = async () => {
    if (busy.current || loading) return;
    const id = txnIdRef.current;
    if (id === null) {
      const num = formRef.current.num;
      const f = newForm(num);
      setForm(f);
      snapshot.current = serialize(f); // a cleared new form has nothing to save
      setError(null);
      setNote(null);
      focusCustomer();
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
      desk.setStatus(`${docLabel(type, formRef.current.num)} deleted.`);
      desk.refresh();
      await startNew();
      focusCustomer();
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  /** The saved document's id, saving first if there are unsaved changes; null if it could not be saved. */
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
      if (id === null) setError(`Fill in the ${text.noun} first.`);
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

  const send = async () => {
    const id = await savedId();
    if (id !== null) desk.open('email', { txnId: id });
  };

  const needSaved = (what: string, fn: (id: number) => void) => () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus(`Save the ${text.noun} first to see its ${what}.`);
    else fn(id);
  };
  const history = needSaved('history', (id) => desk.open('txnhistory', { txnId: id }));
  const journal = needSaved('transaction journal', (id) => desk.open('txnjournal', { txnId: id }));

  const applyCredits = () => {
    const id = txnIdRef.current;
    if (id !== null && isInvoice) desk.open('applycredits', { invoiceId: id });
  };
  const receivePayments = () => {
    const cust = formRef.current.customerId ?? docRef.current?.name_id ?? null;
    openWindow(desk, 'payment', cust !== null ? { id: null, customerId: cust } : { id: null }, 'Receive Payments');
  };

  const openArRegister = () => {
    const ar = docRef.current?.ar_account_id ?? accounts?.find((a) => a.type === 'AR' && a.system_role === 'AR')?.id ?? accounts?.find((a) => a.type === 'AR')?.id;
    if (ar !== undefined) desk.open('register', { accountId: ar });
    else desk.setStatus('There is no Accounts Receivable account yet.');
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
          focusCustomer();
        })
        .finally(() => (busy.current = false));
    },
    delete: txnId !== null ? () => void remove() : undefined,
    insertLine: () => gridRef.current?.insertLine(),
    deleteLine: () => gridRef.current?.deleteLine(),
    register: openArRegister,
    print: () => void print(),
    history,
    txnJournal: journal,
    confirmClose: () => (loading ? true : askSave(true)),
  });

  // Window-level Alt keys (letters no menu uses): Previous, Next, Send, Apply Credits, Receive Payments.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act: Record<string, (() => void) | undefined> = {
      KeyP: () => void go('prev'),
      KeyX: () => void go('next'),
      KeyD: () => void send(),
      KeyT: isInvoice && txnId !== null ? applyCredits : undefined,
      KeyM: isInvoice && txnId !== null ? receivePayments : undefined,
    };
    const fn = act[e.code];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const customerOptions = useMemo(() => {
    const cur = form.customerId;
    return (customers ?? []).filter((n) => !n.inactive || n.id === cur).map((n) => ({ id: n.id, label: n.full_name }));
  }, [customers, form.customerId]);
  const termsOptions = useMemo(
    () => (terms ?? []).filter((t) => !t.inactive || t.id === form.termsId).map((t) => ({ id: t.id, label: t.name })),
    [terms, form.termsId],
  );

  const total = linesTotal(form.lines, imap);
  // Applied so far (payments and credits to an invoice, or this credit to invoices).
  const applied = doc ? (isInvoice ? doc.total - (doc.open_balance ?? doc.total) : doc.total - (doc.unapplied ?? doc.total)) : 0;
  const dis = loading;

  return (
    <div className="form-window sales-form" onKeyDown={onKeyDown}>
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
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void send()} title="Alt+D">
          <Mnemonic label="Sen&d" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={history} title="Ctrl+H">
          History
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={journal} title="Ctrl+Y">
          Journal
        </button>
        {doc?.is_finance_charge && <span className="fc-flag">Finance charge</span>}
      </div>

      {error && <div className="msg-strip error">{error}</div>}
      {note && <div className="msg-strip info">{note}</div>}

      <div className="sf-head">
        <div className="sf-cust" ref={customerRef}>
          <label className="stack">
            Customer:Job
            <Combo
              options={customerOptions}
              value={form.customerId}
              onChange={chooseCustomer}
              disabled={dis}
              {...nameQuickFill(desk, 'customer')}
            />
          </label>
        </div>
        <h2 className="sf-title">{isInvoice ? 'Invoice' : 'Credit Memo'}</h2>
        <div className="sf-datenum">
          <label className="stack">
            Date
            <DateField
              value={form.date}
              disabled={dis}
              onChange={(date) =>
                set(isInvoice ? { date, dueDate: dueDate(termsFor(formRef.current.termsId), date) } : { date })
              }
            />
          </label>
          <label className="stack">
            {text.numLabel}
            <input
              className="field num-field"
              value={form.num}
              maxLength={20}
              disabled={dis}
              onChange={(e) => set({ num: e.target.value })}
              onFocus={(e) => e.target.select()}
            />
          </label>
        </div>
      </div>

      <div className="sf-addrs">
        <label className="stack">
          {isInvoice ? 'Bill To' : 'Customer'}
          <textarea className="field addr-box" rows={5} value={form.billAddr} disabled={dis} onChange={(e) => set({ billAddr: e.target.value })} />
        </label>
        {isInvoice && (
          <label className="stack">
            Ship To
            <textarea className="field addr-box" rows={5} value={form.shipAddr} disabled={dis} onChange={(e) => set({ shipAddr: e.target.value })} />
          </label>
        )}
      </div>

      <div className="sf-fields">
        <label className="stack">
          P.O. No.
          <input className="field" value={form.po} disabled={dis} onChange={(e) => set({ po: e.target.value })} />
        </label>
        {isInvoice && (
          <>
            <label className="stack">
              Terms
              <Combo
                options={termsOptions}
                value={form.termsId}
                disabled={dis}
                onChange={(termsId) => set({ termsId, dueDate: dueDate(termsFor(termsId), formRef.current.date) })}
                {...termsQuickFill(desk)}
              />
            </label>
            <label className="stack">
              Due Date
              <DateField value={form.dueDate} disabled={dis} onChange={(d) => set({ dueDate: d })} />
            </label>
            <label className="stack">
              Ship
              <DateField value={form.shipDate} allowEmpty disabled={dis} onChange={(d) => set({ shipDate: d })} />
            </label>
            <label className="stack">
              Via
              <input className="field" value={form.via} disabled={dis} onChange={(e) => set({ via: e.target.value })} />
            </label>
          </>
        )}
      </div>

      <LineGrid ref={gridRef} lines={form.lines} setLines={setLines} items={items} accounts={accounts} minRows={MIN_ROWS} disabled={dis} />

      <div className="sf-foot">
        <div className="sf-foot-left">
          <label className="stack">
            Customer Message
            <textarea className="field" rows={2} value={form.message} disabled={dis} onChange={(e) => set({ message: e.target.value })} />
          </label>
          <label className="inline-fields">
            Memo
            <input className="field" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
          </label>
          <div className="inline-fields">
            <label className="check">
              <input type="checkbox" checked={form.toPrint} disabled={dis} onChange={(e) => set({ toPrint: e.target.checked })} />
              To be printed
            </label>
            <label className="check">
              <input type="checkbox" checked={form.toEmail} disabled={dis} onChange={(e) => set({ toEmail: e.target.checked })} />
              To be e-mailed
            </label>
          </div>
        </div>
        <table className="sf-totals">
          <tbody>
            <tr>
              <th>Total</th>
              <td className="total">{formatMoney(total)}</td>
            </tr>
            {doc && isInvoice && (
              <>
                <tr>
                  <th>Payments Applied</th>
                  <td>{formatMoney(applied)}</td>
                </tr>
                <tr>
                  <th>Balance Due</th>
                  <td className="total">{formatMoney(total - applied)}</td>
                </tr>
              </>
            )}
            {doc && !isInvoice && (
              <tr>
                <th>Remaining Credit</th>
                <td className="total">{formatMoney(total - applied)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="button-row">
        {isInvoice && txnId !== null && (
          <>
            <button type="button" className="btn" disabled={dis} onClick={applyCredits} title="Alt+T">
              <Mnemonic label="Apply Credi&ts..." />
            </button>
            <button type="button" className="btn" disabled={dis} onClick={receivePayments} title="Alt+M">
              <Mnemonic label="Receive Pay&ments" />
            </button>
          </>
        )}
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

export const Invoice = (p: WinProps) => <SalesForm {...p} type="INVOICE" />;
export const CreditMemo = (p: WinProps) => <SalesForm {...p} type="CREDITMEMO" />;
