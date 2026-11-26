# Running RapidBooks in Docker (older Linux)

For a Linux machine whose own Node.js is too old for RapidBooks and cannot be upgraded:
Linux Mint 19, Ubuntu 18.04 and similar (Node 18+ needs glibc 2.28; these have 2.27).
The container brings its own Node 24, so the age of the system does not matter. 64-bit
(x86_64) only. On a current Linux, use the normal install in `docs/DEPLOY.md` instead.

**Tested:** installed and running on Linux Mint 19 (Docker from `docker.io`) on an AMD
FX-8150, November 2026. That CPU has no AVX2, so Vite's bundler cannot run on it
("Illegal instruction"); the script downloads the web app that GitHub builds for each
commit (`.github/workflows/web-dist.yml`) instead of building it there. That download
needs a git clone, not a ZIP, and the workflow to have finished for the commit.

## Install

```
sudo apt install docker.io git curl chromium-browser
git clone https://github.com/ByrelMitchell/rapidbooks.git     # or copy the folder over
cd rapidbooks
sudo ./deploy/docker-install.sh
```

It builds the image (a few minutes the first time), creates the data folder
`/var/lib/rapidbooks`, puts the **demo company** in it if there is no database yet
(`--empty` for a blank company instead), starts the container, waits until it answers,
and adds **RapidBooks** to the applications menu. Then open http://localhost:3001/.

By default it listens on this computer only (127.0.0.1) and asks for no password.
`--lan` makes it reachable from the other computers on the network; it then asks for a
password the first time. (Docker opens the port past `ufw`, so the password matters.)

The container starts again by itself after a reboot (`--restart unless-stopped`).

## Update

```
cd rapidbooks
git pull
sudo ./deploy/docker-install.sh          # same options as the first time
```

It stops the container cleanly, copies the database to
`/var/lib/rapidbooks/backups/before-update-<date>.db`, rebuilds and starts again.

## Where things are

| What | Where |
| --- | --- |
| Database | `/var/lib/rapidbooks/rapidbooks.db` |
| Backups (nightly 02:00, local time) | `/var/lib/rapidbooks/backups/` |
| Password hash (with `--lan`) | `/var/lib/rapidbooks/auth.json` |
| E-mail settings | `/var/lib/rapidbooks/smtp.json` (see `docs/EMAIL.md`) |

## Everyday commands

```
sudo docker logs -f rapidbooks                 # the log
sudo docker restart rapidbooks
sudo docker ps                                 # STATUS shows (healthy) when it is fine
sudo docker run --rm -it -v /var/lib/rapidbooks:/data rapidbooks \
     node --import tsx packages/server/src/auth/set-password.ts      # change the password
```

To restore a backup: `sudo docker stop rapidbooks`, then
`sudo docker run --rm -v /var/lib/rapidbooks:/data rapidbooks node --import tsx packages/server/src/backup/restore.ts /data/backups/<file>.db`,
then `sudo docker start rapidbooks`.
