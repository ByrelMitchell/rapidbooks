import { useEffect, useRef } from 'react';
import { BackupWarning } from './admin/BackupWarning';
import { LoginScreen } from './admin/LoginScreen';
import { MenuBar, type MenuBarHandle } from './shell/MenuBar';
import { DesktopProvider, useDesktop } from './shell/desktop';
import { registry } from './shell/registry';
import { useGlobalShortcuts } from './shell/shortcuts';
import { WindowFrame } from './shell/WindowFrame';

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
  useGlobalShortcuts(desk, menuRef);

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
    <div className="app">
      <MenuBar ref={menuRef} />
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
            <small>Press Alt to use the menus: Alt+L for Lists, Alt+C for Company, Alt+B for Banking. Ctrl+A opens the Chart of Accounts.</small>
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
