import { ACTIVITIES, activityTitle, type ActivityId } from './activities';
import { useDesktop } from './desktop';
import { Pictogram } from './icons';
import { setViewPref, useViewPrefs } from './viewPrefs';

/** Left to right, with a gap between groups (View > Top Icon Bar). */
const GROUPS: ActivityId[][] = [
  ['home'],
  ['invoice', 'payment', 'deposit'],
  ['bill', 'paybills', 'check', 'register'],
  ['customers', 'vendors', 'items', 'accounts'],
  ['reports', 'find', 'backup'],
];

/** Top to bottom on the left icon bar ("My Shortcuts"), with QuickBooks 2013's longer captions. */
const SHORTCUTS: ActivityId[] = [
  'home',
  'customers',
  'vendors',
  'items',
  'accounts',
  'invoice',
  'payment',
  'deposit',
  'bill',
  'paybills',
  'check',
  'register',
  'reports',
  'find',
  'backup',
];
const LONG: Partial<Record<ActivityId, string>> = {
  customers: 'Customers',
  vendors: 'Vendors',
  items: 'Items & Services',
  accounts: 'Chart of Accounts',
  invoice: 'Create Invoices',
  payment: 'Receive Payments',
  deposit: 'Make Deposits',
  bill: 'Enter Bills',
  paybills: 'Pay Bills',
  check: 'Write Checks',
  register: 'Registers',
  reports: 'Reports',
  backup: 'Back Up',
};

/**
 * The icon bar: across the top (View > Top Icon Bar) or down the left as QuickBooks 2013's
 * "My Shortcuts" (View > Left Icon Bar). Mouse only, as in QuickBooks: every button is
 * also a keyboard shortcut or a menu, shown in its tooltip, so the buttons stay out of the
 * Tab order and never take focus from the field being typed in.
 */
export function IconBar() {
  const desk = useDesktop();
  return (
    <div className="iconbar" role="toolbar" aria-label="Icon bar" onMouseDown={(e) => e.preventDefault()}>
      {GROUPS.map((g, i) => (
        <div key={i} className="iconbar-group">
          {g.map((id) => {
            const a = ACTIVITIES[id];
            return (
              <button
                key={id}
                type="button"
                className="iconbar-btn"
                tabIndex={-1}
                title={activityTitle(a)}
                aria-label={`${a.what} (${a.keys})`}
                onClick={() => a.run(desk)}
              >
                <Pictogram name={a.icon} />
                <span>{a.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function LeftIconBar() {
  const desk = useDesktop();
  const { leftBarOpen: open } = useViewPrefs();
  return (
    <div
      className={`lbar${open ? ' open' : ''}`}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="My Shortcuts"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="lbar-top">
        {open && <span className="lbar-heading">My Shortcuts</span>}
        <button
          type="button"
          className="lbar-toggle"
          tabIndex={-1}
          title={open ? 'Hide the shortcut names' : 'Show the shortcut names'}
          aria-label={open ? 'Fold the icon bar' : 'Open the icon bar'}
          onClick={() => setViewPref('leftBarOpen', !open)}
        >
          {open ? '‹' : '›'}
        </button>
      </div>
      {!open && (
        <button type="button" className="lbar-label" tabIndex={-1} onClick={() => setViewPref('leftBarOpen', true)}>
          {/* Turned on the inner span: older browsers ignore writing-mode on a button itself. */}
          <span className="lbar-label-text">My Shortcuts</span>
        </button>
      )}
      <div className="lbar-items">
        {SHORTCUTS.map((id) => {
          const a = ACTIVITIES[id];
          return (
            <button
              key={id}
              type="button"
              className="lbar-btn"
              tabIndex={-1}
              title={activityTitle(a)}
              aria-label={`${a.what} (${a.keys})`}
              onClick={() => a.run(desk)}
            >
              <Pictogram name={a.icon} />
              {open && <span>{LONG[id] ?? a.label}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
