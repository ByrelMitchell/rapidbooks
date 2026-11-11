# E-mailing invoices and credit memos

RapidBooks sends invoices and credit memos through your own SMTP mail account, with
the form attached as a PDF ("Invoice 1234.pdf"). After a successful send it records
the time (`emailed_at`) and clears the form's "To be e-mailed" mark.

## Where the settings live

The SMTP settings are **not** stored in the company database. Database backups get
copied around (to other machines, USB sticks, the importer's scratch copies), and the
mail password must not travel with them. Settings come from:

1. a JSON file, by default `config/smtp.json` in the RapidBooks folder (next to
   `packages/` and `data/`), or the file named by `RAPIDBOOKS_SMTP_FILE`; and
2. environment variables, which win over the file.

| JSON key   | Environment variable         | Meaning                                                              |
|------------|------------------------------|----------------------------------------------------------------------|
| `host`     | `RAPIDBOOKS_SMTP_HOST`       | SMTP server name, e.g. `smtp.example.com` (required)                 |
| `port`     | `RAPIDBOOKS_SMTP_PORT`       | Port. Default 465 when `secure`, otherwise 587                       |
| `secure`   | `RAPIDBOOKS_SMTP_SECURE`     | `true`: TLS from the start (port 465). `false`: STARTTLS when offered (587/25) |
| `user`     | `RAPIDBOOKS_SMTP_USER`       | Login name; leave out for a relay that needs no login               |
| `password` | `RAPIDBOOKS_SMTP_PASSWORD`   | Password (an app password for Gmail/Outlook accounts). Required when `user` is set |
| `from`     | `RAPIDBOOKS_SMTP_FROM`       | The From address, e.g. `Byrel Precision <office@example.com>` (required) |
| `bcc_self` | `RAPIDBOOKS_SMTP_BCC_SELF`   | `true` to send a blind copy of every message to the From address, so it lands in your own mailbox |

Example `config/smtp.json`:

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "secure": false,
  "user": "office@example.com",
  "password": "app-password-here",
  "from": "Byrel Precision Machine <office@example.com>",
  "bcc_self": true
}
```

Keep the file readable only by the account the server runs as
(`chmod 600 config/smtp.json`). The settings are read each time a message is sent, so
changing the file needs no restart; environment variables do need one.

If a setting is missing, sending fails with a message naming it, for example
"E-mail is not set up: the SMTP server name is missing. Set RAPIDBOOKS_SMTP_HOST, or
"host" in .../config/smtp.json." `GET /api/email/status` reports the same without
sending anything.

## Message templates

The proposed Subject and Body are kept in the company database (they hold no
secrets), edited through `GET`/`PUT /api/email/templates`:

| Company key                 | Default                                      |
|-----------------------------|----------------------------------------------|
| `email_invoice_subject`     | `Invoice {num} from {company}`               |
| `email_invoice_body`        | "Dear {contact}: Your invoice {num} for ${total} is attached. ..." |
| `email_creditmemo_subject`  | `Credit Memo {num} from {company}`           |
| `email_creditmemo_body`     | "Dear {contact}: Your credit memo {num} for ${total} is attached. ..." |

Placeholders: `{num}` `{date}` `{due_date}` `{total}` `{balance}` (open balance, or
unapplied credit) `{customer}` (Customer:Job) `{contact}` (the contact, else the
person's name, else the company name) `{company}` (your company name). Unknown
placeholders are left as typed.

The proposed To is the customer's e-mail address; a job without one uses its
customer's.

## Testing

The tests never touch the network: `buildApp(db, { mailer })` and the send functions
take a mailer factory, and the tests pass one built on nodemailer's `jsonTransport`.
To try a real send, set up `config/smtp.json`, mark an invoice "To be e-mailed" and
send it to yourself.
