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

export const TxnInput = z.object({
  type: z.enum(['GENJRNL']),
  date: IsoDate,
  num: z.string().default(''),
  name_id: z.number().int().nullable().default(null),
  memo: z.string().default(''),
  version: z.number().int().optional(), // required when updating
  splits: z.array(SplitInput),
});
export type TxnInput = z.infer<typeof TxnInput>;

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
  rate: z.number().int().default(0),
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
