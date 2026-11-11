CREATE TABLE accounts (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES accounts(id),
  description TEXT NOT NULL DEFAULT '',
  inactive    INTEGER NOT NULL DEFAULT 0,
  -- Accounts the program itself posts to: AR, AP, UNDEPOSITED, OPENING_EQUITY, RETAINED
  system_role TEXT UNIQUE
);
CREATE UNIQUE INDEX accounts_name ON accounts (COALESCE(parent_id, 0), name COLLATE NOCASE);

-- Customers (and their jobs), vendors, employees and other names share one table,
-- as they share one name space in QuickBooks.
CREATE TABLE names (
  id        INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('customer', 'vendor', 'employee', 'other')),
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES names(id),
  company   TEXT NOT NULL DEFAULT '',
  contact   TEXT NOT NULL DEFAULT '',
  phone     TEXT NOT NULL DEFAULT '',
  fax       TEXT NOT NULL DEFAULT '',
  email     TEXT NOT NULL DEFAULT '',
  bill_addr TEXT NOT NULL DEFAULT '',
  ship_addr TEXT NOT NULL DEFAULT '',
  notes     TEXT NOT NULL DEFAULT '',
  picks_up  INTEGER NOT NULL DEFAULT 0, -- customer collects; left out of trip reports
  inactive  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX names_name ON names (COALESCE(parent_id, 0), name COLLATE NOCASE);

CREATE TABLE txns (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  num        TEXT NOT NULL DEFAULT '',
  name_id    INTEGER REFERENCES names(id),
  memo       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX txns_date ON txns (date);
CREATE INDEX txns_type_num ON txns (type, num);

-- amount is integer cents; positive = debit, negative = credit.
-- The splits of a transaction always sum to zero (enforced in ledger/posting.ts,
-- the only code that writes this table).
CREATE TABLE splits (
  id         INTEGER PRIMARY KEY,
  txn_id     INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount     INTEGER NOT NULL,
  name_id    INTEGER REFERENCES names(id),
  memo       TEXT NOT NULL DEFAULT '',
  cleared    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (txn_id, seq)
);
CREATE INDEX splits_account ON splits (account_id);

CREATE TABLE company (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  txn_id INTEGER,
  detail TEXT NOT NULL DEFAULT ''
);
