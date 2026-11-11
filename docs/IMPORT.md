# Importing from QuickBooks

## Lists (IIF)

### Making the file in QuickBooks

In QuickBooks Pro, choose **File > Utilities > Export > Lists to IIF Files**, tick every
list (Chart of Accounts, Customer List, Vendor List, Employee List, Other Names List,
Item List, Terms List and any others), click **OK** and save the file, for example as
`lists.iif`. Copy it to the RapidBooks machine.

### Running the import

From the RapidBooks folder:

```
npx tsx packages/server/src/import/cli.ts lists.iif [--db path/to/company.db]
```

Without `--db` it uses `data/rapidbooks.db` (or `$RAPIDBOOKS_DB`), the file the server
uses. The database is created if it does not exist. The import only runs into an
**empty** company (no accounts, names, items or terms): stop the server, move the old
database aside, and run the import before starting the server again. Do not start the
server against a new file first, because it would create its starter chart of
accounts. The whole import is one database transaction, so if it stops with an error,
nothing is imported.

It prints how many of each list it imported, the record types it ignored, and a
warning for everything it skipped or changed. Read the warnings.

### What comes across

- **Chart of accounts**: names, types, subaccounts, descriptions and inactive flags.
  Opening balances are not imported; balances come later from the Journal report.
  Non-posting accounts (Purchase Orders, Estimates) are skipped. "Other Asset" accounts
  become Other Current Asset. Account numbers are not kept yet. The A/R, A/P,
  Undeposited Funds, Opening Bal Equity and Retained Earnings accounts are recognised,
  and created if the file has none.
- **Terms**: standard (net days) terms with discount percent and days. Date-driven
  terms are skipped with a warning.
- **Customers and jobs, vendors, employees, other names**: addresses, phones, fax,
  e-mail, contacts, first/last names, company name, terms, credit limit, notes,
  inactive flag; vendor print-as name, tax ID, 1099 flag and account number;
  employee SSN and hire/release dates. A name already used on another list is
  skipped with a warning (QuickBooks doesn't allow that either).
- **Items**: service, non-inventory part, other charge, subtotal, discount and group
  items with subitems, description, rate and account. Inventory parts become
  non-inventory parts. Sales tax and payment items are skipped. **Groups arrive
  empty**, because the list export does not say which items are in a group: open each
  group afterwards and add its items.

### Not yet checked against a real export

The importer was written against the documented IIF format and a hand-made sample
(`packages/server/test/fixtures/sample.iif`), not against a real export from this
company's QuickBooks. Before cutover, run it on her real file and check the warnings and
the lists by eye, in particular: the column names her QuickBooks version uses for terms,
employees and vendor account numbers, how notes with several lines are written, and how
discount items' percentages are signed.
