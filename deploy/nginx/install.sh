#!/usr/bin/env bash
#
# deploy/nginx/install.sh — render the proxy config from the environment.
#
#   PUBLIC_HOST=lowexpectations.zone \
#   CERT_DIR=/etc/ssl/cloudflare \
#   UPSTREAM=127.0.0.1:5000 \
#       sudo -E bash deploy/nginx/install.sh [output path]
#
# The template holds no address of its own (check:config enforces that), so the
# domain, the certificate location and the upstream are values at install time —
# which is what makes "run it locally, then change the URLs" a config change and
# not an edit.
#
# ONLY THE THREE NAMED VARIABLES ARE SUBSTITUTED. nginx has its own $host,
# $scheme and $proxy_add_x_forwarded_for, and substituting those would quietly
# break the proxy — envsubst is given an explicit list for that reason.

set -euo pipefail

: "${PUBLIC_HOST:?PUBLIC_HOST is required — the domain visitors use}"
: "${UPSTREAM:?UPSTREAM is required — host:port the portal listens on}"

CERT_DIR="${CERT_DIR:-/etc/ssl/cloudflare}"

OUT="${1:-/etc/nginx/sites-available/lowexpectations.conf}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

envsubst '${PUBLIC_HOST} ${CERT_DIR} ${UPSTREAM}' \
    < "$HERE/lowexpectations.conf.template" > "$TMP"

install -m 0644 "$TMP" "$OUT"

echo "Written: $OUT"
echo "  public host : $PUBLIC_HOST"
echo "  certificate : $CERT_DIR/$PUBLIC_HOST.pem"
echo "  upstream    : $UPSTREAM"
echo
echo "Next:"
echo "  sudo ln -sf $OUT /etc/nginx/sites-enabled/"
echo "  sudo nginx -t && sudo systemctl reload nginx"
