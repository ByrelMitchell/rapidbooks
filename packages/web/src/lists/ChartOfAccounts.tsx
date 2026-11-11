import { accountType, formatMoney, type Account } from '@rapidbooks/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';

/** Balance including subaccounts, as the QuickBooks chart of accounts shows it. */
function rolledUp(accounts: Account[]): Map<number, number> {
  const total = new Map<number, number>(accounts.map((a) => [a.id, a.balance]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const a of accounts) {
    let p = a.parent_id;
    while (p !== null) {
      total.set(p, (total.get(p) ?? 0) + a.balance);
      p = byId.get(p)?.parent_id ?? null;
    }
  }
  return total;
}

export function ChartOfAccounts({ winId }: WinProps) {
  const desk = useDesktop();
  const { data, error } = useData<Account[]>('/api/accounts');
  const accounts = data ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const totals = useMemo(() => rolledUp(accounts), [accounts]);

  // Keep a valid selection as the list reloads.
  useEffect(() => {
    if (!data || data.length === 0) return;
    if (selected === null || !data.some((a) => a.id === selected)) setSelected(data[0].id);
  }, [data, selected]);

  const current = accounts.find((a) => a.id === selected) ?? null;

  const openRegister = (a: Account | null) => {
    if (!a) return;
    if (accountType(a.type).balanceSheet) desk.open('register', { accountId: a.id });
    else desk.setStatus('QuickReport is not available yet.');
  };

  const cmds = {
    new: () => desk.open('account', { id: null }),
    edit: () => current && desk.open('account', { id: current.id }),
    delete: async () => {
      if (!current) return;
      if (!window.confirm(`Delete the account "${current.full_name}"?`)) return;
      try {
        await api.del(`/api/accounts/${current.id}`);
        const i = accounts.indexOf(current);
        const next = accounts[i + 1] ?? accounts[i - 1];
        setSelected(next ? next.id : null);
        desk.setStatus(`Account "${current.full_name}" deleted.`);
        desk.refresh();
      } catch (e) {
        window.alert(errorMessage(e));
      }
    },
    register: () => openRegister(current),
  };
  useWindowCommands(winId, {
    new: cmds.new,
    edit: cmds.edit,
    delete: () => void cmds.delete(),
    register: cmds.register,
  });

  const columns: Column<Account>[] = [
    {
      key: 'name',
      title: 'Name',
      render: (a) => (
        <span style={{ paddingLeft: `${a.depth * 1.25}em` }} className={a.inactive ? 'inactive' : undefined}>
          {a.name}
        </span>
      ),
    },
    { key: 'type', title: 'Type', width: '13rem', render: (a) => accountType(a.type).label },
    {
      key: 'balance',
      title: 'Balance',
      width: '9rem',
      align: 'right',
      render: (a) => {
        const t = accountType(a.type);
        if (!t.balanceSheet) return '';
        const b = totals.get(a.id) ?? 0;
        return formatMoney(t.debitNormal ? b : -b);
      },
    },
  ];

  return (
    <div className="list-window">
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={accounts}
        rowKey={(a) => a.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={(a) => openRegister(a)}
        emptyText={data ? 'There are no accounts.' : 'Loading...'}
        label="Chart of Accounts"
      />
      <div className="button-row">
        <span className="group-label">Account:</span>
        <button type="button" className="btn" onClick={cmds.new}>
          New
        </button>
        <button type="button" className="btn" disabled={!current} onClick={cmds.edit}>
          Edit
        </button>
        <button type="button" className="btn" disabled={!current} onClick={() => void cmds.delete()}>
          Delete
        </button>
        <span className="spacer" />
        <button type="button" className="btn" disabled={!current} onClick={cmds.register}>
          Use Register
        </button>
      </div>
    </div>
  );
}
