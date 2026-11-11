import { formatMoney, formatUsDate, todayIso, type FindResult, type FindRow, type Name } from '@rapidbooks/shared';
import { useEffect, useMemo, useState } from 'react';
import { useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { MenuButton } from '../controls/MenuButton';
import { openTxn } from '../forms/openTxn';
import { RibbonIcon } from '../forms/Ribbon';
import { openQuickReport, openReport } from '../reports/open';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import './center.css';

type Show = 'all' | 'PAYCHECK' | 'CHECK';
type Range = 'this_year' | 'last_year' | 'all';

const RANGES: Record<Range, { label: string; dates: () => { from: string; to: string } | null }> = {
  this_year: {
    label: 'This Calendar Year',
    dates: () => {
      const y = todayIso().slice(0, 4);
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    },
  },
  last_year: {
    label: 'Last Calendar Year',
    dates: () => {
      const y = Number(todayIso().slice(0, 4)) - 1;
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    },
  },
  all: { label: 'All', dates: () => null },
};

const SHOWS: Record<Show, string> = { all: 'All Transactions', PAYCHECK: 'Paychecks', CHECK: 'Checks' };

/**
 * Employees > Employee Center, as QuickBooks 2013 lays it out: the employees down the left,
 * the chosen one's information and reports on the right, and their transactions below.
 * Up/Down choose an employee; Enter (or Ctrl+E) edits; Ctrl+N adds one; Ctrl+Q is the QuickReport.
 */
export function EmployeeCenter({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: employees } = useData<Name[]>('/api/names?kind=employee');
  const [activeOnly, setActiveOnly] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [range, setRange] = useState<Range>('this_year');
  const [txnSel, setTxnSel] = useState<number | null>(null);

  const list = useMemo(() => (employees ?? []).filter((e) => !activeOnly || !e.inactive), [employees, activeOnly]);
  useEffect(() => {
    if (list.length && (selected === null || !list.some((e) => e.id === selected))) setSelected(list[0].id);
  }, [list, selected]);
  const current = list.find((e) => e.id === selected) ?? null;

  useEffect(() => {
    desk.setTitle(winId, current ? `Employee Center: ${current.full_name}` : 'Employee Center');
  }, [current?.full_name]);

  const dates = RANGES[range].dates();
  const query = current
    ? `/api/find?name_id=${current.id}&limit=500${show === 'all' ? '' : `&types=${show}`}${dates ? `&from=${dates.from}&to=${dates.to}` : ''}`
    : null;
  const { data: found, error } = useData<FindResult>(query);
  const txns = found?.rows ?? [];

  const edit = () => current && desk.open('employee', { id: current.id });
  useWindowCommands(winId, {
    new: () => desk.open('employee', { id: null }),
    edit,
    quickReport: current ? () => openQuickReport(desk, { name_id: current.id }) : undefined,
  });

  const nameCols: Column<Name>[] = [{ key: 'name', title: 'Name', render: (e) => e.full_name }];
  const txnCols: Column<FindRow>[] = [
    { key: 'type', title: 'Transaction Type', width: '30%', render: (r) => r.type_label },
    { key: 'date', title: 'Date', width: '20%', render: (r) => formatUsDate(r.date) },
    { key: 'account', title: 'Account', render: (r) => r.account },
    { key: 'amount', title: 'Amount', width: '20%', align: 'right', render: (r) => formatMoney(r.amount) },
  ];
  const nameIds = current ? String(current.id) : '';

  return (
    <div className="center">
      <div className="center-tb" role="toolbar" onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className="minitb-btn" tabIndex={-1} title="Ctrl+N" onClick={() => desk.open('employee', { id: null })}>
          <RibbonIcon name="new" />
          <b>New Employee...</b>
        </button>
        <MenuButton
          label="Manage Employee Information"
          down
          items={[
            { label: '&Edit Employee', shortcut: 'Ctrl+E', action: current ? edit : undefined },
            { label: '&Pay Employees', action: () => desk.open('paycheck', current ? { id: null, employeeId: current.id } : { id: null }) },
            { label: 'Payroll &Item List', action: () => desk.open('payrollitems') },
          ]}
        />
      </div>
      <div className="center-main">
        <div className="center-left">
          <div className="center-tabs">
            <span className="on">Employees</span>
          </div>
          <select className="field center-filter" value={activeOnly ? 'active' : 'all'} onChange={(e) => setActiveOnly(e.target.value === 'active')} aria-label="Show employees">
            <option value="active">Active Employees</option>
            <option value="all">All Employees</option>
          </select>
          <ListView
            columns={nameCols}
            rows={list}
            rowKey={(e) => e.id}
            selected={selected}
            onSelect={setSelected}
            onActivate={(e) => desk.open('employee', { id: e.id })}
            rowClass={(e) => (e.inactive ? 'inactive' : '')}
            emptyText={employees ? 'There are no employees.' : 'Loading...'}
            label="Employees"
          />
        </div>
        <div className="center-right">
          <div className="center-info">
            <div className="center-info-main">
              <div className="center-info-head">
                <h2>Employee Information</h2>
                <button type="button" className="center-edit" tabIndex={-1} title="Edit Employee (Ctrl+E)" disabled={!current} onClick={edit}>
                  ✎
                </button>
              </div>
              {current && (
                <dl className="center-fields">
                  <dt>Full Name</dt>
                  <dd>
                    <b>{[current.first_name, current.middle_init, current.last_name].filter(Boolean).join(' ') || current.full_name}</b>
                  </dd>
                  <dt>Address</dt>
                  <dd className="pre">{current.bill_addr || current.full_name}</dd>
                  {current.phone && (
                    <>
                      <dt>Phone</dt>
                      <dd>{current.phone}</dd>
                    </>
                  )}
                  {current.email && (
                    <>
                      <dt>Email</dt>
                      <dd>{current.email}</dd>
                    </>
                  )}
                  {current.hire_date && (
                    <>
                      <dt>Hire Date</dt>
                      <dd>{formatUsDate(current.hire_date)}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
            <div className="center-reports">
              <h3>Reports for this Employee</h3>
              <button type="button" className="linkbtn" disabled={!current} onClick={() => current && openQuickReport(desk, { name_id: current.id })}>
                QuickReport
              </button>
              <button type="button" className="linkbtn" disabled={!current} onClick={() => openReport(desk, 'payroll_summary', { name_ids: nameIds })}>
                Payroll Summary
              </button>
              <button type="button" className="linkbtn" disabled={!current} onClick={() => openReport(desk, 'payroll_detail', { name_ids: nameIds })}>
                Payroll Transaction Detail
              </button>
            </div>
          </div>
          <div className="center-txns">
            <div className="center-tabs">
              <span className="on">Transactions</span>
            </div>
            <div className="center-txn-filters">
              <label>
                Show
                <select className="field" value={show} onChange={(e) => setShow(e.target.value as Show)}>
                  {(Object.keys(SHOWS) as Show[]).map((k) => (
                    <option key={k} value={k}>
                      {SHOWS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Date
                <select className="field" value={range} onChange={(e) => setRange(e.target.value as Range)}>
                  {(Object.keys(RANGES) as Range[]).map((k) => (
                    <option key={k} value={k}>
                      {RANGES[k].label}
                    </option>
                  ))}
                </select>
              </label>
              <span>{dates ? `${formatUsDate(dates.from)} - ${formatUsDate(dates.to)}` : ''}</span>
            </div>
            {error && <div className="msg-strip error">{error}</div>}
            <ListView
              columns={txnCols}
              rows={txns}
              rowKey={(r) => r.id}
              selected={txnSel}
              onSelect={setTxnSel}
              onActivate={(r) => void openTxn(desk, r.type, r.id)}
              emptyText={
                !current
                  ? ''
                  : found
                    ? `There are no transactions of type "${SHOWS[show]}" in date range "${RANGES[range].label}".`
                    : 'Loading...'
              }
              label="Transactions"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
