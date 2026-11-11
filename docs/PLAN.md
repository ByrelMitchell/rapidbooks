# RapidBooks: a QuickBooks-style bookkeeping web app for the LAN

## Context

Mom keeps the business books in an old QuickBooks Pro (around 2003) on a Windows XP machine she reaches by VNC. She won't upgrade because she doesn't want to relearn the interface, and she works largely by keyboard shortcut. The rest of the business is on Linux. RapidBooks replaces only the parts of QuickBooks she uses, keeps the look and the keystrokes, runs as a web app on one Linux box, and carries over her full history so the Windows XP machine can be retired.

Decisions already made:
- TypeScript full stack, SQLite, single bookkeeper, served on the LAN.
- Import lists and full transaction history.
- Paychecks are manual entry (she types gross, withholdings, net); no tax tables.
- UI is built from my knowledge of QuickBooks first, then refined from screenshots.

`D:\rapidbooks` is empty, so this is a greenfield build.

## Scope answers

- **Version**: an older QuickBooks Pro on Windows XP, probably around 2003 (no left icon bar). Build the classic look: top menu bar, icon bar, Navigator. Pressing **F2** in QuickBooks will confirm the exact version; screenshots come later for refinement.
- **Trip reports**: today an Awk script over invoices. RapidBooks builds it in: one trip per customer per invoice date, excluding customers flagged as "picks up" (a checkbox on the customer record). Shows date, customer, invoices in the trip, with trip counts per customer and per period.
- **Inventory**: not tracked. Items are service, non-inventory part, other charge, subtotal, discount and group only.
- **Sales tax**: none (B2B machine shop). No tax items, codes or tax columns on forms.
- **Checks**: she prints non-negotiable copies for her paper files. Write Checks gets a plain-paper record print. Printing on real check stock is a possible later addition.
- **Reconciliation**: done by hand. No reconcile screen; the register keeps the cleared (✓) column so she can tick items off.

## Architecture

```
rapidbooks/
  package.json                npm workspaces
  packages/shared/            money (integer cents), types, Zod schemas shared by both sides
  packages/server/
    src/db/                   better-sqlite3, numbered SQL migrations
    src/ledger/               posting engine: one function per transaction type -> balanced splits
    src/routes/               Fastify JSON API
    src/reports/              report queries (all derived from splits)
    src/pdf/                  pdfkit templates: invoice, credit memo, statement, purchase order
    src/mail/                 nodemailer SMTP send
    src/import/               IIF list importer, report-export history importer, reconciler
    src/backup/               scheduled + on-demand SQLite backups
  packages/web/               React + Vite
    src/shell/                MenuBar, WindowManager (MDI windows), shortcut dispatcher, zoom
    src/controls/             DateField, AmountField, QuickFillCombo, LineGrid
    src/forms/                Invoice, CreditMemo, ReceivePayments, Deposit, WriteChecks, EnterBills, PayBills, PurchaseOrder, Paycheck, Transfer, JournalEntry
    src/lists/                ChartOfAccounts, Items, Customers, Vendors, Employees, OtherNames, Register
    src/reports/              report viewer, customize dialog, graphs (Recharts)
  deploy/                     systemd unit, install script
```

- **Server**: Node 22, Fastify, better-sqlite3 (WAL mode), Zod validation. One process serves the API and the built frontend.
- **Tests**: Vitest for the ledger and reports; Playwright for keyboard-driven end-to-end flows.
- **Access**: bound to the LAN interface, single shared password with a session cookie.
- **Concurrent edits**: a version column on transactions, so the same record open in two browsers can't silently overwrite.

### Data model

- `accounts`: QuickBooks account types (Bank, A/R, Other Current Asset, Fixed Asset, A/P, Credit Card, liabilities, Equity, Income, COGS, Expense, Other Income/Expense), sub-accounts, inactive flag.
- `names`: one table for customers (with jobs), vendors, employees, other names.
- `items`: service, non-inventory part, other charge, subtotal, discount, group.
- `transactions` (type, date, number, name, memo, terms, due date, ship fields) and `splits` (account, signed amount in cents, name, memo, cleared flag).
- `lines`: document line detail (item, description, qty, rate, amount) for invoices, credit memos, POs, bills.
- `links`: payment→invoice, credit→invoice, bill payment→bill, deposit→payment, PO→bill.
- `terms`, `payment_methods`, `company`, `audit_log`.

Rules the ledger enforces:
- Splits of every transaction sum to zero; the posting engine is the only code that writes splits.
- Saving an edited document regenerates its splits inside one database transaction.
- Purchase orders are non-posting. Statements are generated on demand, not stored. Finance charges are stored as invoices of type FC.
- Received payments go to Undeposited Funds by default and move to the bank through Record Deposits, as in QuickBooks.

### Interface

- A QuickBooks-style desktop in the browser: menu bar (File, Edit, Lists, Company, Customers, Vendors, Employees, Banking, Reports, Window, Help) with Alt mnemonics, icon bar, home page flow diagram, and movable internal windows listed under the Window menu.
- Forms laid out like the originals, with Save & Close (Alt+S), Save & New (Alt+N), Previous/Next, and Esc to close.
- **Shortcuts**: Ctrl+I invoice, Ctrl+W write checks, Ctrl+A chart of accounts, Ctrl+J customers, Ctrl+R register, Ctrl+N/E/D new/edit/delete, Ctrl+F find, Ctrl+Q QuickReport, Ctrl+Y transaction journal, Ctrl+H history, Ctrl+L open list for the current field, Ctrl+P print, Ctrl+G go to transfer, Ctrl+Ins / Ctrl+Del insert/delete line.
- **Field behaviour**: date keys (+, -, T, W/K, M/H, Y/R), QuickFill type-ahead in name/item/account fields with "not found, Quick Add / Set Up", arithmetic in amount fields, Tab order matching the originals.
- **Fonts and zoom**: a View > Zoom setting (100–200%, rem-based so the whole UI scales) remembered per browser, plus a larger-font option for lists and registers.

**Shortcut risk.** A normal browser tab cannot intercept Ctrl+W, Ctrl+N or Ctrl+T; Ctrl+W would close the tab. Phase 1 starts with a spike: Chromium fullscreen with the Keyboard Lock API. If that doesn't deliver those keys reliably, the fallback is a small Electron shell on each Linux box that just loads the LAN URL and passes all keys through. The web app itself is the same either way.

### Email

QuickBooks hands a PDF to the local mail client; a web page can't attach a file to a `mailto:` link. RapidBooks instead shows a compose dialog (To, Subject, Body pre-filled from the customer and a template) and sends through her SMTP account from the server, with the PDF attached and a copy to her so it lands in her mail. Batch send works from a "to be emailed" checkbox on invoices. "Download PDF" stays available for attaching by hand.

### Reports

A shared report viewer with date-range presets, column/filter customization, drill-down to the underlying transaction (double-click, as in QuickBooks), print via print CSS, and CSV export.

- Profit & Loss (standard, by month)
- Balance Sheet and Trial Balance (needed to verify the import anyway)
- Sales by Customer and Sales by Item, summary and detail
- Item reports with customizable columns and filters
- Vendor reports: balance summary/detail, A/P aging, unpaid bills, purchases by vendor
- Customer reports: A/R aging, open invoices, customer balance detail
- Banking: deposit detail, check detail, missing checks, register QuickReport
- Trip report (replaces the Awk script; see Scope answers)
- Sales graphs: by customer or item, selectable date range and customer set

### Backup

- Nightly SQLite online backup to a configured directory (ideally another machine's mount), with daily/weekly/monthly rotation, run by a systemd timer.
- File > Back Up downloads a copy on demand; File > Restore is a documented command-line step, not a menu item.
- The home page shows the date of the last successful backup.

### History import

QuickBooks exports lists to IIF but not transactions, so history comes from report exports:

1. **Lists**: File > Utilities > Export > Lists to IIF (accounts, customers, vendors, employees, other names, items, terms).
2. **Ledger**: the Journal report for all dates, exported to CSV. This gives every transaction with type, date, number, name, memo, and each split's account, debit and credit. It is the source of truth for balances.
3. **Line detail**: Sales by Item Detail and Purchases by Item Detail for all dates, matched to invoices/bills by type + number + date, to recover item, quantity and rate.
4. **Open balances**: payment-to-invoice links are not in any export. The importer applies payments and credits oldest-first per customer/vendor, then checks the result against the Open Invoices and Unpaid Bills reports and flags any difference for manual fixing.
5. **Reconciliation report**: Trial Balance, P&L per year, A/R and A/P aging from RapidBooks compared against the same QuickBooks exports, to the cent.

The importer always builds a fresh database, so it can be run for testing now and again on cutover day.

## Build phases

1. **Foundation**: keyboard spike; workspace setup; schema and migrations; posting engine; shell (menus, windows, shortcuts, zoom); chart of accounts; register; general journal entry; company information.
2. **Lists**: customers and jobs, vendors, employees, other names, items, terms; IIF list importer.
3. **Sales and receivables**: invoices, credit memos, receive payments, record deposits, statements, finance charges; PDFs; email single and batch.
4. **Purchases and banking**: purchase orders, enter bills, pay bills, write checks (with plain-paper record print), transfer funds, paychecks (manual lines for gross, each withholding, net).
5. **Reports and graphs**.
6. **History import and reconciliation** against her real exports.
7. **Deployment and cutover**: systemd service, backups, parallel run alongside QuickBooks for a few weeks, final re-import, then UI refinement from screenshots.

## Verification

- **Ledger**: Vitest cases for each transaction type asserting exact splits and zero sum, including edit and delete; a property test that the trial balance is always zero.
- **Reports**: fixture company with known totals; each report checked against hand-computed figures. The trip report is compared against the Awk script's output for the same period.
- **Keyboard flows**: Playwright scripts that create an invoice, receive payment, deposit, enter and pay a bill, and write a check using only the keyboard.
- **Import**: the reconciliation report shows zero differences against her QuickBooks Trial Balance, yearly P&L, A/R aging and A/P aging.
- **PDF and email**: generate an invoice PDF and send it to a test mailbox.
- **Backup**: run the backup, restore it to a scratch database, and compare trial balances.
- **Acceptance**: she does a normal day's bookkeeping in both systems during the parallel run and the reports agree.
