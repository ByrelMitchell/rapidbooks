import { accountType, formatMoney, type Account } from '@rapidbooks/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { openQuickReport } from '../reports/open';
import { inactiveMark, Indented, ListFooter, visibleRows } from './ListWindow';

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

/** Lists > Chart of Accounts (Ctrl+A), laid out as QuickBooks 2013 shows it. */
export function ChartOfAccounts({ winId }: WinProps) {
  const desk = useDesktop();
  const { data, error } = useData<Account[]>('/api/accounts');
  const [includeInactive, setIncludeInactive] = useState(false);
  const accounts = useMemo(() => visibleRows(data ?? [], includeInactive), [data, includeInactive]);
  const [selected, setSelected] = useState<number | null>(null);
  const totals = useMemo(() => rolledUp(data ?? []), [data]);

  // Keep a valid selection as the list reloads.
  useEffect(() => {
    if (accounts.length === 0) return;
    if (selected === null || !accounts.some((a) => a.id === selected)) setSelected(accounts[0].id);
  }, [accounts, selected]);

  const current = accounts.find((a) => a.id === selected) ?? null;

  const openRegister = (a: Account | null) => {
    if (!a) return;
    // Income and expense accounts have no register: Enter opens their QuickReport, as in QuickBooks.
    if (accountType(a.type).balanceSheet) desk.open('register', { accountId: a.id });
    else openQuickReport(desk, { account_id: a.id });
  };

  const cmds = {
    new: () => desk.open('account', { id: null }),
    edit: () => current && desk.open('account', { id: current.id }),
    delete: async () => {
      if (!current) return;
      if (!(await desk.confirm(`Delete the account "${current.full_name}"?`, { yes: '&Delete', no: '&Cancel' })))
        return;
      try {
        await api.del(`/api/accounts/${current.id}`);
        const i = accounts.indexOf(current);
        const next = accounts[i + 1] ?? accounts[i - 1];
        setSelected(next ? next.id : null);
        desk.setStatus(`Account "${current.full_name}" deleted.`);
        desk.refresh();
      } catch (e) {
        await desk.alert(errorMessage(e));
      }
    },
    register: () => openRegister(current),
  };
  const quickReport = current ? () => openQuickReport(desk, { account_id: current.id }) : undefined;
  useWindowCommands(winId, {
    new: cmds.new,
    edit: cmds.edit,
    delete: () => void cmds.delete(),
    register: cmds.register,
    quickReport,
  });

  const columns: Column<Account>[] = [
    ...(includeInactive ? [inactiveMark<Account>()] : []),
    {
      key: 'name',
      title: 'Name',
      render: (a) => (
        <Indented depth={a.depth} bullet>
          {a.name}
        </Indented>
      ),
    },
    { key: 'type', title: 'Type', width: '13rem', render: (a) => accountType(a.type).label },
    {
      key: 'balance',
      title: 'Balance Total',
      width: '10rem',
      align: 'right',
      render: (a) => {
        const t = accountType(a.type);
        if (!t.balanceSheet) return '';
        const b = totals.get(a.id) ?? 0;
        return formatMoney(t.debitNormal ? b : -b);
      },
    },
  ];

  const isBank = current?.type === 'BANK';
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
        rowClass={(a) => (a.inactive ? 'inactive' : '')}
        emptyText={data ? 'There are no accounts.' : 'Loading...'}
        label="Chart of Accounts"
      />
      <ListFooter
        includeInactive={includeInactive}
        onIncludeInactive={setIncludeInactive}
        menus={[
          {
            label: 'Account',
            items: [
              { label: '&New', shortcut: 'Ctrl+N', action: cmds.new },
              { label: '&Edit Account', shortcut: 'Ctrl+E', action: current ? cmds.edit : undefined },
              { label: '&Delete Account', shortcut: 'Ctrl+D', action: current ? () => void cmds.delete() : undefined },
            ],
          },
          {
            label: 'Activities',
            items: [
              { label: '&Use Register', shortcut: 'Ctrl+R', action: current && accountType(current.type).balanceSheet ? cmds.register : undefined },
              'sep',
              { label: '&Write Checks', shortcut: 'Ctrl+W', action: () => desk.open('check', isBank && current ? { id: null, accountId: current.id } : { id: null }) },
              { label: 'Make &Deposits', action: () => desk.open('deposit', { id: null }) },
              { label: '&Transfer Funds', action: () => desk.open('transfer', { id: null }) },
              { label: 'Make General &Journal Entries', action: () => desk.open('journal', { id: null }) },
            ],
          },
          {
            label: 'Reports',
            items: [{ label: `&QuickReport: ${current?.full_name ?? ''}`, shortcut: 'Ctrl+Q', action: quickReport }],
          },
        ]}
      />
    </div>
  );
}
