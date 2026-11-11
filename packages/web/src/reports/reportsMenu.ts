import { REPORT_GROUPS, type ReportDef } from '@rapidbooks/shared';
import { useData } from '../api';
import type { Desktop } from '../shell/desktop';
import type { Menu, MenuEntry } from '../shell/MenuBar';
import { assignMnemonics } from '../shell/mnemonics';
import { HIDDEN_REPORTS, openReport } from './open';
import { MEMORIZED_KEY, parseMemorized, sortMemorized } from './reportQuery';

/** The report definitions (GET /api/reports), loaded once and kept current. */
export const useReportDefs = () => useData<ReportDef[]>('/api/reports');

/** The memorized reports, from the company key-value store. */
export function useMemorized() {
  const { data, error } = useData<Record<string, string>>('/api/company');
  return { list: data ? sortMemorized(parseMemorized(data[MEMORIZED_KEY])) : undefined, error };
}

/**
 * The Reports menu, as QuickBooks lays it out: Report Finder and Memorized Reports, one
 * submenu per report group, then Trip Report and the graphs. Mnemonics inside each submenu
 * are chosen automatically.
 */
export function useReportsMenu(desk: Desktop): Menu {
  const { data: defs } = useReportDefs();
  const { list: memorized } = useMemorized();

  const groups: MenuEntry[] = REPORT_GROUPS.map((g) => {
    const reports = (defs ?? []).filter((d) => d.group === g && !HIDDEN_REPORTS.has(d.id));
    const labels = assignMnemonics(reports.map((d) => d.title));
    return {
      label: g, // mnemonics for the group names are assigned below
      items: reports.map((d, i) => ({ label: labels[i], action: () => openReport(desk, d.id) })),
    };
  });

  const memLabels = assignMnemonics([{ label: 'Memorized Report &List...' }, ...(memorized ?? []).map((m) => m.name)]);
  const memorizedMenu: MenuEntry[] = [
    ...(memorized ?? []).map((m, i) => ({
      label: memLabels[i + 1],
      action: () => openReport(desk, m.report_id, m.params, m.name),
    })),
    ...((memorized ?? []).length ? (['sep'] as MenuEntry[]) : []),
    { label: memLabels[0], action: () => desk.open('memorized') },
  ];

  // Fixed mnemonics first, then the group names fill in around them.
  const fixed = [
    { label: 'Report &Finder...' },
    { label: 'Memori&zed Reports' },
    { label: '&Trip Report' },
    { label: 'Sales &Graph' },
    { label: '&Income and Expense Graph' },
  ];
  const all = assignMnemonics([...fixed, ...REPORT_GROUPS]);
  const groupLabels = all.slice(fixed.length);

  return {
    label: '&Reports',
    items: [
      { label: all[0], action: () => desk.open('reportfinder') },
      { label: all[1], items: memorizedMenu },
      'sep',
      ...groups.map((g, i) => ({ ...(g as { label: string; items: MenuEntry[] }), label: groupLabels[i] })),
      'sep',
      { label: all[2], action: () => openReport(desk, 'trip_report', { date: 'this_month', mode: 'detail' }) },
      'sep',
      { label: all[3], action: () => desk.open('salesgraph') },
      { label: all[4], action: () => desk.open('iegraph') },
    ],
  };
}
