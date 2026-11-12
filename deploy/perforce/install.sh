#!/usr/bin/env bash
#
# deploy/perforce/install.sh — the Perforce server, guarded.
#
#   install.sh                      DRY RUN: prints every form, changes nothing
#   install.sh --apply              creates the depot, stream, typemap, trigger
#   install.sh --apply --apply-protections
#   install.sh --apply --test-notification
#
# WHY IT IS GUARDED, IN THE ORDER THE RISKS ARISE:
#
#   1. A FILE'S TYPE IS FIXED WHEN IT IS ADDED. The typemap must be right BEFORE
#      the first `p4 add`, and this script REFUSES to proceed if the depot
#      already holds files that the typemap does not cover — re-adding them is
#      the only repair.
#   2. PROTECTIONS CAN LOCK YOU OUT. The table is shown, never applied, unless
#      --apply-protections is given as a separate decision.
#   3. EVERY SETTING IS A FORM. Depot, stream, groups, protections and triggers
#      are read-modify-write; this script reads, skips what exists, and merges
#      rather than duplicating.
#   4. A TRIGGER RUNS IN THE SERVER'S ENVIRONMENT. Its script and its 0600
#      environment file are checked for existence and readability — the secret
#      is never created or printed here.
#   5. THE NOTIFICATION IS PROVEN, not assumed: --test-notification performs a
#      real submit and reads the portal's cursor back with the trigger's own
#      credential.
#
# The facts come from deploy/site.env (or the environment).

set -euo pipefail

APPLY="0"
APPLY_PROTECTIONS="0"
TEST_NOTIFICATION="0"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"

while [ $# -gt 0 ]; do
    case "$1" in
        --apply)              APPLY="1"; shift ;;
        --apply-protections)  APPLY_PROTECTIONS="1"; shift ;;
        --test-notification)  TEST_NOTIFICATION="1"; shift ;;
        -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ "$APPLY_PROTECTIONS" = "1" ] && [ "$APPLY" != "1" ]; then
    echo "--apply-protections needs --apply as well." >&2
    exit 2
fi

# The orchestrator has already sourced the file; running this script alone does
# it here, so each part stays self-contained.
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

for required in P4PORT P4_ROOT P4DEPOT P4STREAM P4_SUPER_USER \
                PORTAL_URL PERFORCE_TRIGGER_ENV PERFORCE_TRIGGER_SCRIPT; do
    if [ -z "${!required:-}" ]; then
        die "$required is not set — see deploy/site.env.example"
    fi
done

p4c() { p4 -p "$P4PORT" -u "$P4_SUPER_USER" "$@"; }

say "server      : $P4PORT"
say "root        : $P4_ROOT"
say "depot       : $P4DEPOT"
say "stream      : $P4STREAM"
say "super user  : $P4_SUPER_USER"
say "portal      : $PORTAL_URL"
[ "$APPLY" = "1" ] && say "mode        : APPLY" || say "mode        : DRY RUN"

# ---------------------------------------------------------------------------
# 0. A server to talk to
# ---------------------------------------------------------------------------

if ! p4c info >/dev/null 2>&1; then
    say "no server answering on $P4PORT"

    command -v p4d >/dev/null 2>&1 || die "p4d is not installed"
    command -v p4  >/dev/null 2>&1 || die "p4 is not installed"

    run mkdir -p "$P4_ROOT"
    # STDIO IS DETACHED. `p4d -d` daemonises, but a child that keeps the
    # caller's stdout open makes any pipeline reading this script wait for EOF
    # that never comes — which looks exactly like a hung installer.
    run p4d -r "$P4_ROOT" -p "$P4PORT" -J "$P4_ROOT/journal" -L "$P4_ROOT/log" -d \
        </dev/null >/dev/null 2>&1

    if [ "$APPLY" = "0" ]; then
        say "would start p4d, then read the forms"
        exit 0
    fi

    for _ in $(seq 1 30); do
        p4c info >/dev/null 2>&1 && break
        sleep 1
    done

    p4c info >/dev/null 2>&1 || die "p4d did not start — see $P4_ROOT/log"
fi

say "server answers: $(p4c info 2>/dev/null | head -1)"

# ---------------------------------------------------------------------------
# 1. The depot
# ---------------------------------------------------------------------------

DEPOT_NAME="${P4DEPOT#//}"

if p4c depots 2>/dev/null | awk '{print $2}' | grep -qx "$DEPOT_NAME"; then
    say "depot $P4DEPOT exists"
else
    say "creating depot $P4DEPOT (stream)"

    depot_spec="$(cat <<EOF
Depot: $DEPOT_NAME
Type: stream
StreamDepth: 1
Map: $DEPOT_NAME/...
Description: Low Expectations — the game.
EOF
)"

    if [ "$APPLY" = "1" ]; then
        printf '%s\n' "$depot_spec" | p4c depot -i
    else
        say "would write:"
        printf '%s\n' "$depot_spec" | while IFS= read -r line; do say "  $line"; done
    fi
fi

# ---------------------------------------------------------------------------
# 2. The stream
# ---------------------------------------------------------------------------

if p4c streams 2>/dev/null | awk '{print $2}' | grep -qx "$P4STREAM"; then
    say "stream $P4STREAM exists"
else
    say "creating mainline $P4STREAM"

    stream_spec="$(cat <<EOF
Stream: $P4STREAM
Owner: $P4_SUPER_USER
Name: ${P4STREAM##*/}
Type: mainline
Parent: none
ParentView: inherit
Description: Low Expectations — mainline.
Paths:
    share ...
EOF
)"

    if [ "$APPLY" = "1" ]; then
        printf '%s\n' "$stream_spec" | p4c stream -i
    else
        say "would write:"
        printf '%s\n' "$stream_spec" | while IFS= read -r line; do say "  $line"; done
    fi
fi

# ---------------------------------------------------------------------------
# 3. The typemap — BEFORE ANY ADD, and refused if it is already too late
# ---------------------------------------------------------------------------

TYPEMAP_EXPECTED=(
    "binary+l $P4DEPOT/.../*.uasset"
    "binary+l $P4DEPOT/.../*.umap"
    "binary+l $P4DEPOT/.../*.ubulk"
    "binary+l $P4DEPOT/.../*.uexp"
    "binary+l $P4DEPOT/.../*.png"
    "binary+l $P4DEPOT/.../*.fbx"
    "text $P4DEPOT/.../*.ini"
    "text $P4DEPOT/.../*.cpp"
    "text $P4DEPOT/.../*.h"
    "text $P4DEPOT/.../*.cs"
    "text $P4DEPOT/.../*.json"
)

current_typemap="$(p4c typemap -o 2>/dev/null || true)"

# TYPEMAP ENTRIES ARE TAB-INDENTED. Comparing raw lines would report every
# entry as missing on a table that is correct, so the comparison is trimmed.
normalised_typemap="$(printf '%s\n' "$current_typemap" | sed 's/^[[:space:]]*//')"
missing=()

for line in "${TYPEMAP_EXPECTED[@]}"; do
    printf '%s\n' "$normalised_typemap" | grep -Fxq "$line" || missing+=("$line")
done

if [ "${#missing[@]}" -eq 0 ]; then
    say "typemap covers every expected type"
else
    say "typemap is missing ${#missing[@]} entries"

    # THE GUARD. If files are already in the depot, their types are fixed; this
    # is the one place the installer must refuse rather than repair.
    if p4c files "$P4DEPOT/..." 2>&1 | grep -qv 'no such file'; then
        printf '\n' >&2
        say "the depot ALREADY HOLDS FILES and the typemap does not cover them:" >&2
        for line in "${missing[@]}"; do say "  $line" >&2; done
        die "their types are fixed at add; re-adding is the only repair. Nothing was changed."
    fi

    merged="$(printf '%s\n' "$current_typemap" | python3 -c '
import sys
lines = sys.stdin.read().splitlines()
missing = sys.argv[1:]
out, inserted = [], False
for line in lines:
    out.append(line)
    if line.startswith("TypeMap:") and not inserted:
        out.extend("\t" + m for m in missing)
        inserted = True
print("\n".join(out))
' "${missing[@]}")"

    if [ "$APPLY" = "1" ]; then
        printf '%s\n' "$merged" | p4c typemap -i
        say "typemap updated"
    else
        say "would add:"
        for line in "${missing[@]}"; do say "  $line"; done
    fi
fi

# ---------------------------------------------------------------------------
# 4. Groups — protections are written against these, so they must exist
# ---------------------------------------------------------------------------

existing_groups="$(p4c groups 2>/dev/null || true)"

for group in game-dev game-build game-admin; do
    if printf '%s\n' "$existing_groups" | grep -qx "$group"; then
        say "group $group exists"
        continue
    fi

    say "creating group $group (with no members)"

    # THE SERVER'S OWN TEMPLATE, not a hand-written spec: a group form carries
    # limits (MaxResults, Timeout and the rest) that a minimal spec omits, and
    # the server refuses one without them — with "not created" and no reason.
    #
    # AND IT NEEDS AT LEAST ONE MEMBER. An empty group is refused for the same
    # silent reason, so the super user is seeded into it and moved out later by
    # whoever manages the studio's people.
    if [ "$APPLY" = "1" ]; then
        p4c group -o "$group" | python3 -c '
import sys
text, user = sys.stdin.read(), sys.argv[1]
# ONLY THE USERS SECTION IS SEEDED. Looking for the user anywhere in the form
# finds it in the "Group:" line — every group is named after a person here —
# and skips the insertion the form needs.
needle = "Users:\n"
if needle in text:
    text = text.replace(needle, needle + "\t" + user + "\n", 1)
print(text, end="")
' "$P4_SUPER_USER" | p4c group -i
    else
        say "would create it from the server's group template, with $P4_SUPER_USER seeded in"
    fi
done

say "add people with: p4 group game-dev"

# ---------------------------------------------------------------------------
# 5. Protections — shown always, applied only on an explicit decision
# ---------------------------------------------------------------------------

protections="$(
    cat <<EOF
Protections:
    super user $P4_SUPER_USER * $P4DEPOT/...
    write group game-dev * $P4DEPOT/dev/...
    write group game-dev * $P4DEPOT/exp-*/...
    write group game-build * $P4DEPOT/rel-*/...
    read group game-dev * //...
    list group game-dev * //...
EOF
)"

# A FRESH SERVER HAS NO USERS, and a protections table naming a user that does
# not exist cannot be written. The super account is created with no password —
# set one afterwards with `p4 passwd`.
if ! p4c users 2>/dev/null | grep -q "^$P4_SUPER_USER "; then
    say "creating the super user $P4_SUPER_USER (set a password with: p4 passwd)"

    user_spec="$(
        cat <<EOF
User: $P4_SUPER_USER
Email: $P4_SUPER_USER@example.invalid
FullName: $P4_SUPER_USER
EOF
    )"

    if [ "$APPLY" = "1" ]; then
        printf '%s\n' "$user_spec" | p4c user -i
    else
        say "would create user $P4_SUPER_USER"
    fi
fi

say "protections this install expects:"
printf '%s\n' "$protections" | while IFS= read -r line; do say "  $line"; done

if [ "$APPLY_PROTECTIONS" = "1" ]; then
    say "REPLACING the protections table (as asked)"
    run bash -c 'printf "%s\n" "$1" | p4 -p "$2" -u "$3" protect -i' _ "$protections" "$P4PORT" "$P4_SUPER_USER"
else
    say "protections NOT applied — re-run with --apply --apply-protections to replace the table"
fi

# ---------------------------------------------------------------------------
# 6. The trigger, and the environment it needs
# ---------------------------------------------------------------------------

TRIGGER_SOURCE="$HERE/change-commit.sh"

if [ "$(readlink -f "$TRIGGER_SOURCE")" = "$(readlink -f "$PERFORCE_TRIGGER_SCRIPT" 2>/dev/null || echo "$PERFORCE_TRIGGER_SCRIPT")" ]; then
    say "trigger script is already at $PERFORCE_TRIGGER_SCRIPT"
else
    say "installing the trigger script at $PERFORCE_TRIGGER_SCRIPT"
    run install -D -m 0755 "$TRIGGER_SOURCE" "$PERFORCE_TRIGGER_SCRIPT"
fi

if [ -r "$PERFORCE_TRIGGER_ENV" ]; then
    for key in PORTAL_URL P4PORT PERFORCE_TRIGGER_TOKEN; do
        if ! grep -Eq "^${key}=.+" "$PERFORCE_TRIGGER_ENV"; then
            die "$PERFORCE_TRIGGER_ENV has no $key — the trigger would send nothing"
        fi
    done
    say "trigger environment: $PERFORCE_TRIGGER_ENV (readable, all three values set)"
else
    die "no readable $PERFORCE_TRIGGER_ENV — create it from deploy/perforce/trigger.env.example"
fi

trigger_line="lowex-change-commit change-commit $P4DEPOT/... \"bash $PERFORCE_TRIGGER_SCRIPT %changelist% %user% %client% $PERFORCE_TRIGGER_ENV\""

if p4c triggers -o 2>/dev/null | grep -q lowex-change-commit; then
    say "trigger lowex-change-commit is installed"
else
    say "adding trigger lowex-change-commit"

    if [ "$APPLY" = "1" ]; then
        p4c triggers -o | python3 -c '
import sys
line = sys.argv[1]
text = sys.stdin.read()
marker = "\nTriggers:\n"
i = text.rindex(marker) + len(marker)
print(text[:i] + "\t" + line + "\n" + text[i:], end="")
' "$trigger_line" | p4c triggers -i
    else
        say "would add: $trigger_line"
    fi
fi

# ---------------------------------------------------------------------------
# 7. Prove the notification, with a real submit
# ---------------------------------------------------------------------------

if [ "$TEST_NOTIFICATION" = "1" ]; then
    [ "$APPLY" = "1" ] || die "--test-notification needs --apply"

    # shellcheck disable=SC1090
    set -a; . "$PERFORCE_TRIGGER_ENV"; set +a

    TRIGGER_TOKEN="${PERFORCE_TRIGGER_TOKEN:-}"
    TRIGGER_PORTAL="${PORTAL_URL:-}"

    [ -n "$TRIGGER_TOKEN" ] || die "no PERFORCE_TRIGGER_TOKEN in $PERFORCE_TRIGGER_ENV"
    [ -n "$TRIGGER_PORTAL" ] || die "no PORTAL_URL in $PERFORCE_TRIGGER_ENV"

    cursor_of() {
        curl -fsS --max-time 10 \
            -H "Authorization: Bearer $TRIGGER_TOKEN" \
            "$TRIGGER_PORTAL/api/perforce/cursor" 2>/dev/null \
            | python3 -c 'import sys,json; print(json.load(sys.stdin).get("last_changelist",0))' 2>/dev/null \
            || echo 0
    }

    before="$(cursor_of)"
    say "portal cursor before: $before"

    test_root="$(mktemp -d)"
    test_client="lowex-install-test-$$"

    client_spec="$(
        cat <<EOF
Client: $test_client
Owner: $P4_SUPER_USER
Root: $test_root
Options: noallwrite noclobber nocompress unlocked nomodtime normdir
SubmitOptions: submitunchanged
LineEnd: local
Stream: $P4STREAM
EOF
    )"

    printf '%s\n' "$client_spec" | p4c client -i
    printf 'Low Expectations installation test\n' > "$test_root/lowex-install-test.txt"
    p4c -c "$test_client" add "$test_root/lowex-install-test.txt" >/dev/null
    p4c -c "$test_client" submit -d "Low Expectations installation test — safe to ignore" >/dev/null

    changelist="$(p4c changes -m 1 -u "$P4_SUPER_USER" | awk 'NR==1 {print $2}')"

    say "submitted changelist $changelist; waiting for the portal to be told"

    told="0"
    for _ in $(seq 1 30); do
        now="$(cursor_of)"
        if [ "$now" -ge "$changelist" ] 2>/dev/null; then told="$now"; break; fi
        sleep 1
    done

    p4c client -d "$test_client" >/dev/null 2>&1 || true
    rm -rf "$test_root"

    if [ "$told" = "0" ]; then
        die "the portal did not record changelist $changelist — check $PERFORCE_TRIGGER_ENV and the trigger log"
    fi

    say "the portal recorded it: cursor $before -> $told"
fi

# ---------------------------------------------------------------------------
# 8. Proof
# ---------------------------------------------------------------------------

say "proof:"
say "  $(p4c info 2>/dev/null | head -1)"
say "  typemap entries: $(p4c typemap -o 2>/dev/null | grep -c "$P4DEPOT")"
say "  trigger lines  : $(p4c triggers -o 2>/dev/null | grep -c lowex-change-commit)"
# Protections are TAB-indented in the form the server stores, whatever
# indentation was typed.
say "  protections    : $(p4c protect -o 2>/dev/null | sed -n '/^Protections:/,$p' | grep -c $'^\t' || true)"

if [ "$APPLY" = "0" ]; then
    say ""
    say "DRY RUN — nothing was changed. Re-run with --apply."
fi
