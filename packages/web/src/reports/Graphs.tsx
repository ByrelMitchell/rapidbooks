import { DATE_PRESETS, formatMoney, todayIso, type GraphData, type Item, type Name, type SalesGraph } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, errorMessage, useData } from '../api';
import { DateField } from '../controls/DateField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic } from '../util';
import { openReport } from './open';
import { PickList } from './PickList';
import { printWindowOf } from './print';
import { incomeExpenseUrl, monthRange, salesGraphDrill, salesGraphUrl, shownRange, withDate, withPreset, type GraphQuery } from './reportQuery';
import './reports.css';

// Categorical hues in a fixed order (validated palette, light surface). Series 9 and 10 reuse
// hues 1-2 with a diagonal hatch so identity never rests on colour alone; "Other" is grey.
const HUES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#9a9893';
const fillFor = (i: number, id: number | null, name: string, prefix: string) => {
  if (id === null && name === 'Other') return OTHER;
  if (i < HUES.length) return HUES[i];
  return `url(#${prefix}-hatch-${i % HUES.length})`;
};
const swatchColor = (i: number, id: number | null, name: string) => {
  if (id === null && name === 'Other') return OTHER;
  const h = HUES[i % HUES.length];
  return i < HUES.length ? h : `repeating-linear-gradient(45deg, ${h} 0 3px, #fff 3px 6px)`;
};

/** Dollars for axes: $12,345 (whole dollars) or $1.2M. */
const axisDollars = (cents: number) => {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  return `${d < 0 ? '-' : ''}$${Math.round(Math.abs(d)).toLocaleString('en-US')}`;
};
const dollars = (cents: number) => `${cents < 0 ? '-' : ''}$${formatMoney(Math.abs(cents))}`;

function HatchDefs({ prefix }: { prefix: string }) {
  return (
    <defs>
      {HUES.map((h, i) => (
        <pattern key={i} id={`${prefix}-hatch-${i}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#fff" />
          <rect width="3" height="6" fill={h} />
        </pattern>
      ))}
    </defs>
  );
}

/** Dates bar shared by both graphs. */
function DatesBar({ q, setQ, children }: { q: GraphQuery; setQ: (q: GraphQuery) => void; children?: ReactNode }) {
  const today = todayIso();
  const r = shownRange({ ...q }, today);
  const asQ = (p: Record<string, string>): GraphQuery => ({ date: p.date ?? 'custom', from: p.from ?? '', to: p.to ?? '' });
  return (
    <div className="rpt-params">
      <label>
        <Mnemonic label="&Dates" />
        <select className="field rpt-preset" data-dates value={q.date} onChange={(e) => setQ(asQ(withPreset({ ...q }, e.target.value, today)))}>
          {DATE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        From
        <DateField value={r.from} allowEmpty onChange={(iso) => setQ(asQ(withDate({ ...q }, 'from', iso, today)))} />
      </label>
      <label>
        To
        <DateField value={r.to} allowEmpty onChange={(iso) => setQ(asQ(withDate({ ...q }, 'to', iso, today)))} />
      </label>
      {children}
    </div>
  );
}

/** Fetch a graph (debounced after the first time), keeping the old one up while loading. */
function useGraph<T>(url: string | null) {
  const desk = useDesktop();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(
      () =>
        api.get<T>(url).then(
          (d) => {
            if (my !== seq.current) return;
            setData(d);
            setError(null);
            setLoading(false);
          },
          (e) => {
            if (my !== seq.current) return;
            setError(errorMessage(e));
            setLoading(false);
          },
        ),
      first.current ? 0 : 350,
    );
    first.current = false;
    return () => clearTimeout(t);
  }, [url, desk.dataVersion]);
  return { data, error, loading };
}

/** Recharts has no double-click on bars: two clicks on the same bar within 400 ms count as one. */
function useDoubleClick() {
  const last = useRef<{ key: string; at: number } | null>(null);
  return (key: string, fn: () => void) => {
    const now = Date.now();
    if (last.current && last.current.key === key && now - last.current.at < 400) {
      last.current = null;
      fn();
    } else last.current = { key, at: now };
  };
}

interface LegendRow {
  name: string;
  id: number | null;
  value: number;
  color: string;
}

/** The legend table beside a chart: name, amount, percent. Up/Down move, Enter or double-click zooms. */
function LegendTable({ rows, total, onZoom }: { rows: LegendRow[]; total: number; onZoom: (r: LegendRow) => void }) {
  const [hot, setHot] = useState(0);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !rows.length) return;
    if (e.key === 'ArrowDown') setHot((h) => Math.min(rows.length - 1, h + 1));
    else if (e.key === 'ArrowUp') setHot((h) => Math.max(0, h - 1));
    else if (e.key === 'Enter') onZoom(rows[Math.min(hot, rows.length - 1)]);
    else return;
    e.preventDefault();
  };
  return (
    <div className="graph-legend" tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-label="Legend">
      <table>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.id}-${r.name}`} className={`${r.id !== null ? 'zoom' : ''}${i === hot ? ' sel' : ''}`} onMouseDown={() => setHot(i)} onDoubleClick={() => onZoom(r)}>
              <td>
                <span className="swatch" style={{ background: r.color }} />
              </td>
              <td style={{ width: '100%' }}>{r.name}</td>
              <td className="al-right">{dollars(r.value)}</td>
              <td className="al-right">{total ? `${((r.value / total) * 100).toFixed(1)}%` : ''}</td>
            </tr>
          ))}
          <tr>
            <td />
            <td>
              <b>Total</b>
            </td>
            <td className="al-right">
              <b>{dollars(total)}</b>
            </td>
            <td className="al-right">{total ? '100.0%' : ''}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const tooltipStyle = { fontSize: '0.875rem', border: '1px solid #808080' };

/** Reports > Sales Graph: sales by month stacked by customer or item, with the totals beside it. */
export function SalesGraphWindow({ winId }: WinProps) {
  const desk = useDesktop();
  const [q, setQ] = useState<GraphQuery>({ date: 'this_fiscal_year_to_date', from: '', to: '' });
  const [by, setBy] = useState<'customer' | 'item'>('customer');
  const [top, setTop] = useState(10);
  const [ids, setIds] = useState<{ customer: number[]; item: number[] }>({ customer: [], item: [] });
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dbl = useDoubleClick();
  const { data: customers } = useData<Name[]>(picking && by === 'customer' ? '/api/names?kind=customer' : null);
  const { data: items } = useData<Item[]>(picking && by === 'item' ? '/api/items' : null);

  const custom = q.date === 'custom';
  const valid = !custom || !q.from || !q.to || q.from <= q.to;
  const url = valid ? salesGraphUrl({ ...q, by, top, ids: ids[by] }) : null;
  const { data, error, loading } = useGraph<SalesGraph>(url);

  const chartRows = useMemo(
    () => (data ? data.labels.map((label, i) => ({ label, key: data.keys[i], ...Object.fromEntries(data.series.map((s, j) => [`s${j}`, s.values[i]])) })) : []),
    [data],
  );
  const legend: LegendRow[] = (data?.breakdown.labels ?? []).map((name, i) => ({
    name,
    id: data!.breakdown.ids[i],
    value: data!.breakdown.values[i],
    color: swatchColor(i, data!.breakdown.ids[i], name),
  }));

  const zoom = (id: number | null, name: string, range: { from: string; to: string }) => {
    if (id === null || !data) {
      desk.setStatus(`"${name}" groups several ${data?.by === 'item' ? 'items' : 'customers'}; there is no single report for it.`);
      return;
    }
    const d = salesGraphDrill(data.by, id, range);
    openReport(desk, d.report, d.params);
  };
  const whole = data ? { from: data.from, to: data.to } : { from: '', to: '' };

  const print = () => {
    commitActiveField();
    printWindowOf(rootRef.current, { landscape: true });
  };
  useWindowCommands(winId, { print });

  return (
    <div className="rpt-window rpt-resizable" ref={rootRef}>
      <div className="rpt-bar no-print">
        <div className="rpt-buttons">
          <button type="button" className="btn" onClick={print} title="Ctrl+P">
            Print...
          </button>
          <button type="button" className="btn" onClick={() => setPicking((p) => !p)}>
            {picking ? 'Hide List' : by === 'customer' ? 'Choose Customers...' : 'Choose Items...'}
          </button>
          <label className="check">
            <input type="radio" name={`${winId}-by`} checked={by === 'customer'} onChange={() => setBy('customer')} />
            By Customer
          </label>
          <label className="check">
            <input type="radio" name={`${winId}-by`} checked={by === 'item'} onChange={() => setBy('item')} />
            By Item
          </label>
          <label className="check">
            Top
            <input
              type="number"
              className="field small-num"
              min={1}
              max={50}
              value={top}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (n >= 1 && n <= 50) setTop(n);
              }}
            />
          </label>
        </div>
        <DatesBar q={q} setQ={setQ}>
          <span className="rpt-loading">{loading ? 'Loading...' : ''}</span>
        </DatesBar>
        {picking && (
          <div style={{ maxWidth: '30rem' }}>
            <PickList
              label={by === 'customer' ? 'Only these customers (none ticked = all)' : 'Only these items (none ticked = all)'}
              options={by === 'customer' ? (customers ?? []).map((c) => ({ id: c.id, label: c.full_name })) : (items ?? []).map((i) => ({ id: i.id, label: i.full_name }))}
              value={ids[by]}
              onChange={(v) => setIds((x) => ({ ...x, [by]: v }))}
            />
          </div>
        )}
      </div>
      {(error || !valid) && <div className="msg-strip error no-print">{error ?? 'The From date is after the To date.'}</div>}
      <div className="rpt-titles">
        <div className="rpt-title">Sales by {by === 'customer' ? 'Customer' : 'Item'}</div>
        <div className="rpt-subtitle">{data ? `${data.from} to ${data.to}`.replace(/(\d{4})-(\d\d)-(\d\d)/g, '$2/$3/$1') : ''}</div>
      </div>
      <div className="graph-body">
        <div className="graph-panel">
          <h3>Sales by Month</h3>
          <div className="graph-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                <HatchDefs prefix={`${winId}m`} />
                <CartesianGrid vertical={false} stroke="#e4e3df" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={axisDollars} tick={{ fontSize: 12 }} width={72} />
                <Tooltip formatter={(v) => dollars(Number(v))} contentStyle={tooltipStyle} isAnimationActive={false} />
                {(data?.series ?? []).map((s, j) => (
                  <Bar
                    key={`${s.id}-${s.name}`}
                    dataKey={`s${j}`}
                    name={s.name}
                    stackId="a"
                    fill={fillFor(j, s.id, s.name, `${winId}m`)}
                    stroke="#fff"
                    strokeWidth={1}
                    isAnimationActive={false}
                    onClick={(_d: unknown, i: number) => dbl(`${j}:${i}`, () => zoom(s.id, s.name, monthRange(data!.keys[i], whole)))}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="graph-hint">Double-click a bar for the detail report of that {by} and month.</div>
        </div>
        <div className="graph-panel">
          <h3>Totals</h3>
          <div className="graph-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={legend} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <HatchDefs prefix={`${winId}b`} />
                <CartesianGrid horizontal={false} stroke="#e4e3df" />
                <XAxis type="number" tickFormatter={axisDollars} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} interval={0} />
                <Tooltip formatter={(v) => dollars(Number(v))} contentStyle={tooltipStyle} isAnimationActive={false} />
                <Bar
                  dataKey="value"
                  name="Sales"
                  isAnimationActive={false}
                  onClick={(_d: unknown, i: number) => dbl(`t:${i}`, () => legend[i] && zoom(legend[i].id, legend[i].name, whole))}
                >
                  {legend.map((r, i) => (
                    <Cell key={i} fill={fillFor(i, r.id, r.name, `${winId}b`)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <LegendTable rows={legend} total={data?.total ?? 0} onZoom={(r) => zoom(r.id, r.name, whole)} />
        </div>
      </div>
    </div>
  );
}

/** Reports > Income and Expense Graph: income and expense bars by month with the net income line. */
export function IncomeExpenseGraphWindow({ winId }: WinProps) {
  const desk = useDesktop();
  const [q, setQ] = useState<GraphQuery>({ date: 'this_fiscal_year_to_date', from: '', to: '' });
  const rootRef = useRef<HTMLDivElement>(null);
  const dbl = useDoubleClick();
  const valid = q.date !== 'custom' || !q.from || !q.to || q.from <= q.to;
  const { data, error, loading } = useGraph<GraphData>(valid ? incomeExpenseUrl(q) : null);

  const series = (n: string) => data?.series.find((s) => s.name === n)?.values ?? [];
  const rows = useMemo(
    () => (data ? data.labels.map((label, i) => ({ label, key: data.keys[i], income: series('Income')[i] ?? 0, expense: series('Expense')[i] ?? 0, net: series('Net Income')[i] ?? 0 })) : []),
    [data],
  );
  const range = shownRange({ ...q }, todayIso());
  const zoomMonth = (i: number) => {
    const key = data?.keys[i];
    if (!key) return;
    const m = monthRange(key, range);
    openReport(desk, 'pl_standard', { date: 'custom', from: m.from, to: m.to });
  };
  const print = () => {
    commitActiveField();
    printWindowOf(rootRef.current, { landscape: true });
  };
  useWindowCommands(winId, { print });

  return (
    <div className="rpt-window rpt-resizable" ref={rootRef}>
      <div className="rpt-bar no-print">
        <div className="rpt-buttons">
          <button type="button" className="btn" onClick={print} title="Ctrl+P">
            Print...
          </button>
        </div>
        <DatesBar q={q} setQ={setQ}>
          <span className="rpt-loading">{loading ? 'Loading...' : ''}</span>
        </DatesBar>
      </div>
      {(error || !valid) && <div className="msg-strip error no-print">{error ?? 'The From date is after the To date.'}</div>}
      <div className="rpt-titles">
        <div className="rpt-title">Income and Expense by Month</div>
      </div>
      <div className="graph-body single">
        <div className="graph-panel">
          <div className="graph-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                <CartesianGrid vertical={false} stroke="#e4e3df" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={axisDollars} tick={{ fontSize: 12 }} width={72} />
                <Tooltip formatter={(v) => dollars(Number(v))} contentStyle={tooltipStyle} isAnimationActive={false} />
                <Legend />
                <Bar dataKey="income" name="Income" fill={HUES[0]} isAnimationActive={false} onClick={(_d: unknown, i: number) => dbl(`i:${i}`, () => zoomMonth(i))} />
                <Bar dataKey="expense" name="Expense" fill={HUES[1]} isAnimationActive={false} onClick={(_d: unknown, i: number) => dbl(`e:${i}`, () => zoomMonth(i))} />
                <Line dataKey="net" name="Net Income" stroke="#0b0b0b" strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="graph-hint">Double-click a month's bar for its Profit &amp; Loss.</div>
        </div>
      </div>
    </div>
  );
}
