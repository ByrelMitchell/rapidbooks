import { useSyncExternalStore } from 'react';

// Login state, kept outside React so the api wrapper can flip it when the server says 401.

export interface SessionState {
  /** null until the first /api/session answer. */
  authRequired: boolean | null;
  /** The login screen is up. */
  needLogin: boolean;
}

let state: SessionState = { authRequired: null, needLogin: false };
const listeners = new Set<() => void>();

function set(next: Partial<SessionState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const sessionState = () => state;

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Called by the api wrapper on any 401: show the login screen. Nothing is retried. */
export function loginRequired() {
  if (!state.needLogin) set({ needLogin: true, authRequired: true });
}

export function loggedIn() {
  set({ needLogin: false, authRequired: true });
}

/** The first thing the app does: ask the server whether a login is needed. */
export async function checkSession(): Promise<void> {
  try {
    const res = await fetch('/api/session', { headers: { 'X-Requested-With': 'RapidBooks' } });
    if (!res.ok) return;
    const s = (await res.json()) as { authenticated: boolean; authRequired: boolean };
    set({ authRequired: s.authRequired, needLogin: s.authRequired && !s.authenticated });
  } catch {
    // Server not reachable: the windows will say so when they try.
  }
}
