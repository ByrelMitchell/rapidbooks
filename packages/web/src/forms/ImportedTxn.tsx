import { formatMoney, type Account, type GenJrnlInput, type Name, type Txn, type TxnLink } from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { accountQuickFill } from '../lists/quickAdd';
import { openQuickReport } from '../reports/open';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';
import { TXN_WINDOWS, txnLabel } from './openTxn';
import { anyNameQuickFill } from './receivablesShared';
import './sales.css';
import './receivables.css';

/** What GET /api/txns/:id adds for an imported transaction (and, for known types, its links). */
type ImportedTxnData = Txn & { links_in?: TxnLink[]; links_out?: TxnLink[] };

interface Line {
  key: number;
  accountId: number | null;
  debit: number | null;
  credit: number | null;
  memo: string;
  nameId: number | null;
}
interface Form {
  date: string;
  num: string;
  nameId: number | null;
  memo: string;
  lines: Line[];
}
type Col = 'account' | 'debit' | 'credit' | 'memo' | 'name';
const MIN_ROWS = 6;

let lineSeq = 0;
const blankLine = (): Line => ({ key: ++lineSeq, accountId: null, debit: null, credit: null, memo: '', nameId: null });
const isBlank = (l: Line) =>
  l.accountId === null && l.debit === null && l.credit === null && l.memo.trim() === '' && l.nameId === null;

function withTrailingBlank(lines: Line[]): Line[] {
  if (lines.length === 0 || !isBlank(lines[lines.length - 1])) return [...lines, blankLine()];
  return lines;
}

const amountOf = (l: Line) => (l.debit ?? 0) - (l.credit ?? 0);

function serialize(f: Form): string {
  return JSON.stringify({
    date: f.date,
    num: f.num,
    nameId: f.nameId,
    memo: f.memo,
    lines: f.lines.filter((l) => !isBlank(l)).map(({ key: _k, ...rest }) => rest),
  });
}

function formOf(t: Txn): Form {
  const lines = t.splits.map(
    (s): Line => ({
      key: ++lineSeq,
      accountId: s.account_id,
      debit: s.amount > 0 ? s.amount : null,
      credit: s.amount < 0 ? -s.amount : null,
      memo: s.memo,
      nameId: s.name_id,
    }),
  );
  while (lines.length < MIN_ROWS) lines.push(blankLine());
  return { date: t.date, num: t.num, nameId: t.name_id, memo: t.memo, lines: withTrailingBlank(lines) };
}

/**
 * A transaction brought over from QuickBooks exactly as QuickBooks posted it (import_locked),
 * or of a QuickBooks type RapidBooks has no form for ("Sales Receipt"). It is shown and
 * corrected as its debits and credits, like a general journal entry, and saved with
 * PUT /api/txns/:id as type GENJRNL (the server keeps the transaction's own type).
 * Props: { id }.
 */
export function ImportedTxn({ winId, props }: WinProps) {
  const id = props.id as number;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const { data: names } = useData<Name[]>('/api/names');
  const [txn, setTxn] = useState<ImportedTxnData | null>(null);
  const [form, setForm, formRef] = useLiveState<Form>(() => ({ date: '', num: '', nameId: null, memo: '', lines: [] }));
  const version = useRef<number | undefined>(undefined);
  const snapshot = useRef(serialize(form));
  // The splits as stored: a line keeps its cleared mark when its account and amount are unchanged.
  const [stored, setStored] = useState<Txn['splits']>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const curRow = useRef(0);
  const focusReq = useRef<{ row: number; col: Col } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const isDirty = () => serialize(formRef.current) !== snapshot.current;

  const apply = (t: ImportedTxnData) => {
    const f = formOf(t);
    setForm(f);
    snapshot.current = serialize(f);
    version.current = t.version;
    setStored(t.splits);
    setTxn(t);
    desk.setTitle(winId, `${t.import_locked || t.qb_type ? 'Imported ' : ''}${txnLabel(t)}`);
  };

  // Load once (edits made elsewhere are caught by the version check on save).
  useEffect(() => {
    let cancelled = false;
    api.get<ImportedTxnData>(`/api/txns/${id}`).then(
      (t) => {
        if (cancelled) return;
        // Not locked and RapidBooks has a form for it: the form is the right place.
        const kind = TXN_WINDOWS[t.type];
        if (!t.import_locked && kind) {
          desk.close(winId);
          desk.open(kind, t.type === 'BILLCREDIT' ? { id, credit: true } : { id });
          return;
        }
        apply(t);
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
  }, [id]);

  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${req.row}"][data-col="${req.col}"]`)?.focus();
  });

  const accountOptions = useMemo(() => {
    const used = new Set(form.lines.map((l) => l.accountId));
    return (accounts ?? []).filter((a) => !a.inactive || used.has(a.id)).map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, form.lines]);
  const nameOptions = useMemo(() => {
    const used = new Set([form.nameId, ...form.lines.map((l) => l.nameId)]);
    return (names ?? []).filter((n) => !n.inactive || used.has(n.id)).map((n) => ({ id: n.id, label: n.full_name }));
  }, [names, form.nameId, form.lines]);

  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };

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
      // As in a journal entry: a new line gets the amount that brings it back into balance.
      if (accountId !== null && l.debit === null && l.credit === null) {
        const diff = lines.reduce((t, x, j) => (j === i ? t : t + amountOf(x)), 0);
        if (diff > 0) l.credit = diff;
        else if (diff < 0) l.debit = -diff;
      }
      return l;
    });

  const setAmount = (i: number, side: 'debit' | 'credit', v: number | null) =>
    editLine(i, (l) => {
      const other = side === 'debit' ? 'credit' : 'debit';
      if (v !== null && v < 0) {
        l[other] = -v;
        l[side] = null;
      } else {
        l[side] = v;
        if (v !== null) l[other] = null;
      }
      return l;
    });

  const insertLine = () => {
    if (loading) return;
    commitActiveField();
    const i = Math.min(curRow.current, formRef.current.lines.length - 1);
    setForm((f) => {
      const lines = [...f.lines];
      lines.splice(Math.max(0, i), 0, blankLine());
      return { ...f, lines };
    });
    focusReq.current = { row: Math.max(0, i), col: 'account' };
  };

  const deleteLine = () => {
    if (loading) return;
    commitActiveField();
    const i = Math.min(curRow.current, formRef.current.lines.length - 1);
    setForm((f) => ({ ...f, lines: withTrailingBlank(f.lines.filter((_, j) => j !== i)) }));
    focusReq.current = { row: Math.max(0, Math.min(i, formRef.current.lines.length - 1)), col: 'account' };
  };

  /** Save the lines. True when saved (or nothing to save). */
  const persist = async (): Promise<boolean> => {
    const f = formRef.current;
    if (!isDirty()) return true;
    if (f.lines.some((l) => l.accountId === null && amountOf(l) !== 0)) {
      setError('Every line with an amount needs an account.');
      return false;
    }
    const lines = f.lines.filter((l) => l.accountId !== null);
    const debits = lines.reduce((t, l) => t + (l.debit ?? 0), 0);
    const credits = lines.reduce((t, l) => t + (l.credit ?? 0), 0);
    if (debits !== credits) {
      setError(`The debits (${formatMoney(debits)}) and credits (${formatMoney(credits)}) must be equal before it can be saved.`);
      return false;
    }
    // Saved as a journal entry; the server keeps the transaction's own type (Paycheck, Sales Receipt...).
    const body: GenJrnlInput = {
      type: 'GENJRNL',
      date: f.date,
      num: f.num.trim(),
      name_id: f.nameId,
      memo: f.memo,
      version: version.current,
      splits: lines.map((l) => ({ account_id: l.accountId!, amount: amountOf(l), name_id: l.nameId, memo: l.memo })),
    };
    try {
      const r = await api.put<{ id: number; version: number }>(`/api/txns/${id}`, body);
      version.current = r.version;
      snapshot.current = serialize(f);
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
    desk.refresh();
    setError(null);
    desk.setStatus(`${txnLabel({ ...txn!, num: body.num })} saved.`);
    // Read it back for the cleared marks the server kept (the save itself is done either way).
    try {
      apply(await api.get<ImportedTxnData>(`/api/txns/${id}`));
    } catch {
      // Shown as typed; the next save's version check still protects it.
    }
    return true;
  };

  const save = async (mode: 'stay' | 'close') => {
    if (busy.current || loading || !txn) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      if (!(await settleQuickFill())) return;
      if (await persist()) {
        if (mode === 'close') desk.close(winId);
        else refocus(field);
      } else refocus(field);
    } finally {
      busy.current = false;
    }
  };

  const revert = async () => {
    if (busy.current || loading || !txn) return;
    commitActiveField({ quiet: true });
    if (isDirty() && !(await desk.confirm('Do you want to undo the changes you have made to this transaction?'))) return;
    busy.current = true;
    try {
      apply(await api.get<ImportedTxnData>(`/api/txns/${id}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (busy.current || loading || !txn) return;
    const what = txnLabel(txn);
    if (
      !(await desk.confirm(
        `Are you sure you want to delete ${what}? It was brought over from QuickBooks; deleting it removes it from the books here (QuickBooks itself is not changed).`,
        { yes: '&OK', no: '&Cancel', defaultNo: true },
      ))
    )
      return;
    busy.current = true;
    try {
      await api.del(`/api/txns/${id}`);
      desk.setStatus(`${what} deleted.`);
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      busy.current = false;
    }
  };

  const confirmClose = async () => {
    if (loading) return true;
    const field = commitActiveField({ quiet: true });
    if (!isDirty()) return true;
    const i = await desk.messageBox('This transaction has changes that have not been saved. Do you want to save them?', {
      title: 'Save Changes',
      icon: 'question',
      buttons: ['&Yes', '&No', '&Cancel'],
      cancelButton: 2,
    });
    if (i === 1) return true;
    if (i === 0) {
      busy.current = true;
      try {
        if ((await settleQuickFill()) && (await persist())) return true;
      } finally {
        busy.current = false;
      }
    }
    refocus(field);
    return false;
  };

  const linkCount = (txn?.links_in?.length ?? 0) + (txn?.links_out?.length ?? 0);
  const hasLinks = linkCount > 0;
  const history = () => {
    if (hasLinks) desk.open('txnhistory', { txnId: id });
    else desk.setStatus('Nothing is linked to this transaction (no payments, credits or deposits).');
  };
  const journal = () => desk.open('txnjournal', { txnId: id });
  const currentAccount = () => {
    const lines = formRef.current.lines;
    return lines[Math.min(curRow.current, lines.length - 1)]?.accountId ?? lines.find((l) => l.accountId !== null)?.accountId ?? null;
  };

  useWindowCommands(winId, {
    save: () => void save('stay'),
    saveClose: () => void save('close'),
    insertLine,
    deleteLine,
    delete: txn ? () => void remove() : undefined,
    history: txn ? history : undefined,
    txnJournal: txn ? journal : undefined,
    register: txn
      ? () => {
          const a = currentAccount();
          if (a !== null) desk.open('register', { accountId: a });
        }
      : undefined,
    quickReport: () => {
      commitActiveField({ quiet: true });
      const n = formRef.current.nameId;
      if (n !== null) openQuickReport(desk, { name_id: n });
      else desk.setStatus('This transaction has no name for a QuickReport.');
    },
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
    if (next < 0 || next >= formRef.current.lines.length) return;
    e.preventDefault();
    rootRef.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-col="${col}"]`)?.focus();
  };

  const totalDebit = form.lines.reduce((t, l) => t + (l.debit ?? 0), 0);
  const totalCredit = form.lines.reduce((t, l) => t + (l.credit ?? 0), 0);
  const unbalanced = totalDebit !== totalCredit;
  const dis = loading || !txn;

  // Cleared (✓) is kept by the server for a line whose account and amount are unchanged at the same position.
  const clearedAt = (() => {
    const out = new Map<number, boolean>();
    let seq = 0;
    for (const l of form.lines) {
      if (l.accountId === null) continue;
      const s = stored[seq++];
      out.set(l.key, !!s && s.cleared && s.account_id === l.accountId && s.amount === amountOf(l));
    }
    return out;
  })();

  const qbType = txn ? txn.qb_type || txn.type : '';
  const note = txn?.import_note ? txn.import_note.charAt(0).toUpperCase() + txn.import_note.slice(1) : '';

  return (
    <div className="form-window imp-form" ref={rootRef}>
      <div className="form-toolbar">
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis || !hasLinks} onClick={history} title="Ctrl+H">
          History
        </button>
        <button type="button" className="btn tool" tabIndex={-1} disabled={dis} onClick={journal} title="Ctrl+Y">
          Journal
        </button>
        {txn && <span className="imp-flag">Imported from QuickBooks</span>}
      </div>

      {txn && (
        <div className="msg-strip imp-banner" role="note">
          <b>
            This {qbType.toLowerCase()} was brought over from QuickBooks exactly as QuickBooks posted it.
          </b>{' '}
          {TXN_WINDOWS[txn.type]
            ? `It opens here instead of in the ${qbType} form, because the form could not re-create it exactly. `
            : `RapidBooks has no ${qbType} form, so it is kept as QuickBooks' own debits and credits. `}
          Its lines can be corrected here; the books stay exactly as they are until you save.
          {note && (
            <>
              <br />
              <span className="imp-note">Reason: {note}.</span>
            </>
          )}
        </div>
      )}

      <div className="imp-head">
        <span className="imp-label">Type</span>
        <span className="readout imp-readout">{qbType || (loading ? 'Loading...' : '')}</span>
        <span className="imp-label">QuickBooks Trans #</span>
        <span className="readout imp-readout">{txn?.qb_trans_no ?? ''}</span>
        <label className="imp-label" htmlFor={`${winId}-date`}>
          Date
        </label>
        <DateField id={`${winId}-date`} value={form.date} onChange={(date) => set({ date })} disabled={dis} />
        <label className="imp-label" htmlFor={`${winId}-num`}>
          No.
        </label>
        <input
          id={`${winId}-num`}
          className="field num-field"
          value={form.num}
          maxLength={20}
          disabled={dis}
          onChange={(e) => set({ num: e.target.value })}
          onFocus={(e) => e.target.select()}
        />
        <label className="imp-label" htmlFor={`${winId}-name`}>
          Name
        </label>
        <div className="imp-wide">
          <Combo
            id={`${winId}-name`}
            options={nameOptions}
            value={form.nameId}
            onChange={(nameId) => set({ nameId })}
            disabled={dis}
            {...anyNameQuickFill(desk)}
          />
        </div>
        <label className="imp-label" htmlFor={`${winId}-memo`}>
          Memo
        </label>
        <input
          id={`${winId}-memo`}
          className="field imp-wide"
          value={form.memo}
          maxLength={200}
          disabled={dis}
          onChange={(e) => set({ memo: e.target.value })}
        />
      </div>

      {error && <div className="msg-strip error">{error}</div>}

      <div className="grid-wrap imp-grid">
        <table className="line-grid">
          <colgroup>
            <col style={{ width: '27%' }} />
            <col style={{ width: '7.5rem' }} />
            <col style={{ width: '7.5rem' }} />
            <col />
            <col style={{ width: '20%' }} />
            <col style={{ width: '2rem' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Account</th>
              <th className="al-right">Debit</th>
              <th className="al-right">Credit</th>
              <th>Memo</th>
              <th>Name</th>
              <th className="al-center" title="Cleared. Kept on a line whose account and amount are not changed.">
                ✓
              </th>
            </tr>
          </thead>
          <tbody onKeyDown={onGridKey}>
            {form.lines.map((l, i) => (
              <tr key={l.key} onFocus={() => (curRow.current = i)}>
                <td>
                  <Combo
                    options={accountOptions}
                    value={l.accountId}
                    onChange={(a) => setAccount(i, a)}
                    data-row={i}
                    data-col="account"
                    aria-label={`Account, line ${i + 1}`}
                    disabled={dis}
                    {...accountQuickFill(desk)}
                  />
                </td>
                <td>
                  <AmountField
                    value={l.debit}
                    onChange={(v) => setAmount(i, 'debit', v)}
                    data-row={i}
                    data-col="debit"
                    aria-label={`Debit, line ${i + 1}`}
                    disabled={dis}
                  />
                </td>
                <td>
                  <AmountField
                    value={l.credit}
                    onChange={(v) => setAmount(i, 'credit', v)}
                    data-row={i}
                    data-col="credit"
                    aria-label={`Credit, line ${i + 1}`}
                    disabled={dis}
                  />
                </td>
                <td>
                  <input
                    className="field"
                    value={l.memo}
                    data-row={i}
                    data-col="memo"
                    aria-label={`Memo, line ${i + 1}`}
                    disabled={dis}
                    onChange={(e) => {
                      const memo = e.target.value;
                      editLine(i, (x) => ({ ...x, memo }));
                    }}
                  />
                </td>
                <td>
                  <Combo
                    options={nameOptions}
                    value={l.nameId}
                    onChange={(nameId) => editLine(i, (x) => ({ ...x, nameId }))}
                    data-row={i}
                    data-col="name"
                    aria-label={`Name, line ${i + 1}`}
                    disabled={dis}
                    {...anyNameQuickFill(desk)}
                  />
                </td>
                <td className="cell-text al-center" aria-label={clearedAt.get(l.key) ? 'Cleared' : 'Not cleared'}>
                  {clearedAt.get(l.key) ? '✓' : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="al-right total-label">Totals</td>
              <td className={`al-right total${unbalanced ? ' unbalanced' : ''}`}>{formatMoney(totalDebit)}</td>
              <td className={`al-right total${unbalanced ? ' unbalanced' : ''}`}>{formatMoney(totalCredit)}</td>
              <td colSpan={3} className="error-text">
                {unbalanced ? 'Out of balance' : ''}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="button-row right">
        <button type="button" className="btn default" disabled={dis} onClick={() => void save('close')} title="Alt+S">
          <Mnemonic label="&Save && Close" />
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void save('stay')} title="Ctrl+Enter">
          Save
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void revert()}>
          Revert
        </button>
        <button type="button" className="btn" disabled={dis} onClick={() => void remove()} title="Ctrl+D">
          Delete
        </button>
      </div>
    </div>
  );
}
