import { COMPANY_FIELDS, type CompanyInfo as Info } from '@rapidbooks/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';

const blank = (): Info => Object.fromEntries(COMPANY_FIELDS.map(([k]) => [k, '']));

export function CompanyInfo({ winId }: WinProps) {
  const desk = useDesktop();
  const [info, setInfo, infoRef] = useLiveState<Info>(blank);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef('');

  useEffect(() => {
    let cancelled = false;
    api.get<Info>('/api/company').then(
      (data) => {
        if (cancelled) return;
        const f = { ...blank(), ...data };
        setInfo(f);
        saved.current = JSON.stringify(f);
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [setInfo]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    const field = commitActiveField();
    const body: Info = {};
    for (const [k] of COMPANY_FIELDS) body[k] = infoRef.current[k] ?? '';
    try {
      await api.put('/api/company', body);
      desk.setStatus('Company information saved.');
      desk.refresh();
      desk.close(winId);
    } catch (err) {
      setError(errorMessage(err));
      refocus(field);
    }
  };

  useWindowCommands(winId, {
    save: () => void submit(),
    confirmClose: () => {
      const field = commitActiveField();
      if (loading || JSON.stringify(infoRef.current) === saved.current) return true;
      if (window.confirm('The company information has changes that have not been saved. Do you want to discard changes?')) return true;
      refocus(field);
      return false;
    },
  });

  return (
    <form
      className="dialog"
      onSubmit={submit}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey) return;
        if (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA') return;
        e.preventDefault();
        void submit();
      }}
    >
      {error && <div className="msg-strip error">{error}</div>}
      <div className="form-grid">
        {COMPANY_FIELDS.map(([key, label]) => (
          <FieldRow
            key={key}
            id={`${winId}-${key}`}
            label={label}
            multiline={key === 'address'}
            value={info[key] ?? ''}
            disabled={loading}
            onChange={(v) => setInfo((cur) => ({ ...cur, [key]: v }))}
          />
        ))}
      </div>
      <div className="button-row right">
        <button type="submit" className="btn default" disabled={loading}>
          OK
        </button>
        <button type="button" className="btn" disabled={loading} onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function FieldRow(p: {
  id: string;
  label: string;
  multiline: boolean;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label htmlFor={p.id}>{p.label}</label>
      {p.multiline ? (
        <textarea
          id={p.id}
          className="field"
          rows={4}
          value={p.value}
          disabled={p.disabled}
          onChange={(e) => p.onChange(e.target.value)}
        />
      ) : (
        <input
          id={p.id}
          className="field"
          value={p.value}
          disabled={p.disabled}
          onChange={(e) => p.onChange(e.target.value)}
        />
      )}
    </>
  );
}
