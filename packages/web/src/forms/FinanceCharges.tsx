import {
  formatMoney,
  formatUsDate,
  todayIso,
  type Account,
  type FinanceChargePreview,
  type FinanceChargeSettings,
} from '@rapidbooks/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errorMessage, useData } from '../api';
import { AmountField } from '../controls/AmountField';
import { Combo, settleQuickFill } from '../controls/Combo';
import { DateField } from '../controls/DateField';
import { ListView, type Column } from '../controls/ListView';
import { accountQuickFill } from '../lists/quickAdd';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { commitActiveField, refocus, useLiveState } from '../util';
import './receivables.css';

const NO_ACCOUNT =
  'Before you can assess finance charges, choose the account finance charges are posted to (an income account) in Finance Charge Settings.';

/** Customers > Assess Finance Charges. */
export function FinanceCharges({ winId }: WinProps) {
  const desk = useDesktop();
  const [asOf, setAsOf] = useState(todayIso);
  const { data: settings } = useData<FinanceChargeSettings>('/api/finance-charges/settings');
  const { data, error } = useData<FinanceChargePreview[]>(asOf ? `/api/finance-charges/preview?as_of=${asOf}` : null);
  const rows = data ?? [];
  const [unmarked, setUnmarked] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (rows.length && (selected === null || !rows.some((r) => r.name_id === selected))) setSelected(rows[0].name_id);
  }, [rows, selected]);

  const openSettings = () => desk.openForResult<boolean>('fcsettings', {});

  // No finance charge account yet: send her to Settings first, once, when the window opens.
  useEffect(() => {
    if (!settings || asked.current) return;
    asked.current = true;
    if (settings.account_id === null) {
      void desk.alert(NO_ACCOUNT, { title: 'Assess Finance Charges', icon: 'info' }).then(() => openSettings());
    }
  }, [settings]);

  const marked = rows.filter((r) => !unmarked.has(r.name_id) && r.charge > 0);
  const toggle = (id: number) =>
    setUnmarked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const assess = async () => {
    commitActiveField();
    if (busy) return;
    if (!settings || settings.account_id === null) {
      await desk.alert(NO_ACCOUNT, { title: 'Assess Finance Charges', icon: 'info' });
      await openSettings();
      return;
    }
    if (marked.length === 0) {
      await desk.alert('There are no customers marked to assess finance charges on.');
      return;
    }
    const total = marked.reduce((t, r) => t + r.charge, 0);
    if (
      !(await desk.confirm(
        `Assess finance charges of ${formatMoney(total)} on ${marked.length} customer${marked.length === 1 ? '' : 's'} as of ${formatUsDate(asOf)}?`,
        { yes: '&OK', no: '&Cancel' },
      ))
    )
      return;
    setBusy(true);
    try {
      const r = await api.post<{ ids: number[] }>('/api/finance-charges/assess', {
        as_of: asOf,
        customer_ids: marked.map((m) => m.name_id),
      });
      desk.refresh();
      setUnmarked(new Set());
      const n = r.ids.length;
      await desk.alert(`${n} finance charge invoice${n === 1 ? ' was' : 's were'} created.`, {
        title: 'Assess Finance Charges',
        icon: 'info',
      });
      desk.setStatus(`${n} finance charge invoice${n === 1 ? '' : 's'} created.`);
    } catch (e) {
      await desk.alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useWindowCommands(winId, {});

  const columns: Column<FinanceChargePreview>[] = [
    {
      key: 'chk',
      title: '✓',
      width: '2rem',
      align: 'center',
      render: (r) => (!unmarked.has(r.name_id) && r.charge > 0 ? '✓' : ''),
      onClick: (r) => toggle(r.name_id),
    },
    { key: 'last', title: 'Last FC', width: '7rem', render: (r) => (r.last_fc_date ? formatUsDate(r.last_fc_date) : '') },
    { key: 'name', title: 'Customer', render: (r) => r.full_name },
    { key: 'bal', title: 'Overdue Bal.', width: '8.5rem', align: 'right', render: (r) => formatMoney(r.overdue_balance) },
    { key: 'fc', title: 'Finance Charge', width: '8.5rem', align: 'right', render: (r) => formatMoney(r.charge) },
  ];

  return (
    <div className="list-window">
      <div className="form-header">
        <label>
          Assessment Date
          <DateField value={asOf} onChange={setAsOf} />
        </label>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void openSettings()}>
          Settings...
        </button>
      </div>
      {settings && (
        <div className="hint">
          Annual rate {settings.annual_rate_bp / 100}%, minimum charge {formatMoney(settings.min_charge)}, grace period{' '}
          {settings.grace_days} day{settings.grace_days === 1 ? '' : 's'}. The charges are worked out from these settings and
          cannot be changed here.
        </div>
      )}
      {error && <div className="msg-strip error">{error}</div>}
      <div
        className="stmt-list"
        onKeyDown={(e) => {
          if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey) return;
          if (!(e.target as HTMLElement).classList.contains('listview')) return;
          e.preventDefault();
          if (selected !== null) toggle(selected);
        }}
      >
        <ListView
          columns={columns}
          rows={rows}
          rowKey={(r) => r.name_id}
          selected={selected}
          onSelect={setSelected}
          emptyText={data ? 'No customer has an overdue balance to charge as of this date.' : 'Loading...'}
          label="Customers to assess"
        />
      </div>
      <div className="button-row">
        <button type="button" className="btn" onClick={() => setUnmarked(new Set())}>
          Mark All
        </button>
        <button type="button" className="btn" onClick={() => setUnmarked(new Set(rows.map((r) => r.name_id)))}>
          Unmark All
        </button>
        <span className="spacer" />
        <span>
          {marked.length} marked, total {formatMoney(marked.reduce((t, r) => t + r.charge, 0))}
        </span>
      </div>
      <div className="button-row right">
        <button type="button" className="btn default" disabled={busy} onClick={() => void assess()}>
          Assess Charges
        </button>
        <button type="button" className="btn" onClick={() => desk.close(winId)}>
          Close
        </button>
      </div>
    </div>
  );
}

interface SettingsForm {
  rate: number | null; // percent in hundredths (18% = 1800, which is also basis points)
  min: number | null; // cents
  grace: string;
  accountId: number | null;
  onFc: boolean;
}

/** Finance Charge Settings (the QuickBooks Preferences tab). Result: true when saved. */
export function FinanceChargeSettingsDialog({ winId }: WinProps) {
  const desk = useDesktop();
  const { data: accounts } = useData<Account[]>('/api/accounts');
  const [form, setForm, formRef] = useLiveState<SettingsForm | null>(null);
  const snapshot = useRef('');
  const [error, setError] = useState<string | null>(null);
  const idFc = useId();

  useEffect(() => {
    api.get<FinanceChargeSettings>('/api/finance-charges/settings').then(
      (s) => {
        const f: SettingsForm = {
          // The AmountField reads "18" as 1800 hundredths, the same number as basis points.
          rate: s.annual_rate_bp,
          min: s.min_charge,
          grace: String(s.grace_days),
          accountId: s.account_id,
          onFc: s.charge_on_finance_charges,
        };
        setForm(f);
        snapshot.current = JSON.stringify(f);
      },
      (e) => setError(errorMessage(e)),
    );
  }, []);

  const options = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => (a.type === 'INC' || a.type === 'OINC') && (!a.inactive || a.id === form?.accountId))
        .map((a) => ({ id: a.id, label: a.full_name })),
    [accounts, form?.accountId],
  );

  const set = (patch: Partial<SettingsForm>) => {
    setError(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const ok = async () => {
    const field = commitActiveField();
    if (!(await settleQuickFill())) return;
    const f = formRef.current;
    if (!f) return;
    const fail = (m: string) => {
      setError(m);
      refocus(field);
    };
    const rate = f.rate ?? 0;
    if (rate < 0 || rate > 100000 || !Number.isInteger(rate)) return fail('Enter an annual rate between 0 and 1000 percent.');
    const min = f.min ?? 0;
    if (min < 0) return fail('The minimum finance charge cannot be negative.');
    const grace = f.grace.trim() === '' ? 0 : Number(f.grace);
    if (!Number.isInteger(grace) || grace < 0) return fail('Enter the grace period as a whole number of days.');
    if (f.accountId === null) return fail('Choose the income account finance charges are posted to.');
    const body: FinanceChargeSettings = {
      annual_rate_bp: rate,
      min_charge: min,
      grace_days: grace,
      account_id: f.accountId,
      charge_on_finance_charges: f.onFc,
    };
    try {
      await api.put('/api/finance-charges/settings', body);
    } catch (e) {
      return fail(errorMessage(e));
    }
    desk.refresh();
    desk.setStatus('Finance charge settings saved.');
    desk.resolveWindow(winId, true);
    desk.close(winId);
  };

  const confirmClose = async () => {
    const field = commitActiveField({ quiet: true });
    if (!formRef.current || JSON.stringify(formRef.current) === snapshot.current) return true;
    if (await desk.confirm('You have changed the settings. Do you want to discard your changes?', { defaultNo: true })) return true;
    refocus(field);
    return false;
  };

  useWindowCommands(winId, { save: () => void ok(), saveClose: () => void ok(), confirmClose });

  return (
    <form
      className="dialog"
      onSubmit={(e) => {
        e.preventDefault();
        void ok();
      }}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey || t.tagName === 'BUTTON') return;
        e.preventDefault();
        void ok();
      }}
    >
      {error && <div className="msg-strip error">{error}</div>}
      {!form ? (
        <div className="rec-loading">Loading...</div>
      ) : (
        <div className="form-grid dlg-fields">
          <label htmlFor={`${winId}-rate`}>Annual Interest Rate (%)</label>
          <AmountField id={`${winId}-rate`} className="short-amount" value={form.rate} onChange={(rate) => set({ rate })} />
          <label htmlFor={`${winId}-min`}>Minimum Finance Charge</label>
          <AmountField id={`${winId}-min`} className="short-amount" value={form.min} onChange={(min) => set({ min })} />
          <label htmlFor={`${winId}-grace`}>Grace Period (days)</label>
          <input
            id={`${winId}-grace`}
            className="field small-num"
            inputMode="numeric"
            value={form.grace}
            onChange={(e) => set({ grace: e.target.value })}
            onFocus={(e) => e.target.select()}
          />
          <label htmlFor={`${winId}-acct`}>Finance Charge Account</label>
          <Combo
            id={`${winId}-acct`}
            options={options}
            value={form.accountId}
            onChange={(accountId) => set({ accountId })}
            {...accountQuickFill(desk, { type: 'INC' })}
          />
          <span />
          <label className="check" htmlFor={idFc}>
            <input id={idFc} type="checkbox" checked={form.onFc} onChange={(e) => set({ onFc: e.target.checked })} />
            Assess finance charges on overdue finance charges
          </label>
        </div>
      )}
      <div className="button-row right">
        <button type="submit" className="btn default" disabled={!form}>
          OK
        </button>
        <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => desk.close(winId)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
