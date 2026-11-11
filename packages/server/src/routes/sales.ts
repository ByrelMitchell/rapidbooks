import {
  ApplyCreditsInput,
  AssessFinanceChargesInput,
  EmailTemplates,
  FinanceChargeSettings,
  isIsoDate,
  SendEmailInput,
} from '@rapidbooks/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db';
import { assessFinanceCharges, getFinanceChargeSettings, previewFinanceCharges, setFinanceChargeSettings } from '../ledger/finance';
import { removeApplication } from '../ledger/posting';
import {
  adjacentTxns,
  applyCredits,
  findTxns,
  listCredits,
  listOpenInvoices,
  listPendingPayments,
  listToEmail,
  listToPrint,
} from '../ledger/receivables';
import { getStatement, listStatementCustomers } from '../ledger/statements';
import { loadSmtpConfig } from '../mail/config';
import {
  emailDraft,
  getEmailTemplates,
  sendEmailBatch,
  sendInvoiceEmail,
  setEmailTemplates,
  smtpMailer,
  type MailerFactory,
} from '../mail/send';
import { isPurchasePrintable, loadPurchasePrintable, purchaseFileName, renderPurchasePdf } from '../pdf/check';
import { docFileName, loadSalesDoc, renderSalesDocPdf } from '../pdf/invoice';
import { renderStatementPdf } from '../pdf/statement';

const Id = z.object({ id: z.coerce.number().int() });
const DateQ = z.string().refine(isIsoDate, { message: 'Enter a valid date.' });
const OptId = z.preprocess((v) => (v === undefined || v === '' ? null : v), z.coerce.number().int().nullable());
const StatementQ = z.object({ customer_id: z.coerce.number().int(), from: DateQ, to: DateQ });

const pdfName = (name: string) => `inline; filename="${name.replace(/"/g, '')}"`;

/** Routes for Phase 3: sales and receivables. */
export function registerSalesRoutes(app: FastifyInstance, db: DB, mailer: MailerFactory = smtpMailer) {
  // Transactions: lookups for the forms
  app.get('/api/txns/adjacent', (req) => {
    const q = z.object({ type: z.string(), id: OptId }).parse(req.query);
    return adjacentTxns(db, q.type, q.id);
  });
  app.get('/api/txns/find', (req) => {
    const q = z.object({ type: z.string(), num: z.string() }).parse(req.query);
    return findTxns(db, q.type, q.num);
  });
  app.get('/api/txns/:id/pdf', async (req, reply) => {
    const id = Id.parse(req.params).id;
    // Purchase orders and check records (Phase 4) print from pdf/check.ts.
    const type = (db.prepare('SELECT type FROM txns WHERE id = ?').get(id) as { type: string } | undefined)?.type;
    if (type && isPurchasePrintable(type)) {
      const p = loadPurchasePrintable(db, id);
      const pdf = await renderPurchasePdf(db, id);
      return reply.type('application/pdf').header('Content-Disposition', pdfName(purchaseFileName(p))).send(pdf);
    }
    const t = loadSalesDoc(db, id);
    const pdf = await renderSalesDocPdf(db, id);
    return reply.type('application/pdf').header('Content-Disposition', pdfName(docFileName(t))).send(pdf);
  });

  // Customers: open invoices and credits
  app.get('/api/customers/:id/open-invoices', (req) => {
    const q = z.object({ payment_id: OptId }).parse(req.query);
    return listOpenInvoices(db, Id.parse(req.params).id, q.payment_id);
  });
  app.get('/api/customers/:id/credits', (req) => listCredits(db, Id.parse(req.params).id));
  app.post('/api/credits/apply', (req) => {
    applyCredits(db, ApplyCreditsInput.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/links/:id', (req) => {
    removeApplication(db, Id.parse(req.params).id);
    return { ok: true };
  });

  // Queues
  app.get('/api/invoices/to-print', () => listToPrint(db));
  app.get('/api/invoices/to-email', () => listToEmail(db));

  // Deposits
  app.get('/api/deposits/pending', (req) => {
    const q = z.object({ deposit_id: OptId }).parse(req.query);
    return listPendingPayments(db, q.deposit_id);
  });

  // Finance charges
  app.get('/api/finance-charges/settings', () => getFinanceChargeSettings(db));
  app.put('/api/finance-charges/settings', (req) => {
    setFinanceChargeSettings(db, FinanceChargeSettings.parse(req.body));
    return { ok: true };
  });
  app.get('/api/finance-charges/preview', (req) =>
    previewFinanceCharges(db, z.object({ as_of: DateQ }).parse(req.query).as_of),
  );
  app.post('/api/finance-charges/assess', (req) => {
    const b = AssessFinanceChargesInput.parse(req.body);
    return { ids: assessFinanceCharges(db, b.as_of, b.customer_ids) };
  });

  // Statements
  app.get('/api/statements', (req) => {
    const q = StatementQ.parse(req.query);
    return getStatement(db, q.customer_id, q.from, q.to);
  });
  app.get('/api/statements/customers', (req) => {
    const q = z.object({ from: DateQ, to: DateQ }).parse(req.query);
    return listStatementCustomers(db, q.from, q.to);
  });
  app.get('/api/statements/pdf', async (req, reply) => {
    const q = StatementQ.parse(req.query);
    const pdf = await renderStatementPdf(db, q.customer_id, q.from, q.to);
    const s = customerFileName(db, q.customer_id);
    return reply.type('application/pdf').header('Content-Disposition', pdfName(`Statement ${s}.pdf`)).send(pdf);
  });

  // E-mail
  app.get('/api/email/status', () => {
    const r = loadSmtpConfig();
    return r.ok ? { configured: true, message: null } : { configured: false, message: r.missing };
  });
  app.get('/api/email/templates', () => getEmailTemplates(db));
  app.put('/api/email/templates', (req) => {
    setEmailTemplates(db, EmailTemplates.parse(req.body));
    return { ok: true };
  });
  app.get('/api/email/defaults/:id', (req) => emailDraft(db, Id.parse(req.params).id));
  app.post('/api/email/send', async (req) => {
    const r = await sendInvoiceEmail(db, SendEmailInput.parse(req.body), mailer);
    return { ok: true, emailed_at: r.emailed_at };
  });
  app.post('/api/email/batch', async (req) => {
    const b = z.object({ txn_ids: z.array(z.number().int()).min(1, 'Choose at least one form to send.') }).parse(req.body);
    return sendEmailBatch(db, b.txn_ids, mailer);
  });
}

function customerFileName(db: DB, customerId: number): string {
  const r = db.prepare('SELECT name FROM names WHERE id = ?').get(customerId) as { name: string } | undefined;
  return (r?.name ?? 'Customer').replace(/[\\/:*?"<>|]/g, '-');
}
