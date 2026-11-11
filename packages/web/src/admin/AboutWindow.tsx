import { useEffect, useRef } from 'react';
import { useData } from '../api';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { formatSize, formatWhen, timeAgo, type BackupFileInfo } from './backupStatus';
import './admin.css';

interface About {
  version: string;
  node: string;
  server: { hostname: string; urls: string[]; tls: boolean; thisAddress: string };
  database: { path: string; size: number; walSize: number };
  counts: { transactions: number; accounts: number; names: number };
  backup: { directory: string; lastSuccess: BackupFileInfo | null; lastError: { at: string; message: string } | null } | null;
}

/** Help > About RapidBooks (F2, like QuickBooks' Product Information). */
export function AboutWindow({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: a, error } = useData<About>('/api/about');
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);

  const n = (x: number) => x.toLocaleString('en-US');
  const rows: [string, string][] = a
    ? [
        ['Version', a.version],
        ['Server address', a.server.urls.length ? a.server.urls.join('   ') : a.server.thisAddress],
        ['Connected as', `${a.server.thisAddress}${a.server.tls ? ' (secure)' : ''}`],
        ['Database file', a.database.path],
        ['Database size', formatSize(a.database.size + a.database.walSize)],
        ['Transactions', n(a.counts.transactions)],
        ['Accounts / names', `${n(a.counts.accounts)} / ${n(a.counts.names)}`],
        [
          'Last backup',
          a.backup?.lastSuccess
            ? `${formatWhen(a.backup.lastSuccess.at)} (${timeAgo(a.backup.lastSuccess.at)})`
            : a.backup
              ? 'Never'
              : 'Backups are not set up',
        ],
        ['Backup folder', a.backup?.directory ?? ''],
        ['Server software', `Node.js ${a.node}`],
      ]
    : [];

  return (
    <div className="dialog about-window">
      <div className="about-brand">RapidBooks</div>
      {error && <div className="msg-strip error">{error}</div>}
      {!a && !error && <div className="rec-loading">Loading...</div>}
      <div className="about-grid">
        {rows.map(([k, v]) => (
          <div key={k} className="about-row">
            <span className="about-k">{k}:</span>
            <span className="about-v">{v}</span>
          </div>
        ))}
      </div>
      {a?.backup?.lastError && <div className="msg-strip error">The last backup did not work. {a.backup.lastError.message}</div>}
      <div className="button-row right">
        <button ref={ok} type="button" className="btn default" onClick={() => desk.close(winId)}>
          OK
        </button>
      </div>
    </div>
  );
}
