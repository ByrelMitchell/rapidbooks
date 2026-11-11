import { DATE_PRESETS, todayIso, type Account, type Report, type ReportColumn, type ReportDef, type ReportRow } from '@rapidbooks/shared';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { openTxn } from '../forms/openTxn';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic } from '../util';
import { openReport } from './open';
import { printWindowOf } from './print';
import {
  columnAlign,
  csvFileName,
  fillRequired,
  formatCell,
  hasAsOf,
  hasDateRange,
  mergeParams,
  MEMORIZED_KEY,
  missingRequired,
  parseMemorized,
  reportUrl,
  shownRange,
  withDate,
  withParam,
  withPreset,
  type MemorizedReport,
  type ReportParams,
} from './reportQuery';
import { useReportDefs } from './reportsMenu';
import './reports.css';

const DEBOUNCE_MS = 350;

/** Rows the highlight can rest on (blank rows are only spacing). */
const navigable = (r: ReportRow | undefined) => !!r && r.kind !== 'blank';

function nextRow(rows: ReportRow[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (navigable(rows[i])) return i;
  return -1;
}

/** The nearest navigable row at or after `i` (or before it, at the end of the report). */
function nearestRow(rows: ReportRow[], i: number, dir: 1 | -1): number {
  const at = Math.max(0, Math.min(rows.length - 1, i));
  if (navigable(rows[at])) return at;
  const a = nextRow(rows, at, dir);
  return a >= 0 ? a : nextRow(rows, at, dir === 1 ? -1 : 1);
}

const isNumeric = (c: ReportColumn) => c.kind === 'money' || c.kind === 'qty' || c.kind === 'percent';

/**
 * The cells of one row. The label of a header / subtotal / total row runs on over the empty
 * cells after it (as QuickBooks prints "Total Checking" across the columns), and the label
 * column is indented by the row's depth.
 */
function rowCells(r: ReportRow, cols: ReportColumn[], labelIdx: number): ReactNode[] {
  const texts = cols.map((c) => formatCell(c, r.cells[c.key]));
  const out: ReactNode[] = [];
  for (let j = 0; j < cols.length; j++) {
    const c = cols[j];
    let span = 1;
    if (r.kind !== 'data' && texts[j] !== '' && !isNumeric(c)) {
      while (j + span < cols.length && texts[j + span] === '') span++;
    }
    const numeric = isNumeric(c);
    const indent = j === labelIdx && r.depth > 0 ? { paddingLeft: `${0.375 + r.depth * 1.25}em` } : undefined;
    out.push(
      <td
        key={c.key}
        colSpan={span > 1 ? span : undefined}
        className={`al-${span > 1 ? 'left' : columnAlign(c)}${numeric ? ' num' : ''}${numeric && texts[j] !== '' ? ' has-v' : ''}`}
        style={indent}
      >
        {r.kind === 'blank' && j === 0 ? ' ' : texts[j]}
      </td>,
    );
    j += span - 1;
  }
  return out;
}

/** Open what a row's QuickZoom points at: its transaction, or a report in a new window. */
export function drillRow(desk: ReturnType<typeof useDesktop>, r: ReportRow | undefined) {
  const d = r?.drill;
  if (!d) return;
  if ('txn' in d) openTxn(desk, d.txn.type, d.txn.id);
  else openReport(desk, d.report, d.params);
}

/**
 * The one report viewer. Props: { id, params? (laid over the report's defaults), title? }.
 * Header bar: Modify Report, Memorize, Print, Export, Refresh; the dates (or As of) and the
 * report's choices inline. Up/Down/PageUp/PageDown/Home/End move the highlight, Enter or a
 * double-click QuickZooms.
 */
export function ReportWindow({ winId, props }: WinProps) {
  const desk = useDesktop();
  const id = props.id as string;
  const { data: defs, error: defsError } = useReportDefs();
  const def: ReportDef | undefined = defs?.find((d) => d.id === id);
  const { data: company } = useData<Record<string, string>>('/api/company');
  const today = todayIso();

  const needsAccounts = !!def?.params.some((p) => p.kind === 'account_id' && p.required);
  const { data: accounts } = useData<Account[]>(needsAccounts ? '/api/accounts' : null);

  const [params, setParams] = useState<ReportParams | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [cur, setCur] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const fetched = useRef(false);

  // The parameters it opens with: the report's defaults with the given ones on top.
  useEffect(() => {
    if (def && params === null) setParams(mergeParams(def, props.params as ReportParams | undefined));
  }, [def, params]);

  // A required account (the bank account of Cleared and Uncleared): the first one that fits.
  useEffect(() => {
    if (!def || !params || missingRequired(def, params).length === 0 || !accounts) return;
    const filled = fillRequired(def, params, { accounts });
    if (filled !== params) setParams(filled);
  }, [def, params, accounts]);

  const missing = def && params ? missingRequired(def, params) : [];
  const url = def && params && missing.length === 0 ? reportUrl(def, params) : null;

  // Fetch (debounced after the first time); the old report stays up while the new one loads.
  useEffect(() => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(
      () => {
        api.get<Report>(url).then(
          (r) => {
            if (my !== seq.current) return;
            setReport(r);
            setError(null);
            setLoading(false);
          },
          (e) => {
            if (my !== seq.current) return;
            setError(errorMessage(e));
            setLoading(false);
          },
        );
      },
      fetched.current ? DEBOUNCE_MS : 0,
    );
    fetched.current = true;
    return () => clearTimeout(t);
  }, [url, desk.dataVersion, tick]);

  const title = (props.title as string | undefined) ?? report?.title ?? def?.title ?? 'Report';
  useEffect(() => {
    desk.setTitle(winId, title);
  }, [title, winId]);

  const rows = report?.rows ?? [];

  // Keep the highlight on a real row as reports load (the first row the first time).
  useEffect(() => {
    if (!report) return;
    setCur((c) => (rows.length === 0 ? -1 : c < 0 ? nearestRow(rows, 0, 1) : nearestRow(rows, c, 1)));
  }, [report]);

  // Focus starts in the report so the arrow keys work at once.
  useEffect(() => {
    scrollRef.current?.focus();
  }, []);

  // Keep the highlighted row in view below the sticky column headings.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || cur < 0) return;
    const tr = box.querySelector<HTMLElement>(`tbody tr[data-i="${cur}"]`);
    if (!tr) return;
    const b = box.getBoundingClientRect();
    const r = tr.getBoundingClientRect();
    const headH = box.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    if (r.top < b.top + headH) box.scrollTop -= b.top + headH - r.top;
    else if (r.bottom > b.top + box.clientHeight) box.scrollTop += r.bottom - (b.top + box.clientHeight);
  }, [cur]);

  const pageSize = () => {
    const box = scrollRef.current;
    const tr = box?.querySelector<HTMLElement>('tbody tr');
    if (!box || !tr) return 10;
    const headH = box.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    return Math.max(1, Math.floor((box.clientHeight - headH) / (tr.getBoundingClientRect().height || 1)) - 1);
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || rows.length === 0) return;
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = cur < 0 ? nearestRow(rows, 0, 1) : nextRow(rows, cur, 1);
        break;
      case 'ArrowUp':
        next = cur < 0 ? nearestRow(rows, 0, 1) : nextRow(rows, cur, -1);
        break;
      case 'Home':
        next = nearestRow(rows, 0, 1);
        break;
      case 'End':
        next = nearestRow(rows, rows.length - 1, -1);
        break;
      case 'PageDown':
        next = nearestRow(rows, Math.max(cur, 0) + pageSize(), 1);
        break;
      case 'PageUp':
        next = nearestRow(rows, Math.max(cur, 0) - pageSize(), -1);
        break;
      case 'Enter':
        e.preventDefault();
        drillRow(desk, rows[cur]);
        return;
      default:
        return; // Left/Right scroll the report sideways (the browser's own handling)
    }
    e.preventDefault();
    if (next >= 0) setCur(next);
  };

  // ---- Header bar actions

  const modify = async () => {
    if (!def || !params) return;
    commitActiveField();
    const next = await desk.openForResult<ReportParams>('modifyreport', { id: def.id, params });
    if (next) setParams(next);
  };

  const wide = () => {
    const table = scrollRef.current?.querySelector('table');
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return (report?.columns.length ?? 0) > 8 || (!!table && table.offsetWidth / rem > 52);
  };
  const print = () => {
    if (!report) return;
    commitActiveField();
    printWindowOf(rootRef.current, { landscape: wide() });
  };

  const exportCsv = async () => {
    if (!def || !params || missing.length) return;
    commitActiveField();
    const name = csvFileName(def, title, params, today);
    try {
      const res = await fetch(reportUrl(def, params, { csv: true }));
      if (!res.ok) {
        let msg = `The server returned an error (${res.status}).`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          // not JSON
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
      desk.setStatus(`Exported "${name}".`);
    } catch (e) {
      setError(e instanceof TypeError ? 'RapidBooks cannot reach its server. Check that the server is running and try again.' : errorMessage(e));
    }
  };

  const memorize = async () => {
    if (!def || !params) return;
    commitActiveField();
    const name = await desk.openForResult<string>('memorize', { name: title });
    if (!name) return;
    try {
      const info = await api.get<Record<string, string>>('/api/company');
      const list = parseMemorized(info[MEMORIZED_KEY]);
      const i = list.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
      if (i >= 0 && !(await desk.confirm(`There is already a memorized report named "${list[i].name}". Replace it?`, { title: 'Memorize Report' })))
        return;
      const entry: MemorizedReport = { name, report_id: def.id, params };
      const next = i >= 0 ? list.map((m, j) => (j === i ? entry : m)) : [...list, entry];
      await api.put('/api/company', { [MEMORIZED_KEY]: JSON.stringify(next) });
      desk.refresh();
      desk.setStatus(`Report memorized as "${name}".`);
    } catch (e) {
      await desk.alert(errorMessage(e));
    }
  };

  const refresh = () => setTick((t) => t + 1);

  useWindowCommands(winId, { print });

  // Window Alt keys (letters no menu uses): Modify, Memorize, Print, Export, Dates.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const act: Record<string, (() => void) | undefined> = {
      KeyM: () => void modify(),
      KeyZ: () => void memorize(),
      KeyP: print,
      KeyX: () => void exportCsv(),
      KeyD: () => rootRef.current?.querySelector<HTMLElement>('[data-dates]')?.focus(),
      KeyG: refresh,
    };
    const fn = act[e.code];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  // ---- Header bar parameters

  const set = (p: ReportParams) => setParams(p);
  const range = params && def && hasDateRange(def) ? shownRange(params, today) : null;
  const bar = def && params && (
    <div className="rpt-params">
      {hasDateRange(def) && range && (
        <>
          <label>
            <Mnemonic label="&Dates" />
            <select
              className="field rpt-preset"
              data-dates
              value={params.date ?? 'custom'}
              onChange={(e) => set(withPreset(params, e.target.value, today))}
            >
              {DATE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <DateField value={range.from} allowEmpty onChange={(iso) => set(withDate(params, 'from', iso, today))} />
          </label>
          <label>
            To
            <DateField value={range.to} allowEmpty onChange={(iso) => set(withDate(params, 'to', iso, today))} />
          </label>
        </>
      )}
      {hasAsOf(def) && (
        <label>
          <Mnemonic label="As of" />
          <DateField data-dates value={params.as_of || today} onChange={(iso) => set(withParam(params, 'as_of', iso))} />
        </label>
      )}
      {def.params.map((p) => {
        if (p.kind === 'enum')
          return (
            <label key={p.key}>
              {p.label}
              <select className="field rpt-enum" value={params[p.key] ?? String(p.default)} onChange={(e) => set(withParam(params, p.key, e.target.value))}>
                {(p.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        if (p.kind === 'boolean')
          return (
            <label key={p.key} className="check">
              <input type="checkbox" checked={params[p.key] === 'true'} onChange={(e) => set(withParam(params, p.key, e.target.checked ? 'true' : 'false'))} />
              {p.label}
            </label>
          );
        if (p.kind === 'account_id' && p.required)
          return (
            <label key={p.key}>
              {p.label}
              <span className="rpt-combo">
                <Combo
                  options={(accounts ?? [])
                    .filter((a) => (!p.account_types || p.account_types.includes(a.type)) && (!a.inactive || String(a.id) === params[p.key]))
                    .map((a) => ({ id: a.id, label: a.full_name }))}
                  value={params[p.key] ? Number(params[p.key]) : null}
                  onChange={(v) => v !== null && set(withParam(params, p.key, String(v)))}
                  listName="Account"
                  aria-label={p.label}
                />
              </span>
            </label>
          );
        return null;
      })}
      <span className="rpt-loading" aria-live="polite">
        {loading ? 'Loading...' : ''}
      </span>
    </div>
  );

  const shownError = defsError ?? (defs && !def ? 'There is no such report.' : null) ?? error;
  const cols = report?.columns ?? [];
  const labelIdx = Math.max(0, cols.findIndex((c) => c.kind === 'text'));

  return (
    <div className="rpt-window rpt-resizable" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="rpt-bar no-print">
        <div className="rpt-buttons">
          <button type="button" className="btn" disabled={!def} onClick={() => void modify()} title="Alt+M">
            <Mnemonic label="&Modify Report..." />
          </button>
          <button type="button" className="btn" disabled={!def} onClick={() => void memorize()} title="Alt+Z">
            <Mnemonic label="Memori&ze..." />
          </button>
          <button type="button" className="btn" disabled={!report} onClick={print} title="Ctrl+P">
            <Mnemonic label="&Print..." />
          </button>
          <button type="button" className="btn" disabled={!def || missing.length > 0} onClick={() => void exportCsv()} title="Alt+X">
            <Mnemonic label="E&xport..." />
          </button>
          <button type="button" className="btn" disabled={!url} onClick={refresh} title="Alt+G">
            Refresh
          </button>
        </div>
        {bar}
      </div>
      {shownError && <div className="msg-strip error no-print">{shownError}</div>}
      {missing.length > 0 && !shownError && (
        <div className="msg-strip no-print">Choose the {missing.map((m) => m.label.toLowerCase()).join(' and ')} for this report.</div>
      )}
      <div className={`rpt-page${loading ? ' rpt-stale' : ''}`}>
        <div className="rpt-titles">
          {company?.name && <div className="rpt-company">{company.name}</div>}
          <div className="rpt-title">{report?.title ?? def?.title ?? ''}</div>
          <div className="rpt-subtitle">{report?.subtitle ?? (report ? '' : loading || !defs ? 'Loading...' : '')}</div>
        </div>
        <div className="rpt-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onGridKey} role="grid" aria-label={title}>
          {report && (
            <table className="rpt-table">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c.key} className={`al-${columnAlign(c)}`}>
                      {c.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    data-i={i}
                    className={`rpt-${r.kind}${r.drill ? ' rpt-drill' : ''}${i === cur ? ' sel' : ''}`}
                    onMouseDown={() => navigable(r) && setCur(i)}
                    onDoubleClick={() => drillRow(desk, r)}
                  >
                    {rowCells(r, cols, labelIdx)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report && rows.length === 0 && <div className="rpt-empty">There are no transactions for this report.</div>}
        </div>
      </div>
    </div>
  );
}
