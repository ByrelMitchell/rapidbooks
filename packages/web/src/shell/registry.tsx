import type { ComponentType } from 'react';
import { CompanyInfo } from '../forms/CompanyInfo';
import { CreateStatements, StatementPreview } from '../forms/CreateStatements';
import { FinanceCharges, FinanceChargeSettingsDialog } from '../forms/FinanceCharges';
import { ImportedTxn } from '../forms/ImportedTxn';
import { JournalEntry } from '../forms/JournalEntry';
import { MakeDeposits, PaymentsToDeposit } from '../forms/MakeDeposits';
import { PaymentDiscount, PaymentHistory } from '../forms/PaymentExtras';
import { ReceivePayments } from '../forms/ReceivePayments';
import { ApplyCreditToInvoices, ApplyCredits } from '../forms/ApplyCredits';
import { IssueRefund } from '../forms/IssueRefund';
import { EmailDialog } from '../forms/EmailDialog';
import { PrintForms, SendForms } from '../forms/FormQueues';
import { CreditMemo, Invoice } from '../forms/SalesForm';
import { TxnHistory, TxnJournal } from '../forms/TxnInfo';
import { BillPayment } from '../forms/BillPayment';
import { EnterBills } from '../forms/EnterBills';
import { PayBills } from '../forms/PayBills';
import { BillCredits, BillDiscount, PoChooser } from '../forms/PurchaseDialogs';
import { PurchaseOrder } from '../forms/PurchaseOrder';
import { Paycheck } from '../forms/Paycheck';
import { PrintChecks } from '../forms/PrintChecks';
import { TransferFunds } from '../forms/TransferFunds';
import { WriteChecks } from '../forms/WriteChecks';
import { PayrollItemDialog, PayrollItemList } from '../lists/PayrollItemList';
import { AccountDialog } from '../lists/AccountDialog';
import { ChangeItemPrices } from '../lists/ChangeItemPrices';
import { ChartOfAccounts } from '../lists/ChartOfAccounts';
import { ItemDialog } from '../lists/ItemDialog';
import { ItemList } from '../lists/ItemList';
import { CustomerDialog, EmployeeDialog, OtherNameDialog, VendorDialog } from '../lists/NameDialog';
import { CustomerCenter, EmployeeCenter, VendorCenter } from '../lists/NameCenter';
import { EmployeeList, OtherNameList } from '../lists/NameList';
import { Register } from '../lists/Register';
import { TermsDialog } from '../lists/TermsDialog';
import { TermsList } from '../lists/TermsList';
import { AboutWindow } from '../admin/AboutWindow';
import { BackupWindow } from '../admin/BackupWindow';
import { FindWindow } from '../reports/FindWindow';
import { IncomeExpenseGraphWindow, SalesGraphWindow } from '../reports/Graphs';
import { MemorizeDialog, MemorizedList } from '../reports/Memorized';
import { ModifyReport } from '../reports/ModifyReport';
import { ReportFinder } from '../reports/ReportFinder';
import { ReportWindow } from '../reports/ReportWindow';
import { KeyboardHelp } from './KeyboardHelp';
import { Navigator } from './Navigator';

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
  /** A main window (form, list, register, report): opens maximized while View > Maximize Windows is on. */
  max?: boolean;
}

export type Registry = Record<string, WindowDef>;

export const registry: Registry = {
  accounts: { component: ChartOfAccounts, title: 'Chart of Accounts', width: 46, height: 30, max: true },
  account: { component: AccountDialog, title: 'New Account', width: 34 },
  register: { component: Register, title: 'Register', width: 78, height: 30, max: true },
  journal: { component: JournalEntry, title: 'Make General Journal Entries', width: 56, max: true },
  // A transaction imported "as posted" from QuickBooks (or a QuickBooks type with no form): its splits.
  imported: { component: ImportedTxn, title: 'Imported Transaction', width: 66, max: true },
  // Company > Navigator (opened at start-up) and Help > Keyboard Shortcuts
  navigator: { component: Navigator, title: 'Home', width: 60, max: true },
  keys: { component: KeyboardHelp, title: 'Keyboard Shortcuts', width: 58, height: 34, max: true },
  company: { component: CompanyInfo, title: 'Company Information', width: 36 },
  customers: { component: CustomerCenter, title: 'Customer Center', width: 76, height: 40, max: true },
  vendors: { component: VendorCenter, title: 'Vendor Center', width: 76, height: 40, max: true },
  employees: { component: EmployeeList, title: 'Employee List', width: 40, height: 26, max: true },
  employeecenter: { component: EmployeeCenter, title: 'Employee Center', width: 76, height: 40, max: true },
  othernames: { component: OtherNameList, title: 'Other Names List', width: 44, height: 26, max: true },
  items: { component: ItemList, title: 'Item List', width: 70, height: 30, max: true },
  itemprices: { component: ChangeItemPrices, title: 'Change Item Prices', width: 70, height: 36, max: true },
  terms: { component: TermsList, title: 'Terms List', width: 40, height: 22, max: true },
  customer: { component: CustomerDialog, title: 'New Customer', width: 68, max: true },
  vendor: { component: VendorDialog, title: 'New Vendor', width: 68, max: true },
  employee: { component: EmployeeDialog, title: 'New Employee', width: 50 },
  othername: { component: OtherNameDialog, title: 'New Name', width: 54 },
  item: { component: ItemDialog, title: 'New Item', width: 54, max: true },
  term: { component: TermsDialog, title: 'New Terms', width: 38 },
  // Receive payments, deposits, statements, finance charges
  payment: { component: ReceivePayments, title: 'Receive Payments', width: 66, max: true },
  pmtdiscount: { component: PaymentDiscount, title: 'Discount and Credits', width: 30 },
  pmthistory: { component: PaymentHistory, title: 'Payment History', width: 44, height: 20 },
  deposit: { component: MakeDeposits, title: 'Make Deposits', width: 64, max: true },
  depositpicker: { component: PaymentsToDeposit, title: 'Payments to Deposit', width: 54, height: 24 },
  statements: { component: CreateStatements, title: 'Create Statements', width: 46, height: 36, max: true },
  statementpreview: { component: StatementPreview, title: 'Statement', width: 60, height: 30, max: true },
  financecharges: { component: FinanceCharges, title: 'Assess Finance Charges', width: 52, height: 30, max: true },
  fcsettings: { component: FinanceChargeSettingsDialog, title: 'Finance Charge Settings', width: 34 },
  // Invoices and credit memos, e-mail, print and send queues
  invoice: { component: Invoice, title: 'Create Invoices', width: 72, max: true },
  creditmemo: { component: CreditMemo, title: 'Create Credit Memos/Refunds', width: 72, max: true },
  email: { component: EmailDialog, title: 'Send Form by E-mail', width: 44 },
  sendforms: { component: SendForms, title: 'Select Forms to Send', width: 62, height: 28, max: true },
  printforms: { component: PrintForms, title: 'Select Invoices to Print', width: 52, height: 26, max: true },
  applycredits: { component: ApplyCredits, title: 'Apply Credits', width: 52 },
  applycredit: { component: ApplyCreditToInvoices, title: 'Apply Credit to Invoices', width: 54 },
  txnhistory: { component: TxnHistory, title: 'Transaction History', width: 46, height: 20 },
  txnjournal: { component: TxnJournal, title: 'Transaction Journal', width: 62, height: 20 },
  // Purchase orders, bills, Pay Bills, bill payments
  purchaseorder: { component: PurchaseOrder, title: 'Create Purchase Orders', width: 64, max: true },
  bill: { component: EnterBills, title: 'Enter Bills', width: 62, max: true },
  pochooser: { component: PoChooser, title: 'Open Purchase Orders', width: 50, height: 22 },
  paybills: { component: PayBills, title: 'Pay Bills', width: 66, max: true },
  billdiscount: { component: BillDiscount, title: 'Discount', width: 32 },
  billcredits: { component: BillCredits, title: 'Credits', width: 52 },
  billpmt: { component: BillPayment, title: 'Bill Payments (Check)', width: 60, max: true },
  // Checks, transfers, payroll
  check: { component: WriteChecks, title: 'Write Checks', width: 60, max: true },
  refund: { component: IssueRefund, title: 'Issue a Refund', width: 44 },
  transfer: { component: TransferFunds, title: 'Transfer Funds Between Accounts', width: 52, max: true },
  paycheck: { component: Paycheck, title: 'Enter Paycheck', width: 66, max: true },
  payrollitems: { component: PayrollItemList, title: 'Payroll Item List', width: 56, height: 24, max: true },
  payrollitem: { component: PayrollItemDialog, title: 'New Payroll Item', width: 44 },
  printchecks: { component: PrintChecks, title: 'Select Checks to Print', width: 54, height: 26, max: true },
  // File > Back Up, Help > About RapidBooks
  backup: { component: BackupWindow, title: 'Back Up', width: 50, height: 32 },
  about: { component: AboutWindow, title: 'About RapidBooks', width: 44 },
  // Reports, Find, graphs (Phase 5)
  report: { component: ReportWindow, title: 'Report', width: 76, height: 40, max: true },
  modifyreport: { component: ModifyReport, title: 'Modify Report', width: 60 },
  reportfinder: { component: ReportFinder, title: 'Report Finder', width: 62, height: 30, max: true },
  memorized: { component: MemorizedList, title: 'Memorized Report List', width: 48, height: 24, max: true },
  memorize: { component: MemorizeDialog, title: 'Memorize Report', width: 34 },
  find: { component: FindWindow, title: 'Find', width: 70, height: 36, max: true },
  salesgraph: { component: SalesGraphWindow, title: 'Sales Graph', width: 76, height: 40, max: true },
  iegraph: { component: IncomeExpenseGraphWindow, title: 'Income and Expense Graph', width: 70, height: 34, max: true },
};
