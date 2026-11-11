import { evalAmount, type Terms, type TermsInput } from '@rapidbooks/shared';
import { api } from '../api';
import { useDesktop } from '../shell/desktop';
import type { WinProps } from '../shell/registry';
import { RecordDialogFrame, useRecordDialog } from './RecordDialog';

interface Form {
  name: string;
  net_days: string;
  discount_pct: string; // percent as typed: "2" = 2%
  discount_days: string;
  inactive: boolean;
}

const blankForm = (name = ''): Form => ({ name, net_days: '0', discount_pct: '0', discount_days: '0', inactive: false });

function days(s: string, what: string): number | string {
  const t = s.trim();
  if (t === '') return 0;
  return /^\d+$/.test(t) ? Number(t) : `Enter ${what} as a whole number of days.`;
}

function toBody(f: Form): TermsInput | string {
  const net = days(f.net_days, 'the net due days');
  if (typeof net === 'string') return net;
  const discDays = days(f.discount_days, 'the discount days');
  if (typeof discDays === 'string') return discDays;
  const pct = f.discount_pct.replace(/%\s*$/, '').trim();
  const bp = pct === '' ? 0 : evalAmount(pct); // hundredths of a percent = basis points
  if (bp === null || bp < 0) return 'Enter the discount as a percentage, such as 2 or 1.5.';
  return { name: f.name, net_days: net, discount_pct: bp, discount_days: discDays, inactive: f.inactive };
}

export function TermsDialog({ winId, props }: WinProps) {
  const id = (props.id as number | null | undefined) ?? null;
  const desk = useDesktop();
  const dlg = useRecordDialog<Form>({
    winId,
    id,
    initial: () => blankForm((props.name as string | undefined) ?? ''),
    blank: () => blankForm(),
    load: async (rid) => {
      const t = await api.get<Terms>(`/api/terms/${rid}`);
      return {
        name: t.name,
        net_days: String(t.net_days),
        discount_pct: String(t.discount_pct / 100),
        discount_days: String(t.discount_days),
        inactive: t.inactive,
      };
    },
    validate: (f) => {
      const b = toBody(f);
      return typeof b === 'string' ? b : null;
    },
    save: async (f, rid) => {
      const body = toBody(f) as TermsInput;
      if (rid === null) return (await api.post<{ id: number }>('/api/terms', body)).id;
      await api.put(`/api/terms/${rid}`, body);
      return rid;
    },
    titles: { new: 'New Terms', edit: 'Edit Terms' },
    savedMessage: (f) => `Terms "${f.name.trim()}" saved.`,
    openNew: () => desk.open('term', { id: null }),
  });
  const { form, update } = dlg;
  const fid = (k: string) => `${winId}-${k}`;
  const num = (k: 'net_days' | 'discount_pct' | 'discount_days', label: string) => (
    <input
      id={fid(k)}
      className="field small-num"
      value={form[k]}
      inputMode="decimal"
      aria-label={label}
      onChange={(e) => update({ [k]: e.target.value } as Partial<Form>)}
      onFocus={(e) => e.target.select()}
    />
  );

  return (
    <RecordDialogFrame
      dlg={dlg}
      winId={winId}
      inactive={
        <label className="check">
          <input type="checkbox" checked={form.inactive} onChange={(e) => update({ inactive: e.target.checked })} />
          Terms is inactive
        </label>
      }
    >
      <div className="form-grid">
        <label htmlFor={fid('name')}>Terms</label>
        <input
          id={fid('name')}
          className="field"
          value={form.name}
          maxLength={31}
          onChange={(e) => update({ name: e.target.value })}
        />
      </div>
      <fieldset className="groupbox terms-box">
        <legend>Standard</legend>
        <div className="terms-line">
          <label htmlFor={fid('net_days')}>Net due in</label>
          {num('net_days', 'Net due in days')}
          <span>days.</span>
        </div>
        <div className="terms-line">
          <label htmlFor={fid('discount_pct')}>Discount percentage is</label>
          {num('discount_pct', 'Discount percentage')}
          <span>%</span>
        </div>
        <div className="terms-line">
          <label htmlFor={fid('discount_days')}>Discount if paid within</label>
          {num('discount_days', 'Discount if paid within days')}
          <span>days.</span>
        </div>
      </fieldset>
    </RecordDialogFrame>
  );
}
