import {
  formatMoney,
  formatUsDate,
  todayIso,
  TXN_TYPE_SHORT,
  type Name,
  type Statement,
  type StatementCustomer,
  type StatementRow,
} from '@rapidbooks/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { ListView, type Column } from '../controls/ListView';
import { nameQuickFill } from '../lists/quickAdd';
import { useDesktop } from '../shell/desktop';
import { openTxn } from './openTxn';
import type { WinProps } from '../shell/registry';
import { commitActiveField } from '../util';
import './receivables.css';
import './form2013.css';

/** The first day of the month that ends on (or contains) `iso`: the default statement period. */
function monthStart(iso: string): string {
  return `${iso.slice(0, 8)}01`;
}

const pdfUrl = (customerId: number, from: string, to: string) =>
  `/api/statements/pdf?customer_id=${customerId}&from=${from}&to=${to}`;

interface Pick {
  id: number;
  full_name: string;
  balance: number | null;
  has_activity: boolean | null;
}

export function CreateStatements({ winId }: WinProps) {
  const desk = useDesktop();
  const [stmtDate, setStmtDate] = useState(todayIso);
  const [from, setFrom] = useState(() => monthStart(todayIso()));
  const [to, setTo] = useState(todayIso);
  const [mode, setMode] = useState<'all' | 'multiple' | 'one'>('all');
  const [oneId, setOneId] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const { data: customers } = useData<Name[]>('/api/names?kind=customer');
  const validRange = from !== '' && to !== '' && from <= to;
  const { data: list, error } = useData<StatementCustomer[]>(
    validRange ? `/api/statements/customers?from=${from}&to=${to}` : null,
  );
  const idAll = useId();
  const idOne = useId();
  const idMulti = useId();

  // Changing the statement date moves the period to the month ending on it.
  const changeStmtDate = (d: string) => {
    setStmtDate(d);
    setFrom(monthStart(d));
    setTo(d);
  };

  const rows: Pick[] = useMemo(() => {
    if (mode === 'one') {
      const c = customers?.find((x) => x.id === oneId);
      const s = list?.find((x) => x.customer_id === oneId);
      return c ? [{ id: c.id, full_name: c.full_name, balance: s?.balance ?? null, has_activity: s?.has_activity ?? null }] : [];
    }
    return (list ?? []).map((s) => ({ id: s.customer_id, full_name: s.full_name, balance: s.balance, has_activity: s.has_activity }));
  }, [mode, list, customers, oneId]);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  // Only Multiple Customers uses the ticks; All Customers is every row.
  const chosen = mode === 'multiple' ? rows.filter((r) => !excluded.has(r.id)) : rows;
  const current = rows.find((r) => r.id === selected) ?? null;

  const toggle = (id: number) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const check = (): boolean => {
    commitActiveField();
    if (!validRange) {
      void desk.alert('The statement period is not valid. The From date must be on or before the To date.');
      return false;
    }
    return true;
  };

  const preview = () => {
    if (!check()) return;
    const target = current && chosen.includes(current) ? current : chosen[0];
    if (!target) {
      void desk.alert('There is no customer selected to preview.');
      return;
    }
    desk.open('statementpreview', { customerId: target.id, from, to });
  };

  const print = async () => {
    if (!check()) return;
    if (chosen.length === 0) {
      await desk.alert('There are no customers selected to print statements for.');
      return;
    }
    // Every statement in one combined PDF, in one tab.
    const url =
      chosen.length === 1
        ? pdfUrl(chosen[0].id, from, to)
        : `/api/statements/pdf?customer_ids=${chosen.map((c) => c.id).join(',')}&from=${from}&to=${to}`;
    if (window.open(url, '_blank')) {
      desk.setStatus(`${chosen.length} statement${chosen.length === 1 ? '' : 's'} opened for printing.`);
    } else {
      desk.setStatus('The browser blocked the PDF tab. Allow pop-ups for RapidBooks, then click Print again.');
    }
  };

  const columns: Column<Pick>[] = [
    {
      key: 'chk',
      title: '✓',
      width: '2rem',
      align: 'center',
      render: (r) => (excluded.has(r.id) ? '' : '✓'),
      onClick: (r) => toggle(r.id),
    },
    { key: 'name', title: 'Customer:Job', render: (r) => r.full_name },
    {
      key: 'act',
      title: 'Activity',
      width: '5.5rem',
      align: 'center',
      render: (r) => (r.has_activity === null ? '' : r.has_activity ? 'Yes' : ''),
    },
    {
      key: 'bal',
      title: 'Balance',
      width: '8rem',
      align: 'right',
      render: (r) => (r.balance === null ? '' : formatMoney(r.balance)),
    },
  ];

  return (
    <div className="f13 stmt13">
      <div className="f13-page">
        <div className="stmt13-cols">
          <div className="stmt13-left">
            <fieldset className="sec13">
              <legend>Select Statement Options</legend>
              <div className="stmt13-grid">
                <label htmlFor={`${winId}-sdate`}>Statement Date</label>
                <DateField id={`${winId}-sdate`} value={stmtDate} onChange={changeStmtDate} />
                <span />
                <span />
                <label htmlFor={`${winId}-from`}>Statement Period From</label>
                <DateField id={`${winId}-from`} value={from} onChange={setFrom} />
                <label htmlFor={`${winId}-to`}>To</label>
                <DateField id={`${winId}-to`} value={to} onChange={setTo} />
              </div>
            </fieldset>
            <fieldset className="sec13 stmt13-who">
              <legend>Select Customers</legend>
              <label className="check" htmlFor={idAll}>
                <input id={idAll} type="radio" name={`${winId}-who`} checked={mode === 'all'} onChange={() => setMode('all')} />
                All Customers
              </label>
              <label className="check" htmlFor={idMulti}>
                <input id={idMulti} type="radio" name={`${winId}-who`} checked={mode === 'multiple'} onChange={() => setMode('multiple')} />
                Multiple Customers
              </label>
              <div className="stmt13-one">
                <label className="check" htmlFor={idOne}>
                  <input id={idOne} type="radio" name={`${winId}-who`} checked={mode === 'one'} onChange={() => setMode('one')} />
                  One Customer
                </label>
                <Combo
                  options={(customers ?? []).filter((c) => !c.inactive).map((c) => ({ id: c.id, label: c.full_name }))}
                  value={oneId}
                  onChange={(id) => {
                    setOneId(id);
                    if (id !== null) setMode('one');
                  }}
                  aria-label="Customer"
                  {...nameQuickFill(desk, 'customer')}
                />
              </div>
              <div className="stmt13-note">
                {mode === 'all'
                  ? `${rows.length} customer${rows.length === 1 ? '' : 's'} with a balance or activity in the period.`
                  : mode === 'multiple'
                    ? `${chosen.length} of ${rows.length} ticked below. Space ticks or unticks.`
                    : ''}
              </div>
            </fieldset>
          </div>
          <fieldset className="sec13 stmt13-right">
            <legend>Select Additional Options</legend>
            <p className="stmt13-note">
              Statements show every customer with a balance or with activity in the period; each customer gets one statement.
            </p>
            <button type="button" className="btn" onClick={() => desk.open('financecharges')}>
              Assess Finance Charges...
            </button>
          </fieldset>
        </div>
        {error && <div className="msg-strip error">{error}</div>}
        {mode === 'multiple' && (
          <div
            className="stmt-list"
            onKeyDown={(e) => {
              if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey) return;
              if (!(e.target as HTMLElement).classList.contains('listview')) return;
              e.preventDefault();
              if (selected !== null) toggle(selected);
            }}
          >
            <ListView
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              selected={selected}
              onSelect={setSelected}
              onActivate={() => preview()}
              emptyText={!validRange ? 'The statement period is not valid.' : list ? 'No customer has a balance or activity in this period.' : 'Loading...'}
              label="Customers to print statements for"
            />
            <div className="button-row">
              <button type="button" className="btn" onClick={() => setExcluded(new Set())}>
                Select All
              </button>
              <button type="button" className="btn" onClick={() => setExcluded(new Set(rows.map((r) => r.id)))}>
                Select None
              </button>
            </div>
          </div>
        )}
        <div className="stmt13-buttons">
          <button type="button" className="btn" onClick={preview}>
            Preview
          </button>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={() => void print()}>
            Print
          </button>
          <span className="gap" />
          <button type="button" className="btn" onClick={() => desk.close(winId)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const AGING: [keyof Statement['aging'], string][] = [
  ['current', 'Current'],
  ['d1_30', '1-30 Days Past Due'],
  ['d31_60', '31-60 Days Past Due'],
  ['d61_90', '61-90 Days Past Due'],
  ['over_90', 'Over 90 Days Past Due'],
];

/** One customer's statement on screen (Create Statements > Preview). */
export function StatementPreview({ winId, props }: WinProps) {
  const customerId = props.customerId as number;
  const from = props.from as string;
  const to = props.to as string;
  const desk = useDesktop();
  const [stmt, setStmt] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    api.get<Statement>(`/api/statements?customer_id=${customerId}&from=${from}&to=${to}`).then(
      (s) => {
        setStmt(s);
        setError(null);
        desk.setTitle(winId, `Statement: ${s.full_name}`);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [customerId, from, to, desk.dataVersion]);

  // The balance-forward row has no transaction; index rows by position.
  const rows = useMemo(() => {
    if (!stmt) return [] as (StatementRow & { idx: number })[];
    const fwd: StatementRow = {
      txn_id: null,
      date: stmt.from,
      type: '',
      num: '',
      name_id: null,
      description: 'Balance forward',
      amount: 0,
      balance: stmt.balance_forward,
    };
    return [fwd, ...stmt.rows].map((r, idx) => ({ ...r, idx }));
  }, [stmt]);

  useEffect(() => {
    if (rows.length && selected === null) setSelected(0);
  }, [rows, selected]);

  const openRow = (r: StatementRow) => {
    if (r.txn_id === null) return;
    // Any type, including QuickBooks' own imported ones ("Statement Charge"): openTxn finds its window.
    void openTxn(desk, r.type, r.txn_id);
  };

  const columns: Column<StatementRow & { idx: number }>[] = [
    { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.date) },
    { key: 'type', title: 'Type', width: '5rem', render: (r) => TXN_TYPE_SHORT[r.type] ?? r.type },
    { key: 'num', title: 'Num', width: '5rem', render: (r) => r.num },
    { key: 'desc', title: 'Description', render: (r) => r.description },
    { key: 'amt', title: 'Amount', width: '7.5rem', align: 'right', render: (r) => (r.txn_id === null ? '' : formatMoney(r.amount)) },
    { key: 'bal', title: 'Balance', width: '8rem', align: 'right', render: (r) => formatMoney(r.balance) },
  ];

  return (
    <div className="list-window">
      {error && <div className="msg-strip error">{error}</div>}
      {stmt && (
        <div className="hist-head">
          {stmt.full_name}: {formatUsDate(stmt.from)} to {formatUsDate(stmt.to)}
        </div>
      )}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.idx}
        selected={selected}
        onSelect={setSelected}
        onActivate={openRow}
        emptyText={stmt ? 'Nothing to show.' : 'Loading...'}
        label="Statement"
      />
      {stmt && (
        <table className="aging-table">
          <thead>
            <tr>
              {AGING.map(([k, label]) => (
                <th key={k}>{label}</th>
              ))}
              <th>Amount Due</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              {AGING.map(([k]) => (
                <td key={k}>{formatMoney(stmt.aging[k])}</td>
              ))}
              <td className="total">{formatMoney(stmt.ending_balance)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="button-row right">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!window.open(pdfUrl(customerId, from, to), '_blank')) {
              void desk.alert('The browser blocked the statement tab. Allow pop-ups for RapidBooks, then try again.');
            }
          }}
        >
          Print
        </button>
        <button type="button" className="btn default" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
