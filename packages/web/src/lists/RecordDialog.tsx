import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { errorMessage } from '../api';
import { settleQuickFill } from '../controls/Combo';
import { useDesktop, useWindowCommands } from '../shell/desktop';
import { commitActiveField, focusables, refocus, useLiveState } from '../util';

interface Options<F> {
  winId: string;
  /** props.id: the record to edit, or null for a new one. */
  id: number | null;
  /** The form for a new record when the window opens (with any Set Up presets). */
  initial: () => F;
  /** The form for "Next" after saving `prev` (normally blank; a job keeps its customer). */
  blank: (prev: F) => F;
  load: (id: number) => Promise<F>;
  /** A message to show instead of saving, or null. */
  validate?: (f: F) => string | null;
  /** Save, returning the record's id (POST when id is null, else PUT). */
  save: (f: F, id: number | null) => Promise<number>;
  titles: { new: string; edit: string };
  savedMessage: (f: F) => string;
  /** "Next" from a window opened on an existing record: open a fresh New window instead. */
  openNew: () => void;
}

/**
 * State and behaviour shared by the list edit dialogs: load, save (OK), save and start
 * another (Next), errors shown in the dialog, Quick Add boxes awaited before saving,
 * "discard changes?" on Esc, and the dialog's result for openForResult (the saved id).
 */
export function useRecordDialog<F>(o: Options<F>) {
  const desk = useDesktop();
  const [form, setForm, formRef] = useLiveState<F>(o.initial);
  const [recId, setRecId, recIdRef] = useLiveState<number | null>(o.id);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(o.id !== null);
  const snapshot = useRef(JSON.stringify(form));
  const busy = useRef(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const focusFirst = useRef(false);

  const title = recId === null ? o.titles.new : o.titles.edit;
  useEffect(() => {
    desk.setTitle(o.winId, title);
  }, [o.winId, title]);

  useEffect(() => {
    if (o.id === null) return;
    let cancelled = false;
    o.load(o.id).then(
      (f) => {
        if (cancelled) return;
        setForm(f);
        snapshot.current = JSON.stringify(f);
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [o.id]);

  useLayoutEffect(() => {
    if (!focusFirst.current) return;
    focusFirst.current = false;
    focusables(rootRef.current)[0]?.focus();
  });

  const update = (patch: Partial<F>) => {
    setError(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const submit = async (next: boolean) => {
    if (busy.current || loading) return;
    busy.current = true;
    try {
      const field = commitActiveField();
      // A name typed into a QuickFill field that is not on the list: wait for Quick Add / Set Up.
      if (!(await settleQuickFill())) return;
      const f = formRef.current;
      const problem = o.validate?.(f) ?? null;
      if (problem) {
        setError(problem);
        refocus(field);
        return;
      }
      let id: number;
      try {
        id = await o.save(f, recIdRef.current);
      } catch (e) {
        setError(errorMessage(e));
        refocus(field);
        return;
      }
      desk.resolveWindow(o.winId, id);
      desk.refresh();
      desk.setStatus(o.savedMessage(f));
      setError(null);
      if (!next) {
        desk.close(o.winId);
      } else if (o.id !== null) {
        desk.close(o.winId);
        o.openNew();
      } else {
        const b = o.blank(f);
        setForm(b);
        snapshot.current = JSON.stringify(b);
        setRecId(null);
        focusFirst.current = true;
      }
    } finally {
      busy.current = false;
    }
  };

  const confirmClose = async () => {
    const field = commitActiveField({ quiet: true });
    if (loading || JSON.stringify(formRef.current) === snapshot.current) return true;
    if (await desk.confirm('You have changed this record. Do you want to discard your changes?', { defaultNo: true }))
      return true;
    refocus(field);
    return false;
  };

  useWindowCommands(o.winId, {
    save: () => void submit(false),
    saveClose: () => void submit(false),
    saveNew: () => void submit(true),
    confirmClose,
  });

  return { form, setForm, formRef, update, error, setError, loading, recId, submit, rootRef };
}

interface DialogState {
  error: string | null;
  loading: boolean;
  submit: (next: boolean) => Promise<void>;
  rootRef: RefObject<HTMLFormElement | null>;
}

/**
 * The dialog frame: error strip, the fields, and the QuickBooks button column on the right
 * (OK, Cancel, Next, then the "is inactive" box). Enter is OK except in multi-line boxes.
 */
export function RecordDialogFrame({
  dlg,
  winId,
  inactive,
  children,
  bottom,
  className,
  onKeyDown,
}: {
  dlg: DialogState;
  winId: string;
  /** The "… is inactive" checkbox, shown under the buttons (or at the bottom left). */
  inactive?: ReactNode;
  children: ReactNode;
  /**
   * QuickBooks 2013's New Customer / New Vendor: the "is inactive" box at the bottom left and
   * OK, Cancel, Help along the bottom right (no Next button; Alt+N is left to the window).
   */
  bottom?: boolean;
  className?: string;
  /** Window keys handled before Enter = OK (e.g. Alt+letter tabs); call preventDefault to take a key. */
  onKeyDown?: (e: KeyboardEvent<HTMLFormElement>) => void;
}) {
  const desk = useDesktop();
  const cancel = (
    <button
      type="button"
      className="btn"
      // Cancel by mouse must not first leave the field (which could ask to Quick Add).
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => desk.close(winId)}
    >
      Cancel
    </button>
  );
  return (
    <form
      ref={dlg.rootRef}
      className={`dialog rec-dialog${bottom ? ' rec-bottom' : ''}${className ? ` ${className}` : ''}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void dlg.submit(false);
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        const t = e.target as HTMLElement;
        if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
        if (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA') return;
        e.preventDefault();
        void dlg.submit(false);
      }}
    >
      {dlg.error && <div className="msg-strip error">{dlg.error}</div>}
      {dlg.loading ? (
        <div className="rec-loading">Loading...</div>
      ) : bottom ? (
        <>
          {children}
          <div className="rec-foot">
            <div className="rec-inactive">{inactive}</div>
            <button type="submit" className="btn default">
              OK
            </button>
            {cancel}
            <button type="button" className="btn" onClick={() => desk.open('keys')} title="Keyboard shortcuts">
              Help
            </button>
          </div>
        </>
      ) : (
        <div className="rec-body">
          <div className="rec-fields">{children}</div>
          <div className="rec-side">
            <button type="submit" className="btn default">
              OK
            </button>
            {cancel}
            <button type="button" className="btn" onClick={() => void dlg.submit(true)} title="Alt+N">
              <u>N</u>ext
            </button>
            {inactive && <div className="rec-inactive">{inactive}</div>}
          </div>
        </div>
      )}
    </form>
  );
}
