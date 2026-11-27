import { formatMoney, formatUsDate, percentOf, TXN_TYPE_LABELS, type Account, type DocTxn, type TxnLink } from '@rapidbooks/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { ListView, type Column } from '../controls/ListView';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import { openTxn } from './openTxn';
import type { WinProps } from '../shell/registry';
import { defaultDiscountAccount, rememberDiscountAccount } from './discountAccount';
import { commitActiveField, refocus, useLiveState } from '../util';
import type { DiscountResult } from './ReceivePayments';
import './receivables.css';

/** Receive Payments > Discount Info: the discount on one invoice and the account it posts to. */
export function PaymentDiscount({ winId, props }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const total = props.total as number;
  const due = props.due as number;
  const pct = props.discountPct as number;
  const discDate = props.discountDate as string | null;
  const paymentDate = props.paymentDate as string;
  const inTerms = discDate !== null && pct > 0 && paymentDate <= discDate;
  const suggested = inTerms ? Math.min(due, percentOf(total, pct)) : 0;
  const start = props.discount as number;
  const [amount, setAmount, amountRef] = useLiveState<number | null>(start > 0 ? start : suggested || null);
  const [accountId, setAccountId, accountRef] = useLiveState<number | null>(
    (props.accountId as number | null) ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  // No account yet: the one last chosen here, else one named like a customer discount account.
  useEffect(() => {
    if (accountRef.current !== null || !accounts) return;
    const guess = defaultDiscountAccount(accounts, 'customer');
    if (guess !== null) setAccountId(guess);
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
    if (d < 0) {
      setError('A discount cannot be negative.');
      refocus(field);
      return;
    }
    if (d > due) {
      setError(`The discount cannot be more than the ${formatMoney(due)} due on this invoice.`);
      refocus(field);
      return;
    }
    if (d > 0 && accountRef.current === null) {
      setError('Choose the account the discount is posted to.');
      refocus(field);
      return;
    }
    if (d > 0 && accountRef.current !== null) rememberDiscountAccount('customer', accountRef.current);
    const result: DiscountResult = { discount: d, accountId: d > 0 ? accountRef.current : null };
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
        <span>Invoice</span>
        <span>
          {props.num as string} of {formatUsDate(props.date as string)}
        </span>
        <span>Original Amt.</span>
        <span>{formatMoney(total)}</span>
        <span>Amount Due</span>
        <span>{formatMoney(due)}</span>
        <span>Discount Used</span>
        <span>{formatMoney(start)}</span>
        <span>Discount Date</span>
        <span>{discDate ? formatUsDate(discDate) : 'none'}</span>
        <span>Terms</span>
        <span>{pct > 0 ? `${pct / 100}% discount` : 'no discount'}</span>
        <span>Suggested Discount</span>
        <span>{formatMoney(suggested)}</span>
      </div>
      {discDate && !inTerms && pct > 0 && (
        <div className="hint">The payment date is after the discount date, so the terms discount does not apply.</div>
      )}
      <div className="form-grid dlg-fields">
        <label htmlFor={`${winId}-amt`}>Amount of Discount</label>
        <AmountField id={`${winId}-amt`} className="short-amount" value={amount} onChange={setAmount} />
        <label htmlFor={`${winId}-acct`}>Discount Account</label>
        <Combo
          id={`${winId}-acct`}
          options={options}
          value={accountId}
          onChange={setAccountId}
          {...accountQuickFill(desk, { type: 'INC' })}
        />
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

interface HistRow {
  key: string;
  link: TxnLink;
}

/** Ctrl+H on a payment: the invoices it paid and the deposit it is in. Enter opens one. */
export function PaymentHistory({ winId, props }: WinProps) {
  const id = props.id as number;
  const desk = useDesktop();
  const [txn, setTxn] = useState<DocTxn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { dataVersion } = desk;

  useEffect(() => {
    api.get<DocTxn>(`/api/txns/${id}`).then(
      (t) => {
        setTxn(t);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [id, dataVersion]);

  const rows: HistRow[] = useMemo(
    () =>
      txn
        ? [...txn.links_out, ...txn.links_in].map((l) => ({ key: `${l.kind}${l.id}`, link: l }))
        : [],
    [txn],
  );
  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.key === selected))) setSelected(rows[0].key);
  }, [rows, selected]);

  const openRow = (r: HistRow) => {
    void openTxn(desk, r.link.type, r.link.txn_id);
  };
  const current = rows.find((r) => r.key === selected) ?? null;
  useWindowCommands(winId, { edit: () => current && openRow(current) });

  const columns: Column<HistRow>[] = [
    { key: 'type', title: 'Type', width: '7rem', render: (r) => TXN_TYPE_LABELS[r.link.type] ?? r.link.type },
    { key: 'num', title: 'Num', width: '6rem', render: (r) => r.link.num },
    { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.link.date) },
    {
      key: 'disc',
      title: 'Discount',
      width: '7rem',
      align: 'right',
      render: (r) => (r.link.discount ? formatMoney(r.link.discount) : ''),
    },
    { key: 'amt', title: 'Amount', align: 'right', render: (r) => formatMoney(r.link.amount) },
  ];

  return (
    <div className="list-window">
      {error && <div className="msg-strip error">{error}</div>}
      {txn && (
        <div className="hist-head">
          Payment of {formatMoney(txn.total)} received {formatUsDate(txn.date)}
          {txn.ref_no ? `, check ${txn.ref_no}` : ''}. Unused: {formatMoney(txn.unapplied ?? 0)}.
        </div>
      )}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        selected={selected}
        onSelect={setSelected}
        onActivate={openRow}
        emptyText={txn ? 'This payment has not been applied to any invoice.' : 'Loading...'}
        label="Payment history"
      />
      <div className="button-row right">
        <button type="button" className="btn" disabled={!current} onClick={() => current && openRow(current)}>
          Go To
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
