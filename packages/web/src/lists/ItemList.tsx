import { itemType, type Account, type Item } from '@rapidbooks/shared';
import { useMemo } from 'react';
import { useData } from '../api';
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

  const columns: Column<Item>[] = [
    { key: 'name', title: 'Name', render: (i) => <Indented depth={i.depth}>{i.name}</Indented> },
    { key: 'desc', title: 'Description', render: (i) => i.description.split('\n', 1)[0] },
    { key: 'type', title: 'Type', width: '10rem', render: (i) => i.type_label },
    {
      key: 'account',
      title: 'Account',
      width: '12rem',
      render: (i) => (i.account_id === null ? '' : accountNames.get(i.account_id) ?? ''),
    },
    {
      key: 'price',
      title: 'Price',
      width: '7rem',
      align: 'right',
      render: (i) => (itemType(i.type).hasRate ? formatRate({ rate: i.rate, percent: i.rate_is_percent }) : ''),
    },
  ];

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
    />
  );
}
