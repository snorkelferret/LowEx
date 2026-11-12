# Deploying the proxy

**What sits between the internet and the portal.** One file —
[`nginx/lowexpectations.conf.template`](nginx/lowexpectations.conf.template) —
rendered by [`nginx/install.sh`](nginx/install.sh) — and the four things
around it that make it safe.

```
visitor ──TLS──▶ Cloudflare ──TLS──▶ nginx (this) ──plain──▶ 127.0.0.1:5000
                 orange cloud        Cloudflare Origin Cert     the portal
```

The portal binds loopback (TODO 44) and **never faces the network**. nginx is
the only process that talks to it, and nginx is reachable only from Cloudflare.
Both halves of that sentence are required; either one alone is decoration.

---

## The installer

**One facts file, one part per thing being deployed.**

```bash
cp deploy/site.env.example deploy/site.env     # addresses, paths, accounts
$EDITOR deploy/site.env

bash deploy/install.sh --dry-run --only portal # what it would do
sudo -E bash deploy/install.sh --only portal
```

| Part | What it installs | State |
|---|---|---|
| `portal` | Sanity checks, the proxy config, `lowex-portal.service`, `lowex-daily.service`/`.timer`, then proof (`systemctl is-active`, the portal answering, `npm run check`) | **built** |
| `perforce` | The depot, stream, typemap, groups, protections (on request), the trigger, and a real-submit proof | **built** (TODO 88) |
| `backups` | A daily verified backup of the database + content store, and the depot's checkpoint, journal and files | **built** (DEPLOY §5) |

**The backup part is verified, not assumed.** It copies the database with
`sqlite3 .backup` (safe against a live server) and the content store, then runs
`check:store` against the copy — a database without its files is a store full of
references to content that is not there. A failed verification fails the run, so
the timer records it. The depot is checkpointed and its journal and versioned
files travel with the checkpoint. Old dated directories are removed only after a
new backup has succeeded. It warns if `BACKUP_DIR` is on the same filesystem as
the checkout: a backup on the failed disk is not a backup.

**The Perforce part is guarded rather than convenient.** It is a dry run
unless `--apply` is given; protections are shown and never applied without
`--apply-protections` as a separate decision; the typemap is checked **before**
anything is added and the installer refuses if the depot already holds files it
does not cover (their type is fixed at add); and `--test-notification` performs
a **real submit** and reads the portal's cursor back with the trigger's own
credential.

Each part is self-contained, idempotent, and reads the same `site.env` — that is
what lets them be run alone and combined. **No part holds an address of its
own**, and `npm run check:config` refuses one in `deploy/` as it would in the
application.

`site.env` carries **no credential**: secrets stay in the portal's `.env` and in
the trigger's own 0600 file.

---

## Before the config goes in

### 1. The origin is reachable only from Cloudflare

If the origin answers anybody, every Cloudflare rule is bypassable by
connecting straight to the IP with the right `Host` header (TODO 48). Two ways:

- **Firewall the origin** to Cloudflare's published ranges — see below, and
  leave SSH open only to your own addresses.
- **Or run a Cloudflare Tunnel**: `cloudflared` connects *out* to Cloudflare
  and forwards to `127.0.0.1:5000`. **No inbound port exists at all**, which is
  stronger, and it makes this nginx config unnecessary — there is nothing to
  proxy. Item 48 names both; the tunnel is the one with less to get wrong.

Pick one. If you pick the tunnel, stop reading the nginx sections.

### 2. Cloudflare's ranges (nginx and the firewall both need them)

They change, so they are generated rather than pasted:

```bash
{
  for ip in $(curl -s https://www.cloudflare.com/ips-v4); do echo "set_real_ip_from $ip;"; done
  for ip in $(curl -s https://www.cloudflare.com/ips-v6); do echo "set_real_ip_from $ip;"; done
  echo "real_ip_header CF-Connecting-IP;"
} | sudo tee /etc/nginx/cloudflare-ips.conf
```

**Refresh it monthly.** A stale list means either a visitor's address is
reported as Cloudflare's, or — worse for the firewall below — a legitimate
Cloudflare address is refused and some visitors cannot reach the portal at all.
The same list feeds the firewall rule; generate it once and use it for both.

With `real_ip` in place, `$remote_addr` is the visitor, `X-Forwarded-For`
carries the visitor, and the portal's logs and any future rate limiting see a
real person rather than Cloudflare.

### 3. A Cloudflare Origin Certificate

In the Cloudflare dashboard: **SSL/TLS → Origin Server → Create Certificate**,
for `lowexpectations.zone` and `*.lowexpectations.zone`. Install the pair at the
paths the config expects (`/etc/ssl/cloudflare/`), readable by root only, and
set the zone's SSL/TLS mode to **Full (strict)**.

Let's Encrypt is not used here on purpose: with the origin reachable only from
Cloudflare, an ACME HTTP-01 challenge has nothing at the origin to answer it.

### 4. The application knows it is behind a proxy

`backend/server.js` sets `trust proxy` to loopback. That is only safe **because
of step 1** — nothing but the proxy can reach the app, so nothing else can
forge the forwarded headers. Do not set it before the origin is protected.

---

## Installing it

```bash
sudo -E PUBLIC_HOST=lowexpectations.zone \
        CERT_DIR=/etc/ssl/cloudflare \
        UPSTREAM=127.0.0.1:5000 \
        bash nginx/install.sh
sudo ln -sf /etc/nginx/sites-available/lowexpectations.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**The domain, the certificate and the upstream are values, not edits.** The file
in git is a template; `install.sh` substitutes `PUBLIC_HOST`, `CERT_DIR` and
`UPSTREAM`, and only those three — nginx's own `$host` and `$proxy_add_x_forwarded_for`
must survive. `npm run check:config` refuses a literal address in the template,
so it cannot quietly become a file somebody edits when the portal moves.

`nginx -t` first, always. A reload with a bad config leaves the old one running,
which is the good outcome; a restart would not.

---

## Proving it

From **another machine** — not the origin:

```bash
curl -I https://lowexpectations.zone            # 200 or 3xx, and an HSTS header
curl -m 5 http://<origin-ip>:5000/              # must FAIL — refused
curl -m 5 -k https://<origin-ip>/ -H 'Host: lowexpectations.zone'   # must FAIL
```

The second and third are the ones people skip. The third is the interesting
one: it is what an attacker does, and it must fail because the firewall refuses
a connection that did not come from Cloudflare — not because the application
looks at the `Host` header.

On the origin:

```bash
sudo ss -ltn | grep -E ':80|:443|:5000'   # 80/443 public, 5000 on 127.0.0.1
sudo tail -f /var/log/nginx/access.log    # the visitor's address, not Cloudflare's
```

And in a browser, signed in: **devtools → Application → Cookies** — the session
cookie is `Secure` and `HttpOnly`. If it is not `Secure`, `NODE_ENV` is not
`production` (see `docs/DEPLOY.md` §1).

---

## The nightly job

The portal's garbage collection runs from a **systemd timer**, not from cron and
not from a startup script. Files: `systemd/lowex-daily.service` and
`systemd/lowex-daily.timer`.

**Why a timer.** A startup hook runs once per boot; a server that stays up for
months would then never collect again — which is the shape of the failure the
steward found on 2026-10-30 (runs on three days, a 24-day gap). `Persistent=true`
is the part that does what a startup hook should: a run missed because the
machine was down happens once when it comes back.

**Why the service file is here but the portal's own unit is not.** The timer is
self-contained — it needs a working directory, a user and a node binary.
Supervising the *application* (which user, which environment file, restart
policy, log handling) is a deployment decision that belongs with the VPS, and
is recorded as outstanding in TODO 102. The timer can be installed before any of
that is settled.

### Installing it

```bash
sudo cp deploy/systemd/lowex-daily.* /etc/systemd/system/
```

Edit both files first:

- `WorkingDirectory` — where the repository is checked out
- `User` / `Group` — who owns `backend/database.db` and `backend/uploads/`
- `RequiresMountsFor=` — the path under which that checkout lives
- `/usr/bin/flock` — correct if the host keeps it elsewhere; it ships with
  util-linux on Debian and Ubuntu

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lowex-daily.timer     # the TIMER, not the service
```

Enabling the service as well would run the job at boot in addition to the
schedule. The timer starts the service; nothing else should.

### Proving it runs

```bash
systemctl list-timers lowex-daily.timer          # NEXT and LAST
sudo systemctl start lowex-daily.service         # one run now, by hand
journalctl -u lowex-daily.service -n 30          # the run's own output
```

Then the record, which is the point:

```bash
sqlite3 website/backend/database.db \
  "SELECT created_at, details FROM audit_logs
   WHERE action = 'store.daily_job' ORDER BY id DESC LIMIT 3;"
```

A row per run, with what was purged and collected. **The row does not say which
mode ran** — a hand-run report and a nightly `--collect` look the same — so
check the counts (a report run collects nothing) until that is fixed (TODO 101).

After a day, `systemctl list-timers` should show LAST as last night and NEXT as
tonight. If LAST stays empty, the timer is not enabled or the service is failing
— `journalctl -u lowex-daily.service` says which.

---

## What this does not cover

| | |
|---|---|
| **Perforce** | `p4d` is TCP, not HTTP, and its access control is its *protections*, not a proxy. `vcs.lowexpectations.zone` is a separate service — read TODO 88's `IMPORTANT` note before creating that name. |
| **Helix Swarm**, if it is ever added | An HTML-serving sibling on the registrable domain changes what the session cookie means. That is the CSRF decision in `docs/DEPLOY.md` §4, not a proxy setting. |
| **Rate limiting and bot protection** | Belong at Cloudflare, where the reputation data is (TODO 48), not here and not in the application. |
| **The application's own upload limit** | `client_max_body_size` is a transport ceiling of 6 GB, above the default 5 GB workspace allowance. A per-request limit inside the app is still wanted (TODO item 9). |
| **Backups, passwords, the rest of go-live** | `docs/DEPLOY.md`. This folder answers "how is it exposed"; that one answers "is it ready". |
