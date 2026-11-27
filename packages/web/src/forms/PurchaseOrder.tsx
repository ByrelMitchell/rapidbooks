import { formatMoney, todayIso, type Account, type Item, type Name, type PurchaseOrderInput, type PurchTxn } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { itemMap, LineGrid, linesForCompare, linesTotal, padLines, type GridLine, type LineGridHandle } from '../controls/LineGrid';
import { nameQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import { handOffLocked, confirmDeleteTxn } from './openTxn';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { companyShipTo, gridFromItemLines, isPurchasable, itemLinesToInput, nameOptions, purchLabel, vendorAddress } from './purchaseShared';
import { openPdf } from './salesDoc';
import './sales.css';
import './purchases.css';
import { openQuickReport } from '../reports/open';
import { Ribbon, RibbonBig, RibbonCheck, RibbonGroup, RibbonStack, RibbonStart, SaveButtons } from './Ribbon';

interface Form {
  vendorId: number | null;
  date: string;
  num: string;
  vendorAddr: string;
  shipTo: string;
  expected: string;
  lines: GridLine[];
  message: string;
  memo: string;
  toPrint: boolean;
  closed: boolean;
}

const MIN_ROWS = 6;
const TITLES = { item: 'Item', description: 'Description', qty: 'Qty', rate: 'Rate', amount: 'Amount' };

const newForm = (num = '', shipTo = ''): Form => ({
  vendorId: null,
  date: todayIso(),
  num,
  vendorAddr: '',
  shipTo,
  expected: '',
  lines: padLines([], MIN_ROWS),
  message: '',
  memo: '',
  toPrint: false,
  closed: false,
});

const serialize = (f: Form) => JSON.stringify({ ...f, lines: linesForCompare(f.lines) });

/** Create Purchase Orders (non-posting). Props: { id: number | null, vendorId? }. */
export function PurchaseOrder({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const presetVendor = (props.vendorId as number | undefined) ?? null;
  const desk = useDesktop();
  const { data: vendors } = useData<Name[]>('/api/names?kind=vendor');
  const { data: customers } = useData<Name[]>('/api/names?kind=customer');
  const { data: items, error: itemsError } = useData<Item[]>('/api/items');
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const imap = useMemo(() => itemMap(items), [items]);

  const [form, setForm, formRef] = useLiveState<Form>(() => newForm());
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const [doc, setDoc] = useState<PurchTxn | null>(null);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(propId !== null);
  const busy = useRef(false);
  const gridRef = useRef<LineGridHandle>(null);
  const vendorRef = useRef<HTMLDivElement>(null);
  const pendingVendor = useRef<number | null>(presetVendor);
  const shipTo = useRef('');

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const focusVendor = () => vendorRef.current?.querySelector<HTMLInputElement>('input')?.focus();

  const applyDoc = (t: PurchTxn) => {
    const prev = formRef.current.lines;
    const lines = padLines(gridFromItemLines(t.items), MIN_ROWS).map((l, i) => (prev[i] ? { ...l, key: prev[i].key } : l));
    const f: Form = {
      vendorId: t.name_id,
      date: t.date,
      num: t.num,
      vendorAddr: t.address,
      shipTo: t.ship_addr,
      expected: t.expected_date,
      lines,
      message: t.message,
      memo: t.memo,
      toPrint: t.to_print,
      closed: t.closed,
    };
    setForm(f);
    snapshot.current = serialize(f);
    version.current = t.version;
    setDoc(t);
    setTxnId(t.id);
  };

  const load = async (id: number): Promise<boolean> => {
    try {
      const t = await api.get<PurchTxn>(`/api/txns/${id}`);
      if (handOffLocked(desk, winId, t)) return false;
      if (t.type !== 'PURCHORD') {
        setError('That transaction is not a purchase order.');
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

  /** A blank purchase order with the next P.O. number and the company as Ship To. */
  const startNew = async () => {
    const f = newForm('', shipTo.current);
    setForm(f);
    snapshot.current = serialize(f);
    setTxnId(null);
    setDoc(null);
    version.current = undefined;
    setError(null);
    try {
      const [{ num }, ship] = await Promise.all([
        api.get<{ num: string }>('/api/txns/next-num?type=PURCHORD'),
        shipTo.current ? Promise.resolve(shipTo.current) : companyShipTo(),
      ]);
      shipTo.current = ship;
      if (txnIdRef.current !== null) return;
      const untouched = !isDirty();
      setForm((cur) => ({ ...cur, num: cur.num === '' ? num : cur.num, shipTo: cur.shipTo === '' ? ship : cur.shipTo }));
      if (untouched) snapshot.current = serialize(formRef.current);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || (!items && !itemsError)) return;
    opened.current = true;
    if (propId === null) void startNew();
    else void load(propId).finally(() => setLoading(false));
  }, [items, itemsError]);

  // Bills received against it close it elsewhere: show the current state.
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
  const setLines = (fn: (prev: GridLine[]) => GridLine[]) => {
    setError(null);
    setForm((f) => ({ ...f, lines: fn(f.lines) }));
  };

  const chooseVendor = (id: number | null) => {
    set({ vendorId: id });
    if (id === null) return;
    set({ vendorAddr: vendorAddress(vendors?.find((v) => v.id === id)) });
  };

  // A new P.O. opened for a vendor (Vendor List).
  useEffect(() => {
    const id = pendingVendor.current;
    if (id === null || !opened.current || !vendors || loading || txnId !== null) return;
    pendingVendor.current = null;
    const clean = !isDirty();
    chooseVendor(id);
    if (clean) snapshot.current = serialize(formRef.current);
  }, [vendors, loading, txnId, items, itemsError]);

  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const id = txnIdRef.current;
    if (f.vendorId === null) {
      setError('Choose the vendor for this purchase order.');
      return false;
    }
    const body: PurchaseOrderInput = {
      type: 'PURCHORD',
      date: f.date,
      num: f.num.trim(),
      name_id: f.vendorId,
      memo: f.memo,
      ...(id !== null ? { version: version.current } : {}),
      address: f.vendorAddr,
      ship_addr: f.shipTo,
      expected_date: f.expected,
      message: f.message,
      closed: f.closed,
      to_print: f.toPrint,
      lines: itemLinesToInput(f.lines),
    };
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      const t = await api.get<PurchTxn>(`/api/txns/${r.id}`);
      applyDoc(t);
      setError(null);
      desk.refresh();
      desk.setStatus(`${purchLabel('PURCHORD', t.num)} saved.`);
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
        await startNew();
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
    const i = await desk.messageBox('You have changed the purchase order. Do you want to save the changes?', {
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
      const adj = await api.get<{ prev: number | null; next: number | null }>(`/api/txns/adjacent?type=PURCHORD&id=${id ?? ''}`);
      const target = dir === 'prev' ? adj.prev : adj.next;
      if (target !== null) {
        await load(target);
        focusVendor();
      } else if (dir === 'next' && id !== null) {
        await startNew();
        focusVendor();
      } else desk.setStatus(dir === 'prev' ? 'This is the first purchase order.' : 'This is the last purchase order.');
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
      const f = newForm(formRef.current.num, shipTo.current);
      setForm(f);
      snapshot.current = serialize(f);
      setError(null);
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
      desk.setStatus(`${purchLabel('PURCHORD', formRef.current.num)} deleted.`);
      desk.refresh();
      await startNew();
      focusVendor();
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const print = async () => {
    if (busy.current || loading) return;
    busy.current = true;
    let id: number | null = null;
    try {
      const { ok, field } = await commitAndSave();
      if (!ok) {
        refocus(field);
        return;
      }
      id = txnIdRef.current;
      if (id === null) setError('Fill in the purchase order first.');
    } finally {
      busy.current = false;
    }
    if (id !== null && !openPdf(id)) desk.setStatus('The browser blocked the new tab. Allow pop-ups for RapidBooks, then print again.');
  };

  const history = () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus('Save the purchase order first to see its history.');
    else desk.open('txnhistory', { txnId: id });
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
        .then(async (ok) => {
          if (!ok) return;
          await startNew();
          focusVendor();
        })
        .finally(() => (busy.current = false));
    },
    delete: txnId !== null ? () => void remove() : undefined,
    insertLine: () => gridRef.current?.insertLine(),
    deleteLine: () => gridRef.current?.deleteLine(),
    print: () => void print(),
    history,
    confirmClose: () => (loading ? true : askSave(true)),
  });

  // Alt+P Previous, Alt+X Next (letters no menu uses).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const fn = e.code === 'KeyP' ? () => void go('prev') : e.code === 'KeyX' ? () => void go('next') : undefined;
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const vendorOptions = useMemo(() => nameOptions(vendors, [form.vendorId]), [vendors, form.vendorId]);
  const customerOptions = useMemo(() => nameOptions(customers, form.lines.map((l) => l.nameId)), [customers, form.lines]);
  const total = linesTotal(form.lines, imap);
  const received = doc?.bill_ids.length ?? 0;
  // What bills have received of each item line, as saved (QuickBooks' Rcv'd column).
  const rcvd = (doc?.items ?? []).filter((l) => l.item_id !== null);
  const partly = received > 0 && rcvd.some((l) => (l.received_qty ?? 0) !== 0 || l.received_amount !== 0);
  const fullyReceived =
    received > 0 && (!partly || rcvd.every((l) => (l.qty !== null && l.qty > 0 ? (l.received_qty ?? 0) >= l.qty : l.received_amount >= l.amount)));
  const itemName = (id: number | null) => items?.find((i) => i.id === id)?.name ?? '';
  const formatQty = (n: number) => (Math.round(n * 100000) / 100000).toLocaleString('en-US', { maximumFractionDigits: 5 });
  const dis = loading;

  /** Ribbon > Create a Copy: the same vendor and lines as a new, unsaved purchase order with the next number. */
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
      setForm({ ...src, num: '', closed: false });
      snapshot.current = serialize(newForm('', shipTo.current));
      const { num } = await api.get<{ num: string }>('/api/txns/next-num?type=PURCHORD');
      if (txnIdRef.current === null && formRef.current.num === '') setForm((cur) => ({ ...cur, num }));
      desk.setStatus('This is a copy. Save it to record a new purchase order.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

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
        <RibbonBig icon="closed" label={form.closed ? 'Mark As\nOpen' : 'Mark As\nClosed'} disabled={dis} onClick={() => set({ closed: !form.closed })} />
      </RibbonGroup>
      <RibbonGroup>
        <RibbonBig icon="print" label="Print" keys="Ctrl+P" disabled={dis} onClick={() => void print()} />
        <RibbonStack>
          <RibbonCheck label="Print Later" checked={form.toPrint} disabled={dis} onChange={(toPrint) => set({ toPrint })} />
        </RibbonStack>
      </RibbonGroup>
      <RibbonGroup>
        <RibbonBig
          icon="receipt"
          label={'Enter Bill\nfor this PO'}
          disabled={dis || txnId === null || form.closed || form.vendorId === null}
          onClick={() => form.vendorId !== null && txnId !== null && desk.open('bill', { id: null, vendorId: form.vendorId, poId: txnId })}
        />
      </RibbonGroup>
    </>
  );
  const reportsTab = (
    <RibbonGroup>
      <RibbonBig icon="history" label={'Transaction\nHistory'} keys="Ctrl+H" disabled={dis || txnId === null} onClick={history} />
      <RibbonBig
        icon="report"
        label={'Vendor\nQuickReport'}
        keys="Ctrl+Q"
        disabled={form.vendorId === null}
        onClick={() => form.vendorId !== null && openQuickReport(desk, { name_id: form.vendorId })}
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

      <div className="f13-band" ref={vendorRef}>
        <label>
          Vendor
          <Combo options={vendorOptions} value={form.vendorId} onChange={chooseVendor} disabled={dis} aria-label="Vendor" {...nameQuickFill(desk, 'vendor')} />
        </label>
        <span className="spacer" />
        {doc?.closed && <span className="band-flag">{fullyReceived ? 'Received in full' : 'Closed'}</span>}
        {!doc?.closed && form.closed && <span className="band-flag">Closed when saved</span>}
        {!doc?.closed && !form.closed && received > 0 && <span className="band-flag">Partially received</span>}
      </div>

      <div className="f13-page">
        {error && <div className="msg-strip error">{error}</div>}

        <div className="sf13-top">
          <h2 className="f13-title">Purchase Order</h2>
          <div className="sf13-datenum">
            <label className="cap">
              <span className="cap-text">Date</span>
              <DateField value={form.date} disabled={dis} onChange={(date) => set({ date })} />
            </label>
            <label className="cap">
              <span className="cap-text">P.O. Number</span>
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
          <label className="cap sf13-addr">
            <span className="cap-text">Vendor</span>
            <textarea className="field addr-box" value={form.vendorAddr} disabled={dis} onChange={(e) => set({ vendorAddr: e.target.value })} />
          </label>
          <label className="cap sf13-addr">
            <span className="cap-text">Ship To</span>
            <textarea className="field addr-box" value={form.shipTo} disabled={dis} onChange={(e) => set({ shipTo: e.target.value })} />
          </label>
        </div>

        <div className="sf13-fields">
          <label className="cap">
            <span className="cap-text">Expected</span>
            <DateField value={form.expected} allowEmpty disabled={dis} onChange={(expected) => set({ expected })} />
          </label>
        </div>

        <LineGrid
          ref={gridRef}
          lines={form.lines}
          setLines={setLines}
          items={items}
          accounts={accounts}
          itemFilter={isPurchasable}
          minRows={MIN_ROWS}
          disabled={dis}
          titles={TITLES}
          purchase
          customers={customerOptions}
        />
        {partly && !fullyReceived && (
          <div className="f13-note">
            Received on bills so far:{' '}
            {rcvd
              .map((l) =>
                l.qty !== null && l.qty > 0
                  ? `${itemName(l.item_id)} ${formatQty(l.received_qty ?? 0)} of ${formatQty(l.qty)}`
                  : `${itemName(l.item_id)} ${formatMoney(l.received_amount)} of ${formatMoney(l.amount)}`,
              )
              .join('; ')}
            .
          </div>
        )}

        <div className="sf13-foot">
          <div className="sf13-foot-left">
            <label className="cap">
              <span className="cap-text">Message</span>
              <textarea className="field" rows={2} value={form.message} disabled={dis} onChange={(e) => set({ message: e.target.value })} />
            </label>
            <label className="memo-row">
              <span className="cap-left">Memo</span>
              <input className="field" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
            </label>
          </div>
          <table className="sf13-totals">
            <tbody>
              <tr>
                <th className="plain">Total</th>
                <td className="big">{formatMoney(total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <SaveButtons disabled={dis} saved={txnId !== null} onSave={(m) => void save(m)} onClear={() => void clearOrRevert()} />
      </div>
    </div>
  );
}
