import { formatMoney, todayIso, type Account, type Txn, type TxnInput } from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';

interface Line {
  key: number;
  accountId: number | null;
  debit: number | null;
  credit: number | null;
  memo: string;
}
interface Form {
  date: string;
  num: string;
  lines: Line[];
}
type Col = 'account' | 'debit' | 'credit' | 'memo';
const START_ROWS = 8;

let lineSeq = 0;
const blankLine = (): Line => ({ key: ++lineSeq, accountId: null, debit: null, credit: null, memo: '' });
const isBlank = (l: Line) => l.accountId === null && l.debit === null && l.credit === null && l.memo.trim() === '';
const blankLines = (n: number) => Array.from({ length: n }, blankLine);

/** Always keep at least one blank row at the end of the grid. */
function withTrailingBlank(lines: Line[]): Line[] {
  if (lines.length === 0 || !isBlank(lines[lines.length - 1])) return [...lines, blankLine()];
  return lines;
}

/** What counts for "unsaved changes": everything but blank rows and row identity. */
function serialize(f: Form): string {
  return JSON.stringify({
    date: f.date,
    num: f.num,
    lines: f.lines.filter((l) => !isBlank(l)).map(({ key: _k, ...rest }) => rest),
  });
}

const newForm = (num = ''): Form => ({ date: todayIso(), num, lines: blankLines(START_ROWS) });

export function JournalEntry({ winId, props }: WinProps) {
  const propId = (props.id as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const [form, setForm, formRef] = useLiveState<Form>(() => newForm());
  const [txnId, setTxnId, txnIdRef] = useLiveState<number | null>(propId);
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(propId !== null);
  const saving = useRef(false);
  const curRow = useRef(0);
  const focusReq = useRef<{ row: number; col: Col } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;

  /** Start a blank entry with the next entry number. */
  const startNew = async () => {
    const f = newForm();
    setForm(f);
    snapshot.current = serialize(f);
    setTxnId(null);
    version.current = undefined;
    setError(null);
    curRow.current = 0;
    try {
      const { num } = await api.get<{ num: string }>('/api/txns/next-num?type=GENJRNL');
      // Only fill it in if nothing has been typed yet.
      if (formRef.current.num === '' && txnIdRef.current === null) {
        const untouched = !isDirty();
        setForm((cur) => ({ ...cur, num }));
        if (untouched) snapshot.current = serialize(formRef.current);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // Load the entry (once; edits made elsewhere are caught by the version check on save).
  useEffect(() => {
    if (propId === null) {
      void startNew();
      return;
    }
    let cancelled = false;
    api.get<Txn>(`/api/txns/${propId}`).then(
      (t) => {
        if (cancelled) return;
        const lines = t.splits.map(
          (s): Line => ({
            key: ++lineSeq,
            accountId: s.account_id,
            debit: s.amount > 0 ? s.amount : null,
            credit: s.amount < 0 ? -s.amount : null,
            memo: s.memo,
          }),
        );
        while (lines.length < START_ROWS) lines.push(blankLine());
        const f: Form = { date: t.date, num: t.num, lines: withTrailingBlank(lines) };
        setForm(f);
        snapshot.current = serialize(f);
        version.current = t.version;
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [propId]);

  // Put focus where a row operation asked for it, once the grid has re-rendered.
  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${req.row}"][data-col="${req.col}"]`)?.focus();
  });

  // Account list: active accounts, plus inactive ones this entry already uses.
  const options = useMemo(() => {
    const used = new Set(form.lines.map((l) => l.accountId));
    return (accounts ?? []).filter((a) => !a.inactive || used.has(a.id)).map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, form.lines]);

  const editLine = (i: number, change: (l: Line, lines: Line[]) => Line) => {
    setError(null);
    setForm((f) => {
      const lines = [...f.lines];
      lines[i] = change({ ...lines[i] }, lines);
      return { ...f, lines: withTrailingBlank(lines) };
    });
  };

  const setAccount = (i: number, accountId: number | null) =>
    editLine(i, (l, lines) => {
      l.accountId = accountId;
      // QuickBooks fills in the amount that brings the entry back into balance.
      if (accountId !== null && l.debit === null && l.credit === null) {
        const diff = lines.reduce((t, x, j) => (j === i ? t : t + (x.debit ?? 0) - (x.credit ?? 0)), 0);
        if (diff > 0) l.credit = diff;
        else if (diff < 0) l.debit = -diff;
      }
      return l;
    });

  const setAmount = (i: number, side: 'debit' | 'credit', v: number | null) =>
    editLine(i, (l) => {
      const other = side === 'debit' ? 'credit' : 'debit';
      if (v !== null && v < 0) {
        // A negative amount belongs on the other side.
        l[other] = -v;
        l[side] = null;
      } else {
        l[side] = v;
        if (v !== null) l[other] = null;
      }
      return l;
    });

  const insertLine = () => {
    commitActiveField();
    const i = Math.min(curRow.current, formRef.current.lines.length - 1);
    setForm((f) => {
      const lines = [...f.lines];
      lines.splice(i, 0, blankLine());
      return { ...f, lines };
    });
    focusReq.current = { row: i, col: 'account' };
  };

  const deleteLine = () => {
    commitActiveField();
    const i = Math.min(curRow.current, formRef.current.lines.length - 1);
    setForm((f) => {
      const lines = f.lines.filter((_, j) => j !== i);
      return { ...f, lines: withTrailingBlank(lines) };
    });
    focusReq.current = { row: Math.min(i, formRef.current.lines.length - 1), col: 'account' };
  };

  const save = async (mode: 'stay' | 'close' | 'new') => {
    if (saving.current || loading) return;
    const field = commitActiveField();
    const f = formRef.current;
    const id = txnIdRef.current;

    // A blank new entry: nothing to save.
    if (id === null && !isDirty()) {
      if (mode === 'close') desk.close(winId);
      else if (mode === 'stay') refocus(field);
      else dateRef.current?.focus();
      return;
    }

    if (f.lines.some((l) => l.accountId === null && ((l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0))) {
      setError('Every line with an amount needs an account.');
      refocus(field);
      return;
    }
    const body: TxnInput = {
      type: 'GENJRNL',
      date: f.date,
      num: f.num.trim(),
      name_id: null,
      memo: '',
      splits: f.lines
        .filter((l) => l.accountId !== null)
        .map((l) => ({ account_id: l.accountId!, amount: (l.debit ?? 0) - (l.credit ?? 0), name_id: null, memo: l.memo })),
      ...(id !== null ? { version: version.current } : {}),
    };

    saving.current = true;
    try {
      const r =
        id === null
          ? await api.post<{ id: number; version: number }>('/api/txns', body)
          : await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      desk.refresh();
      desk.setStatus(`General journal entry ${body.num ? `${body.num} ` : ''}saved.`);
      setError(null);
      if (mode === 'close') {
        desk.close(winId);
      } else if (mode === 'new') {
        if (propId !== null) {
          // This window belongs to an existing entry; the new one gets its own window.
          desk.close(winId);
          desk.open('journal', { id: null });
        } else {
          await startNew();
          dateRef.current?.focus();
        }
      } else {
        setTxnId(r.id);
        version.current = r.version;
        snapshot.current = serialize(f);
        refocus(field);
      }
    } catch (e) {
      setError(errorMessage(e));
      refocus(field);
    } finally {
      saving.current = false;
    }
  };

  const clear = () => {
    const f: Form = { ...formRef.current, lines: blankLines(START_ROWS) };
    setForm(f);
    setError(null);
    curRow.current = 0;
    focusReq.current = { row: 0, col: 'account' };
  };

  const remove = async () => {
    const id = txnIdRef.current;
    if (id === null) return;
    if (!window.confirm('Are you sure you want to delete this transaction?')) return;
    try {
      await api.del(`/api/txns/${id}`);
      desk.setStatus('General journal entry deleted.');
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const confirmClose = () => {
    const field = commitActiveField();
    if (!isDirty()) return true;
    if (window.confirm('This journal entry has changes that have not been saved. Do you want to discard changes?')) return true;
    refocus(field);
    return false;
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    saveNew: () => void save('new'),
    insertLine,
    deleteLine,
    new: () => {
      if (propId !== null) {
        desk.open('journal', { id: null });
        return;
      }
      if (!confirmClose()) return;
      void startNew().then(() => dateRef.current?.focus());
    },
    delete: txnId !== null ? () => void remove() : undefined,
    confirmClose,
  });

  // Up/Down move between rows in the same column (when no dropdown is using them).
  const onGridKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    const row = Number(t.dataset.row);
    const col = t.dataset.col as Col | undefined;
    if (!col || Number.isNaN(row)) return;
    const next = row + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0 || next >= form.lines.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-col="${col}"]`)?.focus();
  };

  const totalDebit = form.lines.reduce((t, l) => t + (l.debit ?? 0), 0);
  const totalCredit = form.lines.reduce((t, l) => t + (l.credit ?? 0), 0);

  return (
    <div className="form-window" ref={rootRef}>
      <div className="form-header">
        <label>
          Date
          <DateField
            ref={dateRef}
            value={form.date}
            onChange={(date) => setForm((f) => ({ ...f, date }))}
            disabled={loading}
          />
        </label>
        <label>
          Entry No.
          <input
            className="field num-field"
            value={form.num}
            maxLength={20}
            disabled={loading}
            onChange={(e) => {
              const num = e.target.value;
              setForm((f) => ({ ...f, num }));
            }}
            onFocus={(e) => e.target.select()}
          />
        </label>
      </div>
      {error && <div className="msg-strip error">{error}</div>}
      <div className="grid-wrap">
        <table className="line-grid">
          <colgroup>
            <col style={{ width: '38%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '15%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Account</th>
              <th className="al-right">Debit</th>
              <th className="al-right">Credit</th>
              <th>Memo</th>
            </tr>
          </thead>
          <tbody onKeyDown={onGridKey}>
            {form.lines.map((l, i) => (
              <tr key={l.key} onFocus={() => (curRow.current = i)}>
                <td>
                  <Combo
                    options={options}
                    value={l.accountId}
                    onChange={(id) => setAccount(i, id)}
                    data-row={i}
                    data-col="account"
                    aria-label={`Account, line ${i + 1}`}
                    disabled={loading}
                  />
                </td>
                <td>
                  <AmountField
                    value={l.debit}
                    onChange={(v) => setAmount(i, 'debit', v)}
                    data-row={i}
                    data-col="debit"
                    aria-label={`Debit, line ${i + 1}`}
                    disabled={loading}
                  />
                </td>
                <td>
                  <AmountField
                    value={l.credit}
                    onChange={(v) => setAmount(i, 'credit', v)}
                    data-row={i}
                    data-col="credit"
                    aria-label={`Credit, line ${i + 1}`}
                    disabled={loading}
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
                    onChange={(e) => {
                      const memo = e.target.value;
                      editLine(i, (x) => ({ ...x, memo }));
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="al-right total-label">Totals</td>
              <td className={`al-right total${totalDebit !== totalCredit ? ' unbalanced' : ''}`}>
                {formatMoney(totalDebit)}
              </td>
              <td className={`al-right total${totalDebit !== totalCredit ? ' unbalanced' : ''}`}>
                {formatMoney(totalCredit)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="button-row right">
        <button type="button" className="btn default" disabled={loading} onClick={() => void save('close')}>
          <Mnemonic label="&Save && Close" />
        </button>
        <button type="button" className="btn" disabled={loading} onClick={() => void save('new')}>
          <Mnemonic label="Save && &New" />
        </button>
        {txnId === null ? (
          <button type="button" className="btn" disabled={loading} onClick={clear}>
            Clear
          </button>
        ) : (
          <button type="button" className="btn" disabled={loading} onClick={() => void remove()} title="Ctrl+D">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

