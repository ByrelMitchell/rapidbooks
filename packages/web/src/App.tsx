import { useEffect, useRef } from 'react';
import { BackupWarning } from './admin/BackupWarning';
import { LoginScreen } from './admin/LoginScreen';
import { useSession } from './admin/session';
import { MenuBar, type MenuBarHandle } from './shell/MenuBar';
import { DesktopProvider, useDesktop } from './shell/desktop';
import { registry } from './shell/registry';
import { useGlobalShortcuts } from './shell/shortcuts';
import { IconBar } from './shell/IconBar';
import { useViewPrefs } from './shell/viewPrefs';
import { WindowFrame } from './shell/WindowFrame';
import './shell/shell.css';

export function App() {
  return (
    <DesktopProvider registry={registry}>
      <Shell />
    </DesktopProvider>
  );
}

function Shell() {
  const desk = useDesktop();
  const menuRef = useRef<MenuBarHandle>(null);
  const prefs = useViewPrefs();
  useGlobalShortcuts(desk, menuRef);

  // QuickBooks opens on the Company Navigator: at start-up, and again after File > Log Off
  // and a new login (when every window was closed). desk.open never opens a second copy.
  const { needLogin } = useSession();
  useEffect(() => {
    if (!needLogin && desk.windows.length === 0) desk.open('navigator');
  }, [needLogin]);

  // A stray Ctrl+W (which a normal browser tab cannot intercept) should not silently close the books.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return (
    <div className={`app${prefs.largeLists ? ' large-lists' : ''}`}>
      <MenuBar ref={menuRef} />
      {prefs.iconBar && <IconBar />}
      <div className="desktop">
        {desk.windows.map((w) => {
          const def = registry[w.kind];
          if (!def) return null;
          const Body = def.component;
          return (
            <WindowFrame key={w.id} win={w} def={def} active={w.id === desk.activeId}>
              <Body winId={w.id} props={w.props} />
            </WindowFrame>
          );
        })}
        {desk.windows.length === 0 && (
          <div className="desktop-hint">
            RapidBooks
            <small>
              Press Alt to use the menus: Alt+L for Lists, Alt+C for Company, Alt+B for Banking. Company &gt; Navigator (Alt+C, N)
              shows the day&apos;s work; Help &gt; Keyboard Shortcuts lists every key.
            </small>
          </div>
        )}
      </div>
      <div className="statusbar" role="status">
        <span className="status-msg">{desk.status}</span>
        <BackupWarning />
        <span className="status-zoom">{desk.zoom}%</span>
      </div>
      <LoginScreen />
    </div>
  );
}
