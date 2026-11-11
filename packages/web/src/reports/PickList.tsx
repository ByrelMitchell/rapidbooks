import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export interface CheckOption<K extends string | number> {
  id: K;
  label: string;
  depth?: number;
}

interface CheckListProps<K extends string | number> {
  options: CheckOption<K>[];
  checked: ReadonlySet<K>;
  onToggle: (id: K) => void;
  /** The row with the highlight (index into options). */
  hot: number;
  setHot: (i: number) => void;
  label: string;
  emptyText?: string;
  className?: string;
}

/** A list of checkboxes: Up/Down/PageUp/PageDown/Home/End move, Space (or a click) ticks. */
export function CheckList<K extends string | number>({ options, checked, onToggle, hot, setHot, label, emptyText, className }: CheckListProps<K>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hot < 0) return;
    ref.current?.querySelector(`[data-i="${hot}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hot]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || options.length === 0) return;
    const last = options.length - 1;
    const page = 8;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(last, hot + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, hot - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'PageDown':
        next = Math.min(last, Math.max(0, hot) + page);
        break;
      case 'PageUp':
        next = Math.max(0, hot - page);
        break;
      case ' ':
        e.preventDefault();
        if (hot >= 0 && options[hot]) onToggle(options[hot].id);
        return;
      default:
        return;
    }
    e.preventDefault();
    setHot(next);
  };

  return (
    <div ref={ref} className={`checklist${className ? ` ${className}` : ''}`} tabIndex={0} role="listbox" aria-label={label} aria-multiselectable onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <div
          key={String(o.id)}
          data-i={i}
          role="option"
          aria-selected={checked.has(o.id)}
          className={`checklist-row${i === hot ? ' hot' : ''}`}
          style={o.depth ? { paddingLeft: `${0.375 + o.depth * 1.25}em` } : undefined}
          onMouseDown={() => setHot(i)}
          onClick={() => onToggle(o.id)}
        >
          <input type="checkbox" tabIndex={-1} readOnly checked={checked.has(o.id)} />
          {o.label}
        </div>
      ))}
      {options.length === 0 && <div className="checklist-empty">{emptyText ?? '(none)'}</div>}
    </div>
  );
}

/**
 * A multi-select pick list with type-ahead filtering, Select All and Clear.
 * Nothing ticked means "all" (no filter), as in the QuickBooks filters.
 */
export function PickList<K extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: CheckOption<K>[];
  value: K[];
  onChange: (ids: K[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const [hot, setHot] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? options.filter((o) => o.label.toLowerCase().includes(f)) : options;
  }, [options, filter]);
  const checked = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    if (hot >= shown.length) setHot(Math.max(0, shown.length - 1));
  }, [shown.length, hot]);

  // Keep the order of the list, not the order of ticking.
  const ordered = (ids: Set<K>) => options.filter((o) => ids.has(o.id)).map((o) => o.id);
  const toggle = (id: K) => {
    const n = new Set(value);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    onChange(ordered(n));
  };
  const selectAll = () => onChange(ordered(new Set([...value, ...shown.map((o) => o.id)])));
  const clear = () => onChange([]);

  return (
    <div className="pick">
      <div className="pick-head">
        <span className="group-label">{label}</span>
        <span className="pick-count">{value.length === 0 ? 'All' : `${value.length} selected`}</span>
      </div>
      <input
        className="field"
        placeholder="Type to filter the list"
        aria-label={`Filter ${label}`}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setHot(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !e.altKey) {
            e.preventDefault();
            listRef.current?.querySelector<HTMLElement>('.checklist')?.focus();
          }
        }}
      />
      <div ref={listRef}>
        <CheckList options={shown} checked={checked} onToggle={toggle} hot={hot} setHot={setHot} label={label} emptyText={filter ? 'Nothing matches.' : '(none)'} />
      </div>
      <div className="pick-head">
        <button type="button" className="btn" onClick={selectAll}>
          Select All
        </button>
        <button type="button" className="btn" onClick={clear}>
          Clear
        </button>
      </div>
    </div>
  );
}
