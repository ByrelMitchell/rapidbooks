import { z } from 'zod';
import { isIsoDate } from './dates';

// Account types, in chart-of-accounts display order.
export const ACCOUNT_TYPES = [
  { code: 'BANK', label: 'Bank', debitNormal: true, balanceSheet: true },
  { code: 'AR', label: 'Accounts Receivable', debitNormal: true, balanceSheet: true },
  { code: 'OCA', label: 'Other Current Asset', debitNormal: true, balanceSheet: true },
  { code: 'FA', label: 'Fixed Asset', debitNormal: true, balanceSheet: true },
  { code: 'AP', label: 'Accounts Payable', debitNormal: false, balanceSheet: true },
  { code: 'CC', label: 'Credit Card', debitNormal: false, balanceSheet: true },
  { code: 'OCL', label: 'Other Current Liability', debitNormal: false, balanceSheet: true },
  { code: 'LTL', label: 'Long Term Liability', debitNormal: false, balanceSheet: true },
  { code: 'EQUITY', label: 'Equity', debitNormal: false, balanceSheet: true },
  { code: 'INC', label: 'Income', debitNormal: false, balanceSheet: false },
  { code: 'COGS', label: 'Cost of Goods Sold', debitNormal: true, balanceSheet: false },
  { code: 'EXP', label: 'Expense', debitNormal: true, balanceSheet: false },
  { code: 'OINC', label: 'Other Income', debitNormal: false, balanceSheet: false },
  { code: 'OEXP', label: 'Other Expense', debitNormal: true, balanceSheet: false },
] as const;

export type AccountTypeCode = (typeof ACCOUNT_TYPES)[number]['code'];
const TYPE_CODES = ACCOUNT_TYPES.map((t) => t.code) as [AccountTypeCode, ...AccountTypeCode[]];

export function accountType(code: string) {
  const t = ACCOUNT_TYPES.find((x) => x.code === code);
  if (!t) throw new Error(`Unknown account type ${code}`);
  return t;
}

export const TXN_TYPE_LABELS: Record<string, string> = {
  GENJRNL: 'General Journal',
  INVOICE: 'Invoice',
  CREDITMEMO: 'Credit Memo',
  PAYMENT: 'Payment',
  DEPOSIT: 'Deposit',
};

/** The short type codes QuickBooks shows in registers and reports. */
export const TXN_TYPE_SHORT: Record<string, string> = {
  GENJRNL: 'GENJRNL',
  INVOICE: 'INV',
  CREDITMEMO: 'CREDMEM',
  PAYMENT: 'PMT',
  DEPOSIT: 'DEP',
};

export const AccountInput = z.object({
  name: z.string().trim().min(1, 'Enter an account name.').refine((s) => !s.includes(':'), {
    message: 'An account name cannot contain a colon.',
  }),
  type: z.enum(TYPE_CODES),
  parent_id: z.number().int().nullable().default(null),
  description: z.string().default(''),
  inactive: z.boolean().default(false),
});
export type AccountInput = z.infer<typeof AccountInput>;

export interface Account {
  id: number;
  name: string;
  full_name: string; // Parent:Child
  type: AccountTypeCode;
  parent_id: number | null;
  depth: number;
  description: string;
  inactive: boolean;
  system_role: string | null;
  balance: number; // cents, debit-positive
}

const IsoDate = z.string().refine(isIsoDate, { message: 'Enter a valid date.' });

// amount is in cents: positive = debit, negative = credit.
export const SplitInput = z.object({
  account_id: z.number().int(),
  amount: z.number().int(),
  name_id: z.number().int().nullable().default(null),
  memo: z.string().default(''),
});
export type SplitInput = z.infer<typeof SplitInput>;

export const GenJrnlInput = z.object({
  type: z.enum(['GENJRNL']),
  date: IsoDate,
  num: z.string().default(''),
  name_id: z.number().int().nullable().default(null),
  memo: z.string().default(''),
  version: z.number().int().optional(), // required when updating
  splits: z.array(SplitInput),
});
export type GenJrnlInput = z.infer<typeof GenJrnlInput>;

const OptionalDate = z
  .string()
  .default('')
  .refine((s) => s === '' || isIsoDate(s), { message: 'Enter a valid date.' });

/** True when n has at most `places` decimal places (allowing for binary floating point). */
export function hasAtMostDecimals(n: number, places: number): boolean {
  const scaled = n * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, Math.abs(scaled) / 1e9);
}

/** A money rate in cents, allowing fractions of a cent down to 0.001 cent ($0.00001). */
export const Rate = z
  .number()
  .finite()
  .refine((n) => hasAtMostDecimals(n, 3), { message: 'A rate can have at most five decimal places of dollars.' })
  .transform((n) => Math.round(n * 1000) / 1000);

/**
 * One line of an invoice or credit memo.
 * - item line: item_id set; amount = qty × rate (rounded half away from zero) unless amount is given.
 *   When qty is null, amount = rate.
 * - SUBTOTAL item: amount is computed by the server (sum of lines above back to the previous subtotal).
 * - DISCOUNT / OTHER_CHARGE item with rate_is_percent: rate is basis points (10% = 1000) of the line
 *   just above (or of that subtotal); the server computes the amount. Discounts are always negative.
 * - description-only line: no item and no account; amount must be 0 (or null).
 * - account line: no item, account_id set (finance charges); posts to that account.
 */
export const LineInput = z.object({
  item_id: z.number().int().nullable().default(null),
  description: z.string().default(''),
  qty: z.number().finite().nullable().default(null),
  rate: Rate.nullable().default(null),
  rate_is_percent: z.boolean().default(false),
  amount: z.number().int().nullable().default(null), // cents; null = computed
  account_id: z.number().int().nullable().default(null),
});
export type LineInput = z.infer<typeof LineInput>;

const SalesDocFields = {
  date: IsoDate,
  num: z.string().default(''),
  name_id: z.number().int().nullable().default(null), // the customer or job; required
  memo: z.string().default(''),
  version: z.number().int().optional(), // required when updating
  ar_account_id: z.number().int().nullable().default(null), // null = the system Accounts Receivable account
  terms_id: z.number().int().nullable().default(null),
  due_date: OptionalDate, // '' = from the terms
  po_number: z.string().default(''),
  ship_date: OptionalDate,
  ship_via: z.string().default(''),
  bill_addr: z.string().default(''),
  ship_addr: z.string().default(''),
  message: z.string().default(''), // customer message, printed on the form
  to_print: z.boolean().default(false),
  to_email: z.boolean().default(false),
  lines: z.array(LineInput).default([]),
};

export const InvoiceInput = z.object({ type: z.enum(['INVOICE']), ...SalesDocFields });
export type InvoiceInput = z.infer<typeof InvoiceInput>;

export const CreditMemoInput = z.object({ type: z.enum(['CREDITMEMO']), ...SalesDocFields });
export type CreditMemoInput = z.infer<typeof CreditMemoInput>;

export const ApplicationInput = z.object({
  txn_id: z.number().int(), // the invoice
  amount: z.number().int().min(0, 'An applied amount cannot be negative.').default(0), // cents of the payment
  discount: z.number().int().min(0, 'A discount cannot be negative.').default(0), // cents
  discount_account_id: z.number().int().nullable().default(null), // required when discount > 0
});
export type ApplicationInput = z.infer<typeof ApplicationInput>;

export const PaymentInput = z.object({
  type: z.enum(['PAYMENT']),
  date: IsoDate,
  num: z.string().default(''), // ignored: a payment's number is its ref_no (check number)
  name_id: z.number().int().nullable().default(null), // the customer or job; required
  memo: z.string().default(''),
  version: z.number().int().optional(),
  amount: z.number().int(), // cents, > 0
  pay_method: z.string().default(''),
  ref_no: z.string().default(''), // check number
  account_id: z.number().int().nullable().default(null), // deposit to; null = Undeposited Funds
  ar_account_id: z.number().int().nullable().default(null),
  applications: z.array(ApplicationInput).default([]),
});
export type PaymentInput = z.infer<typeof PaymentInput>;

export const DepositLineInput = z.object({
  name_id: z.number().int().nullable().default(null), // received from
  account_id: z.number().int().nullable().default(null), // from account; required
  description: z.string().default(''), // memo
  ref_no: z.string().default(''), // check no.
  pay_method: z.string().default(''),
  amount: z.number().int(),
});
export type DepositLineInput = z.infer<typeof DepositLineInput>;

export const DepositInput = z.object({
  type: z.enum(['DEPOSIT']),
  date: IsoDate,
  num: z.string().default(''),
  name_id: z.number().int().nullable().default(null), // unused, kept for symmetry
  memo: z.string().default(''),
  version: z.number().int().optional(),
  account_id: z.number().int().nullable().default(null), // the bank account; required
  payment_ids: z.array(z.number().int()).default([]), // payments taken from Undeposited Funds
  lines: z.array(DepositLineInput).default([]),
});
export type DepositInput = z.infer<typeof DepositInput>;

export const TxnInput = z.discriminatedUnion('type', [
  GenJrnlInput,
  InvoiceInput,
  CreditMemoInput,
  PaymentInput,
  DepositInput,
]);
export type TxnInput = z.infer<typeof TxnInput>;
export type TxnType = TxnInput['type'];

export interface Split {
  id: number;
  seq: number;
  account_id: number;
  amount: number;
  name_id: number | null;
  memo: string;
  cleared: boolean;
}

export interface Txn {
  id: number;
  type: string;
  date: string;
  num: string;
  name_id: number | null;
  memo: string;
  version: number;
  splits: Split[];
}

/** A stored document line (invoice, credit memo or deposit). */
export interface TxnLine {
  id: number;
  seq: number;
  item_id: number | null;
  description: string;
  qty: number | null;
  rate: number | null; // cents (possibly fractional), or basis points when rate_is_percent
  rate_is_percent: boolean;
  amount: number; // cents
  account_id: number | null; // deposit lines and item-less account lines
  name_id: number | null; // deposit lines: received from
  ref_no: string; // deposit lines: check no.
  pay_method: string; // deposit lines
}

/**
 * A link between two transactions.
 *   apply:   payment or credit memo -> invoice (amount applied, plus any early-payment discount)
 *   deposit: deposit -> payment
 */
export interface TxnLink {
  id: number;
  kind: 'apply' | 'deposit';
  txn_id: number; // the transaction at the other end
  type: string;
  num: string;
  date: string;
  name_id: number | null;
  amount: number; // cents
  discount: number; // cents (apply links from payments only)
  discount_account_id: number | null;
}

/** INVOICE, CREDITMEMO, PAYMENT and DEPOSIT as returned by GET /api/txns/:id. */
export interface DocTxn extends Txn {
  type: 'INVOICE' | 'CREDITMEMO' | 'PAYMENT' | 'DEPOSIT';
  ar_account_id: number | null; // INVOICE, CREDITMEMO, PAYMENT
  account_id: number | null; // PAYMENT: deposit to; DEPOSIT: bank account
  terms_id: number | null;
  due_date: string; // '' when not an invoice
  po_number: string;
  ship_date: string;
  ship_via: string;
  bill_addr: string;
  ship_addr: string;
  message: string;
  to_print: boolean;
  to_email: boolean;
  emailed_at: string | null; // 'YYYY-MM-DD HH:MM:SS' UTC
  pay_method: string;
  ref_no: string;
  is_finance_charge: boolean;
  lines: TxnLine[];
  links_out: TxnLink[]; // links from this transaction (payment -> invoices, deposit -> payments)
  links_in: TxnLink[]; // links to this transaction (invoice <- payments/credits, payment <- deposit)
  total: number; // cents: invoice/credit memo total, payment amount, deposit total
  open_balance: number | null; // INVOICE only
  unapplied: number | null; // PAYMENT and CREDITMEMO only
  deposit_id: number | null; // PAYMENT only: the deposit it is in
  payment_ids: number[]; // DEPOSIT only
}

export type AnyTxn = Txn | DocTxn;

/** A transaction found by type and number. */
export interface TxnRef {
  id: number;
  type: string;
  date: string;
  num: string;
  name_id: number | null;
  total: number;
}

export interface OpenInvoice {
  id: number;
  num: string;
  date: string;
  due_date: string;
  name_id: number;
  full_name: string; // Customer:Job
  total: number;
  open_balance: number; // not counting the payment given as payment_id, if any
  applied_by_payment: number; // amount applied by that payment (0 without payment_id)
  discount_by_payment: number;
  is_finance_charge: boolean;
  terms_id: number | null;
  discount_pct: number; // basis points from the invoice terms (0 = none)
  discount_date: string | null; // last day the terms discount applies
}

export interface AvailableCredit {
  id: number;
  type: 'PAYMENT' | 'CREDITMEMO';
  num: string;
  date: string;
  name_id: number;
  full_name: string;
  memo: string;
  total: number;
  unapplied: number;
}

export const ApplyCreditsInput = z.object({
  applications: z
    .array(
      z.object({
        from_txn: z.number().int(), // payment or credit memo
        to_txn: z.number().int(), // invoice
        amount: z.number().int().positive('Enter an amount to apply.'),
      }),
    )
    .min(1, 'Choose a credit to apply.'),
});
export type ApplyCreditsInput = z.infer<typeof ApplyCreditsInput>;

/** An invoice or credit memo in the "to print" / "to e-mail" queues. */
export interface DocSummary {
  id: number;
  type: 'INVOICE' | 'CREDITMEMO';
  num: string;
  date: string;
  name_id: number;
  full_name: string;
  email: string;
  total: number;
  emailed_at: string | null;
}

/** A payment sitting in Undeposited Funds. */
export interface PendingPayment {
  id: number;
  date: string;
  ref_no: string;
  pay_method: string;
  name_id: number;
  full_name: string;
  memo: string;
  amount: number;
  in_this_deposit: boolean; // when listing for an existing deposit
}

// ---------------------------------------------------------------------------
// Finance charges

export const FinanceChargeSettings = z.object({
  annual_rate_bp: z.number().int().min(0).max(100000).default(0), // 18% = 1800
  min_charge: z.number().int().min(0).default(0), // cents
  grace_days: z.number().int().min(0).default(0),
  account_id: z.number().int().nullable().default(null), // finance-charge income account
  charge_on_finance_charges: z.boolean().default(false),
});
export type FinanceChargeSettings = z.infer<typeof FinanceChargeSettings>;

export interface FinanceChargeInvoice {
  txn_id: number;
  num: string;
  date: string;
  due_date: string;
  open_balance: number;
  from_date: string; // charge starts accruing from this date
  days: number;
  charge: number; // cents, unrounded share is rounded per customer
}

export interface FinanceChargePreview {
  name_id: number;
  full_name: string;
  last_fc_date: string | null;
  overdue_balance: number;
  computed: number; // cents, before the minimum
  charge: number; // cents, after the minimum
  invoices: FinanceChargeInvoice[];
}

export const AssessFinanceChargesInput = z.object({
  as_of: IsoDate,
  customer_ids: z.array(z.number().int()).min(1, 'Choose at least one customer to assess.'),
});

// ---------------------------------------------------------------------------
// Statements

export interface StatementRow {
  txn_id: number | null; // null for the balance-forward row
  date: string;
  type: string; // txn type code; '' for balance forward
  num: string;
  name_id: number | null;
  description: string;
  amount: number; // cents, + charges, - payments/credits
  balance: number; // running
}

export interface Aging {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  over_90: number;
}

export interface Statement {
  customer_id: number;
  full_name: string;
  bill_addr: string;
  from: string;
  to: string; // the statement date
  balance_forward: number;
  rows: StatementRow[]; // transactions in range, oldest first, with running balance
  ending_balance: number; // the amount due
  aging: Aging; // sums to ending_balance
}

export interface StatementCustomer {
  customer_id: number;
  full_name: string;
  balance: number; // as of the statement date
  has_activity: boolean;
}

// ---------------------------------------------------------------------------
// Email

export interface EmailDraft {
  to: string;
  cc: string;
  subject: string;
  body: string;
  attachment_name: string; // e.g. "Invoice 1234.pdf"
}

export const SendEmailInput = z.object({
  txn_id: z.number().int(),
  to: z.string().trim().min(1, 'Enter an e-mail address to send to.'),
  cc: z.string().default(''),
  subject: z.string().default(''),
  body: z.string().default(''),
});
export type SendEmailInput = z.infer<typeof SendEmailInput>;

export interface EmailBatchResult {
  txn_id: number;
  num: string;
  ok: boolean;
  error: string | null;
}

export const EmailTemplates = z.object({
  invoice_subject: z.string(),
  invoice_body: z.string(),
  creditmemo_subject: z.string(),
  creditmemo_body: z.string(),
});
export type EmailTemplates = z.infer<typeof EmailTemplates>;

export interface RegisterRow {
  split_id: number;
  txn_id: number;
  date: string;
  num: string;
  type: string;
  name: string | null;
  memo: string;
  amount: number; // debit-positive
  cleared: boolean;
  other_account_id: number | null; // null when the transaction has more than two splits
  balance: number; // running, debit-positive
}

export type CompanyInfo = Record<string, string>;
export const COMPANY_FIELDS = [
  ['name', 'Company Name'],
  ['address', 'Address'],
  ['phone', 'Phone #'],
  ['fax', 'Fax #'],
  ['email', 'E-mail'],
  ['website', 'Web Site'],
  ['ein', 'Federal Employer ID'],
] as const;

// ---------------------------------------------------------------------------
// Lists: names (customers and jobs, vendors, employees, other names), terms, items

export const NAME_KINDS = [
  { code: 'customer', label: 'Customer' },
  { code: 'vendor', label: 'Vendor' },
  { code: 'employee', label: 'Employee' },
  { code: 'other', label: 'Other Name' },
] as const;
export type NameKind = (typeof NAME_KINDS)[number]['code'];
const NAME_KIND_CODES = NAME_KINDS.map((k) => k.code) as [NameKind, ...NameKind[]];

const OptionalIsoDate = z
  .string()
  .default('')
  .refine((s) => s === '' || isIsoDate(s), { message: 'Enter a valid date.' });

export const NameInput = z.object({
  kind: z.enum(NAME_KIND_CODES),
  name: z.string().trim().min(1, 'Enter a name.').refine((s) => !s.includes(':'), {
    message: 'A name cannot contain a colon.',
  }),
  parent_id: z.number().int().nullable().default(null), // customers only: the customer a job belongs to
  company: z.string().default(''),
  salutation: z.string().default(''), // Mr./Ms.
  first_name: z.string().default(''),
  middle_init: z.string().default(''),
  last_name: z.string().default(''),
  contact: z.string().default(''),
  alt_contact: z.string().default(''),
  phone: z.string().default(''),
  alt_phone: z.string().default(''),
  fax: z.string().default(''),
  email: z.string().default(''),
  bill_addr: z.string().default(''), // lines separated by \n
  ship_addr: z.string().default(''),
  notes: z.string().default(''),
  account_no: z.string().default(''), // the number this customer/vendor uses for the company
  terms_id: z.number().int().nullable().default(null),
  credit_limit: z.number().int().nonnegative('The credit limit cannot be negative.').nullable().default(null), // cents
  picks_up: z.boolean().default(false), // customer collects; left out of trip reports
  print_as: z.string().default(''), // vendors: name printed on checks
  tax_id: z.string().default(''), // vendors: tax ID for 1099s
  is_1099: z.boolean().default(false), // vendors
  ssn: z.string().default(''), // employees
  hire_date: OptionalIsoDate, // employees; '' when unknown
  release_date: OptionalIsoDate, // employees
  inactive: z.boolean().default(false),
});
export type NameInput = z.infer<typeof NameInput>;

export interface Name extends NameInput {
  id: number;
  full_name: string; // Customer:Job
  depth: number;
  /**
   * Cents. Customers: open receivable (A/R, debit-positive), including their jobs.
   * Vendors: open payable (A/P, credit shown positive). Others: 0.
   */
  balance: number;
}

export const TermsInput = z.object({
  name: z.string().trim().min(1, 'Enter a name for the terms.'),
  net_days: z.number().int().min(0, 'Net due days cannot be negative.').default(0),
  discount_pct: z.number().int().min(0).max(10000, 'The discount cannot be more than 100%.').default(0), // basis points: 2% = 200
  discount_days: z.number().int().min(0, 'Discount days cannot be negative.').default(0),
  inactive: z.boolean().default(false),
});
export type TermsInput = z.infer<typeof TermsInput>;

export interface Terms extends TermsInput {
  id: number;
}

// Item types, in item-list display order (as QuickBooks lists them).
export const ITEM_TYPES = [
  { code: 'SERVICE', label: 'Service', needsAccount: true, hasRate: true, allowsPercent: false },
  { code: 'PART', label: 'Non-inventory Part', needsAccount: true, hasRate: true, allowsPercent: false },
  { code: 'OTHER_CHARGE', label: 'Other Charge', needsAccount: true, hasRate: true, allowsPercent: true },
  { code: 'SUBTOTAL', label: 'Subtotal', needsAccount: false, hasRate: false, allowsPercent: false },
  { code: 'GROUP', label: 'Group', needsAccount: false, hasRate: false, allowsPercent: false },
  { code: 'DISCOUNT', label: 'Discount', needsAccount: true, hasRate: true, allowsPercent: true },
] as const;
export type ItemTypeCode = (typeof ITEM_TYPES)[number]['code'];
const ITEM_TYPE_CODES = ITEM_TYPES.map((t) => t.code) as [ItemTypeCode, ...ItemTypeCode[]];

export function itemType(code: string) {
  const t = ITEM_TYPES.find((x) => x.code === code);
  if (!t) throw new Error(`Unknown item type ${code}`);
  return t;
}

export const GroupMemberInput = z.object({
  item_id: z.number().int(),
  qty: z.number().finite().default(1),
});
export type GroupMemberInput = z.infer<typeof GroupMemberInput>;

export const ItemInput = z.object({
  name: z.string().trim().min(1, 'Enter an item name.').refine((s) => !s.includes(':'), {
    message: 'An item name cannot contain a colon.',
  }),
  type: z.enum(ITEM_TYPE_CODES),
  parent_id: z.number().int().nullable().default(null),
  description: z.string().default(''),
  /**
   * Cents, or basis points when rate_is_percent (10% = 1000).
   * Discount items hold the discount as a positive number; they always subtract.
   * Always 0 for SUBTOTAL and GROUP.
   */
  rate: Rate.default(0), // money rates may hold fractions of a cent (at most 3 decimals: $0.0375 = 3.75)
  rate_is_percent: z.boolean().default(false), // DISCOUNT and OTHER_CHARGE only
  account_id: z.number().int().nullable().default(null), // required unless SUBTOTAL or GROUP
  inactive: z.boolean().default(false),
  members: z.array(GroupMemberInput).default([]), // GROUP only, in order
});
export type ItemInput = z.infer<typeof ItemInput>;

export interface GroupMember {
  item_id: number;
  qty: number;
  seq: number;
}

export interface Item extends Omit<ItemInput, 'members'> {
  id: number;
  full_name: string; // Parent:Child
  depth: number;
  type_label: string;
  members: GroupMember[];
}

/** What the IIF list importer did. */
export interface ImportResult {
  counts: {
    accounts: number;
    terms: number;
    customers: number; // including jobs
    jobs: number;
    vendors: number;
    employees: number;
    other_names: number;
    items: number;
  };
  ignored_record_types: string[];
  warnings: string[];
}
