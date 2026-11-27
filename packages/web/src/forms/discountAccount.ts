import type { Account } from '@rapidbooks/shared';

/**
 * The account a discount dialog offers first. Customer discounts (Receive Payments) are money
 * given away, usually an expense such as "Discounts Given"; vendor discounts (Pay Bills) are
 * money saved, usually income such as "Discounts Taken". The account last chosen on that side
 * is remembered in this browser, as QuickBooks keeps its default discount accounts.
 */
export type DiscountSide = 'customer' | 'vendor';

const KEY: Record<DiscountSide, string> = {
  customer: 'rapidbooks.discountAccount.customer',
  vendor: 'rapidbooks.discountAccount.vendor',
};

const usable = (a: Account) => !a.inactive && a.type !== 'AR' && a.type !== 'AP';

export function rememberDiscountAccount(side: DiscountSide, id: number): void {
  try {
    localStorage.setItem(KEY[side], String(id));
  } catch {
    // Private mode or storage full: the guess below still works.
  }
}

export function defaultDiscountAccount(accounts: Account[], side: DiscountSide): number | null {
  let saved: number | null = null;
  try {
    const v = Number(localStorage.getItem(KEY[side]));
    saved = Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    saved = null;
  }
  if (saved !== null && accounts.some((a) => a.id === saved && usable(a))) return saved;

  const discounts = accounts.filter((a) => usable(a) && /discount/i.test(a.name));
  const income = (a: Account) => a.type === 'INC' || a.type === 'OINC';
  const ranked =
    side === 'vendor'
      ? [
          discounts.find((a) => /taken|earned|received/i.test(a.name)),
          discounts.find(income),
          discounts.find((a) => !/given|allowed/i.test(a.name)),
        ]
      : [
          discounts.find((a) => /given|allowed/i.test(a.name)),
          discounts.find((a) => !income(a)),
          discounts.find((a) => !/taken|earned|received/i.test(a.name)),
        ];
  return ranked.find((a) => a !== undefined)?.id ?? null;
}
