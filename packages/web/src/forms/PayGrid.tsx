import { formatMoney, lineAmount, type PayrollItem, type PayrollItemKind } from '@rapidbooks/shared';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type Ref } from 'react';
import { AmountField, parseAmount } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import type { QuickFill } from '../lists/quickAdd';
import { useDesktop, type Desktop } from '../shell/desktop';
import { commitActiveField } from '../util';

/** One paycheck line. Deductions and company contributions use only item and amount. */
export interface PayRow {
  key: number;
  itemId: number | null;
  /** Cents per hour (up to 3 decimals of a cent). Earnings only. */
  rate: number | null;
  hours: number | null;
  /** Typed amount, or null = hours × rate (earnings) / nothing yet. */
  amount: number | null;
}

let seq = 0;
export const blankPay = (): PayRow => ({ key: ++seq, itemId: null, rate: null, hours: null, amount: null });
export const isBlankPay = (r: PayRow) => r.itemId === null && r.rate === null && r.hours === null && r.amount === null;
export function padPay(rows: PayRow[], min = 1): PayRow[] {
  const out = rows.length === 0 || !isBlankPay(rows[rows.length - 1]) ? [...rows, blankPay()] : rows;
  return out.length >= min ? out : [...out, ...Array.from({ length: min - out.length }, blankPay)];
}
export const payForCompare = (rows: PayRow[]) => rows.filter((r) => !isBlankPay(r)).map(({ key: _k, ...rest }) => rest);

/** hours × rate, exactly as the server works it out (0 unless both are filled in). */
export const naturalPay = (r: PayRow) => (r.hours !== null && r.rate !== null ? lineAmount(r.hours, r.rate) : 0);
/** The line's amount in cents. */
export const payAmount = (r: PayRow) => r.amount ?? naturalPay(r);
export const payTotal = (rows: PayRow[]) => rows.reduce((t, r) => t + (isBlankPay(r) ? 0 : payAmount(r)), 0);

const formatHours = (h: number | null) => (h === null ? '' : h.toLocaleString('en-US', { maximumFractionDigits: 6 }));
/** Hours: a number (arithmetic allowed), up to 6 decimals; blank = none; undefined = not a number. */
function parseHours(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const v = parseAmount(text, 6);
  return v === null ? undefined : Math.round(v * 10000) / 1000000;
}

function HoursCell({
  value,
  onCommit,
  ...rest
}: { value: number | null; onCommit: (v: number | null) => void; 'data-row': number; 'data-col': string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  const shown = formatHours(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <input
      {...rest}
      type="text"
      className="field amount-field"
      value={text}
      inputMode="decimal"
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (text === shown) return;
        const v = parseHours(text);
        if (v === undefined) setText(shown);
        else {
          setText(formatHours(v));
          onCommit(v);
        }
      }}
    />
  );
}

/** Payroll item not on the list: Set Up (preset to the grid's kind) or Cancel. */
export function payrollItemQuickFill(d: Desktop, kind: PayrollItemKind): QuickFill {
  return {
    listName: 'Payroll Item',
    onNotFound: async (text) => {
      const i = await d.messageBox(`"${text}" is not in the Payroll Item list.`, {
        title: 'Payroll Item Not Found',
        icon: 'question',
        buttons: ['&Set Up', '&Cancel'],
      });
      if (i !== 0) return null;
      return d.openForResult('payrollitem', { id: null, name: text, kind });
    },
  };
}

type Col = 'item' | 'rate' | 'hours' | 'amount';

export interface PayGridHandle {
  insertLine: () => void;
  deleteLine: () => void;
  focusCell: (row?: number, col?: Col) => void;
}

interface Props {
  kind: PayrollItemKind;
  title: string;
  rows: PayRow[];
  setRows: (fn: (prev: PayRow[]) => PayRow[]) => void;
  items: PayrollItem[] | undefined;
  /** Year-to-date amount for a payroll item (this paycheck included), or null when not known. */
  ytd?: (itemId: number) => number | null;
  minRows?: number;
  disabled?: boolean;
  onFocusGrid?: () => void;
  ref?: Ref<PayGridHandle>;
}

/**
 * One of the paycheck grids. Earnings: Item, Rate, Hours, Amount (hours × rate unless an
 * amount is typed over it). Deductions and company contributions: Item, Amount. A YTD
 * column when `ytd` is given. Keyboard as in the other line grids.
 */
export function PayGrid({ kind, title, rows, setRows, items, ytd, minRows = 3, disabled, onFocusGrid, ref }: Props) {
  const desk = useDesktop();
  const earning = kind === 'earning';
  const rootRef = useRef<HTMLDivElement>(null);
  const curKey = useRef<number | null>(null);
  const focusReq = useRef<{ row: number; col: Col } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const options = useMemo(() => {
    const used = new Set(rows.map((r) => r.itemId));
    return (items ?? []).filter((p) => p.kind === kind && (!p.inactive || used.has(p.id))).map((p) => ({ id: p.id, label: p.name }));
  }, [items, rows, kind]);

  const focusCell = (row: number, col: Col) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
    if (el && !(el as HTMLInputElement).disabled) el.focus();
  };
  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    focusCell(req.row, req.col);
  });

  const update = (fn: (prev: PayRow[]) => PayRow[]) => setRows((prev) => padPay(fn(prev), minRows));
  const edit = (key: number, change: (r: PayRow) => PayRow) => update((prev) => prev.map((r) => (r.key === key ? change(r) : r)));
  const curIndex = () => {
    const i = rowsRef.current.findIndex((r) => r.key === curKey.current);
    return i < 0 ? 0 : i;
  };

  useImperativeHandle(ref, () => ({
    insertLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      update((prev) => [...prev.slice(0, i), blankPay(), ...prev.slice(i)]);
      focusReq.current = { row: i, col: 'item' };
    },
    deleteLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      const key = rowsRef.current[i]?.key;
      update((prev) => prev.filter((r) => r.key !== key));
      focusReq.current = { row: i, col: 'item' };
    },
    focusCell: (row = 0, col = 'item') => focusCell(row, col),
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    const col = t.dataset.col as Col | undefined;
    if (!col || Number.isNaN(row)) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    e.preventDefault();
    focusCell(next, col);
  };

  const label = title.toLowerCase();
  return (
    <div className="bk-paygrid" onFocus={onFocusGrid}>
      <div className="bk-paygrid-title">{title}</div>
      <div className="grid-wrap bk-grid" ref={rootRef}>
        <table className="line-grid">
          <colgroup>
            <col />
            {earning && <col style={{ width: '7.5rem' }} />}
            {earning && <col style={{ width: '5.5rem' }} />}
            <col style={{ width: '8rem' }} />
            {ytd && <col style={{ width: '8rem' }} />}
          </colgroup>
          <thead>
            <tr>
              <th>Item Name</th>
              {earning && <th className="al-right">Rate</th>}
              {earning && <th className="al-right">Hours</th>}
              <th className="al-right">Amount</th>
              {ytd && <th className="al-right">YTD</th>}
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {rows.map((r, i) => {
              const n = i + 1;
              const blank = isBlankPay(r);
              const y = ytd && r.itemId !== null ? ytd(r.itemId) : null;
              return (
                <tr key={r.key} onFocus={() => (curKey.current = r.key)}>
                  <td>
                    <Combo
                      options={options}
                      value={r.itemId}
                      onChange={(itemId) => edit(r.key, (x) => ({ ...x, itemId }))}
                      data-row={i}
                      data-col="item"
                      aria-label={`${title} item, line ${n}`}
                      disabled={disabled}
                      {...payrollItemQuickFill(desk, kind)}
                    />
                  </td>
                  {earning && (
                    <td>
                      <AmountField
                        decimals={5}
                        value={r.rate}
                        onChange={(rate) => edit(r.key, (x) => ({ ...x, rate, amount: null }))}
                        data-row={i}
                        data-col="rate"
                        aria-label={`Rate, ${label} line ${n}`}
                        disabled={disabled}
                      />
                    </td>
                  )}
                  {earning && (
                    <td>
                      <HoursCell
                        value={r.hours}
                        onCommit={(hours) => edit(r.key, (x) => ({ ...x, hours, amount: null }))}
                        data-row={i}
                        data-col="hours"
                        aria-label={`Hours, ${label} line ${n}`}
                        disabled={disabled}
                      />
                    </td>
                  )}
                  <td>
                    <AmountField
                      value={blank ? null : earning ? payAmount(r) : r.amount}
                      onChange={(v) =>
                        edit(r.key, (x) => {
                          if (!earning) return { ...x, amount: v };
                          const natural = naturalPay(x);
                          // Typing the computed figure (or clearing it) goes back to hours × rate.
                          return { ...x, amount: v === null || (v === natural && x.hours !== null && x.rate !== null) ? null : v };
                        })
                      }
                      data-row={i}
                      data-col="amount"
                      aria-label={`Amount, ${label} line ${n}`}
                      disabled={disabled}
                    />
                  </td>
                  {ytd && <td className="bk-ytd">{y !== null ? formatMoney(y) : ''}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
