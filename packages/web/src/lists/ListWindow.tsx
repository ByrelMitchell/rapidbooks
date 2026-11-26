import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { MenuButton, type MenuButtonEntry } from '../controls/MenuButton';
import { useDesktop, useWindowCommands } from '../shell/desktop';

export interface ListRow {
  id: number;
  inactive: boolean;
  parent_id?: number | null;
}

/** Inactive entries, and everything under them, only when "Include inactive" is on. */
export function visibleRows<T extends ListRow>(rows: T[], includeInactive: boolean): T[] {
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

/** Name indented by depth (jobs under customers, subitems under items), with QuickBooks 2013's small bullet. */
export function Indented({ depth, bullet, children }: { depth: number; bullet?: boolean; children: ReactNode }) {
  return (
    <span style={{ paddingLeft: `${depth * 1.25}em` }}>
      {bullet && <span className="lv-bullet">◦</span>}
      {children}
    </span>
  );
}

/** The ✖ column: inactive entries (shown while "Include inactive" is on). */
export function inactiveMark<T extends ListRow>(): Column<T> {
  return {
    key: 'inactive-mark',
    title: '✖',
    width: '1.75rem',
    align: 'center',
    render: (r) => (r.inactive ? '✖' : ''),
  };
}

/** The bar along the bottom of a 2013 list: "Account ▾", "Activities ▾", "Reports ▾", Include inactive. */
export function ListFooter({
  menus,
  includeInactive,
  onIncludeInactive,
  children,
}: {
  menus: { label: string; items: MenuButtonEntry[] }[];
  includeInactive?: boolean;
  onIncludeInactive?: (v: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="lv-footer">
      {menus.map((m) => (
        <MenuButton key={m.label} label={m.label} items={m.items} />
      ))}
      {children}
      {onIncludeInactive && (
        <label className="check lv-inactive" htmlFor={id}>
          <input id={id} type="checkbox" tabIndex={-1} checked={!!includeInactive} onChange={(e) => onIncludeInactive(e.target.checked)} />
          Include inactive
        </label>
      )}
    </div>
  );
}

/**
 * QuickBooks 2013's search bar over the Item List: Look for [ ] in [All fields], Search, Reset,
 * Search within results. Typing and Enter search; Reset shows the whole list again.
 */
export function ListSearch({ onSearch }: { onSearch: (text: string, within: boolean) => void }) {
  const [text, setText] = useState('');
  const [within, setWithin] = useState(false);
  const [active, setActive] = useState(false);
  const id = useId();
  const go = () => {
    onSearch(text.trim(), within);
    setActive(text.trim() !== '');
  };
  return (
    <div className="lv-search">
      <label htmlFor={id}>
        Look for
      </label>
      <input
        id={id}
        className="field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go();
          }
        }}
      />
      <span>in</span>
      <select className="field lv-in" disabled aria-label="Search in">
        <option>All fields</option>
      </select>
      <button type="button" className="btn primary" onClick={go}>
        Search
      </button>
      <button
        type="button"
        className="btn"
        disabled={!active}
        onClick={() => {
          setText('');
          setActive(false);
          onSearch('', false);
        }}
      >
        Reset
      </button>
      <label className="check">
        <input type="checkbox" checked={within} onChange={(e) => setWithin(e.target.checked)} />
        Search within results
      </label>
    </div>
  );
}

interface Props<T extends ListRow> {
  winId: string;
  /** GET path for the rows (in list order). */
  path: string;
  /** DELETE goes to `${itemPath}/${id}`. */
  itemPath: string;
  /** "customer:job", "vendor", "item"... as in "Are you sure you want to delete this vendor?" */
  noun: string;
  /** The first menu button ("Item", "Other Names", ...), and the list's aria label. */
  title: string;
  /** The delete question, if not "Are you sure you want to delete this <noun>?". */
  deleteQuestion?: string;
  /** Label of the row in status messages. */
  rowLabel: (row: T) => string;
  columns: Column<T>[];
  newLabel?: string;
  onNew: () => void;
  onEdit: (row: T) => void;
  /** More entries for the first menu (e.g. Add Job), given the selected row. */
  moreEntries?: (current: T | null) => MenuButtonEntry[];
  /** The Activities menu, given the selected row. */
  activities?: (current: T | null) => MenuButtonEntry[];
  /** Ctrl+Q and Reports > QuickReport: the QuickReport for the selected row. */
  onQuickReport?: (row: T) => void;
  /** Item > Duplicate Item: a new entry like this one. */
  onDuplicate?: (row: T) => void;
  /** Item > Make Item Inactive / Active: save the row with its inactive flag changed. */
  setInactive?: (row: T, inactive: boolean) => Promise<void>;
  /** "Items" in "Show Inactive Items" (default: the noun in capitals, + s unless it ends in s). */
  plural?: string;
  /** The Item List's search bar: does the row match the text? */
  matches?: (row: T, text: string) => boolean;
  /** Something above the list (Item List: its search bar is built in when `matches` is given). */
}

/**
 * A QuickBooks 2013 list window: the list, and along the bottom its menu buttons (New / Edit /
 * Delete are also Ctrl+N / Ctrl+E / Ctrl+D), Enter or double-click to edit, and "Include inactive".
 */
export function ListWindow<T extends ListRow>(p: Props<T>) {
  const desk = useDesktop();
  const { data, error } = useData<T[]>(p.path);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState<string[]>([]);
  const rows = useMemo(() => {
    const all = visibleRows(data ?? [], includeInactive);
    const m = p.matches;
    return m && search.length ? all.filter((r) => search.every((t) => m(r, t))) : all;
  }, [data, includeInactive, search, p.matches]);
  const [selected, setSelected] = useState<number | null>(null);

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

  const columns = includeInactive ? [inactiveMark<T>(), ...p.columns] : p.columns;
  // "payroll item" -> "Payroll Item"; "terms" is already plural.
  const noun = p.noun.replace(/:.*/, '').replace(/\b\w/g, (c) => c.toUpperCase());
  const plural = p.plural ?? (noun.endsWith('s') ? noun : `${noun}s`);
  const toggleInactive = async () => {
    const row = current;
    if (!row || !p.setInactive) return;
    try {
      await p.setInactive(row, !row.inactive);
      desk.setStatus(`${p.rowLabel(row)} is now ${row.inactive ? 'active' : 'inactive'}.`);
      desk.refresh();
    } catch (e) {
      await desk.alert(errorMessage(e));
    }
  };
  const dup = p.onDuplicate;
  const menus: { label: string; items: MenuButtonEntry[] }[] = [
    {
      label: p.title,
      items: [
        { label: p.newLabel ?? 'New', shortcut: 'Ctrl+N', action: p.onNew },
        { label: `Edit ${noun}`, shortcut: 'Ctrl+E', action: current ? edit : undefined },
        ...(dup ? [{ label: `Duplicate ${noun}`, action: current ? () => dup(current) : undefined }] : []),
        { label: `Delete ${noun}`, shortcut: 'Ctrl+D', action: current ? () => void remove() : undefined },
        'sep',
        ...(p.setInactive
          ? [{ label: `Make ${noun} ${current?.inactive ? 'Active' : 'Inactive'}`, action: current ? () => void toggleInactive() : undefined }]
          : []),
        {
          label: `Show Inactive ${plural}`,
          checked: includeInactive,
          action: () => setIncludeInactive(!includeInactive),
        },
        ...(p.moreEntries ? (['sep', ...p.moreEntries(current)] as MenuButtonEntry[]) : []),
      ],
    },
  ];
  if (p.activities) menus.push({ label: 'Activities', items: p.activities(current) });
  if (p.onQuickReport)
    menus.push({ label: 'Reports', items: [{ label: `QuickReport: ${current ? p.rowLabel(current).replace(/"/g, '') : ''}`, shortcut: 'Ctrl+Q', action: quickReport }] });

  return (
    <div className="list-window">
      {p.matches && <ListSearch onSearch={(t, within) => setSearch((prev) => (t === '' ? [] : within ? [...prev, t] : [t]))} />}
      {error && <div className="msg-strip error">{error}</div>}
      <ListView
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={selected}
        onSelect={setSelected}
        onActivate={p.onEdit}
        rowClass={(r) => (r.inactive ? 'inactive' : '')}
        emptyText={data ? (search.length ? 'Nothing matches the search.' : 'There are no entries in this list.') : 'Loading...'}
        label={p.title}
      />
      <ListFooter menus={menus} includeInactive={includeInactive} onIncludeInactive={setIncludeInactive} />
    </div>
  );
}
