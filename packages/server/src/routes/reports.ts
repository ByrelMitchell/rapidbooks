import { REPORT_TYPE_LABELS, resolvePreset, todayIso, isIsoDate } from '@rapidbooks/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db';
import { AppError } from '../errors';
import { renderTxnsPdf } from '../pdf/combined';
import { toCsv } from '../reports/engine';
import { find, incomeExpenseGraph, optDate, salesGraph } from '../reports/find';
import { listReports, runReport } from '../reports/registry';

// Phase 5: reports, Find, graphs, and combined form PDFs.

type Q = Record<string, string | undefined>;

const idList = (s: string | undefined, what: string): number[] =>
  s === undefined || s.trim() === ''
    ? []
    : s.split(',').map((x) => {
        const n = Number(x.trim());
        if (!Number.isInteger(n)) throw new AppError(400, `The ${what} list is not a list of ids.`);
        return n;
      });
const optInt = (s: string | undefined, label: string) => {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  if (!Number.isInteger(n)) throw new AppError(400, `${label} must be a whole number.`);
  return n;
};

/** from/to from explicit dates, or from a preset (`date`), or the given default preset. */
function range(q: Q, def: string): { from: string | null; to: string | null; today: string } {
  const today = q.today && isIsoDate(q.today) ? q.today : todayIso();
  if ((q.from ?? '') !== '' || (q.to ?? '') !== '') {
    return { from: optDate(q.from, 'The From date'), to: optDate(q.to, 'The To date'), today };
  }
  const r = resolvePreset(q.date || def, today);
  if (!r) throw new AppError(400, `"${q.date}" is not a date range.`);
  return { ...r, today };
}

export function registerReportRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/reports', () => listReports());

  app.get('/api/reports/:id', (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = req.query as Q;
    const report = runReport(db, id, q);
    if (q.format === 'csv') {
      const name = report.title.replace(/[\\/:*?"<>|]/g, '-');
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}.csv"`)
        .send(toCsv(report));
    }
    return report;
  });

  app.get('/api/find', (req) => {
    const q = req.query as Q;
    const types = (q.types ?? q.type ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => s);
    for (const t of types) if (!REPORT_TYPE_LABELS[t]) throw new AppError(400, `${t} is not a transaction type.`);
    return find(db, {
      types,
      name_id: optInt(q.name_id, 'The name'),
      from: optDate(q.from, 'The From date'),
      to: optDate(q.to, 'The To date'),
      num: q.num && q.num.trim() ? q.num.trim() : null,
      amount: optInt(q.amount, 'The amount (in cents)'),
      amount_min: optInt(q.amount_min, 'The lowest amount (in cents)'),
      amount_max: optInt(q.amount_max, 'The highest amount (in cents)'),
      text: q.text && q.text.trim() ? q.text.trim() : null,
      account_id: optInt(q.account_id, 'The account'),
      item_id: optInt(q.item_id, 'The item'),
      name_kind: q.name_kind ? z.enum(['customer', 'vendor', 'employee', 'other']).parse(q.name_kind) : null,
      status: q.status ? z.enum(['open', 'overdue']).parse(q.status) : null,
      today: optDate(q.today, 'Today'),
      with_open: q.with_open === '1' || q.with_open === 'true',
      limit: optInt(q.limit, 'The limit') ?? 200,
    });
  });

  app.get('/api/graphs/sales', (req) => {
    const q = req.query as Q;
    const by = z.enum(['customer', 'item']).parse(q.by || 'customer');
    return salesGraph(db, {
      ...range(q, 'this_fiscal_year_to_date'),
      by,
      top: optInt(q.top, 'Top') ?? 10,
      name_ids: idList(q.name_ids, 'customer'),
      item_ids: idList(q.item_ids, 'item'),
    });
  });

  app.get('/api/graphs/income-expense', (req) => incomeExpenseGraph(db, range(req.query as Q, 'this_fiscal_year_to_date')));

  app.get('/api/txns/pdf', async (req, reply) => {
    const ids = idList((req.query as Q).ids, 'transaction');
    const pdf = await renderTxnsPdf(db, ids);
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="Forms.pdf"').send(pdf);
  });
}
