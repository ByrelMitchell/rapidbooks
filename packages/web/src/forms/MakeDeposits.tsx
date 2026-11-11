import {
  formatMoney,
  formatUsDate,
  todayIso,
  type Account,
  type DepositInput,
  type DocTxn,
  type Name,
  type PendingPayment,
} from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { ListView, type Column } from '../controls/ListView';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import { handOffLocked } from './openTxn';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { adjacentTxn, anyNameQuickFill, PayMethodField } from './receivablesShared';
import './receivables.css';
import { MiniButton, MiniToolbar, SaveButtons } from './Ribbon';

interface Line {
  key: number;
  nameId: number | null;
  accountId: number | null;
  memo: string;
  refNo: string;
  method: string;
  amount: number | null;
}
interface Form {
  bankId: number | null;
  date: string;
  memo: string;
  payments: PendingPayment[];
  lines: Line[];
}
type Col = 'name' | 'account' | 'memo' | 'ref' | 'method' | 'amount';
const START_LINES = 6;

let lineSeq = 0;
const blankLine = (): Line => ({ key: ++lineSeq, nameId: null, accountId: null, memo: '', refNo: '', method: '', amount: null });
const isBlank = (l: Line) =>
  l.nameId === null && l.accountId === null && l.amount === null && !l.memo.trim() && !l.refNo.trim() && !l.method.trim();
const blankLines = (n: number) => Array.from({ length: n }, blankLine);
function withTrailingBlank(lines: Line[]): Line[] {
  if (lines.length === 0 || !isBlank(lines[lines.length - 1])) return [...lines, blankLine()];
  return lines;
}

function serialize(f: Form): string {
  return JSON.stringify({
    bankId: f.bankId,
    date: f.date,
    memo: f.memo,
    payments: f.payments.map((p) => p.id),
    lines: f.lines.filter((l) => !isBlank(l)).map(({ key: _k, ...rest }) => rest),
  });
}

const newForm = (bankId: number | null): Form => ({
  bankId,
  date: todayIso(),
  memo: '',
  payments: [],
  lines: blankLines(START_LINES),
});

export function MakeDeposits({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: names } = useData<Name[]>('/api/names');
  const [form, setForm, formRef] = useLiveState<Form>(() => newForm(null));
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const curRow = useRef(0);
  const focusReq = useRef<{ row: number; col: Col } | 'top' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ufId = accounts?.find((a) => a.system_role === 'UNDEPOSITED')?.id ?? null;
  const firstBank = accounts?.find((a) => a.type === 'BANK' && !a.inactive)?.id ?? null;

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const markClean = () => {
    snapshot.current = serialize(formRef.current);
  };

  // A new deposit goes to the first bank account until she picks another.
  useEffect(() => {
    if (firstBank === null || txnIdRef.current !== null || formRef.current.bankId !== null) return;
    const clean = !isDirty();
    setForm((f) => ({ ...f, bankId: firstBank }));
    if (clean) markClean();
  }, [firstBank]);

  /** The "Payments to Deposit" window; resolves to the chosen payments, or null if cancelled. */
  const choosePayments = async (current: PendingPayment[], depositId: number | null) =>
    desk.openForResult<PendingPayment[]>('depositpicker', {
      depositId,
      selected: current.map((p) => p.id),
    });

  const startNew = async (askPayments: boolean) => {
    const f = newForm(firstBank);
    setForm(f);
    setTxnId(null);
    version.current = undefined;
    setError(null);
    curRow.current = 0;
    markClean();
    setLoading(false);
    if (!askPayments) {
      focusReq.current = 'top';
      return;
    }
    try {
      const pending = await api.get<PendingPayment[]>('/api/deposits/pending');
      if (pending.length > 0) {
        const chosen = await choosePayments([], null);
        if (chosen && chosen.length) setForm((x) => ({ ...x, payments: chosen }));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
    focusReq.current = 'top';
  };

  const load = async (id: number) => {
    setLoading(true);
    try {
      const t = await api.get<DocTxn>(`/api/txns/${id}`);
      if (handOffLocked(desk, winId, t)) return;
      if (t.type !== 'DEPOSIT') throw new Error('That transaction is not a deposit.');
      const pend = await api.get<PendingPayment[]>(`/api/deposits/pending?deposit_id=${id}`);
      const order = new Map(t.payment_ids.map((p, i) => [p, i]));
      const payments = pend.filter((p) => order.has(p.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      const lines: Line[] = t.lines.map((l) => ({
        key: ++lineSeq,
        nameId: l.name_id,
        accountId: l.account_id,
        memo: l.description,
        refNo: l.ref_no,
        method: l.pay_method,
        amount: l.amount,
      }));
      while (lines.length < START_LINES) lines.push(blankLine());
      const f: Form = { bankId: t.account_id, date: t.date, memo: t.memo, payments, lines: withTrailingBlank(lines) };
      setForm(f);
      setTxnId(id);
      version.current = t.version;
      setError(null);
      curRow.current = 0;
      markClean();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Once per window (StrictMode runs mount effects twice; one chooser is enough).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (propId !== null) void load(propId);
    else void startNew(true);
  }, [propId]);

  useLayoutEffect(() => {
    const req = focusReq.current;
    if (req === null || loading) return;
    focusReq.current = null;
    const root = rootRef.current;
    if (req === 'top') {
      root?.querySelector<HTMLElement>('[data-field="bank"]')?.focus();
      return;
    }
    (
      root?.querySelector<HTMLElement>(`[data-row="${req.row}"][data-col="${req.col}"]`) ??
      root?.querySelector<HTMLElement>(`[data-row="${req.row}"]`)
    )?.focus();
  });

  const bankOptions = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => a.type === 'BANK' && (!a.inactive || a.id === form.bankId))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, form.bankId],
  );
  const accountOptions = useMemo(() => {
    const used = new Set(form.lines.map((l) => l.accountId));
    return (accounts ?? [])
      .filter((a) => a.id !== ufId && (!a.inactive || used.has(a.id)))
      .map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, form.lines, ufId]);
  const nameOptions = useMemo(() => {
    const used = new Set(form.lines.map((l) => l.nameId));
    return (names ?? []).filter((n) => !n.inactive || used.has(n.id)).map((n) => ({ id: n.id, label: n.full_name }));
  }, [names, form.lines]);
  const ufName = accounts?.find((a) => a.id === ufId)?.full_name ?? 'Undeposited Funds';

  const edit = (change: (f: Form) => Form) => {
    setError(null);
    setForm(change);
  };
  const editLine = (i: number, patch: Partial<Line>) =>
    edit((f) => {
      const lines = [...f.lines];
      lines[i] = { ...lines[i], ...patch };
      return { ...f, lines: withTrailingBlank(lines) };
    });

  const npay = form.payments.length;

  const reopenPayments = async () => {
    commitActiveField();
    const chosen = await choosePayments(formRef.current.payments, txnIdRef.current);
    if (chosen) edit((f) => ({ ...f, payments: chosen }));
  };

  const insertLine = () => {
    commitActiveField();
    const n = formRef.current.payments.length;
    const i = Math.max(0, Math.min(curRow.current - n, formRef.current.lines.length - 1));
    edit((f) => {
      const lines = [...f.lines];
      lines.splice(i, 0, blankLine());
      return { ...f, lines };
    });
    focusReq.current = { row: n + i, col: 'name' };
  };

  // Ctrl+Delete: a payment row leaves the deposit (back to Undeposited Funds); an other line is deleted.
  const deleteLine = () => {
    commitActiveField();
    const f = formRef.current;
    const n = f.payments.length;
    const row = Math.min(curRow.current, n + f.lines.length - 1);
    if (row < n) {
      edit((x) => ({ ...x, payments: x.payments.filter((_, j) => j !== row) }));
      focusReq.current = { row: Math.max(0, Math.min(row, n + f.lines.length - 2)), col: 'name' };
      return;
    }
    const i = row - n;
    edit((x) => ({ ...x, lines: withTrailingBlank(x.lines.filter((_, j) => j !== i)) }));
    focusReq.current = { row, col: 'name' };
  };

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      if (!(await settleQuickFill())) return;
      const f = formRef.current;
      const id = txnIdRef.current;
      if (id === null && !isDirty()) {
        if (mode === 'close') desk.close(winId);
        else refocus(field);
        return;
      }
      const fail = (msg: string) => {
        setError(msg);
        refocus(field);
      };
      if (f.bankId === null) return fail('Choose the bank account to deposit to.');
      const used = f.lines.filter((l) => !isBlank(l));
      const noAcct = used.findIndex((l) => l.accountId === null);
      if (noAcct >= 0) return fail(`Choose the account that line ${npay + f.lines.indexOf(used[noAcct]) + 1} comes from.`);
      if (f.payments.length === 0 && used.length === 0) return fail('Choose payments to deposit, or fill in a line.');
      const body: DepositInput = {
        type: 'DEPOSIT',
        date: f.date,
        num: '',
        name_id: null,
        memo: f.memo.trim(),
        account_id: f.bankId,
        payment_ids: f.payments.map((p) => p.id),
        lines: used.map((l) => ({
          name_id: l.nameId,
          account_id: l.accountId,
          description: l.memo.trim(),
          ref_no: l.refNo.trim(),
          pay_method: l.method.trim(),
          amount: l.amount ?? 0,
        })),
        ...(id !== null ? { version: version.current } : {}),
      };
      let r: { id: number; version: number };
      try {
        r =
          id === null
            ? await api.post<{ id: number; version: number }>('/api/txns', body)
            : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      } catch (e) {
        return fail(errorMessage(e));
      }
      desk.refresh();
      desk.setStatus(`Deposit of ${formatMoney(depositTotal(f))} saved.`);
      setError(null);
      if (mode === 'close') desk.close(winId);
      else if (mode === 'new') await startNew(true);
      else {
        setTxnId(r.id);
        version.current = r.version;
        markClean();
        refocus(field);
      }
    } finally {
      busy.current = false;
    }
  };

  const confirmLeave = async () => {
    const field = commitActiveField({ quiet: true });
    if (loading || !isDirty()) return true;
    if (await desk.confirm('This deposit has changes that have not been saved. Do you want to discard changes?', { defaultNo: true }))
      return true;
    refocus(field);
    return false;
  };

  const go = async (dir: 'prev' | 'next') => {
    if (!(await confirmLeave())) return;
    try {
      const id = await adjacentTxn('DEPOSIT', txnIdRef.current, dir);
      if (id === null) desk.setStatus(dir === 'prev' ? 'There is no earlier deposit.' : 'There is no later deposit.');
      else await load(id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async () => {
    const id = txnIdRef.current;
    if (id === null) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    try {
      await api.del(`/api/txns/${id}`);
      desk.setStatus('Deposit deleted. Its payments are back in Undeposited Funds.');
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const clear = () => {
    commitActiveField({ quiet: true });
    void startNew(false);
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    saveNew: () => void save('new'),

    keys2013: true,
    insertLine,
    deleteLine,
    new: () =>
      void confirmLeave().then(async (ok) => {
        if (ok) await startNew(true);
      }),
    delete: txnId !== null ? () => void remove() : undefined,
    confirmClose: confirmLeave,
  });

  // Up/Down move between rows (payment rows included) in the same column.
  const onGridKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    const col = t.dataset.col as Col | undefined;
    if (!col || Number.isNaN(row)) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= npay + form.lines.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-col="${col}"]`)?.focus();
  };

  const total = depositTotal(form);
  const methods = form.payments.map((p) => p.pay_method);
  const ro = (row: number, col: Col, value: string, right = false) => (
    <input
      className={`field${right ? ' amount-field' : ''}`}
      readOnly
      tabIndex={col === 'name' ? 0 : -1}
      value={value}
      data-row={row}
      data-col={col}
      aria-label={`Payment, line ${row + 1}`}
      title="A payment from Undeposited Funds. Ctrl+Delete takes it out of this deposit."
    />
  );

  // Alt+P Previous, Alt+X Next, Alt+T the Deposit To field (letters no menu uses).
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const fn =
      e.code === 'KeyP'
        ? () => void go('prev')
        : e.code === 'KeyX'
          ? () => void go('next')
          : e.code === 'KeyT'
            ? () => rootRef.current?.querySelector<HTMLElement>('[data-field="bank"]')?.focus()
            : undefined;
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  return (
    <div className="f13" ref={rootRef}>
      <MiniToolbar>
        <MiniButton icon="prev" label="&Previous" keys="Alt+P" disabled={loading} onClick={() => void go('prev')} />
        <MiniButton icon="next" label="Ne&xt" keys="Alt+X" disabled={loading} onClick={() => void go('next')} />
        <MiniButton icon="save" label="Save" keys="Ctrl+Enter" disabled={loading} onClick={() => void save('stay')} />
        <span className="minitb-sep" />
        <MiniButton icon="payments" label="Payments" disabled={loading} onClick={() => void reopenPayments()} />
        <MiniButton
          icon="journal"
          label="Journal"
          keys="Ctrl+Y"
          disabled={loading || txnId === null}
          onClick={() => txnId !== null && desk.open('txnjournal', { txnId })}
        />
      </MiniToolbar>
      <div className="f13-page" onKeyDown={onBarKey}>
        <div className="dep13-head">
          <label>
            <Mnemonic label="Deposit &To" />
            <Combo
              options={bankOptions}
              value={form.bankId}
              onChange={(bankId) => edit((f) => ({ ...f, bankId }))}
              data-field="bank"
              disabled={loading}
              {...accountQuickFill(desk, { type: 'BANK' })}
            />
          </label>
          <label>
            Date
            <DateField value={form.date} onChange={(date) => edit((f) => ({ ...f, date }))} disabled={loading} />
          </label>
          <label>
            Memo
            <input
              className="field memo"
              value={form.memo}
              disabled={loading}
              onChange={(e) => {
                const memo = e.target.value;
                edit((f) => ({ ...f, memo }));
              }}
            />
          </label>
        </div>
        <div>Click Payments to select customer payments that you have received. List any other amounts to deposit below.</div>
        {error && <div className="msg-strip error">{error}</div>}
        <div className="grid-wrap">
          <table className="line-grid">
            <colgroup>
              <col style={{ width: '18%' }} />
              <col style={{ width: '13%' }} />
              <col />
              <col style={{ width: '9%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '17%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Received From</th>
                <th>From Account</th>
                <th>Memo</th>
                <th>Chk No.</th>
                <th>Pmt Meth.</th>
                <th className="al-right">Amount</th>
              </tr>
            </thead>
            <tbody onKeyDown={onGridKey}>
              {form.payments.map((p, i) => (
                <tr key={`p${p.id}`} className="ro-row" onFocus={() => (curRow.current = i)}>
                  <td>{ro(i, 'name', p.full_name)}</td>
                  <td>{ro(i, 'account', ufName)}</td>
                  <td>{ro(i, 'memo', p.memo)}</td>
                  <td>{ro(i, 'ref', p.ref_no)}</td>
                  <td>{ro(i, 'method', p.pay_method)}</td>
                  <td>{ro(i, 'amount', formatMoney(p.amount), true)}</td>
                </tr>
              ))}
              {form.lines.map((l, j) => {
                const i = npay + j;
                return (
                  <tr key={l.key} onFocus={() => (curRow.current = i)}>
                    <td>
                      <Combo
                        options={nameOptions}
                        value={l.nameId}
                        onChange={(nameId) => editLine(j, { nameId })}
                        data-row={i}
                        data-col="name"
                        aria-label={`Received from, line ${i + 1}`}
                        disabled={loading}
                        {...anyNameQuickFill(desk)}
                      />
                    </td>
                    <td>
                      <Combo
                        options={accountOptions}
                        value={l.accountId}
                        onChange={(accountId) => editLine(j, { accountId })}
                        data-row={i}
                        data-col="account"
                        aria-label={`From account, line ${i + 1}`}
                        disabled={loading}
                        {...accountQuickFill(desk)}
                      />
                    </td>
                    <td>
                      <input
                        className="field"
                        value={l.memo}
                        data-row={i}
                        data-col="memo"
                        aria-label={`Memo, line ${i + 1}`}
                        disabled={loading}
                        onChange={(e) => editLine(j, { memo: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="field"
                        value={l.refNo}
                        maxLength={20}
                        data-row={i}
                        data-col="ref"
                        aria-label={`Check number, line ${i + 1}`}
                        disabled={loading}
                        onChange={(e) => editLine(j, { refNo: e.target.value })}
                      />
                    </td>
                    <td>
                      <PayMethodField
                        value={l.method}
                        extra={methods}
                        onChange={(method) => editLine(j, { method })}
                        data-row={i}
                        data-col="method"
                        aria-label={`Payment method, line ${i + 1}`}
                        disabled={loading}
                      />
                    </td>
                    <td>
                      <AmountField
                        value={l.amount}
                        onChange={(amount) => editLine(j, { amount })}
                        data-row={i}
                        data-col="amount"
                        aria-label={`Amount, line ${i + 1}`}
                        disabled={loading}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="dep13-foot">
          <div className="dep13-totals">
            <span>Deposit Subtotal</span>
            <span>{formatMoney(total)}</span>
            <span>Deposit Total</span>
            <span>{formatMoney(total)}</span>
          </div>
        </div>
        <SaveButtons
          disabled={loading}
          saved={txnId !== null}
          onSave={(m) => void save(m)}
          onClear={txnId === null ? clear : () => void remove()}
          clearLabel={txnId === null ? 'Clear' : 'Delete'}
        />
      </div>
    </div>
  );
}

function depositTotal(f: Form): number {
  return f.payments.reduce((t, p) => t + p.amount, 0) + f.lines.reduce((t, l) => t + (l.amount ?? 0), 0);
}

/** "Payments to Deposit": tick the payments in Undeposited Funds that go in this deposit. */
export function PaymentsToDeposit({ winId, props }: WinProps) {
  const depositId = (props.depositId as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data, error } = useData<PendingPayment[]>(
    `/api/deposits/pending${depositId !== null ? `?deposit_id=${depositId}` : ''}`,
  );
  const rows = data ?? [];
  const [checked, setChecked] = useState<Set<number>>(() => new Set((props.selected as number[] | undefined) ?? []));
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  const toggle = (id: number) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const ok = () => {
    if (!data) return;
    desk.resolveWindow(
      winId,
      rows.filter((r) => checked.has(r.id)),
    );
    desk.close(winId);
  };
  useWindowCommands(winId, { save: ok, saveClose: ok });

  const columns: Column<PendingPayment>[] = [
    {
      key: 'chk',
      title: '✓',
      width: '2rem',
      align: 'center',
      render: (r) => (checked.has(r.id) ? '✓' : ''),
      onClick: (r) => toggle(r.id),
    },
    { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.date) },
    { key: 'type', title: 'Type', width: '3.5rem', render: () => 'PMT' },
    { key: 'no', title: 'No.', width: '5.5rem', render: (r) => r.ref_no },
    { key: 'meth', title: 'Pmt Meth', width: '7rem', render: (r) => r.pay_method },
    { key: 'name', title: 'Name', render: (r) => r.full_name },
    { key: 'amt', title: 'Amount', width: '7.5rem', align: 'right', render: (r) => formatMoney(r.amount) },
  ];
  const chosenTotal = rows.filter((r) => checked.has(r.id)).reduce((t, r) => t + r.amount, 0);

  return (
    <div
      className="list-window"
      onKeyDown={(e) => {
        if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
        const t = e.target as HTMLElement;
        if (e.key === ' ' && t.classList.contains('listview')) {
          e.preventDefault();
          if (selected !== null) toggle(selected);
        }
      }}
    >
      <div className="hint">Select the payments to deposit (Space ticks the one you are on), then OK.</div>
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={ok}
        emptyText={data ? 'There are no payments waiting to be deposited.' : 'Loading...'}
        label="Payments to deposit"
      />
      <div className="button-row">
        <span>
          {rows.filter((r) => checked.has(r.id)).length} of {rows.length} payments selected for deposit: {formatMoney(chosenTotal)}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setChecked(new Set(rows.map((r) => r.id)))}>
          Select All
        </button>
        <button type="button" className="btn" onClick={() => setChecked(new Set())}>
          Select None
        </button>
        <button type="button" className="btn default" disabled={!data} onClick={ok}>
          OK
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
