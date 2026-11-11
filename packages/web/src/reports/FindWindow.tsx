import { formatMoney, formatUsDate, TXN_TYPE_LABELS, type Account, type FindResult, type FindRow, type Item, type Name } from '@rapidbooks/shared';
import { useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { ListView, type Column } from '../controls/ListView';
import { openTxn } from '../forms/openTxn';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';
import { emptyFind, findUrl, type FindForm } from './reportQuery';
import './reports.css';

/** Edit > Find (Ctrl+F): find transactions by type, name, dates, number, amount, memo, account or item. */
export function FindWindow({ winId }: WinProps) {
  const desk = useDesktop();
  const [form, setForm, formRef] = useLiveState<FindForm>(emptyFind);
  const [result, setResult] = useState<FindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLSelectElement>(null);
  const { data: names } = useData<Name[]>('/api/names');
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: items } = useData<Item[]>('/api/items');

  const set = <K extends keyof FindForm>(k: K, v: FindForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const find = async () => {
    const back = commitActiveField(); // commit what is typed in the field she is in
    const f = formRef.current;
    if (f.from && f.to && f.from > f.to) {
      setError('The From date is after the To date.');
      refocus(back);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<FindResult>(findUrl(f));
      setResult(r);
      setSelected(r.rows[0]?.id ?? null);
      desk.setStatus(`${r.rows.length}${r.more ? '+' : ''} transaction${r.rows.length === 1 ? '' : 's'} found.`);
      // Results in hand: the list takes the keyboard (Enter opens the transaction).
      if (r.rows.length) setTimeout(() => rootRef.current?.querySelector<HTMLElement>('.listview')?.focus(), 0);
      else refocus(back);
    } catch (e) {
      setError(errorMessage(e));
      refocus(back);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setForm(emptyFind());
    setResult(null);
    setError(null);
    setSelected(null);
    firstRef.current?.focus();
  };

  const rows = result?.rows ?? [];
  const current = rows.find((r) => r.id === selected) ?? null;
  const goTo = (r: FindRow | null) => r && openTxn(desk, r.type, r.id);

  useWindowCommands(winId, { save: () => void find(), edit: () => goTo(current) });

  // Enter in any search field runs Find (an open Combo list keeps its Enter to itself).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('.listview') || t.tagName === 'BUTTON') return;
    e.preventDefault();
    void find();
  };

  const nameOptions = (names ?? []).map((n) => ({ id: n.id, label: n.full_name }));
  const accountOptions = (accounts ?? []).map((a) => ({ id: a.id, label: a.full_name }));
  const itemOptions = (items ?? []).map((i) => ({ id: i.id, label: i.full_name }));

  const columns: Column<FindRow>[] = [
    { key: 'date', title: 'Date', width: '6.5rem', render: (r) => formatUsDate(r.date) },
    { key: 'type', title: 'Type', width: '8.5rem', render: (r) => r.type_label },
    { key: 'num', title: 'Num', width: '5rem', render: (r) => r.num },
    { key: 'name', title: 'Name', width: '20%', render: (r) => r.name },
    { key: 'account', title: 'Account', width: '18%', render: (r) => r.account },
    { key: 'memo', title: 'Memo', render: (r) => r.memo },
    { key: 'amount', title: 'Amount', width: '7.5rem', align: 'right', render: (r) => formatMoney(r.amount) },
  ];

  const id = (k: string) => `${winId}-${k}`;
  return (
    <div className="list-window rpt-resizable" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="find-form">
        <label htmlFor={id('type')}>Transaction Type</label>
        <select id={id('type')} ref={firstRef} className="field" value={form.type} onChange={(e) => set('type', e.target.value)}>
          <option value="">Any</option>
          {Object.entries(TXN_TYPE_LABELS).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
        <label htmlFor={id('name')}>Customer/Vendor/Name</label>
        <Combo id={id('name')} options={nameOptions} value={form.nameId} onChange={(v) => set('nameId', v)} aria-label="Name" />

        <label htmlFor={id('from')}>Date From</label>
        <span className="find-pair">
          <DateField id={id('from')} value={form.from} allowEmpty onChange={(v) => set('from', v)} />
          To
          <DateField value={form.to} allowEmpty onChange={(v) => set('to', v)} aria-label="Date To" />
        </span>
        <label htmlFor={id('num')}>Number</label>
        <input id={id('num')} className="field" value={form.num} maxLength={20} onChange={(e) => set('num', e.target.value)} />

        <label htmlFor={id('amtmode')}>Amount</label>
        <span className="find-pair">
          <select id={id('amtmode')} className="field" style={{ width: '6.5rem' }} value={form.amountMode} onChange={(e) => set('amountMode', e.target.value as FindForm['amountMode'])}>
            <option value="exact">Exactly</option>
            <option value="range">From</option>
          </select>
          {form.amountMode === 'exact' ? (
            <AmountField value={form.amount} onChange={(v) => set('amount', v)} aria-label="Amount" />
          ) : (
            <>
              <AmountField value={form.amountMin} onChange={(v) => set('amountMin', v)} aria-label="Amount from" />
              to
              <AmountField value={form.amountMax} onChange={(v) => set('amountMax', v)} aria-label="Amount to" />
            </>
          )}
        </span>
        <label htmlFor={id('text')}>Memo/Description</label>
        <input id={id('text')} className="field" value={form.text} onChange={(e) => set('text', e.target.value)} />

        <label htmlFor={id('account')}>Account</label>
        <Combo id={id('account')} options={accountOptions} value={form.accountId} onChange={(v) => set('accountId', v)} listName="Account" aria-label="Account" />
        <label htmlFor={id('item')}>Item</label>
        <Combo id={id('item')} options={itemOptions} value={form.itemId} onChange={(v) => set('itemId', v)} listName="Item" aria-label="Item" />
      </div>
      <div className="button-row" style={{ paddingTop: 0, paddingBottom: '0.5rem' }}>
        <button type="button" className="btn default" onClick={() => void find()} disabled={busy} title="Enter">
          {busy ? 'Finding...' : 'Find'}
        </button>
        <button type="button" className="btn" onClick={reset}>
          Reset
        </button>
        <span className="spacer" />
        <button type="button" className="btn" disabled={!current} onClick={() => goTo(current)} title="Enter on a result, or Ctrl+E">
          Go To
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={goTo}
        emptyText={result ? 'No transactions match. Change the search and press Find.' : 'Fill in what you know and press Enter to find.'}
        label="Found transactions"
      />
      {result?.more && <div className="find-more">More transactions match than are shown. Narrow the search.</div>}
      {result && (
        <div className="graph-hint">
          {rows.length} transaction{rows.length === 1 ? '' : 's'} shown, newest first.
        </div>
      )}
    </div>
  );
}
