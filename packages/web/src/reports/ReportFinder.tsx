import { REPORT_GROUPS, type ReportDef } from '@rapidbooks/shared';
import { useEffect, useMemo, useState } from 'react';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { HIDDEN_REPORTS, openReport } from './open';
import { useReportDefs } from './reportsMenu';
import './reports.css';

type Row = { key: string; group: string; def: ReportDef | null };

/** Reports > Report Finder: every report under its group, its description beside the list; Enter opens it. */
export function ReportFinder({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: defs, error } = useReportDefs();
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of REPORT_GROUPS) {
      const list = (defs ?? []).filter((d) => d.group === g && !HIDDEN_REPORTS.has(d.id));
      if (!list.length) continue;
      out.push({ key: `g:${g}`, group: g, def: null });
      for (const d of list) out.push({ key: d.id, group: g, def: d });
    }
    return out;
  }, [defs]);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.key === selected))) setSelected(rows.find((r) => r.def)?.key ?? null);
  }, [rows, selected]);

  const current = rows.find((r) => r.key === selected) ?? null;
  const open = (r: Row | null) => r?.def && openReport(desk, r.def.id);
  useWindowCommands(winId, { edit: () => open(current) });

  const columns: Column<Row>[] = [
    {
      key: 'title',
      title: 'Report',
      render: (r) => (r.def ? <span style={{ paddingLeft: '1.25em' }}>{r.def.title}</span> : r.group),
    },
  ];

  return (
    <div className="list-window rpt-resizable">
      {error && <div className="msg-strip error">{error}</div>}
      <div className="finder">
        <ListView
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          selected={selected}
          onSelect={setSelected}
          onActivate={(r) => open(r)}
          rowClass={(r) => (r.def ? '' : 'finder-group')}
          emptyText={defs ? 'There are no reports.' : 'Loading...'}
          label="Reports"
        />
        <div className="finder-desc">
          {current?.def ? (
            <>
              <h3>{current.def.title}</h3>
              <p>{current.def.description}</p>
              <p className="graph-hint">{current.def.group}. Press Enter or double-click to open the report.</p>
            </>
          ) : (
            current && <h3>{current.group}</h3>
          )}
        </div>
      </div>
      <div className="button-row">
        <span className="spacer" />
        <button type="button" className="btn default" disabled={!current?.def} onClick={() => open(current)}>
          Display
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
