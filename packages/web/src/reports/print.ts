// Printing one window (a report or a graph) with window.print(): the print stylesheet in
// reports.css hides everything except the window marked `rb-print-target`, and only while
// <body> carries `rb-printing`, so the browser's own Ctrl+P elsewhere is unaffected.

let cleanup: (() => void) | null = null;

/** Print the window that contains `el`. `landscape` adds an @page hint for wide reports. */
export function printWindowOf(el: HTMLElement | null, opts: { landscape?: boolean } = {}) {
  const win = el?.closest('.win');
  if (!(win instanceof HTMLElement)) return;
  cleanup?.();
  const style = document.createElement('style');
  style.textContent = `@media print { @page { size: ${opts.landscape ? 'letter landscape' : 'letter portrait'}; margin: 0.5in; } }`;
  document.head.appendChild(style);
  document.body.classList.add('rb-printing');
  win.classList.add('rb-print-target');
  const done = () => {
    document.body.classList.remove('rb-printing');
    win.classList.remove('rb-print-target');
    style.remove();
    window.removeEventListener('afterprint', done);
    cleanup = null;
  };
  cleanup = done;
  window.addEventListener('afterprint', done);
  window.print();
}
