import { accountType, formatMoney, formatUsDate, TXN_TYPE_SHORT, type Account, type RegisterRow } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { openTxn as openTxnWindow } from '../forms/openTxn';
import { openQuickReport } from '../reports/open';
import { RibbonIcon } from '../forms/Ribbon';
import { Mnemonic } from '../util';

export function Register({ winId, props }: WinProps) {
  const accountId = props.accountId as number;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data, error } = useData<RegisterRow[]>(`/api/accounts/${accountId}/register`);
  const rows = data ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const placed = useRef(false);

  const account = accounts?.find((a) => a.id === accountId);
  const names = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.full_name])), [accounts]);
  const type = account ? accountType(account.type) : null;
  const debitNormal = type?.debitNormal ?? true;

  useEffect(() => {
    if (account) desk.setTitle(winId, account.full_name);
    // desk.setTitle is stable; only the name matters.
  }, [account?.full_name, winId]);

  // Start at the newest entry; afterwards keep the selection (or the nearest row) across reloads.
  useEffect(() => {
    if (!data) return;
    if (!placed.current || selected === null || !data.some((r) => r.split_id === selected)) {
      placed.current = true;
      setSelected(data.length ? data[data.length - 1].split_id : null);
    }
  }, [data, selected]);

  const current = rows.find((r) => r.split_id === selected) ?? null;

  const openTxn = (r: RegisterRow | null) => {
    if (r) openTxnWindow(desk, r.type, r.txn_id);
  };

  const toggleCleared = async (r: RegisterRow) => {
    try {
      await api.put(`/api/splits/${r.split_id}/cleared`, { cleared: !r.cleared });
      desk.refresh();
    } catch (e) {
      desk.setStatus(errorMessage(e));
    }
  };

  const deleteTxn = async () => {
    if (!current) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    try {
      await api.del(`/api/txns/${current.txn_id}`);
      desk.setStatus('Transaction deleted.');
      desk.refresh();
    } catch (e) {
      await desk.alert(errorMessage(e));
    }
  };

  // In a bank register a new entry is a check on that account (as in QuickBooks).
  const newEntry = () => (account?.type === 'BANK' ? desk.open('check', { id: null, accountId }) : desk.open('journal', { id: null }));

  useWindowCommands(winId, {
    new: newEntry,
    edit: () => openTxn(current),
    delete: () => void deleteTxn(),
    quickReport: () => openQuickReport(desk, { account_id: accountId }),
  });

  const isBank = account?.type === 'BANK';
  // Credits on the left, ✓, debits on the right (as in the QuickBooks registers).
  const [leftTitle, rightTitle] = isBank ? ['Payment', 'Deposit'] : debitNormal ? ['Decrease', 'Increase'] : ['Increase', 'Decrease'];
  const credit = (r: RegisterRow) => (r.amount < 0 ? formatMoney(-r.amount) : '');
  const debit = (r: RegisterRow) => (r.amount > 0 ? formatMoney(r.amount) : '');
  const natural = (cents: number) => (debitNormal ? cents : -cents);

  // Fixed widths for the dates, numbers and amounts; Name and Account share the rest with Memo
  // by percentage, and the table never gets narrower than .register-table's minimum, so Memo
  // keeps real room (the list scrolls sideways instead when the window is made small or zoomed).
  const columns: Column<RegisterRow>[] = [
    { key: 'date', title: 'Date', width: '6.5rem', render: (r) => formatUsDate(r.date) },
    { key: 'num', title: 'Number', width: '4.5rem', render: (r) => r.num },
    { key: 'type', title: 'Type', width: '5rem', render: (r) => TXN_TYPE_SHORT[r.type] ?? r.type },
    { key: 'name', title: 'Name', width: '13%', render: (r) => r.name ?? '' },
    {
      key: 'account',
      title: 'Account',
      width: '14%',
      render: (r) => (r.other_account_id === null ? '-split-' : names.get(r.other_account_id) ?? ''),
    },
    { key: 'memo', title: 'Memo', render: (r) => r.memo },
    { key: 'left', title: leftTitle, width: '6.5rem', align: 'right', render: credit },
    {
      key: 'cleared',
      title: '✓',
      width: '1.75rem',
      align: 'center',
      render: (r) => (r.cleared ? '✓' : ''),
      onClick: (r) => void toggleCleared(r),
    },
    { key: 'right', title: rightTitle, width: '6.5rem', align: 'right', render: debit },
    { key: 'balance', title: 'Balance', width: '7.5rem', align: 'right', render: (r) => formatMoney(natural(r.balance)) },
  ];

  const ending = rows.length ? rows[rows.length - 1].balance : 0;
  const accountOf = (r: RegisterRow) => (r.other_account_id === null ? '-split-' : names.get(r.other_account_id) ?? '');
  const [oneLine, setOneLine] = useState(false);

  return (
    <div className="list-window reg13">
      <div className="minitb reg13-tb" role="toolbar" onMouseDown={(e) => e.preventDefault()}>
        <button type="button" className="minitb-btn" tabIndex={-1} title="Find (Ctrl+F)" onClick={() => desk.open('find')}>
          <RibbonIcon name="lookup" />
          <u>G</u>o to...
        </button>
        <button type="button" className="minitb-btn" tabIndex={-1} title={isBank ? 'Write Checks (Ctrl+N)' : 'New (Ctrl+N)'} onClick={newEntry}>
          <RibbonIcon name="new" />
          {isBank ? 'New Check' : 'New Entry'}
        </button>
        {isBank && (
          <>
            <button type="button" className="minitb-btn" tabIndex={-1} title="Make Deposits" onClick={() => desk.open('deposit', { id: null })}>
              <RibbonIcon name="payments" />
              Deposit
            </button>
            <button type="button" className="minitb-btn" tabIndex={-1} title="Transfer Funds" onClick={() => desk.open('transfer', { id: null })}>
              <RibbonIcon name="reverse" />
              Transfer
            </button>
          </>
        )}
        <button type="button" className="minitb-btn" tabIndex={-1} disabled={!current} title="Ctrl+E" onClick={() => openTxn(current)}>
          <RibbonIcon name="journal" />
          <u>E</u>dit Transaction
        </button>
        <button type="button" className="minitb-btn" tabIndex={-1} title="Ctrl+Q" onClick={() => openQuickReport(desk, { account_id: accountId })}>
          <RibbonIcon name="report" />
          QuickReport
        </button>
      </div>
      {error && <div className="msg-strip error">{error}</div>}
      {oneLine ? (
        <ListView
          columns={columns}
          rows={rows}
          rowKey={(r) => r.split_id}
          selected={selected}
          onSelect={setSelected}
          onActivate={openTxn}
          emptyText={data ? 'There are no transactions in this account.' : 'Loading...'}
          label="Register"
          tableClass="register-table"
        />
      ) : (
        <TwoLineRegister
          rows={rows}
          selected={selected}
          onSelect={setSelected}
          onActivate={openTxn}
          onNew={newEntry}
          leftTitle={leftTitle}
          rightTitle={rightTitle}
          nameTitle={isBank ? 'Payee' : 'Name'}
          credit={credit}
          debit={debit}
          balance={(r) => formatMoney(natural(r.balance))}
          accountOf={accountOf}
          onToggleCleared={(r) => void toggleCleared(r)}
          emptyText={data ? '' : 'Loading...'}
        />
      )}
      <div className="reg13-foot">
        <div className="reg13-left">
          <button type="button" className="btn" disabled={!current} title="The debits and credits of this transaction (Ctrl+Y)" onClick={() => current && desk.open('txnjournal', { txnId: current.txn_id })}>
            <Mnemonic label="S&plits" />
          </button>
          <label className="check">
            <input type="checkbox" checked={oneLine} onChange={(e) => setOneLine(e.target.checked)} />
            <Mnemonic label="&1-Line" />
          </label>
        </div>
        <span className="cap-left">Ending Balance</span>
        <span className="reg13-ending">{formatMoney(natural(ending))}</span>
      </div>
    </div>
  );
}

/**
 * The QuickBooks 2013 register: two lines per transaction (date, number, payee and amounts;
 * then type, account and memo), the second line tinted green, and an empty entry line at the
 * bottom that starts a new one. Up/Down, PgUp/PgDn, Home/End move; Enter opens.
 */
function TwoLineRegister({
  rows,
  selected,
  onSelect,
  onActivate,
  onNew,
  leftTitle,
  rightTitle,
  nameTitle,
  credit,
  debit,
  balance,
  accountOf,
  onToggleCleared,
  emptyText,
}: {
  rows: RegisterRow[];
  selected: number | null;
  onSelect: (id: number) => void;
  onActivate: (r: RegisterRow) => void;
  onNew: () => void;
  leftTitle: string;
  rightTitle: string;
  nameTitle: string;
  credit: (r: RegisterRow) => string;
  debit: (r: RegisterRow) => string;
  balance: (r: RegisterRow) => string;
  accountOf: (r: RegisterRow) => string;
  onToggleCleared: (r: RegisterRow) => void;
  emptyText: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // -1 = the empty entry line at the bottom.
  const index = selected === null ? -1 : rows.findIndex((r) => r.split_id === selected);
  const [onBlank, setOnBlank] = useState(false);

  useEffect(() => {
    const el = box.current?.querySelector(onBlank ? 'tbody.reg13-new' : `tbody[data-index="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index, rows.length, onBlank]);

  const pageSize = () => {
    const b = box.current;
    const t = b?.querySelector('tbody[data-index]') as HTMLElement | null;
    if (!b || !t) return 5;
    return Math.max(1, Math.floor(b.clientHeight / (t.offsetHeight || 1)) - 2);
  };
  const go = (i: number) => {
    if (i >= rows.length) {
      setOnBlank(true);
      return;
    }
    setOnBlank(false);
    const r = rows[Math.max(0, i)];
    if (r) onSelect(r.split_id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const cur = onBlank ? rows.length : index;
    const last = rows.length; // the entry line
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(last, cur + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, cur - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'PageDown':
        next = Math.min(last, cur + pageSize());
        break;
      case 'PageUp':
        next = Math.max(0, cur - pageSize());
        break;
      case 'Enter':
        e.preventDefault();
        if (onBlank) onNew();
        else if (index >= 0) onActivate(rows[index]);
        return;
      default:
        return;
    }
    e.preventDefault();
    go(next);
  };

  return (
    <div className="listview reg13-view" ref={box} tabIndex={0} role="grid" aria-label="Register" onKeyDown={onKeyDown}>
      <table className="reg13-table">
        <colgroup>
          <col style={{ width: '6.5em' }} />
          <col style={{ width: '5.5em' }} />
          <col style={{ width: '22%' }} />
          <col />
          <col style={{ width: '9em' }} />
          <col style={{ width: '1.75em' }} />
          <col style={{ width: '9em' }} />
          <col style={{ width: '9em' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Number</th>
            <th colSpan={2} className="al-center">
              {nameTitle}
            </th>
            <th className="al-center">{leftTitle}</th>
            <th className="al-center">✓</th>
            <th className="al-center">{rightTitle}</th>
            <th className="al-center">Balance</th>
          </tr>
          <tr className="reg13-head2">
            <th />
            <th className="al-center">Type</th>
            <th className="al-center">Account</th>
            <th className="al-center">Memo</th>
            <th />
            <th />
            <th />
            <th />
          </tr>
        </thead>
        {rows.map((r, i) => {
          const sel = !onBlank && i === index;
          return (
            <tbody
              key={r.split_id}
              data-index={i}
              className={sel ? 'sel' : undefined}
              onMouseDown={() => go(i)}
              onDoubleClick={() => onActivate(r)}
            >
              <tr>
                <td>{formatUsDate(r.date)}</td>
                <td>{r.num}</td>
                <td colSpan={2}>{r.name ?? ''}</td>
                <td className="al-right">{credit(r)}</td>
                <td
                  className="al-center reg13-clr"
                  onClick={() => onToggleCleared(r)}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title="Cleared: click to tick or untick"
                >
                  {r.cleared ? '✔' : ''}
                </td>
                <td className="al-right">{debit(r)}</td>
                <td className="al-right">{balance(r)}</td>
              </tr>
              <tr className="reg13-line2">
                <td />
                <td>{TXN_TYPE_SHORT[r.type] ?? r.type}</td>
                <td>{accountOf(r)}</td>
                <td>{r.memo}</td>
                <td />
                <td />
                <td />
                <td />
              </tr>
            </tbody>
          );
        })}
        <tbody className={`reg13-new${onBlank ? ' sel' : ''}`} onMouseDown={() => go(rows.length)} onDoubleClick={onNew} title="Enter or double-click: a new entry">
          <tr>
            <td>{emptyText || 'Date'}</td>
            <td>Number</td>
            <td colSpan={2}>{nameTitle}</td>
            <td>{leftTitle}</td>
            <td />
            <td>{rightTitle}</td>
            <td />
          </tr>
          <tr>
            <td />
            <td />
            <td>Account</td>
            <td>Memo</td>
            <td />
            <td />
            <td />
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
