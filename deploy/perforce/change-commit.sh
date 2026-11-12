#!/usr/bin/env bash
#
# deploy/perforce/change-commit.sh
#
# THE TRIGGER THAT TELLS THE PORTAL SOMETHING WAS COMMITTED.
#
# ============================================================
# IT RUNS AFTER THE COMMIT, AND IT CANNOT STOP ONE
# ============================================================
#
# Installed as a `change-commit` trigger, which Perforce runs AFTER the submit
# has been committed (TODO 88 §15). Two consequences, both intended:
#
#   * a failure here loses a NOTIFICATION, never a developer's submit;
#   * so THIS SCRIPT ALWAYS EXITS 0, and reports problems to its log instead.
#
# An admin token does not belong in a trigger, so the notification is
# authenticated by its OWN secret — PERFORCE_TRIGGER_TOKEN — which can do one
# thing: write a notification row.
#
# ============================================================
# INSTALLING IT
# ============================================================
#
# In the Perforce trigger table, for the stream(s) that matter:
#
#   Triggers:
#       lowex-change-commit change-commit //LowExpectations/... \
#           "bash /path/to/change-commit.sh %changelist% %user% %client% /etc/lowex/perforce-trigger.env"
#
# The fourth argument is the environment file, and it is where the secrets
# live — NOT in this file, which is in git. It needs:
#
#   PORTAL_URL=http://127.0.0.1:5000
#   PERFORCE_TRIGGER_TOKEN=<the same value as the portal's .env>
#
# ============================================================

CHANGE="${1:-}"
TRIGGER_USER="${2:-}"
TRIGGER_CLIENT="${3:-}"
ENV_FILE="${4:-/etc/lowex/perforce-trigger.env}"

LOG="${LOWEX_TRIGGER_LOG:-/tmp/lowex-perforce-trigger.log}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG" 2>/dev/null; }

# NOTHING HERE MAY FAIL THE SUBMIT. A trap is belt and braces: whatever happens
# below, this exits 0.
trap 'exit 0' EXIT

if [ -z "$CHANGE" ]; then
    log "no changelist argument; nothing to notify"
    exit 0
fi

if [ ! -r "$ENV_FILE" ]; then
    log "environment file $ENV_FILE is not readable; notification not sent"
    exit 0
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

PORTAL_URL="${PORTAL_URL:-http://127.0.0.1:5000}"
P4PORT="${P4PORT:-127.0.0.1:1666}"

if [ -z "${PERFORCE_TRIGGER_TOKEN:-}" ]; then
    log "PERFORCE_TRIGGER_TOKEN is not set; notification not sent"
    exit 0
fi

# `p4 -G` is python-marshalled output: stable fields, no human formatting to
# parse. The file list is the depotFile0..depotFileN keys.
JSON=$(p4 -p "$P4PORT" -u "$TRIGGER_USER" -G describe -s "$CHANGE" 2>/dev/null | python3 -c '
import sys, marshal, json, time

# `p4 -G` emits Python-marshalled data whose keys and string values are BYTES
# in this build, and str in others. Normalise both rather than assume.
try:
    data = marshal.load(sys.stdin.buffer)
except Exception:
    sys.exit(1)

def text(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return "" if value is None else str(value)

def field(name):
    for key, value in data.items():
        if text(key) == name:
            return text(value)
    return ""

files = sorted(text(value) for key, value in data.items()
               if text(key).startswith("depotFile")
               and text(key)[len("depotFile"):].isdigit())

try:
    change = int(field("change"))
except ValueError:
    sys.exit(1)

# `time` is a Unix timestamp in the describe output; store it as a date a
# person can read. If it is already text, keep it.
raw_time = field("time")

try:
    submitted = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(int(raw_time)))
except (ValueError, OverflowError):
    submitted = raw_time

json.dump({
    "changelist": change,
    "user": field("user"),
    "client": field("client"),
    "stream": field("stream"),
    "description": field("desc"),
    "time": submitted,
    "files": files,
}, sys.stdout)
' 2>/dev/null)

if [ -z "$JSON" ]; then
    log "changelist $CHANGE: could not describe it; notification not sent"
    exit 0
fi

STATUS=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    -X POST "$PORTAL_URL/api/perforce/change-commit" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $PERFORCE_TRIGGER_TOKEN" \
    --data "$JSON" 2>>"$LOG")

log "changelist $CHANGE by $TRIGGER_USER@$TRIGGER_CLIENT -> $PORTAL_URL : HTTP ${STATUS:-none}"
exit 0
