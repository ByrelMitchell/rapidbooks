import type { EmailDraft } from '@rapidbooks/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, Mnemonic, refocus, useLiveState } from '../util';

export interface EmailStatus {
  configured: boolean;
  message: string | null;
}

/** Send one invoice or credit memo by e-mail, with its PDF attached. Props: { txnId }. */
export function EmailDialog({ winId, props }: WinProps) {
  const txnId = props.txnId as number;
  const desk = useDesktop();
  const { data: status } = useData<EmailStatus>('/api/email/status');
  const [draft, setDraft, draftRef] = useLiveState<EmailDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api.get<EmailDraft>(`/api/email/defaults/${txnId}`).then(
      (d) => !cancelled && setDraft(d),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [txnId]);

  const set = (patch: Partial<EmailDraft>) => {
    setError(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const send = async () => {
    if (busy.current || !draftRef.current || !status?.configured) return;
    const field = commitActiveField();
    const d = draftRef.current;
    busy.current = true;
    setSending(true);
    try {
      await api.post('/api/email/send', { txn_id: txnId, to: d.to, cc: d.cc, subject: d.subject, body: d.body });
      desk.setStatus(`${d.attachment_name.replace(/\.pdf$/i, '')} sent to ${d.to}.`);
      desk.refresh();
      desk.close(winId);
    } catch (e) {
      setError(errorMessage(e));
      refocus(field);
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  // Ctrl+Enter and Alt+S send.
  useWindowCommands(winId, { save: () => void send(), saveClose: () => void send() });

  const notConfigured = status && !status.configured;
  return (
    <div className="dialog email-dialog">
      {notConfigured && <div className="msg-strip error">{status.message ?? 'E-mail is not set up.'}</div>}
      {error && <div className="msg-strip error">{error}</div>}
      {!draft ? (
        <div className="rec-loading">{error ? '' : 'Loading...'}</div>
      ) : (
        <div className="form-grid">
          <label htmlFor={`${winId}-to`}>To</label>
          <input id={`${winId}-to`} className="field" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
          <label htmlFor={`${winId}-cc`}>Cc</label>
          <input id={`${winId}-cc`} className="field" value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
          <label htmlFor={`${winId}-subj`}>Subject</label>
          <input id={`${winId}-subj`} className="field" value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
          <label htmlFor={`${winId}-body`} className="top-label">
            Body
          </label>
          <textarea id={`${winId}-body`} className="field" rows={10} value={draft.body} onChange={(e) => set({ body: e.target.value })} />
          <span>Attachment</span>
          <span className="attachment">{draft.attachment_name}</span>
        </div>
      )}
      <div className="button-row right">
        {!notConfigured && (
          <button type="button" className="btn default" disabled={!draft || !status || sending} onClick={() => void send()} title="Ctrl+Enter">
            <Mnemonic label="&Send Now" />
          </button>
        )}
        <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => desk.close(winId)}>
          {notConfigured ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
