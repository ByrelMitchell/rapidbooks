import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { checkSession, loggedIn, useSession } from './session';
import './admin.css';

/**
 * The login screen: one large password field, Enter logs in. It covers the whole
 * desktop (and hides the windows behind it, which keep whatever was typed in them)
 * whenever the server answers 401. Message boxes still show on top of it.
 */
export function LoginScreen() {
  const { needLogin } = useSession();

  useEffect(() => {
    void checkSession();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('rb-locked', needLogin);
  }, [needLogin]);

  return needLogin ? <LoginBox /> : null;
}

function LoginBox() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard here: focus anywhere else (except a message box) comes back to the field.
  useEffect(() => {
    inputRef.current?.focus();
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (layerRef.current?.contains(t) || t.closest?.('.msgbox')) return;
      inputRef.current?.focus();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!password) {
      setError('Type the password, then press Enter.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'RapidBooks' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setPassword('');
        loggedIn();
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.status === 401) setError('That password is not correct. Check that Caps Lock is off, then type the password again.');
      else setError(data?.error ?? `The server returned an error (${res.status}).`);
    } catch {
      setError('RapidBooks cannot reach its server. Check that the server computer is on, then try again.');
    } finally {
      setBusy(false);
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  // Nothing typed here may reach the menus or shortcuts of the desktop behind.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    setCaps(e.getModifierState?.('CapsLock') ?? false);
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  return (
    <div className="login-layer" ref={layerRef} onKeyDown={onKeyDown} onKeyUp={(e) => e.stopPropagation()}>
      <form className="win active login-box" role="dialog" aria-modal="true" aria-label="Log in to RapidBooks" onSubmit={submit}>
        <div className="win-title">
          <span className="win-title-text">RapidBooks Login</span>
        </div>
        <div className="login-body">
          <div className="login-brand">RapidBooks</div>
          <p className="login-text">Type the RapidBooks password, then press Enter.</p>
          {error && (
            <div className="msg-strip error" role="alert">
              {error}
            </div>
          )}
          <label htmlFor="rb-login-password" className="login-label">
            <u>P</u>assword:
          </label>
          <input
            id="rb-login-password"
            ref={inputRef}
            className="field login-field"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
          />
          <div className="login-caps" aria-live="polite">
            {caps ? 'Caps Lock is on.' : ' '}
          </div>
          <div className="button-row right">
            <button type="submit" className="btn default" disabled={busy} tabIndex={-1}>
              {busy ? 'Checking...' : 'OK'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
