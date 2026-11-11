import { useState, type ReactNode } from 'react';
import './form2013.css';

/**
 * The QuickBooks 2013 transaction ribbon: tabs (Main, Send/Ship, Reports...) over a strip
 * of grouped buttons, big ones with the caption underneath and small ones stacked two
 * high. Mouse only, as in QuickBooks: every button is also a key (shown in its tooltip), so
 * the ribbon stays out of the Tab order and never takes focus from the field being typed in.
 */
export interface RibbonTab {
  label: string;
  content: ReactNode;
}

export function Ribbon({ tabs }: { tabs: RibbonTab[] }) {
  const [current, setCurrent] = useState(0);
  const tab = tabs[Math.min(current, tabs.length - 1)];
  return (
    <div className="ribbon" onMouseDown={(e) => e.preventDefault()}>
      <div className="ribbon-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className={`ribbon-tab${t === tab ? ' on' : ''}`}
            tabIndex={-1}
            onClick={() => setCurrent(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ribbon-body" role="toolbar" aria-label={tab.label}>
        {tab.content}
      </div>
    </div>
  );
}

export const RibbonGroup = ({ children }: { children: ReactNode }) => <div className="rb-group">{children}</div>;

/** Small buttons stacked two (or three) high. */
export const RibbonStack = ({ children }: { children: ReactNode }) => <div className="rb-stack">{children}</div>;

interface BtnProps {
  icon: RibbonIconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** The key that does the same, for the tooltip. */
  keys?: string;
}

export function RibbonBig({ icon, label, onClick, disabled, keys }: BtnProps) {
  return (
    <button
      type="button"
      className="rb-big"
      tabIndex={-1}
      disabled={disabled || !onClick}
      title={keys ? `${label.replace('\n', ' ')} (${keys})` : label.replace('\n', ' ')}
      onClick={onClick}
    >
      <RibbonIcon name={icon} big />
      <span>{label}</span>
    </button>
  );
}

export function RibbonSmall({ icon, label, onClick, disabled, keys }: BtnProps) {
  return (
    <button
      type="button"
      className="rb-small"
      tabIndex={-1}
      disabled={disabled || !onClick}
      title={keys ? `${label} (${keys})` : label}
      onClick={onClick}
    >
      <RibbonIcon name={icon} />
      <span>{label}</span>
    </button>
  );
}

export function RibbonCheck({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="rb-check">
      <input type="checkbox" tabIndex={-1} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** The ← → arrows (Previous / Next) over the Find button, at the left of every ribbon. */
export function RibbonFind({ onPrev, onNext, onFind, disabled }: { onPrev: () => void; onNext: () => void; onFind: () => void; disabled?: boolean }) {
  return (
    <div className="rb-find">
      <div className="rb-arrows">
        <button type="button" tabIndex={-1} disabled={disabled} title="Previous (Alt+P)" aria-label="Previous" onClick={onPrev}>
          <RibbonIcon name="prev" />
        </button>
        <button type="button" tabIndex={-1} disabled={disabled} title="Next (Alt+X)" aria-label="Next" onClick={onNext}>
          <RibbonIcon name="next" />
        </button>
      </div>
      <button type="button" className="rb-findbtn" tabIndex={-1} title="Find (Ctrl+F)" onClick={onFind}>
        Find
      </button>
    </div>
  );
}

export type RibbonIconName =
  | 'prev'
  | 'next'
  | 'new'
  | 'save'
  | 'delete'
  | 'copy'
  | 'print'
  | 'email'
  | 'credits'
  | 'payments'
  | 'refund'
  | 'history'
  | 'journal'
  | 'report'
  | 'lookup'
  | 'discount'
  | 'autoapply';

const BLUE = '#2f6fd0';
const INK = '#4a4a4a';
const GREEN = '#3d9a3d';

const GLYPHS: Record<RibbonIconName, ReactNode> = {
  prev: <path d="M3 10l7-6v4h7v4h-7v4z" fill={BLUE} />,
  next: <path d="M17 10l-7-6v4H3v4h7v4z" fill={BLUE} />,
  new: (
    <>
      <path d="M4 2h9l3 3v13H4z" fill={BLUE} />
      <path d="M8 11l1 1.6 1.8.4-1.3 1.3.3 1.8L8 15.3l-1.6.8.3-1.8-1.3-1.3 1.8-.4z" fill="#fff" />
    </>
  ),
  save: (
    <>
      <rect x={2} y={3} width={16} height={14} rx={1} fill={BLUE} />
      <rect x={5} y={3} width={10} height={5} fill="#dfe9f8" />
      <rect x={5} y={11} width={10} height={6} fill="#fff" />
    </>
  ),
  delete: <path d="M4 5l2-2 4 4 4-4 2 2-4 4 4 4-2 2-4-4-4 4-2-2 4-4z" fill="#fff" stroke={BLUE} strokeWidth={1.3} />,
  copy: (
    <>
      <path d="M3 5h8v12H3z" fill="#fff" stroke={BLUE} />
      <path d="M7 2h7l3 3v11H7z" fill={BLUE} />
    </>
  ),
  print: (
    <>
      <path d="M5 2h10v5H5z" fill="#fff" stroke={INK} />
      <rect x={2} y={7} width={16} height={7} rx={1} fill="#e2a33a" stroke="#9a6a1a" />
      <path d="M5 12h10v6H5z" fill="#fff" stroke={INK} />
    </>
  ),
  email: (
    <>
      <rect x={2} y={5} width={16} height={11} rx={1} fill="#e8c860" stroke="#9a7a1a" />
      <path d="M2 6l8 6 8-6" fill="none" stroke="#9a7a1a" />
    </>
  ),
  credits: (
    <>
      <rect x={2} y={4} width={13} height={10} fill={GREEN} />
      <path d="M12 13l3 3 4-6" fill="none" stroke="#1e5e1e" strokeWidth={2} />
    </>
  ),
  payments: (
    <>
      <rect x={1} y={6} width={13} height={8} fill="#5cae5c" stroke="#2e6e2e" />
      <rect x={5} y={9} width={13} height={8} fill={GREEN} stroke="#2e6e2e" />
      <circle cx={11.5} cy={13} r={2} fill="#bfe3bf" />
    </>
  ),
  refund: (
    <>
      <rect x={2} y={4} width={14} height={9} fill={GREEN} stroke="#2e6e2e" />
      <path d="M7 16h8l-3-3m3 3l-3 3" fill="none" stroke="#2e6e2e" strokeWidth={1.6} />
    </>
  ),
  history: (
    <>
      <circle cx={10} cy={10} r={7} fill="#fff" stroke={BLUE} strokeWidth={1.5} />
      <path d="M10 5v5l3 2" fill="none" stroke={BLUE} strokeWidth={1.5} />
    </>
  ),
  journal: (
    <>
      <path d="M4 2h12v16H4z" fill="#fff" stroke={INK} />
      <path d="M7 6h6M7 9h6M7 12h6M7 15h4" stroke={BLUE} />
    </>
  ),
  report: (
    <>
      <path d="M3 2h14v16H3z" fill="#fff" stroke={INK} />
      <path d="M6 15V10M10 15V6M14 15v-3" stroke={GREEN} strokeWidth={2.4} />
    </>
  ),
  lookup: (
    <>
      <path d="M3 2h10v14H3z" fill="#fff" stroke={INK} />
      <circle cx={12} cy={11} r={4} fill="#dfe9f8" stroke={GREEN} strokeWidth={1.6} />
      <path d="M15 14l3 3" stroke={GREEN} strokeWidth={2} />
    </>
  ),
  discount: (
    <>
      <rect x={2} y={4} width={16} height={12} fill="#5cae5c" stroke="#2e6e2e" />
      <path d="M6 13l8-6" stroke="#fff" strokeWidth={1.6} />
      <circle cx={7} cy={8} r={1.4} fill="#fff" />
      <circle cx={13} cy={12} r={1.4} fill="#fff" />
    </>
  ),
  autoapply: (
    <>
      <rect x={2} y={4} width={16} height={12} fill="#5cae5c" stroke="#2e6e2e" />
      <path d="M6 10l3 3 5-6" fill="none" stroke="#fff" strokeWidth={2} />
    </>
  ),
};

export function RibbonIcon({ name, big }: { name: RibbonIconName; big?: boolean }) {
  return (
    <svg className={big ? 'rb-icon big' : 'rb-icon'} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}
