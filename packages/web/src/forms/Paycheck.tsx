import {
  addDays,
  formatMoney,
  formatUsDate,
  todayIso,
  type Account,
  type Name,
  type PayLine,
  type PayLineInput,
  type PaycheckInput,
  type PayrollItem,
  type PayrollItemKind,
  type PayrollSummaryRow,
  type PurchTxn,
} from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { accountQuickFill, nameQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import { handOffLocked } from './openTxn';
import type { WinProps } from '../shell/registry';
import { commitActiveField, isQuietBlur, Mnemonic, refocus, useLiveState } from '../util';
import { bankOptions, daysBetween, EndingBalance, firstBankId, nextCheckNum, payeeAddress, useCheckNumGuard } from './checkShared';
import {
  blankPay,
  isBlankPay,
  naturalPay,
  padPay,
  payAmount,
  payForCompare,
  PayGrid,
  payTotal,
  type PayGridHandle,
  type PayRow,
} from './PayGrid';
import { openPdf } from './salesDoc';
import './sales.css';
import './banking.css';

type Section = 'earnings' | 'deductions' | 'company';
const SECTIONS: { key: Section; kind: PayrollItemKind; title: string; rows: number }[] = [
  { key: 'earnings', kind: 'earning', title: 'Earnings', rows: 4 },
  { key: 'deductions', kind: 'deduction', title: 'Deductions', rows: 5 },
  { key: 'company', kind: 'company', title: 'Company Contributions', rows: 4 },
];

interface Form {
  employeeId: number | null;
  bankId: number | null;
  num: string;
  toPrint: boolean;
  date: string;
  periodFrom: string;
  periodTo: string;
  memo: string;
  address: string;
  earnings: PayRow[];
  deductions: PayRow[];
  company: PayRow[];
}

const newForm = (bankId: number | null): Form => ({
  employeeId: null,
  bankId,
  num: '',
  toPrint: false,
  date: todayIso(),
  periodFrom: '',
  periodTo: '',
  memo: '',
  address: '',
  earnings: padPay([], 4),
  deductions: padPay([], 5),
  company: padPay([], 4),
});

const linesKey = (f: Form) =>
  JSON.stringify({ e: payForCompare(f.earnings), d: payForCompare(f.deductions), c: payForCompare(f.company) });
const serialize = (f: Form) =>
  JSON.stringify({ ...f, earnings: payForCompare(f.earnings), deductions: payForCompare(f.deductions), company: payForCompare(f.company) });

/** Stored lines of one kind as grid rows; an amount other than hours × rate is kept as typed. */
function rowsOf(lines: PayLine[], kind: PayrollItemKind, min: number): PayRow[] {
  const rows = [...lines]
    .filter((l) => l.kind === kind)
    .sort((a, b) => a.seq - b.seq)
    .map((l): PayRow => {
      const r: PayRow = { ...blankPay(), itemId: l.payroll_item_id, rate: kind === 'earning' ? l.rate : null, hours: kind === 'earning' ? l.hours : null, amount: null };
      if (kind !== 'earning' || l.amount !== naturalPay(r)) r.amount = l.amount;
      return r;
    });
  return padPay(rows, min);
}

/** Employees > Pay Employees: a paycheck entered by hand. Props: { id: number | null, employeeId?: number }. */
export function Paycheck({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const presetEmployee = (props.employeeId as number | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: employees } = useData<Name[]>('/api/names?kind=employee');
  const { data: payItems } = useData<PayrollItem[]>('/api/payroll-items');
  const empMap = useMemo(() => new Map((employees ?? []).map((n) => [n.id, n])), [employees]);

  const [form, setForm, formRef] = useLiveState<Form>(() => newForm(null));
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const [doc, setDoc] = useState<PurchTxn | null>(null);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const autoNum = useRef('');
  const copied = useRef<string | null>(null); // the lines as copied from the last paycheck
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLInputElement>(null);
  const grids = { earnings: useRef<PayGridHandle>(null), deductions: useRef<PayGridHandle>(null), company: useRef<PayGridHandle>(null) };
  const curGrid = useRef<Section>('earnings');
  const guard = useCheckNumGuard(desk);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;
  const markClean = () => {
    snapshot.current = serialize(formRef.current);
  };
  const wantFocus = useRef(false);
  const focusEmployee = () => {
    const el = rootRef.current?.querySelector<HTMLInputElement>('[data-field="employee"]');
    if (el && !el.disabled) el.focus();
    else wantFocus.current = true;
  };
  useLayoutEffect(() => {
    if (!wantFocus.current || loading) return;
    wantFocus.current = false;
    rootRef.current?.querySelector<HTMLInputElement>('[data-field="employee"]')?.focus();
  });
  const focusNum = () => {
    numRef.current?.focus();
    numRef.current?.select();
  };

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const fillNextNum = async (bankId: number | null) => {
    if (bankId === null) return;
    try {
      const num = await nextCheckNum(bankId);
      const f = formRef.current;
      if (f.bankId !== bankId || f.toPrint || txnIdRef.current !== null) return;
      if (f.num !== '' && f.num !== autoNum.current) return;
      const clean = !isDirty();
      autoNum.current = num;
      setForm((cur) => ({ ...cur, num }));
      guard.markOk(bankId, num);
      if (clean) markClean();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const applyTxn = (t: PurchTxn) => {
    const f: Form = {
      employeeId: t.name_id,
      bankId: t.account_id,
      num: t.to_print ? '' : t.num,
      toPrint: t.to_print,
      date: t.date,
      periodFrom: t.period_from,
      periodTo: t.period_to,
      memo: t.memo,
      address: t.address,
      earnings: rowsOf(t.pay_lines, 'earning', 4),
      deductions: rowsOf(t.pay_lines, 'deduction', 5),
      company: rowsOf(t.pay_lines, 'company', 4),
    };
    setForm(f);
    markClean();
    autoNum.current = '';
    copied.current = null;
    guard.markOk(t.account_id, f.num);
    version.current = t.version;
    setDoc(t);
    setTxnId(t.id);
  };

  const load = async (id: number): Promise<boolean> => {
    try {
      const t = await api.get<PurchTxn>(`/api/txns/${id}`);
      if (handOffLocked(desk, winId, t)) return false;
      if (t.type !== 'PAYCHECK') {
        setError('That transaction is not a paycheck.');
        return false;
      }
      applyTxn(t);
      setError(null);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const startNew = async (bankId?: number | null) => {
    const bank = bankId !== undefined ? bankId : (formRef.current.bankId ?? firstBankId(accounts));
    setForm(newForm(bank));
    markClean();
    autoNum.current = '';
    copied.current = null;
    setTxnId(null);
    setDoc(null);
    version.current = undefined;
    setError(null);
    await fillNextNum(bank);
  };

  /**
   * Employee chosen: the address, and on a new paycheck the lines of the employee's last
   * paycheck (items, rates, hours and amounts), unless she has already filled in other lines.
   */
  const chooseEmployee = async (id: number | null) => {
    set({ employeeId: id });
    if (id === null) return;
    const n = empMap.get(id) ?? (await api.get<Name>(`/api/names/${id}`).catch(() => undefined));
    if (formRef.current.employeeId !== id) return;
    if (n) set({ address: payeeAddress(n) });
    if (txnIdRef.current !== null) return;
    const cur = formRef.current;
    const blank = [...cur.earnings, ...cur.deductions, ...cur.company].every(isBlankPay);
    if (!blank && linesKey(cur) !== copied.current) return;
    let last: PurchTxn | null = null;
    try {
      last = (await api.get<{ paycheck: PurchTxn | null }>(`/api/employees/${id}/last-paycheck`)).paycheck;
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (formRef.current.employeeId !== id || txnIdRef.current !== null) return;
    const who = n?.full_name ?? 'this employee';
    if (!last) {
      if (copied.current !== null) {
        // Lines copied for someone else: start this one empty.
        set({ earnings: padPay([], 4), deductions: padPay([], 5), company: padPay([], 4) });
        copied.current = null;
      }
      desk.setStatus(`There is no earlier paycheck for ${who}. Fill in the earnings and deductions.`);
      return;
    }
    const patch: Partial<Form> = {
      earnings: rowsOf(last.pay_lines, 'earning', 4),
      deductions: rowsOf(last.pay_lines, 'deduction', 5),
      company: rowsOf(last.pay_lines, 'company', 4),
    };
    // The next pay period: the day after the last one ended, for the same number of days.
    if (last.period_from && last.period_to && last.period_to >= last.period_from) {
      const from = addDays(last.period_to, 1);
      patch.periodFrom = from;
      patch.periodTo = addDays(from, daysBetween(last.period_from, last.period_to));
    }
    const bankChanged = last.account_id !== null && last.account_id !== formRef.current.bankId;
    if (bankChanged) patch.bankId = last.account_id;
    set(patch);
    copied.current = linesKey(formRef.current);
    if (bankChanged && !formRef.current.toPrint && (formRef.current.num === '' || formRef.current.num === autoNum.current)) {
      void fillNextNum(last.account_id);
    }
    desk.setStatus(`The last paycheck for ${who} (${formatUsDate(last.date)}) was copied. Check the hours and amounts.`);
  };

  // Open once the accounts are in (for the default bank account).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !accounts) return;
    opened.current = true;
    const p = propId === null ? startNew(firstBankId(accounts)) : load(propId);
    void p.finally(async () => {
      setLoading(false);
      if (propId === null && presetEmployee !== null) {
        await chooseEmployee(presetEmployee);
        markClean(); // opened for an employee: nothing to save until she changes something
      }
      if (propId === null) focusEmployee();
    });
  }, [accounts]);

  // ---- totals and year to date

  const gross = payTotal(form.earnings);
  const deductions = payTotal(form.deductions);
  const company = payTotal(form.company);
  const net = gross - deductions;

  const year = form.date.slice(0, 4);
  const { data: summary } = useData<PayrollSummaryRow[]>(
    form.employeeId !== null ? `/api/payroll/summary?from=${year}-01-01&to=${form.date}&employee_id=${form.employeeId}` : null,
  );
  const ytd = useMemo(() => {
    if (!summary || form.employeeId === null) return undefined;
    const m = new Map<number, number>();
    for (const r of summary) if (r.employee_id === form.employeeId) m.set(r.payroll_item_id, (m.get(r.payroll_item_id) ?? 0) + r.amount);
    // The stored figures of this paycheck are in the summary when it falls in the range; use what is on screen instead.
    if (doc && doc.name_id === form.employeeId && doc.date.slice(0, 4) === year && doc.date <= form.date) {
      for (const l of doc.pay_lines) m.set(l.payroll_item_id, (m.get(l.payroll_item_id) ?? 0) - l.amount);
    }
    for (const r of [...form.earnings, ...form.deductions, ...form.company]) {
      if (r.itemId !== null) m.set(r.itemId, (m.get(r.itemId) ?? 0) + payAmount(r));
    }
    return (itemId: number) => m.get(itemId) ?? null;
  }, [summary, doc, form]);

  // ---- choosing things

  const chooseBank = (bankId: number | null) => {
    const before = formRef.current;
    set({ bankId });
    if (txnIdRef.current === null && !before.toPrint && (before.num === '' || before.num === autoNum.current)) void fillNextNum(bankId);
  };

  const setToPrint = (toPrint: boolean) => {
    if (toPrint) {
      autoNum.current = '';
      set({ toPrint, num: '' });
    } else {
      set({ toPrint });
      if (formRef.current.num === '') void fillNextNum(formRef.current.bankId);
    }
  };

  const checkNum = () => {
    if (isQuietBlur()) return;
    const f = formRef.current;
    if (f.toPrint) return;
    void guard.ensure(f.bankId, f.num, txnIdRef.current).then((ok) => {
      if (!ok) focusNum();
    });
  };

  // ---- saving

  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    const id = txnIdRef.current;
    const fail = (msg: string) => {
      setError(msg);
      return false;
    };
    if (f.employeeId === null) return fail('Choose the employee this paycheck is for.');
    if (f.bankId === null) return fail('Choose the bank account to write this paycheck from.');
    const lines: PayLineInput[] = [];
    for (const s of SECTIONS) {
      const rows = f[s.key];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (isBlankPay(r)) continue;
        if (r.itemId === null) return fail(`Choose a payroll item for ${s.title.toLowerCase()} line ${i + 1}.`);
        lines.push(
          s.kind === 'earning'
            ? { payroll_item_id: r.itemId, hours: r.hours, rate: r.rate, amount: r.amount }
            : { payroll_item_id: r.itemId, hours: null, rate: null, amount: r.amount ?? 0 },
        );
      }
    }
    if (!f.earnings.some((r) => !isBlankPay(r))) return fail('Enter at least one earnings line.');
    const g = payTotal(f.earnings);
    const d = payTotal(f.deductions);
    if (g - d < 0) return fail(`Net pay cannot be negative: deductions of ${formatMoney(d)} are more than earnings of ${formatMoney(g)}.`);
    if (f.periodFrom && f.periodTo && f.periodTo < f.periodFrom) return fail('The pay period ends before it begins.');
    if (!f.toPrint && !(await guard.ensure(f.bankId, f.num, id))) {
      focusNum();
      return false;
    }
    const body: PaycheckInput = {
      type: 'PAYCHECK',
      date: f.date,
      num: f.toPrint ? '' : f.num.trim(),
      to_print: f.toPrint,
      account_id: f.bankId,
      name_id: f.employeeId,
      address: f.address,
      memo: f.memo,
      ...(id !== null ? { version: version.current } : {}),
      period_from: f.periodFrom,
      period_to: f.periodTo,
      lines,
    };
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      const t = await api.get<PurchTxn>(`/api/txns/${r.id}`);
      applyTxn(t);
      setError(null);
      desk.refresh();
      desk.setStatus(`Paycheck${t.num ? ` ${t.num}` : ''} for ${empMap.get(t.name_id ?? -1)?.full_name ?? 'the employee'} saved: net pay ${formatMoney(t.total)}.`);
      return true;
    } catch (e) {
      return fail(errorMessage(e));
    }
  };

  const commitAndSave = async (): Promise<{ ok: boolean; field: HTMLElement | null }> => {
    const field = commitActiveField();
    if (!(await settleQuickFill())) return { ok: false, field: null };
    if (!isDirty()) return { ok: true, field };
    return { ok: await persist(), field };
  };

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const { ok, field } = await commitAndSave();
      if (!ok) {
        refocus(field);
        return;
      }
      if (mode === 'close') desk.close(winId);
      else if (mode === 'new') {
        await startNew(formRef.current.bankId);
        focusEmployee();
      } else refocus(field);
    } finally {
      busy.current = false;
    }
  };

  const askSave = async (quiet = false): Promise<boolean> => {
    const field = commitActiveField({ quiet });
    if (!quiet && !(await settleQuickFill())) return false;
    if (!isDirty()) return true;
    const i = await desk.messageBox('You have changed the paycheck. Do you want to save the changes?', {
      title: 'Recording Transaction',
      icon: 'question',
      buttons: ['&Yes', '&No', '&Cancel'],
      cancelButton: 2,
    });
    if (i === 1) return true;
    if (i === 0 && (await persist())) return true;
    refocus(field);
    return false;
  };

  const go = async (dir: 'prev' | 'next') => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      if (!(await askSave())) return;
      const id = txnIdRef.current;
      const adj = await api.get<{ prev: number | null; next: number | null }>(`/api/txns/adjacent?type=PAYCHECK&id=${id ?? ''}`);
      const target = dir === 'prev' ? adj.prev : adj.next;
      if (target !== null) {
        await load(target);
        focusEmployee();
      } else if (dir === 'next' && id !== null) {
        await startNew();
        focusEmployee();
      } else desk.setStatus(dir === 'prev' ? 'This is the first paycheck.' : 'This is the last paycheck.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const clearOrRevert = async () => {
    if (busy.current || loading) return;
    commitActiveField({ quiet: true });
    const id = txnIdRef.current;
    if (id === null) {
      const f = formRef.current;
      setForm({ ...newForm(f.bankId), num: f.num, toPrint: f.toPrint, date: f.date });
      markClean();
      copied.current = null;
      setError(null);
      focusEmployee();
      return;
    }
    if (isDirty() && !(await desk.confirm('Do you want to undo the changes you have made to this transaction?'))) return;
    busy.current = true;
    try {
      await load(id);
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    const id = txnIdRef.current;
    if (id === null || busy.current) return;
    if (!(await desk.confirm('Are you sure you want to delete this transaction?', { yes: '&OK', no: '&Cancel' }))) return;
    busy.current = true;
    try {
      await api.del(`/api/txns/${id}`);
      desk.setStatus('Paycheck deleted.');
      desk.refresh();
      await startNew(formRef.current.bankId);
      focusEmployee();
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const print = async () => {
    if (busy.current || loading) return;
    busy.current = true;
    let id: number | null = null;
    try {
      const { ok, field } = await commitAndSave();
      if (!ok) {
        refocus(field);
        return;
      }
      id = txnIdRef.current;
      if (id === null) setError('Fill in the paycheck first.');
    } finally {
      busy.current = false;
    }
    if (id !== null && !openPdf(id)) desk.setStatus('The browser blocked the new tab. Allow pop-ups for RapidBooks, then print again.');
  };

  const journal = () => {
    const id = txnIdRef.current;
    if (id === null) desk.setStatus('Save the paycheck first to see its transaction journal.');
    else desk.open('txnjournal', { txnId: id });
  };
  const openRegister = () => {
    const bank = formRef.current.bankId;
    if (bank !== null) desk.open('register', { accountId: bank });
    else desk.setStatus('Choose a bank account first.');
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    saveNew: () => void save('new'),
    new: () => {
      if (busy.current) return;
      busy.current = true;
      void askSave()
        .then(async (ok) => {
          if (!ok) return;
          await startNew();
          focusEmployee();
        })
        .finally(() => (busy.current = false));
    },
    delete: txnId !== null ? () => void remove() : undefined,
    insertLine: () => grids[curGrid.current].current?.insertLine(),
    deleteLine: () => grids[curGrid.current].current?.deleteLine(),
    register: openRegister,
    print: () => void print(),
    txnJournal: journal,
    confirmClose: () => (loading ? true : askSave(true)),
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || loading) return;
    const act: Record<string, (() => void) | undefined> = {
      KeyP: () => void go('prev'),
      KeyX: () => void go('next'),
      KeyD: () => setToPrint(!formRef.current.toPrint),
    };
    const fn = act[e.code];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const employeeOptions = useMemo(() => {
    const cur = form.employeeId;
    return (employees ?? []).filter((n) => !n.inactive || n.id === cur).map((n) => ({ id: n.id, label: n.full_name }));
  }, [employees, form.employeeId]);
  const banks = useMemo(() => bankOptions(accounts, form.bankId), [accounts, form.bankId]);
  const dis = loading;
  const grid = (s: (typeof SECTIONS)[number]) => (
    <PayGrid
      ref={grids[s.key]}
      kind={s.kind}
      title={s.title}
      rows={form[s.key]}
      setRows={(fn) => {
        setError(null);
        setForm((f) => ({ ...f, [s.key]: fn(f[s.key]) }));
      }}
      items={payItems}
      ytd={ytd}
      minRows={s.rows}
      disabled={dis}
      onFocusGrid={() => (curGrid.current = s.key)}
    />
  );

  return (
    <div className="form-window bk-form" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="form-toolbar">
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('prev')} title="Alt+P">
          <Mnemonic label="&Previous" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void go('next')} title="Alt+X">
          <Mnemonic label="Ne&xt" />
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={() => void print()} title="Ctrl+P">
          Print
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || txnId === null} onClick={journal} title="Ctrl+Y">
          Journal
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || form.bankId === null} onClick={openRegister} title="Ctrl+R">
          Register
        </button>
      </div>

      {error && <div className="msg-strip error">{error}</div>}

      <div className="bk-payhead">
        <label className="stack">
          Employee
          <Combo
            data-field="employee"
            options={employeeOptions}
            value={form.employeeId}
            onChange={(id) => void chooseEmployee(id)}
            disabled={dis}
            {...nameQuickFill(desk, 'employee')}
          />
        </label>
        <label className="stack">
          Bank Account
          <Combo
            options={banks}
            value={form.bankId}
            onChange={chooseBank}
            disabled={dis}
            {...accountQuickFill(desk, { type: 'BANK' })}
          />
        </label>
        <div className="stack bk-endbal">
          <span>&nbsp;</span>
          <EndingBalance accounts={accounts} id={form.bankId} />
        </div>
        <label className="stack">
          Check Date
          <DateField value={form.date} disabled={dis} onChange={(date) => set({ date })} />
        </label>
        <label className="stack">
          Check No.
          <input
            ref={numRef}
            className="field num-field"
            value={form.toPrint ? 'To Print' : form.num}
            readOnly={form.toPrint}
            maxLength={20}
            disabled={dis}
            onChange={(e) => set({ num: e.target.value })}
            onFocus={(e) => e.target.select()}
            onBlur={checkNum}
          />
        </label>
        <label className="check bk-toprint">
          <input type="checkbox" checked={form.toPrint} disabled={dis} onChange={(e) => setToPrint(e.target.checked)} />
          <Mnemonic label="To be printe&d" />
        </label>
        <div className="stack">
          Pay Period
          <span className="inline-fields">
            <DateField value={form.periodFrom} allowEmpty disabled={dis} aria-label="Pay period from" onChange={(periodFrom) => set({ periodFrom })} />
            <span>to</span>
            <DateField value={form.periodTo} allowEmpty disabled={dis} aria-label="Pay period to" onChange={(periodTo) => set({ periodTo })} />
          </span>
        </div>
        <label className="stack bk-paymemo">
          Memo
          <input className="field" value={form.memo} disabled={dis} onChange={(e) => set({ memo: e.target.value })} />
        </label>
        <label className="stack bk-payaddr">
          Address
          <textarea className="field addr-box" rows={3} value={form.address} disabled={dis} onChange={(e) => set({ address: e.target.value })} />
        </label>
      </div>

      {grid(SECTIONS[0])}
      <div className="bk-paycols">
        {grid(SECTIONS[1])}
        {grid(SECTIONS[2])}
      </div>

      <div className="bk-payfoot">
        <table className="sf-totals">
          <tbody>
            <tr>
              <th>Gross Pay</th>
              <td>{formatMoney(gross)}</td>
            </tr>
            <tr>
              <th>Deductions</th>
              <td>{formatMoney(-deductions)}</td>
            </tr>
            <tr>
              <th>Net Pay</th>
              <td className={`total bk-net${net < 0 ? ' unbalanced' : ''}`}>{formatMoney(net)}</td>
            </tr>
          </tbody>
        </table>
        <table className="sf-totals">
          <tbody>
            <tr>
              <th>Company Contributions</th>
              <td>{formatMoney(company)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="button-row">
        <span className="spacer" />
        <button type="button" className="btn default" disabled={dis} onClick={() => void save('close')} title="Alt+S">
          <Mnemonic label="&Save && Close" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void save('new')} title="Alt+N">
          <Mnemonic label="Save && &New" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void clearOrRevert()}>
          {txnId === null ? 'Clear' : 'Revert'}
        </button>
      </div>
    </div>
  );
}
