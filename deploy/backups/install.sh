#!/usr/bin/env bash
#
# deploy/backups/install.sh — the backups part.
#
#   install.sh                    DRY RUN: prints every action
#   install.sh --apply            installs the script and the timer
#   install.sh --apply --run-backup   ...and takes one backup now, verified
#
# WHAT IT INSTALLS:
#
#   the backup script      at $BACKUP_SCRIPT, from deploy/backups/backup.sh
#   lowex-backup.service   a oneshot that runs it with the facts file
#   lowex-backup.timer     daily at 04:47, Persistent=true
#
# THE BACKUP ITSELF IS VERIFIED, not assumed: it runs check:store against the
# copy, because a database without its files is a store full of references to
# content that is not there (DEPLOY §5). A failed verification fails the run,
# so the timer records a failure.
#
# NO CREDENTIAL LIVES HERE. The depot checkpoint uses the super-user name from
# site.env; passwords and tickets are Perforce's own.

set -euo pipefail

APPLY="0"
RUN_BACKUP="0"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --apply)      APPLY="1"; shift ;;
        --run-backup) RUN_BACKUP="1"; shift ;;
        -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -r "$DEPLOY_DIR/site.env" ]; then
    # shellcheck disable=SC1091
    set -a; . "$DEPLOY_DIR/site.env"; set +a
fi

say() { printf '  %s\n' "$*"; }

die() {
    printf '\n  FAILED: %s\n\n' "$*" >&2
    exit 1
}

run() {
    if [ "$APPLY" = "0" ]; then
        say "would: $*"
        return 0
    fi

    "$@"
}

for required in CHECKOUT BACKUP_DIR BACKUP_SCRIPT; do
    if [ -z "${!required:-}" ]; then
        die "$required is not set — see deploy/site.env.example"
    fi
done

say "checkout    : $CHECKOUT"
say "backups     : $BACKUP_DIR"
say "script      : $BACKUP_SCRIPT"
[ "$APPLY" = "1" ] && say "mode        : APPLY" || say "mode        : DRY RUN"

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

[ -f "$CHECKOUT/website/backend/database.db" ] \
    || die "no database at $CHECKOUT/website/backend/database.db"

[ -d "$CHECKOUT/website/backend/uploads/files" ] \
    || die "no content store at $CHECKOUT/website/backend/uploads/files"

command -v sqlite3 >/dev/null 2>&1 \
    || die "sqlite3 is not installed — the database copy uses its .backup command"

# A BACKUP ON THE SAME FILESYSTEM IS NOT OFF THE BOX. The timer protects
# against deletion and corruption; only a different volume protects against the
# disk. Said here because it is easy to install this and believe otherwise.
if [ -d "$BACKUP_DIR" ] \
   && [ "$(stat -c %d "$BACKUP_DIR" 2>/dev/null)" = "$(stat -c %d "$CHECKOUT" 2>/dev/null)" ]; then
    say "WARNING: $BACKUP_DIR is on the same filesystem as $CHECKOUT"
    say "         an off-box copy is still needed — a backup on the failed disk is not a backup"
fi

[ -r "$CHECKOUT/deploy/site.env" ] \
    || say "NOTE: $CHECKOUT/deploy/site.env is not present; the installed timer will pass that path and the script will run without facts"

if [ "$APPLY" != "1" ] && [ "$(id -u)" != "0" ]; then
    say "(dry run as a non-root user; --apply will need sudo -E)"
fi

if [ "$APPLY" = "1" ] && [ "$(id -u)" != "0" ]; then
    die "system files need root — run with sudo -E"
fi

# ---------------------------------------------------------------------------
# The script
# ---------------------------------------------------------------------------

if [ "$(readlink -f "$HERE/backup.sh")" = "$(readlink -f "$BACKUP_SCRIPT" 2>/dev/null || echo "$BACKUP_SCRIPT")" ]; then
    say "backup script is already at $BACKUP_SCRIPT"
else
    say "installing the backup script at $BACKUP_SCRIPT"
    run install -D -m 0700 "$HERE/backup.sh" "$BACKUP_SCRIPT"
fi

# ---------------------------------------------------------------------------
# The units
# ---------------------------------------------------------------------------

SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

say "rendering lowex-backup.service"

if [ "$APPLY" = "1" ]; then
    rendered="$(mktemp)"
    trap 'rm -f "$rendered"' EXIT

    envsubst '${CHECKOUT} ${BACKUP_SCRIPT}' \
        < "$HERE/../systemd/lowex-backup.service.template" > "$rendered"

    install -m 0644 "$rendered" "$SYSTEMD_DIR/lowex-backup.service"
    rm -f "$rendered"
    trap - EXIT
else
    say "would: envsubst into $SYSTEMD_DIR/lowex-backup.service"
fi

say "installing lowex-backup.timer"
run install -m 0644 "$HERE/../systemd/lowex-backup.timer" "$SYSTEMD_DIR/lowex-backup.timer"

run systemctl daemon-reload
run systemctl enable --now lowex-backup.timer

# ---------------------------------------------------------------------------
# One backup now, if asked
# ---------------------------------------------------------------------------

if [ "$RUN_BACKUP" = "1" ]; then
    [ "$APPLY" = "1" ] || die "--run-backup needs --apply"

    say "running one backup now (the timer's service, so the unit is proved too)"

    if ! systemctl start lowex-backup.service; then
        die "the backup service failed — see journalctl -u lowex-backup"
    fi

    latest="$(ls -1dt "$BACKUP_DIR"/2*T*Z 2>/dev/null | head -1 || true)"

    [ -n "$latest" ] || die "no backup directory was written under $BACKUP_DIR"

    [ -f "$latest/portal/database.db" ] || die "$latest has no database copy"
    [ -d "$latest/portal/files" ] || die "$latest has no content store copy"

    say "backup written and verified: $latest"
fi

# ---------------------------------------------------------------------------
# Proof
# ---------------------------------------------------------------------------

say "proof:"
say "  timer   : $(systemctl list-timers --no-pager lowex-backup.timer 2>/dev/null | sed -n '2p' | sed 's/  */ /g' || echo 'not shown on this host')"
say "  backups : $(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l) dated director(ies) in $BACKUP_DIR"

if [ "$APPLY" = "0" ]; then
    say ""
    say "DRY RUN — nothing was changed. Re-run with --apply."
fi
