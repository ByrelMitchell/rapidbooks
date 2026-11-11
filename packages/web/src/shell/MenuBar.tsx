import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { useReportsMenu } from '../reports/reportsMenu';
import { logOff } from '../admin/logOff';
import { sessionState, useSession } from '../admin/session';
import { Mnemonic, parseMnemonic } from '../util';
import { isModalOpen, toggleFullScreen, useDesktop, type CommandName, type Desktop } from './desktop';
import { openRegister } from './shortcuts';
import { setViewPref, useViewPrefs, type ViewPrefs } from './viewPrefs';

export interface MenuItem {
  label: string;
  shortcut?: string;
  /** No action = shown disabled (feature not built yet, or nothing to act on). */
  action?: () => void;
  /** A submenu (one level): Right or Enter opens it, Left or Esc closes it. */
  items?: MenuEntry[];
  /** An on/off choice (View > Icon Bar): shown with a check mark when on. */
  checked?: boolean;
}
export type MenuEntry = MenuItem | 'sep';
export interface Menu {
  label: string;
  items: MenuEntry[];
}

export interface MenuBarHandle {
  /** Open the menu whose mnemonic is `letter`; false if there is none. */
  openByLetter: (letter: string) => boolean;
}

function buildMenus(desk: Desktop, reportsMenu: Menu, prefs: ViewPrefs): Menu[] {
  const cmds = desk.commands(desk.activeId);
  const cmd = (name: CommandName) => (cmds[name] ? () => desk.run(name) : undefined);
  return [
    {
      label: '&File',
      items: [
        { label: '&Back Up...', action: () => desk.open('backup') },
        'sep',
        { label: 'Print &Forms > Invoices...', action: () => desk.open('printforms') },
        { label: 'Print Forms > &Checks...', action: () => desk.open('printchecks') },
        { label: 'Sen&d Forms...', action: () => desk.open('sendforms') },
        'sep',
        // Only when a password is set (otherwise there is nothing to log off from).
        { label: '&Log Off', action: sessionState().authRequired ? () => void logOff(desk) : undefined },
      ],
    },
    {
      label: '&Edit',
      items: [
        { label: '&New', shortcut: 'Ctrl+N', action: cmd('new') },
        { label: '&Edit', shortcut: 'Ctrl+E', action: cmd('edit') },
        { label: '&Delete', shortcut: 'Ctrl+D', action: cmd('delete') },
        'sep',
        { label: '&Find...', shortcut: 'Ctrl+F', action: () => desk.open('find') },
      ],
    },
    {
      label: '&View',
      items: [
        { label: 'Zoom &In', action: desk.zoom < 200 ? desk.zoomIn : undefined },
        { label: 'Zoom &Out', action: desk.zoom > 100 ? desk.zoomOut : undefined },
        { label: '&Actual Size', action: desk.zoom !== 100 ? () => desk.setZoom(100) : undefined },
        'sep',
        { label: '&Full Screen', action: () => void toggleFullScreen(desk.setStatus) },
        'sep',
        { label: 'Icon &Bar', checked: prefs.iconBar, action: () => setViewPref('iconBar', !prefs.iconBar) },
        { label: '&Large List Font', checked: prefs.largeLists, action: () => setViewPref('largeLists', !prefs.largeLists) },
      ],
    },
    {
      label: '&Lists',
      items: [
        { label: 'Chart of &Accounts', shortcut: 'Ctrl+A', action: () => desk.open('accounts') },
        { label: '&Item List', action: () => desk.open('items') },
        { label: '&Customer:Job List', shortcut: 'Ctrl+J', action: () => desk.open('customers') },
        { label: '&Vendor List', action: () => desk.open('vendors') },
        { label: '&Employee List', action: () => desk.open('employees') },
        { label: '&Other Names List', action: () => desk.open('othernames') },
        'sep',
        { label: '&Payroll Item List', action: () => desk.open('payrollitems') },
        { label: '&Terms List', action: () => desk.open('terms') },
      ],
    },
    {
      label: '&Company',
      items: [
        { label: '&Navigator', action: () => desk.open('navigator') },
        'sep',
        { label: 'Company &Information...', action: () => desk.open('company') },
        { label: 'Make General &Journal Entries...', action: () => desk.open('journal', { id: null }) },
      ],
    },
    {
      label: 'C&ustomers',
      items: [
        { label: 'Customer:&Job List', shortcut: 'Ctrl+J', action: () => desk.open('customers') },
        'sep',
        { label: 'Create &Invoices', shortcut: 'Ctrl+I', action: () => desk.open('invoice', { id: null }) },
        { label: 'Create Credit &Memos/Refunds', action: () => desk.open('creditmemo', { id: null }) },
        { label: 'Create &Statements...', action: () => desk.open('statements') },
        { label: 'Assess Finance &Charges', action: () => desk.open('financecharges') },
        { label: '&Receive Payments', action: () => desk.open('payment', { id: null }) },
      ],
    },
    {
      label: 'Vend&ors',
      items: [
        { label: '&Vendor List', action: () => desk.open('vendors') },
        'sep',
        { label: 'Create &Purchase Orders', action: () => desk.open('purchaseorder', { id: null }) },
        { label: '&Enter Bills', action: () => desk.open('bill', { id: null }) },
        { label: 'Pay &Bills', action: () => desk.open('paybills') },
      ],
    },
    {
      label: 'Emplo&yees',
      items: [
        { label: '&Employee List', action: () => desk.open('employees') },
        { label: 'Payroll &Item List', action: () => desk.open('payrollitems') },
        'sep',
        { label: '&Pay Employees', action: () => desk.open('paycheck', { id: null }) },
      ],
    },
    {
      label: '&Banking',
      items: [
        { label: '&Write Checks', shortcut: 'Ctrl+W', action: () => desk.open('check', { id: null }) },
        { label: 'Make &Deposits', action: () => desk.open('deposit', { id: null }) },
        { label: '&Transfer Funds', action: () => desk.open('transfer', { id: null }) },
        { label: 'Use &Register', shortcut: 'Ctrl+R', action: () => openRegister(desk) },
      ],
    },
    reportsMenu,
    {
      label: '&Window',
      items: [
        ...desk.windows.map(
          (w, i): MenuItem => ({
            label: `${i < 9 ? `&${i + 1}` : ''} ${w.title.replace(/&/g, '&&')}`.trim(),
            action: () => desk.focus(w.id),
          }),
        ),
        ...(desk.windows.length ? (['sep'] as MenuEntry[]) : []),
        {
          label: 'Close &All',
          action: desk.windows.length
            ? async () => {
                // Front-most first, so any "discard changes?" prompt is for the window in view.
                for (const w of [...desk.windows].sort((a, b) => b.z - a.z)) {
                  desk.focus(w.id);
                  if (!(await desk.requestClose(w.id))) break;
                }
              }
            : undefined,
        },
      ],
    },
    {
      label: '&Help',
      items: [
        { label: '&Keyboard Shortcuts', action: () => desk.open('keys') },
        'sep',
        { label: '&About RapidBooks...', shortcut: 'F2', action: () => desk.open('about') },
      ],
    },
  ];
}

/** The submenu of an entry, when it has one with something enabled in it. */
const subOf = (e: MenuEntry | undefined): MenuEntry[] | null =>
  !!e && e !== 'sep' && !!e.items && e.items.some((x) => x !== 'sep' && !!x.action) ? e.items : null;
const enabled = (e: MenuEntry | undefined): e is MenuItem =>
  !!e && e !== 'sep' && (!!e.action || subOf(e) !== null);

function step(items: MenuEntry[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (enabled(items[i])) return i;
  }
  return -1;
}
const firstEnabled = (items: MenuEntry[]) => step(items, -1, 1);

export function MenuBar({ ref }: { ref?: Ref<MenuBarHandle> }) {
  const desk = useDesktop();
  useSession(); // re-render when login state changes (File > Log Off)
  const menus = buildMenus(desk, useReportsMenu(desk), useViewPrefs());
  const [open, setOpen] = useState<number | null>(null);
  const [item, setItem] = useState(-1);
  // The open submenu belongs to the hot item `item`; subItem is the hot entry inside it.
  const [sub, setSub] = useState(false);
  const [subItem, setSubItem] = useState(-1);
  const barRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  const openMenu = (i: number) => {
    setOpen(i);
    setItem(firstEnabled(menus[i].items));
    setSub(false);
    setSubItem(-1);
  };
  const closeMenu = () => {
    setOpen(null);
    setItem(-1);
    setSub(false);
    setSubItem(-1);
  };
  /** Make entry j of the open menu hot and open its submenu. */
  const openSub = (j: number, entries: MenuEntry[]) => {
    setItem(j);
    setSub(true);
    setSubItem(firstEnabled(entries));
  };
  const closeSub = () => {
    setSub(false);
    setSubItem(-1);
  };
  /** Choose an entry: run its action, or open its submenu when it has one (entry j of the open menu). */
  const activate = (entry: MenuEntry | undefined, j = -1) => {
    if (!enabled(entry)) return;
    const s = subOf(entry);
    if (s) {
      if (j >= 0) openSub(j, s);
      return;
    }
    closeMenu();
    entry.action?.();
  };
  const byMnemonic = (entries: MenuEntry[], k: string) =>
    entries.findIndex((x) => x !== 'sep' && enabled(x) && parseMnemonic(x.label).key === k);

  // Keep the open submenu on screen: to the left of its menu when there is no room on the
  // right, and moved up when it would run off the bottom.
  useLayoutEffect(() => {
    const el = subRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const pr = parent.getBoundingClientRect();
    el.classList.toggle('flip', pr.right + el.offsetWidth > window.innerWidth && pr.left - el.offsetWidth >= 0);
    el.style.top = '';
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight) el.style.top = `${-Math.min(r.top, r.bottom - window.innerHeight + 4)}px`;
  });
  const indexByLetter = (letter: string) => menus.findIndex((m) => parseMnemonic(m.label).key === letter);

  useImperativeHandle(ref, () => ({
    openByLetter: (letter: string) => {
      const i = indexByLetter(letter.toLowerCase());
      if (i < 0) return false;
      openMenu(i);
      return true;
    },
  }));

  // While a menu is open it owns the keyboard: every key is swallowed before it reaches
  // the focused field or the global shortcuts. DOM focus never moves into the menu.
  useEffect(() => {
    if (open === null) return;
    const items = menus[open].items;
    const onKey = (e: KeyboardEvent) => {
      // A message box that opens while a menu is down takes the keyboard; the menu just closes.
      if (isModalOpen()) {
        closeMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const altLetter = e.altKey && !e.ctrlKey && /^Key[A-Z]$/.test(e.code);
      const plainChar = !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1;
      const subItems = sub ? subOf(items[item]) : null;
      if (subItems) {
        // In the submenu: Left / Esc go back to the menu, Right moves on to the next menu.
        if (e.key === 'Escape' || e.key === 'ArrowLeft') closeSub();
        else if (e.key === 'ArrowRight') openMenu((open + 1) % menus.length);
        else if (e.key === 'ArrowDown') setSubItem(step(subItems, subItem, 1));
        else if (e.key === 'ArrowUp') setSubItem(step(subItems, subItem < 0 ? subItems.length : subItem, -1));
        else if (e.key === 'Enter') activate(subItems[subItem]);
        else if (altLetter) {
          const i = indexByLetter(e.code.slice(3).toLowerCase());
          if (i >= 0) openMenu(i);
        } else if (plainChar) {
          const k = byMnemonic(subItems, e.key.toLowerCase());
          if (k >= 0) activate(subItems[k]);
        }
        return;
      }
      if (e.key === 'Escape') closeMenu();
      else if (e.key === 'ArrowLeft') openMenu((open - 1 + menus.length) % menus.length);
      else if (e.key === 'ArrowRight') {
        // Right opens the hot item's submenu; on an ordinary item it moves to the next menu.
        const s = subOf(items[item]);
        if (s) openSub(item, s);
        else openMenu((open + 1) % menus.length);
      } else if (e.key === 'ArrowDown') setItem(step(items, item, 1));
      else if (e.key === 'ArrowUp') setItem(step(items, item < 0 ? items.length : item, -1));
      else if (e.key === 'Enter') activate(items[item], item);
      else if (altLetter) {
        const i = indexByLetter(e.code.slice(3).toLowerCase());
        if (i >= 0) openMenu(i);
      } else if (plainChar) {
        const j = byMnemonic(items, e.key.toLowerCase());
        if (j >= 0) activate(items[j], j);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onBlur);
    };
  });

  return (
    <div className="menubar" ref={barRef} role="menubar" onMouseDown={(e) => e.preventDefault()}>
      {menus.map((m, i) => (
        <div key={m.label} className="menu-wrap">
          <div
            className={`menu-title${open === i ? ' open' : ''}`}
            role="menuitem"
            onClick={() => (open === i ? closeMenu() : openMenu(i))}
            onMouseEnter={() => open !== null && open !== i && openMenu(i)}
          >
            <Mnemonic label={m.label} />
          </div>
          {open === i && (
            <div className="menu-drop" role="menu">
              {m.items.map((x, j) => {
                if (x === 'sep') return <div key={`sep${j}`} className="menu-sep" />;
                const on = enabled(x);
                const s = subOf(x);
                return (
                  <div
                    key={`${j}${x.label}`}
                    role={x.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                    aria-disabled={!on}
                    aria-checked={x.checked}
                    aria-haspopup={x.items ? 'menu' : undefined}
                    aria-expanded={x.items ? sub && item === j : undefined}
                    className={`menu-item${on ? '' : ' disabled'}${item === j ? ' hot' : ''}${x.items ? ' has-sub' : ''}`}
                    onMouseEnter={() => {
                      if (!on) return;
                      if (s) openSub(j, s);
                      else {
                        setItem(j);
                        closeSub();
                      }
                    }}
                    onClick={() => activate(x, j)}
                  >
                    {x.checked && (
                      <span className="menu-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                    <span className="menu-label">
                      <Mnemonic label={x.label} />
                    </span>
                    <span className="menu-key">{x.items ? '▸' : (x.shortcut ?? '')}</span>
                    {s && sub && item === j && (
                      <div ref={subRef} className="menu-drop menu-sub" role="menu">
                        {s.map((y, k) =>
                          y === 'sep' ? (
                            <div key={`sep${k}`} className="menu-sep" />
                          ) : (
                            <div
                              key={`${k}${y.label}`}
                              role="menuitem"
                              aria-disabled={!y.action}
                              className={`menu-item${y.action ? '' : ' disabled'}${subItem === k ? ' hot' : ''}`}
                              onMouseEnter={() => y.action && setSubItem(k)}
                              onClick={(e) => {
                                // Not also a click on the parent entry, which would reopen this submenu.
                                e.stopPropagation();
                                activate(y);
                              }}
                            >
                              <span className="menu-label">
                                <Mnemonic label={y.label} />
                              </span>
                              <span className="menu-key">{y.shortcut ?? ''}</span>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
