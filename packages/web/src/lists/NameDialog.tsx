import type { Name, NameInput, NameKind, Terms } from '@rapidbooks/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { api, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { Mnemonic, parseMnemonic } from '../util';
import { termsQuickFill, NAME_WINDOWS } from './quickAdd';
import { RecordDialogFrame, useRecordDialog } from './RecordDialog';
import './dialogs2013.css';

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
    job_title: '',
    mobile: '',
    cc_email: '',
    website: '',
    other_contact: '',
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

type Tab2013 = 'address' | 'payment' | 'tax' | 'account' | 'additional' | 'job';

/**
 * The tabs down the left of QuickBooks 2013's New Customer and New Vendor windows (Alt+underlined
 * letter). No tab takes S or N: Alt+S is OK (save and close) and Alt+N saves and starts a new one,
 * as in every other record dialog.
 */
const TABS_2013: Record<'customer' | 'vendor', { id: Tab2013; label: string }[]> = {
  customer: [
    { id: 'address', label: 'Address &Info' },
    { id: 'payment', label: '&Payment Settings' },
    { id: 'tax', label: 'Sales &Tax Settings' },
    { id: 'additional', label: '&Additional Info' },
    { id: 'job', label: '&Job Info' },
  ],
  vendor: [
    { id: 'address', label: 'Address &Info' },
    { id: 'payment', label: '&Payment Settings' },
    { id: 'tax', label: '&Tax Settings' },
    { id: 'account', label: 'A&ccount Settings' },
    { id: 'additional', label: '&Additional Info' },
  ],
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
  const [tab, setTab] = useState<Tab2013>('address');

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
  if (kind === 'customer' || kind === 'vendor') {
    const tabs = TABS_2013[kind];
    const tabId = tabs.some((t) => t.id === tab) ? tab : 'address';
    // QuickBooks 2013: small grey capitals to the left of each box.
    const cap = (k: TextKey, label: string, className = '') => (
      <>
        <label className="nd-cap" htmlFor={fid(k)}>
          {label}
        </label>
        <input
          id={fid(k)}
          className={`field${className ? ` ${className}` : ''}`}
          value={form[k]}
          onChange={(e) => update({ [k]: e.target.value } as Partial<NameInput>)}
        />
      </>
    );
    // The contact boxes, each behind its 2013 label ("Main Phone ▾"); the labels are fixed here.
    const contact = (k: TextKey, label: string) => (
      <>
        <label className="nd-type" htmlFor={fid(k)}>
          {label}
        </label>
        <input id={fid(k)} className="field" value={form[k]} onChange={(e) => update({ [k]: e.target.value } as Partial<NameInput>)} />
      </>
    );
    const addrBox = (k: 'bill_addr' | 'ship_addr', label: string) => (
      <div className="nd-addr">
        <label className="nd-cap" htmlFor={fid(k)}>
          {label}
        </label>
        <textarea id={fid(k)} className="field" rows={5} value={form[k]} onChange={(e) => update({ [k]: e.target.value })} />
      </div>
    );
    const placeholderNote = (msg: string) => <p className="nd-note">{msg}</p>;

    let page: ReactNode;
    switch (tabId) {
      case 'address':
        page = (
          <>
            <div className="nd-person">
              {cap('company', 'Company Name', 'nd-wide')}
              <span className="nd-cap">Full Name</span>
              <span className="nd-full">
                <input className="field nd-sal" placeholder="Mr./Ms./..." aria-label="Mr./Ms./..." maxLength={15} value={form.salutation} onChange={(e) => update({ salutation: e.target.value })} />
                <input className="field" placeholder="First" aria-label="First name" value={form.first_name} onChange={(e) => update({ first_name: e.target.value })} />
                <input className="field nd-mi" placeholder="M.I." aria-label="Middle initial" maxLength={5} value={form.middle_init} onChange={(e) => update({ middle_init: e.target.value })} />
                <input className="field" placeholder="Last" aria-label="Last name" value={form.last_name} onChange={(e) => update({ last_name: e.target.value })} />
              </span>
              {cap('job_title', 'Job Title', 'nd-wide')}
            </div>
            <div className="nd-contacts">
              {contact('phone', 'Main Phone')}
              {contact('email', 'Main Email')}
              {contact('alt_phone', 'Work Phone')}
              {contact('cc_email', 'CC Email')}
              {contact('mobile', 'Mobile')}
              {contact('website', 'Website')}
              {contact('fax', 'Fax')}
              {contact('other_contact', 'Other 1')}
            </div>
            <fieldset className="nd-addrs">
              <legend>Address Details</legend>
              {addrBox('bill_addr', kind === 'customer' ? 'Invoice/Bill To' : 'Billed From')}
              <button
                type="button"
                className="btn nd-copy"
                onClick={() => update({ ship_addr: form.bill_addr })}
                title={`Copy the ${kind === 'customer' ? 'Bill To' : 'Billed From'} address`}
              >
                Copy &gt;&gt;
              </button>
              {addrBox('ship_addr', kind === 'customer' ? 'Ship To' : 'Shipped From')}
            </fieldset>
          </>
        );
        break;
      case 'payment':
        page = (
          <div className="nd-grid">
            {cap('account_no', 'Account No.')}
            <label className="nd-cap" htmlFor={fid('credit')}>
              Credit Limit
            </label>
            <AmountField id={fid('credit')} value={form.credit_limit} onChange={(v) => update({ credit_limit: v })} />
            <label className="nd-cap" htmlFor={fid('terms')}>
              Payment Terms
            </label>
            <Combo id={fid('terms')} options={termOptions} value={form.terms_id} onChange={(t) => update({ terms_id: t })} {...termsQuickFill(desk)} />
            {kind === 'vendor' && cap('print_as', 'Print Name on Check As')}
          </div>
        );
        break;
      case 'tax':
        page =
          kind === 'vendor' ? (
            <div className="nd-grid">
              {cap('tax_id', 'Vendor Tax ID')}
              <span />
              {check('is_1099', 'Vendor eligible for 1099')}
            </div>
          ) : (
            placeholderNote('RapidBooks does not charge sales tax, so there is nothing to set here.')
          );
        break;
      case 'account':
        page = placeholderNote('RapidBooks does not pre-fill accounts for a vendor: choose the account on each bill or check.');
        break;
      case 'additional':
        page = (
          <>
            <div className="nd-grid">
              {cap('contact', 'Contact')}
              {cap('alt_contact', 'Alt. Contact')}
              {kind === 'customer' && (
                <>
                  <span />
                  {check('picks_up', 'Customer picks up (leave out of trip reports)')}
                </>
              )}
            </div>
            <label className="nd-cap nd-notes-cap" htmlFor={fid('notes')}>
              Notes
            </label>
            <textarea id={fid('notes')} className="field nd-notes" rows={5} value={form.notes} onChange={(e) => update({ notes: e.target.value })} />
          </>
        );
        break;
      case 'job':
        page = placeholderNote(
          isJob
            ? 'This job belongs to the customer chosen above. RapidBooks keeps no job status, dates or job type.'
            : 'To add a job for this customer, save the customer, then choose New Customer & Job > Add Job in the Customer Center.',
        );
        break;
    }

    return (
      <RecordDialogFrame
        dlg={dlg}
        winId={winId}
        bottom
        className="nd13"
        inactive={check('inactive', isJob ? 'Job is inactive' : text.inactive)}
        onKeyDown={(e) => {
          if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !/^Key[A-Z]$/.test(e.code)) return;
          const letter = e.code.slice(3).toLowerCase();
          const t = tabs.find((x) => parseMnemonic(x.label).key === letter);
          if (!t) return;
          e.preventDefault();
          setTab(t.id);
        }}
      >
        <div className="nd-top">
          <label className="nd-cap" htmlFor={fid('name')}>
            {isJob ? 'Job Name' : text.nameLabel}
          </label>
          <input id={fid('name')} className="field nd-name" value={form.name} onChange={(e) => update({ name: e.target.value })} />
          {isJob && (
            <>
              <label className="nd-cap" htmlFor={fid('parent')}>
                Customer
              </label>
              <Combo id={fid('parent')} className="nd-name" options={parentOptions} value={form.parent_id} onChange={(p) => update({ parent_id: p })} listName="Customer:Job" />
            </>
          )}
          <label className="nd-cap" htmlFor={fid('ob')}>
            Opening Balance
          </label>
          <span className="nd-ob" title={`RapidBooks has no opening balance here: enter what is owed as ${kind === 'customer' ? 'an invoice' : 'a bill'} dated the day it was owed.`}>
            <input id={fid('ob')} className="field nd-obamt" disabled />
            <span className="nd-cap">As Of</span>
            <input className="field nd-obdate" disabled aria-label="As of" />
          </span>
        </div>
        <div className="nd-panel">
          <div className="nd-tabs" role="tablist" aria-orientation="vertical">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tabId}
                className={t.id === tabId ? 'on' : undefined}
                tabIndex={t.id === tabId ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  const i = tabs.findIndex((x) => x.id === tabId);
                  const n = tabs[(i + (e.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length];
                  setTab(n.id);
                  const sib = e.currentTarget.parentElement?.children[tabs.indexOf(n)] as HTMLElement | undefined;
                  sib?.focus();
                }}
              >
                <Mnemonic label={t.label} />
              </button>
            ))}
          </div>
          <div className="nd-page" role="tabpanel">
            {page}
          </div>
        </div>
      </RecordDialogFrame>
    );
  }

  return (
    <RecordDialogFrame dlg={dlg} winId={winId} inactive={check('inactive', text.inactive)}>
      <div className="form-grid rec-top">{txt('name', text.nameLabel)}</div>

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
          <Group legend="Address" className="cols2">
            {area('bill_addr', 'Address')}
          </Group>
        </>
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
