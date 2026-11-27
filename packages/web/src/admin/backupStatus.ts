import { useSyncExternalStore } from 'react';
import { api, errorMessage } from '../api';

// The backup status, shared by File > Back Up and the status-bar warning.

export interface BackupFileInfo {
  file: string;
  size: number;
  at: string;
}

export interface BackupStatus {
  directory: string;
  lastSuccess: BackupFileInfo | null;
  lastAttempt: string | null;
  lastError: { at: string; message: string } | null;
  rotationError: string | null;
  folderError: string | null;
  backups: BackupFileInfo[];
  schedule: string | null;
  nextRun: string | null;
  running: boolean;
  warning: string | null;
}

let state: { status: BackupStatus | null; error: string | null } = { status: null, error: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setBackupStatus(status: BackupStatus) {
  state = { status, error: null };
  emit();
}

export async function refreshBackupStatus(): Promise<void> {
  try {
    setBackupStatus(await api.get<BackupStatus>('/api/backup/status'));
  } catch (e) {
    state = { ...state, error: errorMessage(e) };
    emit();
  }
}

export function useBackupStatus() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// ---- Formatting ----

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `${date} at ${formatTime(iso)}`;
}

export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

export function timeAgo(iso: string, now = Date.now()): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "tonight at 2:00 AM", "tomorrow at 2:00 AM", or the date. */
export function formatNextRun(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const t = formatTime(iso);
  if (diff === 0) return d.getHours() >= 18 || d.getHours() < 5 ? `tonight at ${t}` : `today at ${t}`;
  if (diff === 1) return d.getHours() < 5 ? `tonight at ${t} (after midnight)` : `tomorrow at ${t}`;
  return formatWhen(iso);
}
