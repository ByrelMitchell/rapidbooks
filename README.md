# RapidBooks

A bookkeeping web app that looks and works like QuickBooks Pro 2013, built to run on a Linux box on the LAN. It covers invoices, credit memos, statements, finance charges, payments, deposits, purchase orders, bills, checks, transfers, manual paychecks, lists, reports and graphs.

## Development

```
npm install
npm run dev:server     # API on http://127.0.0.1:3001 (creates data/rapidbooks.db)
npm run dev:web        # app on http://localhost:5173
npm test               # all tests
npm run typecheck
```

## Production

```
npm run build
npm start              # serves the app and the API from one process
```

See the docs for the rest:

- `docs/DEPLOY.md`: installing on the Linux server, the password, HTTPS, the client launcher, updates, restore.
- `docs/IMPORT.md`: exporting from QuickBooks and importing lists and full history, with the reconciliation report.
- `docs/EMAIL.md`: SMTP settings for e-mailing invoices.
- `docs/PLAN.md`: the original design.

## Layout

- `packages/shared`: money, dates and types used by both sides.
- `packages/server`: Fastify + SQLite. `ledger/posting.ts` is the only code that writes ledger splits.
- `packages/web`: React app (menu bar, child windows, forms, lists, reports).
- `deploy`: systemd unit, install and update scripts, certificate helper, client launcher.
