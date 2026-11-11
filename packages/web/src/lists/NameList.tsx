import { formatMoney, type Name, type NameKind } from '@rapidbooks/shared';
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
  other: { title: 'Other Names', noun: 'name', newLabel: 'New Name', columns: [nameCol, { ...notesCol, width: '10rem' }] },
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
      onQuickReport={(n) => openQuickReport(desk, { name_id: n.id })}
      moreEntries={kind === 'customer' ? (cur) => [{ label: 'Add &Job', action: cur ? () => desk.open(dialog, { id: null, parentId: cur.id }) : undefined }] : undefined}
      activities={
        kind === 'customer'
          ? (cur) => [
              { label: 'Create &Invoices', shortcut: 'Ctrl+I', action: () => desk.open('invoice', cur ? { id: null, customerId: cur.id } : { id: null }) },
              { label: '&Receive Payments', action: () => desk.open('payment', cur ? { id: null, customerId: cur.id } : { id: null }) },
              { label: 'Create &Credit Memos/Refunds', action: () => desk.open('creditmemo', cur ? { id: null, customerId: cur.id } : { id: null }) },
            ]
          : kind === 'vendor'
            ? (cur) => [
                { label: '&Enter Bills', action: () => desk.open('bill', cur ? { id: null, vendorId: cur.id } : { id: null }) },
                { label: 'Pay &Bills', action: () => desk.open('paybills') },
                { label: 'Create &Purchase Orders', action: () => desk.open('purchaseorder', cur ? { id: null, vendorId: cur.id } : { id: null }) },
              ]
            : kind === 'employee'
              ? (cur) => [{ label: '&Pay Employees', action: () => desk.open('paycheck', cur ? { id: null, employeeId: cur.id } : { id: null }) }]
              : (_cur) => [{ label: '&Write Checks', shortcut: 'Ctrl+W', action: () => desk.open('check', { id: null }) }]
      }
    />
  );
}

/** Registry components, one per kind (each window kind has its own title and size). */
export const CustomerList = (p: WinProps) => <NameList {...p} kind="customer" />;
export const VendorList = (p: WinProps) => <NameList {...p} kind="vendor" />;
export const EmployeeList = (p: WinProps) => <NameList {...p} kind="employee" />;
export const OtherNameList = (p: WinProps) => <NameList {...p} kind="other" />;
