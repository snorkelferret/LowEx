# Deploying the proxy

**What sits between the internet and the portal.** One file —
[`nginx/lowexpectations.conf`](nginx/lowexpectations.conf) — and the four things
around it that make it safe.

```
visitor ──TLS──▶ Cloudflare ──TLS──▶ nginx (this) ──plain──▶ 127.0.0.1:5000
                 orange cloud        Cloudflare Origin Cert     the portal
```

The portal binds loopback (TODO 44) and **never faces the network**. nginx is
the only process that talks to it, and nginx is reachable only from Cloudflare.
Both halves of that sentence are required; either one alone is decoration.

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
sudo cp nginx/lowexpectations.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/lowexpectations.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

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

## What this does not cover

| | |
|---|---|
| **Perforce** | `p4d` is TCP, not HTTP, and its access control is its *protections*, not a proxy. `vcs.lowexpectations.zone` is a separate service — read TODO 88's `IMPORTANT` note before creating that name. |
| **Helix Swarm**, if it is ever added | An HTML-serving sibling on the registrable domain changes what the session cookie means. That is the CSRF decision in `docs/DEPLOY.md` §4, not a proxy setting. |
| **Rate limiting and bot protection** | Belong at Cloudflare, where the reputation data is (TODO 48), not here and not in the application. |
| **The application's own upload limit** | `client_max_body_size` is a transport ceiling of 6 GB, above the default 5 GB workspace allowance. A per-request limit inside the app is still wanted (TODO item 9). |
| **Backups, passwords, the rest of go-live** | `docs/DEPLOY.md`. This folder answers "how is it exposed"; that one answers "is it ready". |
