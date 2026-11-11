-- Phase 2: lists (terms, more name fields, items).

-- discount_pct is in basis points (2% = 200).
CREATE TABLE terms (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  net_days      INTEGER NOT NULL DEFAULT 0,
  discount_pct  INTEGER NOT NULL DEFAULT 0,
  discount_days INTEGER NOT NULL DEFAULT 0,
  inactive      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX terms_name ON terms (name COLLATE NOCASE);

ALTER TABLE names ADD COLUMN terms_id     INTEGER REFERENCES terms(id);
ALTER TABLE names ADD COLUMN salutation   TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN first_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN middle_init  TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN last_name    TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN alt_contact  TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN alt_phone    TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN account_no   TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN credit_limit INTEGER; -- cents; NULL = no limit
-- vendors
ALTER TABLE names ADD COLUMN print_as     TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN tax_id       TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN is_1099      INTEGER NOT NULL DEFAULT 0;
-- employees
ALTER TABLE names ADD COLUMN ssn          TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN hire_date    TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN release_date TEXT NOT NULL DEFAULT '';

CREATE INDEX names_parent ON names (parent_id);
CREATE INDEX splits_name ON splits (name_id);
CREATE INDEX txns_name ON txns (name_id);

-- rate is cents, or basis points when rate_is_percent = 1.
CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  parent_id       INTEGER REFERENCES items(id),
  type            TEXT NOT NULL CHECK (type IN ('SERVICE', 'PART', 'OTHER_CHARGE', 'SUBTOTAL', 'DISCOUNT', 'GROUP')),
  description     TEXT NOT NULL DEFAULT '',
  rate            INTEGER NOT NULL DEFAULT 0,
  rate_is_percent INTEGER NOT NULL DEFAULT 0,
  account_id      INTEGER REFERENCES accounts(id),
  inactive        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX items_name ON items (COALESCE(parent_id, 0), name COLLATE NOCASE);

CREATE TABLE item_group_members (
  group_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES items(id),
  qty      REAL NOT NULL DEFAULT 1,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (group_id, seq)
);
CREATE INDEX item_group_members_item ON item_group_members (item_id);
