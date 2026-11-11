import type { ComponentType } from 'react';
import { CompanyInfo } from '../forms/CompanyInfo';
import { CreateStatements, StatementPreview } from '../forms/CreateStatements';
import { FinanceCharges, FinanceChargeSettingsDialog } from '../forms/FinanceCharges';
import { JournalEntry } from '../forms/JournalEntry';
import { MakeDeposits, PaymentsToDeposit } from '../forms/MakeDeposits';
import { PaymentDiscount, PaymentHistory } from '../forms/PaymentExtras';
import { ReceivePayments } from '../forms/ReceivePayments';
import { ApplyCredits } from '../forms/ApplyCredits';
import { EmailDialog } from '../forms/EmailDialog';
import { PrintForms, SendForms } from '../forms/FormQueues';
import { CreditMemo, Invoice } from '../forms/SalesForm';
import { TxnHistory, TxnJournal } from '../forms/TxnInfo';
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
  // Receive payments, deposits, statements, finance charges
  payment: { component: ReceivePayments, title: 'Receive Payments', width: 60 },
  pmtdiscount: { component: PaymentDiscount, title: 'Discount and Credits', width: 30 },
  pmthistory: { component: PaymentHistory, title: 'Payment History', width: 44, height: 20 },
  deposit: { component: MakeDeposits, title: 'Make Deposits', width: 64 },
  depositpicker: { component: PaymentsToDeposit, title: 'Payments to Deposit', width: 54, height: 24 },
  statements: { component: CreateStatements, title: 'Create Statements', width: 46, height: 36 },
  statementpreview: { component: StatementPreview, title: 'Statement', width: 60, height: 30 },
  financecharges: { component: FinanceCharges, title: 'Assess Finance Charges', width: 52, height: 30 },
  fcsettings: { component: FinanceChargeSettingsDialog, title: 'Finance Charge Settings', width: 34 },
  // Invoices and credit memos, e-mail, print and send queues
  invoice: { component: Invoice, title: 'Create Invoices', width: 64 },
  creditmemo: { component: CreditMemo, title: 'Create Credit Memos/Refunds', width: 64 },
  email: { component: EmailDialog, title: 'Send Form by E-mail', width: 44 },
  sendforms: { component: SendForms, title: 'Select Forms to Send', width: 62, height: 28 },
  printforms: { component: PrintForms, title: 'Select Invoices to Print', width: 52, height: 26 },
  applycredits: { component: ApplyCredits, title: 'Apply Credits', width: 52 },
  txnhistory: { component: TxnHistory, title: 'Transaction History', width: 46, height: 20 },
  txnjournal: { component: TxnJournal, title: 'Transaction Journal', width: 62, height: 20 },
};
