import { openReport } from '../reports/open';
import type { Desktop } from './desktop';
import type { IconName } from './icons';
import { openRegister } from './shortcuts';

/** Something she does all day, reachable from the icon bar and the Company Navigator. */
export interface Activity {
  label: string;
  icon: IconName;
  /** The keyboard way to the same place, shown in the tooltip. */
  keys: string;
  /** What it opens, for the tooltip. */
  what: string;
  run: (desk: Desktop) => void;
}

export const ACTIVITIES = {
  invoice: { label: 'Invoice', icon: 'invoice', keys: 'Ctrl+I', what: 'Create Invoices', run: (d) => d.open('invoice', { id: null }) },
  payment: {
    label: 'Rcv Pmt',
    icon: 'payment',
    keys: 'Alt+U, R',
    what: 'Receive Payments',
    run: (d) => d.open('payment', { id: null }),
  },
  deposit: { label: 'Deposit', icon: 'deposit', keys: 'Alt+B, D', what: 'Make Deposits', run: (d) => d.open('deposit', { id: null }) },
  bill: { label: 'Bill', icon: 'bill', keys: 'Alt+O, E', what: 'Enter Bills', run: (d) => d.open('bill', { id: null }) },
  paybills: { label: 'Pay Bills', icon: 'paybills', keys: 'Alt+O, B', what: 'Pay Bills', run: (d) => d.open('paybills') },
  check: {
    label: 'Check',
    icon: 'check',
    keys: 'Ctrl+W in full screen, or Alt+B, W',
    what: 'Write Checks',
    run: (d) => d.open('check', { id: null }),
  },
  register: { label: 'Reg', icon: 'register', keys: 'Ctrl+R', what: 'Use Register', run: (d) => void openRegister(d) },
  customers: { label: 'Cust', icon: 'customers', keys: 'Ctrl+J', what: 'Customer:Job List', run: (d) => d.open('customers') },
  vendors: { label: 'Vend', icon: 'vendors', keys: 'Alt+L, V', what: 'Vendor List', run: (d) => d.open('vendors') },
  items: { label: 'Item', icon: 'items', keys: 'Alt+L, I', what: 'Item List', run: (d) => d.open('items') },
  accounts: { label: 'Accnt', icon: 'accounts', keys: 'Ctrl+A', what: 'Chart of Accounts', run: (d) => d.open('accounts') },
  reports: { label: 'Reports', icon: 'reports', keys: 'Alt+R, F', what: 'Report Finder', run: (d) => d.open('reportfinder') },
  find: { label: 'Find', icon: 'find', keys: 'Ctrl+F', what: 'Find', run: (d) => d.open('find') },
  backup: { label: 'Backup', icon: 'backup', keys: 'Alt+F, B', what: 'Back Up', run: (d) => d.open('backup') },
  // Navigator only
  statements: {
    label: 'Statements',
    icon: 'statement',
    keys: 'Alt+U, S',
    what: 'Create Statements',
    run: (d) => d.open('statements'),
  },
  finance: {
    label: 'Finance Charges',
    icon: 'finance',
    keys: 'Alt+U, C',
    what: 'Assess Finance Charges',
    run: (d) => d.open('financecharges'),
  },
  creditmemo: {
    label: 'Refunds and Credits',
    icon: 'creditmemo',
    keys: 'Alt+U, M',
    what: 'Create Credit Memos/Refunds',
    run: (d) => d.open('creditmemo', { id: null }),
  },
  po: {
    label: 'Purchase Orders',
    icon: 'po',
    keys: 'Alt+O, P',
    what: 'Create Purchase Orders',
    run: (d) => d.open('purchaseorder', { id: null }),
  },
  transfer: {
    label: 'Transfer Funds',
    icon: 'transfer',
    keys: 'Alt+B, T',
    what: 'Transfer Funds Between Accounts',
    run: (d) => d.open('transfer', { id: null }),
  },
  paycheck: {
    label: 'Pay Employees',
    icon: 'employees',
    keys: 'Alt+Y, P',
    what: 'Enter Paycheck',
    run: (d) => d.open('paycheck', { id: null }),
  },
  pl: {
    label: 'Profit & Loss',
    icon: 'pl',
    keys: 'Alt+R, then Company & Financial',
    what: 'Profit & Loss report',
    run: (d) => openReport(d, 'pl_standard'),
  },
  trip: {
    label: 'Trip Report',
    icon: 'trip',
    keys: 'Alt+R, T',
    what: 'Trip Report, this month',
    run: (d) => openReport(d, 'trip_report', { date: 'this_month', mode: 'detail' }),
  },
  salescust: {
    label: 'Sales by Customer',
    icon: 'salescust',
    keys: 'Alt+R, then Sales',
    what: 'Sales by Customer Summary report',
    run: (d) => openReport(d, 'sales_by_customer_summary'),
  },
  aging: {
    label: 'A/R Aging',
    icon: 'aging',
    keys: 'Alt+R, then Customers & Receivables',
    what: 'A/R Aging Summary report',
    run: (d) => openReport(d, 'ar_aging_summary'),
  },
} satisfies Record<string, Activity>;

export type ActivityId = keyof typeof ACTIVITIES;

/** "Create Invoices (Ctrl+I)" */
export const activityTitle = (a: Activity) => `${a.what} (${a.keys})`;
