import { itemType, type Account, type Item } from '@rapidbooks/shared';
import { useCallback, useMemo } from 'react';
import { api, useData } from '../api';
import type { Column } from '../controls/ListView';
import { formatRate } from '../controls/RateField';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { Indented, ListWindow } from './ListWindow';
import { openQuickReport } from '../reports/open';

export function ItemList({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const accountNames = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.full_name])), [accounts]);

  // As her QuickBooks 2013 shows the Item List: Name, Description, Price.
  const columns: Column<Item>[] = [
    { key: 'name', title: 'Name', width: '30%', render: (i) => <Indented depth={0} bullet>{i.full_name}</Indented> },
    { key: 'desc', title: 'Description', render: (i) => i.description.split('\n', 1)[0] },
    {
      key: 'price',
      title: 'Price',
      width: '7rem',
      align: 'right',
      render: (i) => (itemType(i.type).hasRate ? formatRate({ rate: i.rate, percent: i.rate_is_percent }) : ''),
    },
  ];
  const matches = useCallback(
    (i: Item, text: string) => {
      const t = text.toLowerCase();
      const acct = i.account_id === null ? '' : accountNames.get(i.account_id) ?? '';
      return [i.full_name, i.description, i.type_label, acct, String(i.rate)].some((v) => v.toLowerCase().includes(t));
    },
    [accountNames],
  );

  return (
    <ListWindow<Item>
      winId={winId}
      path="/api/items"
      itemPath="/api/items"
      noun="item"
      title="Item"
      rowLabel={(i) => `Item "${i.full_name}"`}
      columns={columns}
      onNew={() => desk.open('item', { id: null })}
      onEdit={(i) => desk.open('item', { id: i.id })}
      onQuickReport={(i) => openQuickReport(desk, { item_id: i.id })}
      onDuplicate={(i) => desk.open('item', { id: null, copyOf: i.id })}
      setInactive={async (i, inactive) => {
        await api.put(`/api/items/${i.id}`, { ...i, inactive, members: i.members.map((m) => ({ item_id: m.item_id, qty: m.qty })) });
      }}
      matches={matches}
      activities={() => [{ label: 'Change Item &Prices', action: () => desk.open('itemprices') }]}
    />
  );
}
