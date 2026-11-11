import {
  formatMoney,
  formatUsDate,
  TXN_TYPE_LABELS,
  TXN_TYPE_SHORT,
  type Account,
  type DocTxn,
  type Name,
  type Split,
  type TxnLink,
} from '@rapidbooks/shared';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { openTxn } from './openTxn';

const heading = (t: DocTxn | undefined) =>
  t ? `${t.qb_type || TXN_TYPE_LABELS[t.type] || t.type}${t.num ? ` ${t.num}` : ''}, ${formatUsDate(t.date)}` : 'Loading...';

/**
 * Transaction History (Ctrl+H): what is linked to this transaction. For an invoice,
 * the payments and credits applied to it; for a payment or credit memo, the invoices
 * it was applied to. Enter or double-click opens the selected one. Props: { txnId }.
 */
export function TxnHistory({ winId, props }: WinProps) {
  const txnId = props.txnId as number;
  const desk = useDesktop();
  const { data: t, error } = useData<DocTxn>(`/api/txns/${txnId}`);
  // A QuickBooks type with no RapidBooks form (imported as posted) has no links at all.
  const rows = useMemo(
    () => (t ? (t.type === 'INVOICE' ? (t.links_in ?? []) : [...(t.links_out ?? []), ...(t.links_in ?? [])]) : []),
    [t],
  );
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  const current = rows.find((r) => r.id === selected) ?? null;
  const open = (r: TxnLink | null) => r && openTxn(desk, r.type, r.txn_id);
  useWindowCommands(winId, { edit: () => open(current) });

  const columns: Column<TxnLink>[] = [
    { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.date) },
    { key: 'type', title: 'Type', width: '6rem', render: (r) => TXN_TYPE_SHORT[r.type] ?? r.type },
    { key: 'num', title: 'Num', width: '6rem', render: (r) => r.num },
    {
      key: 'kind',
      title: 'Link',
      // 'po' links (bill <-> purchase order) come from purchase transactions.
      render: (r) =>
        r.kind === 'deposit' ? 'Deposit' : (r.kind as string) === 'po' ? 'Received' : r.discount ? 'Applied (with discount)' : 'Applied',
    },
    { key: 'amount', title: 'Amount', width: '8rem', align: 'right', render: (r) => formatMoney(r.amount + r.discount) },
  ];

  return (
    <div className="list-window">
      <div className="apply-head">{heading(t)}</div>
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={open}
        emptyText={t ? 'Nothing has been applied to or from this transaction.' : 'Loading...'}
        label="Transaction history"
      />
      <div className="button-row right">
        <button type="button" className="btn" disabled={!current} onClick={() => open(current)}>
          Go To
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Transaction Journal (Ctrl+Y): the transaction's splits. Props: { txnId }. */
export function TxnJournal({ winId, props }: WinProps) {
  const txnId = props.txnId as number;
  const desk = useDesktop();
  const { data: t, error } = useData<DocTxn>(`/api/txns/${txnId}`);
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: names } = useData<Name[]>('/api/names');
  const acct = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.full_name])), [accounts]);
  const name = useMemo(() => new Map((names ?? []).map((n) => [n.id, n.full_name])), [names]);
  const rows = t?.splits ?? [];
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  const columns: Column<Split>[] = [
    { key: 'account', title: 'Account', width: '30%', render: (s) => acct.get(s.account_id) ?? '' },
    { key: 'debit', title: 'Debit', width: '7rem', align: 'right', render: (s) => (s.amount > 0 ? formatMoney(s.amount) : '') },
    { key: 'credit', title: 'Credit', width: '7rem', align: 'right', render: (s) => (s.amount < 0 ? formatMoney(-s.amount) : '') },
    { key: 'name', title: 'Name', width: '20%', render: (s) => (s.name_id !== null ? name.get(s.name_id) ?? '' : '') },
    { key: 'memo', title: 'Memo', render: (s) => s.memo },
  ];
  const debits = rows.reduce((x, s) => x + Math.max(0, s.amount), 0);

  return (
    <div className="list-window">
      <div className="apply-head">{heading(t)}</div>
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        selected={selected}
        onSelect={setSelected}
        emptyText={t ? 'This transaction posts nothing.' : 'Loading...'}
        label="Transaction journal"
      />
      <div className="button-row">
        <span className="ending">
          Total <span className="ending-amount">{formatMoney(debits)}</span>
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
