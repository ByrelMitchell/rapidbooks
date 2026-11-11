-- Phase 3: sales and receivables (invoices, credit memos, payments, deposits,
-- finance charges). Document header fields live on txns; line detail in `lines`;
-- payment/credit applications and deposits in `links`.
--
-- Note: items.rate (from 002) now also holds fractions of a cent (3.75 = $0.0375).
-- SQLite keeps such values as REAL despite the column's INTEGER affinity.

ALTER TABLE txns ADD COLUMN terms_id          INTEGER REFERENCES terms(id);
ALTER TABLE txns ADD COLUMN due_date          TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN po_number         TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN ship_date         TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN ship_via          TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN bill_addr         TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN ship_addr         TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN message           TEXT NOT NULL DEFAULT ''; -- customer message
ALTER TABLE txns ADD COLUMN to_print          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE txns ADD COLUMN to_email          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE txns ADD COLUMN emailed_at        TEXT; -- UTC, datetime('now') format
ALTER TABLE txns ADD COLUMN pay_method        TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN ref_no            TEXT NOT NULL DEFAULT ''; -- payments: check number
-- The header account: payments deposit to it; deposits go into it (the bank).
ALTER TABLE txns ADD COLUMN account_id        INTEGER REFERENCES accounts(id);
-- The receivable account of an invoice, credit memo or payment.
ALTER TABLE txns ADD COLUMN ar_account_id     INTEGER REFERENCES accounts(id);
ALTER TABLE txns ADD COLUMN is_finance_charge INTEGER NOT NULL DEFAULT 0;
-- Cents: invoice/credit memo total, payment amount, deposit total. Written by the
-- posting engine with the splits; open balances are never stored (see links).
ALTER TABLE txns ADD COLUMN total             INTEGER NOT NULL DEFAULT 0;

CREATE INDEX txns_type_date ON txns (type, date);

-- Document lines. qty and rate are REAL: rate is cents and may carry fractions of a
-- cent (piece prices), or basis points when rate_is_percent = 1. amount is integer cents.
CREATE TABLE lines (
  id              INTEGER PRIMARY KEY,
  txn_id          INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  item_id         INTEGER REFERENCES items(id),
  description     TEXT NOT NULL DEFAULT '',
  qty             REAL,
  rate            REAL,
  rate_is_percent INTEGER NOT NULL DEFAULT 0,
  amount          INTEGER NOT NULL DEFAULT 0,
  -- deposit lines (and item-less account lines such as finance charges)
  account_id      INTEGER REFERENCES accounts(id),
  name_id         INTEGER REFERENCES names(id),
  ref_no          TEXT NOT NULL DEFAULT '',
  pay_method      TEXT NOT NULL DEFAULT '',
  UNIQUE (txn_id, seq)
);
CREATE INDEX lines_item ON lines (item_id);

-- apply:   payment or credit memo (from) -> invoice (to). amount is what the payment
--          or credit gives; discount is an early-payment discount taken on the invoice
--          (payments only; posted by the payment). The invoice's open balance is its
--          total less amount + discount of every link to it.
-- deposit: deposit (from) -> payment (to), amount = the payment's amount.
CREATE TABLE links (
  id                  INTEGER PRIMARY KEY,
  from_txn            INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  to_txn              INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('apply', 'deposit')),
  amount              INTEGER NOT NULL DEFAULT 0,
  discount            INTEGER NOT NULL DEFAULT 0,
  discount_account_id INTEGER REFERENCES accounts(id)
);
CREATE INDEX links_from ON links (from_txn);
CREATE INDEX links_to ON links (to_txn);
-- A payment can be in at most one deposit.
CREATE UNIQUE INDEX links_one_deposit ON links (to_txn) WHERE kind = 'deposit';

-- Existing journal entries: total = the sum of their debits.
UPDATE txns SET total = COALESCE((SELECT SUM(amount) FROM splits s WHERE s.txn_id = txns.id AND s.amount > 0), 0);
