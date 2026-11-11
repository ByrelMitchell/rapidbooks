import type { ComponentType } from 'react';
import { CompanyInfo } from '../forms/CompanyInfo';
import { JournalEntry } from '../forms/JournalEntry';
import { AccountDialog } from '../lists/AccountDialog';
import { ChartOfAccounts } from '../lists/ChartOfAccounts';
import { Register } from '../lists/Register';

/** What every window component receives. */
export interface WinProps {
  winId: string;
  props: Record<string, unknown>;
}

export interface WindowDef {
  component: ComponentType<WinProps>;
  title: string;
  width: number; // rem
  height?: number; // rem; omitted = fit the content (dialogs)
}

export type Registry = Record<string, WindowDef>;

export const registry: Registry = {
  accounts: { component: ChartOfAccounts, title: 'Chart of Accounts', width: 46, height: 30 },
  account: { component: AccountDialog, title: 'New Account', width: 34 },
  register: { component: Register, title: 'Register', width: 78, height: 30 },
  journal: { component: JournalEntry, title: 'Make General Journal Entries', width: 56 },
  company: { component: CompanyInfo, title: 'Company Information', width: 36 },
};
