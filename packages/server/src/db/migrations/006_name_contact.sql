-- QuickBooks 2013's New Customer / New Vendor windows: Job Title, and the contact boxes
-- Mobile, CC Email, Website and Other 1 beside Main Phone, Work Phone, Fax and Main Email.
ALTER TABLE names ADD COLUMN job_title TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN mobile    TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN cc_email  TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN website   TEXT NOT NULL DEFAULT '';
ALTER TABLE names ADD COLUMN other_contact TEXT NOT NULL DEFAULT '';
