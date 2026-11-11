import type { Report, ReportDef } from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { auditTrail, DETAIL_COLUMNS, generalLedger, journal, JOURNAL_COLUMNS, profitAndLossDetail, quickReport, TXN_LIST_COLUMNS, txnDetailByAccount, txnListByDate } from './accountant';
import { agingDetail, agingSummary, balanceDetail, BALANCE_DETAIL_COLUMNS, balanceSummary, OPEN_ITEM_COLUMNS, openByName } from './balances';
import { checkDetail, clearedListing, depositDetail, missingChecks } from './banking';
import { finish, P, parseParams, type Def } from './engine';
import { balanceSheet, profitAndLoss, profitAndLossByMonth, trialBalance } from './financial';
import { accountListing, CONTACT_COLUMNS, contactList, itemPriceList, payrollDetail, payrollSummaryReport, termsListing } from './lists';
import { purchasesByItemDetail, purchasesByItemSummary, purchasesByVendorDetail, purchasesByVendorSummary, openPurchaseOrders, PURCH_DETAIL_COLUMNS } from './purchases';
import { salesByCustomerDetail, salesByCustomerSummary, SALES_DETAIL_COLUMNS, salesByItemDetail, salesByItemSummary, tripReport } from './sales';

// Every report: its id, title, menu group, parameters with defaults, and columns.

const fixed = { columns: [], default_columns: [] };
const custom = (columns: Def['columns'], defaults: string[]) => ({ columns, default_columns: defaults });
const BANKS = ['BANK', 'CC'];
const INCLUDE_INACTIVE = P.bool('include_inactive', 'Include inactive');

export const REPORTS: Def[] = [
  // Company & Financial
  { id: 'pl_standard', title: 'Profit & Loss', group: 'Company & Financial', description: 'Income and expenses by account for a period, down to net income.', params: [P.range('this_fiscal_year_to_date')], ...fixed, run: profitAndLoss },
  { id: 'pl_by_month', title: 'Profit & Loss by Month', group: 'Company & Financial', description: 'The Profit & Loss with one column per month and a total.', params: [P.range('this_fiscal_year_to_date')], ...fixed, run: profitAndLossByMonth },
  {
    id: 'pl_detail', title: 'Profit & Loss Detail', group: 'Company & Financial', description: 'Every transaction behind the Profit & Loss, by account.',
    params: [P.range('this_fiscal_year_to_date'), P.accounts(['INC', 'COGS', 'EXP', 'OINC', 'OEXP']), P.names(), P.types(), P.columns(), P.sort()],
    ...custom(DETAIL_COLUMNS, ['type', 'date', 'num', 'name', 'memo', 'split', 'amount', 'balance']), run: profitAndLossDetail,
  },
  { id: 'balance_sheet', title: 'Balance Sheet', group: 'Company & Financial', description: 'Assets, liabilities and equity as of a date.', params: [P.asOf()], ...fixed, run: balanceSheet },
  { id: 'trial_balance', title: 'Trial Balance', group: 'Company & Financial', description: 'Every account balance as debit or credit as of a date; income and expenses for the fiscal year to date.', params: [P.asOf()], ...fixed, run: trialBalance },

  // Customers & Receivables
  { id: 'ar_aging_summary', title: 'A/R Aging Summary', group: 'Customers & Receivables', description: 'What each customer owes, by days past due.', params: [P.asOf(), P.names('customer', 'Customers')], ...fixed, run: agingSummary('AR') },
  { id: 'ar_aging_detail', title: 'A/R Aging Detail', group: 'Customers & Receivables', description: 'Open invoices, credits and payments grouped by days past due.', params: [P.asOf(), P.names('customer', 'Customers'), P.columns(), P.sort()], ...custom(OPEN_ITEM_COLUMNS, ['type', 'date', 'num', 'po_no', 'name', 'terms', 'due_date', 'aging', 'open_balance']), run: agingDetail('AR') },
  { id: 'open_invoices', title: 'Open Invoices', group: 'Customers & Receivables', description: 'Unpaid invoices and unapplied credits, by customer.', params: [P.asOf(), P.names('customer', 'Customers'), P.columns(), P.sort()], ...custom(OPEN_ITEM_COLUMNS, ['type', 'date', 'num', 'po_no', 'terms', 'due_date', 'aging', 'open_balance']), run: openByName('AR') },
  { id: 'customer_balance_summary', title: 'Customer Balance Summary', group: 'Customers & Receivables', description: 'Each customer\'s balance as of a date.', params: [P.asOf(), P.names('customer', 'Customers')], ...fixed, run: balanceSummary('AR') },
  { id: 'customer_balance_detail', title: 'Customer Balance Detail', group: 'Customers & Receivables', description: 'Every A/R transaction per customer with a running balance.', params: [P.range('all'), P.names('customer', 'Customers'), P.columns(), P.sort()], ...custom(BALANCE_DETAIL_COLUMNS, ['type', 'date', 'num', 'memo', 'account', 'amount', 'balance']), run: balanceDetail('AR') },

  // Sales
  { id: 'sales_by_customer_summary', title: 'Sales by Customer Summary', group: 'Sales', description: 'Sales per customer and job.', params: [P.range(), P.names('customer', 'Customers'), P.items()], ...fixed, run: salesByCustomerSummary },
  { id: 'sales_by_customer_detail', title: 'Sales by Customer Detail', group: 'Sales', description: 'Every sales line per customer and job.', params: [P.range(), P.names('customer', 'Customers'), P.items(), P.columns(), P.sort()], ...custom(SALES_DETAIL_COLUMNS, ['type', 'date', 'num', 'memo', 'customer', 'item', 'qty', 'rate', 'amount', 'balance']), run: salesByCustomerDetail },
  { id: 'sales_by_item_summary', title: 'Sales by Item Summary', group: 'Sales', description: 'Quantity, amount, share of sales and average price per item.', params: [P.range(), P.names('customer', 'Customers'), P.items()], ...fixed, run: salesByItemSummary },
  {
    id: 'sales_by_item_detail', title: 'Sales by Item Detail', group: 'Sales', description: 'Every sales line per item; choose filters, columns and how to total (the customizable item report).',
    params: [P.range(), P.names('customer', 'Customers'), P.items(), P.choice('total_by', 'Total by', [['item', 'Item'], ['customer', 'Customer'], ['month', 'Month'], ['none', 'Nothing (list)']], 'item'), P.columns(), P.sort()],
    ...custom(SALES_DETAIL_COLUMNS, ['type', 'date', 'num', 'memo', 'customer', 'qty', 'rate', 'amount', 'balance']), run: salesByItemDetail,
  },
  {
    id: 'trip_report', title: 'Trip Report', group: 'Sales', description: 'Delivery trips: one per customer per invoice date, leaving out customers who pick up.',
    params: [P.range('this_month'), P.names('customer', 'Customers'), P.choice('mode', 'Show', [['detail', 'Trips (detail)'], ['by_customer', 'Trips per customer'], ['by_month', 'Trips per month'], ['grid', 'Customer by month']], 'detail'), P.bool('include_picks_up', 'Include customers who pick up')],
    ...fixed, run: tripReport,
  },

  // Vendors & Payables
  { id: 'ap_aging_summary', title: 'A/P Aging Summary', group: 'Vendors & Payables', description: 'What is owed to each vendor, by days past due.', params: [P.asOf(), P.names('vendor', 'Vendors')], ...fixed, run: agingSummary('AP') },
  { id: 'ap_aging_detail', title: 'A/P Aging Detail', group: 'Vendors & Payables', description: 'Open bills and credits grouped by days past due.', params: [P.asOf(), P.names('vendor', 'Vendors'), P.columns(), P.sort()], ...custom(OPEN_ITEM_COLUMNS, ['type', 'date', 'num', 'name', 'terms', 'due_date', 'aging', 'open_balance']), run: agingDetail('AP') },
  { id: 'unpaid_bills', title: 'Unpaid Bills Detail', group: 'Vendors & Payables', description: 'Unpaid bills and unapplied credits, by vendor.', params: [P.asOf(), P.names('vendor', 'Vendors'), P.columns(), P.sort()], ...custom(OPEN_ITEM_COLUMNS, ['type', 'date', 'num', 'due_date', 'aging', 'open_balance']), run: openByName('AP') },
  { id: 'vendor_balance_summary', title: 'Vendor Balance Summary', group: 'Vendors & Payables', description: 'What is owed to each vendor as of a date.', params: [P.asOf(), P.names('vendor', 'Vendors')], ...fixed, run: balanceSummary('AP') },
  { id: 'vendor_balance_detail', title: 'Vendor Balance Detail', group: 'Vendors & Payables', description: 'Every A/P transaction per vendor with a running balance.', params: [P.range('all'), P.names('vendor', 'Vendors'), P.columns(), P.sort()], ...custom(BALANCE_DETAIL_COLUMNS, ['type', 'date', 'num', 'memo', 'account', 'amount', 'balance']), run: balanceDetail('AP') },
  { id: 'vendor_contact_list', title: 'Vendor Contact List', group: 'Vendors & Payables', description: 'Vendors with contacts, phone numbers and balances.', params: [INCLUDE_INACTIVE, P.columns(), P.sort()], ...custom(CONTACT_COLUMNS, ['name', 'contact', 'phone', 'fax', 'email', 'bill_addr', 'account_no', 'balance']), run: contactList('vendor') },

  // Purchases
  { id: 'purchases_by_vendor_summary', title: 'Purchases by Vendor Summary', group: 'Purchases', description: 'Item purchases per vendor (bills, credits and checks).', params: [P.range(), P.names(undefined, 'Vendors'), P.items(), P.bool('include_expense_lines', 'Include expense-account lines')], ...fixed, run: purchasesByVendorSummary },
  { id: 'purchases_by_vendor_detail', title: 'Purchases by Vendor Detail', group: 'Purchases', description: 'Every purchase line per vendor.', params: [P.range(), P.names(undefined, 'Vendors'), P.items(), P.bool('include_expense_lines', 'Include expense-account lines'), P.columns(), P.sort()], ...custom(PURCH_DETAIL_COLUMNS, ['type', 'date', 'num', 'memo', 'item', 'qty', 'rate', 'amount', 'balance']), run: purchasesByVendorDetail },
  { id: 'purchases_by_item_summary', title: 'Purchases by Item Summary', group: 'Purchases', description: 'Quantity, amount and average cost per item purchased.', params: [P.range(), P.names(undefined, 'Vendors'), P.items()], ...fixed, run: purchasesByItemSummary },
  { id: 'purchases_by_item_detail', title: 'Purchases by Item Detail', group: 'Purchases', description: 'Every purchase line per item.', params: [P.range(), P.names(undefined, 'Vendors'), P.items(), P.columns(), P.sort()], ...custom(PURCH_DETAIL_COLUMNS, ['type', 'date', 'num', 'memo', 'vendor', 'qty', 'rate', 'amount', 'balance']), run: purchasesByItemDetail },
  { id: 'open_purchase_orders', title: 'Open Purchase Orders', group: 'Purchases', description: 'Purchase orders not yet received.', params: [P.range('all'), P.names('vendor', 'Vendors')], ...fixed, run: openPurchaseOrders },

  // Banking
  { id: 'deposit_detail', title: 'Deposit Detail', group: 'Banking', description: 'Each deposit with the payments and lines in it.', params: [P.range(), P.accounts(BANKS)], ...fixed, run: depositDetail },
  { id: 'check_detail', title: 'Check Detail', group: 'Banking', description: 'Each check, bill payment and paycheck with what it paid for.', params: [P.range(), P.accounts(BANKS)], ...fixed, run: checkDetail },
  { id: 'missing_checks', title: 'Missing Checks', group: 'Banking', description: 'Check numbers in order per bank account, flagging gaps and duplicates.', params: [P.range('all'), P.accounts(BANKS)], ...fixed, run: missingChecks },
  { id: 'bank_cleared', title: 'Cleared and Uncleared Transactions', group: 'Banking', description: 'Cleared balance, uncleared payments and deposits, and register balance, for reconciling by hand.', params: [{ key: 'account_id', label: 'Account', kind: 'account_id', default: null, account_types: BANKS, required: true }, P.asOf()], ...fixed, run: clearedListing },

  // Employees & Payroll
  { id: 'payroll_summary', title: 'Payroll Summary', group: 'Employees & Payroll', description: 'Totals per payroll item and employee (for the quarterly and annual forms).', params: [P.range('this_fiscal_quarter'), P.names('employee', 'Employees'), P.bool('show_hours', 'Show hours')], ...fixed, run: payrollSummaryReport },
  { id: 'payroll_detail', title: 'Payroll Detail', group: 'Employees & Payroll', description: 'Each paycheck\'s lines and net pay.', params: [P.range('this_fiscal_quarter'), P.names('employee', 'Employees')], ...fixed, run: payrollDetail },

  // Lists
  { id: 'customer_contact_list', title: 'Customer Contact List', group: 'Lists', description: 'Customers and jobs with contacts, phone numbers and balances.', params: [INCLUDE_INACTIVE, P.columns(), P.sort()], ...custom(CONTACT_COLUMNS, ['name', 'bill_addr', 'contact', 'phone', 'fax', 'email', 'picks_up', 'balance']), run: contactList('customer') },
  { id: 'item_price_list', title: 'Item Price List', group: 'Lists', description: 'Items with their prices.', params: [INCLUDE_INACTIVE], ...fixed, run: itemPriceList },
  { id: 'account_listing', title: 'Account Listing', group: 'Lists', description: 'The chart of accounts with balances.', params: [INCLUDE_INACTIVE], ...fixed, run: accountListing },
  { id: 'terms_listing', title: 'Terms Listing', group: 'Lists', description: 'Payment terms.', params: [], ...fixed, run: termsListing },

  // Accountant
  { id: 'general_ledger', title: 'General Ledger', group: 'Accountant', description: 'Per account: beginning balance, every transaction with a running balance, ending balance.', params: [P.range('this_month_to_date'), P.accounts(), P.names(), P.types(), P.columns()], ...custom(DETAIL_COLUMNS, ['type', 'date', 'num', 'name', 'memo', 'split', 'debit', 'credit', 'balance']), run: generalLedger },
  { id: 'journal', title: 'Journal', group: 'Accountant', description: 'Every transaction with all its debits and credits (QuickBooks\' Journal layout).', params: [P.range('this_month_to_date'), P.accounts(), P.names(), P.types(), P.columns()], ...custom(JOURNAL_COLUMNS, JOURNAL_COLUMNS.map((c) => c.key)), run: journal },
  { id: 'txn_list_by_date', title: 'Transaction List by Date', group: 'Accountant', description: 'Every transaction in date order.', params: [P.range('this_month_to_date'), P.accounts(), P.names(), P.types(), P.columns(), P.sort()], ...custom(TXN_LIST_COLUMNS, ['type', 'date', 'num', 'name', 'memo', 'account', 'clr', 'split', 'amount']), run: txnListByDate },
  { id: 'txn_detail_by_account', title: 'Transaction Detail by Account', group: 'Accountant', description: 'Every transaction per account with a running balance for the period.', params: [P.range('this_month_to_date'), P.accounts(), P.names(), P.types(), P.columns(), P.sort()], ...custom(DETAIL_COLUMNS, ['type', 'date', 'num', 'name', 'memo', 'clr', 'split', 'amount', 'balance']), run: txnDetailByAccount },
  { id: 'audit_trail', title: 'Audit Trail', group: 'Accountant', description: 'Every change saved, by when it was entered.', params: [P.range('today')], ...fixed, run: auditTrail },
  {
    id: 'quickreport', title: 'QuickReport', group: 'Accountant', description: 'All transactions of one account, name or item (Ctrl+Q).',
    params: [
      P.range('all'),
      { key: 'account_id', label: 'Account', kind: 'account_id', default: null },
      { key: 'name_id', label: 'Name', kind: 'name_id', default: null },
      { key: 'item_id', label: 'Item', kind: 'item_id', default: null },
    ],
    ...fixed, run: quickReport,
  },
];

const byId = new Map(REPORTS.map((r) => [r.id, r]));

/** The registry as served by GET /api/reports (without the code). */
export function listReports(): ReportDef[] {
  return REPORTS.map(({ run: _run, ...d }) => d);
}

export function runReport(db: DB, id: string, query: Record<string, string | undefined>): Report {
  const def = byId.get(id);
  if (!def) throw new AppError(404, 'There is no such report.');
  const p = parseParams(def, query);
  return finish(def, p, def.run(db, p));
}
