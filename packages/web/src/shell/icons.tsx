import type { ReactNode } from 'react';

/**
 * Small pictograms for the icon bar and the Company Navigator, drawn inline in the
 * restrained style of the Windows 2000 / QuickBooks 2003 toolbars: dark outlines, paper
 * white, a few flat colours. 32 x 32 user units; sized by CSS (rem, so View > Zoom scales them).
 */
export type IconName =
  | 'invoice'
  | 'payment'
  | 'deposit'
  | 'bill'
  | 'paybills'
  | 'check'
  | 'register'
  | 'customers'
  | 'vendors'
  | 'items'
  | 'accounts'
  | 'reports'
  | 'find'
  | 'backup'
  | 'statement'
  | 'finance'
  | 'creditmemo'
  | 'po'
  | 'transfer'
  | 'employees'
  | 'pl'
  | 'trip'
  | 'salescust'
  | 'aging'
  | 'home';

const INK = '#404040';
const PAPER = '#ffffff';
const NAVY = '#0a246a';
const GREEN = '#2e7d32';
const RED = '#b00000';
const TAN = '#e8d8a8';
const GREY = '#c0c0c0';

/** A sheet of paper with a folded corner, optionally with ruled lines. */
const sheet = (x: number, y: number, w: number, h: number, lines = 0, fill = PAPER) => (
  <>
    <path d={`M${x} ${y}h${w - 5}l5 5v${h - 5}h-${w}z`} fill={fill} stroke={INK} />
    <path d={`M${x + w - 5} ${y}v5h5`} fill="none" stroke={INK} />
    {Array.from({ length: lines }, (_, i) => (
      <path key={i} d={`M${x + 3} ${y + 9 + i * 4}h${w - 7}`} stroke={GREY} strokeWidth={1.5} />
    ))}
  </>
);

const dollar = (cx: number, cy: number, color: string) => (
  <text x={cx} y={cy} fontSize={11} fontWeight="bold" fontFamily="Tahoma, Verdana, sans-serif" textAnchor="middle" fill={color}>
    $
  </text>
);

const ICONS: Record<IconName, ReactNode> = {
  invoice: (
    <>
      {sheet(7, 3, 18, 26, 4)}
      {dollar(20, 27, GREEN)}
    </>
  ),
  payment: (
    <>
      <ellipse cx={16} cy={21} rx={11} ry={5} fill="#d8b040" stroke={INK} />
      <ellipse cx={16} cy={17} rx={11} ry={5} fill="#f0d060" stroke={INK} />
      <ellipse cx={16} cy={13} rx={11} ry={5} fill="#f8e080" stroke={INK} />
      {dollar(16, 17, '#806000')}
    </>
  ),
  deposit: (
    <>
      <path d="M4 12L16 5l12 7z" fill={GREY} stroke={INK} />
      <path d="M6 13h20v2H6zM7 26h18v2H7z" fill={GREY} stroke={INK} />
      <path d="M9 15v11M14 15v11M18 15v11M23 15v11" stroke={INK} strokeWidth={2} />
      <path d="M16 1v8m-3-3l3 3 3-3" fill="none" stroke={GREEN} strokeWidth={2} />
    </>
  ),
  bill: (
    <>
      {sheet(7, 3, 18, 26, 4, '#fff8e8')}
      {dollar(20, 27, RED)}
    </>
  ),
  paybills: (
    <>
      {sheet(4, 3, 15, 20, 3, '#fff8e8')}
      <rect x={9} y={16} width={20} height={11} fill="#e0f0e0" stroke={INK} />
      <path d="M12 23h8M22 20h5" stroke={INK} />
      <path d="M2 28l6-6" stroke={GREEN} strokeWidth={2} />
    </>
  ),
  check: (
    <>
      <rect x={2} y={9} width={28} height={15} fill="#e0f0e0" stroke={INK} />
      <path d="M5 14h10M5 20h12M21 14h6" stroke={INK} />
      <path d="M19 21c2-3 3 2 5-1s2 1 4-1" fill="none" stroke={NAVY} />
    </>
  ),
  register: (
    <>
      <rect x={5} y={3} width={22} height={26} fill={PAPER} stroke={INK} />
      <path d="M5 9h22M5 14h22M5 19h22M5 24h22M12 3v26M21 3v26" stroke={GREY} />
      <path d="M5 3h22v4H5z" fill={NAVY} />
      <path d="M23 15l1.5 2 3-4" fill="none" stroke={GREEN} strokeWidth={1.5} />
    </>
  ),
  customers: (
    <>
      <circle cx={16} cy={10} r={5} fill={TAN} stroke={INK} />
      <path d="M6 28c0-7 4-10 10-10s10 3 10 10z" fill={NAVY} stroke={INK} />
    </>
  ),
  vendors: (
    <>
      <rect x={2} y={10} width={17} height={12} fill={GREY} stroke={INK} />
      <path d="M19 14h6l4 4v4H19z" fill="#6080c0" stroke={INK} />
      <circle cx={8} cy={24} r={3} fill={INK} />
      <circle cx={24} cy={24} r={3} fill={INK} />
    </>
  ),
  items: (
    <>
      <path d="M4 10l12-5 12 5-12 5z" fill="#e8c890" stroke={INK} />
      <path d="M4 10v13l12 5V15z" fill="#d0a868" stroke={INK} />
      <path d="M28 10v13l-12 5V15z" fill="#b88c50" stroke={INK} />
    </>
  ),
  accounts: (
    <>
      <rect x={4} y={3} width={9} height={6} fill={NAVY} stroke={INK} />
      <path d="M8 9v18M8 15h6M8 21h6M8 27h6" fill="none" stroke={INK} />
      <rect x={14} y={12} width={14} height={6} fill={PAPER} stroke={INK} />
      <rect x={14} y={18} width={14} height={6} fill={PAPER} stroke={INK} />
      <rect x={14} y={24} width={14} height={6} fill={PAPER} stroke={INK} />
    </>
  ),
  reports: (
    <>
      {sheet(5, 2, 22, 28)}
      <path d="M10 25v-6h3v6zM15 25v-11h3v11zM20 25v-8h3v8z" fill={NAVY} stroke={INK} />
    </>
  ),
  find: (
    <>
      <circle cx={13} cy={13} r={8} fill="#e0f0ff" stroke={INK} strokeWidth={2} />
      <path d="M19 19l9 9" stroke={INK} strokeWidth={4} strokeLinecap="round" />
    </>
  ),
  backup: (
    <>
      <rect x={4} y={4} width={24} height={24} fill="#404860" stroke={INK} />
      <rect x={9} y={4} width={14} height={9} fill={GREY} stroke={INK} />
      <rect x={18} y={6} width={3} height={5} fill={INK} />
      <rect x={8} y={17} width={16} height={11} fill={PAPER} stroke={INK} />
      <path d="M10 21h12M10 24h12" stroke={GREY} />
    </>
  ),
  statement: (
    <>
      {sheet(9, 2, 18, 22, 0)}
      {sheet(5, 7, 18, 23, 4)}
    </>
  ),
  finance: (
    <>
      {sheet(7, 3, 18, 26, 2)}
      <text x={16} y={26} fontSize={12} fontWeight="bold" fontFamily="Tahoma, Verdana, sans-serif" textAnchor="middle" fill={RED}>
        %
      </text>
    </>
  ),
  creditmemo: (
    <>
      {sheet(7, 3, 18, 26, 4)}
      <path d="M12 24h9" stroke={RED} strokeWidth={2.5} />
    </>
  ),
  po: (
    <>
      <rect x={6} y={5} width={20} height={25} fill="#c8a060" stroke={INK} />
      <rect x={8} y={8} width={16} height={20} fill={PAPER} stroke={INK} />
      <rect x={12} y={3} width={8} height={4} fill={GREY} stroke={INK} />
      <path d="M11 13h10M11 17h10M11 21h7" stroke={GREY} strokeWidth={1.5} />
    </>
  ),
  transfer: (
    <>
      <path d="M4 11h19m-4-4l4 4-4 4" fill="none" stroke={NAVY} strokeWidth={2.5} />
      <path d="M28 21H9m4-4l-4 4 4 4" fill="none" stroke={GREEN} strokeWidth={2.5} />
    </>
  ),
  employees: (
    <>
      <circle cx={11} cy={10} r={4} fill={TAN} stroke={INK} />
      <path d="M3 26c0-6 3-9 8-9s8 3 8 9z" fill="#6080c0" stroke={INK} />
      <circle cx={21} cy={10} r={4} fill={TAN} stroke={INK} />
      <path d="M13 26c0-6 3-9 8-9s8 3 8 9z" fill={NAVY} stroke={INK} />
    </>
  ),
  pl: (
    <>
      <path d="M4 4v24h24" fill="none" stroke={INK} />
      <path d="M8 27v-8h4v8zM14 27v-13h4v13zM20 27v-17h4v17z" fill={GREEN} stroke={INK} />
      <path d="M6 20l7-6 6 3 9-10" fill="none" stroke={RED} strokeWidth={1.5} />
    </>
  ),
  trip: (
    <>
      <path d="M3 26c6-12 14 2 26-14" fill="none" stroke={GREY} strokeWidth={3} strokeDasharray="3 2" />
      <rect x={9} y={8} width={11} height={8} fill="#6080c0" stroke={INK} />
      <path d="M20 10h4l3 3v3h-7z" fill={GREY} stroke={INK} />
      <circle cx={13} cy={17} r={2} fill={INK} />
      <circle cx={23} cy={17} r={2} fill={INK} />
    </>
  ),
  salescust: (
    <>
      <circle cx={16} cy={16} r={12} fill="#6080c0" stroke={INK} />
      <path d="M16 16V4a12 12 0 0 1 11.4 15.7z" fill={GREEN} stroke={INK} />
      <path d="M16 16l11.4 3.7A12 12 0 0 1 18 27.8z" fill="#f0d060" stroke={INK} />
    </>
  ),
  aging: (
    <>
      <circle cx={16} cy={16} r={12} fill={PAPER} stroke={INK} strokeWidth={1.5} />
      <path d="M16 8v8l6 4" fill="none" stroke={NAVY} strokeWidth={2} />
      <path d="M16 4v2M28 16h-2M16 28v-2M4 16h2" stroke={INK} />
    </>
  ),
  home: (
    <>
      <path d="M4 16L16 5l12 11" fill="none" stroke={INK} strokeWidth={2} />
      <path d="M8 14v14h16V14L16 7z" fill={PAPER} stroke={INK} />
      <path d="M14 28v-8h5v8" fill="#6c98e0" stroke={INK} />
    </>
  ),
};

export function Pictogram({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ?? 'pictogram'} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}
