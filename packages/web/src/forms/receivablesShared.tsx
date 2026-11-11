import type { NameKind } from '@rapidbooks/shared';
import { useId, type InputHTMLAttributes } from 'react';
import { api, errorMessage } from '../api';
import { NAME_WINDOWS, type QuickFill } from '../lists/quickAdd';
import type { Desktop } from '../shell/desktop';

/** The payment methods QuickBooks starts with; anything else may be typed. */
export const PAY_METHODS = ['Check', 'Cash', 'Credit Card'];

type PayMethodProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (v: string) => void;
  /** More choices (methods already used on the form). */
  extra?: string[];
};

/** Pmt. Method: a text field with the usual methods offered as you type (Alt+Down lists them). */
export function PayMethodField({ value, onChange, extra = [], className, ...rest }: PayMethodProps) {
  const listId = useId();
  const choices = [...new Set([...PAY_METHODS, ...extra.filter((x) => x.trim())])];
  return (
    <>
      <input
        {...rest}
        className={`field${className ? ` ${className}` : ''}`}
        list={listId}
        value={value}
        maxLength={30}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          // "check" typed: use the list's spelling.
          const t = e.target.value.trim();
          const hit = choices.find((c) => c.toLowerCase() === t.toLowerCase());
          if (hit && hit !== e.target.value) onChange(hit);
          else if (t !== e.target.value) onChange(t);
        }}
      />
      <datalist id={listId}>
        {choices.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </>
  );
}

/**
 * QuickFill for a field that takes any kind of name (Make Deposits "Received From"):
 * not on the list -> Quick Add / Set Up / Cancel, then which kind of name it is.
 */
export function anyNameQuickFill(d: Desktop): QuickFill {
  return {
    listName: 'Customer:Job',
    onNotFound: async (text) => {
      const how = await d.messageBox(`"${text}" is not in the Name list.`, {
        title: 'Name Not Found',
        icon: 'question',
        buttons: ['&Quick Add', '&Set Up', '&Cancel'],
      });
      if (how === 2) return null;
      const kinds: NameKind[] = ['vendor', 'customer', 'employee', 'other'];
      const k = await d.messageBox(`What kind of name is "${text}"?`, {
        title: 'Select Name Type',
        icon: 'question',
        buttons: ['&Vendor', '&Customer', '&Employee', '&Other', 'Cancel'],
      });
      if (k >= kinds.length) return null;
      const kind = kinds[k];
      if (how === 1) return d.openForResult(NAME_WINDOWS[kind].dialog, { id: null, name: text, parentId: null });
      try {
        const { id } = await api.post<{ id: number }>('/api/names', { kind, name: text, parent_id: null });
        d.refresh();
        d.setStatus(`"${text}" added.`);
        return id;
      } catch (e) {
        await d.alert(errorMessage(e));
        return null;
      }
    },
  };
}

/** The previous or next transaction of a type (Previous / Next buttons), or null at either end. */
export async function adjacentTxn(type: string, id: number | null, dir: 'prev' | 'next'): Promise<number | null> {
  const r = await api.get<{ prev: number | null; next: number | null }>(
    `/api/txns/adjacent?type=${type}&id=${id ?? ''}`,
  );
  return r[dir];
}
