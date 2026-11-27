# Moving the books from QuickBooks to RapidBooks

This guide is for whoever sits at the old QuickBooks computer (Windows XP) and the
RapidBooks computer and carries the company's **whole history** across. Nothing here
changes anything in QuickBooks: you only export reports from it. The import always
builds a **new** RapidBooks company file, so you can try it as often as you like.

The plan:

1. In QuickBooks, export the lists and six reports (about 20 minutes).
2. Copy the files to the RapidBooks computer.
3. Run one command. It builds the company file and prints a **reconciliation**: RapidBooks'
   figures next to QuickBooks', line by line, with PASS or FAIL.
4. If everything says PASS, the books match QuickBooks to the cent.

Do a **trial run** now, and the **real run** on cutover day (section 7).

---

## 1. Exports from QuickBooks

Make a folder on a USB stick called `qb-export`. Save every file below into it, with
exactly the name given. Do every export on the same day, without anyone entering
transactions in between.

Pick the **verification date**: the last day you want to compare, normally today's date
(or, on cutover day, the cutover date). Below it is written *DATE*.

### 1.1 Lists → `lists.iif`

1. **File > Utilities > Export > Lists to IIF Files...**
2. Tick **every** list (Chart of Accounts, Customer List, Vendor List, Employee List,
   Other Names List, Item List, Terms List, and any others shown).
3. **OK**, save as `lists.iif` in `qb-export`.

### 1.2 The Journal (every transaction ever) → `journal.csv`

1. **Reports > Accountant & Taxes > Journal**.
2. Click **Modify Report...** At the top, in **Dates**, choose **All**.
3. Still on the **Display** tab, in the **Columns** list, make sure these are ticked
   (a tick mark in front). The first nine are normally ticked already; tick the others
   if your QuickBooks offers them (skip any it does not have):
   - Trans #, Type, Date, Num, Name, Memo, Account, Debit, Credit
   - Item, Item Description, Qty, Sales Price
   - Clr
   - P. O. #, Terms, Due Date, Ship Date, Via
   - Open Balance, Paid
   - Name Address (or Name Street1, Name Street2, Name City, Name State, Name Zip)
   - Source Name, Pay Meth, Billing Status
   - Account Type (tells apart accounts whose names end the same, see 9.6)
4. **Filters** tab: there should be no filters except the date. If you see one for
   Transaction Type or Account, select it and click **Remove Selected Filter**.
5. **OK**. The report may take a minute or two to build.
6. Click **Export...** (on some versions: **Print > Print to File**, see below). Choose
   **a comma separated values (.csv) file**, click **Export**, save as `journal.csv`.

If your QuickBooks has no Export button that makes a .csv file: click **Print**, choose
**File** instead of the printer, pick **Tab delimited file**, and save it as
`journal.txt`. RapidBooks reads both.

**A long history does not fit in one file.** Her QuickBooks 2013 stopped the .csv export
at 32,768 rows (about seven years of her transactions). So instead of Dates **All**,
export the Journal several times, five years at a time, with Dates **Custom**: From
01/01/1996 To 12/31/2000 → `journal-1996.csv`, From 01/01/2001 To 12/31/2005 →
`journal-2001.csv`, and so on up to *DATE*. Overlapping ranges do no harm (a
transaction in two files is imported once), but a gap loses everything in it, so make
each range start the day after the previous one ends. If a file is still cut off, the
import says so ("the export was cut off"): split that range in two.

### 1.3 Trial Balance → `tb.csv`

**Reports > Accountant & Taxes > Trial Balance**. **Modify Report**: Dates **Custom**,
From blank (or the first day of the year), To *DATE*. **OK**, then **Export** to
`tb.csv` as above.

### 1.4 Open Invoices → `open-invoices.csv`

**Reports > Customers & Receivables > Open Invoices**, Dates: *DATE*. Export to
`open-invoices.csv`. (If you cannot find it, export the **A/R Aging Summary** for *DATE*
instead, still named `open-invoices.csv`. It checks the total per customer only.)

### 1.5 Unpaid Bills → `unpaid-bills.csv`

**Reports > Vendors & Payables > Unpaid Bills Detail**, Dates: *DATE*. Export to
`unpaid-bills.csv`. (Or the **A/P Aging Summary**, same name.)

### 1.6 Profit & Loss, one file per year → `pl-2024.csv`, `pl-2025.csv`, ...

**Reports > Company & Financial > Profit & Loss Standard**. Modify Report: Dates
**Custom**, From 01/01/2025 To 12/31/2025 (one calendar year). Export to `pl-2025.csv`.
Repeat for each year you want checked (at least the last two, ideally every year).

Instead of one file per year you may make one file with every year side by side:
Dates **All**, and in **Columns** (top of the Display tab) choose **Year**. Save it as
`pl-all.csv`.

### 1.7 Purchase orders and estimates

These do not post to the books and are not in the Journal. Print the **Open Purchase
Orders** report (Reports > Purchases > Open Purchase Orders) and re-enter the few that
are still open in RapidBooks by hand after cutover. Estimates are not carried over.

---

## 2. Copy the files to the RapidBooks computer

Copy the `qb-export` folder into the RapidBooks folder (the one that contains
`packages` and `data`), so you have for example `rapidbooks/qb-export/journal.csv`.

---

## 3. Run the import

Open a terminal in the RapidBooks folder and type (one line; `\` continues a line):

```
npx tsx packages/server/src/import/cli.ts \
  --iif qb-export/lists.iif \
  --journal qb-export/journal-1996.csv --journal qb-export/journal-2001.csv \
  --journal qb-export/journal-2006.csv --journal qb-export/journal-2011.csv \
  --journal qb-export/journal-2016.csv --journal qb-export/journal-2021.csv \
  --journal qb-export/journal-2026.csv \
  --trial-balance qb-export/tb.csv --as-of 2026-10-31 \
  --open-invoices qb-export/open-invoices.csv --unpaid-bills qb-export/unpaid-bills.csv \
  --profit-loss qb-export/pl-2024.csv --profit-loss qb-export/pl-2025.csv \
  --out data/trial.db --report qb-export/reconciliation.txt
```

- Replace `2026-10-31` with *DATE*, written year-month-day.
- Give one `--journal` per Journal file, in any order (they are sorted by date). With a
  single file, one `--journal qb-export/journal.csv` is enough. Use `.txt` names if that
  is what you made.
- Leave out any report you did not make. Without any, the import still works and prints
  RapidBooks' own trial balance for you to compare by eye.
- A Profit & Loss file whose only amount column is headed "TOTAL" needs its dates:
  `--profit-loss qb-export/pl.csv --pl-from 2025-01-01 --pl-to 2025-12-31`.
- If her fiscal year does not start in January, add `--fiscal-year-start 7` (the month).
- `--out` is the company file to create. For a trial run use `data/trial.db`. It
  **never overwrites** an existing file: if it exists you get a message and nothing
  happens. Add `--force` to import anyway; the old file is first renamed to
  `<name>.before-import-<date>-<time>`, never deleted.
- The import runs in one go; a company with 20 years of history takes well under a
  minute. If it stops with an error, no company file is created.

When it finishes it prints the reconciliation (and writes it to `--report`). The last
line of its summary says **OVERALL: PASS** or **OVERALL: FAIL**.

---

## 4. Reading the reconciliation

It starts with a **Summary**: one line per check, PASS or FAIL. Then each section:

| Section | What it shows | PASS means |
|---|---|---|
| Transactions read and imported | For each QuickBooks type: how many transactions and rows were read, imported, skipped and locked | (information) |
| Transactions skipped | Every transaction that could not be imported, with the reason | nothing was skipped |
| Locked transactions | Transactions imported exactly as QuickBooks posted them but which cannot be re-opened in their normal form (see 5.3) | (information) |
| Warnings | Accounts and names created, items not found, report lines not understood | (information) |
| Ledger balance | The total of every debit and credit in the books | the books balance (0.00) |
| Applications | Which payments were matched to which invoices (QuickBooks does not export this; see 5.4) | QuickBooks' open balances were reproduced |
| Trial Balance | Every account: QuickBooks, RapidBooks, difference | every account agrees to the cent |
| Open Invoices / Unpaid Bills | Every open document: QuickBooks, RapidBooks | the same documents are open, by the same amounts |
| Profit & Loss | Every income and expense account for the year, and Net Income | every line agrees |

Lines that differ are marked `<-- differs` and listed again under **Differences**.

---

## 5. What to do about each kind of message

### 5.1 "it does not balance in the file" (skipped)

QuickBooks never has a transaction that does not balance, so the file was misread:
usually a report that was cut off, edited in Excel, or a memo with an odd character.
Look up the transaction (the message gives its line in the file, its type, number and
date) in QuickBooks and in the file. Re-export and try again. Never edit the file to
make it balance. Skipped transactions make the Trial Balance differ too.

Other skip reasons: a date or an amount that cannot be read (the message quotes it).
Same remedy.

### 5.2 Accounts or names "created (inactive)"

The Journal uses an account, customer, vendor or other name that is not in the list
export, usually because it was renamed or deleted after use. RapidBooks creates it,
inactive, so no money is lost. Accounts are given a guessed type: **open the Chart of
Accounts and check the type** of each one listed. If it is simply the old name of an
existing account, that is fine to leave; or ask for the two to be merged.

If *many* accounts are created, the account names in the Journal do not match the list:
check that QuickBooks shows full account names (Parent:Child) in reports
(Edit > Preferences > Reports & Graphs > Company Preferences).

### 5.3 Locked transactions

Every QuickBooks transaction is imported with exactly QuickBooks' debits and credits.
RapidBooks then tries to re-create each document (invoice, bill, check...) from its
lines with the normal form. When the form would post it the same way, the document is
an ordinary one and can be edited like anything entered in RapidBooks.

When it would not, it is **locked**: it opens as a list of its debits and credits
instead of the form, and can be corrected there but not re-saved from the form. The
section says why for each one. Typical reasons:

- **Paycheck**: QuickBooks does not export the payroll items, so every paycheck is
  locked. The employee, bank account, check number and net pay are filled in.
- **No RapidBooks form for this QuickBooks type** (Sales Receipt, Credit Card Charge,
  Statement Charge, Item Receipt, ...): shown under QuickBooks' own type name.
- **Its lines post differently**: for example an item that today posts to a different
  account than it did when the invoice was written. The books are still exactly
  QuickBooks'. Nothing to do, unless she wants the old documents editable: then fix the
  item's account in RapidBooks and import again.
- **The form would refuse it**: for example a check with an Accounts Payable line.

None of these needs fixing for the books to be right.

### 5.4 Applications (which payment paid which invoice)

QuickBooks does not export this. RapidBooks works it out per customer (each job on its
own first, then the customer itself), applying payments and credit memos to the oldest
invoices first, and aiming at the open balances QuickBooks gives: those of the Open
Invoices report if you gave one, otherwise the Journal's Open Balance (or Paid) column.
The same for vendors and bills. A customer listed under **Applications** is one where no
assignment could give QuickBooks' open balances; the message names the documents.
Usually a payment was applied to an invoice of another customer, or a journal entry was
used as a credit. Fix those few by hand after the import (Receive Payments / Pay Bills),
and compare the customer's balance with QuickBooks.

Deposits are matched to the payments in them by customer and amount; a line that matches
no payment stays a plain deposit line (shown as "deposit lines with no matching
payment"). That is harmless.

### 5.5 Trial Balance, Open Invoices or Profit & Loss differences

- **One account differs, everything else agrees**: look for skipped transactions or a
  created account first. Then run the QuickBooks report **Account QuickReport** for that
  account and compare with RapidBooks' register.
- **Retained Earnings and every income/expense account differ**: the fiscal year start
  is wrong; add `--fiscal-year-start`.
- **Everything differs**: the reports are of a different date than `--as-of`.
- **"... is not an account in RapidBooks"**: a report line whose name could not be
  matched. If the account exists under another name, nothing is wrong with the books.
- **Open Invoices line "matches no imported transaction"**: compare the type, number and
  date of that line with the Journal.

### 5.6 "Item ... is not on the item list"

Lines with an item that no longer exists are imported as plain lines to the same
account. Nothing is lost.

---

## 6. After a successful trial run

Start RapidBooks against the trial file and look around: open some invoices, the
registers, a few reports. When you are done, delete `data/trial.db` (it is only a test).

---

## 7. Cutover day

1. In QuickBooks: finish the day's work. From now on **nobody enters anything in
   QuickBooks**.
2. Make a QuickBooks backup (File > Back Up) and keep it.
3. Do all the exports of section 1 with *DATE* = today.
4. On the RapidBooks computer: **stop the RapidBooks server** (`sudo systemctl stop
   rapidbooks`, or close its window), so nobody uses the old company file.
5. Run the import of section 3 with `--out data/rapidbooks.db --force`. The old file is
   renamed, not deleted.
6. Read the reconciliation. It must say **OVERALL: PASS** (or only differences you have
   understood and noted, see 5). If not, do not switch: start the server on the old
   file again (rename it back) and keep using QuickBooks until it is sorted out.
7. Print or save `reconciliation.txt` with the QuickBooks backup.
8. Start the RapidBooks server. From now on she works in RapidBooks only.
9. Re-enter open purchase orders by hand (section 1.7).
10. Keep the old computer, switched off, for a few months before retiring it.

---

## 8. Lists only

The older list-only import still works:

```
npx tsx packages/server/src/import/cli.ts lists.iif [--db path/to/company.db]
```

It imports only the lists into an **empty** company file (no starter accounts).

What comes across from the lists:

- **Chart of accounts**: names, types, subaccounts, descriptions and inactive flags.
  Opening balances are not imported; balances come from the Journal. Non-posting
  accounts (Purchase Orders, Estimates) are skipped. "Other Asset" accounts become Other
  Current Asset. Account numbers are not kept yet. The A/R, A/P, Undeposited Funds,
  Opening Bal Equity and Retained Earnings accounts are recognised, and created if the
  file has none.
- **Terms**: standard (net days) terms with discount percent and days. Date-driven terms
  are skipped with a warning.
- **Customers and jobs, vendors, employees, other names**: addresses, phones, fax,
  e-mail, contacts, names, terms, credit limit, notes, inactive flag; vendor print-as
  name, tax ID, 1099 flag and account number; employee SSN and hire/release dates.
- **Items**: service, non-inventory part, other charge, subtotal, discount and group
  items. Inventory parts become non-inventory parts. Sales tax and payment items are
  skipped. **Groups arrive empty**: open each group afterwards and add its items.

---

## 9. Not yet checked against her real files

The importer was written from QuickBooks' documentation and hand-made sample files
(`packages/server/test/fixtures/history/`), not from this company's exports. Every
assumption about the layout lives in one file, `packages/server/src/import/layout.ts`,
so it can be adjusted quickly. On the first trial run, check these:

**Journal**

1. The header row can be found: it has columns named Account, Debit/Credit (or one
   signed Amount column) and Type or Date. Title lines above it are ignored.
2. Column headings are matched by name, ignoring case and punctuation, with the aliases
   in `JOURNAL_COLUMNS` (e.g. "Trans #" or "Trans No", "Sales Price" or "Rate").
3. A transaction starts at a row with a new Trans #. Without a Trans # column: at a
   change of Type, Date or Num, or after a blank line or a total row. Two adjacent
   transactions with the same type, date and number and no blank line between them would
   be merged (and then reported as not balancing).
4. A row with no account but with amounts is the transaction's total row; a row whose
   first text is "TOTAL" is the grand total. Both are skipped.
5. The first row of a transaction is its "header" row: for invoices and credit memos the
   A/R line, bills and credits the A/P line, checks/bill payments/paychecks the bank
   line, deposits the bank line, payments the deposit-to line. The header Name, Memo,
   Terms, Due Date etc. are taken from it (or the first row that has them).
6. Account names are full colon-separated names ("Utilities:Electric"); an account
   number in front ("6100 · Rent") is removed. A plain name that is unique as a
   subaccount name is also accepted. Her QuickBooks 2013 prints only the last part
   ("tooling" for both Sales:Tooling and Supplies:tooling). Such a name is narrowed down
   by the **Account Type** column (add it in Modify Report), then by its exact
   capitalisation ("Swiss" and "swiss" are different accounts), then by the accounts the
   line's item posts to. A name still shared by two accounts of the same type ("electric":
   Supplies:electric and Utilities:electric) is imported into one created account of
   that name, which the Trial Balance shows as differing. The inch mark is matched either
   way: the list export writes 1' bar where the Journal has 1" bar.
7. Item names in the Item column are full names or unique short names. QuickBooks 2013
   writes "Name (Description)", or "(Description)" for a line without an item; the
   description, matched against the Item Description column, is removed.
8. Item rows of invoices carry the line description in Memo and/or Item Description,
   the quantity in Qty (sign ignored) and the rate in Sales Price; a percentage rate ends
   in "%".
9. Clr: any non-blank value other than "No"/"N"/"0" means cleared (the check mark and the
   "*" of an unfinished reconciliation both count as cleared).
10. Open Balance is read from the A/R or A/P row of the transaction (else any row), as
    the document's open balance or the credit's unapplied amount (sign ignored). Paid:
    "Paid" means fully paid.
11. Amounts: thousands commas, $, parentheses, leading or trailing minus. Dates: M/D/YY
    or M/D/YYYY; two-digit years 70-99 are 1900s, 00-69 are 2000s.
12. Files are Windows-1252, UTF-8 or UTF-16 (with a byte-order mark); comma- or
    tab-delimited (detected); quoted fields may contain commas, quotes and line breaks.
13. Type names as listed in `TYPE_MAP`: "Invoice", "Credit Memo", "Payment", "Deposit",
    "General Journal", "Check", "Liability Check" (imported as a check), "Bill",
    "Credit" (vendor credit), "Bill Pmt -Check", "Bill Pmt -CCard", "Transfer",
    "Paycheck", "Finance Chrg"/"Finance Charge" (an invoice). Any other type is imported
    as posted under its own name, locked.
14. A payment with an early-payment discount, and a bill payment with a discount, have
    extra rows for the discount account; the A/R or A/P row may be one row for amount +
    discount (accepted as editable) or two.

**Verification reports**

15. Grouped layout: a customer, vendor or parent account is on its own row in a leading
    unlabelled column; its rows follow, indented one column further; "Total ..." closes
    the group; "TOTAL" ends the report. QuickBooks 2013's .csv export is flat instead:
    every label in the first column. Then a label with no amount opens a group inside the
    current one and "Total X" closes group X.
16. Open Invoices / Unpaid Bills: columns Type, Date, Num, Open Balance; payments and
    credits show negative open balances. Aging summaries: a TOTAL column per name.
17. Trial Balance: Debit and Credit columns; income and expense accounts are
    year-to-date and prior years' profit is in Retained Earnings (fiscal year from
    `--fiscal-year-start`, default January). With From left blank her QuickBooks prints
    them over all dates instead, with no Retained Earnings; the comparison uses whichever
    of the two the report agrees with and says which.
18. Profit & Loss: one amount column per period, headed like "Jan - Dec 25", "Jan 1 -
    Dec 31, 25" or "2025"; a parent account's own amount is the row "Parent - Other";
    rows "Gross Profit", "Net Ordinary Income", "Net Income" etc. are totals.
