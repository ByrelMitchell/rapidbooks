import { PAYROLL_ITEM_KINDS, type Account, type PayrollItem, type PayrollItemInput, type PayrollItemKind } from '@rapidbooks/shared';
import { useMemo } from 'react';
import { api, useData } from '../api';
import { Combo } from '../controls/Combo';
import type { Column } from '../controls/ListView';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { ListWindow } from './ListWindow';
import { accountQuickFill } from './quickAdd';
import { RecordDialogFrame, useRecordDialog } from './RecordDialog';
import '../forms/banking.css';

const kindInfo = (k: PayrollItemKind) => PAYROLL_ITEM_KINDS.find((x) => x.code === k)!;

/** Lists > Payroll Item List (also Employees menu). */
export function PayrollItemList({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const acctName = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.full_name])), [accounts]);
  const columns: Column<PayrollItem>[] = [
    { key: 'name', title: 'Item Name', render: (p) => p.name },
    { key: 'type', title: 'Type', width: '11rem', render: (p) => p.kind_label },
    {
      key: 'exp',
      title: 'Expense Account',
      width: '12rem',
      render: (p) => (p.expense_account_id !== null ? acctName.get(p.expense_account_id) ?? '' : ''),
    },
    {
      key: 'liab',
      title: 'Liability Account',
      width: '12rem',
      render: (p) => (p.liability_account_id !== null ? acctName.get(p.liability_account_id) ?? '' : ''),
    },
  ];
  return (
    <ListWindow<PayrollItem>
      winId={winId}
      path="/api/payroll-items"
      itemPath="/api/payroll-items"
      noun="payroll item"
      title="Payroll Item"
      rowLabel={(p) => `Payroll item "${p.name}"`}
      columns={columns}
      onNew={() => desk.open('payrollitem', { id: null })}
      onEdit={(p) => desk.open('payrollitem', { id: p.id })}
    />
  );
}

type Form = PayrollItemInput;

const blankForm = (name = '', kind: PayrollItemKind = 'earning'): Form => ({
  name,
  kind,
  expense_account_id: null,
  liability_account_id: null,
  inactive: false,
});

/** New / Edit Payroll Item. Props: { id: number | null, name?: string, kind?: PayrollItemKind }. */
export function PayrollItemDialog({ winId, props }: WinProps) {
  const id = (props.id as number | null | undefined) ?? null;
  const presetKind = (props.kind as PayrollItemKind | undefined) ?? 'earning';
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const dlg = useRecordDialog<Form>({
    winId,
    id,
    initial: () => blankForm((props.name as string | undefined) ?? '', presetKind),
    // Next keeps the type: she usually sets up several deductions in a row.
    blank: (prev) => blankForm('', prev.kind),
    load: async (rid) => {
      const p = await api.get<PayrollItem>(`/api/payroll-items/${rid}`);
      return {
        name: p.name,
        kind: p.kind,
        expense_account_id: p.expense_account_id,
        liability_account_id: p.liability_account_id,
        inactive: p.inactive,
      };
    },
    validate: (f) => {
      const k = kindInfo(f.kind);
      if (!f.name.trim()) return 'Enter a name for the payroll item.';
      if (k.needsExpense && f.expense_account_id === null) return `Choose the expense account for this ${k.label.toLowerCase()} item.`;
      if (k.needsLiability && f.liability_account_id === null) return `Choose the liability account for this ${k.label.toLowerCase()} item.`;
      return null;
    },
    save: async (f, rid) => {
      const k = kindInfo(f.kind);
      const body: PayrollItemInput = {
        name: f.name.trim(),
        kind: f.kind,
        expense_account_id: k.needsExpense ? f.expense_account_id : null,
        liability_account_id: k.needsLiability ? f.liability_account_id : null,
        inactive: f.inactive,
      };
      if (rid === null) return (await api.post<{ id: number }>('/api/payroll-items', body)).id;
      await api.put(`/api/payroll-items/${rid}`, body);
      return rid;
    },
    titles: { new: 'New Payroll Item', edit: 'Edit Payroll Item' },
    savedMessage: (f) => `Payroll item "${f.name.trim()}" saved.`,
    openNew: () => desk.open('payrollitem', { id: null }),
  });
  const { form, update, recId } = dlg;
  const k = kindInfo(form.kind);
  const fid = (s: string) => `${winId}-${s}`;
  const options = useMemo(() => {
    const keep = new Set([form.expense_account_id, form.liability_account_id]);
    return (accounts ?? [])
      .filter((a) => a.type !== 'AR' && a.type !== 'AP' && (!a.inactive || keep.has(a.id)))
      .map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, form.expense_account_id, form.liability_account_id]);

  return (
    <RecordDialogFrame
      dlg={dlg}
      winId={winId}
      inactive={
        <label className="check">
          <input type="checkbox" checked={form.inactive} onChange={(e) => update({ inactive: e.target.checked })} />
          Item is inactive
        </label>
      }
    >
      <div className="form-grid">
        <label htmlFor={fid('name')}>Item Name</label>
        <input id={fid('name')} className="field" value={form.name} maxLength={31} onChange={(e) => update({ name: e.target.value })} />
        <label htmlFor={fid('kind')}>Type</label>
        <select
          id={fid('kind')}
          className="field"
          value={form.kind}
          // Fixed once created: lines already on paychecks depend on it.
          disabled={recId !== null}
          title={recId !== null ? 'The type of a payroll item cannot be changed once it is created.' : undefined}
          onChange={(e) => update({ kind: e.target.value as PayrollItemKind })}
        >
          {PAYROLL_ITEM_KINDS.map((x) => (
            <option key={x.code} value={x.code}>
              {x.label}
            </option>
          ))}
        </select>
        {k.needsExpense && (
          <>
            <label htmlFor={fid('exp')}>Expense Account</label>
            <Combo
              id={fid('exp')}
              options={options}
              value={form.expense_account_id}
              onChange={(v) => update({ expense_account_id: v })}
              {...accountQuickFill(desk, { type: 'EXP' })}
            />
          </>
        )}
        {k.needsLiability && (
          <>
            <label htmlFor={fid('liab')}>Liability Account</label>
            <Combo
              id={fid('liab')}
              options={options}
              value={form.liability_account_id}
              onChange={(v) => update({ liability_account_id: v })}
              {...accountQuickFill(desk, { type: 'OCL' })}
            />
          </>
        )}
      </div>
      <p className="bk-hint">
        {form.kind === 'earning'
          ? 'Earnings (wages, salary, overtime) are paid to the employee and post to the expense account.'
          : form.kind === 'deduction'
            ? 'Deductions (withholdings) are taken out of the paycheck and owed to someone else: they post to the liability account.'
            : 'Company contributions (employer taxes and benefits) cost the company: they post to the expense account and are owed on the liability account.'}
      </p>
    </RecordDialogFrame>
  );
}
