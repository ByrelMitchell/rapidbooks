import type { Name, NameInput, NameKind, Terms } from '@rapidbooks/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { api, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { termsQuickFill, NAME_WINDOWS } from './quickAdd';
import { RecordDialogFrame, useRecordDialog } from './RecordDialog';

type TextKey = {
  [K in keyof NameInput]: NameInput[K] extends string ? K : never;
}[keyof NameInput];

export function blankName(kind: NameKind, name = '', parent_id: number | null = null): NameInput {
  return {
    kind,
    name,
    parent_id,
    company: '',
    salutation: '',
    first_name: '',
    middle_init: '',
    last_name: '',
    contact: '',
    alt_contact: '',
    phone: '',
    alt_phone: '',
    fax: '',
    email: '',
    bill_addr: '',
    ship_addr: '',
    notes: '',
    account_no: '',
    terms_id: null,
    credit_limit: null,
    picks_up: false,
    print_as: '',
    tax_id: '',
    is_1099: false,
    ssn: '',
    hire_date: '',
    release_date: '',
    inactive: false,
  };
}

/** The editable fields of a loaded name (drops id, full_name, depth, balance). */
function toInput(n: Name): NameInput {
  const { id: _id, full_name: _f, depth: _d, balance: _b, ...input } = n;
  return { ...blankName(n.kind), ...input };
}

const KIND_TEXT: Record<NameKind, { label: string; nameLabel: string; inactive: string }> = {
  customer: { label: 'Customer', nameLabel: 'Customer Name', inactive: 'Customer is inactive' },
  vendor: { label: 'Vendor', nameLabel: 'Vendor Name', inactive: 'Vendor is inactive' },
  employee: { label: 'Employee', nameLabel: 'Employee Name', inactive: 'Employee is inactive' },
  other: { label: 'Name', nameLabel: 'Name', inactive: 'Name is inactive' },
};

function Group({ legend, children, className }: { legend: string; children: ReactNode; className?: string }) {
  return (
    <fieldset className={`groupbox${className ? ` ${className}` : ''}`}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** New/Edit Customer, Job, Vendor, Employee or Other Name: one dialog, driven by kind. */
export function NameDialog({ winId, props, kind }: WinProps & { kind: NameKind }) {
  const id = (props.id as number | null | undefined) ?? null;
  const presetParent = kind === 'customer' ? ((props.parentId as number | null | undefined) ?? null) : null;
  const desk = useDesktop();
  const text = KIND_TEXT[kind];
  // A job is a customer with a parent; whether this dialog is for a job is settled when it opens.
  const [isJob, setIsJob] = useState(presetParent !== null);

  const dlg = useRecordDialog<NameInput>({
    winId,
    id,
    initial: () => blankName(kind, (props.name as string | undefined) ?? '', presetParent),
    blank: (prev) => blankName(kind, '', isJob ? prev.parent_id : null),
    load: async (rid) => {
      const n = await api.get<Name>(`/api/names/${rid}`);
      if (n.parent_id !== null) setIsJob(true);
      return toInput(n);
    },
    validate: (f) => {
      if (isJob && f.parent_id === null) return 'Choose the customer this job is for.';
      if (!f.name.trim() && !(kind === 'employee' && (f.first_name.trim() || f.last_name.trim())))
        return `Enter the ${text.nameLabel.toLowerCase()}.`;
      return null;
    },
    save: async (f, rid) => {
      const body: NameInput = { ...f, parent_id: isJob ? f.parent_id : null };
      // An employee's list name defaults to "First Last".
      if (kind === 'employee' && !body.name.trim()) {
        body.name = [f.first_name.trim(), f.last_name.trim()].filter(Boolean).join(' ');
      }
      if (rid === null) return (await api.post<{ id: number }>('/api/names', body)).id;
      await api.put(`/api/names/${rid}`, body);
      return rid;
    },
    titles: isJob ? { new: 'New Job', edit: 'Edit Job' } : { new: `New ${text.label}`, edit: `Edit ${text.label}` },
    savedMessage: (f) => `${isJob ? 'Job' : text.label} "${f.name.trim() || `${f.first_name} ${f.last_name}`.trim()}" saved.`,
    openNew: () => desk.open(NAME_WINDOWS[kind].dialog, { id: null }),
  });
  const { form, update } = dlg;

  const { data: terms } = useData<Terms[]>(kind === 'customer' || kind === 'vendor' ? '/api/terms' : null);
  const termOptions = useMemo(
    () => (terms ?? []).filter((t) => !t.inactive || t.id === form.terms_id).map((t) => ({ id: t.id, label: t.name })),
    [terms, form.terms_id],
  );
  const { data: customers } = useData<Name[]>(isJob ? '/api/names?kind=customer' : null);
  // Possible customers for a job: not this job nor anything under it.
  const parentOptions = useMemo(() => {
    const list = customers ?? [];
    const under = new Set<number>(id !== null ? [id] : []);
    for (const c of list) if (c.parent_id !== null && under.has(c.parent_id)) under.add(c.id); // list order: parents first
    return list
      .filter((c) => !under.has(c.id) && (!c.inactive || c.id === form.parent_id))
      .map((c) => ({ id: c.id, label: c.full_name }));
  }, [customers, id, form.parent_id]);

  const fid = (k: string) => `${winId}-${k}`;
  const txt = (k: TextKey, label: string, extra: { maxLength?: number; className?: string } = {}) => (
    <>
      <label htmlFor={fid(k)}>{label}</label>
      <input
        id={fid(k)}
        className={`field${extra.className ? ` ${extra.className}` : ''}`}
        value={form[k]}
        maxLength={extra.maxLength}
        onChange={(e) => update({ [k]: e.target.value } as Partial<NameInput>)}
      />
    </>
  );
  const area = (k: TextKey, label: string, rows = 4) => (
    <label className="stack" htmlFor={fid(k)}>
      {label}
      <textarea
        id={fid(k)}
        className="field"
        rows={rows}
        value={form[k]}
        onChange={(e) => update({ [k]: e.target.value } as Partial<NameInput>)}
      />
    </label>
  );
  const check = (k: 'picks_up' | 'is_1099' | 'inactive', label: string) => (
    <label className="check">
      <input type="checkbox" checked={form[k]} onChange={(e) => update({ [k]: e.target.checked } as Partial<NameInput>)} />
      {label}
    </label>
  );

  const personFields = (
    <div className="form-grid">
      {kind !== 'employee' && txt('company', 'Company Name')}
      {txt('salutation', 'Mr./Ms./...', { className: 'short-field', maxLength: 15 })}
      <label htmlFor={fid('first_name')}>First Name</label>
      <span className="inline-fields">
        <input
          id={fid('first_name')}
          className="field"
          value={form.first_name}
          onChange={(e) => update({ first_name: e.target.value })}
        />
        <label htmlFor={fid('middle_init')}>M.I.</label>
        <input
          id={fid('middle_init')}
          className="field mi-field"
          value={form.middle_init}
          maxLength={5}
          onChange={(e) => update({ middle_init: e.target.value })}
        />
      </span>
      {txt('last_name', 'Last Name')}
    </div>
  );
  const contactFields = (
    <div className="form-grid">
      {txt('contact', 'Contact')}
      {txt('phone', 'Phone')}
      {txt('fax', 'FAX')}
      {txt('alt_phone', 'Alt. Ph.')}
      {txt('alt_contact', 'Alt. Contact')}
      {txt('email', 'E-mail')}
    </div>
  );
  const termsCombo = (
    <>
      <label htmlFor={fid('terms')}>Terms</label>
      <Combo
        id={fid('terms')}
        options={termOptions}
        value={form.terms_id}
        onChange={(t) => update({ terms_id: t })}
        {...termsQuickFill(desk)}
      />
    </>
  );
  const creditLimit = (
    <>
      <label htmlFor={fid('credit')}>Credit Limit</label>
      <AmountField id={fid('credit')} value={form.credit_limit} onChange={(v) => update({ credit_limit: v })} />
    </>
  );

  return (
    <RecordDialogFrame dlg={dlg} winId={winId} inactive={check('inactive', isJob ? 'Job is inactive' : text.inactive)}>
      <div className="form-grid rec-top">
        {txt('name', isJob ? 'Job Name' : text.nameLabel)}
        {isJob && (
          <>
            <label htmlFor={fid('parent')}>Customer</label>
            <Combo
              id={fid('parent')}
              options={parentOptions}
              value={form.parent_id}
              onChange={(p) => update({ parent_id: p })}
              listName="Customer:Job"
            />
          </>
        )}
      </div>

      {kind === 'employee' ? (
        <>
          <Group legend="Personal" className="cols2">
            {personFields}
            <div className="form-grid">
              {txt('ssn', 'SS No.', { maxLength: 11 })}
              <label htmlFor={fid('hire')}>Hire Date</label>
              <DateField id={fid('hire')} allowEmpty value={form.hire_date} onChange={(v) => update({ hire_date: v })} />
              <label htmlFor={fid('release')}>Release Date</label>
              <DateField
                id={fid('release')}
                allowEmpty
                value={form.release_date}
                onChange={(v) => update({ release_date: v })}
              />
            </div>
          </Group>
          <Group legend="Address and Contact" className="cols2">
            {area('bill_addr', 'Address')}
            <div className="form-grid">{txt('phone', 'Phone')}</div>
          </Group>
        </>
      ) : (
        <>
          <Group legend="Name and Contact" className="cols2">
            {personFields}
            {contactFields}
          </Group>
          {kind === 'customer' ? (
            <Group legend="Addresses" className="addr-row">
              {area('bill_addr', 'Bill To')}
              <button
                type="button"
                className="btn copy-btn"
                onClick={() => update({ ship_addr: form.bill_addr })}
                title="Copy the Bill To address to Ship To"
              >
                &gt;&gt; Copy &gt;&gt;
              </button>
              {area('ship_addr', 'Ship To')}
            </Group>
          ) : (
            <Group legend="Address" className="cols2">
              {area('bill_addr', 'Address')}
              {kind === 'vendor' && (
                <div className="form-grid">
                  {txt('print_as', 'Print on Check as')}
                </div>
              )}
            </Group>
          )}
        </>
      )}

      {kind === 'customer' && (
        <Group legend="Additional Info">
          <div className="cols2">
            <div className="form-grid">
              {termsCombo}
              {txt('account_no', 'Account No.')}
            </div>
            <div className="form-grid">{creditLimit}</div>
          </div>
          <div className="picks-up">{check('picks_up', 'Customer picks up (leave out of trip reports)')}</div>
        </Group>
      )}
      {kind === 'vendor' && (
        <Group legend="Additional Info">
          <div className="cols2">
            <div className="form-grid">
              {txt('account_no', 'Account No.')}
              {termsCombo}
              {creditLimit}
            </div>
            <div className="form-grid">
              {txt('tax_id', 'Tax ID')}
              <span />
              {check('is_1099', 'Vendor eligible for 1099')}
            </div>
          </div>
        </Group>
      )}

      {area('notes', 'Notes', 3)}
    </RecordDialogFrame>
  );
}

/** Registry components, one per kind (each window kind has its own size). */
export const CustomerDialog = (p: WinProps) => <NameDialog {...p} kind="customer" />;
export const VendorDialog = (p: WinProps) => <NameDialog {...p} kind="vendor" />;
export const EmployeeDialog = (p: WinProps) => <NameDialog {...p} kind="employee" />;
export const OtherNameDialog = (p: WinProps) => <NameDialog {...p} kind="other" />;
