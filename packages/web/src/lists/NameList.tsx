import type { Name } from '@rapidbooks/shared';
import type { Column } from '../controls/ListView';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { Indented, ListWindow } from './ListWindow';
import { NAME_WINDOWS } from './quickAdd';
import { openQuickReport } from '../reports/open';

const firstLine = (s: string) => s.split('\n', 1)[0];

/** SS No. showing only the last four digits. */
export function maskSsn(ssn: string): string {
  const digits = ssn.replace(/\D/g, '');
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : ssn ? '***' : '';
}

const nameCol: Column<Name> = {
  key: 'name',
  title: 'Name',
  render: (n) => <Indented depth={n.depth}>{n.name}</Indented>,
};

/** The lists that are still plain list windows (customers and vendors have their Centers). */
type ListKind = 'employee' | 'other';

const KINDS: Record<ListKind, { title: string; noun: string; newLabel: string; columns: Column<Name>[] }> = {
  employee: {
    title: 'Employee',
    noun: 'employee',
    newLabel: 'New Employee',
    columns: [nameCol, { key: 'ssn', title: 'SSN', width: '9rem', render: (n) => maskSsn(n.ssn) }],
  },
  other: {
    title: 'Other Names',
    noun: 'name',
    newLabel: 'New Name',
    columns: [nameCol, { key: 'notes', title: 'Notes', width: '10rem', render: (n) => firstLine(n.notes) }],
  },
};

/** Employee and Other Names lists: one component, driven by kind. */
export function NameList({ winId, kind }: WinProps & { kind: ListKind }) {
  const desk = useDesktop();
  const k = KINDS[kind];
  const dialog = NAME_WINDOWS[kind].dialog;
  return (
    <ListWindow<Name>
      winId={winId}
      path={`/api/names?kind=${kind}`}
      itemPath="/api/names"
      noun={k.noun}
      title={k.title}
      rowLabel={(n) => `"${n.full_name}"`}
      columns={k.columns}
      newLabel={k.newLabel}
      onNew={() => desk.open(dialog, { id: null })}
      onEdit={(n) => desk.open(dialog, { id: n.id })}
      onQuickReport={(n) => openQuickReport(desk, { name_id: n.id })}
      activities={
        kind === 'employee'
          ? (cur) => [{ label: '&Pay Employees', action: () => desk.open('paycheck', cur ? { id: null, employeeId: cur.id } : { id: null }) }]
          : () => [{ label: '&Write Checks', shortcut: 'Ctrl+W', action: () => desk.open('check', { id: null }) }]
      }
    />
  );
}

/** Registry components, one per kind (each window kind has its own title and size). */
export const EmployeeList = (p: WinProps) => <NameList {...p} kind="employee" />;
export const OtherNameList = (p: WinProps) => <NameList {...p} kind="other" />;
