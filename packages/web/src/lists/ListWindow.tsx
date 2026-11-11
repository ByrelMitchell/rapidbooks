import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';

export interface ListRow {
  id: number;
  inactive: boolean;
  parent_id?: number | null;
}

/** Inactive entries, and everything under them, only when "Include inactive" is on. */
function visibleRows<T extends ListRow>(rows: T[], includeInactive: boolean): T[] {
  if (includeInactive) return rows;
  const hidden = new Set<number>();
  return rows.filter((r) => {
    if (r.inactive || (r.parent_id != null && hidden.has(r.parent_id))) {
      hidden.add(r.id);
      return false;
    }
    return true;
  });
}

/** Name indented by depth (jobs under customers, subitems under items). */
export function Indented({ depth, children }: { depth: number; children: ReactNode }) {
  return <span style={{ paddingLeft: `${depth * 1.25}em` }}>{children}</span>;
}

const MARK: Column<ListRow> = {
  key: 'inactive-mark',
  title: '✕',
  width: '1.75rem',
  align: 'center',
  render: (r) => (r.inactive ? '✕' : ''),
};

interface Props<T extends ListRow> {
  winId: string;
  /** GET path for the rows (in list order). */
  path: string;
  /** DELETE goes to `${itemPath}/${id}`. */
  itemPath: string;
  /** "customer:job", "vendor", "item"... as in "Are you sure you want to delete this vendor?" */
  noun: string;
  /** Button-row label ("Customer:Job:"), and the list's aria label. */
  title: string;
  /** The delete question, if not "Are you sure you want to delete this <noun>?". */
  deleteQuestion?: string;
  /** Label of the row in status messages. */
  rowLabel: (row: T) => string;
  columns: Column<T>[];
  newLabel?: string;
  onNew: () => void;
  onEdit: (row: T) => void;
  /** More buttons after New (e.g. Add Job), given the selected row. */
  extraButtons?: (current: T | null) => ReactNode;
  /** Ctrl+Q and a QuickReport button: the QuickReport for the selected row. */
  onQuickReport?: (row: T) => void;
}

/**
 * A QuickBooks list window: the list, New / Edit / Delete along the bottom (Ctrl+N / Ctrl+E / Ctrl+D),
 * Enter or double-click to edit, and "Include inactive".
 */
export function ListWindow<T extends ListRow>(p: Props<T>) {
  const desk = useDesktop();
  const { data, error } = useData<T[]>(p.path);
  const [includeInactive, setIncludeInactive] = useState(false);
  const rows = useMemo(() => visibleRows(data ?? [], includeInactive), [data, includeInactive]);
  const [selected, setSelected] = useState<number | null>(null);
  const checkId = useId();

  // Keep a valid selection as the list reloads or inactive rows are hidden.
  useEffect(() => {
    if (rows.length === 0) return;
    if (selected === null || !rows.some((r) => r.id === selected)) setSelected(rows[0].id);
  }, [rows, selected]);

  const current = rows.find((r) => r.id === selected) ?? null;

  const remove = async () => {
    const row = current;
    if (!row) return;
    const question = p.deleteQuestion ?? `Are you sure you want to delete this ${p.noun}?`;
    if (!(await desk.confirm(question, { yes: '&OK', no: '&Cancel' }))) return;
    try {
      await api.del(`${p.itemPath}/${row.id}`);
      const i = rows.indexOf(row);
      const next = rows[i + 1] ?? rows[i - 1];
      setSelected(next ? next.id : null);
      desk.setStatus(`${p.rowLabel(row)} deleted.`);
      desk.refresh();
    } catch (e) {
      await desk.alert(errorMessage(e));
    }
  };

  const edit = () => current && p.onEdit(current);
  const quickReport = p.onQuickReport && current ? () => p.onQuickReport!(current) : undefined;
  useWindowCommands(p.winId, { new: p.onNew, edit, delete: () => void remove(), quickReport });

  const columns = includeInactive ? [MARK as Column<T>, ...p.columns] : p.columns;

  return (
    <div className="list-window">
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={p.onEdit}
        rowClass={(r) => (r.inactive ? 'inactive' : '')}
        emptyText={data ? `There are no entries in this list.` : 'Loading...'}
        label={p.title}
      />
      <div className="button-row">
        <span className="group-label">{p.title}:</span>
        <button type="button" className="btn" onClick={p.onNew} title="Ctrl+N">
          {p.newLabel ?? 'New'}
        </button>
        {p.extraButtons?.(current)}
        <button type="button" className="btn" disabled={!current} onClick={edit} title="Ctrl+E">
          Edit
        </button>
        <button type="button" className="btn" disabled={!current} onClick={() => void remove()} title="Ctrl+D">
          Delete
        </button>
        {p.onQuickReport && (
          <button type="button" className="btn" disabled={!current} onClick={quickReport} title="Ctrl+Q">
            QuickReport
          </button>
        )}
        <span className="spacer" />
        <label className="check" htmlFor={checkId}>
          <input
            id={checkId}
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
      </div>
    </div>
  );
}
