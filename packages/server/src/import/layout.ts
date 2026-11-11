// Every assumption the history importer makes about the layout of QuickBooks report
// exports lives in this file, so that when her real files arrive the adjustments are
// made here and nowhere else. docs/IMPORT.md lists the ones not yet checked against a
// real export ("Not yet checked").

/** Normalise a column header or type name: lower case, letters and digits only. "P. O. #" -> "po". */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Journal report columns, by our field name, with the header spellings accepted for each
 * (already normalised). A column that is not found is simply not used.
 */
export const JOURNAL_COLUMNS = {
  trans: ['trans', 'transno', 'transnum', 'transnumber', 'transid'],
  type: ['type', 'transtype', 'transactiontype'],
  date: ['date', 'transdate'],
  num: ['num', 'number', 'no', 'refno', 'ref'],
  name: ['name', 'payee', 'receivedfrom'],
  source: ['sourcename'],
  memo: ['memo'],
  account: ['account', 'accountname', 'acct', 'splitaccount'],
  debit: ['debit', 'debits', 'dr'],
  credit: ['credit', 'credits', 'cr'],
  amount: ['amount'], // one signed column instead of Debit/Credit: debit positive
  item: ['item'],
  itemDesc: ['itemdescription', 'itemdesc', 'description'],
  qty: ['qty', 'quantity'],
  price: ['salesprice', 'rate', 'price', 'unitprice', 'cost'],
  clr: ['clr', 'cleared', 'clrd'],
  po: ['po', 'pono', 'ponumber'],
  terms: ['terms'],
  dueDate: ['duedate', 'due'],
  shipDate: ['shipdate'],
  via: ['via', 'shipvia'],
  openBalance: ['openbalance', 'openbal'],
  paid: ['paid', 'paidstatus'],
  address: ['nameaddress', 'address', 'billto'],
  street1: ['namestreet1', 'street1'],
  street2: ['namestreet2', 'street2'],
  city: ['namecity', 'city'],
  state: ['namestate', 'state'],
  zip: ['namezip', 'zip'],
  payMeth: ['paymeth', 'paymentmethod', 'paymethod'],
  billingStatus: ['billingstatus'],
} as const;
export type JournalField = keyof typeof JOURNAL_COLUMNS;

/** A row is the Journal's header row when it has an Account column, an amount column and a Type or Date column. */
export const JOURNAL_HEADER_REQUIRED: JournalField[][] = [['account'], ['debit', 'credit', 'amount'], ['type', 'date']];

/** Columns of the verification reports (Open Invoices, Unpaid Bills, aging summaries, Trial Balance). */
export const VERIFY_COLUMNS = {
  type: ['type', 'transtype'],
  date: ['date'],
  num: ['num', 'number', 'no', 'refno'],
  name: ['name', 'customer', 'vendor', 'customerjob'],
  account: ['account', 'accountname'],
  openBalance: ['openbalance', 'openbal', 'balance'],
  amount: ['amount', 'origamount'],
  debit: ['debit'],
  credit: ['credit'],
  total: ['total'],
  current: ['current'],
} as const;

/**
 * QuickBooks transaction types, normalised, mapped to RapidBooks types. Anything else
 * that posts (Sales Receipt, Credit Card Charge, Statement Charge, Item Receipt, Sales
 * Tax Payment, Inventory Adjust, YTD Adjust...) is imported as a journal-style
 * transaction whose type is QuickBooks' own type name, locked.
 */
export const TYPE_MAP: Record<string, { type: string; payMethod?: string; financeCharge?: boolean }> = {
  invoice: { type: 'INVOICE' },
  inv: { type: 'INVOICE' },
  financecharge: { type: 'INVOICE', financeCharge: true },
  financechrg: { type: 'INVOICE', financeCharge: true },
  creditmemo: { type: 'CREDITMEMO' },
  credmem: { type: 'CREDITMEMO' },
  payment: { type: 'PAYMENT' },
  pmt: { type: 'PAYMENT' },
  deposit: { type: 'DEPOSIT' },
  dep: { type: 'DEPOSIT' },
  generaljournal: { type: 'GENJRNL' },
  genjrnl: { type: 'GENJRNL' },
  check: { type: 'CHECK' },
  chk: { type: 'CHECK' },
  liabilitycheck: { type: 'CHECK' },
  liabchk: { type: 'CHECK' },
  bill: { type: 'BILL' },
  credit: { type: 'BILLCREDIT' },
  billcred: { type: 'BILLCREDIT' },
  billpmtcheck: { type: 'BILLPMT', payMethod: 'check' },
  billpmtccard: { type: 'BILLPMT', payMethod: 'other' },
  billpmt: { type: 'BILLPMT', payMethod: 'check' },
  transfer: { type: 'TRANSFER' },
  transfr: { type: 'TRANSFER' },
  paycheck: { type: 'PAYCHECK' },
  paychk: { type: 'PAYCHECK' },
};

/** Text in a Clr column that means "not cleared". Anything else that is not blank means cleared. */
export const NOT_CLEARED = new Set(['', 'no', 'n', 'false', '0']);

/** Text in a Paid column meaning the document is fully paid. */
export const PAID_VALUES = new Set(['paid', 'yes', 'y', 'closed']);

/** A cell that marks the report's grand total row. */
export const GRAND_TOTAL = /^total$/i;

/** Labels of subtotal rows in grouped reports ("Total Baker Mfg", "Total Income"). */
export const SUBTOTAL_LABEL = /^total\s/i;

/** Rows in a Profit & Loss export that are computed, not accounts. */
export const PL_COMPUTED = /^(gross profit|net ordinary income|net other income|net income|ordinary income\/expense|other income\/expense)$/i;
export const PL_NET_INCOME = /^net income$/i;

/** A parent account's own amount in a Profit & Loss export: "Utilities - Other". */
export const PARENT_OTHER = /\s+-\s+other$/i;

/** An account number in front of the name when account numbers are turned on: "6100 · Rent". */
export const ACCOUNT_NUMBER_PREFIX = /^\s*[0-9][\w.-]*\s+·\s+/;

/** Two-digit years: 00-69 are 2000-2069, 70-99 are 1970-1999. */
export const PIVOT_YEAR = 70;

/**
 * Column headers of a period in a Profit & Loss export: "Jan - Dec 25", "Jan - Dec 2025",
 * "Jan 1 - Dec 31, 25", "2025", "TOTAL" (the whole report period).
 */
export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
