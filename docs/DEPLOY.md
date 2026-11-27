# Running RapidBooks on the office server

RapidBooks is one program on one Linux machine (the "server"). It keeps the books in a
single SQLite file and serves the app to the other desktops (the "clients"), which open
it in Chromium. This guide covers installing it, the password, HTTPS, the client
launchers, backups, restoring, updating, moving to a new machine, and reading the log.

Commands marked `server$` are typed on the server, `client$` on a client desktop.

## 1. What you need

- A Linux machine that stays on (Debian/Ubuntu shown; others work the same way).
- **Node.js 22 or newer** with npm. Debian/Ubuntu: install from NodeSource
  (`https://github.com/nodesource/distributions`), then check `node -v`.
- Build tools, in case the SQLite driver has to compile for your Node version:
  `sudo apt install build-essential python3`.
- `rsync`, `openssl`, `curl` (usually already there).

## 2. Install

Copy the RapidBooks folder to the server (USB stick, `scp`, or `git clone`), then:

```
server$ cd rapidbooks
server$ sudo ./deploy/install.sh
```

The script can be run again at any time (it does not touch your data). It:

1. checks Node is 22 or newer;
2. creates a system user `rapidbooks` and the data folder `/var/lib/rapidbooks`;
3. copies the app to `/opt/rapidbooks`, runs `npm ci` and `npm run build`;
4. creates `/etc/rapidbooks.env` from `deploy/rapidbooks.env.example` if it is missing;
5. installs and enables the systemd service `rapidbooks`, and the helper `rapidbooks-admin`;
6. starts the service if a password is set, or tells you to set one.

### Set the password

There is one password for the installation. It is stored as a scrypt hash in
`/var/lib/rapidbooks/auth.json` — never in the database, because backups get copied around.

```
server$ sudo rapidbooks-admin set-password
server$ sudo systemctl restart rapidbooks
```

(The same without the helper:
`cd /opt/rapidbooks && sudo -u rapidbooks npx tsx packages/server/src/auth/set-password.ts`,
with the settings from `/etc/rapidbooks.env` in the environment.)

The password is typed twice and not shown. Changing it logs everyone out. She stays
logged in on each desktop for 30 days after she last used it; File > Log Off ends it.
After 5 wrong passwords from one computer, each further try has to wait (1 s, 2 s,
4 s … up to a minute).

Without a password RapidBooks only runs when it listens on 127.0.0.1 (this machine
only). With `HOST=0.0.0.0` and no password it refuses to start and says why.
`RAPIDBOOKS_NO_AUTH=1` overrides that, for people who really want an open server.
Without a password the server answers only when the address bar shows an IP address,
`localhost`, or this machine's own name (also `<name>.local`): a web page on another
site cannot reach it by pointing its own name at this machine. To use another name,
list it in `RAPIDBOOKS_ALLOWED_HOSTS`.

### Check it

```
server$ sudo systemctl status rapidbooks
server$ sudo rapidbooks-admin health        # {"ok":true,"version":"1.0.0","database":"ok"}
```

## 3. Settings

All settings are in `/etc/rapidbooks.env` (every one is explained in the file). After
changing it: `sudo systemctl restart rapidbooks`.

| Setting | Default | What it is |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to listen on; `0.0.0.0` for the LAN |
| `PORT` | `3001` | TCP port |
| `RAPIDBOOKS_DB` | `<app>/data/rapidbooks.db` (`/var/lib/rapidbooks/rapidbooks.db` in the example) | The database; its folder is the data folder |
| `RAPIDBOOKS_BACKUP_DIR` | `<data folder>/backups` | Where backups go — **point it at another machine** |
| `RAPIDBOOKS_BACKUP_TIME` | `02:00` | Nightly backup time (local, 24 h), or `off` |
| `RAPIDBOOKS_AUTH_FILE` | `<data folder>/auth.json` | The password hash |
| `RAPIDBOOKS_SESSION_FILE` | `<data folder>/sessions.json` | Logged-in sessions (survive restarts) |
| `RAPIDBOOKS_NO_AUTH` | unset | `1` = allow no password on a LAN address |
| `RAPIDBOOKS_ALLOWED_HOSTS` | unset | Without a password: other names the server answers to (comma-separated) |
| `RAPIDBOOKS_TLS_CERT`, `RAPIDBOOKS_TLS_KEY` | unset | Both set = HTTPS |
| `RAPIDBOOKS_WEB_DIST` | `<app>/packages/web/dist` | The built web app |
| `RAPIDBOOKS_SMTP_*` | | E-mail, see `docs/EMAIL.md` |

## 4. Firewall

Let the clients reach the port (3001 unless you changed `PORT`), from the LAN only:

```
server$ sudo ufw allow from 192.168.1.0/24 to any port 3001 proto tcp      # ufw (Ubuntu)
server$ sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.1.0/24 port port=3001 protocol=tcp accept' && sudo firewall-cmd --reload   # firewalld
```

Use your own network instead of `192.168.1.0/24`. Do not forward this port on the router:
RapidBooks is meant for the office network, not the internet.

## 5. HTTPS, and why it matters for the keyboard

In QuickBooks Ctrl+W is Write Checks, Ctrl+N is New, and so on. In a browser those keys
close the tab or open a window — unless the page is in full screen (View > Full Screen)
**and** uses the Keyboard Lock API, which Chromium allows only on a *secure* address:
`https://…`, `http://localhost`, or an address the browser has been told to treat as
secure. Two ways to get that on the LAN:

### A. HTTPS with your own small certificate authority (recommended)

```
server$ sudo /opt/rapidbooks/deploy/make-cert.sh books.lan 192.168.1.20
```

(the server's host name and LAN address; both default to this machine's). It creates
`/etc/rapidbooks/tls/` with a CA (`rapidbooks-ca.crt` + its key, kept on the server) and a
server certificate valid for that name and address. Running it again keeps the CA and
renews the server certificate (valid 825 days). Then in `/etc/rapidbooks.env`:

```
RAPIDBOOKS_TLS_CERT=/etc/rapidbooks/tls/server.crt
RAPIDBOOKS_TLS_KEY=/etc/rapidbooks/tls/server.key
```

and `sudo systemctl restart rapidbooks`. Login cookies are then marked Secure.

**Trust the CA on each client** (copy only `rapidbooks-ca.crt`, never the `.key`):

```
client$ sudo apt install libnss3-tools
client$ mkdir -p ~/.pki/nssdb
client$ certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "RapidBooks Local CA" -i rapidbooks-ca.crt
```

That is the store Chromium uses on Linux, per user (do it as her user; the RapidBooks
launcher uses its own browser profile but the same NSS store). Alternatively, in Chromium:
Settings > Privacy and security > Security > Manage certificates > Authorities > Import,
tick "Trust this certificate for identifying websites". For other programs (curl) also:
`sudo cp rapidbooks-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.

The server name the clients use must be one in the certificate: either the name
(`books.lan` — it must resolve, via the router's DNS or `/etc/hosts` on each client:
`192.168.1.20 books.lan`) or the IP address.

### B. Plain HTTP, telling Chromium to treat the server as secure

Simpler, no certificates, but traffic (including the password) is not encrypted on the
LAN. In the launcher (`/usr/local/bin/rapidbooks-launch`) set `TREAT_AS_SECURE=1` and an
`http://` URL. It adds
`--unsafely-treat-insecure-origin-as-secure=http://server:3001` to Chromium (with a
separate profile directory, which that flag needs).

## 6. Client computers

On each desktop:

```
client$ sudo install -m 0755 rapidbooks-launch.sh /usr/local/bin/rapidbooks-launch
client$ sudo install -m 0644 rapidbooks.desktop /usr/share/applications/rapidbooks.desktop
client$ sudo install -D -m 0644 rapidbooks.png /usr/share/icons/hicolor/256x256/apps/rapidbooks.png
```

(both from the `deploy/` folder). Put the server address in `/etc/rapidbooks-client.conf`:

```
RAPIDBOOKS_URL=https://books.lan:3001/
TREAT_AS_SECURE=0
```

"RapidBooks" then appears in the applications menu; drag it to the desktop or panel.
It opens Chromium in app mode (no address bar or tabs), full screen, with its own profile.
Inside RapidBooks, View > Full Screen turns on the keyboard capture for Ctrl+W/N/T.

## 7. Where the data lives

| What | Where |
| --- | --- |
| The books (database) | `/var/lib/rapidbooks/rapidbooks.db` (+ `-wal`, `-shm` while running) |
| Password hash | `/var/lib/rapidbooks/auth.json` |
| Login sessions | `/var/lib/rapidbooks/sessions.json` |
| Backups | `RAPIDBOOKS_BACKUP_DIR`, default `/var/lib/rapidbooks/backups` |
| Settings | `/etc/rapidbooks.env`, e-mail: see `docs/EMAIL.md` |
| TLS certificates | `/etc/rapidbooks/tls/` |
| The program | `/opt/rapidbooks` (replaceable; no data in it) |

Never copy `rapidbooks.db` while the server runs (it may be mid-write); use a backup.

## 8. Backups

- **Nightly** at `RAPIDBOOKS_BACKUP_TIME` (02:00) inside the server. If the server was off
  then, it backs up shortly after starting whenever the last good backup is over 26 hours old.
- **On demand**: File > Back Up > Back Up Now, or `sudo rapidbooks-admin backup`.
- Each backup is a consistent copy made with SQLite's online backup (safe while she works),
  checked with `PRAGMA integrity_check`, written under a temporary name and renamed when
  complete: `rapidbooks-YYYYMMDD-HHMMSS.db`. Each is a complete, standalone database file.
- **Kept**: every backup from the last 14 days; then one per week for 8 more weeks; then
  one per month going back 24 months. The newest is never deleted. Files with other names
  in the folder are never touched.
- File > Back Up shows the last backup, the folder, the recent backups and any error.
  The status bar shows a red warning while the last good backup is over 3 days old or
  the last attempt failed.
- **Save a Copy...** in File > Back Up downloads a fresh checked copy, e.g. onto a USB stick
  (on HTTPS Chromium asks where to save it; otherwise it goes to Downloads).

### Put the backups on another machine

A backup on the same disk does not survive that disk dying. Mount a shared folder from
another computer (a NAS or another desktop) and point `RAPIDBOOKS_BACKUP_DIR` at it.

NFS, in `/etc/fstab`:

```
nas.lan:/export/rapidbooks  /mnt/rapidbooks-backup  nfs  defaults,_netdev,nofail  0 0
```

SMB (Windows share / Samba), with credentials in `/root/.smb-rapidbooks` (`username=…`,
`password=…`, `chmod 600`):

```
//nas.lan/rapidbooks  /mnt/rapidbooks-backup  cifs  credentials=/root/.smb-rapidbooks,uid=rapidbooks,gid=rapidbooks,file_mode=0640,dir_mode=0750,_netdev,nofail  0 0
```

Then:

```
server$ sudo mkdir -p /mnt/rapidbooks-backup && sudo mount /mnt/rapidbooks-backup
server$ sudo chown rapidbooks:rapidbooks /mnt/rapidbooks-backup     # NFS; for SMB the uid= option does it
# in /etc/rapidbooks.env:  RAPIDBOOKS_BACKUP_DIR=/mnt/rapidbooks-backup
server$ sudo /opt/rapidbooks/deploy/install.sh     # re-run: lets the service write there
server$ sudo rapidbooks-admin backup               # test it
```

Re-running `install.sh` writes `/etc/systemd/system/rapidbooks.service.d/backup-dir.conf`
(`ReadWritePaths=` for the folder), which the service's hardening otherwise blocks. When
`RAPIDBOOKS_BACKUP_DIR` is set RapidBooks never creates that folder, so if the mount is
missing the backup fails loudly (and the warning shows) instead of filling the local disk.
Avoid a folder under `/home` (the service cannot see `/home`).

## 9. Restoring a backup

Restoring is a command, not a menu item. It checks the backup first, and keeps the current
database (renamed `rapidbooks.db.before-restore-YYYYMMDD-HHMMSS`) rather than deleting it.

```
server$ sudo systemctl stop rapidbooks
server$ sudo rapidbooks-admin restore /mnt/rapidbooks-backup/rapidbooks-20261110-020000.db
server$ sudo systemctl start rapidbooks
```

The underlying command is
`npx tsx packages/server/src/backup/restore.ts <backup-file> [--db path]` (run in
`/opt/rapidbooks` as the `rapidbooks` user). It refuses while the server is running on that
database (it sees `rapidbooks.db.server.json`, which the server keeps while running), and
refuses a damaged or foreign file without touching anything. To go back, stop the service
and restore the `before-restore` file the same way.

## 10. Updating

```
server$ sudo /opt/rapidbooks/deploy/update.sh /path/to/new/rapidbooks
```

(or with no argument if `/opt/rapidbooks` is a git checkout: it does `git pull`). It stops
the service, makes a backup (and stops there if the backup fails), copies the new version,
runs `npm ci` and the build, starts the service and waits for `/api/health`.

## 11. Moving to a new server

1. On the new machine: install Node, copy the RapidBooks folder, `sudo ./deploy/install.sh`.
2. Copy `/etc/rapidbooks.env` (and `/etc/rapidbooks/tls/` if you use HTTPS — or make new
   certificates with the same CA; if the IP address or name changes, run `make-cert.sh` with
   the new ones) and mount the backup folder as before.
3. On the old server: `sudo systemctl stop rapidbooks`, then `sudo rapidbooks-admin backup`.
4. On the new server: `sudo systemctl stop rapidbooks`,
   `sudo rapidbooks-admin restore <that backup>`, copy `auth.json` from the old
   `/var/lib/rapidbooks/` (or set the password again), `sudo systemctl start rapidbooks`.
5. Point the clients at the new address (`/etc/rapidbooks-client.conf`) and open the firewall.
6. Check Help > About RapidBooks (F2): database path, transaction count, last backup.

## 12. The service log and troubleshooting

```
server$ journalctl -u rapidbooks -f            # follow the log
server$ journalctl -u rapidbooks -n 100        # the last 100 lines
server$ journalctl -u rapidbooks --since today
server$ sudo systemctl restart rapidbooks
```

The log shows start-up (address, database, backup folder and time), each backup, failures
in plain words, and a clean "RapidBooks stopped cleanly." on stop (it finishes requests,
waits for a running backup, checkpoints the WAL and closes the database).

- *"RapidBooks will not start: … no password has been set"*: set the password (section 2).
- *"cannot listen on …: EADDRINUSE"*: something else uses the port; change `PORT`.
- Backup warning in the status bar: open File > Back Up for the reason; usually the backup
  mount is not connected (`mount | grep rapidbooks`, `sudo mount -a`).
- Help > About RapidBooks (F2) shows the version, server address, database file and size,
  transaction count and the last backup.
