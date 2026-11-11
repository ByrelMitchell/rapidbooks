import {
  formatMoney,
  formatUsDate,
  type EmailBatchResult,
  type EmailDraft,
  type EmailTemplates,
  type SendEmailInput,
} from '@rapidbooks/shared';
import nodemailer, { type Transporter } from 'nodemailer';
import type { DB } from '../db';
import { AppError } from '../errors';
import { fullName, nameRow } from '../ledger/common';
import { docFileName, loadSalesDoc, renderSalesDocPdf } from '../pdf/invoice';
import { companyInfo } from '../pdf/layout';
import { loadSmtpConfig } from './config';

// Sending invoices and credit memos by e-mail, with the PDF attached.

export interface Mailer {
  transport: Transporter;
  from: string;
  bccSelf: boolean;
}

/** Makes the mailer when a message is about to be sent; tests inject one with a JSON transport. */
export type MailerFactory = () => Mailer;

/** The real mailer, from the SMTP settings. Throws a message naming the missing setting. */
export const smtpMailer: MailerFactory = () => {
  const r = loadSmtpConfig();
  if (!r.ok) throw new AppError(400, r.missing);
  const c = r.config;
  return {
    transport: nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.password } : undefined,
    }),
    from: c.from,
    bccSelf: c.bcc_self,
  };
};

// Templates, kept in the company table. Placeholders: {num} {date} {due_date} {total}
// {balance} {customer} {contact} {company}.
const TEMPLATE_KEYS: Record<keyof EmailTemplates, string> = {
  invoice_subject: 'email_invoice_subject',
  invoice_body: 'email_invoice_body',
  creditmemo_subject: 'email_creditmemo_subject',
  creditmemo_body: 'email_creditmemo_body',
};

export const DEFAULT_TEMPLATES: EmailTemplates = {
  invoice_subject: 'Invoice {num} from {company}',
  invoice_body:
    'Dear {contact}:\n\nYour invoice {num} for ${total} is attached. Please remit payment at your earliest convenience.\n\nThank you for your business - we appreciate it very much.\n\nSincerely,\n\n{company}',
  creditmemo_subject: 'Credit Memo {num} from {company}',
  creditmemo_body:
    'Dear {contact}:\n\nYour credit memo {num} for ${total} is attached.\n\nThank you for your business - we appreciate it very much.\n\nSincerely,\n\n{company}',
};

export function getEmailTemplates(db: DB): EmailTemplates {
  const get = db.prepare('SELECT value FROM company WHERE key = ?');
  const out = { ...DEFAULT_TEMPLATES };
  for (const [k, key] of Object.entries(TEMPLATE_KEYS) as [keyof EmailTemplates, string][]) {
    const r = get.get(key) as { value: string } | undefined;
    if (r && r.value !== '') out[k] = r.value;
  }
  return out;
}

export function setEmailTemplates(db: DB, t: EmailTemplates) {
  const up = db.prepare(
    'INSERT INTO company (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [k, key] of Object.entries(TEMPLATE_KEYS) as [keyof EmailTemplates, string][]) up.run(key, t[k]);
  })();
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** The proposed To, Subject and Body for e-mailing a document. */
export function emailDraft(db: DB, txnId: number): EmailDraft {
  const t = loadSalesDoc(db, txnId);
  const n = t.name_id !== null ? nameRow(db, t.name_id) : undefined;
  // A job without its own address uses its customer's.
  let to = n?.email ?? '';
  for (let p = n?.parent_id ?? null; !to && p !== null; ) {
    const parent = nameRow(db, p);
    to = parent?.email ?? '';
    p = parent?.parent_id ?? null;
  }
  const company = companyInfo(db);
  const person = n ? [n.salutation, n.first_name, n.last_name].filter((s) => s.trim()).join(' ') : '';
  const vars = {
    num: t.num,
    date: formatUsDate(t.date),
    due_date: t.due_date ? formatUsDate(t.due_date) : '',
    total: formatMoney(t.total),
    balance: formatMoney(t.open_balance ?? t.unapplied ?? 0),
    customer: fullName(db, t.name_id),
    contact: n?.contact || person || n?.company || fullName(db, t.name_id),
    company: company.name,
  };
  const tpl = getEmailTemplates(db);
  const isInvoice = t.type === 'INVOICE';
  return {
    to,
    cc: '',
    subject: fill(isInvoice ? tpl.invoice_subject : tpl.creditmemo_subject, vars),
    body: fill(isInvoice ? tpl.invoice_body : tpl.creditmemo_body, vars),
    attachment_name: docFileName(t),
  };
}

/**
 * Send an invoice (or credit memo) with its PDF attached. On success, records when it
 * was sent and takes it off the To be e-mailed list.
 */
export async function sendInvoiceEmail(
  db: DB,
  req: SendEmailInput,
  mailer: MailerFactory = smtpMailer,
): Promise<{ emailed_at: string; message_id: string }> {
  const t = loadSalesDoc(db, req.txn_id);
  const pdf = await renderSalesDocPdf(db, req.txn_id);
  const m = mailer();
  const info = await m.transport.sendMail({
    from: m.from,
    to: req.to,
    cc: req.cc.trim() || undefined,
    bcc: m.bccSelf ? m.from : undefined,
    subject: req.subject,
    text: req.body,
    attachments: [{ filename: docFileName(t), content: pdf, contentType: 'application/pdf' }],
  });
  db.prepare("UPDATE txns SET emailed_at = datetime('now'), to_email = 0 WHERE id = ?").run(t.id);
  const at = (db.prepare('SELECT emailed_at FROM txns WHERE id = ?').get(t.id) as { emailed_at: string }).emailed_at;
  db.prepare('INSERT INTO audit_log (action, txn_id, detail) VALUES (?, ?, ?)').run(
    'email',
    t.id,
    JSON.stringify({ to: req.to, cc: req.cc, subject: req.subject }),
  );
  return { emailed_at: at, message_id: String((info as { messageId?: string }).messageId ?? '') };
}

/** Send several documents with their default To/Subject/Body; report each one's outcome. */
export async function sendEmailBatch(
  db: DB,
  txnIds: number[],
  mailer: MailerFactory = smtpMailer,
): Promise<EmailBatchResult[]> {
  // Fail the whole batch at once when e-mail is not set up at all.
  const m = mailer();
  const once: MailerFactory = () => m;
  const out: EmailBatchResult[] = [];
  for (const id of txnIds) {
    let num = '';
    try {
      num = loadSalesDoc(db, id).num;
      const d = emailDraft(db, id);
      if (!d.to.trim()) throw new AppError(400, `${fullName(db, loadSalesDoc(db, id).name_id)} has no e-mail address.`);
      await sendInvoiceEmail(db, { txn_id: id, to: d.to, cc: d.cc, subject: d.subject, body: d.body }, once);
      out.push({ txn_id: id, num, ok: true, error: null });
    } catch (e) {
      out.push({ txn_id: id, num, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
