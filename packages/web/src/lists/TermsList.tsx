import type { Terms } from '@rapidbooks/shared';
import type { Column } from '../controls/ListView';
import { formatPercent } from '../controls/RateField';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { ListWindow } from './ListWindow';

const columns: Column<Terms>[] = [
  { key: 'name', title: 'Name', render: (t) => t.name },
  { key: 'net', title: 'Net days', width: '6rem', align: 'right', render: (t) => String(t.net_days) },
  {
    key: 'discount',
    title: 'Discount',
    width: '11rem',
    render: (t) => (t.discount_pct > 0 ? `${formatPercent(t.discount_pct)} in ${t.discount_days} days` : ''),
  },
];

export function TermsList({ winId }: WinProps) {
  const desk = useDesktop();
  return (
    <ListWindow<Terms>
      winId={winId}
      path="/api/terms"
      itemPath="/api/terms"
      noun="terms"
      deleteQuestion="Are you sure you want to delete these terms?"
      title="Terms"
      rowLabel={(t) => `Terms "${t.name}"`}
      columns={columns}
      onNew={() => desk.open('term', { id: null })}
      onEdit={(t) => desk.open('term', { id: t.id })}
    />
  );
}
