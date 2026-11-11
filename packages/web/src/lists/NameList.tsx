import { formatMoney, type Name, type NameKind } from '@rapidbooks/shared';
import type { Column } from '../controls/ListView';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { Indented, ListWindow } from './ListWindow';
import { NAME_WINDOWS } from './quickAdd';

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
const balanceCol: Column<Name> = {
  key: 'balance',
  title: 'Balance Total',
  width: '9rem',
  align: 'right',
  render: (n) => formatMoney(n.balance),
};
const notesCol: Column<Name> = { key: 'notes', title: 'Notes', width: '40%', render: (n) => firstLine(n.notes) };

const KINDS: Record<NameKind, { title: string; noun: string; newLabel: string; columns: Column<Name>[] }> = {
  customer: { title: 'Customer:Job', noun: 'customer:job', newLabel: 'New Customer', columns: [nameCol, balanceCol, notesCol] },
  vendor: { title: 'Vendor', noun: 'vendor', newLabel: 'New Vendor', columns: [nameCol, balanceCol] },
  employee: {
    title: 'Employee',
    noun: 'employee',
    newLabel: 'New Employee',
    columns: [nameCol, { key: 'ssn', title: 'SSN', width: '9rem', render: (n) => maskSsn(n.ssn) }],
  },
  other: { title: 'Name', noun: 'name', newLabel: 'New Name', columns: [nameCol, notesCol] },
};

/** Customer:Job, Vendor, Employee and Other Names lists: one component, driven by kind. */
export function NameList({ winId, kind }: WinProps & { kind: NameKind }) {
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
      extraButtons={
        kind === 'customer'
          ? (cur) => (
              <button
                type="button"
                className="btn"
                disabled={!cur}
                onClick={() => cur && desk.open(dialog, { id: null, parentId: cur.id })}
              >
                Add Job
              </button>
            )
          : undefined
      }
    />
  );
}

/** Registry components, one per kind (each window kind has its own title and size). */
export const CustomerList = (p: WinProps) => <NameList {...p} kind="customer" />;
export const VendorList = (p: WinProps) => <NameList {...p} kind="vendor" />;
export const EmployeeList = (p: WinProps) => <NameList {...p} kind="employee" />;
export const OtherNameList = (p: WinProps) => <NameList {...p} kind="other" />;
