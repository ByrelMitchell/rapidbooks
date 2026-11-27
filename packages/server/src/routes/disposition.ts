/**
 * A Content-Disposition header for a file name that may hold any character. Node refuses
 * a header with characters outside Latin-1 (a customer named O’Brien, an em dash in a
 * report title), so the name goes twice (RFC 6266): `filename` with a plain ASCII
 * version for old browsers, and `filename*` with the real name, UTF-8 percent-encoded.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const whole = name.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  const ascii = whole
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/["\\]/g, '')
    .replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(whole).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
