import { evalAmount, itemType, type Item } from '@rapidbooks/shared';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { parseAmount } from '../controls/AmountField';
import { formatRate, parseRate } from '../controls/RateField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic } from '../util';
import { visibleRows } from './ListWindow';

/** The item types whose price can be changed here (as in QuickBooks: not groups, subtotals or discounts). */
const TYPES = [
  { code: 'SERVICE', label: 'Service' },
  { code: 'PART', label: 'Non-inventory Part' },
  { code: 'OTHER_CHARGE', label: 'Other Charge' },
] as const;

const ROUNDING = [
  { label: 'no rounding', step: 0 },
  { label: '0.01', step: 1 },
  { label: '0.05', step: 5 },
  { label: '0.10', step: 10 },
  { label: '0.25', step: 25 },
  { label: '0.50', step: 50 },
  { label: '1.00', step: 100 },
  { label: '5.00', step: 500 },
  { label: '10.00', step: 1000 },
];

interface Row {
  id: number;
  name: string;
  description: string;
  inactive: boolean;
  parent_id: number | null;
  current: number; // cents, up to 3 decimals
  cost: number;
}

/** Cents to at most 3 decimals (the server's precision for prices). */
const r3 = (c: number) => Math.round(c * 1000) / 1000;

/**
 * Lists > Item List > Activities > Change Item Prices. Choose a type, tick items (or type new
 * prices), adjust the ticked ones by an amount or a percentage, then OK saves every changed
 * price at once. Space ticks the row you are on; Up/Down move between rows.
 */
export function ChangeItemPrices({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: items } = useData<Item[]>('/api/items');
  const [type, setType] = useState<string>('PART');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [prices, setPrices] = useState<Map<number, number>>(new Map());
  const [adjust, setAdjust] = useState('0.00');
  const [basis, setBasis] = useState<'price' | 'cost'>('price');
  const [rounding, setRounding] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ids = { type: useId(), adjust: useId(), basis: useId(), round: useId() };

  const rows: Row[] = useMemo(() => {
    const all = visibleRows(items ?? [], includeInactive);
    return all
      .filter((i) => i.type === type && itemType(i.type).hasRate && !i.rate_is_percent)
      .map((i) => ({
        id: i.id,
        name: i.full_name,
        description: i.description.split('\n', 1)[0],
        inactive: i.inactive,
        parent_id: i.parent_id,
        current: i.rate,
        cost: i.cost,
      }));
  }, [items, type, includeInactive]);

  // A new type starts with nothing ticked.
  useEffect(() => setMarked(new Set()), [type]);

  const newPrice = (r: Row) => prices.get(r.id);
  const changed = rows.filter((r) => newPrice(r) !== undefined && newPrice(r) !== r.current);
  const allMarked = rows.length > 0 && rows.every((r) => marked.has(r.id));

  const toggle = (id: number) =>
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setPrice = (id: number, cents: number | null) =>
    setPrices((prev) => {
      const next = new Map(prev);
      if (cents === null) next.delete(id);
      else next.set(id, r3(cents));
      return next;
    });

  const doAdjust = () => {
    setError(null);
    const t = adjust.trim();
    let fn: (base: number) => number;
    if (t.endsWith('%')) {
      const bp = evalAmount(t.slice(0, -1));
      if (bp === null) return setError('Type the adjustment as an amount (2.50) or a percentage (10% or -5%).');
      fn = (b) => b * (1 + bp / 10000);
    } else {
      const amt = parseAmount(t, 5);
      if (amt === null) return setError('Type the adjustment as an amount (2.50) or a percentage (10% or -5%).');
      fn = (b) => b + amt;
    }
    const step = ROUNDING[rounding].step;
    const round = (c: number) => (step ? Math.ceil(c / step - 1e-9) * step : c);
    const targets = rows.filter((r) => marked.has(r.id));
    if (targets.length === 0) return setError('Tick the items to adjust first (Space ticks the row you are on, or use Mark All).');
    for (const r of targets) setPrice(r.id, Math.max(0, round(fn(basis === 'cost' ? r.cost : r.current))));
  };

  const ok = async () => {
    commitActiveField();
    if (saving) return;
    // Read after the commit: the field just left may have set a price.
    await new Promise((r) => setTimeout(r, 0));
    const list = rowsRef.current.filter((r) => pricesRef.current.has(r.id) && pricesRef.current.get(r.id) !== r.current);
    if (list.length === 0) {
      desk.close(winId);
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/items/prices', { prices: list.map((r) => ({ id: r.id, rate: pricesRef.current.get(r.id)! })) });
      desk.refresh();
      desk.setStatus(`${list.length === 1 ? 'One price' : `${list.length} prices`} changed.`);
      desk.close(winId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pricesRef = useRef(prices);
  pricesRef.current = prices;

  useWindowCommands(winId, {
    save: () => void ok(),
    saveClose: () => void ok(),
    confirmClose: async () => {
      if (changed.length === 0) return true;
      return desk.confirm(`You have changed ${changed.length === 1 ? 'one price' : `${changed.length} prices`}. Close without saving them?`, {
        yes: '&Close',
        no: '&Cancel',
        defaultNo: true,
      });
    },
  });

  const onGridKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    if (Number.isNaN(row)) return;
    if (e.key === ' ') {
      e.preventDefault();
      const r = rows[row];
      if (r) toggle(r.id);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus();
  };

  return (
    <div className="f13 cip" ref={rootRef}>
      <div className="f13-page">
        <label className="cip-type" htmlFor={ids.type}>
          <Mnemonic label="&Item Type" />
        </label>
        <select id={ids.type} className="field cip-select" value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        {error && <div className="msg-strip error">{error}</div>}
        <div className="grid-wrap grow-grid">
          <table className="line-grid">
            <colgroup>
              <col style={{ width: '2rem' }} />
              <col style={{ width: '27%' }} />
              <col />
              <col style={{ width: '20%' }} />
              <col style={{ width: '20%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className="al-center">✓</th>
                <th>Item</th>
                <th>Description</th>
                <th className="al-right">Current Price</th>
                <th>New Price</th>
              </tr>
            </thead>
            <tbody onKeyDown={onGridKey}>
              {rows.map((r, i) => {
                const np = newPrice(r);
                return (
                  <tr key={r.id} className={r.inactive ? 'inactive' : undefined}>
                    <td className="al-center rcv-check" onClick={() => toggle(r.id)}>
                      {marked.has(r.id) ? '✓' : ''}
                    </td>
                    <td className="cell-text">{r.name}</td>
                    <td className="cell-text">{r.description}</td>
                    <td className="cell-text al-right">{formatRate({ rate: r.current, percent: false })}</td>
                    <td>
                      <PriceCell row={i} value={np} label={`New price for ${r.name}`} onChange={(c) => setPrice(r.id, c)} />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="cell-text grey">
                    {items ? 'There are no items of this type.' : 'Loading...'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="cip-checks">
          <label className="check">
            <input
              type="checkbox"
              checked={allMarked}
              onChange={(e) => setMarked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
            />
            <Mnemonic label="&Mark All" />
          </label>
          <label className="check">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Include inactive
          </label>
        </div>
        <div className="cip-adjust">
          <label htmlFor={ids.adjust}>Adjust price of marked items by (amount or %)</label>
          <input
            id={ids.adjust}
            className="field amount-field cip-amt"
            value={adjust}
            onChange={(e) => setAdjust(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
          <label htmlFor={ids.basis}>based on</label>
          <select id={ids.basis} className="field cip-select" value={basis} onChange={(e) => setBasis(e.target.value as 'price' | 'cost')}>
            <option value="price">Current Price</option>
            <option value="cost">Unit Cost</option>
          </select>
          <span className="spacer" />
          <button type="button" className="btn" onClick={doAdjust}>
            <Mnemonic label="A&djust" />
          </button>
          <label htmlFor={ids.round}>Round up to nearest</label>
          <select id={ids.round} className="field cip-round" value={rounding} onChange={(e) => setRounding(Number(e.target.value))}>
            {ROUNDING.map((x, i) => (
              <option key={x.label} value={i}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div className="f13-buttons">
          <span className="f13-note">
            {changed.length > 0 ? `${changed.length === 1 ? 'One price' : `${changed.length} prices`} will change.` : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={saving} onClick={() => void ok()} title="Ctrl+Enter">
            OK
          </button>
          <button type="button" className="btn" onClick={() => void desk.requestClose(winId)} title="Esc">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** A New Price cell: money with up to five decimals; empty = leave the price as it is. */
function PriceCell({ row, value, label, onChange }: { row: number; value: number | undefined; label: string; onChange: (cents: number | null) => void }) {
  const shown = value === undefined ? '' : formatRate({ rate: value, percent: false });
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <input
      className="field amount-field"
      data-row={row}
      aria-label={label}
      value={text}
      autoComplete="off"
      onChange={(e) => setText(e.target.value.replace(/ /g, ''))}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (text === shown) return;
        if (text.trim() === '') return onChange(null);
        const v = parseRate(text);
        if (v === null || v.percent || v.rate < 0) setText(shown);
        else onChange(v.rate);
      }}
    />
  );
}
