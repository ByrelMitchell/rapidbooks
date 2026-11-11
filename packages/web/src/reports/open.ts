import type { Desktop } from '../shell/desktop';
import type { ReportParams } from './reportQuery';

/** Reports opened from somewhere else (Ctrl+Q), not listed in the menus or the Report Finder. */
export const HIDDEN_REPORTS = new Set(['quickreport']);

/** Open a report window: `params` are laid over the report's defaults (QuickZoom, memorized, menus). */
export function openReport(desk: Desktop, id: string, params: ReportParams = {}, title?: string) {
  desk.open('report', title ? { id, params, title } : { id, params });
}

/** Ctrl+Q: the QuickReport for one account, name or item. */
export function openQuickReport(desk: Desktop, what: { account_id?: number; name_id?: number; item_id?: number }) {
  const params: ReportParams = {};
  for (const [k, v] of Object.entries(what)) if (v !== undefined && v !== null) params[k] = String(v);
  openReport(desk, 'quickreport', params);
}
