import { accountType, formatMoney, formatUsDate, TXN_TYPE_SHORT, type Account, type RegisterRow } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { openTxn as openTxnWindow } from '../forms/openTxn';
import { openQuickReport } from '../reports/open';

export function Register({ winId, props }: WinProps) {
  const accountId = props.accountId as number;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data, error } = useData<RegisterRow[]>(`/api/accounts/${accountId}/register`);
  const rows = data ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const placed = useRef(false);

  const account = accounts?.find((a) => a.id === accountId);
  const names = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.full_name])), [accounts]);
  const type = account ? accountType(account.type) : null;
  const debitNormal = type?.debitNormal ?? true;

  useEffect(() => {
    if (account) desk.setTitle(winId, account.full_name);
    // desk.setTitle is stable; only the name matters.
  }, [account?.full_name, winId]);

  // Start at the newest entry; afterwards keep the selection (or the nearest row) across reloads.
  useEffect(() => {
    if (!data) return;
    if (!placed.current || selected === null || !data.some((r) => r.split_id === selected)) {
      placed.current = true;
      setSelected(data.length ? data[data.length - 1].split_id : null);
    }
  }, [data, selected]);

  const current = rows.find((r) => r.split_id === selected) ?? null;

  const openTxn = (r: RegisterRow | null) => {
    if (r) openTxnWindow(desk, r.type, r.txn_id);
  };

  const toggleCleared = async (r: RegisterRow) => {
    try {
      await api.put(`/api/splits/${r.split_id}/cleared`, { cleared: !r.cleared });
      desk.refresh();
    } catch (e) {
      desk.setStatus(errorMessage(e));
    }
  };

  const deleteTxn = async () => {
    if (!current) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    try {
      await api.del(`/api/txns/${current.txn_id}`);
      desk.setStatus('Transaction deleted.');
      desk.refresh();
    } catch (e) {
      await desk.alert(errorMessage(e));
    }
  };

  // In a bank register a new entry is a check on that account (as in QuickBooks).
  const newEntry = () => (account?.type === 'BANK' ? desk.open('check', { id: null, accountId }) : desk.open('journal', { id: null }));

  useWindowCommands(winId, {
    new: newEntry,
    edit: () => openTxn(current),
    delete: () => void deleteTxn(),
    quickReport: () => openQuickReport(desk, { account_id: accountId }),
  });

  const isBank = account?.type === 'BANK';
  // Credits on the left, ✓, debits on the right (as in the QuickBooks registers).
  const [leftTitle, rightTitle] = isBank ? ['Payment', 'Deposit'] : debitNormal ? ['Decrease', 'Increase'] : ['Increase', 'Decrease'];
  const credit = (r: RegisterRow) => (r.amount < 0 ? formatMoney(-r.amount) : '');
  const debit = (r: RegisterRow) => (r.amount > 0 ? formatMoney(r.amount) : '');
  const natural = (cents: number) => (debitNormal ? cents : -cents);

  // Fixed widths for the dates, numbers and amounts; Name and Account share the rest with Memo
  // by percentage, and the table never gets narrower than .register-table's minimum, so Memo
  // keeps real room (the list scrolls sideways instead when the window is made small or zoomed).
  const columns: Column<RegisterRow>[] = [
    { key: 'date', title: 'Date', width: '6.5rem', render: (r) => formatUsDate(r.date) },
    { key: 'num', title: 'Number', width: '4.5rem', render: (r) => r.num },
    { key: 'type', title: 'Type', width: '5rem', render: (r) => TXN_TYPE_SHORT[r.type] ?? r.type },
    { key: 'name', title: 'Name', width: '13%', render: (r) => r.name ?? '' },
    {
      key: 'account',
      title: 'Account',
      width: '14%',
      render: (r) => (r.other_account_id === null ? '-split-' : names.get(r.other_account_id) ?? ''),
    },
    { key: 'memo', title: 'Memo', render: (r) => r.memo },
    { key: 'left', title: leftTitle, width: '6.5rem', align: 'right', render: credit },
    {
      key: 'cleared',
      title: '✓',
      width: '1.75rem',
      align: 'center',
      render: (r) => (r.cleared ? '✓' : ''),
      onClick: (r) => void toggleCleared(r),
    },
    { key: 'right', title: rightTitle, width: '6.5rem', align: 'right', render: debit },
    { key: 'balance', title: 'Balance', width: '7.5rem', align: 'right', render: (r) => formatMoney(natural(r.balance)) },
  ];

  const ending = rows.length ? rows[rows.length - 1].balance : 0;

  return (
    <div className="list-window">
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.split_id}
        selected={selected}
        onSelect={setSelected}
        onActivate={openTxn}
        emptyText={data ? 'There are no transactions in this account.' : 'Loading...'}
        label="Register"
        tableClass="register-table"
      />
      <div className="button-row">
        <button type="button" className="btn" onClick={newEntry} title="Ctrl+N">
          {isBank ? 'New Check' : 'New Entry'}
        </button>
        {isBank && (
          <>
            <button type="button" className="btn" onClick={() => desk.open('deposit', { id: null })}>
              Deposit
            </button>
            <button type="button" className="btn" onClick={() => desk.open('transfer', { id: null })}>
              Transfer
            </button>
          </>
        )}
        <button type="button" className="btn" disabled={!current} onClick={() => openTxn(current)}>
          Edit Transaction
        </button>
        <span className="spacer" />
        <span className="ending">
          Ending balance <span className="ending-amount">{formatMoney(natural(ending))}</span>
        </span>
      </div>
    </div>
  );
}
