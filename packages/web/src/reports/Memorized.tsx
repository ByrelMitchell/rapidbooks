import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField } from '../util';
import { openReport } from './open';
import { MEMORIZED_KEY, parseMemorized, sortMemorized, type MemorizedReport } from './reportQuery';
import { useMemorized, useReportDefs } from './reportsMenu';
import './reports.css';

/** Memorize Report (and Rename): one name field. Props: { name, rename? }. Result: the name, or null. */
export function MemorizeDialog({ winId, props }: WinProps) {
  const desk = useDesktop();
  const [name, setName] = useState(String(props.name ?? ''));
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.rename) desk.setTitle(winId, 'Rename Memorized Report');
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const ok = () => {
    commitActiveField();
    const n = name.trim();
    if (!n) {
      setErr('Enter a name for the memorized report.');
      ref.current?.focus();
      return;
    }
    desk.resolveWindow(winId, n);
    desk.close(winId);
  };
  useWindowCommands(winId, { save: ok, saveClose: ok });

  return (
    <form
      className="dialog"
      onSubmit={(e) => {
        e.preventDefault();
        ok();
      }}
    >
      {err && <div className="msg-strip error">{err}</div>}
      <div className="form-grid">
        <label htmlFor={`${winId}-name`}>Name</label>
        <input id={`${winId}-name`} ref={ref} className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="button-row right">
        <button type="submit" className="btn default">
          OK
        </button>
        <button type="button" className="btn" onClick={() => void desk.requestClose(winId)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

async function saveList(list: MemorizedReport[]) {
  await api.put('/api/company', { [MEMORIZED_KEY]: JSON.stringify(list) });
}

/** Reports > Memorized Reports > Memorized Report List: open (Enter), rename, delete. */
export function MemorizedList({ winId }: WinProps) {
  const desk = useDesktop();
  const { list, error } = useMemorized();
  const { data: defs } = useReportDefs();
  const rows = list ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.name === selected))) setSelected(rows[0].name);
  }, [rows, selected]);
  const current = rows.find((r) => r.name === selected) ?? null;

  const open = (m: MemorizedReport | null) => m && openReport(desk, m.report_id, m.params, m.name);

  /** Change the stored list: re-read it first so nothing saved meanwhile is lost. */
  const change = async (fn: (all: MemorizedReport[]) => MemorizedReport[] | null, done: string) => {
    try {
      const info = await api.get<Record<string, string>>('/api/company');
      const next = fn(parseMemorized(info[MEMORIZED_KEY]));
      if (!next) return;
      await saveList(next);
      desk.refresh();
      desk.setStatus(done);
    } catch (e) {
      await desk.alert(errorMessage(e));
    }
  };

  const rename = async () => {
    if (!current) return;
    const name = await desk.openForResult<string>('memorize', { name: current.name, rename: true });
    if (!name || name === current.name) return;
    if (rows.some((r) => r !== current && r.name.toLowerCase() === name.toLowerCase())) {
      await desk.alert(`There is already a memorized report named "${name}".`);
      return;
    }
    await change((all) => all.map((m) => (m.name === current.name ? { ...m, name } : m)), `Renamed to "${name}".`);
    setSelected(name);
  };

  const remove = async () => {
    if (!current) return;
    if (!(await desk.confirm(`Delete the memorized report "${current.name}"?`, { yes: '&OK', no: '&Cancel' }))) return;
    const i = rows.indexOf(current);
    const next = rows[i + 1] ?? rows[i - 1];
    await change((all) => all.filter((m) => m.name !== current.name), `"${current.name}" deleted.`);
    setSelected(next ? next.name : null);
  };

  useWindowCommands(winId, { edit: () => void rename(), delete: () => void remove() });

  const title = (id: string) => defs?.find((d) => d.id === id)?.title ?? id;
  const columns: Column<MemorizedReport>[] = [
    { key: 'name', title: 'Report Name', render: (m) => m.name },
    { key: 'report', title: 'Report', width: '16rem', render: (m) => title(m.report_id) },
  ];

  return (
    <div className="list-window">
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={sortMemorized(rows)}
        rowKey={(m) => m.name}
        selected={selected}
        onSelect={setSelected}
        onActivate={open}
        emptyText={list ? 'There are no memorized reports. Use Memorize in a report window to add one.' : 'Loading...'}
        label="Memorized Report List"
      />
      <div className="button-row">
        <button type="button" className="btn" disabled={!current} onClick={() => open(current)}>
          Open Report
        </button>
        <button type="button" className="btn" disabled={!current} onClick={() => void rename()} title="Ctrl+E">
          Rename...
        </button>
        <button type="button" className="btn" disabled={!current} onClick={() => void remove()} title="Ctrl+D">
          Delete
        </button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
