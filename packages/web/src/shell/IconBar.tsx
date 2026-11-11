import { ACTIVITIES, activityTitle, type ActivityId } from './activities';
import { useDesktop } from './desktop';
import { Pictogram } from './icons';

/** Left to right, with a gap between groups, as on the QuickBooks 2003 icon bar. */
const GROUPS: ActivityId[][] = [
  ['invoice', 'payment', 'deposit'],
  ['bill', 'paybills', 'check', 'register'],
  ['customers', 'vendors', 'items', 'accounts'],
  ['reports', 'find', 'backup'],
];

/**
 * The icon bar under the menu bar (View > Icon Bar hides it). Mouse only, as in QuickBooks:
 * every button is also a keyboard shortcut or a menu, shown in its tooltip, so the buttons
 * stay out of the Tab order and never take focus from the field being typed in.
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
