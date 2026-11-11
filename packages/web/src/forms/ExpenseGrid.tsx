import type { Account, Name } from '@rapidbooks/shared';
import { useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type Ref } from 'react';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { accountQuickFill, nameQuickFill } from '../lists/quickAdd';
import { useDesktop } from '../shell/desktop';
import { commitActiveField } from '../util';

/** One row of the Expenses tab: Account, Amount, Memo, Customer:Job. */
export interface ExpRow {
  key: number;
  accountId: number | null;
  amount: number | null; // cents
  memo: string;
  customerId: number | null;
}

let seq = 0;
export const blankExp = (): ExpRow => ({ key: ++seq, accountId: null, amount: null, memo: '', customerId: null });
export const isBlankExp = (r: ExpRow) => r.accountId === null && r.amount === null && r.memo.trim() === '' && r.customerId === null;

/** A blank row always at the end, and at least `min` rows. */
export function padExp(rows: ExpRow[], min = 1): ExpRow[] {
  const out = rows.length === 0 || !isBlankExp(rows[rows.length - 1]) ? [...rows, blankExp()] : rows;
  return out.length >= min ? out : [...out, ...Array.from({ length: min - out.length }, blankExp)];
}

/** Rows without identity or blanks, for "has this changed?". */
export const expForCompare = (rows: ExpRow[]) => rows.filter((r) => !isBlankExp(r)).map(({ key: _k, ...rest }) => rest);

export const expTotal = (rows: ExpRow[]) => rows.reduce((t, r) => t + (r.amount ?? 0), 0);

type Col = 'account' | 'amount' | 'memo' | 'customer';

export interface ExpenseGridHandle {
  insertLine: () => void;
  deleteLine: () => void;
  focusCell: (row?: number, col?: Col) => void;
}

interface Props {
  rows: ExpRow[];
  setRows: (fn: (prev: ExpRow[]) => ExpRow[]) => void;
  accounts: Account[] | undefined;
  customers: Name[] | undefined;
  minRows?: number;
  disabled?: boolean;
  /**
   * The amount still unassigned when an account is picked on a row with no amount
   * (the check amount less the other lines); a positive value fills the row's amount.
   */
  unassigned?: (key: number) => number;
  ref?: Ref<ExpenseGridHandle>;
}

/**
 * The Expenses tab grid of checks and bills. Tab goes across then down, Up/Down move
 * between rows in the same column, Ctrl+Insert / Ctrl+Delete (through the handle)
 * insert and delete lines. Accounts not on the list offer Set Up; customers Quick Add.
 */
export function ExpenseGrid({ rows, setRows, accounts, customers, minRows = 5, disabled, unassigned, ref }: Props) {
  const desk = useDesktop();
  const rootRef = useRef<HTMLDivElement>(null);
  const curKey = useRef<number | null>(null);
  const focusReq = useRef<{ row: number; col: Col } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const accountOptions = useMemo(() => {
    const used = new Set(rows.map((r) => r.accountId));
    // A/R and A/P cannot take expense lines (the server says so); leave them off the list.
    return (accounts ?? [])
      .filter((a) => a.type !== 'AR' && a.type !== 'AP' && (!a.inactive || used.has(a.id)))
      .map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, rows]);
  const customerOptions = useMemo(() => {
    const used = new Set(rows.map((r) => r.customerId));
    return (customers ?? []).filter((n) => !n.inactive || used.has(n.id)).map((n) => ({ id: n.id, label: n.full_name }));
  }, [customers, rows]);

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

  const update = (fn: (prev: ExpRow[]) => ExpRow[]) => setRows((prev) => padExp(fn(prev), minRows));
  const edit = (key: number, patch: Partial<ExpRow>) => update((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const setAccount = (key: number, accountId: number | null) => {
    const row = rowsRef.current.find((r) => r.key === key);
    if (!row) return;
    const patch: Partial<ExpRow> = { accountId };
    // A new line: fill in what is left of the check amount.
    if (accountId !== null && row.accountId === null && row.amount === null && unassigned) {
      const left = unassigned(key);
      if (left > 0) patch.amount = left;
    }
    edit(key, patch);
  };

  const curIndex = () => {
    const i = rowsRef.current.findIndex((r) => r.key === curKey.current);
    return i < 0 ? 0 : i;
  };

  useImperativeHandle(ref, () => ({
    insertLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      update((prev) => [...prev.slice(0, i), blankExp(), ...prev.slice(i)]);
      focusReq.current = { row: i, col: 'account' };
    },
    deleteLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      const key = rowsRef.current[i]?.key;
      update((prev) => prev.filter((r) => r.key !== key));
      focusReq.current = { row: i, col: 'account' };
    },
    focusCell: (row = 0, col = 'account') => focusCell(row, col),
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

  return (
    <div className="grid-wrap bk-grid" ref={rootRef}>
      <table className="line-grid">
        <colgroup>
          <col style={{ width: '30%' }} />
          <col style={{ width: '9rem' }} />
          <col />
          <col style={{ width: '25%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Account</th>
            <th className="al-right">Amount</th>
            <th>Memo</th>
            <th>Customer:Job</th>
          </tr>
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {rows.map((r, i) => {
            const n = i + 1;
            return (
              <tr key={r.key} onFocus={() => (curKey.current = r.key)}>
                <td>
                  <Combo
                    options={accountOptions}
                    value={r.accountId}
                    onChange={(id) => setAccount(r.key, id)}
                    data-row={i}
                    data-col="account"
                    aria-label={`Account, line ${n}`}
                    disabled={disabled}
                    {...accountQuickFill(desk, { type: 'EXP' })}
                  />
                </td>
                <td>
                  <AmountField
                    value={r.amount}
                    onChange={(amount) => edit(r.key, { amount })}
                    data-row={i}
                    data-col="amount"
                    aria-label={`Amount, line ${n}`}
                    disabled={disabled}
                  />
                </td>
                <td>
                  <input
                    className="field"
                    value={r.memo}
                    data-row={i}
                    data-col="memo"
                    aria-label={`Memo, line ${n}`}
                    disabled={disabled}
                    onChange={(e) => edit(r.key, { memo: e.target.value })}
                  />
                </td>
                <td>
                  <Combo
                    options={customerOptions}
                    value={r.customerId}
                    onChange={(customerId) => edit(r.key, { customerId })}
                    data-row={i}
                    data-col="customer"
                    aria-label={`Customer:Job, line ${n}`}
                    disabled={disabled}
                    {...nameQuickFill(desk, 'customer')}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
