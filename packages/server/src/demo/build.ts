import {
  addDays,
  ItemInput,
  NameInput,
  PayBillsInput,
  PayrollItemInput,
  percentOf,
  TermsInput,
  TxnInput,
  type AccountTypeCode,
} from '@rapidbooks/shared';
import { seedDefaults, type DB } from '../db';
import { createAccount, listAccounts } from '../ledger/accounts';
import { assessFinanceCharges, previewFinanceCharges, setFinanceChargeSettings } from '../ledger/finance';
import { listUnpaidBills, payBills } from '../ledger/payables';
import { saveTxn, setCleared } from '../ledger/posting';
import { applyCredits, listOpenInvoices } from '../ledger/receivables';
import { createItem } from '../lists/items';
import { createName } from '../lists/names';
import { createPayrollItem } from '../lists/payroll';
import { createTerms } from '../lists/terms';

// A made-up demo company: Miami Valley Precision, a small Dayton machine shop, with
// every list filled in and day-by-day activity from January 1 of last year up to
// `through`. Everything is posted through the real ledger (saveTxn, payBills,
// applyCredits, assessFinanceCharges), so it is exactly what entering it by hand would
// give. A seeded random generator makes the same `through` date give the same file.
//
// All names, addresses, phone numbers and tax IDs are invented (555-01xx numbers).

export interface DemoOptions {
  /** Last day of activity (ISO). The data starts on January 1 of the year before. */
  through: string;
  seed?: number;
}

export interface DemoSummary {
  from: string;
  through: string;
  accounts: number;
  customers: number;
  vendors: number;
  employees: number;
  items: number;
  txns: Record<string, number>;
}

/** Build the demo company into an empty database (schema already migrated). */
export function buildDemo(db: DB, opts: DemoOptions): DemoSummary {
  const has = db.prepare('SELECT (SELECT COUNT(*) FROM txns) + (SELECT COUNT(*) FROM names) AS n').get() as { n: number };
  if (has.n > 0) throw new Error('The demo company can only be built into a new, empty company file.');
  const through = opts.through;
  const from = `${Number(through.slice(0, 4)) - 1}-01-01`;
  let result!: DemoSummary;
  db.transaction(() => {
    result = new DemoBuilder(db, from, through, opts.seed ?? 20130).run();
  })();
  return result;
}

// ---------------------------------------------------------------------------

/** mulberry32: small, fast, good enough for fake data. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const isWeekday = (iso: string) => dow(iso) !== 0 && dow(iso) !== 6;
const ym = (iso: string) => iso.slice(0, 7);
const lastOfMonth = (iso: string) => addDays(`${ym(addDays(`${ym(iso)}-28`, 4))}-01`, -1);

interface Customer {
  id: number;
  /** Who gets invoiced: the customer itself, or one of its jobs. */
  billTo: number[];
  terms: number;
  weight: number; // relative share of the work
  /** Days after the invoice date they usually pay; null = slow payer who often doesn't. */
  payDays: [number, number];
  /** Chance an invoice is never paid (stays open). */
  stiff: number;
  takesDiscount: boolean;
  picksUp: boolean;
  poPrefix: string;
  shipVia: string;
}

interface Employee {
  id: number;
  hourly: number | null; // cents per hour
  salary: number | null; // cents per pay period
  fedPct: number; // basis points of gross
  statePct: number;
  hired: string;
  released: string;
}

interface PendingPayment {
  date: string;
  invoice: number;
  customer: number;
  takeDiscount: boolean;
  partial: boolean;
}

class DemoBuilder {
  r: () => number;
  a: Record<string, number> = {};
  terms: Record<string, number> = {};
  items: Record<string, number> = {};
  itemCost: Record<string, number> = {};
  itemRate: Record<string, number> = {};
  vendors: Record<string, number> = {};
  pay: Record<string, number> = {};
  customers: Customer[] = [];
  employees: Employee[] = [];
  other: Record<string, number> = {};

  invNum = 1001;
  poNum = 2101;
  checkNum = 5001;
  pendingPayments: PendingPayment[] = [];
  undeposited: number[] = [];
  openPOs: { id: number; vendor: number; lines: { item_id: number; qty: number; rate: number }[]; due: string }[] = [];
  liab = { fed: 0, fica: 0, state: 0, futa: 0, suta: 0 };
  loanBalance = 14_000_000;

  constructor(
    private db: DB,
    private from: string,
    private through: string,
    seed: number,
  ) {
    this.r = rng(seed);
  }

  // ---- random helpers ----
  int(lo: number, hi: number) {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }
  chance(p: number) {
    return this.r() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)];
  }
  weighted<T extends { weight: number }>(xs: T[]): T {
    const total = xs.reduce((t, x) => t + x.weight, 0);
    let v = this.r() * total;
    for (const x of xs) if ((v -= x.weight) < 0) return x;
    return xs[xs.length - 1];
  }
  /** Round cents to a "nice" amount (whole dollars). */
  dollars(lo: number, hi: number) {
    return this.int(lo, hi) * 100;
  }

  /**
   * A sales line as the form fills it in: the item's description and rate (percent
   * items carry their percentage), and a group item expanded into its members.
   */
  line(key: string, qty: number | null = null, extra: { rate?: number; description?: string } = {}): Record<string, unknown>[] {
    const item = this.db
      .prepare('SELECT id, type, description, rate, rate_is_percent FROM items WHERE id = ?')
      .get(this.items[key]) as { id: number; type: string; description: string; rate: number; rate_is_percent: number };
    if (item.type === 'GROUP') {
      const members = this.db
        .prepare('SELECT i.id, i.description, i.rate, m.qty FROM item_group_members m JOIN items i ON i.id = m.item_id WHERE m.group_id = ? ORDER BY m.seq')
        .all(item.id) as { id: number; description: string; rate: number; qty: number }[];
      return members.map((m) => ({ item_id: m.id, description: m.description, qty: m.qty * (qty ?? 1), rate: m.rate }));
    }
    return [{
      item_id: item.id,
      description: extra.description ?? item.description,
      qty: item.type === 'SUBTOTAL' || item.rate_is_percent ? null : qty,
      rate: item.type === 'SUBTOTAL' ? null : (extra.rate ?? item.rate),
      rate_is_percent: !!item.rate_is_percent,
    }];
  }

  save(input: Record<string, unknown>, opts = {}) {
    return saveTxn(this.db, TxnInput.parse(input), undefined, opts).id;
  }
  nextCheck() {
    return String(this.checkNum++);
  }

  run(): DemoSummary {
    this.lists();
    this.openingBalances();
    for (let d = this.from; d <= this.through; d = addDays(d, 1)) this.day(d);
    this.leaveSomeOpen();
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const txns = Object.fromEntries(
      (this.db.prepare('SELECT type, COUNT(*) AS n FROM txns GROUP BY type ORDER BY type').all() as { type: string; n: number }[]).map(
        (x) => [x.type, x.n],
      ),
    );
    return {
      from: this.from,
      through: this.through,
      accounts: count('SELECT COUNT(*) AS n FROM accounts'),
      customers: count("SELECT COUNT(*) AS n FROM names WHERE kind = 'customer'"),
      vendors: count("SELECT COUNT(*) AS n FROM names WHERE kind = 'vendor'"),
      employees: count("SELECT COUNT(*) AS n FROM names WHERE kind = 'employee'"),
      items: count('SELECT COUNT(*) AS n FROM items'),
      txns,
    };
  }

  // =========================================================================
  // Lists

  lists() {
    const db = this.db;
    const company: Record<string, string> = {
      name: 'Miami Valley Precision, Inc.',
      address: '2240 Webster Street\nDayton, OH 45404',
      phone: '937-555-0142',
      fax: '937-555-0143',
      email: 'office@mvprecision.example',
      website: 'www.mvprecision.example',
      ein: '31-5550142',
    };
    const up = db.prepare('INSERT INTO company (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(company)) up.run(k, v);

    seedDefaults(db);
    for (const x of listAccounts(db)) this.a[x.name] = x.id;
    // The starter chart names the bank just "Checking"; this.a.Checking keeps pointing at it.
    db.prepare("UPDATE accounts SET name = 'Checking - Fifth Third', description = 'Operating account' WHERE id = ?").run(this.a.Checking);
    db.prepare('UPDATE accounts SET inactive = 1 WHERE id = ?').run(this.a['Uncategorized Expenses']);
    const acct = (name: string, type: AccountTypeCode, parent: string | null = null, description = '') =>
      (this.a[parent ? `${parent}:${name}` : name] = createAccount(db, {
        name,
        type,
        parent_id: parent ? this.a[parent] : null,
        description,
        inactive: false,
      }));
    acct('Savings - Fifth Third', 'BANK', null, 'Money market');
    acct('Petty Cash', 'BANK');
    acct('Prepaid Insurance', 'OCA');
    acct('Employee Advances', 'OCA');
    acct('Machinery & Equipment', 'FA');
    acct('Vehicles', 'FA');
    acct('Furniture & Office Equipment', 'FA');
    acct('Accumulated Depreciation', 'FA');
    acct('Payroll Liabilities', 'OCL');
    acct('Federal Withholding', 'OCL', 'Payroll Liabilities');
    acct('FICA', 'OCL', 'Payroll Liabilities');
    acct('Ohio Withholding', 'OCL', 'Payroll Liabilities');
    acct('FUTA', 'OCL', 'Payroll Liabilities');
    acct('Ohio SUTA', 'OCL', 'Payroll Liabilities');
    acct('Line of Credit', 'OCL');
    acct('Equipment Loan - Haas', 'LTL', null, 'Fifth Third note #4471, 6.25%');
    acct('Owner Capital', 'EQUITY');
    acct('Owner Draws', 'EQUITY');
    acct('Manual Machining', 'INC', 'Sales');
    acct('CNC Production', 'INC', 'Sales');
    acct('Engineering & Design', 'INC', 'Sales');
    acct('Material Sales', 'INC', 'Sales');
    acct('Outside Processing', 'INC', 'Sales');
    acct('Freight Billed', 'INC', 'Sales');
    acct('Finance Charge Income', 'OINC');
    acct('Interest Income', 'OINC');
    acct('Scrap Sales', 'OINC');
    acct('Discounts Taken', 'OINC');
    acct('Materials', 'COGS', null, 'Bar, plate and tube stock');
    acct('Outside Services', 'COGS', null, 'Heat treat, plating, grinding');
    acct('Tooling', 'COGS', null, 'Inserts, end mills, drills');
    acct('Freight In', 'COGS');
    acct('Advertising', 'EXP');
    acct('Bank Service Charges', 'EXP');
    acct('Depreciation Expense', 'EXP');
    acct('Discounts Given', 'EXP');
    acct('Dues & Subscriptions', 'EXP');
    acct('Insurance', 'EXP');
    acct('Liability', 'EXP', 'Insurance');
    acct('Workers Comp', 'EXP', 'Insurance');
    acct('Health', 'EXP', 'Insurance');
    acct('Office Supplies', 'EXP');
    acct('Professional Fees', 'EXP');
    acct('Rent', 'EXP');
    acct('Repairs & Maintenance', 'EXP');
    acct('Shop Supplies', 'EXP');
    acct('Telephone & Internet', 'EXP');
    acct('Utilities', 'EXP');
    acct('Electric', 'EXP', 'Utilities');
    acct('Gas', 'EXP', 'Utilities');
    acct('Water & Sewer', 'EXP', 'Utilities');
    acct('Vehicle', 'EXP');
    acct('Fuel', 'EXP', 'Vehicle');
    acct('Maintenance', 'EXP', 'Vehicle');
    acct('Wages', 'EXP');
    acct('Shop Wages', 'EXP', 'Wages');
    acct('Office Wages', 'EXP', 'Wages');
    acct('Payroll Taxes', 'EXP');
    acct('Interest Expense', 'OEXP');

    // ---- terms ----
    const terms = (name: string, net_days: number, discount_pct = 0, discount_days = 0) =>
      (this.terms[name] = createTerms(db, TermsInput.parse({ name, net_days, discount_pct, discount_days })));
    terms('Due on receipt', 0);
    terms('Net 10', 10);
    terms('Net 15', 15);
    terms('Net 30', 30);
    terms('Net 45', 45);
    terms('Net 60', 60);
    terms('1% 10 Net 30', 30, 100, 10);
    terms('2% 10 Net 30', 30, 200, 10);

    setFinanceChargeSettings(db, {
      annual_rate_bp: 1800,
      min_charge: 500,
      grace_days: 15,
      account_id: this.a['Finance Charge Income'],
      charge_on_finance_charges: false,
    });

    this.vendorList();
    this.itemList();
    this.customerList();
    this.employeeList();
  }

  vendorList() {
    type V = [key: string, name: string, extra: Record<string, unknown>];
    const v: V[] = [
      ['steel', 'Buckeye Steel & Alloy', { terms: '2% 10 Net 30', phone: '614-555-0110', contact: 'Rita Kowalski', addr: '1800 Joyce Ave\nColumbus, OH 43219', acct: 'MVP-2210' }],
      ['alum', 'Great Lakes Aluminum Supply', { terms: 'Net 30', phone: '216-555-0123', contact: 'Tom Brandt', addr: '4410 E 49th St\nCleveland, OH 44125', acct: '88731' }],
      ['tool', 'Tri-State Tooling', { terms: '1% 10 Net 30', phone: '513-555-0177', contact: 'Gary Hensley', addr: '930 Kemper Rd\nCincinnati, OH 45246' }],
      ['mcm', 'McMaster Industrial Supply', { terms: 'Net 30', phone: '330-555-0160', addr: 'PO Box 4355\nAurora, OH 44202', acct: '1188-4402' }],
      ['heat', 'Gem City Heat Treating', { terms: 'Net 30', phone: '937-555-0131', contact: 'Lou Fisher', addr: '615 Leo St\nDayton, OH 45404', is1099: true, tax: '31-5550131' }],
      ['plate', 'Valley Plating & Anodize', { terms: 'Net 30', phone: '937-555-0138', contact: 'Sandra Ortiz', addr: '1201 Negley Pl\nDayton, OH 45402', is1099: true, tax: '31-5550138' }],
      ['grind', 'Precision Grinding Co.', { terms: 'Net 15', phone: '937-555-0145', addr: '77 Bassett St\nDayton, OH 45403', is1099: true, tax: '31-5550145' }],
      ['landlord', 'Webster Street Properties LLC', { terms: 'Due on receipt', phone: '937-555-0101', contact: 'Martin Reyes', addr: '400 E 1st St Ste 2\nDayton, OH 45402', is1099: true, tax: '31-5550101' }],
      ['power', 'Dayton Power & Light', { terms: 'Net 15', phone: '800-555-0190', addr: 'PO Box 1247\nDayton, OH 45401', acct: '4402-118-337', printAs: 'AES Ohio' }],
      ['gas', 'CenterPoint Energy', { terms: 'Net 15', phone: '800-555-0191', addr: 'PO Box 4981\nHouston, TX 77210', acct: '6610-55-0142' }],
      ['water', 'City of Dayton Water', { terms: 'Net 15', phone: '937-555-0100', addr: '101 W 3rd St\nDayton, OH 45402', acct: '0142-221' }],
      ['phone', 'Spectrum Business', { terms: 'Net 15', phone: '855-555-0199', addr: 'PO Box 7186\nPasadena, CA 91109', acct: '8350 11 004 0142' }],
      ['ins', 'Ohio Mutual Insurance Group', { terms: 'Net 30', phone: '419-555-0150', addr: '1725 Hopley Ave\nBucyrus, OH 44820', acct: 'BOP-7731042' }],
      ['bwc', 'Ohio Bureau of Workers Comp', { terms: 'Net 30', phone: '800-555-0164', addr: '30 W Spring St\nColumbus, OH 43215', acct: '1442078' }],
      ['health', 'Anthem Blue Cross', { terms: 'Net 30', phone: '800-555-0172', addr: 'PO Box 105187\nAtlanta, GA 30348', acct: 'GRP 55014' }],
      ['cpa', 'Hollister & Grant CPAs', { terms: 'Net 30', phone: '937-555-0155', contact: 'Diane Hollister', addr: '1 S Main St Ste 900\nDayton, OH 45402', is1099: true, tax: '31-5550155' }],
      ['repair', 'Midwest Machine Repair', { terms: 'Net 30', phone: '937-555-0167', contact: 'Ed Packard', addr: '3155 Valley St\nDayton, OH 45424', is1099: true, tax: '45-5550167' }],
      ['fuel', 'Speedway', { terms: '', phone: '', addr: '' }],
      ['freight', 'R+L Carriers', { terms: 'Net 15', phone: '800-555-0181', addr: 'PO Box 10020\nPort William, OH 45164', acct: 'MVP0142' }],
      ['bank', 'Fifth Third Bank', { terms: '', phone: '800-555-0102', addr: '38 Fountain Sq Plz\nCincinnati, OH 45263' }],
      ['irs', 'United States Treasury', { terms: '', phone: '', addr: 'EFTPS' }],
      ['ohtax', 'Ohio Department of Taxation', { terms: '', phone: '', addr: 'PO Box 182667\nColumbus, OH 43218' }],
      ['adv', 'Dayton Business Journal', { terms: 'Net 30', phone: '937-555-0184', addr: '40 N Main St Ste 800\nDayton, OH 45423' }],
      ['dues', 'Dayton Tooling & Machining Assn', { terms: 'Net 30', phone: '937-555-0186', addr: '1001 Watervliet Ave\nDayton, OH 45420' }],
      ['office', 'Staples Business Advantage', { terms: 'Net 30', phone: '877-555-0126', addr: 'PO Box 105638\nAtlanta, GA 30348', acct: '7012 5501 42', inactive: false }],
      ['oldsteel', 'Allied Metals (closed)', { terms: 'Net 30', phone: '', addr: '', inactive: true }],
    ];
    for (const [key, name, e] of v) {
      this.vendors[key] = createName(
        this.db,
        NameInput.parse({
          kind: 'vendor',
          name,
          company: name,
          contact: e.contact ?? '',
          phone: e.phone ?? '',
          bill_addr: e.addr ? `${name}\n${e.addr}` : '',
          terms_id: e.terms ? this.terms[e.terms as string] : null,
          account_no: e.acct ?? '',
          print_as: e.printAs ?? '',
          is_1099: !!e.is1099,
          tax_id: e.tax ?? '',
          inactive: !!e.inactive,
        }),
      );
    }
    this.other.owner = createName(this.db, NameInput.parse({ kind: 'other', name: 'Frank Delgado', first_name: 'Frank', last_name: 'Delgado', notes: 'Owner' }));
    this.other.bank = createName(this.db, NameInput.parse({ kind: 'other', name: 'Fifth Third Loan Dept' }));
  }

  itemList() {
    const a = this.a;
    const item = (key: string, input: Record<string, unknown>) => {
      const p = ItemInput.parse(input);
      this.items[key] = createItem(this.db, p);
      this.itemRate[key] = p.rate;
      this.itemCost[key] = p.cost ?? 0;
    };
    // Services
    item('manual', { name: 'Manual Machining', type: 'SERVICE', description: 'Manual mill / lathe time', rate: 8500, account_id: a['Sales:Manual Machining'] });
    item('cncmill', { name: 'CNC Milling', type: 'SERVICE', description: 'CNC vertical machining center', rate: 11500, account_id: a['Sales:CNC Production'] });
    item('cncturn', { name: 'CNC Turning', type: 'SERVICE', description: 'CNC lathe', rate: 10500, account_id: a['Sales:CNC Production'] });
    item('5axis', { name: '5-Axis Machining', type: 'SERVICE', description: '5-axis machining center', rate: 16500, account_id: a['Sales:CNC Production'] });
    item('edm', { name: 'Wire EDM', type: 'SERVICE', description: 'Wire EDM', rate: 9500, account_id: a['Sales:CNC Production'] });
    item('setup', { name: 'Setup', type: 'SERVICE', description: 'Machine setup and first-article', rate: 9000, account_id: a['Sales:CNC Production'] });
    item('weld', { name: 'Welding', type: 'SERVICE', description: 'TIG / MIG welding', rate: 8000, account_id: a['Sales:Manual Machining'] });
    item('insp', { name: 'Inspection', type: 'SERVICE', description: 'CMM inspection and report', rate: 9500, account_id: a['Sales:CNC Production'] });
    item('eng', { name: 'Engineering', type: 'SERVICE', description: 'CAD/CAM programming and design', rate: 12500, account_id: a['Sales:Engineering & Design'] });
    item('repair', { name: 'Repair Work', type: 'SERVICE', description: 'Repair / rework of customer part', rate: 8500, account_id: a['Sales:Manual Machining'] });
    // Production parts (piece prices, some fractional cents)
    const piece = (key: string, name: string, desc: string, rate: number) =>
      item(key, { name, type: 'SERVICE', description: desc, rate, account_id: a['Sales:CNC Production'] });
    piece('p_bush', 'BR-1150 Bushing', 'Bronze bushing, .750 bore', 412.5);
    piece('p_shaft', 'SH-2204 Shaft', '4140 shaft, ground', 2875);
    piece('p_brkt', 'BK-0718 Bracket', '6061-T6 mounting bracket', 1890);
    piece('p_spacer', 'SP-0050 Spacer', 'Steel spacer, zinc plated', 137.5);
    piece('p_hub', 'HB-3310 Hub', 'Drive hub, keyed', 6450);
    piece('p_mani', 'MF-0912 Manifold', 'Hydraulic manifold block', 18500);
    piece('p_pin', 'PN-1000 Pin', 'Hardened dowel pin', 87.5);
    piece('p_plate', 'PL-4410 Plate', 'Fixture plate, blanchard ground', 9200);
    // Material (non-inventory parts, bought and resold)
    const mat = (key: string, name: string, desc: string, rate: number, cost: number) =>
      item(key, {
        name, type: 'PART', description: desc, rate, account_id: a['Sales:Material Sales'],
        purchase_description: desc, cost, purchase_account_id: a.Materials,
      });
    mat('m_4140', '4140 Bar', '4140 HT round bar, per ft', 2400, 1650);
    mat('m_1018', '1018 CRS Bar', '1018 cold rolled bar, per ft', 1100, 720);
    mat('m_6061', '6061 Plate', '6061-T651 plate, per lb', 925, 610);
    mat('m_304', '304 SS Bar', '304 stainless round, per ft', 3150, 2180);
    mat('m_brz', 'Bronze Bar', 'SAE 660 bronze, per ft', 4800, 3350);
    mat('m_tube', 'DOM Tube', 'DOM tube, per ft', 1850, 1240);
    // Tooling bought for jobs (purchase side only shows up on bills)
    const tool = (key: string, name: string, desc: string, cost: number) =>
      item(key, {
        name, type: 'PART', description: desc, rate: 0, account_id: a['Sales:Material Sales'],
        purchase_description: desc, cost, purchase_account_id: a.Tooling,
      });
    tool('t_insert', 'Carbide Inserts', 'CNMG 432 carbide inserts, box of 10', 11850);
    tool('t_em', 'End Mills', '1/2" 4FL carbide end mill', 6475);
    tool('t_drill', 'Drills', 'Cobalt jobber drills', 2290);
    // Other charges
    const oc = (key: string, input: Record<string, unknown>) => item(key, { type: 'OTHER_CHARGE', ...input });
    oc('freight', { name: 'Freight', description: 'Freight', rate: 0, account_id: a['Sales:Freight Billed'], purchase_description: 'Freight in', cost: 0, purchase_account_id: a['Freight In'] });
    oc('heat', { name: 'Heat Treat', description: 'Outside heat treat', rate: 0, account_id: a['Sales:Outside Processing'], purchase_description: 'Heat treat', cost: 0, purchase_account_id: a['Outside Services'] });
    oc('plating', { name: 'Plating', description: 'Outside plating / anodize', rate: 0, account_id: a['Sales:Outside Processing'], purchase_description: 'Plating', cost: 0, purchase_account_id: a['Outside Services'] });
    oc('grinding', { name: 'Grinding', description: 'Outside grinding', rate: 0, account_id: a['Sales:Outside Processing'], purchase_description: 'Grinding', cost: 0, purchase_account_id: a['Outside Services'] });
    oc('rush', { name: 'Rush 15%', description: 'Expedite charge', rate: 1500, rate_is_percent: true, account_id: a['Sales:CNC Production'] });
    oc('cert', { name: 'Material Certs', description: 'Material certifications', rate: 2500, account_id: a['Sales:Material Sales'] });
    item('sub', { name: 'Subtotal', type: 'SUBTOTAL', description: 'Subtotal' });
    item('disc5', { name: 'Disc 5%', type: 'DISCOUNT', description: 'Volume discount 5%', rate: 500, rate_is_percent: true, account_id: a['Discounts Given'] });
    item('disc10', { name: 'Disc 10%', type: 'DISCOUNT', description: 'Volume discount 10%', rate: 1000, rate_is_percent: true, account_id: a['Discounts Given'] });
    item('goodwill', { name: 'Goodwill Credit', type: 'DISCOUNT', description: 'Customer goodwill', rate: 0, account_id: a['Discounts Given'] });
    item('fa', {
      name: 'First Article Pkg', type: 'GROUP', description: 'Setup, programming and first-article inspection',
      members: [{ item_id: this.items.setup, qty: 2 }, { item_id: this.items.eng, qty: 1 }, { item_id: this.items.insp, qty: 1 }],
    });
    item('oldsvc', { name: 'Saw Cutting', type: 'SERVICE', description: 'Saw cut to length (no longer offered)', rate: 4500, account_id: a['Sales:Manual Machining'], inactive: true });
  }

  customerList() {
    const T = this.terms;
    type C = {
      name: string; contact: string; phone: string; addr: string; terms: string; weight: number;
      pay: [number, number]; stiff?: number; disc?: boolean; picks?: boolean; jobs?: string[];
      po?: string; via?: string; limit?: number; email?: string; inactive?: boolean;
    };
    const cs: C[] = [
      { name: 'Acme Tooling', contact: 'Bill Harmon', phone: '937-555-0110', addr: '455 Industrial Dr\nVandalia, OH 45377', terms: 'Net 30', weight: 9, pay: [25, 40], jobs: ['Press Frame', 'Gearbox Rebuild', 'Spare Parts'], po: 'AT-', via: 'Our truck', limit: 5000000, email: 'ap@acmetooling.example' },
      { name: 'Buckeye Hydraulics', contact: 'Janet Price', phone: '614-555-0124', addr: '2900 Morse Rd\nColumbus, OH 43231', terms: '2% 10 Net 30', weight: 8, pay: [8, 12], disc: true, po: 'BH', via: 'UPS Freight', email: 'payables@buckeyehyd.example' },
      { name: 'Cole Manufacturing', contact: 'Ray Cole', phone: '937-555-0127', addr: '88 Commerce Park\nMiamisburg, OH 45342', terms: 'Net 30', weight: 7, pay: [30, 55], jobs: ['Line 3 Retrofit', 'Conveyor'], po: 'CM-', via: 'Our truck' },
      { name: 'Dorn Packaging', contact: 'Ellen Dorn', phone: '937-555-0133', addr: '1220 Wayne Ave\nDayton, OH 45410', terms: 'Net 30', weight: 5, pay: [28, 45], via: 'Our truck' },
      { name: 'Erie Aerospace', contact: 'Kevin Marsh', phone: '419-555-0136', addr: '7000 Airport Hwy\nToledo, OH 43528', terms: 'Net 45', weight: 10, pay: [40, 60], jobs: ['Bracket Program', 'Fixtures'], po: 'EA', via: 'FedEx Freight', limit: 10000000, email: 'invoices@erieaero.example' },
      { name: 'Fairborn Fluid Power', contact: 'Mike Tran', phone: '937-555-0141', addr: '310 E Dayton Dr\nFairborn, OH 45324', terms: 'Net 30', weight: 6, pay: [20, 35], picks: true },
      { name: 'Gem City Robotics', contact: 'Priya Nair', phone: '937-555-0147', addr: '1 Innovation Way\nDayton, OH 45435', terms: '1% 10 Net 30', weight: 5, pay: [9, 30], disc: true, po: 'GCR-', email: 'ap@gemcityrobotics.example' },
      { name: 'Huber Heights Fab', contact: 'Doug Klein', phone: '937-555-0152', addr: '6100 Executive Blvd\nHuber Heights, OH 45424', terms: 'Net 15', weight: 4, pay: [15, 30], picks: true },
      { name: 'Indy Pump & Valve', contact: 'Sharon Bell', phone: '317-555-0155', addr: '4400 W 86th St\nIndianapolis, IN 46268', terms: 'Net 30', weight: 4, pay: [30, 50], via: 'R+L Carriers', po: 'IPV' },
      { name: 'Kettering Medical Devices', contact: 'Dr. Alan Pierce', phone: '937-555-0158', addr: '3535 Southern Blvd\nKettering, OH 45429', terms: 'Net 60', weight: 6, pay: [55, 75], po: 'KMD-', email: 'purchasing@kmd.example' },
      { name: 'Lima Tractor Parts', contact: 'Hank Mueller', phone: '419-555-0161', addr: '1500 Neubrecht Rd\nLima, OH 45801', terms: 'Net 30', weight: 3, pay: [45, 90], stiff: 0.15, via: 'R+L Carriers' },
      { name: 'Miami Valley Motorsports', contact: 'Jake Sutter', phone: '937-555-0163', addr: '200 Speedway Dr\nTroy, OH 45373', terms: 'Due on receipt', weight: 3, pay: [0, 20], picks: true },
      { name: 'Northside Plastics', contact: 'Carol Webb', phone: '937-555-0166', addr: '4141 N Dixie Dr\nDayton, OH 45414', terms: 'Net 30', weight: 4, pay: [28, 40], jobs: ['Mold Base 17', 'Mold Base 22'], via: 'Our truck' },
      { name: 'Ohio Valley Conveyor', contact: 'Steve Rinehart', phone: '513-555-0169', addr: '9800 Princeton-Glendale\nCincinnati, OH 45246', terms: 'Net 30', weight: 5, pay: [35, 70], stiff: 0.08, via: 'UPS Freight' },
      { name: 'Piqua Pressworks', contact: 'Linda Shaw', phone: '937-555-0172', addr: '600 E Ash St\nPiqua, OH 45356', terms: 'Net 30', weight: 3, pay: [25, 35], picks: true },
      { name: 'Quality Gear Works', contact: 'Ben Ostrowski', phone: '937-555-0175', addr: '72 Kenbrook Dr\nVandalia, OH 45377', terms: '2% 10 Net 30', weight: 4, pay: [7, 10], disc: true },
      { name: 'Riverside Dairy Equipment', contact: 'Tom Hale', phone: '937-555-0178', addr: '2200 Harshman Rd\nRiverside, OH 45424', terms: 'Net 30', weight: 2, pay: [60, 120], stiff: 0.3, via: 'Our truck' },
      { name: 'Springfield Stamping', contact: 'Gina Russo', phone: '937-555-0181', addr: '1600 Lagonda Ave\nSpringfield, OH 45503', terms: 'Net 30', weight: 4, pay: [28, 38], jobs: ['Die Repair', 'New Tooling'], via: 'Our truck' },
      { name: 'Tipp City Instruments', contact: 'Rob Lang', phone: '937-555-0184', addr: '125 Weller Dr\nTipp City, OH 45371', terms: 'Net 15', weight: 2, pay: [12, 25] },
      { name: 'Union Ag Equipment', contact: 'Dale Brewer', phone: '937-555-0187', addr: '9900 St Rt 48\nUnion, OH 45322', terms: 'Net 30', weight: 2, pay: [30, 45], picks: true },
      { name: 'Wright Field Research', contact: 'Dr. Maria Chen', phone: '937-555-0190', addr: '2130 Fifth St Bldg 16\nWPAFB, OH 45433', terms: 'Net 30', weight: 4, pay: [30, 30], jobs: ['Test Fixture A', 'Test Fixture B'], po: 'FA8650-', email: 'ap@wfr.example' },
      { name: 'Xenia Food Machinery', contact: 'Paul Grant', phone: '937-555-0193', addr: '400 Bellbrook Ave\nXenia, OH 45385', terms: 'Net 30', weight: 3, pay: [25, 40] },
      { name: 'Yellow Springs Bike Co', contact: 'Mo Abernathy', phone: '937-555-0196', addr: '108 Dayton St\nYellow Springs, OH 45387', terms: 'Due on receipt', weight: 1, pay: [0, 10], picks: true },
      { name: 'Zimmerman Machine (old)', contact: '', phone: '', addr: '', terms: 'Net 30', weight: 0, pay: [30, 30], inactive: true },
    ];
    for (const c of cs) {
      const [first, ...rest] = c.contact.replace(/^Dr\. /, '').split(' ');
      const bill = c.addr ? `${c.name}\n${c.addr}` : '';
      const id = createName(
        this.db,
        NameInput.parse({
          kind: 'customer',
          name: c.name,
          company: c.name,
          contact: c.contact,
          first_name: first ?? '',
          last_name: rest.join(' '),
          salutation: c.contact.startsWith('Dr.') ? 'Dr.' : '',
          phone: c.phone,
          fax: c.phone ? c.phone.replace(/\d{2}$/, (d) => String(Number(d) + 1).padStart(2, '0')) : '',
          email: c.email ?? '',
          bill_addr: bill,
          ship_addr: bill,
          terms_id: T[c.terms],
          credit_limit: c.limit ?? null,
          picks_up: !!c.picks,
          inactive: !!c.inactive,
          notes: c.stiff && c.stiff > 0.2 ? 'Slow payer - call before shipping.' : '',
        }),
      );
      const jobs = (c.jobs ?? []).map((j) =>
        createName(this.db, NameInput.parse({ kind: 'customer', name: j, parent_id: id, company: c.name, contact: c.contact, phone: c.phone, bill_addr: bill, ship_addr: bill, terms_id: T[c.terms], picks_up: !!c.picks })),
      );
      if (c.inactive) continue;
      this.customers.push({
        id,
        billTo: jobs.length ? [id, ...jobs] : [id],
        terms: T[c.terms],
        weight: c.weight,
        payDays: c.pay,
        stiff: c.stiff ?? 0.01,
        takesDiscount: !!c.disc,
        picksUp: !!c.picks,
        poPrefix: c.po ?? '',
        shipVia: c.via ?? '',
      });
    }
  }

  employeeList() {
    const a = this.a;
    const pi = (key: string, name: string, kind: string, extra: Record<string, unknown>) =>
      (this.pay[key] = createPayrollItem(this.db, PayrollItemInput.parse({ name, kind, ...extra })));
    pi('hourly', 'Hourly Wages', 'earning', { expense_account_id: a['Wages:Shop Wages'] });
    pi('ot', 'Overtime (x1.5)', 'earning', { expense_account_id: a['Wages:Shop Wages'] });
    pi('salary', 'Salary', 'earning', { expense_account_id: a['Wages:Office Wages'] });
    pi('bonus', 'Bonus', 'earning', { expense_account_id: a['Wages:Shop Wages'] });
    pi('fed', 'Federal Withholding', 'deduction', { liability_account_id: a['Payroll Liabilities:Federal Withholding'] });
    pi('ss', 'Social Security Employee', 'deduction', { liability_account_id: a['Payroll Liabilities:FICA'] });
    pi('med', 'Medicare Employee', 'deduction', { liability_account_id: a['Payroll Liabilities:FICA'] });
    pi('oh', 'Ohio Withholding', 'deduction', { liability_account_id: a['Payroll Liabilities:Ohio Withholding'] });
    pi('ssco', 'Social Security Company', 'company', { expense_account_id: a['Payroll Taxes'], liability_account_id: a['Payroll Liabilities:FICA'] });
    pi('medco', 'Medicare Company', 'company', { expense_account_id: a['Payroll Taxes'], liability_account_id: a['Payroll Liabilities:FICA'] });
    pi('futa', 'Federal Unemployment', 'company', { expense_account_id: a['Payroll Taxes'], liability_account_id: a['Payroll Liabilities:FUTA'] });
    pi('suta', 'Ohio Unemployment', 'company', { expense_account_id: a['Payroll Taxes'], liability_account_id: a['Payroll Liabilities:Ohio SUTA'] });
    pi('old', 'Piecework (old)', 'earning', { expense_account_id: a['Wages:Shop Wages'], inactive: true });

    type E = [first: string, last: string, hourly: number | null, salary: number | null, fed: number, hired: string, released: string, street: string];
    const year = Number(this.from.slice(0, 4));
    const es: E[] = [
      ['Dave', 'Smith', 3150, null, 1100, '2014-03-17', '', '412 Huffman Ave\nDayton, OH 45403'],
      ['Maria', 'Gonzalez', 2875, null, 950, '2017-08-07', '', '1915 Brown St\nDayton, OH 45409'],
      ['Tyler', 'Brooks', 2400, null, 800, '2021-05-24', '', '33 Pinecrest Dr\nFairborn, OH 45324'],
      ['Kenji', 'Watanabe', 3400, null, 1200, '2012-01-09', '', '5520 Wilmington Pk\nKettering, OH 45440'],
      ['Shawna', 'Miller', null, 230769, 1300, '2016-11-01', '', '808 Patterson Rd\nDayton, OH 45419'],
      ['Luis', 'Ortega', 2200, null, 700, `${year}-01-06`, `${year}-08-15`, '27 Linden Ave\nDayton, OH 45403'],
      ['Ashley', 'Nguyen', 2350, null, 750, `${year}-09-02`, '', '1430 Salem Ave\nDayton, OH 45406'],
    ];
    es.forEach(([first, last, hourly, salary, fed, hired, released, street], i) => {
      const id = createName(
        this.db,
        NameInput.parse({
          kind: 'employee',
          name: `${first} ${last}`,
          first_name: first,
          last_name: last,
          phone: `937-555-01${String(20 + i).padStart(2, '0')}`,
          bill_addr: `${first} ${last}\n${street}`,
          ssn: `000-55-01${String(20 + i).padStart(2, '0')}`,
          hire_date: hired,
          release_date: released,
          inactive: released !== '',
        }),
      );
      this.employees.push({ id, hourly, salary, fedPct: fed, statePct: 300, hired, released });
    });
  }

  // =========================================================================
  // Activity

  openingBalances() {
    const a = this.a;
    const d = this.from;
    this.save({
      type: 'GENJRNL', date: d, num: 'OB-1', memo: 'Opening balances',
      splits: [
        { account_id: a.Checking, amount: 8_650_000, memo: 'Opening balance' },
        { account_id: a['Savings - Fifth Third'], amount: 6_000_000 },
        { account_id: a['Petty Cash'], amount: 30_000 },
        { account_id: a['Machinery & Equipment'], amount: 41_250_000 },
        { account_id: a.Vehicles, amount: 4_800_000 },
        { account_id: a['Furniture & Office Equipment'], amount: 1_150_000 },
        { account_id: a['Accumulated Depreciation'], amount: -18_400_000 },
        { account_id: a['Equipment Loan - Haas'], amount: -this.loanBalance },
        { account_id: a['Owner Capital'], amount: -25_000_000 },
        { account_id: a['Opening Bal Equity'], amount: -(8_650_000 + 6_000_000 + 30_000 + 41_250_000 + 4_800_000 + 1_150_000 - 18_400_000 - this.loanBalance - 25_000_000) },
      ],
    });
  }

  day(d: string) {
    const weekday = isWeekday(d);
    const dom = Number(d.slice(8));
    const month = Number(d.slice(5, 7));

    // Customer payments that come in today (mail arrives on weekdays).
    if (weekday) this.receivePayments(d);

    if (weekday) {
      // Invoices: about 1-3 a day.
      const n = this.pick([1, 1, 2, 2, 2, 3]);
      for (let i = 0; i < n; i++) this.invoice(d);
      if (this.chance(0.03)) this.creditMemo(d);
      // Material POs and receiving.
      if (this.chance(0.18)) this.purchaseOrder(d);
      this.receivePOs(d);
      // Outside processing / tooling / supplies bills.
      if (this.chance(0.12)) this.outsideServiceBill(d);
      if (this.chance(0.08)) this.toolingBill(d);
      if (this.chance(0.1)) this.suppliesCheck(d);
      if (this.chance(0.06)) this.fuel(d);
    }

    if (dow(d) === 5) {
      this.deposit(d);
      this.payroll(d);
      // Pay Bills every other Friday.
      if (Math.floor(dayIndex(d) / 7) % 2 === 0) this.payBills(d);
    }

    if (dom === 1) this.monthStart(d, month);
    if (dom === 5) this.utilityBills(d);
    if (dom === 15) this.monthMid(d, month);
    if (d === lastOfMonth(d)) this.monthEnd(d, month);
  }

  // ---- sales ----

  invoice(d: string) {
    const c = this.weighted(this.customers);
    const nameId = this.pick(c.billTo);
    const lines: Record<string, unknown>[] = [];
    const add = (key: string, qty: number | null = null, extra: { rate?: number; description?: string } = {}) => lines.push(...this.line(key, qty, extra));
    const kind = this.r();
    if (kind < 0.35) {
      // Production run of a part number
      const p = this.pick(['p_bush', 'p_shaft', 'p_brkt', 'p_spacer', 'p_hub', 'p_mani', 'p_pin', 'p_plate']);
      const big = ['p_bush', 'p_spacer', 'p_pin'].includes(p);
      add(p, big ? this.pick([250, 500, 1000, 1500, 2000]) : this.pick([10, 12, 20, 25, 40, 50, 100]));
      if (this.chance(0.3)) add('heat', 1, { rate: this.dollars(85, 450) });
      else if (this.chance(0.3)) add('plating', 1, { rate: this.dollars(60, 380) });
      if (this.chance(0.2)) add('cert', 1);
    } else if (kind < 0.7) {
      // Job shop work: hours on machines, maybe material
      const svc = this.pick(['cncmill', 'cncturn', 'manual', '5axis', 'edm', 'weld']);
      if (this.chance(0.25)) add('fa', 1);
      else if (this.chance(0.4)) add('setup', this.pick([1, 1.5, 2, 3]));
      add(svc, this.pick([2, 3.5, 4, 6, 8, 10, 12.5, 16, 24]));
      if (this.chance(0.5)) add(this.pick(['m_4140', 'm_1018', 'm_6061', 'm_304', 'm_brz', 'm_tube']), this.int(2, 40));
      if (this.chance(0.25)) add('insp', this.pick([0.5, 1, 2]));
    } else if (kind < 0.82) {
      // Repair
      add('repair', this.pick([1, 2, 3, 4.5, 6]), { description: this.pick(['Repair worn bore, sleeve and finish', 'Weld and remachine cracked housing', 'Rebuild gearbox shaft', 'Rework threads per customer drawing', 'Recut keyway']) });
      if (this.chance(0.4)) add('weld', this.pick([1, 2, 3]));
    } else {
      // Engineering / prototype
      add('eng', this.pick([2, 4, 6, 8, 12]));
      add(this.pick(['cncmill', '5axis', 'cncturn']), this.pick([3, 5, 8]));
      lines.push({ item_id: null, description: 'Prototype - not for production. Quote to follow for production quantities.' });
    }
    if (this.chance(0.08)) {
      add('sub');
      add(this.chance(0.7) ? 'disc5' : 'disc10');
    }
    if (this.chance(0.06)) add('rush');
    if (!c.picksUp && c.shipVia && c.shipVia !== 'Our truck' && this.chance(0.8)) add('freight', 1, { rate: this.dollars(45, 260) });

    const num = String(this.invNum++);
    const recent = d >= addDays(this.through, -10);
    const id = this.save({
      type: 'INVOICE',
      date: d,
      num,
      name_id: nameId,
      terms_id: c.terms,
      po_number: c.poPrefix && this.chance(0.85) ? `${c.poPrefix}${this.int(10000, 99999)}` : '',
      ship_date: c.picksUp ? '' : d,
      ship_via: c.picksUp ? 'Customer pickup' : c.shipVia,
      bill_addr: this.billAddr(c.id),
      ship_addr: this.billAddr(c.id),
      message: this.pick(['Thank you for your business.', 'Thank you for your business.', 'We appreciate your prompt payment.', '']),
      to_print: recent && this.chance(0.5),
      to_email: recent && this.chance(0.3),
      lines,
    });

    // When will they pay?
    if (this.chance(c.stiff)) return;
    const [lo, hi] = c.payDays;
    const takeDiscount = c.takesDiscount && this.chance(0.85);
    const payIn = takeDiscount ? this.int(5, 10) : this.int(lo, hi);
    this.pendingPayments.push({ date: addDays(d, payIn), invoice: id, customer: c.id, takeDiscount, partial: this.chance(0.04) });
  }

  billAddr(customerId: number) {
    return (this.db.prepare('SELECT bill_addr FROM names WHERE id = ?').get(customerId) as { bill_addr: string }).bill_addr;
  }

  creditMemo(d: string) {
    const c = this.weighted(this.customers);
    const open = listOpenInvoices(this.db, c.id);
    const target = open.find((x) => !x.is_finance_charge);
    const amount = this.dollars(25, 400);
    const id = this.save({
      type: 'CREDITMEMO',
      date: d,
      num: String(this.invNum++),
      name_id: target?.name_id ?? c.id,
      memo: this.pick(['Scrapped parts - remake at no charge', 'Pricing correction', 'Returned material', 'Short shipment']),
      lines: this.line('repair', 1, { rate: amount, description: 'Credit - see memo' }),
    });
    // Most credits get applied straight away; a few are left for the customer to use.
    if (target && this.chance(0.8)) {
      const amt = Math.min(target.open_balance, this.txnTotal(id));
      if (amt > 0) applyCredits(this.db, { applications: [{ from_txn: id, to_txn: target.id, amount: amt }] });
    }
  }

  txnTotal(id: number) {
    return (this.db.prepare('SELECT total FROM txns WHERE id = ?').get(id) as { total: number }).total;
  }

  receivePayments(d: string) {
    const due = this.pendingPayments.filter((p) => p.date <= d);
    if (due.length === 0) return;
    this.pendingPayments = this.pendingPayments.filter((p) => p.date > d);
    // One check per customer for everything due today.
    const byCustomer = new Map<number, PendingPayment[]>();
    for (const p of due) byCustomer.set(p.customer, [...(byCustomer.get(p.customer) ?? []), p]);
    for (const [customer, ps] of byCustomer) {
      const open = new Map(listOpenInvoices(this.db, customer).map((x) => [x.id, x]));
      const applications: { txn_id: number; amount: number; discount: number; discount_account_id: number | null }[] = [];
      let total = 0;
      for (const p of ps) {
        const inv = open.get(p.invoice);
        if (!inv) continue;
        let discount = 0;
        if (p.takeDiscount && inv.discount_date && d <= inv.discount_date) discount = percentOf(inv.open_balance, inv.discount_pct);
        let amount = inv.open_balance - discount;
        if (p.partial) {
          amount = Math.round(amount / 2 / 100) * 100;
          // The rest comes a month later.
          this.pendingPayments.push({ date: addDays(d, this.int(25, 40)), invoice: inv.id, customer, takeDiscount: false, partial: false });
        }
        if (amount <= 0) continue;
        applications.push({ txn_id: inv.id, amount, discount, discount_account_id: discount ? this.a['Discounts Given'] : null });
        total += amount;
      }
      if (total === 0) continue;
      // Now and then a customer overpays a little, leaving a credit.
      const over = this.chance(0.01) ? this.dollars(5, 50) : 0;
      const method = this.chance(0.85) ? 'Check' : this.pick(['ACH', 'Visa', 'MasterCard', 'Cash']);
      const id = this.save({
        type: 'PAYMENT',
        date: d,
        name_id: customer,
        amount: total + over,
        pay_method: method,
        ref_no: method === 'Check' ? String(this.int(1000, 99999)) : method === 'ACH' ? `ACH${this.int(100000, 999999)}` : '',
        memo: over ? 'Overpayment - credit on account' : '',
        applications,
      });
      this.undeposited.push(id);
    }
  }

  deposit(d: string) {
    if (d > addDays(this.through, -3)) return; // the last few days' checks are still in the drawer
    const a = this.a;
    const extra: Record<string, unknown>[] = [];
    if (this.chance(0.15)) extra.push({ account_id: a['Scrap Sales'], description: 'Scrap metal recycling', amount: this.dollars(40, 380), ref_no: String(this.int(10000, 99999)), pay_method: 'Check' });
    if (this.undeposited.length === 0 && extra.length === 0) return;
    this.save({ type: 'DEPOSIT', date: d, account_id: a.Checking, memo: 'Deposit', payment_ids: this.undeposited, lines: extra });
    this.undeposited = [];
  }

  // ---- purchases ----

  purchaseOrder(d: string) {
    const steel = this.chance(0.7);
    const vendor = steel ? this.vendors.steel : this.vendors.alum;
    const mats = steel ? ['m_4140', 'm_1018', 'm_304', 'm_brz', 'm_tube'] : ['m_6061'];
    const n = this.int(1, 3);
    const lines: { item_id: number; qty: number; rate: number }[] = [];
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      const m = this.pick(mats);
      if (used.has(m)) continue;
      used.add(m);
      lines.push({ item_id: this.items[m], qty: m === 'm_6061' ? this.pick([100, 200, 400, 600]) : this.pick([24, 48, 60, 96, 120, 144]), rate: this.itemCost[m] });
    }
    const due = addDays(d, this.int(4, 14));
    const id = this.save({
      type: 'PURCHORD',
      date: d,
      num: String(this.poNum++),
      name_id: vendor,
      expected_date: due,
      address: (this.db.prepare('SELECT bill_addr FROM names WHERE id = ?').get(vendor) as { bill_addr: string }).bill_addr,
      ship_addr: 'Miami Valley Precision, Inc.\n2240 Webster Street\nDayton, OH 45404',
      message: 'Please include mill certs with shipment.',
      lines,
    });
    this.openPOs.push({ id, vendor, lines, due });
  }

  receivePOs(d: string) {
    const ready = this.openPOs.filter((p) => p.due <= d && d <= addDays(this.through, -5));
    this.openPOs = this.openPOs.filter((p) => !ready.includes(p));
    for (const po of ready) {
      const short = this.chance(0.1);
      const items = po.lines.map((l, i) => ({ ...l, qty: short && i === 0 ? Math.floor(l.qty * 0.75) : l.qty, rate: l.rate }));
      const freight = this.chance(0.4) ? [{ item_id: this.items.freight, qty: 1, rate: this.dollars(75, 225) }] : [];
      this.save({
        type: 'BILL',
        date: d,
        ref_no: `${po.vendor === this.vendors.steel ? 'BSA' : 'GLA'}-${this.int(400000, 499999)}`,
        name_id: po.vendor,
        terms_id: this.vendorTerms(po.vendor),
        po_ids: [po.id],
        memo: short ? 'Short shipped - balance backordered' : '',
        items: [...items, ...freight],
      });
      // Now and then something comes in damaged.
      if (this.chance(0.05)) {
        this.save({
          type: 'BILLCREDIT',
          date: addDays(d, 3),
          ref_no: `RMA-${this.int(1000, 9999)}`,
          name_id: po.vendor,
          memo: 'Damaged in transit - returned',
          items: [{ ...items[0], qty: Math.max(1, Math.floor(items[0].qty / 10)) }],
        });
      }
    }
  }

  vendorTerms(vendor: number) {
    return (this.db.prepare('SELECT terms_id FROM names WHERE id = ?').get(vendor) as { terms_id: number | null }).terms_id;
  }

  bill(d: string, vendorKey: string, ref: string, expenses: { account: string; amount: number; memo?: string; name_id?: number | null }[], memo = '') {
    const vendor = this.vendors[vendorKey];
    return this.save({
      type: 'BILL',
      date: d,
      ref_no: ref,
      name_id: vendor,
      terms_id: this.vendorTerms(vendor),
      memo,
      expenses: expenses.map((e) => ({ account_id: this.a[e.account], amount: e.amount, memo: e.memo ?? '', name_id: e.name_id ?? null })),
    });
  }

  outsideServiceBill(d: string) {
    const key = this.pick(['heat', 'heat', 'plate', 'plate', 'grind']);
    const itemKey = key === 'heat' ? 'heat' : key === 'plate' ? 'plating' : 'grinding';
    const c = this.weighted(this.customers);
    this.save({
      type: 'BILL',
      date: d,
      ref_no: String(this.int(20000, 29999)),
      name_id: this.vendors[key],
      terms_id: this.vendorTerms(this.vendors[key]),
      items: [{ item_id: this.items[itemKey], qty: 1, rate: this.dollars(60, 320), name_id: this.pick(c.billTo), description: `${this.pick(['Lot', 'Batch', 'Shipper'])} ${this.int(100, 999)}` }],
    });
  }

  toolingBill(d: string) {
    const items = [];
    for (const t of ['t_insert', 't_em', 't_drill']) if (this.chance(0.55)) items.push({ item_id: this.items[t], qty: this.int(1, 6), rate: this.itemCost[t] });
    if (items.length === 0) items.push({ item_id: this.items.t_insert, qty: 2, rate: this.itemCost.t_insert });
    const vendor = this.chance(0.7) ? this.vendors.tool : this.vendors.mcm;
    this.save({ type: 'BILL', date: d, ref_no: `${this.int(700000, 799999)}`, name_id: vendor, terms_id: this.vendorTerms(vendor), items });
  }

  suppliesCheck(d: string) {
    const office = this.chance(0.4);
    this.save({
      type: 'CHECK',
      date: d,
      num: this.nextCheck(),
      account_id: this.a.Checking,
      name_id: office ? this.vendors.office : this.vendors.mcm,
      memo: office ? 'Office supplies' : 'Shop supplies',
      expenses: [{ account_id: this.a[office ? 'Office Supplies' : 'Shop Supplies'], amount: this.int(2500, 42000) }],
    });
  }

  fuel(d: string) {
    // Petty cash for fuel; replenished at month end.
    this.save({
      type: 'CHECK',
      date: d,
      num: 'Cash',
      account_id: this.a['Petty Cash'],
      name_id: this.vendors.fuel,
      memo: 'Truck fuel',
      expenses: [{ account_id: this.a['Vehicle:Fuel'], amount: this.int(4500, 9800) }],
    });
  }

  utilityBills(d: string) {
    const m = Number(d.slice(5, 7));
    const winter = m <= 3 || m >= 11;
    const summer = m >= 6 && m <= 8;
    const tag = d.slice(0, 7).replace('-', '');
    this.bill(d, 'power', `E${tag}`, [{ account: 'Utilities:Electric', amount: this.int(summer ? 310000 : 240000, summer ? 420000 : 330000) }]);
    this.bill(d, 'gas', `G${tag}`, [{ account: 'Utilities:Gas', amount: this.int(winter ? 60000 : 9000, winter ? 115000 : 18000) }]);
    if (m % 3 === 1) this.bill(d, 'water', `W${tag}`, [{ account: 'Utilities:Water & Sewer', amount: this.int(21000, 34000) }]);
    this.bill(d, 'phone', `S${tag}`, [{ account: 'Telephone & Internet', amount: 28499 }]);
  }

  monthStart(d: string, month: number) {
    const a = this.a;
    // Rent, by check, on the 1st.
    this.save({ type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.vendors.landlord, memo: `Rent ${d.slice(0, 7)}`, expenses: [{ account_id: a.Rent, amount: 650000 }] });
    // Health insurance, monthly.
    this.bill(d, 'health', `INV${d.slice(0, 7).replace('-', '')}`, [{ account: 'Insurance:Health', amount: 412000 }]);
    // Liability insurance, quarterly (prepaid and expensed monthly at month end).
    if (month % 3 === 1) this.bill(d, 'ins', `Q${Math.ceil(month / 3)}-${d.slice(0, 4)}`, [{ account: 'Prepaid Insurance', amount: 345000, memo: 'Quarterly premium' }]);
    // Workers comp, January and July.
    if (month === 1 || month === 7) this.bill(d, 'bwc', `BWC${d.slice(0, 4)}${month === 1 ? 'A' : 'B'}`, [{ account: 'Insurance:Workers Comp', amount: 268000 }]);
    // Ads and dues now and then.
    if (month % 2 === 0) this.bill(d, 'adv', `DBJ-${this.int(1000, 9999)}`, [{ account: 'Advertising', amount: 45000, memo: 'Directory listing' }]);
    if (month === 2) this.bill(d, 'dues', `${d.slice(0, 4)}-DUES`, [{ account: 'Dues & Subscriptions', amount: 95000, memo: 'Annual membership' }]);
    if (month === 3) this.bill(d, 'cpa', `${this.int(3000, 3999)}`, [{ account: 'Professional Fees', amount: 385000, memo: 'Tax return preparation' }]);
    if (this.chance(0.25)) this.bill(d, 'repair', `MMR-${this.int(500, 999)}`, [{ account: 'Repairs & Maintenance', amount: this.dollars(350, 4200), memo: this.pick(['Spindle bearing replacement', 'Way lube pump', 'Coolant system service', 'Haas preventive maintenance', 'Lathe chuck rebuild']) }]);
  }

  monthMid(d: string, _month: number) {
    const a = this.a;
    // Loan payment: principal + interest.
    const interest = Math.round((this.loanBalance * 625) / 10000 / 12);
    const payment = 275_000;
    const principal = Math.min(payment - interest, this.loanBalance);
    this.loanBalance -= principal;
    this.save({
      type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.other.bank, memo: 'Note #4471',
      expenses: [
        { account_id: a['Equipment Loan - Haas'], amount: principal, memo: 'Principal' },
        { account_id: a['Interest Expense'], amount: interest, memo: 'Interest' },
      ],
    });
    // Payroll tax deposits: last month's withholding and FICA.
    if (this.liab.fed + this.liab.fica > 0) {
      this.save({
        type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.vendors.irs, memo: 'Form 941 deposit',
        expenses: [
          { account_id: a['Payroll Liabilities:Federal Withholding'], amount: this.liab.fed },
          { account_id: a['Payroll Liabilities:FICA'], amount: this.liab.fica },
        ],
      });
      this.liab.fed = this.liab.fica = 0;
    }
    if (this.liab.state > 0) {
      this.save({
        type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.vendors.ohtax, memo: 'Ohio IT 501',
        expenses: [{ account_id: a['Payroll Liabilities:Ohio Withholding'], amount: this.liab.state }],
      });
      this.liab.state = 0;
    }
    // Owner draw.
    this.save({ type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.other.owner, memo: 'Draw', expenses: [{ account_id: a['Owner Draws'], amount: this.pick([300000, 400000, 500000]) }] });
  }

  monthEnd(d: string, month: number) {
    const a = this.a;
    if (d > this.through) return;
    // Bank charges and savings interest.
    const fee = this.int(2500, 4500);
    this.save({ type: 'GENJRNL', date: d, num: `BK${d.slice(0, 7).replace('-', '')}`, memo: 'Bank service charge', splits: [
      { account_id: a['Bank Service Charges'], amount: fee },
      { account_id: a.Checking, amount: -fee },
    ] });
    this.save({ type: 'DEPOSIT', date: d, account_id: a['Savings - Fifth Third'], memo: 'Interest', lines: [{ account_id: a['Interest Income'], description: 'Interest', amount: this.int(1800, 2600) }] });
    // Petty cash replenishment.
    const pc = this.balance(a['Petty Cash']);
    if (pc < 30_000) {
      this.save({ type: 'TRANSFER', date: d, from_account_id: a.Checking, to_account_id: a['Petty Cash'], amount: 30_000 - pc, memo: 'Replenish petty cash' });
    }
    // Sweep: keep checking between $40k and $90k.
    const chk = this.balance(a.Checking);
    if (chk > 9_000_000) this.save({ type: 'TRANSFER', date: d, from_account_id: a.Checking, to_account_id: a['Savings - Fifth Third'], amount: Math.round((chk - 6_000_000) / 100_000) * 100_000, memo: 'Sweep to savings' });
    else if (chk < 4_000_000 && this.balance(a['Savings - Fifth Third']) > 3_000_000) this.save({ type: 'TRANSFER', date: d, from_account_id: a['Savings - Fifth Third'], to_account_id: a.Checking, amount: 2_500_000, memo: 'Transfer to cover payables' });
    // Insurance expense from prepaid; depreciation.
    this.save({ type: 'GENJRNL', date: d, num: `AJ${d.slice(0, 7).replace('-', '')}`, memo: 'Month-end adjustments', splits: [
      { account_id: a['Insurance:Liability'], amount: 115000, memo: 'Prepaid insurance' },
      { account_id: a['Prepaid Insurance'], amount: -115000 },
      { account_id: a['Depreciation Expense'], amount: 410000, memo: 'Depreciation' },
      { account_id: a['Accumulated Depreciation'], amount: -410000 },
    ] });
    // Quarterly: unemployment taxes and finance charges.
    if (month % 3 === 0) {
      const lines = [];
      if (this.liab.futa) lines.push({ account_id: a['Payroll Liabilities:FUTA'], amount: this.liab.futa });
      if (lines.length) this.save({ type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.vendors.irs, memo: 'Form 940 deposit', expenses: lines });
      if (this.liab.suta) this.save({ type: 'CHECK', date: d, num: this.nextCheck(), account_id: a.Checking, name_id: this.vendors.ohtax, memo: 'Ohio JFS-20127 unemployment', expenses: [{ account_id: a['Payroll Liabilities:Ohio SUTA'], amount: this.liab.suta }] });
      this.liab.futa = this.liab.suta = 0;
      const due = previewFinanceCharges(this.db, d).filter((p) => p.overdue_balance > 50000);
      if (due.length) assessFinanceCharges(this.db, d, due.map((p) => p.name_id));
    }
    // Year end: close entries are QuickBooks-style automatic, so just a bonus run in December.
  }

  balance(accountId: number) {
    return (this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS b FROM splits WHERE account_id = ?').get(accountId) as { b: number }).b;
  }

  // ---- payroll ----

  payroll(d: string) {
    // Biweekly, paid on Fridays for the two weeks ending the previous Saturday.
    if (Math.floor(dayIndex(d) / 7) % 2 !== 1) return;
    const a = this.a;
    const P = this.pay;
    const periodTo = addDays(d, -6);
    const periodFrom = addDays(periodTo, -13);
    const december = d.slice(5, 7) === '12' && Number(d.slice(8)) >= 12 && Number(d.slice(8)) <= 25;
    const recent = d > addDays(this.through, -7);
    for (const e of this.employees) {
      if (e.hired > periodTo || (e.released && e.released < periodFrom)) continue;
      const lines: { payroll_item_id: number; hours?: number; rate?: number; amount?: number }[] = [];
      let gross = 0;
      if (e.hourly !== null) {
        const hours = this.pick([80, 80, 80, 80, 76, 72, 64]);
        const ot = this.chance(0.45) ? this.pick([2, 4, 5.5, 6, 8, 10]) : 0;
        lines.push({ payroll_item_id: P.hourly, hours, rate: e.hourly });
        gross += Math.round(hours * e.hourly);
        if (ot) {
          const otRate = Math.round(e.hourly * 1.5);
          lines.push({ payroll_item_id: P.ot, hours: ot, rate: otRate });
          gross += Math.round(ot * otRate);
        }
      } else if (e.salary !== null) {
        lines.push({ payroll_item_id: P.salary, amount: e.salary });
        gross += e.salary;
      }
      if (december) {
        lines.push({ payroll_item_id: P.bonus, amount: 50000 });
        gross += 50000;
      }
      const fed = Math.round((gross * e.fedPct) / 10000);
      const ss = Math.round(gross * 0.062);
      const med = Math.round(gross * 0.0145);
      const oh = Math.round((gross * e.statePct) / 10000);
      const futa = Math.round(gross * 0.006);
      const suta = Math.round(gross * 0.027);
      lines.push(
        { payroll_item_id: P.fed, amount: fed },
        { payroll_item_id: P.ss, amount: ss },
        { payroll_item_id: P.med, amount: med },
        { payroll_item_id: P.oh, amount: oh },
        { payroll_item_id: P.ssco, amount: ss },
        { payroll_item_id: P.medco, amount: med },
        { payroll_item_id: P.futa, amount: futa },
        { payroll_item_id: P.suta, amount: suta },
      );
      this.liab.fed += fed;
      this.liab.fica += 2 * (ss + med);
      this.liab.state += oh;
      this.liab.futa += futa;
      this.liab.suta += suta;
      this.save({
        type: 'PAYCHECK',
        date: d,
        num: recent ? '' : this.nextCheck(),
        to_print: recent,
        account_id: a.Checking,
        name_id: e.id,
        address: (this.db.prepare('SELECT bill_addr FROM names WHERE id = ?').get(e.id) as { bill_addr: string }).bill_addr,
        period_from: periodFrom,
        period_to: periodTo,
        lines,
      });
    }
  }

  // ---- pay bills ----

  payBills(d: string) {
    if (d > addDays(this.through, -4)) return;
    const unpaid = listUnpaidBills(this.db, { due_on_or_before: addDays(d, 12), pay_date: d });
    const credits = new Map<number, { id: number; unapplied: number }[]>();
    const vc = this.db
      .prepare(
        `SELECT t.id, t.name_id, t.total - COALESCE((SELECT SUM(amount) FROM links l WHERE l.kind = 'apply' AND l.from_txn = t.id), 0) AS unapplied
           FROM txns t WHERE t.type = 'BILLCREDIT'`,
      )
      .all() as { id: number; name_id: number; unapplied: number }[];
    for (const c of vc) if (c.unapplied > 0) credits.set(c.name_id, [...(credits.get(c.name_id) ?? []), c]);

    const payments: PayBillsInput['payments'] = [];
    const creditApps: PayBillsInput['credits'] = [];
    for (const b of unpaid) {
      // Discount bills are paid in time to take the discount; the rest close to the due date.
      const takingDiscount = b.suggested_discount > 0;
      if (!takingDiscount && b.due_date > addDays(d, 12)) continue;
      // A couple of bills slip past due now and then.
      if (!takingDiscount && this.chance(0.04)) continue;
      let open = b.open_balance;
      for (const c of credits.get(b.name_id) ?? []) {
        const amt = Math.min(c.unapplied, open);
        if (amt <= 0) continue;
        creditApps.push({ credit_id: c.id, bill_id: b.id, amount: amt });
        c.unapplied -= amt;
        open -= amt;
      }
      const discount = takingDiscount ? Math.min(b.suggested_discount, open) : 0;
      const amount = open - discount;
      if (amount <= 0 && discount === 0) continue;
      payments.push({ bill_id: b.id, amount, discount, discount_account_id: discount ? this.a['Discounts Taken'] : null });
    }
    if (payments.length === 0 && creditApps.length === 0) return;
    const res = payBills(
      this.db,
      PayBillsInput.parse({ date: d, account_id: this.a.Checking, first_check_num: String(this.checkNum), payments, credits: creditApps }),
    );
    const used = res.payments.filter((p) => p.num !== '').length;
    this.checkNum += used;
  }

  // ---- end state ----

  leaveSomeOpen() {
    // A few checks still to print at the end (no number yet), as at any real shop.
    const d = this.through;
    if (!isWeekday(d) && !isWeekday(addDays(d, -1))) return;
    this.save({
      type: 'CHECK', date: d, num: '', to_print: true, account_id: this.a.Checking, name_id: this.vendors.repair,
      memo: 'Emergency service call', expenses: [{ account_id: this.a['Repairs & Maintenance'], amount: 68500 }],
    });
    // Mark the bank statement through the end of last month as cleared, except a few checks.
    const stmt = addDays(`${ym(d)}-01`, -1);
    const bank = [this.a.Checking, this.a['Savings - Fifth Third']];
    const rows = this.db
      .prepare(
        `SELECT s.id, t.type, t.date FROM splits s JOIN txns t ON t.id = s.txn_id
          WHERE s.account_id IN (${bank.join(',')}) AND t.date <= ? ORDER BY t.date`,
      )
      .all(stmt) as { id: number; type: string; date: string }[];
    const late = addDays(stmt, -10);
    for (const r of rows) {
      // Checks written in the last ten days of the statement period may not have cleared.
      if (r.date > late && ['CHECK', 'BILLPMT', 'PAYCHECK'].includes(r.type) && this.chance(0.35)) continue;
      setCleared(this.db, r.id, true);
    }
  }
}

const EPOCH = Date.UTC(2000, 0, 3); // a Monday
function dayIndex(iso: string) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH) / 86_400_000);
}
