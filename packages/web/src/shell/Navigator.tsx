import { Fragment, useRef, type KeyboardEvent } from 'react';
import { formatWhen, timeAgo, useBackupStatus } from '../admin/backupStatus';
import { ACTIVITIES, activityTitle, type ActivityId } from './activities';
import { useDesktop } from './desktop';
import { Pictogram, type IconName } from './icons';
import type { WinProps } from './registry';

interface NavRow {
  title: string;
  icon: IconName;
  /** The workflow, drawn with arrows between the steps. */
  flow: ActivityId[];
  /** Other things in this area, after the workflow. */
  more: ActivityId[];
}

const ROWS: NavRow[] = [
  { title: 'Customers', icon: 'customers', flow: ['invoice', 'payment', 'deposit'], more: ['statements', 'finance', 'creditmemo'] },
  { title: 'Vendors', icon: 'vendors', flow: ['po', 'bill', 'paybills'], more: [] },
  { title: 'Banking', icon: 'register', flow: [], more: ['check', 'transfer', 'register'] },
  { title: 'Employees', icon: 'employees', flow: [], more: ['paycheck'] },
  { title: 'Reports', icon: 'reports', flow: [], more: ['pl', 'trip', 'salescust', 'aging'] },
];

/** The navigator's longer captions (the icon bar uses QuickBooks' short ones). */
const CAPTIONS: Partial<Record<ActivityId, string>> = {
  invoice: 'Invoices',
  payment: 'Receive Payments',
  deposit: 'Deposits',
  bill: 'Enter Bills',
  paybills: 'Pay Bills',
  check: 'Write Checks',
  register: 'Registers',
};

function Arrow() {
  return (
    <svg className="nav-arrow" viewBox="0 0 24 12" aria-hidden="true" focusable="false">
      <path d="M1 6h17" stroke="#0a246a" strokeWidth={2} />
      <path d="M16 1l7 5-7 5z" fill="#0a246a" />
    </svg>
  );
}

/**
 * Company > Navigator: the QuickBooks 2003 Company Navigator, a flow diagram of the
 * day's work. Opened at start-up. Every picture is a real button: Tab / Shift+Tab or the
 * arrow keys move between them (Home / End: first / last), Enter or Space opens.
 */
export function Navigator(_: WinProps) {
  const desk = useDesktop();
  const { status, error } = useBackupStatus();
  const rootRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target as HTMLElement;
    if (!t.classList.contains('nav-btn')) return;
    const all = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.nav-btn') ?? []);
    const i = all.indexOf(t as HTMLButtonElement);
    if (i < 0) return;
    let next: HTMLButtonElement | undefined;
    switch (e.key) {
      case 'ArrowRight':
        next = all[Math.min(all.length - 1, i + 1)];
        break;
      case 'ArrowLeft':
        next = all[Math.max(0, i - 1)];
        break;
      case 'Home':
        next = all[0];
        break;
      case 'End':
        next = all[all.length - 1];
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        // The nearest button (by its centre) in the row above or below.
        const row = Number(t.dataset.row);
        const target = row + (e.key === 'ArrowDown' ? 1 : -1);
        const there = all.filter((b) => Number(b.dataset.row) === target);
        if (!there.length) break;
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const dist = (b: HTMLElement) => {
          const q = b.getBoundingClientRect();
          return Math.abs(q.left + q.width / 2 - cx);
        };
        next = there.reduce((best, b) => (dist(b) < dist(best) ? b : best));
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    next?.focus();
  };

  const button = (id: ActivityId, row: number) => {
    const a = ACTIVITIES[id];
    return (
      <button key={id} type="button" className="nav-btn" data-row={row} title={activityTitle(a)} onClick={() => a.run(desk)}>
        <Pictogram name={a.icon} />
        <span>{CAPTIONS[id] ?? a.label}</span>
      </button>
    );
  };

  const last = status?.lastSuccess;
  let backupText: string;
  if (status) backupText = last ? `${formatWhen(last.at)} (${timeAgo(last.at)})` : 'No backup has been made yet.';
  else backupText = error ? 'Not known (the server did not answer).' : 'Checking...';

  return (
    <div className="navigator" ref={rootRef} onKeyDown={onKeyDown}>
      {ROWS.map((r, ri) => (
        <div key={r.title} className="nav-row">
          <div className="nav-head">
            <Pictogram name={r.icon} />
            <span>{r.title}</span>
          </div>
          <div className="nav-body">
            {r.flow.length > 0 && (
              <div className="nav-flow">
                {r.flow.map((id, k) => (
                  <Fragment key={id}>
                    {k > 0 && <Arrow />}
                    {button(id, ri)}
                  </Fragment>
                ))}
              </div>
            )}
            {r.more.length > 0 && <div className="nav-more">{r.more.map((id) => button(id, ri))}</div>}
          </div>
        </div>
      ))}
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
