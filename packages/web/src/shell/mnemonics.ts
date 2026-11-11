import { parseMnemonic } from '../util';

/**
 * Menu labels with mnemonics chosen automatically, never two alike in one menu.
 * A plain string is raw text (any "&" in it is shown literally) and gets a mnemonic:
 * the first letter of a word that is still free, else any free letter or digit.
 * `{ label }` is already written with "&" and keeps its own mnemonic (reserved first).
 */
export function assignMnemonics(entries: (string | { label: string })[]): string[] {
  const used = new Set<string>();
  for (const e of entries) {
    if (typeof e !== 'string') {
      const k = parseMnemonic(e.label).key;
      if (k) used.add(k);
    }
  }
  return entries.map((e) => {
    if (typeof e !== 'string') return e.label;
    const text = e;
    const alnum = (c: string) => /[a-z0-9]/i.test(c);
    const wordStarts: number[] = [];
    const others: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (!alnum(text[i])) continue;
      if (i === 0 || !alnum(text[i - 1])) wordStarts.push(i);
      else others.push(i);
    }
    const at = [...wordStarts, ...others].find((i) => !used.has(text[i].toLowerCase()));
    if (at !== undefined) used.add(text[at].toLowerCase());
    let out = '';
    for (let i = 0; i < text.length; i++) {
      if (i === at) out += '&';
      out += text[i] === '&' ? '&&' : text[i];
    }
    return out;
  });
}
