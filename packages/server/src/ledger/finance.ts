import {
  addDays,
  FinanceChargeSettings,
  type FinanceChargeInvoice,
  type FinanceChargePreview,
  type InvoiceInput,
} from '@rapidbooks/shared';
import type { DB } from '../db';
import { AppError } from '../errors';
import { accountRow, appliedTo, fullName } from './common';
import { nextFinanceChargeNum, saveTxn } from './posting';

// Finance charges. Settings live in the company table:
//   fc_annual_rate_bp   annual rate in basis points (18% = 1800)
//   fc_min_charge       minimum charge per customer, cents
//   fc_grace_days       grace period, days
//   fc_account_id       finance-charge income account
//   fc_charge_on_fc     '1' to charge on overdue finance charges (default '0')

const KEYS = {
  annual_rate_bp: 'fc_annual_rate_bp',
  min_charge: 'fc_min_charge',
  grace_days: 'fc_grace_days',
  account_id: 'fc_account_id',
  charge_on_finance_charges: 'fc_charge_on_fc',
} as const;

export function getFinanceChargeSettings(db: DB): FinanceChargeSettings {
  const rows = db.prepare("SELECT key, value FROM company WHERE key LIKE 'fc\\_%' ESCAPE '\\'").all() as {
    key: string;
    value: string;
  }[];
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const int = (k: string) => {
    const n = Number(v.get(k) ?? '');
    return v.has(k) && v.get(k) !== '' && Number.isInteger(n) ? n : null;
  };
  return {
    annual_rate_bp: int(KEYS.annual_rate_bp) ?? 0,
    min_charge: int(KEYS.min_charge) ?? 0,
    grace_days: int(KEYS.grace_days) ?? 0,
    account_id: int(KEYS.account_id),
    charge_on_finance_charges: v.get(KEYS.charge_on_finance_charges) === '1',
  };
}

export function setFinanceChargeSettings(db: DB, s: FinanceChargeSettings) {
  if (s.account_id !== null) {
    const a = accountRow(db, s.account_id);
    if (!a) throw new AppError(400, 'The finance charge account no longer exists.');
    if (a.type === 'AR' || a.type === 'AP') {
      throw new AppError(400, 'Finance charges cannot post to an Accounts Receivable or Accounts Payable account.');
    }
  }
  const up = db.prepare(
    'INSERT INTO company (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    up.run(KEYS.annual_rate_bp, String(s.annual_rate_bp));
    up.run(KEYS.min_charge, String(s.min_charge));
    up.run(KEYS.grace_days, String(s.grace_days));
    up.run(KEYS.account_id, s.account_id === null ? '' : String(s.account_id));
    up.run(KEYS.charge_on_finance_charges, s.charge_on_finance_charges ? '1' : '0');
  })();
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * The finance charge each customer (or job) would be assessed as of a date.
 *
 * For each invoice still open on asOf whose due date + grace days is before asOf:
 *   charge = open balance × annual rate × days ÷ 365
 * where days run from the later of (due date + grace days) and the date of the last
 * finance charge assessed to that customer. The charges of one customer are added
 * exactly and rounded once (half away from zero); a positive result below the minimum
 * charge is raised to the minimum. Finance-charge invoices are skipped unless the
 * settings say to charge on them.
 */
export function previewFinanceCharges(db: DB, asOf: string): FinanceChargePreview[] {
  const s = getFinanceChargeSettings(db);
  if (s.annual_rate_bp <= 0) return [];

  const invoices = db
    .prepare(
      `SELECT id, num, date, due_date, name_id, total, is_finance_charge FROM txns
        WHERE type = 'INVOICE' AND date <= ? ORDER BY name_id, date, id`,
    )
    .all(asOf) as {
    id: number;
    num: string;
    date: string;
    due_date: string;
    name_id: number;
    total: number;
    is_finance_charge: number;
  }[];
  const lastFc = db.prepare(
    "SELECT MAX(date) AS d FROM txns WHERE type = 'INVOICE' AND is_finance_charge = 1 AND name_id = ? AND date <= ?",
  );

  const byName = new Map<number, FinanceChargePreview & { numer: bigint }>();
  for (const inv of invoices) {
    if (inv.is_finance_charge && !s.charge_on_finance_charges) continue;
    const graceEnd = addDays(inv.due_date || inv.date, s.grace_days);
    if (graceEnd >= asOf) continue;
    const open = inv.total - appliedTo(db, inv.id, null, asOf);
    if (open <= 0) continue;

    let entry = byName.get(inv.name_id);
    if (!entry) {
      const last = (lastFc.get(inv.name_id, asOf) as { d: string | null }).d;
      entry = {
        name_id: inv.name_id,
        full_name: fullName(db, inv.name_id),
        last_fc_date: last,
        overdue_balance: 0,
        computed: 0,
        charge: 0,
        invoices: [],
        numer: 0n,
      };
      byName.set(inv.name_id, entry);
    }
    const from = entry.last_fc_date && entry.last_fc_date > graceEnd ? entry.last_fc_date : graceEnd;
    const days = daysBetween(from, asOf);
    if (days <= 0) continue;
    const numer = BigInt(open) * BigInt(s.annual_rate_bp) * BigInt(days); // ÷ (10000 × 365) = cents
    entry.numer += numer;
    entry.overdue_balance += open;
    const line: FinanceChargeInvoice = {
      txn_id: inv.id,
      num: inv.num,
      date: inv.date,
      due_date: inv.due_date,
      open_balance: open,
      from_date: from,
      days,
      charge: Number(roundDiv(numer, 3650000n)),
    };
    entry.invoices.push(line);
  }

  const out: FinanceChargePreview[] = [];
  for (const { numer, ...e } of byName.values()) {
    if (e.invoices.length === 0) continue;
    e.computed = Number(roundDiv(numer, 3650000n));
    e.charge = e.computed > 0 && e.computed < s.min_charge ? s.min_charge : e.computed;
    if (e.charge > 0) out.push(e);
  }
  return out.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' }));
}

function roundDiv(a: bigint, b: bigint): bigint {
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return q;
}

/**
 * Create one finance-charge invoice per chosen customer, dated asOf and numbered
 * "FC n": Dr A/R, Cr the finance-charge account. Returns the new invoice ids.
 */
export function assessFinanceCharges(db: DB, asOf: string, customerIds: number[]): number[] {
  const s = getFinanceChargeSettings(db);
  if (s.account_id === null) {
    throw new AppError(400, 'Choose the finance charge account in the finance charge preferences first.');
  }
  return db.transaction(() => {
    const preview = new Map(previewFinanceCharges(db, asOf).map((p) => [p.name_id, p]));
    const ids: number[] = [];
    for (const cid of customerIds) {
      const p = preview.get(cid);
      if (!p) continue; // nothing to charge
      const input: InvoiceInput = {
        type: 'INVOICE',
        date: asOf,
        num: nextFinanceChargeNum(db),
        name_id: cid,
        memo: 'Finance Charge',
        ar_account_id: null,
        terms_id: null,
        due_date: asOf,
        po_number: '',
        ship_date: '',
        ship_via: '',
        bill_addr: (db.prepare('SELECT bill_addr FROM names WHERE id = ?').get(cid) as { bill_addr: string }).bill_addr,
        ship_addr: '',
        message: '',
        to_print: false,
        to_email: false,
        lines: [
          {
            item_id: null,
            description: 'Finance Charge',
            qty: null,
            rate: null,
            rate_is_percent: false,
            amount: p.charge,
            account_id: s.account_id,
          },
        ],
      };
      ids.push(saveTxn(db, input, undefined, { isFinanceCharge: true }).id);
    }
    return ids;
  })();
}
