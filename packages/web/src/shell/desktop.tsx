import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveState } from '../util';
import type { Registry } from './registry';

export interface WinState {
  id: string;
  kind: string;
  props: Record<string, unknown>;
  title: string;
  x: number; // rem
  y: number; // rem
  z: number;
}

/** Handlers a window offers to the menus and the global shortcuts. */
export interface Commands {
  new?: () => void;
  edit?: () => void;
  delete?: () => void;
  save?: () => void;
  saveClose?: () => void;
  saveNew?: () => void;
  insertLine?: () => void;
  deleteLine?: () => void;
  register?: () => void;
  /** Return false to keep the window open. */
  confirmClose?: () => boolean;
}
export type CommandName = Exclude<keyof Commands, 'confirmClose'>;

export const ZOOM_LEVELS = [100, 115, 130, 150, 175, 200];
const ZOOM_KEY = 'rapidbooks.zoom';

function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_LEVELS.includes(v) ? v : 100;
  } catch {
    return 100;
  }
}

export interface Desktop {
  windows: WinState[];
  activeId: string | null;
  open: (kind: string, props?: Record<string, unknown>) => string;
  close: (id: string) => void;
  requestClose: (id: string) => boolean;
  focus: (id: string) => void;
  setTitle: (id: string, title: string) => void;
  move: (id: string, x: number, y: number) => void;
  status: string;
  setStatus: (msg: string) => void;
  dataVersion: number;
  refresh: () => void;
  zoom: number;
  setZoom: (pct: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  commands: (id: string | null) => Commands;
  registerCommands: (id: string, cmds: Commands | null) => void;
  run: (name: CommandName) => boolean;
}

const Ctx = createContext<Desktop | null>(null);

export function useDesktop(): Desktop {
  const d = useContext(Ctx);
  if (!d) throw new Error('useDesktop outside DesktopProvider');
  return d;
}

const sameProps = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);

export function DesktopProvider({ registry, children }: { registry: Registry; children: ReactNode }) {
  const [windows, setWindows, winsRef] = useLiveState<WinState[]>([]);
  const [status, setStatus] = useState('');
  const [dataVersion, setDataVersion] = useState(0);
  const [zoom, setZoomState] = useState(loadZoom);
  const seq = useRef(0);
  const zTop = useRef(0);
  const cascade = useRef(0);
  const cmdMap = useRef(new Map<string, Commands>());

  useEffect(() => {
    document.documentElement.style.fontSize = `${zoom}%`;
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      // Storage blocked: the zoom just isn't remembered.
    }
  }, [zoom]);

  const activeId = useMemo(() => {
    let top: WinState | null = null;
    for (const w of windows) if (!top || w.z > top.z) top = w;
    return top ? top.id : null;
  }, [windows]);

  const focus = useCallback(
    (id: string) => {
      const ws = winsRef.current;
      const w = ws.find((x) => x.id === id);
      if (!w) return;
      if (ws.every((x) => x.id === id || x.z < w.z)) return; // already on top
      const z = ++zTop.current;
      setWindows((prev) => prev.map((x) => (x.id === id ? { ...x, z } : x)));
    },
    [setWindows, winsRef],
  );

  const open = useCallback(
    (kind: string, props: Record<string, unknown> = {}) => {
      const existing = winsRef.current.find((w) => w.kind === kind && sameProps(w.props, props));
      if (existing) {
        focus(existing.id);
        return existing.id;
      }
      const id = `w${++seq.current}`;
      const step = cascade.current++ % 10;
      const w: WinState = {
        id,
        kind,
        props,
        title: registry[kind]?.title ?? kind,
        x: 1 + step * 1.75,
        y: 0.75 + step * 1.75,
        z: ++zTop.current,
      };
      setWindows((prev) => [...prev, w]);
      return id;
    },
    [focus, registry, setWindows, winsRef],
  );

  const close = useCallback(
    (id: string) => {
      cmdMap.current.delete(id);
      setWindows((prev) => prev.filter((w) => w.id !== id));
      if (winsRef.current.length === 0) cascade.current = 0;
    },
    [setWindows, winsRef],
  );

  const requestClose = useCallback(
    (id: string) => {
      const c = cmdMap.current.get(id);
      if (c?.confirmClose && c.confirmClose() === false) return false;
      close(id);
      return true;
    },
    [close],
  );

  const setTitle = useCallback(
    (id: string, title: string) => {
      if (winsRef.current.find((w) => w.id === id)?.title === title) return;
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, title } : w)));
    },
    [setWindows, winsRef],
  );

  const move = useCallback(
    (id: string, x: number, y: number) => {
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, x, y: Math.max(0, y) } : w)));
    },
    [setWindows],
  );

  const refresh = useCallback(() => setDataVersion((v) => v + 1), []);

  const setZoom = useCallback((pct: number) => setZoomState(ZOOM_LEVELS.includes(pct) ? pct : 100), []);
  const zoomIn = useCallback(
    () => setZoomState((z) => ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, ZOOM_LEVELS.indexOf(z) + 1)]),
    [],
  );
  const zoomOut = useCallback(() => setZoomState((z) => ZOOM_LEVELS[Math.max(0, ZOOM_LEVELS.indexOf(z) - 1)]), []);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const commands = useCallback((id: string | null) => (id ? cmdMap.current.get(id) ?? {} : {}), []);
  const registerCommands = useCallback((id: string, cmds: Commands | null) => {
    if (cmds) cmdMap.current.set(id, cmds);
    else cmdMap.current.delete(id);
  }, []);
  const run = useCallback((name: CommandName) => {
    const fn = activeRef.current ? cmdMap.current.get(activeRef.current)?.[name] : undefined;
    if (!fn) return false;
    fn();
    return true;
  }, []);

  const value: Desktop = {
    windows,
    activeId,
    open,
    close,
    requestClose,
    focus,
    setTitle,
    move,
    status,
    setStatus,
    dataVersion,
    refresh,
    zoom,
    setZoom,
    zoomIn,
    zoomOut,
    commands,
    registerCommands,
    run,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Register this window's command handlers (re-registered every render so they never go stale). */
export function useWindowCommands(winId: string, cmds: Commands) {
  const { registerCommands } = useDesktop();
  useEffect(() => {
    registerCommands(winId, cmds);
  });
  useEffect(() => () => registerCommands(winId, null), [winId, registerCommands]);
}

// Full screen with the Keyboard Lock API, so Ctrl+W / Ctrl+N / Ctrl+T reach the page (Chromium).
interface KeyboardLock {
  lock?: (keys?: string[]) => Promise<void>;
  unlock?: () => void;
}
const keyboardApi = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

export async function toggleFullScreen(setStatus: (m: string) => void) {
  try {
    if (document.fullscreenElement) {
      keyboardApi()?.unlock?.();
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
    const kb = keyboardApi();
    if (kb?.lock) await kb.lock();
    else setStatus('This browser cannot capture Ctrl+W, Ctrl+N and Ctrl+T. Use Chrome or Edge for full keyboard support.');
  } catch {
    setStatus('Full screen is not available in this browser.');
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) keyboardApi()?.unlock?.();
  });
}
