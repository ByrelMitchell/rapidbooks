import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { ListView, type Column } from '../controls/ListView';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import {
  formatDate,
  formatNextRun,
  formatSize,
  formatTime,
  formatWhen,
  refreshBackupStatus,
  timeAgo,
  useBackupStatus,
  type BackupFileInfo,
} from './backupStatus';
import { loginRequired } from './session';
import './admin.css';

const columns: Column<BackupFileInfo>[] = [
  { key: 'date', title: 'Date', width: '7.5rem', render: (b) => formatDate(b.at) },
  { key: 'time', title: 'Time', width: '6rem', render: (b) => formatTime(b.at) },
  { key: 'size', title: 'Size', width: '6.5rem', align: 'right', render: (b) => formatSize(b.size) },
  { key: 'file', title: 'File name', render: (b) => b.file },
];

const p2 = (n: number) => String(n).padStart(2, '0');
const localStamp = (d = new Date()) =>
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

interface SaveFilePicker {
  (opts: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }): Promise<{
    name: string;
    createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

/** File > Back Up: when the books were last backed up, back up now, save a copy (e.g. to a USB stick). */
export function BackupWindow(_: WinProps) {
  const desk = useDesktop();
  const { status, error: loadError } = useBackupStatus();
  const [busy, setBusy] = useState<'backup' | 'copy' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [, tick] = useState(0);
  const backupBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    backupBtn.current?.focus();
    void refreshBackupStatus();
    // Keep "how long ago" and the list current while the window is open.
    const t = setInterval(() => {
      tick((n) => n + 1);
      void refreshBackupStatus();
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const backUpNow = async () => {
    if (busy) return;
    setBusy('backup');
    setMessage(null);
    desk.setStatus('Backing up...');
    try {
      const r = await api.post<{ file: string; size: number; durationMs: number; directory: string }>('/api/backup', {});
      const secs = (r.durationMs / 1000).toFixed(1);
      setMessage({ kind: 'ok', text: `Backed up. ${r.file} (${formatSize(r.size)}) was saved in ${r.directory} in ${secs} seconds.` });
      desk.setStatus(`Backup complete: ${r.file}`);
      setSelected(r.file);
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
      desk.setStatus('The backup failed.');
    } finally {
      setBusy(null);
      void refreshBackupStatus();
    }
  };

  const saveCopy = async () => {
    if (busy) return;
    setMessage(null);
    const suggestedName = `rapidbooks-${localStamp()}.db`;
    // Chromium (on https or localhost) can ask where to save it, e.g. on a USB stick.
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    let handle: Awaited<ReturnType<SaveFilePicker>> | null = null;
    if (picker) {
      try {
        handle = await picker({ suggestedName, types: [{ description: 'RapidBooks backup', accept: { 'application/octet-stream': ['.db'] } }] });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // she cancelled
        handle = null;
      }
    }
    setBusy('copy');
    desk.setStatus('Making a copy...');
    try {
      const res = await fetch('/api/backup/download', { headers: { 'X-Requested-With': 'RapidBooks' } });
      if (res.status === 401) {
        loginRequired();
        throw new Error('You need to log in to RapidBooks again. Log in, then try again.');
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `The server returned an error (${res.status}).`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? suggestedName;
      const blob = await res.blob();
      if (handle) {
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        setMessage({ kind: 'ok', text: `A copy of the books (${formatSize(blob.size)}) was saved as ${handle.name}.` });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setMessage({ kind: 'ok', text: `A copy of the books (${formatSize(blob.size)}) was saved as ${name} in your Downloads folder.` });
      }
      desk.setStatus('Copy saved.');
    } catch (e) {
      setMessage({ kind: 'error', text: `The copy was not saved. ${errorMessage(e)}` });
      desk.setStatus('The copy was not saved.');
    } finally {
      setBusy(null);
    }
  };

  const last = status?.lastSuccess ?? null;
  const lastError = status?.lastError ?? null;
  const stale = status?.warning && !lastError ? status.warning : null;

  return (
    <div className="list-window backup-window">
      <div className="backup-info">
        <span className="backup-k">Last backup:</span>
        <span className={`backup-v${!last || stale ? ' backup-bad' : ''}`}>
          {status ? (last ? `${formatWhen(last.at)} (${timeAgo(last.at)})` : 'Never') : 'Loading...'}
        </span>
        <span className="backup-k">Backup folder:</span>
        <span className="backup-v backup-path">{status?.directory ?? ''}</span>
        <span className="backup-k">Next backup:</span>
        <span className="backup-v">
          {status ? (status.nextRun ? `Automatically ${formatNextRun(status.nextRun)}` : 'No automatic backups are scheduled.') : ''}
        </span>
      </div>
      {lastError && (
        <div className="msg-strip error" role="alert">
          The last backup, at {formatTime(lastError.at)} on {formatDate(lastError.at)}, did not work. {lastError.message}
        </div>
      )}
      {stale && !lastError && (
        <div className="msg-strip error" role="alert">
          {stale} Press Back Up Now.
        </div>
      )}
      {status?.rotationError && <div className="msg-strip">{status.rotationError}</div>}
      {loadError && <div className="msg-strip error">{loadError}</div>}
      {message && (
        <div className={`msg-strip${message.kind === 'error' ? ' error' : ' backup-ok'}`} role="status">
          {message.text}
        </div>
      )}
      <div className="button-row">
        <button ref={backupBtn} type="button" className="btn default" disabled={!!busy} onClick={() => void backUpNow()}>
          {busy === 'backup' ? 'Backing Up...' : 'Back Up Now'}
        </button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => void saveCopy()}>
          {busy === 'copy' ? 'Saving...' : 'Save a Copy...'}
        </button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void desk.requestClose(_.winId)}>
          Close
        </button>
      </div>
      <div className="group-label backup-list-label">Recent backups</div>
      <ListView
        columns={columns}
        rows={status?.backups ?? []}
        rowKey={(b) => b.file}
        selected={selected}
        onSelect={setSelected}
        emptyText={status ? 'There are no backups in the backup folder yet.' : 'Loading...'}
        label="Recent backups"
      />
    </div>
  );
}
