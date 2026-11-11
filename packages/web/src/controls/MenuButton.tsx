import { useEffect, useRef, useState } from 'react';
import { Mnemonic } from '../util';

export interface MenuButtonItem {
  label: string;
  shortcut?: string;
  /** No action = shown disabled. */
  action?: () => void;
  /** An on/off choice (Show Inactive Items): shown with a check mark when on. */
  checked?: boolean;
}
export type MenuButtonEntry = MenuButtonItem | 'sep';

/**
 * The drop-down buttons along the bottom of a QuickBooks 2013 list ("Account ▾", "Activities ▾",
 * "Reports ▾"). Mouse only, like the icon bar: every entry is also a key (shown beside it),
 * so the buttons stay out of the Tab order. The menu opens upwards, above the button.
 */
export function MenuButton({ label, items, down }: { label: string; items: MenuButtonEntry[]; /** Open below the button (a toolbar at the top). */ down?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="mbtn-wrap" ref={ref} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className={`mbtn${open ? ' open' : ''}`} tabIndex={-1} onClick={() => setOpen(!open)}>
        <span className="mbtn-label">
          <Mnemonic label={label} />
        </span>
        <span className="mbtn-arrow" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className={`menu-drop mbtn-drop${down ? ' down' : ''}`} role="menu">
          {items.map((x, i) =>
            x === 'sep' ? (
              <div key={`s${i}`} className="menu-sep" />
            ) : (
              <div
                key={`${i}${x.label}`}
                role={x.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={x.checked}
                aria-disabled={!x.action}
                className={`menu-item${x.action ? '' : ' disabled'}`}
                onClick={() => {
                  if (!x.action) return;
                  setOpen(false);
                  x.action();
                }}
              >
                {x.checked && (
                  <span className="menu-check" aria-hidden="true">
                    ✓
                  </span>
                )}
                <span className="menu-label">
                  <Mnemonic label={x.label} />
                </span>
                <span className="menu-key">{x.shortcut ?? ''}</span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
