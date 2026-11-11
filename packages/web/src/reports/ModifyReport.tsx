import { DATE_PRESETS, todayIso, TXN_TYPE_LABELS, type Account, type Item, type Name, type ReportParamDef } from '@rapidbooks/shared';
import { useMemo, useState } from 'react';
import { useData } from '../api';
import { Combo } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField } from '../util';
import { CheckList, PickList, type CheckOption } from './PickList';
import {
  canChooseColumns,
  canSort,
  columnChecklist,
  defaultParams,
  hasAsOf,
  hasDateRange,
  idList,
  shownRange,
  sortOf,
  strList,
  withColumns,
  withDate,
  withIds,
  withParam,
  withPreset,
  withSort,
  type ReportParams,
} from './reportQuery';
import { useReportDefs } from './reportsMenu';
import './reports.css';

type Tab = 'display' | 'filters';

/**
 * Modify Report. Props: { id, params }. Result: the new params (null = Cancel).
 * Display: dates, the columns (tick, Move Up / Move Down) and the sort; Filters: one control per
 * filter the report takes. Revert puts back the report's defaults.
 */
export function ModifyReport({ winId, props }: WinProps) {
  const desk = useDesktop();
  const { data: defs } = useReportDefs();
  const def = defs?.find((d) => d.id === props.id);
  const [p, setP] = useState<ReportParams>(() => ({ ...(props.params as ReportParams) }));
  const [tab, setTab] = useState<Tab>('display');
  const [colHot, setColHot] = useState(0);
  const [typeHot, setTypeHot] = useState(0);
  const today = todayIso();

  const kinds = new Set(def?.params.map((x) => x.kind) ?? []);
  const { data: names } = useData<Name[]>(kinds.has('name_ids') || kinds.has('name_id') ? '/api/names' : null);
  const { data: items } = useData<Item[]>(kinds.has('item_ids') || kinds.has('item_id') ? '/api/items' : null);
  const { data: accounts } = useData<Account[]>(kinds.has('account_ids') || kinds.has('account_id') ? '/api/accounts' : null);

  const ok = () => {
    commitActiveField();
    desk.resolveWindow(winId, p);
    desk.close(winId);
  };
  useWindowCommands(winId, { save: ok, saveClose: ok });

  const checklist = useMemo(() => (def ? columnChecklist(def, p) : []), [def, p]);
  if (!def) return <div className="rec-loading">Loading...</div>;

  const revert = () => {
    setP(defaultParams(def));
    setColHot(0);
  };

  // ---- Columns: tick to show, Move Up / Move Down among the shown ones.
  const shownKeys = checklist.filter((c) => c.on).map((c) => c.key);
  const toggleCol = (key: string) => {
    const keys = shownKeys.includes(key) ? shownKeys.filter((k) => k !== key) : [...shownKeys, key];
    if (keys.length === 0) return; // at least one column
    setP(withColumns(def, p, keys));
  };
  const moveCol = (dir: -1 | 1) => {
    const key = checklist[colHot]?.key;
    const i = shownKeys.indexOf(key ?? '');
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shownKeys.length) return;
    const keys = [...shownKeys];
    [keys[i], keys[j]] = [keys[j], keys[i]];
    setP(withColumns(def, p, keys));
    setColHot(j); // shown columns lead the checklist, so its index is the same
  };

  const sort = sortOf(p);
  const range = hasDateRange(def) ? shownRange(p, today) : null;

  const nameOptions = (d: ReportParamDef): CheckOption<number>[] =>
    (names ?? [])
      .filter((n) => !d.name_kind || n.kind === d.name_kind)
      .map((n) => ({ id: n.id, label: n.full_name }));
  const accountOptions = (d: ReportParamDef): CheckOption<number>[] =>
    (accounts ?? []).filter((a) => !d.account_types || d.account_types.includes(a.type)).map((a) => ({ id: a.id, label: a.full_name }));
  const itemOptions = (): CheckOption<number>[] => (items ?? []).map((i) => ({ id: i.id, label: i.full_name }));
  const typeOptions: CheckOption<string>[] = Object.entries(TXN_TYPE_LABELS).map(([code, label]) => ({ id: code, label }));

  const filterControl = (d: ReportParamDef) => {
    switch (d.kind) {
      case 'name_ids':
        return <PickList key={d.key} label={d.label} options={nameOptions(d)} value={idList(p[d.key])} onChange={(ids) => setP(withIds(p, d.key, ids))} />;
      case 'item_ids':
        return <PickList key={d.key} label={d.label} options={itemOptions()} value={idList(p[d.key])} onChange={(ids) => setP(withIds(p, d.key, ids))} />;
      case 'account_ids':
        return <PickList key={d.key} label={d.label} options={accountOptions(d)} value={idList(p[d.key])} onChange={(ids) => setP(withIds(p, d.key, ids))} />;
      case 'txn_types': {
        const on = new Set(strList(p[d.key]));
        return (
          <div key={d.key} className="pick">
            <div className="pick-head">
              <span className="group-label">{d.label}</span>
              <span className="pick-count">{on.size === 0 ? 'All' : `${on.size} selected`}</span>
            </div>
            <CheckList
              options={typeOptions}
              checked={on}
              hot={typeHot}
              setHot={setTypeHot}
              label={d.label}
              onToggle={(code) => {
                const n = new Set(on);
                if (n.has(code)) n.delete(code);
                else n.add(code);
                setP(withIds(p, d.key, typeOptions.filter((o) => n.has(o.id)).map((o) => o.id)));
              }}
            />
            <div className="pick-head">
              <button type="button" className="btn" onClick={() => setP(withIds(p, d.key, typeOptions.map((o) => o.id)))}>
                Select All
              </button>
              <button type="button" className="btn" onClick={() => setP(withIds(p, d.key, []))}>
                Clear
              </button>
            </div>
          </div>
        );
      }
      case 'account_id':
      case 'name_id':
      case 'item_id': {
        const options =
          d.kind === 'account_id' ? accountOptions(d) : d.kind === 'name_id' ? nameOptions(d) : itemOptions();
        return (
          <label key={d.key} className="pick">
            <span className="group-label">{d.label}</span>
            <Combo
              options={options}
              value={p[d.key] ? Number(p[d.key]) : null}
              onChange={(v) => setP(withParam(p, d.key, v === null ? null : String(v)))}
              listName={d.kind === 'account_id' ? 'Account' : d.kind === 'item_id' ? 'Item' : undefined}
              aria-label={d.label}
            />
          </label>
        );
      }
      case 'enum':
        return (
          <label key={d.key} className="pick">
            <span className="group-label">{d.label}</span>
            <select className="field" value={p[d.key] ?? String(d.default)} onChange={(e) => setP(withParam(p, d.key, e.target.value))}>
              {(d.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        );
      case 'boolean':
        return (
          <label key={d.key} className="check">
            <input type="checkbox" checked={p[d.key] === 'true'} onChange={(e) => setP(withParam(p, d.key, e.target.checked ? 'true' : 'false'))} />
            {d.label}
          </label>
        );
      default:
        return null;
    }
  };
  const filters = def.params.filter((d) => !['date_range', 'as_of', 'columns', 'sort'].includes(d.kind));

  return (
    <div className="mod-dialog">
      <div className="mod-tabs" role="tablist">
        {(['display', 'filters'] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`mod-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'display' ? 'Display' : 'Filters'}
          </button>
        ))}
      </div>

      {tab === 'display' ? (
        <div className="mod-panel" role="tabpanel">
          <div className="group-label">{def.title}</div>
          {range && (
            <div className="mod-row">
              <label>
                Dates
                <select className="field rpt-preset" value={p.date ?? 'custom'} onChange={(e) => setP(withPreset(p, e.target.value, today))}>
                  {DATE_PRESETS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From
                <DateField value={range.from} allowEmpty onChange={(iso) => setP(withDate(p, 'from', iso, today))} />
              </label>
              <label>
                To
                <DateField value={range.to} allowEmpty onChange={(iso) => setP(withDate(p, 'to', iso, today))} />
              </label>
            </div>
          )}
          {hasAsOf(def) && (
            <div className="mod-row">
              <label>
                As of
                <DateField value={p.as_of || today} onChange={(iso) => setP(withParam(p, 'as_of', iso))} />
              </label>
            </div>
          )}
          {canChooseColumns(def) && (
            <div className="mod-cols">
              <div className="pick">
                <span className="group-label">Columns (Space shows or hides the highlighted one)</span>
                <CheckList
                  options={checklist.map((c) => ({ id: c.key, label: c.title }))}
                  checked={new Set(shownKeys)}
                  onToggle={toggleCol}
                  hot={colHot}
                  setHot={setColHot}
                  label="Columns"
                />
              </div>
              <div className="mod-side">
                <span>&nbsp;</span>
                <button type="button" className="btn" onClick={() => moveCol(-1)} disabled={!checklist[colHot]?.on || shownKeys.indexOf(checklist[colHot].key) <= 0}>
                  Move Up
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => moveCol(1)}
                  disabled={!checklist[colHot]?.on || shownKeys.indexOf(checklist[colHot].key) >= shownKeys.length - 1}
                >
                  Move Down
                </button>
                <button type="button" className="btn" onClick={() => setP(withColumns(def, p, def.default_columns))}>
                  Default Columns
                </button>
              </div>
            </div>
          )}
          {canSort(def) && (
            <div className="mod-row">
              <label>
                Sort by
                <select className="field" style={{ width: '14rem' }} value={sort.key ?? ''} onChange={(e) => setP(withSort(p, e.target.value || null, sort.desc))}>
                  <option value="">Default</option>
                  {def.columns.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.title || c.key}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="radio" name={`${winId}-dir`} disabled={!sort.key} checked={!sort.desc} onChange={() => setP(withSort(p, sort.key, false))} />
                Ascending
              </label>
              <label className="check">
                <input type="radio" name={`${winId}-dir`} disabled={!sort.key} checked={sort.desc} onChange={() => setP(withSort(p, sort.key, true))} />
                Descending
              </label>
            </div>
          )}
          {!canChooseColumns(def) && !canSort(def) && <div className="graph-hint">This report's columns are fixed.</div>}
        </div>
      ) : (
        <div className="mod-panel" role="tabpanel">
          {filters.length === 0 ? (
            <div className="graph-hint">This report has no filters.</div>
          ) : (
            <div className="filter-grid">{filters.map(filterControl)}</div>
          )}
        </div>
      )}

      <div className="button-row">
        <button type="button" className="btn" onClick={revert}>
          Revert
        </button>
        <span className="spacer" />
        <button type="button" className="btn default" onClick={ok} title="Ctrl+Enter">
          OK
        </button>
        <button type="button" className="btn" onClick={() => void desk.requestClose(winId)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
