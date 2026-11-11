import { useEffect } from 'react';
import { useDesktop } from '../shell/desktop';
import { refreshBackupStatus, useBackupStatus } from './backupStatus';
import { useSession } from './session';
import './admin.css';

const POLL_MS = 5 * 60_000;

/**
 * The status-bar warning: shown, and kept, while the last good backup is more than
 * 3 days old or the last attempt failed. Clicking it opens File > Back Up.
 */
export function BackupWarning() {
  const desk = useDesktop();
  const { authRequired, needLogin } = useSession();
  const { status } = useBackupStatus();
  const ready = authRequired !== null && !needLogin;

  useEffect(() => {
    if (!ready) return;
    void refreshBackupStatus();
    const t = setInterval(() => void refreshBackupStatus(), POLL_MS);
    return () => clearInterval(t);
  }, [ready]);

  if (!ready || !status?.warning) return null;
  return (
    <span
      className="status-backup"
      role="alert"
      title="Open File > Back Up"
      onClick={() => desk.open('backup')}
    >
      ⚠ {status.warning} Use File &gt; Back Up.
    </span>
  );
}
