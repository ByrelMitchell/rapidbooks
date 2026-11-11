import { ACCOUNT_TYPES, type Account, type AccountTypeCode } from '@rapidbooks/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage, useData } from '../api';
import { Combo } from '../controls/Combo';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';

interface Form {
  type: AccountTypeCode;
  name: string;
  isSub: boolean;
  parent_id: number | null;
  description: string;
  inactive: boolean;
}

const BLANK: Form = { type: 'BANK', name: '', isSub: false, parent_id: null, description: '', inactive: false };

export function AccountDialog({ winId, props }: WinProps) {
  const id = (props.id as number | null | undefined) ?? null;
  // Set Up from a QuickFill field: the typed name, and the parent when "Parent:Child" was typed.
  const presetParent = (props.parentId as number | null | undefined) ?? null;
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const [form, setForm, formRef] = useLiveState<Form>(() => ({
    ...BLANK,
    name: (props.name as string | undefined) ?? '',
    type: (props.type as AccountTypeCode | undefined) ?? BLANK.type,
  }));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(id === null && presetParent === null);

  useEffect(() => {
    desk.setTitle(winId, id === null ? 'New Account' : 'Edit Account');
  }, [winId, id]);

  // Fill the form once, when editing and the accounts have loaded.
  useEffect(() => {
    if (loaded.current || !accounts) return;
    if (id === null) {
      // New subaccount of a preset parent: it takes the parent's type.
      const p = accounts.find((x) => x.id === presetParent);
      if (p) setForm((f) => ({ ...f, type: p.type, isSub: true, parent_id: p.id }));
      loaded.current = true;
      return;
    }
    const a = accounts.find((x) => x.id === id);
    if (!a) {
      setError('That account no longer exists.');
      loaded.current = true;
      return;
    }
    const f: Form = {
      type: a.type,
      name: a.name,
      isSub: a.parent_id !== null,
      parent_id: a.parent_id,
      description: a.description,
      inactive: a.inactive,
    };
    setForm(f);
    loaded.current = true;
  }, [accounts, id, presetParent, setForm]);

  // Possible parents: same type, not this account or any of its subaccounts.
  const parents = useMemo(() => {
    if (!accounts) return [];
    const self = accounts.find((a) => a.id === id);
    return accounts
      .filter(
        (a) =>
          a.type === form.type &&
          a.id !== id &&
          !(self && (a.full_name + ':').startsWith(self.full_name + ':')),
      )
      .map((a) => ({ id: a.id, label: a.full_name }));
  }, [accounts, form.type, id]);

  const update = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    const field = commitActiveField();
    const f = formRef.current;
    if (f.isSub && f.parent_id === null) {
      setError('Choose the parent account, or clear "Subaccount of".');
      refocus(field);
      return;
    }
    const body = {
      name: f.name,
      type: f.type,
      parent_id: f.isSub ? f.parent_id : null,
      description: f.description,
      inactive: f.inactive,
    };
    setSaving(true);
    try {
      if (id === null) {
        const r = await api.post<{ id: number }>('/api/accounts', body);
        desk.resolveWindow(winId, r.id);
      } else {
        await api.put(`/api/accounts/${id}`, body);
        desk.resolveWindow(winId, id);
      }
      desk.setStatus(`Account "${f.name.trim()}" saved.`);
      desk.refresh();
      desk.close(winId);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
      refocus(field);
    }
  };

  useWindowCommands(winId, { save: () => void submit() });

  return (
    <form
      className="dialog"
      onSubmit={submit}
      onKeyDown={(e) => {
        // Enter anywhere in the dialog (not on a button) is OK.
        const t = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey) return;
        if (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA') return;
        e.preventDefault();
        void submit();
      }}
    >
      {error && <div className="msg-strip error">{error}</div>}
      <div className="form-grid">
        <label htmlFor={`${winId}-type`}>Type</label>
        <select
          id={`${winId}-type`}
          className="field"
          value={form.type}
          onChange={(e) => update({ type: e.target.value as AccountTypeCode, parent_id: null })}
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>

        <label htmlFor={`${winId}-name`}>Name</label>
        <input
          id={`${winId}-name`}
          className="field"
          value={form.name}
          maxLength={100}
          onChange={(e) => update({ name: e.target.value })}
          onFocus={(e) => e.target.select()}
        />

        <span />
        <label className="check">
          <input type="checkbox" checked={form.isSub} onChange={(e) => update({ isSub: e.target.checked })} />
          Subaccount of
        </label>

        <span />
        <Combo
          options={parents}
          value={form.isSub ? form.parent_id : null}
          onChange={(pid) => update({ parent_id: pid })}
          disabled={!form.isSub}
          aria-label="Parent account"
          listName="Account"
        />

        <label htmlFor={`${winId}-desc`}>Description</label>
        <input
          id={`${winId}-desc`}
          className="field"
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
        />

        <span />
        <label className="check">
          <input type="checkbox" checked={form.inactive} onChange={(e) => update({ inactive: e.target.checked })} />
          Account is inactive
        </label>
      </div>
      <div className="button-row right">
        <button type="submit" className="btn default" disabled={saving}>
          OK
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
