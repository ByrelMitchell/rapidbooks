import { describe, expect, it } from 'vitest';
import { applyDateKey, dueDate, evalAmount, formatMoney, formatUsDate, parseUsDate } from '../src';

describe('money', () => {
  it('formats cents', () => {
    expect(formatMoney(123456)).toBe('1,234.56');
    expect(formatMoney(-5)).toBe('-0.05');
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(0, { blankZero: true })).toBe('');
  });
  it('evaluates amounts and arithmetic', () => {
    expect(evalAmount('1,234.5')).toBe(123450);
    expect(evalAmount('$12')).toBe(1200);
    expect(evalAmount('3*12.50+4')).toBe(4150);
    expect(evalAmount('(100-15)/2')).toBe(4250);
    expect(evalAmount('-7.25')).toBe(-725);
    expect(evalAmount('1.005')).toBe(101);
    expect(evalAmount('19.99*3')).toBe(5997);
    expect(evalAmount('')).toBeNull();
    expect(evalAmount('abc')).toBeNull();
    expect(evalAmount('1/0')).toBeNull();
    expect(evalAmount('2+')).toBeNull();
  });
});

describe('dates', () => {
  const today = '2026-11-11'; // a Wednesday
  it('parses typed dates', () => {
    expect(parseUsDate('3/7', today)).toBe('2026-03-07');
    expect(parseUsDate('3/7/03', today)).toBe('2003-03-07');
    expect(parseUsDate('03/07/1999', today)).toBe('1999-03-07');
    expect(parseUsDate('030703', today)).toBe('2003-03-07');
    expect(parseUsDate('2/30/2026', today)).toBeNull();
    expect(parseUsDate('hello', today)).toBeNull();
  });
  it('formats', () => {
    expect(formatUsDate('2003-03-07')).toBe('03/07/2003');
  });
  it('applies QuickBooks date keys', () => {
    expect(applyDateKey(today, '+', today)).toBe('2026-11-12');
    expect(applyDateKey('2026-01-01', '-', today)).toBe('2025-12-31');
    expect(applyDateKey('2020-05-05', 't', today)).toBe(today);
    expect(applyDateKey(today, 'w', today)).toBe('2026-11-08');
    expect(applyDateKey('2026-11-08', 'w', today)).toBe('2026-11-01');
    expect(applyDateKey(today, 'k', today)).toBe('2026-11-14');
    expect(applyDateKey(today, 'm', today)).toBe('2026-11-01');
    expect(applyDateKey('2026-11-01', 'm', today)).toBe('2026-10-01');
    expect(applyDateKey(today, 'h', today)).toBe('2026-11-30');
    expect(applyDateKey('2026-11-30', 'h', today)).toBe('2026-12-31');
    expect(applyDateKey('2026-01-31', 'h', today)).toBe('2026-02-28');
    expect(applyDateKey(today, 'y', today)).toBe('2026-01-01');
    expect(applyDateKey('2026-01-01', 'y', today)).toBe('2025-01-01');
    expect(applyDateKey(today, 'r', today)).toBe('2026-12-31');
    expect(applyDateKey(today, 'x', today)).toBeNull();
  });
});

describe('terms', () => {
  it('computes due dates', () => {
    expect(dueDate(null, '2026-01-31')).toBe('2026-01-31');
    expect(dueDate({ net_days: 0 }, '2026-01-31')).toBe('2026-01-31');
    expect(dueDate({ net_days: 30 }, '2026-01-31')).toBe('2026-03-02');
    expect(dueDate({ net_days: 30 }, '2024-02-01')).toBe('2024-03-02'); // leap year
    expect(dueDate({ net_days: 10 }, '2026-12-25')).toBe('2027-01-04');
  });
});
