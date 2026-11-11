import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveState } from '../util';
import { MessageBox, type MsgBoxOptions, type MsgBoxRequest, type MsgIcon } from './MessageBox';
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
  /** Ctrl+H: the transaction's history. */
  history?: () => void;
  /** Ctrl+Y: the transaction's journal (its splits). */
  txnJournal?: () => void;
  /** Ctrl+P: print the form. */
  print?: () => void;
  /** Ctrl+Q: the QuickReport for the selected account, name or item (or the form's name). */
  quickReport?: () => void;
  /** Return (or resolve to) false to keep the window open. */
  confirmClose?: () => boolean | Promise<boolean>;
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

// How many message boxes are up or queued. Module-level so code outside React (the
// shortcut listener, the menu bar, Combo's blur) can ask synchronously.
let modalCount = 0;
/** True while an in-app message box is showing: shortcuts, menus and Quick Add must not act. */
export const isModalOpen = () => modalCount > 0;

export interface ConfirmOptions {
  /** Label of the button that answers true (default "&Yes"). */
  yes?: string;
  /** Label of the button that answers false (default "&No"); Esc chooses it. */
  no?: string;
  title?: string;
  icon?: MsgIcon;
  /** Start with focus on the "no" button. */
  defaultNo?: boolean;
}

export interface Desktop {
  windows: WinState[];
  activeId: string | null;
  open: (kind: string, props?: Record<string, unknown>) => string;
  /**
   * Open a new window (never an existing one) and wait for its result: what the window
   * passes to resolveWindow, or null if it closes without one.
   */
  openForResult: <T = number>(kind: string, props?: Record<string, unknown>) => Promise<T | null>;
  /** A window opened with openForResult reports its result (e.g. the id it saved). Later calls are ignored. */
  resolveWindow: (id: string, result: unknown) => void;
  close: (id: string) => void;
  /** Close unless the window's confirmClose refuses. Resolves to whether it closed. */
  requestClose: (id: string) => Promise<boolean>;
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
  /** Show a message box; resolves to the index of the button chosen. */
  messageBox: (message: string, opts: MsgBoxOptions) => Promise<number>;
  /** Yes/No box (labels configurable); resolves true for "yes". */
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>;
  /** OK box. */
  alert: (message: string, opts?: { title?: string; icon?: MsgIcon }) => Promise<void>;
  /** True while a message box is showing (also isModalOpen() outside React). */
  modalOpen: boolean;
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
  const waiters = useRef(new Map<string, (result: unknown) => void>());
  const closing = useRef(new Set<string>());
  const reqSeq = useRef(0);
  const [modals, setModals] = useState<(MsgBoxRequest & { resolve: (i: number) => void })[]>([]);
  const modalSeq = useRef(0);

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

  const resolveWindow = useCallback((id: string, result: unknown) => {
    const w = waiters.current.get(id);
    if (!w) return;
    waiters.current.delete(id);
    w(result);
  }, []);

  const openForResult = useCallback(
    <T,>(kind: string, props: Record<string, unknown> = {}) =>
      new Promise<T | null>((resolve) => {
        // The request number keeps it from being mistaken for a window that is already open.
        const id = open(kind, { ...props, request: ++reqSeq.current });
        waiters.current.set(id, resolve as (r: unknown) => void);
      }),
    [open],
  );

  const close = useCallback(
    (id: string) => {
      cmdMap.current.delete(id);
      setWindows((prev) => prev.filter((w) => w.id !== id));
      if (winsRef.current.length === 0) cascade.current = 0;
      resolveWindow(id, null);
    },
    [setWindows, winsRef, resolveWindow],
  );

  const requestClose = useCallback(
    async (id: string) => {
      if (closing.current.has(id)) return false; // already asking
      const c = cmdMap.current.get(id);
      if (c?.confirmClose) {
        closing.current.add(id);
        try {
          if ((await c.confirmClose()) === false) return false;
        } finally {
          closing.current.delete(id);
        }
      }
      if (!winsRef.current.some((w) => w.id === id)) return true;
      close(id);
      return true;
    },
    [close, winsRef],
  );

  const messageBox = useCallback(
    (message: string, opts: MsgBoxOptions) =>
      new Promise<number>((resolve) => {
        modalCount++;
        setModals((prev) => [...prev, { ...opts, message, key: ++modalSeq.current, resolve }]);
      }),
    [],
  );
  const finishModal = (key: number, index: number) => {
    const m = modals.find((x) => x.key === key);
    if (!m) return;
    modalCount--;
    setModals((prev) => prev.filter((x) => x.key !== key));
    m.resolve(index);
  };
  const confirm = useCallback(
    async (message: string, opts: ConfirmOptions = {}) =>
      (await messageBox(message, {
        title: opts.title,
        icon: opts.icon ?? 'question',
        buttons: [opts.yes ?? '&Yes', opts.no ?? '&No'],
        defaultButton: opts.defaultNo ? 1 : 0,
        cancelButton: 1,
      })) === 0,
    [messageBox],
  );
  const alert = useCallback(
    async (message: string, opts: { title?: string; icon?: MsgIcon } = {}) => {
      await messageBox(message, { title: opts.title, icon: opts.icon ?? 'warning', buttons: ['OK'] });
    },
    [messageBox],
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
    openForResult,
    resolveWindow,
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
    messageBox,
    confirm,
    alert,
    modalOpen: modals.length > 0,
  };
  const top = modals[0];
  return (
    <Ctx.Provider value={value}>
      {children}
      {top && <MessageBox key={top.key} req={top} onDone={(i) => finishModal(top.key, i)} />}
    </Ctx.Provider>
  );
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
