import { accountType, formatMoney, type Account, type CheckNumUse, type Item, type Name } from '@rapidbooks/shared';
import { useRef } from 'react';
import { api } from '../api';
import type { ComboOption } from '../controls/Combo';
import type { Desktop } from '../shell/desktop';

// Helpers shared by Write Checks, Paychecks, Transfer Funds and Print Checks.

/** The next check number on a bank account (checks, bill payments and paychecks share one sequence). */
export async function nextCheckNum(accountId: number): Promise<string> {
  return (await api.get<{ num: string }>(`/api/txns/next-num?type=CHECK&account_id=${accountId}`)).num;
}

/** Bank accounts for a Combo (inactive ones only when already chosen). */
export function bankOptions(accounts: Account[] | undefined, current: number | null): ComboOption[] {
  return (accounts ?? [])
    .filter((a) => a.type === 'BANK' && (!a.inactive || a.id === current))
    .map((a) => ({ id: a.id, label: a.full_name }));
}

/** The first active bank account, the default for a new check. */
export const firstBankId = (accounts: Account[] | undefined): number | null =>
  accounts?.find((a) => a.type === 'BANK' && !a.inactive)?.id ?? null;

/** An account's balance as its register shows it (credit-normal accounts as positive). */
export function naturalBalance(a: Account): number {
  return accountType(a.type).debitNormal ? a.balance : -a.balance;
}

/** "Ending Balance 1,234.56" next to an account field. */
export function EndingBalance({ accounts, id }: { accounts: Account[] | undefined; id: number | null }) {
  const a = id !== null ? accounts?.find((x) => x.id === id) : undefined;
  return (
    <span className="bk-balance">
      Ending Balance <span className="bk-balance-amt">{a ? formatMoney(naturalBalance(a)) : ''}</span>
    </span>
  );
}

/** The address block QuickBooks puts on a check: the payee's printed name, then the address. */
export function payeeAddress(n: Name | undefined): string {
  if (!n) return '';
  const name = n.print_as.trim() || n.full_name;
  const addr = n.bill_addr.trim();
  return addr ? `${name}\n${addr}` : name;
}

const PURCHASABLE = new Set(['SERVICE', 'PART', 'OTHER_CHARGE']);
/** Items that can go on a check or bill (the server refuses the others). */
export const isPurchasable = (i: Item) => PURCHASABLE.has(i.type);

/**
 * The item list as purchase forms see it: the purchase description and the cost in
 * place of the sales description and rate, so the shared LineGrid fills them in.
 */
export function purchaseItems(items: Item[] | undefined): Item[] | undefined {
  return items?.map((i) => ({
    ...i,
    description: i.purchase_description || i.description,
    rate: i.cost,
    rate_is_percent: false,
  }));
}

/**
 * The "Check number N has already been used. Use it anyway?" warning. ensure() asks the
 * server once per account and number (a confirmed or unused number is not asked again),
 * and a check already in progress is shared, so leaving the No. field and saving in the
 * same keystroke shows one box. Resolves false when she answers No.
 */
export function useCheckNumGuard(desk: Desktop) {
  const ok = useRef<string | null>(null);
  const inflight = useRef<{ key: string; p: Promise<boolean> } | null>(null);
  const keyOf = (bankId: number, num: string) => `${bankId}|${num.trim().toLowerCase()}`;

  const markOk = (bankId: number | null, num: string) => {
    ok.current = bankId !== null && num.trim() ? keyOf(bankId, num) : null;
  };

  const ensure = (bankId: number | null, num: string, excludeId: number | null): Promise<boolean> => {
    const n = num.trim();
    if (bankId === null || n === '') return Promise.resolve(true);
    const key = keyOf(bankId, n);
    if (ok.current === key) return Promise.resolve(true);
    if (inflight.current?.key === key) return inflight.current.p;
    const p = (async () => {
      let used: CheckNumUse;
      try {
        used = await api.get<CheckNumUse>(
          `/api/checks/num-used?account_id=${bankId}&num=${encodeURIComponent(n)}${excludeId !== null ? `&exclude_id=${excludeId}` : ''}`,
        );
      } catch {
        return true; // only a warning; the save itself will report a server that is away
      }
      if (
        !used.used ||
        (await desk.confirm(`Check number ${n} has already been used. Use it anyway?`, { title: 'Duplicate Check Number', icon: 'warning' }))
      ) {
        ok.current = key;
        return true;
      }
      return false;
    })();
    inflight.current = { key, p };
    void p.finally(() => {
      if (inflight.current?.p === p) inflight.current = null;
    });
    return p;
  };

  return { ensure, markOk };
}

/** Whole days from one ISO date to another. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  return Math.round(ms / 86400000);
}
