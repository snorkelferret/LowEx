#!/usr/bin/env bash
#
# deploy/portal/install.sh — the portal host.
#
# Installs what DEPLOY.md §1–3 describe for the application itself:
#
#   1. sanity: the checkout, node, the environment file and its JWT_SECRET
#   2. the proxy config, rendered from the template
#   3. the systemd units — the portal service and the nightly timer
#   4. enable and start them
#   5. proof: the service is active, the portal answers, the checks pass
#
# IDEMPOTENT: re-running installs the same files and enables the same units.
# DRY-RUN: prints every action and changes nothing.
#
# It does NOT rotate passwords (interactive, DEPLOY §2) and does NOT place the
# origin — the Cloudflare range firewall or Tunnel (deploy/README.md).

set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '  %s\n' "$*"; }

die() {
    printf '\n  FAILED: %s\n\n' "$*" >&2
    exit 1
}

run() {
    if [ "$DRY_RUN" = "1" ]; then
        say "would: $*"
        return 0
    fi

    "$@"
}

# THE FACTS ARE REQUIRED, WITH NO DEFAULTS: an address chosen here is an address
# nobody decided. CERT_DIR has a conventional default only because it is a
# path, not an address.
for required in PUBLIC_HOST UPSTREAM CHECKOUT SERVICE_USER SERVICE_GROUP PORTAL_URL; do
    if [ -z "${!required:-}" ]; then
        die "$required is not set — see deploy/site.env.example"
    fi
done

CERT_DIR="${CERT_DIR:-/etc/ssl/cloudflare}"
export PUBLIC_HOST UPSTREAM CERT_DIR

# ---------------------------------------------------------------------------
# 1. Sanity
# ---------------------------------------------------------------------------

say "portal      : $CHECKOUT/website"
say "public host : $PUBLIC_HOST"
say "upstream    : $UPSTREAM"
say "service user: $SERVICE_USER:$SERVICE_GROUP"

[ -f "$CHECKOUT/website/package.json" ] \
    || die "no checkout at $CHECKOUT/website — set CHECKOUT"

command -v node >/dev/null 2>&1 \
    || die "node is not on PATH; the portal runs as $SERVICE_USER"

ENV_FILE="$CHECKOUT/website/.env"

[ -f "$ENV_FILE" ] || die "no $ENV_FILE — the portal refuses to start without it"

grep -Eq '^JWT_SECRET=.+' "$ENV_FILE" \
    || die "$ENV_FILE has no JWT_SECRET; the portal refuses to start without one"

# NAMES ONLY. The values of PUBLIC_URL and CLIENT_URL are not secrets, but the
# token beside them is — so only the keys that matter here are read out.
for key in NODE_ENV PUBLIC_URL CLIENT_URL; do
    value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
    say "$(printf '%-12s: %s' "$key" "${value:-<unset>}")"
done

if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" != "0" ]; then
    die "system files need root — run with sudo -E"
fi

# ---------------------------------------------------------------------------
# 2. The proxy
# ---------------------------------------------------------------------------

say "rendering the proxy config"

run bash "$HERE/nginx/install.sh"

# ---------------------------------------------------------------------------
# 3. The units
# ---------------------------------------------------------------------------

SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

for unit in lowex-portal.service lowex-daily.service; do
    template="$HERE/systemd/${unit}.template"
    [ -f "$template" ] || die "missing template $template"

    say "rendering $unit"

    if [ "$DRY_RUN" = "1" ]; then
        say "would: envsubst into $SYSTEMD_DIR/$unit"
        continue
    fi

    rendered="$(mktemp)"
    trap 'rm -f "$rendered"' EXIT

    envsubst '${CHECKOUT} ${SERVICE_USER} ${SERVICE_GROUP}' \
        < "$template" > "$rendered"

    install -m 0644 "$rendered" "$SYSTEMD_DIR/$unit"
    rm -f "$rendered"
    trap - EXIT
done

say "installing lowex-daily.timer"
run install -m 0644 "$HERE/systemd/lowex-daily.timer" "$SYSTEMD_DIR/lowex-daily.timer"

# ---------------------------------------------------------------------------
# 4. Enable and start
# ---------------------------------------------------------------------------

run systemctl daemon-reload
run systemctl enable --now lowex-portal.service
run systemctl enable --now lowex-daily.timer

# ---------------------------------------------------------------------------
# 5. Proof
# ---------------------------------------------------------------------------

if [ ! -d "$CHECKOUT/website/frontend/dist" ]; then
    say "frontend/dist is missing — run: cd $CHECKOUT/website && npm ci && npm run build"
fi

if [ "$DRY_RUN" = "1" ]; then
    say "would: wait for the portal, then run npm run check"
    exit 0
fi

active="$(systemctl is-active lowex-portal.service || true)"
[ "$active" = "active" ] || die "lowex-portal.service is $active — see journalctl -u lowex-portal"
say "lowex-portal.service: active"

if ! curl -fsS --retry 5 --retry-delay 1 -o /dev/null "http://$UPSTREAM/"; then
    die "the portal is active but did not answer on $UPSTREAM"
fi
say "the portal answers on $UPSTREAM"

say "running the checks"
( cd "$CHECKOUT/website" && npm run --silent check )
