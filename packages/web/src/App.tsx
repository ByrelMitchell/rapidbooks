import { useEffect, useRef } from 'react';
import { BackupWarning } from './admin/BackupWarning';
import { LoginScreen } from './admin/LoginScreen';
import { useSession } from './admin/session';
import { MenuBar, type MenuBarHandle } from './shell/MenuBar';
import { DesktopProvider, useDesktop } from './shell/desktop';
import { registry } from './shell/registry';
import { useGlobalShortcuts } from './shell/shortcuts';
import { useData } from './api';
import { IconBar, LeftIconBar } from './shell/IconBar';
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

  // QuickBooks opens on the Home page: at start-up, and again after File > Log Off
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

  // QuickBooks 2013's title bar: "Company - QuickBooks Pro 2013 - [Create Invoices]".
  const { data: company } = useData<Record<string, string>>(needLogin ? null : '/api/company');
  const activeTitle = desk.windows.find((w) => w.id === desk.activeId)?.title;
  const appTitle = [company?.name, 'RapidBooks'].filter(Boolean).join(' - ') + (activeTitle ? ` - [${activeTitle}]` : '');
  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  return (
    <div className={`app${prefs.largeLists ? ' large-lists' : ''}`}>
      <div className="apptitle">{appTitle}</div>
      <MenuBar ref={menuRef} />
      {prefs.iconBar && !prefs.leftIconBar && <IconBar />}
      <div className="app-main">
      {prefs.iconBar && prefs.leftIconBar && <LeftIconBar />}
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
              Press Alt to use the menus: Alt+L for Lists, Alt+C for Company, Alt+B for Banking. Company &gt; Home Page (Alt+C, H)
              shows the day&apos;s work; Help &gt; Keyboard Shortcuts lists every key.
            </small>
          </div>
        )}
      </div>
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
