import type { Account } from '@rapidbooks/shared';
import { useEffect, useRef, type RefObject } from 'react';
import { api, errorMessage } from '../api';
import { focusables } from '../util';
import type { CommandName, Desktop } from './desktop';
import type { MenuBarHandle } from './MenuBar';

/** Banking > Use Register (Ctrl+R) when the active window has no register of its own: the first bank account. */
export async function openRegister(desk: Desktop) {
  const cmds = desk.commands(desk.activeId);
  if (cmds.register) {
    cmds.register();
    return;
  }
  try {
    const accounts = await api.get<Account[]>('/api/accounts');
    const bank = accounts.find((a) => a.type === 'BANK' && !a.inactive) ?? accounts.find((a) => a.type === 'BANK');
    if (bank) desk.open('register', { accountId: bank.id });
    else desk.setStatus('There is no bank account yet. Create one in the Chart of Accounts (Ctrl+A).');
  } catch (e) {
    desk.setStatus(errorMessage(e));
  }
}

const NOT_YET: Record<string, string> = {
  KeyI: 'Create Invoices',
  KeyW: 'Write Checks',
  KeyJ: 'The Customer:Job List',
  KeyF: 'Find',
  KeyQ: 'QuickReport',
  KeyY: 'Transaction Journal',
  KeyH: 'Transaction History',
  KeyL: 'Open List',
  KeyP: 'Print',
  KeyG: 'Go to Transfer',
  KeyT: 'The Memorized Transaction List',
  KeyM: 'Memorize Transaction',
};

const CTRL_COMMANDS: Record<string, CommandName> = {
  KeyN: 'new',
  KeyE: 'edit',
  KeyD: 'delete',
  Insert: 'insertLine',
  Delete: 'deleteLine',
  Enter: 'save',
  NumpadEnter: 'save',
};

/**
 * The QuickBooks keyboard shortcuts. One bubble-phase listener on window, so controls
 * that need a key first (an open Combo dropdown eating Esc, a date field eating "+")
 * get it and mark it defaultPrevented.
 */
export function useGlobalShortcuts(desk: Desktop, menuRef: RefObject<MenuBarHandle | null>) {
  const deskRef = useRef(desk);
  deskRef.current = desk;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const d = deskRef.current;
      const ctrl = e.ctrlKey || e.metaKey;
      const code = e.code;

      if (ctrl && !e.altKey) {
        if (code === 'F6') {
          e.preventDefault();
          cycleWindows(d, e.shiftKey ? -1 : 1);
          return;
        }
        if (e.shiftKey) return;
        if (code === 'KeyA') {
          e.preventDefault();
          d.open('accounts');
          return;
        }
        if (code === 'KeyR') {
          e.preventDefault();
          void openRegister(d);
          return;
        }
        const name = CTRL_COMMANDS[code] ?? (e.key === 'Insert' ? 'insertLine' : e.key === 'Delete' ? 'deleteLine' : undefined);
        if (name) {
          e.preventDefault();
          d.run(name);
          return;
        }
        const feature = NOT_YET[code];
        if (feature) {
          e.preventDefault();
          d.setStatus(`${feature} is not available yet.`);
        }
        return;
      }

      if (e.altKey && !ctrl) {
        if (e.key === 'Alt') {
          e.preventDefault();
          return;
        }
        if (!/^Key[A-Z]$/.test(code)) return;
        e.preventDefault();
        if (code === 'KeyS' && d.run('saveClose')) return;
        if (code === 'KeyN' && d.run('saveNew')) return;
        menuRef.current?.openByLetter(code.slice(3));
        return;
      }

      if (e.key === 'Escape' && !e.altKey && !ctrl && !e.shiftKey) {
        if (d.activeId) {
          e.preventDefault();
          d.requestClose(d.activeId);
        }
        return;
      }

      // Tab with focus outside every window (e.g. after clicking the desktop): go to the active window.
      if (e.key === 'Tab' && !ctrl && !e.altKey && d.activeId) {
        const inWindow = (document.activeElement as HTMLElement | null)?.closest('.win');
        if (!inWindow) {
          const frame = document.querySelector('.win.active .win-body');
          const first = focusables(frame)[0];
          if (first) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    // Keep Firefox from showing its own menu bar when Alt is released.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [menuRef]);
}

function cycleWindows(d: Desktop, dir: 1 | -1) {
  const ws = d.windows;
  if (ws.length < 2) return;
  const i = ws.findIndex((w) => w.id === d.activeId);
  const next = ws[(i + dir + ws.length) % ws.length];
  d.focus(next.id);
}
