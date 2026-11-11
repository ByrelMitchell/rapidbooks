import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Mnemonic, parseMnemonic } from '../util';
import { isModalOpen, toggleFullScreen, useDesktop, type CommandName, type Desktop } from './desktop';
import { openRegister } from './shortcuts';

export interface MenuItem {
  label: string;
  shortcut?: string;
  /** No action = shown disabled (feature not built yet, or nothing to act on). */
  action?: () => void;
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

function buildMenus(desk: Desktop): Menu[] {
  const cmds = desk.commands(desk.activeId);
  const cmd = (name: CommandName) => (cmds[name] ? () => desk.run(name) : undefined);
  return [
    { label: '&File', items: [{ label: '&Back Up...' }] },
    {
      label: '&Edit',
      items: [
        { label: '&New', shortcut: 'Ctrl+N', action: cmd('new') },
        { label: '&Edit', shortcut: 'Ctrl+E', action: cmd('edit') },
        { label: '&Delete', shortcut: 'Ctrl+D', action: cmd('delete') },
        'sep',
        { label: '&Find...', shortcut: 'Ctrl+F' },
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
        { label: '&Terms List', action: () => desk.open('terms') },
      ],
    },
    {
      label: '&Company',
      items: [
        { label: 'Company &Information...', action: () => desk.open('company') },
        { label: 'Make General &Journal Entries...', action: () => desk.open('journal', { id: null }) },
      ],
    },
    {
      label: 'C&ustomers',
      items: [
        { label: 'Customer:&Job List', shortcut: 'Ctrl+J', action: () => desk.open('customers') },
        'sep',
        { label: 'Create &Invoices', shortcut: 'Ctrl+I' },
        { label: 'Create Credit &Memos/Refunds' },
        { label: 'Create &Statements...' },
        { label: 'Assess Finance &Charges' },
        { label: '&Receive Payments' },
      ],
    },
    {
      label: 'Vend&ors',
      items: [
        { label: '&Vendor List', action: () => desk.open('vendors') },
        'sep',
        { label: 'Create &Purchase Orders' },
        { label: '&Enter Bills' },
        { label: 'Pay &Bills' },
      ],
    },
    {
      label: 'Emplo&yees',
      items: [{ label: '&Employee List', action: () => desk.open('employees') }, 'sep', { label: '&Pay Employees' }],
    },
    {
      label: '&Banking',
      items: [
        { label: '&Write Checks', shortcut: 'Ctrl+W' },
        { label: 'Make &Deposits' },
        { label: '&Transfer Funds' },
        { label: 'Use &Register', shortcut: 'Ctrl+R', action: () => openRegister(desk) },
      ],
    },
    {
      label: '&Reports',
      items: [
        { label: '&Profit && Loss' },
        { label: '&Sales by Customer' },
        { label: 'Sales by &Item' },
        { label: '&Trip Report' },
      ],
    },
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
  ];
}

const enabled = (e: MenuEntry | undefined): e is MenuItem & { action: () => void } =>
  !!e && e !== 'sep' && !!e.action;

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
  const menus = buildMenus(desk);
  const [open, setOpen] = useState<number | null>(null);
  const [item, setItem] = useState(-1);
  const barRef = useRef<HTMLDivElement>(null);

  const openMenu = (i: number) => {
    setOpen(i);
    setItem(firstEnabled(menus[i].items));
  };
  const closeMenu = () => {
    setOpen(null);
    setItem(-1);
  };
  const activate = (entry: MenuEntry | undefined) => {
    if (!enabled(entry)) return;
    closeMenu();
    entry.action();
  };
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
      if (e.key === 'Escape') closeMenu();
      else if (e.key === 'ArrowLeft') openMenu((open - 1 + menus.length) % menus.length);
      else if (e.key === 'ArrowRight') openMenu((open + 1) % menus.length);
      else if (e.key === 'ArrowDown') setItem(step(items, item, 1));
      else if (e.key === 'ArrowUp') setItem(step(items, item < 0 ? items.length : item, -1));
      else if (e.key === 'Enter') activate(items[item]);
      else if (e.altKey && !e.ctrlKey && /^Key[A-Z]$/.test(e.code)) {
        const i = indexByLetter(e.code.slice(3).toLowerCase());
        if (i >= 0) openMenu(i);
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const k = e.key.toLowerCase();
        activate(items.find((x) => x !== 'sep' && parseMnemonic(x.label).key === k));
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
              {m.items.map((x, j) =>
                x === 'sep' ? (
                  <div key={`sep${j}`} className="menu-sep" />
                ) : (
                  <div
                    key={`${j}${x.label}`}
                    role="menuitem"
                    aria-disabled={!x.action}
                    className={`menu-item${x.action ? '' : ' disabled'}${item === j ? ' hot' : ''}`}
                    onMouseEnter={() => x.action && setItem(j)}
                    onClick={() => activate(x)}
                  >
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
      ))}
    </div>
  );
}
