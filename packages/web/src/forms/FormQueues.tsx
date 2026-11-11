import { formatMoney, formatUsDate, TXN_TYPE_SHORT, type DocSummary, type DocTxn, type EmailBatchResult } from '@rapidbooks/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { Mnemonic } from '../util';
import type { EmailStatus } from './EmailDialog';
import { openTxn } from './openTxn';
import { docLabel, docToInput, openPdfs, PDF_BLOCKED } from './salesDoc';
import './sales.css';

/**
 * The checklist both queues share: the forms, a ✓ column (Space or a click toggles the
 * selected row), Select All / Select None. All forms start checked, as in QuickBooks.
 */
function useChecklist(rows: DocSummary[] | undefined) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const seen = useRef(new Set<number>());

  // Forms that appear in the list are checked the first time they are seen.
  useEffect(() => {
    if (!rows) return;
    const fresh = rows.filter((r) => !seen.current.has(r.id));
    if (fresh.length) {
      for (const r of fresh) seen.current.add(r.id);
      setChecked((c) => new Set([...c, ...fresh.map((r) => r.id)]));
    }
    if (rows.length && (selected === null || !rows.some((r) => r.id === selected))) setSelected(rows[0].id);
  }, [rows, selected]);

  const toggle = (id: number) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const all = () => setChecked(new Set((rows ?? []).map((r) => r.id)));
  const none = () => setChecked(new Set());
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey || selected === null) return;
    if (!(e.target as HTMLElement).classList.contains('listview')) return;
    e.preventDefault();
    toggle(selected);
  };
  const chosen = (rows ?? []).filter((r) => checked.has(r.id));
  const checkCol: Column<DocSummary> = {
    key: 'check',
    title: '✓',
    width: '2rem',
    align: 'center',
    render: (r) => (checked.has(r.id) ? '✓' : ''),
    onClick: (r) => toggle(r.id),
  };
  return { checked, selected, setSelected, all, none, onKeyDown, chosen, checkCol };
}

const baseColumns: Column<DocSummary>[] = [
  { key: 'date', title: 'Date', width: '7rem', render: (r) => formatUsDate(r.date) },
  { key: 'type', title: 'Type', width: '5.5rem', render: (r) => TXN_TYPE_SHORT[r.type] ?? r.type },
  { key: 'num', title: 'No.', width: '5rem', render: (r) => r.num },
  { key: 'name', title: 'Customer', render: (r) => r.full_name },
];
const amountCol: Column<DocSummary> = { key: 'amount', title: 'Amount', width: '7rem', align: 'right', render: (r) => formatMoney(r.total) };

/** File > Send Forms: invoices and credit memos marked To be e-mailed, sent in one go. */
export function SendForms({ winId }: WinProps) {
  const desk = useDesktop();
  const { data, error } = useData<DocSummary[]>('/api/invoices/to-email');
  const { data: status } = useData<EmailStatus>('/api/email/status');
  const list = useChecklist(data);
  const [results, setResults] = useState<EmailBatchResult[] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (sending || list.chosen.length === 0 || !status?.configured) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await api.post<EmailBatchResult[]>('/api/email/batch', { txn_ids: list.chosen.map((c) => c.id) });
      setResults(r);
      const ok = r.filter((x) => x.ok).length;
      desk.setStatus(`${ok} of ${r.length} form${r.length === 1 ? '' : 's'} sent.`);
      desk.refresh();
    } catch (e) {
      setSendError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const openRow = (id: number | null) => {
    const r = data?.find((x) => x.id === id);
    if (r) openTxn(desk, r.type, r.id);
  };
  // Ctrl+E opens the selected form; Alt+S and Ctrl+Enter send.
  useWindowCommands(winId, {
    edit: () => openRow(list.selected),
    save: () => void send(),
    saveClose: () => void send(),
  });

  const columns = [
    list.checkCol,
    ...baseColumns,
    { key: 'email', title: 'E-mail', width: '12rem', render: (r: DocSummary) => r.email } as Column<DocSummary>,
    amountCol,
  ];
  const notConfigured = status && !status.configured;

  return (
    <div className="list-window" onKeyDown={list.onKeyDown}>
      {notConfigured && <div className="msg-strip error">{status.message ?? 'E-mail is not set up.'}</div>}
      {(error || sendError) && <div className="msg-strip error">{error ?? sendError}</div>}
      <ListView
        columns={columns}
        rows={data ?? []}
        rowKey={(r) => r.id}
        selected={list.selected}
        onSelect={list.setSelected}
        onActivate={(r) => openTxn(desk, r.type, r.id)}
        emptyText={data ? 'There are no forms waiting to be e-mailed.' : 'Loading...'}
        label="Forms to send"
      />
      {results && (
        <div className="results-box" role="status">
          {results.map((r) => (
            <div key={r.txn_id} className={r.ok ? 'result-ok' : 'result-err'}>
              {docLabel(data?.find((d) => d.id === r.txn_id)?.type ?? 'INVOICE', r.num)}: {r.ok ? 'sent' : r.error}
            </div>
          ))}
        </div>
      )}
      <div className="button-row">
        <button type="button" className="btn" onClick={list.all}>
          Select All
        </button>
        <button type="button" className="btn" onClick={list.none}>
          Select None
        </button>
        <span className="spacer" />
        <span>Space checks or unchecks the selected form.</span>
        <button
          type="button"
          className="btn default"
          disabled={!status?.configured || sending || list.chosen.length === 0}
          onClick={() => void send()}
          title="Alt+S"
        >
          <Mnemonic label={sending ? 'Sending...' : '&Send Now'} />
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Re-save a document with To be printed turned off. */
async function clearToPrint(id: number) {
  const t = await api.get<DocTxn>(`/api/txns/${id}`);
  await api.put(`/api/txns/${id}`, { ...docToInput(t), to_print: false });
}

/** File > Print Forms > Invoices: the forms marked To be printed, opened as PDFs, then cleared. */
export function PrintForms({ winId }: WinProps) {
  const desk = useDesktop();
  const { data, error } = useData<DocSummary[]>('/api/invoices/to-print');
  const list = useChecklist(data);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const busy = useRef(false);

  const print = async () => {
    const forms = list.chosen;
    if (busy.current || forms.length === 0) return;
    busy.current = true;
    setPrintError(null);
    try {
      // One combined PDF with every form, in one tab.
      if (!openPdfs(forms.map((f) => f.id))) {
        desk.setStatus(PDF_BLOCKED);
        return;
      }
      let ok: DocSummary[] = [];
      if (await desk.confirm('Did the forms print correctly?', { title: 'Print Forms' })) ok = forms;
      else {
        for (const f of forms) {
          const label = `${docLabel(f.type, f.num)} for ${f.full_name}`;
          if (await desk.confirm(`Did ${label} print correctly?`, { title: 'Print Forms', defaultNo: true })) ok.push(f);
        }
      }
      if (ok.length === 0) {
        desk.setStatus('The forms stay in the list to be printed again.');
        return;
      }
      setBusyMsg('Updating...');
      const failures: string[] = [];
      for (const f of ok) {
        try {
          await clearToPrint(f.id);
        } catch (e) {
          failures.push(`${docLabel(f.type, f.num)}: ${errorMessage(e)}`);
        }
      }
      desk.refresh();
      desk.setStatus(`${ok.length - failures.length} form${ok.length - failures.length === 1 ? '' : 's'} marked as printed.`);
      if (failures.length) setPrintError(failures.join('\n'));
    } finally {
      busy.current = false;
      setBusyMsg(null);
    }
  };

  const openRow = (id: number | null) => {
    const r = data?.find((x) => x.id === id);
    if (r) openTxn(desk, r.type, r.id);
  };
  // Ctrl+E opens the selected form; Ctrl+P prints.
  useWindowCommands(winId, { edit: () => openRow(list.selected), print: () => void print() });

  return (
    <div className="list-window" onKeyDown={list.onKeyDown}>
      {(error || printError) && <div className="msg-strip error pre">{error ?? printError}</div>}
      <ListView
        columns={[list.checkCol, ...baseColumns, amountCol]}
        rows={data ?? []}
        rowKey={(r) => r.id}
        selected={list.selected}
        onSelect={list.setSelected}
        onActivate={(r) => openTxn(desk, r.type, r.id)}
        emptyText={data ? 'There are no forms waiting to be printed.' : 'Loading...'}
        label="Forms to print"
      />
      <div className="button-row">
        <button type="button" className="btn" onClick={list.all}>
          Select All
        </button>
        <button type="button" className="btn" onClick={list.none}>
          Select None
        </button>
        <span className="spacer" />
        {busyMsg && <span>{busyMsg}</span>}
        <button type="button" className="btn default" disabled={list.chosen.length === 0} onClick={() => void print()} title="Ctrl+P">
          Print
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}
