import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  title: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string; // CSS width in rem/em
  onClick?: (row: T, e: MouseEvent) => void;
}

interface Props<T, K extends string | number> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => K;
  selected: K | null;
  onSelect: (key: K) => void;
  onActivate?: (row: T) => void;
  rowClass?: (row: T) => string;
  emptyText?: string;
  label?: string;
  /** Extra class on the table (e.g. a minimum width so a column keeps its room). */
  tableClass?: string;
}

/**
 * Column widths given in rem are applied in em, which is the same at the normal list font
 * (.listview is 1rem) and grows with View > Large List Font, so the larger text still fits.
 */
const scaled = (w: string) => w.replace(/(\d*\.?\d+)rem\b/g, '$1em');

/** Keyboard-navigable list (Up/Down/Home/End/PageUp/PageDown, Enter or double-click to open). */
export function ListView<T, K extends string | number>({
  columns,
  rows,
  rowKey,
  selected,
  onSelect,
  onActivate,
  rowClass,
  emptyText,
  label,
  tableClass,
}: Props<T, K>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const index = selected === null ? -1 : rows.findIndex((r) => rowKey(r) === selected);

  useEffect(() => {
    if (index < 0) return;
    const tr = scrollRef.current?.querySelector(`tbody tr[data-index="${index}"]`);
    tr?.scrollIntoView({ block: 'nearest' });
  }, [index, rows.length]);

  const pageSize = () => {
    const box = scrollRef.current;
    const tr = box?.querySelector('tbody tr');
    const head = box?.querySelector('thead');
    if (!box || !tr) return 10;
    const h = (tr as HTMLElement).offsetHeight || 1;
    return Math.max(1, Math.floor((box.clientHeight - ((head as HTMLElement | null)?.offsetHeight ?? 0)) / h) - 1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || rows.length === 0) return;
    let next: number | null = null;
    const last = rows.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(last, index + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, index < 0 ? 0 : index - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'PageDown':
        next = Math.min(last, Math.max(0, index) + pageSize());
        break;
      case 'PageUp':
        next = Math.max(0, index - pageSize());
        break;
      case 'Enter':
        e.preventDefault();
        if (index >= 0 && onActivate) onActivate(rows[index]);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next !== null && next !== index) onSelect(rowKey(rows[next]));
  };

  return (
    <div className="listview" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-label={label}>
      <table className={tableClass}>
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: scaled(c.width) } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align ? `al-${c.align}` : undefined}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey(r)}
              data-index={i}
              className={`${i === index ? 'sel' : ''} ${rowClass?.(r) ?? ''}`.trim() || undefined}
              onMouseDown={() => onSelect(rowKey(r))}
              onDoubleClick={() => onActivate?.(r)}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={c.align ? `al-${c.align}` : undefined}
                  onClick={c.onClick ? (e) => c.onClick!(r, e) : undefined}
                  // A clickable cell (the register's ✓) must not also open the row on double-click.
                  onDoubleClick={c.onClick ? (e) => e.stopPropagation() : undefined}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && emptyText && <div className="listview-empty">{emptyText}</div>}
    </div>
  );
}
