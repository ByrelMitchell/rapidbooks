import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { focusables } from '../util';
import { useDesktop, type WinState } from './desktop';
import type { WindowDef } from './registry';

function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function WindowFrame({
  win,
  def,
  active,
  children,
}: {
  win: WinState;
  def: WindowDef;
  active: boolean;
  children: ReactNode;
}) {
  const desk = useDesktop();
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number; rem: number } | null>(null);
  // Once she drags the window it stays where she put it; until then it is kept on screen.
  const userMoved = useRef(false);
  const posRef = useRef({ x: win.x, y: win.y });
  posRef.current = { x: win.x, y: win.y };

  // Keep a new window inside the desktop: when it would run off the right or the bottom
  // (a small screen, a large zoom, a cascade far down, a form that grew once loaded), move
  // it left / up. It can never be larger than the desktop (max-width / max-height in CSS),
  // so after the move all of it is visible; its body scrolls if the content is taller.
  useLayoutEffect(() => {
    const el = frameRef.current;
    const deskEl = el?.parentElement;
    if (!el || !deskEl || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      if (userMoved.current || drag.current) return;
      const rem = remPx();
      const overRight = el.offsetLeft + el.offsetWidth - deskEl.clientWidth;
      const overBottom = el.offsetTop + el.offsetHeight - deskEl.clientHeight;
      const { x, y } = posRef.current;
      const nx = overRight > 0.5 ? Math.max(0, x - overRight / rem) : x;
      const ny = overBottom > 0.5 ? Math.max(0, y - overBottom / rem) : y;
      if (nx !== x || ny !== y) desk.move(win.id, nx, ny);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(deskEl);
    return () => ro.disconnect();
    // desk.move is stable; the window id never changes.
  }, [win.id]);

  // When this window becomes active and focus is elsewhere, put focus on its first field.
  // Windows that are still loading may not have fields yet, so retry for a few frames.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let tries = 0;
    const attempt = () => {
      const frame = frameRef.current;
      if (!frame || frame.contains(document.activeElement)) return;
      const last = lastFocus.current;
      const list = focusables(bodyRef.current);
      const first = last && list.includes(last) ? last : list[0];
      if (first) first.focus();
      else if (tries++ < 120) raf = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // Tab and Shift+Tab stay inside the window.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    const list = focusables(bodyRef.current);
    if (list.length === 0) {
      e.preventDefault();
      return;
    }
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey) {
      if (i <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      }
    } else if (i === -1 || i === list.length - 1) {
      e.preventDefault();
      list[0].focus();
    }
  };

  const onTitleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.win-close')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: win.x, y: win.y, rem: remPx() };
  };
  const onTitleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    userMoved.current = true;
    desk.move(win.id, d.x + (e.clientX - d.px) / d.rem, d.y + (e.clientY - d.py) / d.rem);
  };
  const onTitleUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={frameRef}
      className={`win${active ? ' active' : ''}`}
      style={{
        left: `${win.x}rem`,
        top: `${win.y}rem`,
        width: `${def.width}rem`,
        height: def.height ? `${def.height}rem` : undefined,
        zIndex: win.z,
      }}
      onPointerDownCapture={() => desk.focus(win.id)}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (bodyRef.current?.contains(e.target)) lastFocus.current = e.target;
      }}
      role="dialog"
      aria-label={win.title}
    >
      <div
        className="win-title"
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        onPointerCancel={onTitleUp}
        // Clicking the title bar must not take focus away from the field being edited.
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="win-title-text">{win.title}</span>
        <button
          type="button"
          className="win-close"
          tabIndex={-1}
          title="Close (Esc)"
          aria-label="Close"
          onClick={() => void desk.requestClose(win.id)}
        >
          ×
        </button>
      </div>
      <div ref={bodyRef} className="win-body">
        {children}
      </div>
    </div>
  );
}
