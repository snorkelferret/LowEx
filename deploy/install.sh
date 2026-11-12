#!/usr/bin/env bash
#
# deploy/install.sh — run the parts of a deployment, in order.
#
#   ./install.sh                       # every part that exists
#   ./install.sh --only portal         # one part
#   ./install.sh --only portal --dry-run
#   ./install.sh --env /path/to/site.env
#
# EACH PART IS SELF-CONTAINED and reads the same file. That is what lets them be
# run alone and combined: no part decides an address for itself.
#
# This script does not install anything by itself — it validates the facts file
# and dispatches.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PART="all"
DRY_RUN="0"
ENV_FILE="$HERE/site.env"

usage() {
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --only)    PART="${2:-}"; shift 2 ;;
        --dry-run) DRY_RUN="1"; shift ;;
        --env)     ENV_FILE="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$PART" in
    all|portal|perforce|backups) ;;
    *) echo "Unknown part: $PART (all, portal, perforce, backups)" >&2; exit 2 ;;
esac

if [ ! -r "$ENV_FILE" ]; then
    echo "No facts file at $ENV_FILE." >&2
    echo "Copy deploy/site.env.example to deploy/site.env and fill it in." >&2
    exit 2
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

export DRY_RUN

run_part() {
    local name="$1"
    local script="$HERE/$name/install.sh"

    if [ ! -x "$script" ]; then
        echo "  $name : NOT BUILT YET — no $name/install.sh"
        return 1
    fi

    echo
    echo "============================================================"
    echo "  $name"
    echo "============================================================"

    bash "$script"
    return 0
}

missing=0

if [ "$PART" = "all" ]; then
    for name in portal perforce backups; do
        run_part "$name" || missing=$((missing + 1))
    done
else
    if ! run_part "$PART"; then
        echo "The $PART part is not built yet." >&2
        exit 2
    fi
fi

echo
if [ "$missing" -gt 0 ]; then
    echo "Done, with $missing part(s) not built yet."
else
    echo "Done."
fi

if [ "$DRY_RUN" = "1" ]; then
    echo "(dry run — nothing was changed)"
fi
