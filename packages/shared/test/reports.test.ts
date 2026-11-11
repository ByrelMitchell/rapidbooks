import { describe, expect, it } from 'vitest';
import { DATE_PRESETS, presetId, resolvePreset } from '../src';

const r = (name: string, today: string) => resolvePreset(name, today);

describe('date range presets', () => {
  it('knows every preset by id and by label', () => {
    for (const p of DATE_PRESETS) {
      expect(presetId(p.id)).toBe(p.id);
      expect(presetId(p.label)).toBe(p.id);
    }
    expect(presetId('This Month-to-date')).toBe('this_month_to_date');
    expect(presetId('nonsense')).toBeNull();
    expect(r('custom', '2026-05-05')).toBeNull();
    expect(r('nonsense', '2026-05-05')).toBeNull();
    expect(r('All', '2026-05-05')).toEqual({ from: null, to: null });
  });

  it('on New Year’s Day (a Thursday): year, quarter, month and week boundaries', () => {
    const d = '2026-01-01';
    expect(r('Today', d)).toEqual({ from: d, to: d });
    expect(r('Yesterday', d)).toEqual({ from: '2025-12-31', to: '2025-12-31' });
    expect(r('This Week', d)).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(r('This Week-to-date', d)).toEqual({ from: '2025-12-28', to: d });
    expect(r('Last Week', d)).toEqual({ from: '2025-12-21', to: '2025-12-27' });
    expect(r('This Month', d)).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(r('This Month-to-date', d)).toEqual({ from: d, to: d });
    expect(r('Last Month', d)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(r('This Fiscal Quarter', d)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(r('This Fiscal Quarter-to-date', d)).toEqual({ from: d, to: d });
    expect(r('Last Fiscal Quarter', d)).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(r('This Fiscal Year', d)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(r('This Fiscal Year-to-date', d)).toEqual({ from: d, to: d });
    expect(r('Last Fiscal Year', d)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('at the end of a quarter and of a leap February', () => {
    expect(r('this_fiscal_quarter', '2026-03-31')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(r('this_fiscal_quarter', '2026-04-01')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(r('last_fiscal_quarter', '2026-04-01')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(r('last_fiscal_quarter', '2026-12-31')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(r('this_fiscal_quarter_to_date', '2026-08-15')).toEqual({ from: '2026-07-01', to: '2026-08-15' });
    expect(r('last_month', '2024-03-01')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(r('this_month', '2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(r('last_month', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('weeks run Sunday to Saturday', () => {
    expect(r('this_week', '2026-11-08')).toEqual({ from: '2026-11-08', to: '2026-11-14' }); // a Sunday
    expect(r('this_week', '2026-11-14')).toEqual({ from: '2026-11-08', to: '2026-11-14' }); // a Saturday
    expect(r('last_week', '2026-11-11')).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    expect(r('this_week_to_date', '2026-11-11')).toEqual({ from: '2026-11-08', to: '2026-11-11' });
  });
});
