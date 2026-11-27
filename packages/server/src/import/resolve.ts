// Accounts that share a name in the Journal.
//
// QuickBooks 2013's Journal prints only the last part of an account's name, so "electric"
// may be Utilities:electric or Supplies:electric, both expense accounts. The import narrows
// such a name by Account Type, capitalisation and item (history.ts); what is left is
// decided here from the Profit & Loss: in each period, the rows with that name must make
// up exactly what QuickBooks shows for each of the accounts. With a report by month the
// periods are small and there is nearly always one way to do it. Rows that move no money
// (0.00) cannot be told apart and do not matter; two rows of the same vendor and amount in
// the same period are interchangeable on every report, so either choice is taken.

export interface AmbiguousRow {
  key: number; // the caller's reference
  group: string; // rows sharing a name and the same candidate accounts
  candidates: number[]; // account ids
  date: string; // ISO
  amount: number; // cents, debit positive
  vendor: string;
}

export interface Period {
  from: string;
  to: string;
  /** QuickBooks' amount per account for the period, in cents, debit positive. */
  amounts: Map<number, number>;
}

export interface GroupReport {
  group: string;
  candidates: number[];
  rows: number;
  resolved: number;
  periods: number;
  /** Periods where several different assignments fit (not just same-amount swaps). */
  ambiguous: string[];
  /** Periods whose rows cannot make QuickBooks' amounts at all. */
  inconsistent: string[];
  /** Rows not in any period of the report. */
  outside: number;
  note?: string;
}

const MAX_STATES = 2_000_000;
const MAX_SOLUTIONS = 20;

/**
 * Assign each ambiguous row to one of its candidates. `fixed(account, from, to)` is what
 * the account already has in the period from rows that were not ambiguous. Returns the
 * assignments found (rows left out stay undecided) and a report per group.
 */
export function resolveSharedNames(
  rows: AmbiguousRow[],
  periods: Period[],
  fixed: (account: number, from: string, to: string) => number,
): { assign: Map<number, number>; groups: GroupReport[] } {
  const assign = new Map<number, number>();
  const groups: GroupReport[] = [];
  const byGroup = new Map<string, AmbiguousRow[]>();
  for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  // Shortest periods first: each row goes to the finest period that contains it.
  const len = (p: Period) => Date.parse(p.to) - Date.parse(p.from);
  const finest = [...periods].sort((a, b) => len(a) - len(b));

  for (const [group, list] of byGroup) {
    const candidates = list[0].candidates;
    const rep: GroupReport = { group, candidates, rows: list.length, resolved: 0, periods: 0, ambiguous: [], inconsistent: [], outside: 0 };
    groups.push(rep);
    if (periods.length === 0) {
      rep.note = 'no Profit & Loss was given to tell them apart';
      continue;
    }
    if (candidates.length !== 2) {
      rep.note = `the name is shared by ${candidates.length} accounts; only two can be told apart`;
      continue;
    }
    const [a, b] = candidates;
    const inPeriod = new Map<Period, AmbiguousRow[]>();
    for (const r of list) {
      const p = finest.find((x) => x.from <= r.date && r.date <= x.to && x.amounts.size > 0);
      if (!p) {
        rep.outside++;
        continue;
      }
      inPeriod.set(p, [...(inPeriod.get(p) ?? []), r]);
    }
    rep.periods = inPeriod.size;
    // Which side each vendor's rows went to, for the 0.00 rows.
    const vendorSide = new Map<string, number>();
    const zeros: AmbiguousRow[] = [];

    for (const [p, prs] of [...inPeriod].sort((x, y) => x[0].from.localeCompare(y[0].from))) {
      const label = p.from.slice(0, 7) === p.to.slice(0, 7) ? p.from.slice(0, 7) : `${p.from} - ${p.to}`;
      const ta = (p.amounts.get(a) ?? 0) - fixed(a, p.from, p.to);
      const tb = (p.amounts.get(b) ?? 0) - fixed(b, p.from, p.to);
      const items = prs.filter((r) => r.amount !== 0);
      zeros.push(...prs.filter((r) => r.amount === 0));
      if (items.reduce((t, r) => t + r.amount, 0) !== ta + tb) {
        rep.inconsistent.push(label);
        continue;
      }
      const sols = subsetsSumming(
        items.map((r) => r.amount),
        tb,
      );
      if (sols === null) {
        rep.ambiguous.push(`${label} (too many rows to work out)`);
        continue;
      }
      if (sols.length === 0) {
        rep.inconsistent.push(label);
        continue;
      }
      // Several solutions that only swap rows of the same vendor and amount are the same.
      const shape = (s: number[]) =>
        s
          .map((i) => `${items[i].vendor.toLowerCase()}|${items[i].amount}`)
          .sort()
          .join('\n');
      if (new Set(sols.map(shape)).size > 1) {
        rep.ambiguous.push(label);
        continue;
      }
      const toB = new Set(sols[0]);
      items.forEach((r, i) => {
        const acct = toB.has(i) ? b : a;
        assign.set(r.key, acct);
        vendorSide.set(r.vendor.toLowerCase(), acct);
        rep.resolved++;
      });
    }
    // 0.00 rows: where the vendor's other rows went, else the account with more money.
    const big = list.reduce((t, r) => t + (assign.get(r.key) === a ? Math.abs(r.amount) : 0), 0) >=
      list.reduce((t, r) => t + (assign.get(r.key) === b ? Math.abs(r.amount) : 0), 0) ? a : b;
    for (const r of zeros) {
      assign.set(r.key, vendorSide.get(r.vendor.toLowerCase()) ?? big);
      rep.resolved++;
    }
  }
  return { assign, groups };
}

/**
 * The subsets of `xs` (as index lists) summing to `target`: up to MAX_SOLUTIONS of them,
 * or null when there are too many partial sums to work it out.
 */
export function subsetsSumming(xs: number[], target: number): number[][] | null {
  // reach[i]: the sums some subset of the first i items makes.
  const reach: Set<number>[] = [new Set([0])];
  for (const x of xs) {
    const prev = reach[reach.length - 1];
    const next = new Set(prev);
    for (const s of prev) next.add(s + x);
    if (next.size > MAX_STATES) return null;
    reach.push(next);
  }
  const out: number[][] = [];
  const walk = (i: number, s: number, chosen: number[]) => {
    if (out.length >= MAX_SOLUTIONS) return;
    if (i === 0) {
      if (s === 0) out.push([...chosen].reverse());
      return;
    }
    const x = xs[i - 1];
    if (reach[i - 1].has(s)) walk(i - 1, s, chosen);
    if (reach[i - 1].has(s - x)) {
      chosen.push(i - 1);
      walk(i - 1, s - x, chosen);
      chosen.pop();
    }
  };
  if (reach[xs.length].has(target)) walk(xs.length, target, []);
  return out;
}
