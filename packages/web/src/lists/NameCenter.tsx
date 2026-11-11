import {
  DATE_PRESETS,
  formatMoney,
  formatUsDate,
  resolvePreset,
  todayIso,
  type DatePresetId,
  type FindResult,
  type FindRow,
  type Name,
  type Terms,
} from '@rapidbooks/shared';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { MenuButton, type MenuButtonEntry } from '../controls/MenuButton';
import { openTxn } from '../forms/openTxn';
import { RibbonIcon } from '../forms/Ribbon';
import { openQuickReport, openReport } from '../reports/open';
import { useDesktop, useWindowCommands, type Desktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { Indented } from './ListWindow';
import './center.css';

type Kind = 'customer' | 'vendor';
type NameFilter = 'active' | 'all' | 'open';
type TxnFilter = 'all' | 'open' | 'overdue';

/** One entry of the Transactions tab's list: a kind of transaction and how its grid looks. */
interface TxnKind {
  label: string;
  types: string[];
  /** Open / Overdue filters and the Due Date, Aging and Open Balance columns (invoices, bills). */
  dueCols?: boolean;
  /** An Open Balance column and the Open filter (credits). */
  openCol?: boolean;
}

interface CenterDef {
  title: string;
  noun: string;
  plural: string;
  listTab: string;
  dialog: string;
  /** "Customer & Job Info", "Vendor Info": the edit button. */
  infoButton: string;
  newTxns: (d: Desktop, cur: Name | null) => MenuButtonEntry[];
  txnKinds: TxnKind[];
  /** The Show filter over the selected name's transactions. */
  shows: { label: string; types: string[] }[];
  reports: { label: string; run: (d: Desktop, n: Name) => void }[];
}

const DEFS: Record<Kind, CenterDef> = {
  customer: {
    title: 'Customer Center',
    noun: 'Customer',
    plural: 'Customers',
    listTab: 'Customers & Jobs',
    dialog: 'customer',
    infoButton: 'Customer & Job Info',
    newTxns: (d, c) => {
      const p = c ? { id: null, customerId: c.id } : { id: null };
      return [
        { label: '&Invoices', shortcut: 'Ctrl+I', action: () => d.open('invoice', p) },
        { label: '&Receive Payments', action: () => d.open('payment', p) },
        { label: '&Credit Memos/Refunds', action: () => d.open('creditmemo', p) },
        'sep',
        { label: '&Statements', action: () => d.open('statements') },
        { label: 'Assess &Finance Charges', action: () => d.open('financecharges') },
      ];
    },
    txnKinds: [
      { label: 'Invoices', types: ['INVOICE'], dueCols: true },
      { label: 'Received Payments', types: ['PAYMENT'], openCol: true },
      { label: 'Credit Memos', types: ['CREDITMEMO'], openCol: true },
    ],
    shows: [
      { label: 'All Transactions', types: [] },
      { label: 'Invoices', types: ['INVOICE'] },
      { label: 'Received Payments', types: ['PAYMENT'] },
      { label: 'Credit Memos', types: ['CREDITMEMO'] },
    ],
    reports: [
      { label: 'QuickReport', run: (d, n) => openQuickReport(d, { name_id: n.id }) },
      { label: 'Open Balance', run: (d, n) => openReport(d, 'customer_balance_detail', { name_ids: String(n.id) }) },
      { label: 'Show Sales by Item', run: (d, n) => openReport(d, 'sales_by_item_summary', { name_ids: String(n.id) }) },
    ],
  },
  vendor: {
    title: 'Vendor Center',
    noun: 'Vendor',
    plural: 'Vendors',
    listTab: 'Vendors',
    dialog: 'vendor',
    infoButton: 'Vendor Info',
    newTxns: (d, v) => {
      const p = v ? { id: null, vendorId: v.id } : { id: null };
      return [
        { label: '&Enter Bills', action: () => d.open('bill', p) },
        { label: '&Pay Bills', action: () => d.open('paybills') },
        { label: 'Purchase &Orders', action: () => d.open('purchaseorder', p) },
        { label: '&Write Checks', shortcut: 'Ctrl+W', action: () => d.open('check', { id: null }) },
      ];
    },
    txnKinds: [
      { label: 'Purchase Orders', types: ['PURCHORD'] },
      { label: 'Bills', types: ['BILL'], dueCols: true },
      { label: 'Bill Payments', types: ['BILLPMT'] },
      { label: 'Checks', types: ['CHECK'] },
      { label: 'Bill Credits', types: ['BILLCREDIT'], openCol: true },
    ],
    shows: [
      { label: 'All Transactions', types: [] },
      { label: 'Purchase Orders', types: ['PURCHORD'] },
      { label: 'Bills', types: ['BILL'] },
      { label: 'Bill Payments', types: ['BILLPMT'] },
      { label: 'Checks', types: ['CHECK'] },
      { label: 'Bill Credits', types: ['BILLCREDIT'] },
    ],
    reports: [
      { label: 'QuickReport', run: (d, n) => openQuickReport(d, { name_id: n.id }) },
      { label: 'Open Balance', run: (d, n) => openReport(d, 'vendor_balance_detail', { name_ids: String(n.id) }) },
      { label: 'Unpaid Bills', run: (d, n) => openReport(d, 'unpaid_bills', { name_ids: String(n.id) }) },
    ],
  },
};

/** The date choices over a center's transactions. */
const RANGE_IDS: DatePresetId[] = [
  'all',
  'today',
  'this_week',
  'this_month',
  'this_fiscal_quarter',
  'this_fiscal_year',
  'yesterday',
  'last_week',
  'last_month',
  'last_fiscal_quarter',
  'last_fiscal_year',
];
const RANGES = DATE_PRESETS.filter((p) => RANGE_IDS.includes(p.id));

function rangeQuery(id: DatePresetId): { qs: string; text: string } {
  const r = resolvePreset(id, todayIso());
  if (!r || (!r.from && !r.to)) return { qs: '', text: '' };
  return {
    qs: `${r.from ? `&from=${r.from}` : ''}${r.to ? `&to=${r.to}` : ''}`,
    text: `${r.from ? formatUsDate(r.from) : ''} - ${r.to ? formatUsDate(r.to) : ''}`,
  };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Days past due of an open invoice or bill, or null. */
function aging(r: FindRow, today: string): number | null {
  if (!r.due_date || !r.open_balance || r.open_balance <= 0) return null;
  const d = daysBetween(r.due_date, today);
  return d > 0 ? d : null;
}

type SortKey = 'name' | 'num' | 'date' | 'due' | 'aging' | 'amount' | 'open';

/** Grid header that sorts on click, with QuickBooks' ▲ / ▼. */
function sortTitle(label: string, key: SortKey, sort: { key: SortKey; desc: boolean }, set: (s: { key: SortKey; desc: boolean }) => void): ReactNode {
  return (
    <button type="button" className="lv-sort" tabIndex={-1} onClick={() => set({ key, desc: sort.key === key ? !sort.desc : false })}>
      {label}
      {sort.key === key && <span aria-hidden="true">{sort.desc ? ' ▼' : ' ▲'}</span>}
    </button>
  );
}

function compareRows(a: FindRow, b: FindRow, key: SortKey, today: string): number {
  const num = (x: string) => (/^\d+$/.test(x) ? x.padStart(12, '0') : x);
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.date.localeCompare(b.date) || a.id - b.id;
    case 'num':
      return num(a.num).localeCompare(num(b.num));
    case 'date':
      return a.date.localeCompare(b.date) || a.id - b.id;
    case 'due':
      return a.due_date.localeCompare(b.due_date);
    case 'aging':
      return (aging(a, today) ?? -1) - (aging(b, today) ?? -1);
    case 'amount':
      return a.amount - b.amount;
    case 'open':
      return (a.open_balance ?? 0) - (b.open_balance ?? 0);
  }
}

/**
 * Customers > Customer Center and Vendors > Vendor Center, as QuickBooks 2013 lays them out.
 * The first tab lists the names down the left (the ‹ › button widens the list over the whole
 * window), the chosen one's information and reports on the right, and their transactions below.
 * The Transactions tab lists every invoice, payment, bill... of one kind, for all of them.
 * Up/Down choose; Enter (or Ctrl+E) edits a name or opens a transaction; Ctrl+N adds a name;
 * Ctrl+Q is the chosen name's QuickReport.
 */
export function NameCenter({ winId, kind }: WinProps & { kind: Kind }) {
  const desk = useDesktop();
  const def = DEFS[kind];
  const today = todayIso();
  const { data: names, error: namesError } = useData<Name[]>(`/api/names?kind=${kind}`);
  const { data: terms } = useData<Terms[]>('/api/terms');
  const [tab, setTab] = useState<'names' | 'txns'>('names');

  // ---- Names tab
  const [filter, setFilter] = useState<NameFilter>('active');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [wide, setWide] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [show, setShow] = useState(0);
  const [range, setRange] = useState<DatePresetId>('this_fiscal_year');
  const [txnSel, setTxnSel] = useState<number | null>(null);

  const list = useMemo(() => {
    let rows = names ?? [];
    if (filter !== 'all') {
      // Inactive names and everything under them are hidden unless "All".
      const hidden = new Set<number>();
      rows = rows.filter((n) => {
        if (n.inactive || (n.parent_id !== null && hidden.has(n.parent_id))) {
          hidden.add(n.id);
          return false;
        }
        return true;
      });
    }
    if (filter === 'open') rows = rows.filter((n) => n.balance !== 0);
    const s = search.trim().toLowerCase();
    if (s) rows = rows.filter((n) => [n.full_name, n.company, n.contact, n.phone, n.email].some((v) => v.toLowerCase().includes(s)));
    return rows;
  }, [names, filter, search]);

  useEffect(() => {
    if (list.length && (selected === null || !list.some((n) => n.id === selected))) setSelected(list[0].id);
  }, [list, selected]);
  const current = list.find((n) => n.id === selected) ?? null;

  // ---- Transactions tab
  const [kindIx, setKindIx] = useState(0);
  const [txnFilter, setTxnFilter] = useState<TxnFilter>('all');
  const [allRange, setAllRange] = useState<DatePresetId>('this_fiscal_year');
  const [allSel, setAllSel] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const tk = def.txnKinds[kindIx];

  useEffect(() => {
    desk.setTitle(
      winId,
      tab === 'txns' ? `${def.title}: ${tk.label}` : current ? `${def.title}: ${current.full_name}` : def.title,
    );
  }, [tab, tk.label, current?.full_name]);

  const nameRange = rangeQuery(range);
  const showTypes = def.shows[show].types;
  const { data: nameFound, error: nameTxnError } = useData<FindResult>(
    tab === 'names' && current && !wide
      ? `/api/find?name_id=${current.id}&limit=500${showTypes.length ? `&types=${showTypes.join(',')}` : ''}${nameRange.qs}`
      : null,
  );

  const allRangeQ = rangeQuery(allRange);
  const { data: allFound, error: allError } = useData<FindResult>(
    tab === 'txns' ? `/api/find?types=${tk.types.join(',')}&limit=1000${allRangeQ.qs}` : null,
  );
  const ofKind = useMemo(() => new Set((names ?? []).map((n) => n.id)), [names]);
  const allRows = useMemo(() => {
    let rows = (allFound?.rows ?? []).filter((r) => r.name_id !== null && ofKind.has(r.name_id));
    if (txnFilter === 'open') rows = rows.filter((r) => (r.open_balance ?? 0) > 0);
    if (txnFilter === 'overdue') rows = rows.filter((r) => aging(r, today) !== null);
    const sorted = [...rows].sort((a, b) => compareRows(a, b, sort.key, today));
    return sort.desc ? sorted.reverse() : sorted;
  }, [allFound, ofKind, txnFilter, sort, today]);

  const newName = () => desk.open(def.dialog, { id: null });
  const edit = () => current && desk.open(def.dialog, { id: current.id });
  useWindowCommands(winId, {
    new: newName,
    edit: tab === 'names' ? edit : undefined,
    quickReport: current ? () => openQuickReport(desk, { name_id: current.id }) : undefined,
  });

  const termsName = (id: number | null) => (id === null ? '' : (terms ?? []).find((t) => t.id === id)?.name ?? '');

  // ---- Columns
  const nameCols: Column<Name>[] = [
    { key: 'name', title: 'Name', render: (n) => <Indented depth={n.depth}>{n.name}</Indented> },
    { key: 'balance', title: 'Balance Total', width: '8rem', align: 'right', render: (n) => formatMoney(n.balance) },
  ];
  if (wide) {
    nameCols.splice(1, 0, { key: 'company', title: 'Company', width: '18%', render: (n) => n.company });
    nameCols.splice(2, 0, { key: 'phone', title: 'Main Phone', width: '10rem', render: (n) => n.phone });
  }
  const nameTxnCols: Column<FindRow>[] = [
    { key: 'type', title: 'Type', width: '22%', render: (r) => r.type_label },
    { key: 'num', title: 'Num', width: '12%', render: (r) => r.num },
    { key: 'date', title: 'Date', width: '14%', render: (r) => formatUsDate(r.date) },
    { key: 'account', title: 'Account', render: (r) => r.account },
    { key: 'amount', title: 'Amount', width: '16%', align: 'right', render: (r) => formatMoney(r.amount) },
  ];
  const st = (label: string, key: SortKey) => sortTitle(label, key, sort, setSort);
  const allCols: Column<FindRow>[] = [
    { key: 'name', title: st(def.noun, 'name'), width: '22%', render: (r) => r.name },
    { key: 'num', title: st('Num', 'num'), width: '12%', render: (r) => r.num },
    { key: 'date', title: st('Date', 'date'), width: '12%', render: (r) => formatUsDate(r.date) },
    ...(tk.dueCols
      ? ([
          { key: 'due', title: st('Due Date', 'due'), width: '12%', render: (r) => (r.due_date ? formatUsDate(r.due_date) : '') },
          { key: 'aging', title: st('Aging', 'aging'), width: '9%', align: 'right', render: (r) => aging(r, today) ?? '' },
        ] as Column<FindRow>[])
      : tk.openCol || tk.dueCols
        ? []
        : ([{ key: 'account', title: 'Account', render: (r) => r.account }] as Column<FindRow>[])),
    { key: 'amount', title: st('Amount', 'amount'), width: '13%', align: 'right', render: (r) => formatMoney(r.amount) },
    ...(tk.dueCols || tk.openCol
      ? ([
          {
            key: 'open',
            title: st('Open Balance', 'open'),
            width: '13%',
            align: 'right',
            render: (r) => (r.open_balance === null ? '' : formatMoney(r.open_balance)),
          },
        ] as Column<FindRow>[])
      : []),
  ];

  const field = (label: string, value: ReactNode) =>
    value ? (
      <>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </>
    ) : null;

  const tabs = (
    <div className="cc-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'names'} className={tab === 'names' ? 'on' : undefined} onClick={() => setTab('names')}>
        {def.listTab}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'txns'} className={tab === 'txns' ? 'on' : undefined} onClick={() => setTab('txns')}>
        Transactions
      </button>
    </div>
  );

  return (
    <div className="center">
      <div className="center-tb" role="toolbar" onMouseDown={(e) => e.preventDefault()}>
        {kind === 'customer' && tab === 'names' ? (
          <MenuButton
            label="New Customer && Job"
            down
            items={[
              { label: '&New Customer', shortcut: 'Ctrl+N', action: newName },
              { label: 'Add &Job', action: current ? () => desk.open('customer', { id: null, parentId: current.parent_id ?? current.id }) : undefined },
            ]}
          />
        ) : (
          <button type="button" className="minitb-btn" tabIndex={-1} title="Ctrl+N" onClick={newName}>
            <RibbonIcon name="new" />
            <b>New {def.noun}...</b>
          </button>
        )}
        <MenuButton label="New Transactions" down items={def.newTxns(desk, tab === 'names' ? current : null)} />
        {tab === 'names' && (
          <button type="button" className="minitb-btn" tabIndex={-1} title="Ctrl+E" disabled={!current} onClick={edit}>
            <b>{def.infoButton}</b>
          </button>
        )}
      </div>

      {tab === 'names' ? (
        <div className="center-main">
          <div className={`center-left${wide ? ' wide' : ''}`}>
            {tabs}
            <div className="cc-listhead">
              <select className="field center-filter" value={filter} onChange={(e) => setFilter(e.target.value as NameFilter)} aria-label={`Show ${def.plural.toLowerCase()}`}>
                <option value="active">Active {def.plural}</option>
                <option value="all">All {def.plural}</option>
                <option value="open">{def.plural} with Open Balances</option>
              </select>
              <button
                type="button"
                className="cc-widen"
                tabIndex={-1}
                title={wide ? `Show the ${def.noun.toLowerCase()} information` : 'Widen the list'}
                onClick={() => setWide(!wide)}
              >
                {wide ? '‹' : '›'}
              </button>
            </div>
            <form
              className="cc-search"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(searchText);
              }}
            >
              <input
                className="field"
                value={searchText}
                aria-label={`Search ${def.plural.toLowerCase()}`}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  if (e.target.value === '') setSearch('');
                }}
              />
              <button type="submit" className="cc-search-btn" title="Search">
                ⌕
              </button>
            </form>
            {namesError && <div className="msg-strip error">{namesError}</div>}
            <ListView
              columns={nameCols}
              rows={list}
              rowKey={(n) => n.id}
              selected={selected}
              onSelect={setSelected}
              onActivate={(n) => desk.open(def.dialog, { id: n.id })}
              rowClass={(n) => (n.inactive ? 'inactive' : '')}
              emptyText={names ? (search ? 'Nothing matches the search.' : `There are no ${def.plural.toLowerCase()}.`) : 'Loading...'}
              label={def.plural}
            />
          </div>
          {!wide && (
            <div className="center-right">
              <div className="center-info">
                <div className="center-info-main">
                  <div className="center-info-head">
                    <h2>{def.noun} Information</h2>
                    <button type="button" className="center-edit" tabIndex={-1} title={`Edit ${def.noun} (Ctrl+E)`} disabled={!current} onClick={edit}>
                      ✎
                    </button>
                  </div>
                  {current && (
                    <dl className="center-fields cc-fields">
                      {field(kind === 'customer' && current.parent_id !== null ? 'Job Name' : `${def.noun} Name`, <b>{current.full_name}</b>)}
                      {field('Company Name', current.company)}
                      {field('Full Name', [current.salutation, current.first_name, current.middle_init, current.last_name].filter(Boolean).join(' '))}
                      {field(kind === 'customer' ? 'Bill To' : 'Billed From', current.bill_addr && <span className="pre">{current.bill_addr}</span>)}
                      {field(kind === 'customer' ? 'Ship To' : 'Shipped From', current.ship_addr && <span className="pre">{current.ship_addr}</span>)}
                      {field('Main Phone', current.phone)}
                      {field('Work Phone', current.alt_phone)}
                      {field('Mobile', current.mobile)}
                      {field('Fax', current.fax)}
                      {field('Main Email', current.email)}
                      {field('Terms', termsName(current.terms_id))}
                      {field('Account No.', current.account_no)}
                      {field('Notes', current.notes && <span className="pre">{current.notes}</span>)}
                    </dl>
                  )}
                </div>
                <div className="center-reports">
                  <h3>Reports for this {def.noun}</h3>
                  {def.reports.map((r) => (
                    <button key={r.label} type="button" className="linkbtn" disabled={!current} onClick={() => current && r.run(desk, current)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="center-txns">
                <div className="center-tabs">
                  <span className="on">Transactions</span>
                </div>
                <div className="center-txn-filters">
                  <label>
                    Show
                    <select className="field" value={show} onChange={(e) => setShow(Number(e.target.value))}>
                      {def.shows.map((s, i) => (
                        <option key={s.label} value={i}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Date
                    <select className="field" value={range} onChange={(e) => setRange(e.target.value as DatePresetId)}>
                      {RANGES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span>{nameRange.text}</span>
                </div>
                {nameTxnError && <div className="msg-strip error">{nameTxnError}</div>}
                <ListView
                  columns={nameTxnCols}
                  rows={nameFound?.rows ?? []}
                  rowKey={(r) => r.id}
                  selected={txnSel}
                  onSelect={setTxnSel}
                  onActivate={(r) => void openTxn(desk, r.type, r.id)}
                  emptyText={
                    !current
                      ? ''
                      : nameFound
                        ? `There are no transactions of type "${def.shows[show].label}" in date range "${RANGES.find((r) => r.id === range)?.label}".`
                        : 'Loading...'
                  }
                  label={`Transactions for ${current?.full_name ?? ''}`}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="center-main">
          <div className="center-left cc-kinds">
            {tabs}
            <div className="cc-kind-list" role="listbox" aria-label="Transaction types">
              {def.txnKinds.map((k, i) => (
                <button
                  key={k.label}
                  type="button"
                  role="option"
                  aria-selected={i === kindIx}
                  className={i === kindIx ? 'sel' : undefined}
                  onClick={() => {
                    setKindIx(i);
                    setTxnFilter('all');
                    setAllSel(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    e.preventDefault();
                    const n = Math.max(0, Math.min(def.txnKinds.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
                    setKindIx(n);
                    setTxnFilter('all');
                    setAllSel(null);
                    (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
                  }}
                >
                  <span className="cc-kind-icon" aria-hidden="true">
                    ▤
                  </span>
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <div className="center-right cc-all">
            <div className="cc-all-filters">
              <label>
                Filter By
                <select className="field" value={txnFilter} onChange={(e) => setTxnFilter(e.target.value as TxnFilter)}>
                  <option value="all">All {tk.label}</option>
                  {(tk.dueCols || tk.openCol) && <option value="open">Open {tk.label}</option>}
                  {tk.dueCols && <option value="overdue">Overdue {tk.label}</option>}
                </select>
              </label>
              <label>
                Date
                <select className="field" value={allRange} onChange={(e) => setAllRange(e.target.value as DatePresetId)}>
                  {RANGES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <span>{allRangeQ.text}</span>
            </div>
            {allError && <div className="msg-strip error">{allError}</div>}
            {allFound?.more && <div className="msg-strip">Only the latest 1,000 are shown: choose a shorter date range to see the rest.</div>}
            <ListView
              columns={allCols}
              rows={allRows}
              rowKey={(r) => r.id}
              selected={allSel}
              onSelect={setAllSel}
              onActivate={(r) => void openTxn(desk, r.type, r.id)}
              emptyText={allFound ? `There are no ${tk.label.toLowerCase()} in this date range.` : 'Loading...'}
              label={tk.label}
            />
            <div className="lv-footer">
              <MenuButton
                label="Manage Transactions"
                items={[
                  ...def.newTxns(desk, null),
                  'sep',
                  {
                    label: '&Open Transaction',
                    action: allSel !== null ? () => {
                      const r = allRows.find((x) => x.id === allSel);
                      if (r) void openTxn(desk, r.type, r.id);
                    } : undefined,
                  },
                ]}
              />
              <MenuButton
                label="Run Reports"
                items={
                  kind === 'customer'
                    ? [
                        { label: '&Open Invoices', action: () => openReport(desk, 'open_invoices') },
                        { label: 'A/R Aging &Summary', action: () => openReport(desk, 'ar_aging_summary') },
                        { label: 'A/R Aging &Detail', action: () => openReport(desk, 'ar_aging_detail') },
                        { label: 'Customer &Balance Summary', action: () => openReport(desk, 'customer_balance_summary') },
                      ]
                    : [
                        { label: '&Unpaid Bills Detail', action: () => openReport(desk, 'unpaid_bills') },
                        { label: 'A/P Aging &Summary', action: () => openReport(desk, 'ap_aging_summary') },
                        { label: 'A/P Aging &Detail', action: () => openReport(desk, 'ap_aging_detail') },
                        { label: 'Vendor &Balance Summary', action: () => openReport(desk, 'vendor_balance_summary') },
                      ]
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Registry components. */
export const CustomerCenter = (p: WinProps) => <NameCenter {...p} kind="customer" />;
export const VendorCenter = (p: WinProps) => <NameCenter {...p} kind="vendor" />;
