import type { ComponentType } from 'react';
import { CompanyInfo } from '../forms/CompanyInfo';
import { JournalEntry } from '../forms/JournalEntry';
import { AccountDialog } from '../lists/AccountDialog';
import { ChartOfAccounts } from '../lists/ChartOfAccounts';
import { ItemDialog } from '../lists/ItemDialog';
import { ItemList } from '../lists/ItemList';
import { CustomerDialog, EmployeeDialog, OtherNameDialog, VendorDialog } from '../lists/NameDialog';
import { CustomerList, EmployeeList, OtherNameList, VendorList } from '../lists/NameList';
import { Register } from '../lists/Register';
import { TermsDialog } from '../lists/TermsDialog';
import { TermsList } from '../lists/TermsList';

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
  customers: { component: CustomerList, title: 'Customer:Job List', width: 50, height: 30 },
  vendors: { component: VendorList, title: 'Vendor List', width: 40, height: 28 },
  employees: { component: EmployeeList, title: 'Employee List', width: 40, height: 26 },
  othernames: { component: OtherNameList, title: 'Other Names List', width: 44, height: 26 },
  items: { component: ItemList, title: 'Item List', width: 70, height: 30 },
  terms: { component: TermsList, title: 'Terms List', width: 40, height: 22 },
  customer: { component: CustomerDialog, title: 'New Customer', width: 54 },
  vendor: { component: VendorDialog, title: 'New Vendor', width: 54 },
  employee: { component: EmployeeDialog, title: 'New Employee', width: 50 },
  othername: { component: OtherNameDialog, title: 'New Name', width: 54 },
  item: { component: ItemDialog, title: 'New Item', width: 44 },
  term: { component: TermsDialog, title: 'New Terms', width: 38 },
};
