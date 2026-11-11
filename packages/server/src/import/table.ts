import { MONTHS, norm, PIVOT_YEAR } from './layout';

// Reading QuickBooks report exports: CSV or tab-delimited text, Windows-1252 or UTF-8,
// with title lines above the header, blank spacer columns and quoted fields that may
// contain the delimiter, quotes ("") and line breaks.

export interface TableRow {
  line: number; // 1-based line of the file where the row starts
  cells: string[];
}

/** Decode a file: UTF-8 (with or without BOM) when valid, UTF-16 with a BOM, else Windows-1252. */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Tab when the first lines have tabs outside quotes, else comma. */
export function detectDelimiter(text: string): ',' | '\t' {
  let tabs = 0;
  let commas = 0;
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 40; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '\t') tabs++;
    else if (!quoted && c === ',') commas++;
    else if (!quoted && c === '\n') lines++;
  }
  return tabs > 0 && tabs * 2 >= commas ? '\t' : ',';
}

/**
 * Split delimited text into rows. A field that starts with a double quote runs to the
 * closing quote ("" inside it is one quote) and may contain delimiters and line breaks.
 * Line ends are CRLF, LF or CR. Fields are not trimmed.
 */
export function tokenize(text: string, delim: string): TableRow[] {
  const rows: TableRow[] = [];
  let row: string[] = [];
  let field = '';
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const n = text.length;
  let atFieldStart = true;

  const endField = () => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRow = () => {
    endField();
    rows.push({ line: rowLine, cells: row });
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (atFieldStart && c === '"') {
      // Quoted field.
      let j = i + 1;
      let closed = false;
      let buf = '';
      let breaks = 0;
      while (j < n) {
        const d = text[j];
        if (d === '"') {
          if (text[j + 1] === '"') {
            buf += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        if (d === '\r') {
          buf += '\n';
          breaks++;
          j += text[j + 1] === '\n' ? 2 : 1;
          continue;
        }
        if (d === '\n') breaks++;
        buf += d;
        j++;
      }
      if (closed) {
        field += buf;
        line += breaks;
        i = j;
        atFieldStart = false;
        continue;
      }
      // An unclosed quote: treat it as an ordinary character.
      field += c;
      i++;
      atFieldStart = false;
      continue;
    }
    if (c === delim) {
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      endRow();
      line++;
      rowLine = line;
      continue;
    }
    field += c;
    atFieldStart = false;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

export const isBlankRow = (cells: string[]) => cells.every((c) => c.trim() === '');

/** Find the columns of a header row: field -> column index (first match wins). */
export function mapHeader<K extends string>(cells: string[], aliases: Record<K, readonly string[]>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  const normed = cells.map(norm);
  for (const key of Object.keys(aliases) as K[]) {
    for (const alias of aliases[key]) {
      const at = normed.indexOf(alias);
      if (at >= 0) {
        out[key] = at;
        break;
      }
    }
  }
  return out;
}

/**
 * Parse an amount to cents: "1,234.56", "$1,234.56", "-1,234.56", "(1,234.56)",
 * "1,234.56-". Blank is null; anything else unreadable is NaN.
 */
export function parseAmount(text: string | undefined): number | null {
  if (text === undefined) return null;
  let s = text.trim().replace(/[$,\s ]/g, '');
  if (s === '') return null;
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1];
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return NaN;
  const frac = (m[2] ?? '').padEnd(3, '0');
  let v = Number(m[1] || '0') * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) v += 1; // more than two decimals: round half away from zero
  return neg && v !== 0 ? -v : v;
}

/**
 * Parse a plain decimal number (quantities, prices): "1,234.5", "(2)", "3-", "12.50%".
 * Returns { value, percent } or null when blank/unreadable.
 */
export function parseNumber(text: string | undefined): { value: number; percent: boolean } | null {
  if (text === undefined) return null;
  let s = text.trim().replace(/[$,\s ]/g, '');
  if (s === '') return null;
  const percent = s.endsWith('%');
  if (percent) s = s.slice(0, -1);
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    neg = true;
    s = paren[1];
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  return { value: neg ? -v : v, percent };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse M/D/YY or M/D/YYYY (also with - or . separators) to ISO; null if blank or invalid. */
export function parseQbDate(text: string | undefined): string | null {
  const t = (text ?? '').trim();
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  let y = Number(m[3]);
  if (m[3].length === 2) y += y < PIVOT_YEAR ? 2000 : 1900;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(mo)}-${pad(d)}`;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? iso : null;
}

/** A period column header of a Profit & Loss export, as an ISO date range; null if not one. */
export function parsePeriodHeader(text: string): { from: string; to: string } | null {
  const t = text.trim().toLowerCase();
  const year = (s: string) => {
    let y = Number(s);
    if (s.length === 2) y += y < PIVOT_YEAR ? 2000 : 1900;
    return y;
  };
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  let m = /^(\d{4})$/.exec(t);
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  // "jan - dec 25", "jan 1 - dec 31, 25", "jan '25 - dec '25"
  m = /^([a-z]{3})[a-z]*\s*(?:\d{1,2})?\s*,?\s*'?(\d{2}|\d{4})?\s*-\s*([a-z]{3})[a-z]*\s*(?:\d{1,2})?\s*,?\s*'?(\d{2}|\d{4})$/.exec(t);
  if (m) {
    const m1 = MONTHS.indexOf(m[1]) + 1;
    const m2 = MONTHS.indexOf(m[3]) + 1;
    if (m1 === 0 || m2 === 0) return null;
    const y2 = year(m[4]);
    const y1 = m[2] ? year(m[2]) : m1 <= m2 ? y2 : y2 - 1;
    return { from: `${y1}-${pad(m1)}-01`, to: `${y2}-${pad(m2)}-${pad(lastDay(y2, m2))}` };
  }
  return null;
}
