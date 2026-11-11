// Dates are ISO strings (YYYY-MM-DD) everywhere except on screen, where they are MM/DD/YYYY.

const pad = (n: number) => n.toString().padStart(2, '0');

function toParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
}

function fromUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function make(y: number, m: number, d: number): string {
  return fromUtc(new Date(Date.UTC(y, m - 1, d)));
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = toParts(s);
  return make(y, m, d) === s;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = toParts(iso);
  return make(y, m, d + n);
}

export function formatUsDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = toParts(iso);
  return `${pad(m)}/${pad(d)}/${y}`;
}

/** Parse what a person types: 3/7, 3/7/03, 03/07/2003, 030703, 03072003. */
export function parseUsDate(text: string, today: string = todayIso()): string | null {
  const t = text.trim();
  let m: number, d: number, y: number | undefined;
  const sep = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(t);
  const packed = /^(\d{2})(\d{2})(\d{2}|\d{4})?$/.exec(t);
  const hit = sep ?? packed;
  if (!hit) return null;
  m = Number(hit[1]);
  d = Number(hit[2]);
  if (hit[3] !== undefined) {
    y = Number(hit[3]);
    if (hit[3].length === 2) y += y < 70 ? 2000 : 1900;
  } else {
    y = toParts(today)[0];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * QuickBooks date-field keys. Returns the new date, or null if the key isn't a date key.
 *   +  next day        -  previous day      T  today
 *   W  first of week   K  last of week
 *   M  first of month  H  last of month
 *   Y  first of year   R  last of year
 * Pressing W/M/Y again steps back a period; K/H/R again steps forward.
 */
export function applyDateKey(iso: string, key: string, today: string = todayIso()): string | null {
  const base = isIsoDate(iso) ? iso : today;
  const [y, m, d] = toParts(base);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  switch (key.toLowerCase()) {
    case '+':
    case '=':
      return addDays(base, 1);
    case '-':
    case '_':
      return addDays(base, -1);
    case 't':
      return today;
    case 'w':
      return dow === 0 ? addDays(base, -7) : addDays(base, -dow);
    case 'k':
      return dow === 6 ? addDays(base, 7) : addDays(base, 6 - dow);
    case 'm':
      return d === 1 ? make(y, m - 1, 1) : make(y, m, 1);
    case 'h': {
      const last = make(y, m + 1, 0);
      return base === last ? make(y, m + 2, 0) : last;
    }
    case 'y':
      return m === 1 && d === 1 ? make(y - 1, 1, 1) : make(y, 1, 1);
    case 'r':
      return m === 12 && d === 31 ? make(y + 1, 12, 31) : make(y, 12, 31);
    default:
      return null;
  }
}

/** The due date for a document dated `iso` under the given terms (no terms: due the same day). */
export function dueDate(terms: { net_days: number } | null, iso: string): string {
  return terms ? addDays(iso, terms.net_days) : iso;
}
