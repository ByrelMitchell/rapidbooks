import { useEffect, useState } from 'react';
import { useDesktop } from './shell/desktop';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('RapidBooks cannot reach its server. Check that the server is running and try again.', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `The server returned an error (${res.status}).`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T,>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T,>(path: string) => request<T>('DELETE', path),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Load JSON from the API, and load it again whenever the desktop's dataVersion
 * changes (after any save anywhere), so every open window stays current.
 */
// Last result per path. A window that opens gets the lists at once from here (so
// QuickFill works on the very first keystroke) while a fresh copy is fetched.
const cache = new Map<string, unknown>();

export function useData<T>(path: string | null): { data: T | undefined; error: string | null } {
  const { dataVersion } = useDesktop();
  const [state, setState] = useState<{ path: string | null; data: T | undefined; error: string | null }>(() => ({
    path: path !== null && cache.has(path) ? path : null,
    data: path !== null ? (cache.get(path) as T | undefined) : undefined,
    error: null,
  }));
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api.get<T>(path).then(
      (data) => {
        cache.set(path, data);
        if (!cancelled) setState({ path, data, error: null });
      },
      (e) => {
        if (!cancelled) setState((s) => ({ ...s, error: errorMessage(e) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, dataVersion]);
  const data = state.path === path ? state.data : path !== null ? (cache.get(path) as T | undefined) : undefined;
  return { data, error: state.error };
}
