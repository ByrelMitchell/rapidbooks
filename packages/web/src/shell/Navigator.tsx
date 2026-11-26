import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { formatWhen, timeAgo, useBackupStatus } from '../admin/backupStatus';
import { openRegister } from './shortcuts';
import { useDesktop, type Desktop } from './desktop';
import { Pictogram, type IconName } from './icons';
import type { WinProps } from './registry';

/*
 * Company > Home Page, laid out like her QuickBooks 2013 Home page: the Vendors, Customers and
 * Employees panels with the day's work drawn as a flow on the left, Company and Banking on
 * the right. Coordinates are in the screenshot's pixels (the diagram is 1856 x 874) and are
 * turned into percentages, so the picture keeps its shape at any window size.
 * Steps her QuickBooks shows that RapidBooks has not got (Estimates, Accept Credit Cards,
 * Enter Time, Reconcile...) are shown greyed out; their tooltip says so. Statements is the
 * entry QuickBooks adds when statements are turned on. Her Home page has no Transfer Funds
 * or reports: those are on the Banking and Reports menus and the icon bar. The Intuit service
 * links (Loan Finder, Web and Mobile Apps) are left out.
 */

const W = 1856;
const H = 874;

interface Panel {
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The panel's title button opens its center (as in QuickBooks 2013). */
  open?: (d: Desktop) => void;
  what?: string;
}

const PANELS: Panel[] = [
  { title: 'Vendors', x: 0, y: 0, w: 1422, h: 257, open: (d) => d.open('vendors'), what: 'Vendor Center' },
  { title: 'Customers', x: 0, y: 274, w: 1422, h: 377, open: (d) => d.open('customers'), what: 'Customer Center (Ctrl+J)' },
  { title: 'Employees', x: 0, y: 668, w: 1422, h: 206, open: (d) => d.open('employeecenter'), what: 'Employee Center' },
  { title: 'Company', x: 1437, y: 0, w: 419, h: 352 },
  { title: 'Banking', x: 1437, y: 369, w: 419, h: 505 },
];

interface Step {
  /** Centre of the icon. */
  x: number;
  y: number;
  icon: IconName;
  label: string;
  /** Tooltip: what it opens and the keys for it (or, when it is not implemented, its name). */
  title: string;
  /** None: RapidBooks has not got this; the step is greyed out. */
  run?: (d: Desktop) => void;
}

const notImplemented = (what: string) => `${what} is not implemented in RapidBooks. If you would like it, contact the developer.`;

const STEPS: Step[] = [
  // Vendors
  { x: 173, y: 55, icon: 'po', label: 'Purchase\nOrders', title: 'Create Purchase Orders (Alt+O, P)', run: (d) => d.open('purchaseorder', { id: null }) },
  {
    x: 533,
    y: 55,
    icon: 'items',
    label: 'Receive\nInventory',
    // QuickBooks' "Receive Inventory with Bill" is Enter Bills against a purchase order; receiving without a bill is not implemented.
    title: 'Receive Inventory with Bill: Enter Bills, then receive against the vendor\'s open purchase orders (Alt+O, E). Receiving inventory without a bill is not implemented.',
    run: (d) => d.open('bill', { id: null }),
  },
  { x: 895, y: 55, icon: 'bill', label: 'Enter Bills\nAgainst\nInventory', title: 'Enter Bills Against Inventory (item receipts)' },
  { x: 371, y: 179, icon: 'bill', label: 'Enter Bills', title: 'Enter Bills (Alt+O, E)', run: (d) => d.open('bill', { id: null }) },
  { x: 1251, y: 179, icon: 'paybills', label: 'Pay Bills', title: 'Pay Bills (Alt+O, B)', run: (d) => d.open('paybills') },
  // Customers
  { x: 706, y: 341, icon: 'payment', label: 'Accept\nCredit Cards', title: 'Accept Credit Cards' },
  { x: 173, y: 452, icon: 'statement', label: 'Estimates', title: 'Estimates' },
  { x: 371, y: 452, icon: 'invoice', label: 'Create\nInvoices', title: 'Create Invoices (Ctrl+I)', run: (d) => d.open('invoice', { id: null }) },
  { x: 947, y: 452, icon: 'payment', label: 'Receive\nPayments', title: 'Receive Payments (Alt+U, R)', run: (d) => d.open('payment', { id: null }) },
  { x: 661, y: 567, icon: 'finance', label: 'Finance\nCharges', title: 'Assess Finance Charges (Alt+U, C)', run: (d) => d.open('financecharges') },
  { x: 947, y: 567, icon: 'statement', label: 'Statements', title: 'Create Statements (Alt+U, S)', run: (d) => d.open('statements') },
  {
    x: 1252,
    y: 567,
    icon: 'creditmemo',
    label: 'Refunds\n& Credits',
    title: 'Create Credit Memos/Refunds (Alt+U, M)',
    run: (d) => d.open('creditmemo', { id: null }),
  },
  // Employees
  { x: 175, y: 731, icon: 'employees', label: 'Turn On\nPayroll', title: 'Payroll service setup' },
  { x: 371, y: 731, icon: 'register', label: 'Enter\nTime', title: 'Enter Time (timesheets)' },
  { x: 631, y: 731, icon: 'employees', label: 'Pay\nEmployees', title: 'Enter Paycheck (Alt+Y, P)', run: (d) => d.open('paycheck', { id: null }) },
  { x: 872, y: 731, icon: 'paybills', label: 'Pay\nLiabilities', title: 'Pay Payroll Liabilities' },
  { x: 1285, y: 731, icon: 'employees', label: 'Employee\nBenefits', title: 'Employee Benefits' },
  // Company
  { x: 1546, y: 58, icon: 'accounts', label: 'Chart of\nAccounts', title: 'Chart of Accounts (Ctrl+A)', run: (d) => d.open('accounts') },
  { x: 1715, y: 58, icon: 'items', label: 'Inventory\nActivities', title: 'Inventory Activities' },
  { x: 1546, y: 160, icon: 'items', label: 'Items &\nServices', title: 'Item List (Alt+L, I)', run: (d) => d.open('items') },
  { x: 1715, y: 267, icon: 'register', label: 'Calendar', title: 'Calendar' },
  // Banking
  { x: 1546, y: 452, icon: 'deposit', label: 'Record\nDeposits', title: 'Make Deposits (Alt+B, D)', run: (d) => d.open('deposit', { id: null }) },
  { x: 1715, y: 452, icon: 'register', label: 'Reconcile', title: 'Reconcile' },
  { x: 1546, y: 578, icon: 'check', label: 'Write\nChecks', title: 'Write Checks (Ctrl+W)', run: (d) => d.open('check', { id: null }) },
  { x: 1715, y: 578, icon: 'register', label: 'Check\nRegister', title: 'Use Register (Ctrl+R)', run: (d) => void openRegister(d) },
  { x: 1546, y: 715, icon: 'check', label: 'Print\nChecks', title: 'Print Checks', run: (d) => d.open('printchecks') },
  { x: 1715, y: 715, icon: 'check', label: 'Enter Credit\nCard Charges', title: 'Enter Credit Card Charges' },
];

/** The flow lines; `arrow` puts a head at the end. */
const LINES: { d: string; arrow?: boolean }[] = [
  { d: 'M195 55H511', arrow: true }, // Purchase Orders -> Receive Inventory
  { d: 'M557 55H873', arrow: true }, // Receive Inventory -> Enter Bills Against Inventory
  { d: 'M895 132V179' }, // Enter Bills Against Inventory joins the Pay Bills line
  { d: 'M393 179H1229', arrow: true }, // Enter Bills -> Pay Bills
  // Vertical lines start and end clear of the labels under the icons, as in QuickBooks.
  { d: 'M173 430V119', arrow: true }, // Estimates -> Purchase Orders
  { d: 'M371 221V430', arrow: true }, // Enter Bills -> Create Invoices (billable costs)
  { d: 'M195 452H349', arrow: true }, // Estimates -> Create Invoices
  { d: 'M393 452H925', arrow: true }, // Create Invoices -> Receive Payments
  { d: 'M685 567H925', arrow: true }, // Finance Charges -> Statements
  { d: 'M947 545V516', arrow: true }, // Statements -> Receive Payments
  { d: 'M969 452H1524', arrow: true }, // Receive Payments -> Record Deposits
  { d: 'M371 709V516', arrow: true }, // Enter Time -> Create Invoices
  { d: 'M393 731H609', arrow: true }, // Enter Time -> Pay Employees
  { d: 'M653 731H850', arrow: true }, // Pay Employees -> Pay Liabilities
];

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

export function Navigator(_: WinProps) {
  const desk = useDesktop();
  const { status, error } = useBackupStatus();
  const rootRef = useRef<HTMLDivElement>(null);

  // Arrow keys move to the nearest button in that direction; Home / End: first / last.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (!t.classList.contains('home-btn')) return;
    const all = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.home-btn') ?? []);
    const centre = (b: HTMLElement) => {
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const c = centre(t);
    let next: HTMLButtonElement | undefined;
    const dirs: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (dirs[e.key]) {
      const [dx, dy] = dirs[e.key];
      let best = Infinity;
      for (const b of all) {
        if (b === t) continue;
        const p = centre(b);
        const along = (p.x - c.x) * dx + (p.y - c.y) * dy;
        if (along <= 4) continue;
        const across = Math.abs((p.x - c.x) * dy) + Math.abs((p.y - c.y) * dx);
        const score = along + across * 2;
        if (score < best) {
          best = score;
          next = b;
        }
      }
    } else return;
    e.preventDefault();
    next?.focus();
  };

  const last = status?.lastSuccess;
  let backupText: string;
  if (status) backupText = last ? `${formatWhen(last.at)} (${timeAgo(last.at)})` : 'No backup has been made yet.';
  else backupText = error ? 'Not known (the server did not answer).' : 'Checking...';

  return (
    <div className="home" ref={rootRef} onKeyDown={onKeyDown}>
      <div className="home-map">
        {PANELS.map((p) => (
          <div
            key={p.title}
            className="home-panel"
            style={{ left: pct(p.x, W), top: pct(p.y, H), width: pct(p.w, W), height: pct(p.h, H) }}
          >
            {p.open ? (
              <button type="button" className="home-title home-btn" title={p.what} onClick={() => p.open!(desk)}>
                {p.title}
              </button>
            ) : (
              <span className="home-title">{p.title}</span>
            )}
          </div>
        ))}
        <svg className="home-lines" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          <defs>
            <marker id="home-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#c8c8c8" />
            </marker>
          </defs>
          {LINES.map((l) => (
            <path key={l.d} d={l.d} fill="none" stroke="#c8c8c8" strokeWidth={4} markerEnd={l.arrow ? 'url(#home-arrow)' : undefined} />
          ))}
        </svg>
        {STEPS.map((s) => (
          // A step RapidBooks has not got stays focusable (aria-disabled, not disabled) so its tooltip
          // shows on hover and a click or Enter puts the same note on the status bar.
          <button
            key={`${s.x},${s.y}`}
            type="button"
            className={`home-step home-btn${s.run ? '' : ' off'}`}
            style={{ left: pct(s.x, W), top: pct(s.y, H) } as CSSProperties}
            title={s.run ? s.title : notImplemented(s.title)}
            aria-disabled={s.run ? undefined : true}
            onClick={() => (s.run ? s.run(desk) : desk.setStatus(notImplemented(s.title)))}
          >
            <Pictogram name={s.icon} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
      <div className={`nav-backup${status?.warning ? ' warn' : ''}`}>
        <span>
          <b>Last backup:</b> {backupText}
          {status?.warning && <span className="nav-backup-warn"> {status.warning}</span>}
        </span>
        <button type="button" className="btn nav-backup-btn" onClick={() => desk.open('backup')} title="File > Back Up (Alt+F, B)">
          Back Up...
        </button>
      </div>
    </div>
  );
}
