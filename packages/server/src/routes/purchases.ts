import { AssignCheckNumbersInput, isIsoDate, PayBillsInput, PayrollItemInput } from '@rapidbooks/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db';
import {
  assignCheckNumbers,
  checkNumUse,
  lastPaycheck,
  listChecksToPrint,
  listOpenPurchaseOrders,
  listUnpaidBills,
  listVendorCredits,
  payBills,
  payrollSummary,
} from '../ledger/payables';
import { createPayrollItem, deletePayrollItem, getPayrollItem, listPayrollItems, updatePayrollItem } from '../lists/payroll';

const Id = z.object({ id: z.coerce.number().int() });
const DateQ = z.string().refine(isIsoDate, { message: 'Enter a valid date.' });
const blank = (v: unknown) => (v === undefined || v === '' ? null : v);
const OptId = z.preprocess(blank, z.coerce.number().int().nullable());
const OptDate = z.preprocess(blank, DateQ.nullable());

/** Routes for Phase 4: purchases and banking (the transactions themselves go through /api/txns). */
export function registerPurchaseRoutes(app: FastifyInstance, db: DB) {
  // Purchase orders
  app.get('/api/purchase-orders/open', (req) => listOpenPurchaseOrders(db, z.object({ vendor_id: OptId }).parse(req.query).vendor_id));

  // Bills and Pay Bills
  app.get('/api/bills/unpaid', (req) => {
    const q = z
      .object({
        due_on_or_before: OptDate,
        vendor_id: OptId,
        sort: z.enum(['due_date', 'vendor']).default('due_date'),
        pay_date: OptDate,
        payment_id: OptId,
      })
      .parse(req.query);
    return listUnpaidBills(db, q);
  });
  app.get('/api/vendors/:id/credits', (req) => listVendorCredits(db, Id.parse(req.params).id));
  app.post('/api/pay-bills', (req) => payBills(db, PayBillsInput.parse(req.body)));

  // Checks: duplicate numbers, the print queue, assigning numbers
  app.get('/api/checks/num-used', (req) => {
    const q = z.object({ account_id: z.coerce.number().int(), num: z.string(), exclude_id: OptId }).parse(req.query);
    return checkNumUse(db, q.account_id, q.num, q.exclude_id);
  });
  app.get('/api/checks/to-print', (req) => listChecksToPrint(db, z.object({ account_id: OptId }).parse(req.query).account_id));
  app.post('/api/checks/assign-numbers', (req) => ({ assigned: assignCheckNumbers(db, AssignCheckNumbersInput.parse(req.body)) }));

  // Payroll
  app.get('/api/payroll-items', () => listPayrollItems(db));
  app.get('/api/payroll-items/:id', (req) => getPayrollItem(db, Id.parse(req.params).id));
  app.post('/api/payroll-items', (req) => ({ id: createPayrollItem(db, PayrollItemInput.parse(req.body)) }));
  app.put('/api/payroll-items/:id', (req) => {
    updatePayrollItem(db, Id.parse(req.params).id, PayrollItemInput.parse(req.body));
    return { ok: true };
  });
  app.delete('/api/payroll-items/:id', (req) => {
    deletePayrollItem(db, Id.parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/employees/:id/last-paycheck', (req) => ({ paycheck: lastPaycheck(db, Id.parse(req.params).id) }));
  app.get('/api/payroll/summary', (req) => {
    const q = z.object({ from: DateQ, to: DateQ, employee_id: OptId }).parse(req.query);
    return payrollSummary(db, q.from, q.to, q.employee_id);
  });
}
