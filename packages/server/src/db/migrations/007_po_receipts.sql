-- Receiving part of a purchase order: a bill's item line can say which purchase order line
-- it receives (the P.O. and that line's seq). What a P.O. line has received is the sum of the
-- bill lines that point at it; the P.O. closes when every item line is received in full.
-- Bills from before this point at no line: their P.O.s count as received in full, as then.
ALTER TABLE lines ADD COLUMN po_txn_id INTEGER REFERENCES txns(id) ON DELETE SET NULL;
ALTER TABLE lines ADD COLUMN po_seq    INTEGER;
CREATE INDEX lines_po ON lines (po_txn_id, po_seq);
