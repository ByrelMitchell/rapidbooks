import type { AccountTypeCode, ItemTypeCode, NameKind } from '@rapidbooks/shared';
import { api, errorMessage } from '../api';
import type { Desktop } from '../shell/desktop';

/** Props a Combo needs for QuickBooks "not in the list" handling: spread them onto it. */
export interface QuickFill {
  listName: string;
  onNotFound: (text: string) => Promise<number | null>;
}

/** Window kind for each name kind's list and edit dialog. */
export const NAME_WINDOWS: Record<NameKind, { listName: string; list: string; dialog: string }> = {
  // Ctrl+L on a customer or vendor field opens the Customer / Vendor Center (QuickBooks 2013 has no separate lists).
  customer: { listName: 'Customer:Job', list: 'customers', dialog: 'customer' },
  vendor: { listName: 'Vendor', list: 'vendors', dialog: 'vendor' },
  employee: { listName: 'Employee', list: 'employees', dialog: 'employee' },
  other: { listName: 'Other Name', list: 'othernames', dialog: 'othername' },
};

/** Ctrl+L: the list window for a Combo's listName. */
export const LIST_WINDOWS: Record<string, string> = {
  Account: 'accounts',
  Item: 'items',
  Terms: 'terms',
  'Payroll Item': 'payrollitems',
  ...Object.fromEntries(Object.values(NAME_WINDOWS).map((w) => [w.listName, w.list])),
};

type Choice = 'quick' | 'setup' | null;

/** `"<text>" is not in the <List> list.`  Quick Add / Set Up / Cancel. */
async function askNotFound(d: Desktop, text: string, listName: string, canQuickAdd: boolean): Promise<Choice> {
  const buttons = canQuickAdd ? ['&Quick Add', '&Set Up', '&Cancel'] : ['&Set Up', '&Cancel'];
  const i = await d.messageBox(`"${text}" is not in the ${listName} list.`, {
    title: `${listName} Not Found`,
    icon: 'question',
    buttons,
  });
  if (canQuickAdd) return i === 0 ? 'quick' : i === 1 ? 'setup' : null;
  return i === 0 ? 'setup' : null;
}

/**
 * "Parent:Child" typed into a field: the child's name and the parent's id, when the
 * parent is on the list (so Quick Add makes a job, a subaccount or a subitem).
 */
async function splitPath(path: string, text: string): Promise<{ name: string; parentId: number | null }> {
  const at = text.lastIndexOf(':');
  if (at < 0) return { name: text, parentId: null };
  const parentName = text.slice(0, at).trim().toLowerCase();
  const name = text.slice(at + 1).trim();
  try {
    const rows = await api.get<{ id: number; full_name: string }[]>(path);
    const parent = rows.find((r) => r.full_name.toLowerCase() === parentName);
    return { name, parentId: parent ? parent.id : null };
  } catch {
    return { name, parentId: null };
  }
}

async function quickAdd(d: Desktop, path: string, body: object, what: string): Promise<number | null> {
  try {
    const { id } = await api.post<{ id: number }>(path, body);
    d.refresh();
    d.setStatus(`${what} added.`);
    return id;
  } catch (e) {
    await d.alert(errorMessage(e));
    return null;
  }
}

/** Customers, vendors, employees or other names. Quick Add makes the name with just its name (a job for "Customer:Job"). */
export function nameQuickFill(d: Desktop, kind: NameKind): QuickFill {
  const w = NAME_WINDOWS[kind];
  return {
    listName: w.listName,
    onNotFound: async (text) => {
      const choice = await askNotFound(d, text, w.listName, true);
      if (!choice) return null;
      const { name, parentId } =
        kind === 'customer' ? await splitPath('/api/names?kind=customer', text) : { name: text, parentId: null };
      if (choice === 'quick') {
        return quickAdd(d, '/api/names', { kind, name, parent_id: parentId }, `"${name}"`);
      }
      return d.openForResult(w.dialog, { id: null, name, parentId });
    },
  };
}

/** Terms. Quick Add makes terms with that name, due on receipt. */
export function termsQuickFill(d: Desktop): QuickFill {
  return {
    listName: 'Terms',
    onNotFound: async (text) => {
      const choice = await askNotFound(d, text, 'Terms', true);
      if (choice === 'quick') return quickAdd(d, '/api/terms', { name: text }, `Terms "${text}"`);
      if (choice === 'setup') return d.openForResult('term', { id: null, name: text });
      return null;
    },
  };
}

/** Accounts. An account needs a type, so there is only Set Up (optionally with the type preset). */
export function accountQuickFill(d: Desktop, preset: { type?: AccountTypeCode } = {}): QuickFill {
  return {
    listName: 'Account',
    onNotFound: async (text) => {
      if ((await askNotFound(d, text, 'Account', false)) !== 'setup') return null;
      const { name, parentId } = await splitPath('/api/accounts', text);
      return d.openForResult('account', { id: null, name, parentId, type: preset.type });
    },
  };
}

/** Items. An item needs a type, so there is only Set Up (optionally with the type preset). */
export function itemQuickFill(d: Desktop, preset: { type?: ItemTypeCode } = {}): QuickFill {
  return {
    listName: 'Item',
    onNotFound: async (text) => {
      if ((await askNotFound(d, text, 'Item', false)) !== 'setup') return null;
      const { name, parentId } = await splitPath('/api/items', text);
      return d.openForResult('item', { id: null, name, parentId, type: preset.type });
    },
  };
}
