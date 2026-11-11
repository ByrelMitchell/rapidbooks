# Sharing a demo over the internet

To let someone elsewhere try RapidBooks, you can run it on your own Windows PC and
open a Cloudflare *quick tunnel* to it. You don't need an account, a domain, router
changes or certificates. They get an `https://…trycloudflare.com` link. Because the link
is HTTPS, the Ctrl+W/N/T keyboard capture works for them in full screen (see `DEPLOY.md` §5).

This is for short demos. For the real office install, see `DEPLOY.md`.

## One-time setup

1. Install the tunnel tool:

   ```
   winget install Cloudflare.cloudflared
   ```

2. Build the app (again after every update): `npm run build`.

3. Make a data folder **outside the repo**. The script defaults to `rapidbooks-demo` next to
   the repo folder, e.g. `D:\rapidbooks-demo`. Put the demo database in it. Copy it while
   no server has it open:

   ```
   npm run demo
   mkdir ..\rapidbooks-demo
   copy data\demo.db ..\rapidbooks-demo\rapidbooks.db
   ```

   They work on this copy, so `data/demo.db` and your real books are never touched. To
   start over with fresh data, stop the demo and copy it again.

4. **Set a password.** This is required. The server listens on 127.0.0.1, so its "no password
   on a network address" check does not apply, but the tunnel still puts it on the open
   internet. The script refuses to start without `auth.json`.

   ```
   $env:RAPIDBOOKS_DB='D:\rapidbooks-demo\rapidbooks.db'
   npx tsx packages/server/src/auth/set-password.ts
   ```

   This writes `auth.json` next to that database. If you also save the password as the first line of
   `PASSWORD.txt` in the same folder, the script prints it with the link. That makes it easy
   to copy, but keep it out of the repo.

## Running it

```
powershell -ExecutionPolicy Bypass -File deploy\remote-demo.ps1
```

Options: `-DataDir D:\somewhere` and `-Port 3002`.

The script starts the server on `127.0.0.1:3002` with nightly backups off and opens the tunnel.
It prints:

```
  Demo URL:  https://some-random-words.trycloudflare.com
  Password:  …
```

Send them both. They should use Chrome or Edge. **Ctrl+C** stops the server and the tunnel.

## Things to know

- **Your PC is the server.** The link works only while the script runs. The script keeps
  the PC from sleeping, but a restart or shutdown ends the demo.
- **The address changes on every start.** Send the new link each time. For a permanent
  address, use a named Cloudflare tunnel (free account plus a domain you own) or
  Tailscale Funnel (`tailscale funnel 3002`, gives a fixed `*.ts.net` name).
- **Login throttling is shared.** The server delays logins per IP after 5 wrong passwords,
  and behind the tunnel every request comes from 127.0.0.1. Someone guessing at the link
  could make the real user wait up to a minute.
- **Port 3002** stays clear of the dev server on 3001, so you can keep developing while the
  demo runs.
- Log in and other requests that change data must carry the app's `X-Requested-With`
  header. The browser app does this itself; it matters only if you test with `curl`:

  ```
  curl -H 'x-requested-with: RapidBooks' -H 'content-type: application/json' \
       -d '{"password":"…"}' https://….trycloudflare.com/api/login
  ```
