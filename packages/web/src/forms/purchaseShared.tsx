import {
  lineAmount,
  type Account,
  type ExpenseLine,
  type ExpenseLineInput,
  type Item,
  type ItemLine,
  type ItemLineInput,
  type Name,
} from '@rapidbooks/shared';
import { useImperativeHandle, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type Ref } from 'react';
import { api } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, type ComboOption } from '../controls/Combo';
import { blankGridLine, isBlankLine, newLineKey, padLines, type GridLine } from '../controls/LineGrid';
import { accountQuickFill, nameQuickFill } from '../lists/quickAdd';
import { useDesktop } from '../shell/desktop';
import { commitActiveField } from '../util';

// Purchase orders, bills and bill payments: line conversions, the Expenses grid, small helpers.
// Everything is integer cents (costs may carry 3 decimals of a cent, like sales rates).

/** Item types the server accepts on purchase forms. */
export const isPurchasable = (i: Item) => i.type === 'SERVICE' || i.type === 'PART' || i.type === 'OTHER_CHARGE';

/** Stored item lines (PO, bill) as grid rows. An amount that differs from qty × cost is kept as typed over. */
export function gridFromItemLines(lines: ItemLine[]): GridLine[] {
  return [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((s): GridLine => {
      const natural = s.item_id !== null && s.rate !== null ? lineAmount(s.qty, s.rate) : 0;
      return {
        key: newLineKey(),
        itemId: s.item_id,
        description: s.description,
        qty: s.item_id === null ? null : s.qty,
        rate: s.item_id === null ? null : s.rate,
        percent: false,
        amount: s.item_id !== null && s.amount !== natural ? s.amount : null,
        accountId: null,
        nameId: s.name_id,
      };
    });
}

/** Grid rows as ItemLineInput (blank rows dropped; the server computes qty × cost). */
export function itemLinesToInput(lines: GridLine[]): ItemLineInput[] {
  return lines
    .filter((l) => !isBlankLine(l))
    .map((l) => ({
      item_id: l.itemId,
      description: l.description,
      qty: l.qty,
      rate: l.rate,
      amount: l.amount,
      name_id: l.nameId ?? null,
    }));
}

/** Copies of stored lines for a new document (bill received against a P.O.): new row keys. */
export const copyItemLines = (lines: ItemLine[]): GridLine[] => gridFromItemLines(lines).map((l) => ({ ...l, key: newLineKey() }));

/** Append rows before the trailing blank rows. */
export function appendLines(prev: GridLine[], add: GridLine[], minRows: number): GridLine[] {
  const kept = prev.filter((l) => !isBlankLine(l));
  return padLines([...kept, ...add], minRows);
}

export const blankItemLines = (n: number) => padLines([blankGridLine()], n);

/** Vendor address for the Vendor / Address box: the vendor's address, else its company or name. */
export const vendorAddress = (v: Name | undefined) => (v ? v.bill_addr.trim() || v.company.trim() || v.name : '');

/** Combo options for active entries (plus the one in use). */
export function nameOptions(names: Name[] | undefined, keep: (number | null | undefined)[] = []): ComboOption[] {
  const k = new Set(keep);
  return (names ?? []).filter((n) => !n.inactive || k.has(n.id)).map((n) => ({ id: n.id, label: n.full_name }));
}

/** "Bill 4471" / "Credit 12" / "Bill Pmt -Check 1043". */
export function purchLabel(type: string, num: string): string {
  const what = type === 'BILLCREDIT' ? 'Credit' : type === 'BILLPMT' ? 'Bill payment' : type === 'PURCHORD' ? 'Purchase order' : 'Bill';
  return `${what}${num ? ` ${num}` : ''}`;
}

/** Company name and address for a purchase order's Ship To box. */
export async function companyShipTo(): Promise<string> {
  const c = await api.get<Record<string, string>>('/api/company');
  return [c.name ?? '', c.address ?? ''].filter((s) => s.trim()).join('\n');
}

// ---------------------------------------------------------------------------
// The Expenses tab: Account / Amount / Memo / Customer:Job

export interface ExpLine {
  key: number;
  accountId: number | null;
  amount: number | null;
  memo: string;
  nameId: number | null;
}

let expSeq = 0;
export const blankExpLine = (): ExpLine => ({ key: ++expSeq, accountId: null, amount: null, memo: '', nameId: null });
export const isBlankExp = (l: ExpLine) => l.accountId === null && l.amount === null && !l.memo.trim() && l.nameId === null;

export function padExp(lines: ExpLine[], minRows: number): ExpLine[] {
  const out = lines.length === 0 || !isBlankExp(lines[lines.length - 1]) ? [...lines, blankExpLine()] : lines;
  return out.length >= minRows ? out : [...out, ...Array.from({ length: minRows - out.length }, blankExpLine)];
}

export const expFromStored = (lines: ExpenseLine[]): ExpLine[] =>
  [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((l) => ({ key: ++expSeq, accountId: l.account_id, amount: l.amount, memo: l.memo, nameId: l.name_id }));

export const expToInput = (lines: ExpLine[]): ExpenseLineInput[] =>
  lines.filter((l) => !isBlankExp(l)).map((l) => ({ account_id: l.accountId, amount: l.amount ?? 0, memo: l.memo, name_id: l.nameId }));

export const expForCompare = (lines: ExpLine[]) => lines.filter((l) => !isBlankExp(l)).map(({ key: _k, ...rest }) => rest);

export const expTotal = (lines: ExpLine[]) => lines.reduce((t, l) => t + (l.amount ?? 0), 0);

type ExpCol = 'account' | 'amount' | 'memo' | 'customer';

export interface ExpenseGridHandle {
  insertLine: () => void;
  deleteLine: () => void;
  focusCell: (row?: number, col?: ExpCol) => void;
}

/**
 * The Expenses tab grid. Picking an account on a row with no amount fills in what is
 * still missing to reach the Amount Due (`remaining`, when positive), as QuickBooks does.
 * Tab goes across then down; Up/Down move between rows; Ctrl+Insert / Ctrl+Delete via the handle.
 */
export function ExpenseGrid({
  lines,
  setLines,
  accounts,
  customers,
  remaining,
  minRows = 6,
  disabled,
  ref,
}: {
  lines: ExpLine[];
  setLines: (fn: (prev: ExpLine[]) => ExpLine[]) => void;
  accounts: Account[] | undefined;
  customers: Name[] | undefined;
  /** What is still missing to reach Amount Due, given the lines as they are now. */
  remaining?: () => number;
  minRows?: number;
  disabled?: boolean;
  ref?: Ref<ExpenseGridHandle>;
}) {
  const desk = useDesktop();
  const rootRef = useRef<HTMLDivElement>(null);
  const curKey = useRef<number | null>(null);
  const focusReq = useRef<{ row: number; col: ExpCol } | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const accountOptions = useMemo(() => {
    const used = new Set(lines.map((l) => l.accountId));
    return (accounts ?? [])
      .filter((a) => used.has(a.id) || (!a.inactive && a.type !== 'AR' && a.type !== 'AP'))
      .map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, lines]);
  const customerOptions = useMemo(() => nameOptions(customers, lines.map((l) => l.nameId)), [customers, lines]);

  const focusCell = (row: number, col: ExpCol) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
    if (el && !(el as HTMLInputElement).disabled) el.focus();
  };
  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    focusCell(req.row, req.col);
  });

  const update = (fn: (prev: ExpLine[]) => ExpLine[]) => setLines((prev) => padExp(fn(prev), minRows));
  const edit = (key: number, patch: Partial<ExpLine>) => update((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const setAccount = (key: number, accountId: number | null) => {
    const row = linesRef.current.find((l) => l.key === key);
    if (!row) return;
    const patch: Partial<ExpLine> = { accountId };
    if (accountId !== null && row.amount === null && remaining) {
      const left = remaining();
      if (left > 0) patch.amount = left;
    }
    edit(key, patch);
  };

  const curIndex = () => {
    const i = linesRef.current.findIndex((l) => l.key === curKey.current);
    return i < 0 ? 0 : i;
  };
  useImperativeHandle(ref, () => ({
    insertLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      update((prev) => [...prev.slice(0, i), blankExpLine(), ...prev.slice(i)]);
      focusReq.current = { row: i, col: 'account' };
    },
    deleteLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      const key = linesRef.current[i]?.key;
      update((prev) => prev.filter((l) => l.key !== key));
      focusReq.current = { row: i, col: 'account' };
    },
    focusCell: (row = 0, col = 'account') => focusCell(row, col),
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    const col = t.dataset.col as ExpCol | undefined;
    if (!col || Number.isNaN(row)) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= lines.length) return;
    e.preventDefault();
    focusCell(next, col);
  };

  return (
    <div className="grid-wrap doc-grid purch-grid" ref={rootRef}>
      <table className="line-grid">
        <colgroup>
          <col style={{ width: '30%' }} />
          <col style={{ width: '14%' }} />
          <col />
          <col style={{ width: '24%' }} />
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
          {lines.map((l, i) => {
            const n = i + 1;
            const cell = (col: ExpCol) => ({ 'data-row': i, 'data-col': col });
            return (
              <tr key={l.key} onFocus={() => (curKey.current = l.key)}>
                <td>
                  <Combo
                    options={accountOptions}
                    value={l.accountId}
                    onChange={(id) => setAccount(l.key, id)}
                    {...cell('account')}
                    aria-label={`Account, expense line ${n}`}
                    disabled={disabled}
                    {...accountQuickFill(desk, { type: 'EXP' })}
                  />
                </td>
                <td>
                  <AmountField
                    value={l.amount}
                    onChange={(amount) => edit(l.key, { amount })}
                    {...cell('amount')}
                    aria-label={`Amount, expense line ${n}`}
                    disabled={disabled}
                  />
                </td>
                <td>
                  <input
                    className="field"
                    value={l.memo}
                    {...cell('memo')}
                    aria-label={`Memo, expense line ${n}`}
                    disabled={disabled}
                    onChange={(e) => edit(l.key, { memo: e.target.value })}
                  />
                </td>
                <td>
                  <Combo
                    options={customerOptions}
                    value={l.nameId}
                    onChange={(nameId) => edit(l.key, { nameId })}
                    {...cell('customer')}
                    aria-label={`Customer:Job, expense line ${n}`}
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
