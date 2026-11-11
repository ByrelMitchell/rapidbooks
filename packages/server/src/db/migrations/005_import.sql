-- Phase 6: history import from QuickBooks report exports.
--
-- import_locked = 1: the transaction was imported "as posted" from the QuickBooks Journal.
-- Its splits are QuickBooks' own and cannot be reproduced from its header and lines by
-- the form's builder (a paycheck whose payroll items are unknown, an invoice whose item
-- now posts to another account, a QuickBooks type RapidBooks has no form for...). It opens
-- as a journal-style view; saving it through its form is refused, but its splits can be
-- edited as a journal entry (PUT /api/txns/:id with type GENJRNL). import_note says why.
ALTER TABLE txns ADD COLUMN import_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE txns ADD COLUMN import_note   TEXT NOT NULL DEFAULT '';
-- The QuickBooks type name ("Invoice", "Bill Pmt -Check", "Sales Receipt") and Trans #
-- of an imported transaction; '' for transactions entered in RapidBooks.
ALTER TABLE txns ADD COLUMN qb_type       TEXT NOT NULL DEFAULT '';
ALTER TABLE txns ADD COLUMN qb_trans_no   TEXT NOT NULL DEFAULT '';
