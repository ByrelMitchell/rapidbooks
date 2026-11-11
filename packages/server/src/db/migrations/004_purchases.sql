-- Phase 4: purchases and banking (purchase orders, bills, bill credits, bill payments,
-- checks, transfers, paychecks).

-- The purchase side of an item. cost is cents and may carry fractions of a cent, like rate.
ALTER TABLE items ADD COLUMN purchase_description TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN cost                 REAL NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN purchase_account_id  INTEGER REFERENCES accounts(id);

-- Header fields of the new documents. Reused from 003: num (P.O. no., check no., a bill's
-- ref no.), bill_addr (vendor/payee address), ship_addr (P.O. ship to), message (P.O.
-- vendor message), terms_id/due_date (bills), to_print (checks), pay_method ('check' or
-- 'other' on bill payments), ref_no (bills), account_id (the bank account of a check,
-- bill payment or paycheck; the from account of a transfer), total.
ALTER TABLE txns ADD COLUMN ap_account_id INTEGER REFERENCES accounts(id); -- bills, bill credits, bill payments
ALTER TABLE txns ADD COLUMN to_account_id INTEGER REFERENCES accounts(id); -- transfers
ALTER TABLE txns ADD COLUMN expected_date TEXT NOT NULL DEFAULT '';        -- purchase orders
ALTER TABLE txns ADD COLUMN closed        INTEGER NOT NULL DEFAULT 0;      -- purchase orders
ALTER TABLE txns ADD COLUMN period_from   TEXT NOT NULL DEFAULT '';        -- paychecks
ALTER TABLE txns ADD COLUMN period_to     TEXT NOT NULL DEFAULT '';
CREATE INDEX txns_account ON txns (account_id);

-- Manual payroll: what each line of a paycheck is and where it posts.
--   earning:   Dr expense
--   deduction: Cr liability (withheld from net pay)
--   company:   Dr expense, Cr liability (employer-paid; not in net pay)
CREATE TABLE payroll_items (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('earning', 'deduction', 'company')),
  expense_account_id   INTEGER REFERENCES accounts(id),
  liability_account_id INTEGER REFERENCES accounts(id),
  inactive             INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX payroll_items_name ON payroll_items (name COLLATE NOCASE);

-- Line detail. Expense lines: account_id, amount, description (memo), name_id (customer:job).
-- Item lines: item_id, description, qty, rate (cost), amount, name_id, account_id (where
-- it posted). Paycheck lines: payroll_item_id, qty (hours), rate, amount.
ALTER TABLE lines ADD COLUMN payroll_item_id INTEGER REFERENCES payroll_items(id);
CREATE INDEX lines_payroll_item ON lines (payroll_item_id);

-- links gains a third kind:
--   apply: also bill payment or bill credit (from) -> bill (to), as for invoices.
--   po:    bill (from) -> purchase order (to) received on it.
-- SQLite cannot change a CHECK constraint, so the table is rebuilt (nothing refers to it).
CREATE TABLE links_new (
  id                  INTEGER PRIMARY KEY,
  from_txn            INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  to_txn              INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('apply', 'deposit', 'po')),
  amount              INTEGER NOT NULL DEFAULT 0,
  discount            INTEGER NOT NULL DEFAULT 0,
  discount_account_id INTEGER REFERENCES accounts(id)
);
INSERT INTO links_new (id, from_txn, to_txn, kind, amount, discount, discount_account_id)
  SELECT id, from_txn, to_txn, kind, amount, discount, discount_account_id FROM links;
DROP TABLE links;
ALTER TABLE links_new RENAME TO links;
CREATE INDEX links_from ON links (from_txn);
CREATE INDEX links_to ON links (to_txn);
CREATE UNIQUE INDEX links_one_deposit ON links (to_txn) WHERE kind = 'deposit';
