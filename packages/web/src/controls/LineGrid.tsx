import {
  formatMoney,
  lineAmount,
  percentOf,
  type Account,
  type Item,
  type LineInput,
  type TxnLine,
} from '@rapidbooks/shared';
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { itemQuickFill, nameQuickFill } from '../lists/quickAdd';
import { useDesktop } from '../shell/desktop';
import { commitActiveField } from '../util';
import { AmountField, formatAmount, parseAmount } from './AmountField';
import { Combo, type ComboOption } from './Combo';
import { formatPercent, parseRate } from './RateField';

// ---------------------------------------------------------------------------
// The line model and the amount arithmetic (the same as the server's computeLines).

/** One row of a document line grid (invoice, credit memo, purchase order, bill). */
export interface GridLine {
  key: number;
  itemId: number | null;
  description: string;
  qty: number | null;
  /** Cents with up to 3 decimals ($0.0375 = 3.75), or basis points when `percent`. */
  rate: number | null;
  percent: boolean;
  /** An amount typed over qty × rate (QuickBooks keeps it), or null = computed. Account lines: their amount. */
  amount: number | null;
  /** Lines with an account and no item (finance charges): shown read-only and sent back unchanged. */
  accountId: number | null;
  /** Customer:Job of a purchase line (only with the grid's `customers` column). */
  nameId?: number | null;
  /** Bill lines: the purchase order line this receives (that P.O. and the line's seq). */
  poTxnId?: number | null;
  poSeq?: number | null;
}

let lineSeq = 0;
export const newLineKey = () => ++lineSeq;

export const blankGridLine = (): GridLine => ({
  key: newLineKey(),
  itemId: null,
  description: '',
  qty: null,
  rate: null,
  percent: false,
  amount: null,
  accountId: null,
});

export const isBlankLine = (l: GridLine) =>
  l.itemId === null && l.accountId === null && l.description.trim() === '' && l.qty === null && l.rate === null && l.amount === null;

/** Always keep a blank row at the end, and at least `minRows` rows. */
export function padLines(lines: GridLine[], minRows = 1): GridLine[] {
  const out = lines.length === 0 || !isBlankLine(lines[lines.length - 1]) ? [...lines, blankGridLine()] : lines;
  if (out.length >= minRows) return out;
  return [...out, ...Array.from({ length: minRows - out.length }, blankGridLine)];
}

export type ItemMap = Map<number, Item>;
export const itemMap = (items: Item[] | undefined): ItemMap => new Map((items ?? []).map((i) => [i.id, i]));

/** qty × rate for a plain item line (discounts are always negative), before any typed-over amount. */
function naturalAmount(l: GridLine, item: Item | undefined): number {
  const a = l.rate !== null ? lineAmount(l.qty, l.rate) : 0;
  return item?.type === 'DISCOUNT' ? -Math.abs(a) : a;
}

const isSubtotal = (l: GridLine, items: ItemMap) => l.itemId !== null && items.get(l.itemId)?.type === 'SUBTOTAL';
/** Subtotal and percentage lines: the server always works out their amount. */
export const isComputedLine = (l: GridLine, items: ItemMap) => l.itemId !== null && (isSubtotal(l, items) || l.percent);

/**
 * Each non-blank line's amount in cents, by line key, exactly as the server computes it:
 * item lines qty × rate (or the typed amount), subtotals the lines above back to the
 * previous subtotal, percentages of the line just above, discounts always negative,
 * description-only lines nothing. Blank rows are skipped (they are not saved).
 */
export function computeAmounts(lines: GridLine[], items: ItemMap): Map<number, number> {
  const out = new Map<number, number>();
  let sinceSubtotal = 0;
  let above = 0;
  for (const l of lines) {
    if (isBlankLine(l)) continue;
    const item = l.itemId !== null ? items.get(l.itemId) : undefined;
    let amount: number;
    if (l.itemId === null) {
      // Account lines post; a description-only line must come to 0 (the server says so otherwise).
      amount = l.amount ?? (l.rate !== null ? lineAmount(l.qty, l.rate) : 0);
    } else if (item?.type === 'SUBTOTAL') {
      amount = sinceSubtotal;
    } else if (l.percent) {
      const pct = l.rate ?? 0;
      amount = item?.type === 'DISCOUNT' ? -percentOf(above, Math.abs(pct)) : percentOf(above, pct);
    } else {
      amount = l.amount ?? naturalAmount(l, item);
      if (item?.type === 'DISCOUNT') amount = -Math.abs(amount);
    }
    if (item?.type === 'SUBTOTAL') sinceSubtotal = 0;
    else sinceSubtotal += amount;
    above = amount;
    out.set(l.key, amount);
  }
  return out;
}

/** The document total: every line that posts (everything but subtotals and description-only lines). */
export function linesTotal(lines: GridLine[], items: ItemMap): number {
  const amounts = computeAmounts(lines, items);
  let total = 0;
  for (const l of lines) {
    if (isBlankLine(l) || isSubtotal(l, items)) continue;
    if (l.itemId === null && l.accountId === null) continue;
    total += amounts.get(l.key) ?? 0;
  }
  return total;
}

function memberLines(group: Item, items: ItemMap, depth = 0): GridLine[] {
  const out: GridLine[] = [];
  for (const m of [...group.members].sort((a, b) => a.seq - b.seq)) {
    const it = items.get(m.item_id);
    if (!it) continue;
    if (it.type === 'GROUP') {
      if (depth < 5) out.push(...memberLines(it, items, depth + 1));
      continue;
    }
    const sub = it.type === 'SUBTOTAL';
    out.push({
      key: newLineKey(),
      itemId: it.id,
      description: it.description,
      qty: sub || it.rate_is_percent ? null : m.qty,
      rate: sub ? null : it.rate,
      percent: !sub && it.rate_is_percent,
      amount: null,
      accountId: null,
    });
  }
  return out;
}

/** Replace every Group item line by its member lines (other lines keep their keys). */
export function expandGroups(lines: GridLine[], items: ItemMap): GridLine[] {
  if (!lines.some((l) => l.itemId !== null && items.get(l.itemId)?.type === 'GROUP')) return lines;
  return lines.flatMap((l) => {
    const it = l.itemId !== null ? items.get(l.itemId) : undefined;
    return it?.type === 'GROUP' ? memberLines(it, items) : [l];
  });
}

/** The lines to send to the server: blank rows dropped, groups expanded, computed amounts left to the server. */
export function linesToInput(lines: GridLine[], items: ItemMap): LineInput[] {
  return expandGroups(lines, items)
    .filter((l) => !isBlankLine(l))
    .map((l): LineInput => {
      if (l.accountId !== null && l.itemId === null) {
        // Finance-charge lines go back exactly as they came.
        return { item_id: null, description: l.description, qty: l.qty, rate: l.rate, rate_is_percent: false, amount: l.amount, account_id: l.accountId };
      }
      if (l.itemId === null) {
        // Description only. Any qty/rate/amount typed without an item goes too, so the server can say what is wrong.
        return { item_id: null, description: l.description, qty: l.qty, rate: l.rate, rate_is_percent: false, amount: l.amount, account_id: null };
      }
      if (isSubtotal(l, items)) {
        return { item_id: l.itemId, description: l.description, qty: null, rate: null, rate_is_percent: false, amount: null, account_id: null };
      }
      if (l.percent) {
        return { item_id: l.itemId, description: l.description, qty: null, rate: l.rate ?? 0, rate_is_percent: true, amount: null, account_id: null };
      }
      return { item_id: l.itemId, description: l.description, qty: l.qty, rate: l.rate, rate_is_percent: false, amount: l.amount, account_id: null };
    });
}

/** Grid rows for stored lines. An amount that differs from qty × rate is kept as typed over. */
export function linesFromTxn(lines: TxnLine[], items: ItemMap): GridLine[] {
  return [...lines]
    .sort((a, b) => a.seq - b.seq)
    .map((s): GridLine => {
      const l: GridLine = {
        key: newLineKey(),
        itemId: s.item_id,
        description: s.description,
        qty: s.qty,
        rate: s.rate,
        percent: s.rate_is_percent,
        amount: null,
        accountId: s.item_id === null ? s.account_id : null,
      };
      if (l.accountId !== null) l.amount = s.amount;
      else if (l.itemId === null) l.amount = s.amount !== 0 ? s.amount : null;
      else if (!isComputedLine(l, items) && s.amount !== naturalAmount(l, items.get(l.itemId))) l.amount = s.amount;
      return l;
    });
}

/** Lines without their row identity, for "has this changed?" comparisons. */
export const linesForCompare = (lines: GridLine[]) =>
  lines.filter((l) => !isBlankLine(l)).map(({ key: _k, ...rest }) => rest);

// ---------------------------------------------------------------------------
// Cells

const formatQty = (q: number | null) => (q === null ? '' : q.toLocaleString('en-US', { maximumFractionDigits: 6 }));

/** Quantity: a number (arithmetic allowed), up to 6 decimals; blank = none. */
function parseQty(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const v = parseAmount(text, 6); // hundredths of the number, with 4 more places
  return v === null ? undefined : Math.round(v * 10000) / 1000000;
}

function formatLineRate(l: GridLine): string {
  if (l.rate === null) return '';
  return l.percent ? formatPercent(l.rate) : formatAmount(l.rate, 5);
}

/** Text cell that commits on blur through parse (undefined = not valid: put the old text back). */
function CommitCell<T>({
  value,
  format,
  parse,
  onCommit,
  className,
  ...rest
}: {
  value: T;
  format: (v: T) => string;
  parse: (t: string) => T | undefined;
  onCommit: (v: T) => void;
  className?: string;
  disabled?: boolean;
  readOnly?: boolean;
  tabIndex?: number;
  'data-row': number;
  'data-col': string;
  'aria-label': string;
}) {
  const shown = format(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <input
      {...rest}
      type="text"
      className={`field amount-field${className ? ` ${className}` : ''}`}
      value={text}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (text === shown) return;
        const v = parse(text);
        if (v === undefined) setText(shown);
        else {
          setText(format(v));
          onCommit(v);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// The grid

export type LineCol = 'item' | 'description' | 'qty' | 'rate' | 'amount' | 'customer';

export interface LineGridHandle {
  /** Ctrl+Insert: a blank line above the current one. */
  insertLine: () => void;
  /** Ctrl+Delete: remove the current line. */
  deleteLine: () => void;
  /** Put focus in a cell (default: the first row's Item). */
  focusCell: (row?: number, col?: LineCol) => void;
}

export interface LineGridProps {
  lines: GridLine[];
  /** Functional update of the lines (the grid keeps a blank last row itself). */
  setLines: (update: (prev: GridLine[]) => GridLine[]) => void;
  items: Item[] | undefined;
  /** For the labels of account lines (finance charges). */
  accounts?: Account[];
  /** Which items may be picked (inactive ones already on the form are always listed). */
  itemFilter?: (item: Item) => boolean;
  /** Rows shown even when the document is short. Default 6. */
  minRows?: number;
  disabled?: boolean;
  /** Column titles (purchase forms say "Cost" for Rate). */
  titles?: Partial<Record<LineCol, string>>;
  /**
   * Purchase forms: picking an item fills its purchase description (or its description
   * when it has none) and its cost; percentages are not accepted in the rate column.
   */
  purchase?: boolean;
  /** Customer:Job choices: shows a Customer:Job column (purchase forms) that sets each line's nameId. */
  customers?: ComboOption[];
  ref?: Ref<LineGridHandle>;
}

/**
 * The QuickBooks document line grid: Item, Description, Qty, Rate, Amount.
 * Picking an item fills description and rate; qty × rate fills the amount; typing an
 * amount overrides it. Subtotal and percentage lines show their amount read-only.
 * A Group item becomes its member lines. Tab goes across then down, Up/Down move
 * between rows, Ctrl+Insert / Ctrl+Delete (through the handle) insert and delete lines.
 */
export function LineGrid({ lines, setLines, items, accounts, itemFilter, minRows = 6, disabled, titles, purchase, customers, ref }: LineGridProps) {
  const desk = useDesktop();
  const map = useMemo(() => itemMap(items), [items]);
  const amounts = useMemo(() => computeAmounts(lines, map), [lines, map]);
  const rootRef = useRef<HTMLDivElement>(null);
  const curKey = useRef<number | null>(null);
  const focusReq = useRef<{ row: number; col: LineCol } | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const options = useMemo(() => {
    const used = new Set(lines.map((l) => l.itemId));
    return (items ?? [])
      .filter((i) => used.has(i.id) || (!i.inactive && (itemFilter ? itemFilter(i) : true)))
      .map((i) => ({ id: i.id, label: i.full_name }));
  }, [items, lines, itemFilter]);

  const accountName = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.full_name])), [accounts]);

  const focusCell = (row: number, col: LineCol) => {
    const root = rootRef.current;
    if (!root) return;
    let el = root.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
    if (!el || (el as HTMLInputElement).disabled) el = root.querySelector<HTMLElement>(`[data-row="${row}"][data-col="item"]`);
    if (el && !(el as HTMLInputElement).disabled) el.focus();
  };

  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    focusCell(req.row, req.col);
  });

  const update = (fn: (prev: GridLine[]) => GridLine[]) => setLines((prev) => padLines(fn(prev), minRows));
  const edit = (key: number, change: (l: GridLine) => GridLine) =>
    update((prev) => prev.map((l) => (l.key === key ? change({ ...l }) : l)));

  /** Replace a Group line by its members, keeping focus on the same row and column. */
  const expandRow = (key: number, groupId: number) => {
    const idx = linesRef.current.findIndex((l) => l.key === key && l.itemId === groupId);
    const group = map.get(groupId);
    if (idx < 0 || !group) return;
    const active = document.activeElement as HTMLElement | null;
    const inRow = active?.closest('tr')?.dataset.key === String(key);
    update((prev) => prev.flatMap((l) => (l.key === key && l.itemId === groupId ? memberLines(group, map) : [l])));
    if (inRow) focusReq.current = { row: idx, col: (active?.dataset.col as LineCol | undefined) ?? 'description' };
  };

  const setItem = (key: number, itemId: number | null) => {
    if (!linesRef.current.some((l) => l.key === key)) return; // a row already replaced (group expanded)
    const it = itemId !== null ? map.get(itemId) : undefined;
    edit(key, (l) => {
      l.itemId = itemId;
      l.amount = null;
      if (!it) {
        l.rate = null;
        l.percent = false;
        return l;
      }
      l.description = purchase ? it.purchase_description || it.description : it.description;
      if (it.type === 'SUBTOTAL' || it.type === 'GROUP') {
        l.qty = null;
        l.rate = null;
        l.percent = false;
      } else if (purchase) {
        l.rate = it.cost;
        l.percent = false;
      } else {
        l.rate = it.rate;
        l.percent = it.rate_is_percent;
        if (it.rate_is_percent) l.qty = null;
      }
      return l;
    });
    // Expanded once the keystroke that picked it is done, so the field that had it is not mid-event.
    if (it?.type === 'GROUP') setTimeout(() => expandRow(key, it.id), 0);
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
      update((prev) => [...prev.slice(0, i), blankGridLine(), ...prev.slice(i)]);
      focusReq.current = { row: i, col: 'item' };
    },
    deleteLine: () => {
      if (disabled) return;
      commitActiveField();
      const i = curIndex();
      const key = linesRef.current[i]?.key;
      update((prev) => prev.filter((l) => l.key !== key));
      focusReq.current = { row: i, col: 'item' };
    },
    focusCell: (row = 0, col = 'item') => focusCell(row, col),
  }));

  // Up/Down move to the same column of the row above/below (an open dropdown keeps them;
  // in a description with several lines they move inside the text until its first/last line).
  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    const col = t.dataset.col as LineCol | undefined;
    if (!col || Number.isNaN(row)) return;
    const down = e.key === 'ArrowDown';
    if (t instanceof HTMLTextAreaElement) {
      const v = t.value;
      if (down ? v.indexOf('\n', t.selectionEnd) >= 0 : t.selectionStart > 0 && v.lastIndexOf('\n', t.selectionStart - 1) >= 0) return;
    }
    const next = row + (down ? 1 : -1);
    if (next < 0 || next >= lines.length) return;
    e.preventDefault();
    focusCell(next, col);
  };

  const title = (c: LineCol, d: string) => titles?.[c] ?? d;

  return (
    <div className="grid-wrap doc-grid" ref={rootRef}>
      <table className="line-grid">
        <colgroup>
          <col style={{ width: customers ? '18%' : '22%' }} />
          <col />
          <col style={{ width: customers ? '8%' : '9%' }} />
          <col style={{ width: customers ? '11%' : '12%' }} />
          <col style={{ width: customers ? '12%' : '13%' }} />
          {customers && <col style={{ width: '18%' }} />}
        </colgroup>
        <thead>
          <tr>
            <th>{title('item', 'Item')}</th>
            <th>{title('description', 'Description')}</th>
            <th className="al-right">{title('qty', 'Qty')}</th>
            <th className="al-right">{title('rate', 'Rate')}</th>
            <th className="al-right">{title('amount', 'Amount')}</th>
            {customers && <th>{title('customer', 'Customer:Job')}</th>}
          </tr>
        </thead>
        <tbody onKeyDown={onKeyDown}>
          {lines.map((l, i) => {
            const n = i + 1;
            const blank = isBlankLine(l);
            const acctLine = l.accountId !== null && l.itemId === null;
            const item = l.itemId !== null ? map.get(l.itemId) : undefined;
            const sub = item?.type === 'SUBTOTAL';
            const computed = sub || (l.itemId !== null && l.percent);
            const amount = amounts.get(l.key);
            const cell = (col: LineCol) => ({ 'data-row': i, 'data-col': col });
            return (
              <tr key={l.key} data-key={l.key} onFocus={() => (curKey.current = l.key)}>
                <td>
                  {acctLine ? (
                    <input className="field" disabled value={accountName.get(l.accountId!) ?? ''} {...cell('item')} aria-label={`Account, line ${n}`} />
                  ) : (
                    <Combo
                      options={options}
                      value={l.itemId}
                      onChange={(id) => setItem(l.key, id)}
                      {...cell('item')}
                      aria-label={`Item, line ${n}`}
                      disabled={disabled}
                      {...itemQuickFill(desk)}
                    />
                  )}
                </td>
                <td>
                  <textarea
                    className="field desc-field"
                    rows={Math.max(1, l.description.split('\n').length)}
                    value={l.description}
                    {...cell('description')}
                    aria-label={`Description, line ${n}`}
                    disabled={disabled || acctLine}
                    onChange={(e) => {
                      const description = e.target.value;
                      edit(l.key, (x) => ({ ...x, description }));
                    }}
                  />
                </td>
                <td>
                  <CommitCell<number | null>
                    value={l.qty}
                    format={formatQty}
                    parse={parseQty}
                    onCommit={(qty) => edit(l.key, (x) => ({ ...x, qty, amount: null }))}
                    {...cell('qty')}
                    aria-label={`Quantity, line ${n}`}
                    disabled={disabled || acctLine || computed}
                  />
                </td>
                <td>
                  <CommitCell<GridLine>
                    value={l}
                    format={formatLineRate}
                    parse={(t) => {
                      if (t.trim() === '') return { ...l, rate: null, percent: false };
                      const r = parseRate(t);
                      if (r?.percent && purchase) return undefined; // a cost is never a percentage
                      return r ? { ...l, rate: r.rate, percent: r.percent } : undefined;
                    }}
                    onCommit={(v) =>
                      edit(l.key, (x) => ({ ...x, rate: v.rate, percent: v.percent, qty: v.percent ? null : x.qty, amount: null }))
                    }
                    {...cell('rate')}
                    aria-label={`Rate, line ${n}`}
                    disabled={disabled || acctLine || sub}
                  />
                </td>
                <td>
                  {computed || acctLine ? (
                    <input
                      className="field amount-field"
                      readOnly
                      tabIndex={-1}
                      value={amount === undefined ? '' : formatMoney(amount)}
                      {...cell('amount')}
                      aria-label={`Amount, line ${n}`}
                    />
                  ) : (
                    <AmountField
                      // A description-only line shows no amount unless one was typed.
                      value={blank || (l.itemId === null && l.amount === null && l.rate === null) ? null : (amount ?? null)}
                      onChange={(v) =>
                        edit(l.key, (x) => {
                          const natural = x.itemId !== null ? naturalAmount(x, map.get(x.itemId)) : null;
                          return { ...x, amount: v === null || v === natural ? null : v };
                        })
                      }
                      {...cell('amount')}
                      aria-label={`Amount, line ${n}`}
                      disabled={disabled}
                    />
                  )}
                </td>
                {customers && (
                  <td>
                    <Combo
                      options={customers}
                      value={l.nameId ?? null}
                      onChange={(nameId) => edit(l.key, (x) => ({ ...x, nameId }))}
                      {...cell('customer')}
                      aria-label={`Customer:Job, line ${n}`}
                      disabled={disabled || acctLine}
                      {...nameQuickFill(desk, 'customer')}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
