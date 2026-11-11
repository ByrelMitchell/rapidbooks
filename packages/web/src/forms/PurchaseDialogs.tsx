import { formatMoney, formatUsDate, type Account, type OpenPurchaseOrder, type VendorCredit } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useData } from '../api';
import { AmountField, parseAmount } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { ListView, type Column } from '../controls/ListView';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';
import type { CreditUse } from './payBillsMath';
import './receivables.css';
import './purchases.css';

/**
 * Enter Bills > "Open purchase orders exist": tick the P.O.s received on this bill.
 * Space ticks the selected one, Enter or OK accepts. Props: { vendorId }. Result: number[].
 */
export function PoChooser({ winId, props }: WinProps) {
  const vendorId = props.vendorId as number;
  const desk = useDesktop();
  const { data, error } = useData<OpenPurchaseOrder[]>(`/api/purchase-orders/open?vendor_id=${vendorId}`);
  const rows = data ?? [];
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const ok = () => {
    // Enter with nothing ticked takes the one she is on.
    const ids = checked.size ? rows.filter((r) => checked.has(r.id)).map((r) => r.id) : selected !== null ? [selected] : [];
    desk.resolveWindow(winId, ids);
    desk.close(winId);
  };
  useWindowCommands(winId, { save: ok, saveClose: ok });

  const columns: Column<OpenPurchaseOrder>[] = [
    { key: 'chk', title: '✓', width: '2rem', align: 'center', render: (r) => (checked.has(r.id) ? '✓' : ''), onClick: (r) => toggle(r.id) },
    { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.date) },
    { key: 'num', title: 'PO No.', width: '6rem', render: (r) => r.num },
    { key: 'exp', title: 'Expected', width: '7rem', render: (r) => formatUsDate(r.expected_date) },
    { key: 'memo', title: 'Memo', render: (r) => r.memo },
    { key: 'total', title: 'Amount', width: '7.5rem', align: 'right', render: (r) => formatMoney(r.total) },
  ];

  return (
    <div
      className="list-window"
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === ' ' && (e.target as HTMLElement).classList.contains('listview')) {
          e.preventDefault();
          if (selected !== null) toggle(selected);
        }
      }}
    >
      <div className="hint">Select the purchase orders to receive against (Space ticks the one you are on), then OK.</div>
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={ok}
        emptyText={data ? 'This vendor has no open purchase orders.' : 'Loading...'}
        label="Open purchase orders"
      />
      <div className="button-row right">
        <button type="button" className="btn default" disabled={!data} onClick={ok}>
          OK
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Result of the Pay Bills discount dialog. */
export interface BillDiscountResult {
  discount: number;
  accountId: number | null;
}

let lastDiscountAccount: number | null = null;

/**
 * Pay Bills > Set Discount for the current bill. Props: { label, date, total, open, credits,
 * discount, accountId, suggested, discountPct, discountDate, payDate }. Result: BillDiscountResult.
 */
export function BillDiscount({ winId, props }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const open = props.open as number;
  const creditsOn = props.credits as number;
  const start = props.discount as number;
  const suggested = props.suggested as number;
  const pct = props.discountPct as number;
  const discDate = props.discountDate as string | null;
  const max = open - creditsOn;
  const [amount, setAmount, amountRef] = useLiveState<number | null>(start > 0 ? start : Math.min(suggested, max) || null);
  const [accountId, setAccountId, accountRef] = useLiveState<number | null>((props.accountId as number | null) ?? lastDiscountAccount);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (accountRef.current !== null || !accounts) return;
    const guess = accounts.find((a) => !a.inactive && /discount/i.test(a.name) && a.type !== 'AR' && a.type !== 'AP');
    if (guess) setAccountId(guess.id);
  }, [accounts]);

  const options = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => a.type !== 'AR' && a.type !== 'AP' && (!a.inactive || a.id === accountId))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, accountId],
  );

  const ok = async () => {
    const field = commitActiveField();
    if (!(await settleQuickFill())) return;
    const d = amountRef.current ?? 0;
    const fail = (m: string) => {
      setError(m);
      refocus(field);
    };
    if (d < 0) return fail('A discount cannot be negative.');
    if (d > max) return fail(`The discount cannot be more than the ${formatMoney(max)} still owed on this bill${creditsOn ? ' after its credits' : ''}.`);
    if (d > 0 && accountRef.current === null) return fail('Choose the account the discount is posted to.');
    if (d > 0) lastDiscountAccount = accountRef.current;
    const result: BillDiscountResult = { discount: d, accountId: d > 0 ? accountRef.current : null };
    desk.resolveWindow(winId, result);
    desk.close(winId);
  };
  useWindowCommands(winId, { save: () => void ok(), saveClose: () => void ok() });

  return (
    <form
      className="dialog"
      onSubmit={(e) => {
        e.preventDefault();
        void ok();
      }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey || t.tagName === 'BUTTON') return;
        e.preventDefault();
        void ok();
      }}
    >
      {error && <div className="msg-strip error">{error}</div>}
      <div className="info-grid">
        <span>Bill</span>
        <span>{props.label as string}</span>
        <span>Bill Date</span>
        <span>{formatUsDate(props.date as string)}</span>
        <span>Original Amt.</span>
        <span>{formatMoney(props.total as number)}</span>
        <span>Amount Due</span>
        <span>{formatMoney(open)}</span>
        {creditsOn > 0 && (
          <>
            <span>Credits Used</span>
            <span>{formatMoney(creditsOn)}</span>
          </>
        )}
        <span>Discount Date</span>
        <span>{discDate ? formatUsDate(discDate) : 'none'}</span>
        <span>Terms</span>
        <span>{pct > 0 ? `${pct / 100}% discount` : 'no discount'}</span>
        <span>Suggested Discount</span>
        <span>{formatMoney(suggested)}</span>
      </div>
      {discDate && suggested === 0 && pct > 0 && (
        <div className="hint">The payment date ({formatUsDate(props.payDate as string)}) is after the discount date, so the terms discount does not apply.</div>
      )}
      <div className="form-grid dlg-fields">
        <label htmlFor={`${winId}-amt`}>Amount of Discount</label>
        <AmountField id={`${winId}-amt`} className="short-amount" value={amount} onChange={setAmount} />
        <label htmlFor={`${winId}-acct`}>Discount Account</label>
        <Combo id={`${winId}-acct`} options={options} value={accountId} onChange={setAccountId} {...accountQuickFill(desk, { type: 'OINC' })} />
      </div>
      <div className="button-row right">
        <button type="submit" className="btn default">
          OK
        </button>
        <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Pay Bills > Set Credits for the current bill: how much of each of the vendor's credits
 * (bill credits and unapplied payments, same A/P account) to use on it.
 * Props: { label, vendorId, apAccountId, open, discount, current: CreditUse[], elsewhere: [creditId, amount][] }.
 * Result: CreditUse[].
 */
export function BillCredits({ winId, props }: WinProps) {
  const desk = useDesktop();
  const vendorId = props.vendorId as number;
  const apId = props.apAccountId as number;
  const open = props.open as number;
  const discount = props.discount as number;
  const elsewhere = useMemo(() => new Map(props.elsewhere as [number, number][]), [props.elsewhere]);
  const { data, error: loadError } = useData<VendorCredit[]>(`/api/vendors/${vendorId}/credits`);
  const rows = useMemo(() => (data ?? []).filter((c) => c.ap_account_id === apId), [data, apId]);
  const [uses, setUses, usesRef] = useLiveState<Map<number, number>>(
    () => new Map((props.current as CreditUse[]).map((c) => [c.creditId, c.amount])),
  );
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const room = open - discount;

  const available = (c: VendorCredit) => Math.max(0, c.unapplied - (elsewhere.get(c.id) ?? 0));
  const used = [...uses.values()].reduce((t, v) => t + v, 0);

  const setUse = (id: number, v: number | null) =>
    setUses((m) => {
      const n = new Map(m);
      if (!v) n.delete(id);
      else n.set(id, v);
      return n;
    });

  /** Space: use as much of this credit as the bill can take, or stop using it. */
  const toggle = (c: VendorCredit) => {
    const cur = usesRef.current.get(c.id) ?? 0;
    if (cur > 0) setUse(c.id, null);
    else {
      const others = [...usesRef.current.entries()].reduce((t, [k, v]) => (k === c.id ? t : t + v), 0);
      setUse(c.id, Math.max(0, Math.min(available(c), room - others)));
    }
  };

  const ok = () => {
    commitActiveField();
    const m = usesRef.current;
    for (const c of rows) {
      const v = m.get(c.id) ?? 0;
      if (v < 0) return setError('A credit amount cannot be negative.');
      if (v > available(c)) return setError(`Only ${formatMoney(available(c))} of credit ${c.num || formatUsDate(c.date)} is available.`);
    }
    const total = [...m.values()].reduce((t, v) => t + v, 0);
    if (total > room) return setError(`The credits come to ${formatMoney(total)}, more than the ${formatMoney(room)} owed on this bill.`);
    const result: CreditUse[] = rows.filter((c) => (m.get(c.id) ?? 0) > 0).map((c) => ({ creditId: c.id, amount: m.get(c.id)! }));
    desk.resolveWindow(winId, result);
    desk.close(winId);
  };
  useWindowCommands(winId, { save: ok, saveClose: ok });

  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLInputElement;
    const row = Number(t.dataset.row);
    if (Number.isNaN(row)) return;
    if (e.key === ' ' && !e.shiftKey) {
      e.preventDefault();
      const c = rows[row];
      const typed = t.value.trim() === '' ? null : parseAmount(t.value);
      if (c && typed !== null && typed !== (usesRef.current.get(c.id) ?? 0)) setUse(c.id, typed);
      else if (c) toggle(c);
      requestAnimationFrame(() => t.isConnected && t.select());
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      ok();
      return;
    }
    if (e.shiftKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)?.focus();
  };

  useEffect(() => {
    if (data) rootRef.current?.querySelector<HTMLElement>('[data-row="0"]')?.focus();
  }, [data]);

  return (
    <div className="dialog" ref={rootRef}>
      <div className="hist-head">
        {props.label as string}: amount due {formatMoney(open)}
        {discount ? `, discount ${formatMoney(discount)}` : ''}
      </div>
      <div className="hint">Type the amount of each credit to use (Space uses as much as fits), then OK.</div>
      {(error || loadError) && <div className="msg-strip error">{error ?? loadError}</div>}
      <div className="grid-wrap">
        <table className="line-grid">
          <colgroup>
            <col style={{ width: '7rem' }} />
            <col style={{ width: '6rem' }} />
            <col style={{ width: '6rem' }} />
            <col />
            <col style={{ width: '8rem' }} />
            <col style={{ width: '8rem' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Ref. No.</th>
              <th>Memo</th>
              <th className="al-right">Available</th>
              <th className="al-right">Amt. To Use</th>
            </tr>
          </thead>
          <tbody onKeyDown={onKey}>
            {rows.map((c, i) => (
              <tr key={c.id}>
                <td className="cell-text">{formatUsDate(c.date)}</td>
                <td className="cell-text">{c.type === 'BILLCREDIT' ? 'Credit' : 'Payment'}</td>
                <td className="cell-text">{c.num}</td>
                <td className="cell-text">{c.memo}</td>
                <td className="cell-text al-right">{formatMoney(available(c))}</td>
                <td>
                  <AmountField
                    value={uses.get(c.id) ?? null}
                    onChange={(v) => setUse(c.id, v)}
                    data-row={i}
                    aria-label={`Credit to use from ${c.num || formatUsDate(c.date)}`}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="cell-text grey">
                  {data ? 'This vendor has no credits available.' : 'Loading...'}
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="al-right total-label">
                Credits Used
              </td>
              <td className={`al-right total${used > room ? ' unbalanced' : ''}`}>{formatMoney(used)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="button-row right">
        <button type="button" className="btn default" onClick={ok}>
          OK
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
