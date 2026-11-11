import { formatMoney, formatUsDate, TXN_TYPE_SHORT, type Account, type CheckNumUse, type CheckToPrint } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo } from '../controls/Combo';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { bankOptions, EndingBalance, firstBankId, nextCheckNum } from './checkShared';
import { openTxn } from './openTxn';
import './sales.css';
import './banking.css';

/**
 * File > Print Forms > Checks: the checks, bill payments and paychecks marked To be
 * printed on one bank account. OK numbers the ticked ones from the first check number
 * (in the order listed) and opens each check record to print.
 */
export function PrintChecks({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const [bankId, setBankId] = useState<number | null>(null);
  const [firstNum, setFirstNum] = useState('');
  const { data, error } = useData<CheckToPrint[]>(bankId !== null ? `/api/checks/to-print?account_id=${bankId}` : null);
  const rows = useMemo(() => (bankId !== null ? (data ?? []) : []), [data, bankId]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const seen = useRef(new Set<number>());
  const busy = useRef(false);

  // The first bank account, once the accounts are in.
  useEffect(() => {
    if (bankId === null && accounts) setBankId(firstBankId(accounts));
  }, [accounts]);

  // The next number on the chosen account.
  useEffect(() => {
    if (bankId === null) return;
    let cancelled = false;
    nextCheckNum(bankId).then(
      (n) => !cancelled && setFirstNum(n),
      (e) => !cancelled && setPrintError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [bankId, desk.dataVersion]);

  // Checks start ticked the first time they are listed, as in QuickBooks.
  useEffect(() => {
    const fresh = rows.filter((r) => !seen.current.has(r.id));
    if (fresh.length) {
      for (const r of fresh) seen.current.add(r.id);
      setChecked((c) => new Set([...c, ...fresh.map((r) => r.id)]));
    }
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  const toggle = (id: number) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = rows.filter((r) => checked.has(r.id));

  const print = async () => {
    if (busy.current || bankId === null) return;
    const list = chosen;
    if (list.length === 0) {
      setPrintError('Tick the checks to print.');
      return;
    }
    const first = firstNum.trim();
    if (!/^\d+$/.test(first)) {
      setPrintError('Enter the first check number (digits only).');
      return;
    }
    busy.current = true;
    setPrintError(null);
    try {
      // Numbers already on this account in the range: a warning, as for a single check.
      const clashes: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const n = String(Number(first) + i);
        const use = await api.get<CheckNumUse>(`/api/checks/num-used?account_id=${bankId}&num=${n}`).catch(() => null);
        if (use?.used) clashes.push(n);
      }
      if (clashes.length) {
        const which = clashes.length === 1 ? `Check number ${clashes[0]} has` : `Check numbers ${clashes.join(', ')} have`;
        if (!(await desk.confirm(`${which} already been used. Use ${clashes.length === 1 ? 'it' : 'them'} anyway?`, { title: 'Print Checks', icon: 'warning' })))
          return;
      }
      let assigned: { id: number; num: string }[];
      try {
        assigned = (await api.post<{ assigned: { id: number; num: string }[] }>('/api/checks/assign-numbers', {
          txn_ids: list.map((c) => c.id),
          first_num: first,
        })).assigned;
      } catch (e) {
        setPrintError(errorMessage(e));
        return;
      }
      desk.refresh();
      let blocked = 0;
      for (const a of assigned) if (window.open(`/api/txns/${a.id}/pdf`, '_blank') === null) blocked++;
      const range = assigned.length === 1 ? `Check ${assigned[0].num}` : `Checks ${assigned[0].num} to ${assigned[assigned.length - 1].num}`;
      desk.setStatus(`${range} numbered and opened to print.`);
      if (blocked > 0) {
        await desk.alert(
          `The checks are numbered, but the browser blocked ${blocked} of the ${assigned.length} PDF tabs. ` +
            'Allow pop-ups for RapidBooks in the browser, then open the blocked checks from the register and print them (Ctrl+P).',
        );
      }
    } finally {
      busy.current = false;
    }
  };

  const openRow = (id: number | null) => {
    const r = rows.find((x) => x.id === id);
    if (r) openTxn(desk, r.type, r.id);
  };
  useWindowCommands(winId, { edit: () => openRow(selected), print: () => void print(), save: () => void print() });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey || selected === null) return;
    if (!(e.target as HTMLElement).classList.contains('listview')) return;
    e.preventDefault();
    toggle(selected);
  };

  const columns: Column<CheckToPrint>[] = [
    { key: 'chk', title: '✓', width: '2rem', align: 'center', render: (r) => (checked.has(r.id) ? '✓' : ''), onClick: (r) => toggle(r.id) },
    { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.date) },
    { key: 'type', title: 'Type', width: '5.5rem', render: (r) => TXN_TYPE_SHORT[r.type] ?? r.type },
    { key: 'payee', title: 'Payee', render: (r) => r.full_name },
    { key: 'amt', title: 'Amount', width: '7.5rem', align: 'right', render: (r) => formatMoney(r.amount) },
  ];
  const total = chosen.reduce((t, r) => t + r.amount, 0);

  return (
    <div className="list-window" onKeyDown={onKeyDown}>
      <div className="bk-printhead">
        <label className="inline-fields">
          Bank Account
          <span className="bk-bank">
            <Combo options={bankOptions(accounts, bankId)} value={bankId} onChange={setBankId} aria-label="Bank Account" />
          </span>
        </label>
        <EndingBalance accounts={accounts} id={bankId} />
        <label className="inline-fields">
          First Check Number
          <input className="field num-field" value={firstNum} maxLength={12} onChange={(e) => setFirstNum(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
      </div>
      {(error || printError) && <div className="msg-strip error">{error ?? printError}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={(r) => toggle(r.id)}
        emptyText={bankId === null ? 'Choose a bank account.' : data ? 'There are no checks to print on this account.' : 'Loading...'}
        label="Checks to print"
      />
      <div className="button-row">
        <button type="button" className="btn" onClick={() => setChecked(new Set(rows.map((r) => r.id)))}>
          Select All
        </button>
        <button type="button" className="btn" onClick={() => setChecked(new Set())}>
          Select None
        </button>
        <span>
          {chosen.length} of {rows.length} checks selected: {formatMoney(total)}. Space ticks the selected check.
        </span>
        <span className="spacer" />
        <button type="button" className="btn default" disabled={chosen.length === 0} onClick={() => void print()} title="Ctrl+P">
          OK
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
