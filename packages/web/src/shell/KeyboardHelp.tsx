import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { useDesktop } from './desktop';
import type { WinProps } from './registry';

type Row = [keys: ReactNode, what: ReactNode];
interface Group {
  title: string;
  rows: Row[];
  sections?: { title: string; rows: Row[] }[];
}

const k = (...keys: string[]) => (
  <>
    {keys.map((x, i) => (
      <Fragment key={i}>
        {i > 0 && (x === 'or' || x === 'then' || x === ',' ? ` ${x} ` : '+')}
        {x === 'or' || x === 'then' || x === ',' ? null : <kbd>{x}</kbd>}
      </Fragment>
    ))}
  </>
);
/** Several alternative keys: "+ or =". */
const alt = (...keys: string[]) => (
  <>
    {keys.map((x, i) => (
      <Fragment key={i}>
        {i > 0 && ' or '}
        <kbd>{x}</kbd>
      </Fragment>
    ))}
  </>
);

/**
 * Every shortcut RapidBooks implements, grouped as in the QuickBooks manual. Written from
 * the code: shell/shortcuts.ts (global keys), MenuBar and MessageBox, controls/DateField
 * (applyDateKey), AmountField / RateField (evalAmount), Combo, LineGrid and the other grids,
 * ListView, each form's window Alt keys, ReportWindow and Graphs, and the Navigator.
 * Keep it in step when a key is added or removed.
 */
const GROUPS: Group[] = [
  {
    title: 'General',
    rows: [
      [
        <>
          <kbd>Alt</kbd>, then a letter, or {k('Alt', 'letter')}
        </>,
        'Open the menu with that underlined letter: File F, Edit E, View V, Lists L, Company C, Customers U, Vendors O, Employees Y, Banking B, Reports R, Window W, Help H. In a window, the window’s own underlined letters come first.',
      ],
      [
        <>
          {alt('↑', '↓')}, {alt('←', '→')}, <kbd>Enter</kbd>, <kbd>Esc</kbd>
        </>,
        'In an open menu: choose an item, go to the next menu or open a submenu (→), run the item, close the menu. A letter runs the item with that underlined letter.',
      ],
      [k('Esc'), 'Close the window you are in (it asks first if something has not been saved).'],
      [k('Ctrl', 'F6'), 'Go to the next open window.'],
      [k('Ctrl', 'Shift', 'F6'), 'Go to the previous open window.'],
      [k('Alt', 'W', ',', '1'), 'Window menu: go to window 1 to 9 in the list.'],
      [k('Tab'), 'Next field. Shift+Tab: previous field. Tab stays inside the window.'],
      [k('F2'), 'About RapidBooks: version, company file, last backup.'],
      [
        <>
          <kbd>Enter</kbd>, <kbd>Esc</kbd>
        </>,
        'In a message box: the highlighted button; Esc is Cancel (or No). The underlined letter of a button chooses it; arrows and Tab move between the buttons.',
      ],
    ],
  },
  {
    title: 'Dates',
    rows: [
      [alt('+', '='), 'Next day.'],
      [alt('-', '_'), 'Previous day.'],
      [k('T'), 'Today.'],
      [k('W'), 'First day of the week (Sunday). Again: the week before.'],
      [k('K'), 'Last day of the week (Saturday). Again: the week after.'],
      [k('M'), 'First day of the month. Again: the month before.'],
      [k('H'), 'Last day of the month. Again: the month after.'],
      [k('Y'), 'First day of the year. Again: the year before.'],
      [k('R'), 'Last day of the year. Again: the year after.'],
      ['12/31/25', 'Type a date as month/day/year (or 123125). A two-digit year 70-99 is 19xx, 00-69 is 20xx; no year is this year.'],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['3*12.50', 'Amount fields work out arithmetic (+ - * / and parentheses) when you leave the field. $ and commas are ignored.'],
      ['10%', 'Rate and price fields: a percentage when it ends in %; a price may have up to five decimals.'],
      ['Type the start', 'Name, item and account fields fill in the first match as you type (QuickFill). Typing "Parent:Child" picks or adds a job, subaccount or subitem.'],
      [
        <>
          {k('Alt', '↓')} or {k('Alt', '↑')}
        </>,
        'Open or close the drop-down list of the field.',
      ],
      [
        <>
          {alt('↑', '↓')}, {alt('PgUp', 'PgDn')}, <kbd>Enter</kbd>, <kbd>Esc</kbd>, <kbd>Tab</kbd>
        </>,
        'In an open drop-down list: move, choose, close it, or choose and go to the next field.',
      ],
      ['Leave the field', 'A name that is not on the list asks: Quick Add, Set Up or Cancel.'],
      [k('Ctrl', 'L'), 'Open the list (Customer:Job, Vendor, Item, Account, Terms...) for the field you are in.'],
      [k('Ctrl', 'Insert'), 'Insert a blank line above the one you are on.'],
      [k('Ctrl', 'Delete'), 'Delete the line you are on.'],
      [alt('↑', '↓'), 'In the lines of a form: the same column in the line above or below.'],
      [k('Space'), 'Receive Payments, Pay Bills, bill payments: in the payment column, tick or untick the row (an amount typed there is entered).'],
      [k('Ctrl', 'Enter'), 'Save the form and stay in it (in a dialog: OK; in Find: Find).'],
    ],
  },
  {
    title: 'Activities',
    rows: [
      [k('Ctrl', 'I'), 'Create Invoices.'],
      [k('Ctrl', 'W'), 'Write Checks. The browser keeps Ctrl+W for itself except in View > Full Screen; Alt+B, W always works.'],
      [k('Ctrl', 'J'), 'Customer:Job List.'],
      [k('Ctrl', 'A'), 'Chart of Accounts.'],
      [k('Ctrl', 'R'), 'Use Register: the register of the form you are in or of the account selected in the Chart of Accounts, otherwise the first bank account.'],
      [k('Ctrl', 'F'), 'Find.'],
      [k('Ctrl', 'Q'), 'QuickReport for the selected account, name or item, or the name on the form.'],
      [k('Ctrl', 'H'), 'Transaction History: what is linked to this transaction (payments, credits, deposits).'],
      [k('Ctrl', 'Y'), 'Transaction Journal: the debits and credits this transaction posts.'],
      [k('Ctrl', 'P'), 'Print the form or report.'],
      [k('Ctrl', 'N'), 'New (a new form, or a new entry in a list).'],
      [k('Ctrl', 'E'), 'Edit the selected entry or transaction.'],
      [k('Ctrl', 'D'), 'Delete the transaction or the selected entry (it asks first).'],
    ],
  },
  {
    title: 'Moving around a form',
    rows: [
      [k('Alt', 'S'), 'Save & Close (Pay & Close in Pay Bills, Send Now in e-mail windows, OK in dialogs).'],
      [k('Alt', 'N'), 'Save & New (Pay & New in Pay Bills, Next in a list entry such as New Customer).'],
      [k('Alt', 'P'), 'Previous transaction of the same kind.'],
      [k('Alt', 'X'), 'Next transaction of the same kind.'],
      [k('Enter'), 'In a list entry (New Customer, New Item...) and in Company Information: OK.'],
    ],
    sections: [
      {
        title: 'Create Invoices',
        rows: [
          [k('Alt', 'D'), 'Send by e-mail.'],
          [k('Alt', 'T'), 'Apply Credits (a saved invoice).'],
          [k('Alt', 'M'), 'Receive Payments for this customer (a saved invoice).'],
        ],
      },
      { title: 'Create Credit Memos/Refunds', rows: [[k('Alt', 'D'), 'Send by e-mail.']] },
      {
        title: 'Enter Bills',
        rows: [
          [k('Alt', 'M'), 'Expenses tab.'],
          [k('Alt', 'I'), 'Items tab.'],
          [k('Alt', 'A'), 'Recalculate the amount due from the lines.'],
        ],
      },
      {
        title: 'Write Checks',
        rows: [
          [k('Alt', 'K'), 'Expenses tab.'],
          [k('Alt', 'I'), 'Items tab.'],
          [k('Alt', 'T'), 'Recalculate the check amount from the lines (when they differ).'],
          [k('Alt', 'D'), 'To be printed.'],
        ],
      },
      { title: 'Enter Paycheck', rows: [[k('Alt', 'D'), 'To be printed.']] },
      {
        title: 'Pay Bills',
        rows: [
          [k('Alt', 'A'), 'Pay All Bills.'],
          [k('Alt', 'I'), 'Clear Selections.'],
          [k('Alt', 'D'), 'Set Discount for the bill you are on.'],
          [k('Alt', 'T'), 'Set Credits for the bill you are on.'],
        ],
      },
    ],
  },
  {
    title: 'Lists',
    rows: [
      [
        <>
          {alt('↑', '↓')}, {alt('PgUp', 'PgDn')}, {alt('Home', 'End')}
        </>,
        'Move through a list or register.',
      ],
      [k('Enter'), 'Open the selected entry or transaction (or double-click it).'],
      [
        <>
          {k('Ctrl', 'N')}, {k('Ctrl', 'E')}, {k('Ctrl', 'D')}
        </>,
        'New, Edit, Delete in a list window.',
      ],
      [k('Ctrl', 'Q'), 'QuickReport for the selected account, name or item.'],
      [k('Space'), 'In a list with tick boxes (forms to print or send, checks to print, payments to deposit, statements, finance charges, report filters): tick or untick the row.'],
      [
        <>
          {alt('←', '→', '↑', '↓')}, {alt('Home', 'End')}, <kbd>Enter</kbd>
        </>,
        'Company Navigator: move between the pictures, open one.',
      ],
    ],
  },
  {
    title: 'Reports',
    rows: [
      [
        <>
          {alt('↑', '↓')}, {alt('PgUp', 'PgDn')}, {alt('Home', 'End')}
        </>,
        'Move through the report rows.',
      ],
      [k('Enter'), 'QuickZoom: open the transaction or the detail report behind the row (or double-click it).'],
      [k('Alt', 'M'), 'Modify Report.'],
      [k('Alt', 'Z'), 'Memorize.'],
      [
        <>
          {k('Alt', 'P')} or {k('Ctrl', 'P')}
        </>,
        'Print.',
      ],
      [k('Alt', 'X'), 'Export to a CSV file.'],
      [k('Alt', 'D'), 'Go to the Dates box (also in the graphs).'],
      [k('Alt', 'G'), 'Refresh.'],
      [
        <>
          {alt('↑', '↓')}, <kbd>Enter</kbd>
        </>,
        'Sales Graph totals: choose a customer or item, open its report.',
      ],
    ],
  },
];

function Table({ rows }: { rows: Row[] }) {
  return (
    <table>
      <tbody>
        {rows.map(([keys, what], i) => (
          <tr key={i}>
            <td className="keys-k">{keys}</td>
            <td>{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Help > Keyboard Shortcuts. The list scrolls with the arrow keys and PgUp / PgDn. */
export function KeyboardHelp({ winId }: WinProps) {
  const desk = useDesktop();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => panel.current?.focus(), []);
  return (
    <div className="keys-window">
      <div ref={panel} className="keys-panel" tabIndex={0} aria-label="Keyboard shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <Table rows={g.rows} />
            {g.sections?.map((s) => (
              <Fragment key={s.title}>
                <div className="keys-note">
                  <b>{s.title}</b>
                </div>
                <Table rows={s.rows} />
              </Fragment>
            ))}
          </section>
        ))}
      </div>
      <div className="button-row right">
        <button type="button" className="btn default" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
