import { formatMoney, formatUsDate, TXN_TYPE_SHORT, type AvailableCredit, type DocTxn } from '@rapidbooks/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { AmountField } from '../controls/AmountField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';
import './sales.css';

interface Row {
  credit: AvailableCredit;
  on: boolean;
  amount: number | null;
}

/** Apply a customer's unapplied payments and credit memos to one invoice. Props: { invoiceId }. */
export function ApplyCredits({ winId, props }: WinProps) {
  const invoiceId = props.invoiceId as number;
  const desk = useDesktop();
  const [inv, setInv] = useState<DocTxn | null>(null);
  const [rows, setRows, rowsRef] = useLiveState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await api.get<DocTxn>(`/api/txns/${invoiceId}`);
        const credits = await api.get<AvailableCredit[]>(`/api/customers/${t.name_id}/credits`);
        if (cancelled) return;
        setInv(t);
        setRows(credits.map((c) => ({ credit: c, on: false, amount: null })));
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invoiceId]);

  const open = inv?.open_balance ?? 0;
  const appliedNow = (rows ?? []).reduce((t, r) => t + (r.on ? (r.amount ?? 0) : 0), 0);

  const toggle = (i: number, on: boolean) =>
    setRows((rs) => {
      if (!rs) return rs;
      const out = [...rs];
      const others = out.reduce((t, r, j) => t + (j !== i && r.on ? (r.amount ?? 0) : 0), 0);
      const r = out[i];
      out[i] = { ...r, on, amount: on ? Math.max(0, Math.min(r.credit.unapplied, open - others)) : null };
      return out;
    });

  const setAmount = (i: number, amount: number | null) =>
    setRows((rs) => (rs ? rs.map((r, j) => (j === i ? { ...r, amount, on: (amount ?? 0) > 0 } : r)) : rs));

  const done = async () => {
    if (busy.current || !rowsRef.current) return;
    const field = commitActiveField();
    const chosen = rowsRef.current.filter((r) => r.on && (r.amount ?? 0) > 0);
    if (chosen.length === 0) {
      desk.close(winId);
      return;
    }
    busy.current = true;
    try {
      await api.post('/api/credits/apply', {
        applications: chosen.map((r) => ({ from_txn: r.credit.id, to_txn: invoiceId, amount: r.amount })),
      });
      desk.setStatus(`${formatMoney(chosen.reduce((t, r) => t + (r.amount ?? 0), 0))} in credits applied to invoice ${inv?.num ?? ''}.`);
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      setError(errorMessage(e));
      refocus(field);
    } finally {
      busy.current = false;
    }
  };

  useWindowCommands(winId, { save: () => void done(), saveClose: () => void done() });

  return (
    <div className="dialog">
      {inv && (
        <div className="apply-head">
          Invoice {inv.num} dated {formatUsDate(inv.date)}: open balance <b>{formatMoney(open)}</b>
        </div>
      )}
      {error && <div className="msg-strip error">{error}</div>}
      <div className="grid-wrap">
        <table className="line-grid apply-grid">
          <colgroup>
            <col style={{ width: '2.5rem' }} />
            <col style={{ width: '7rem' }} />
            <col style={{ width: '6rem' }} />
            <col style={{ width: '5rem' }} />
            <col />
            <col style={{ width: '7rem' }} />
            <col style={{ width: '8rem' }} />
          </colgroup>
          <thead>
            <tr>
              <th>✓</th>
              <th>Date</th>
              <th>Type</th>
              <th>No.</th>
              <th>Memo</th>
              <th className="al-right">Available</th>
              <th className="al-right">Amount to Use</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r, i) => (
              <tr key={r.credit.id}>
                <td className="al-center">
                  <input
                    type="checkbox"
                    checked={r.on}
                    aria-label={`Use credit ${r.credit.num}`}
                    onChange={(e) => toggle(i, e.target.checked)}
                  />
                </td>
                <td className="cell-text">{formatUsDate(r.credit.date)}</td>
                <td className="cell-text">{TXN_TYPE_SHORT[r.credit.type] ?? r.credit.type}</td>
                <td className="cell-text">{r.credit.num}</td>
                <td className="cell-text">{r.credit.memo}</td>
                <td className="cell-text al-right">{formatMoney(r.credit.unapplied)}</td>
                <td>
                  <AmountField value={r.amount} onChange={(v) => setAmount(i, v)} aria-label={`Amount of credit ${r.credit.num} to use`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && rows.length === 0 && <div className="listview-empty">This customer has no credits available.</div>}
        {!rows && !error && <div className="listview-empty">Loading...</div>}
      </div>
      <div className="button-row">
        <span>
          Applying <b>{formatMoney(appliedNow)}</b>; balance after: <b>{formatMoney(open - appliedNow)}</b>
        </span>
        <span className="spacer" />
        <button type="button" className="btn default" onClick={() => void done()} title="Alt+S">
          Done
        </button>
        <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
