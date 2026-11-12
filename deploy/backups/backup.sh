#!/usr/bin/env bash
#
# deploy/backups/backup.sh — one backup, taken together and verified.
#
#   backup.sh [env file]
#
# TWO THINGS ARE BACKED UP:
#
#   the portal   the SQLite database and the content store, TAKEN TOGETHER.
#                A database without its files is a store full of references to
#                content that is not there (DEPLOY §5), so the copy is VERIFIED
#                with check:store before this script reports success.
#
#   the depot    a checkpoint, the journal and the versioned files. The depot is
#                the game's only copy, so a checkpoint alone is not a backup —
#                the files it refers to must travel with it.
#
# Retained for BACKUP_KEEP_DAYS (default 14). Every run is a dated directory,
# so a partial run is visible rather than blended into the last one.

set -euo pipefail

ENV_FILE="${1:-}"

if [ -n "$ENV_FILE" ]; then
    [ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE" >&2; exit 1; }
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
fi

for required in CHECKOUT BACKUP_DIR; do
    if [ -z "${!required:-}" ]; then
        echo "$required is not set" >&2
        exit 1
    fi
done

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# NANOSECOND PRECISION, so two runs in the same second cannot share a
# directory — which would nest one copy inside the other.
STAMP="$(date -u +%Y%m%dT%H%M%S%NZ)"
DEST="$BACKUP_DIR/$STAMP"

say() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

say "backup $STAMP -> $DEST"

mkdir -p "$DEST/portal"

# ---------------------------------------------------------------------------
# The portal: database and content, together
# ---------------------------------------------------------------------------

DB="$CHECKOUT/website/backend/database.db"
FILES="$CHECKOUT/website/backend/uploads/files"

[ -f "$DB" ] || { say "no database at $DB"; exit 1; }
[ -d "$FILES" ] || { say "no content store at $FILES"; exit 1; }

# `.backup` is safe against a live database; a plain copy can catch it mid-write.
sqlite3 "$DB" ".backup '$DEST/portal/database.db'"

mkdir -p "$DEST/portal/files"
cp -a "$FILES/." "$DEST/portal/files/"

say "portal copied: database and $(find "$DEST/portal/files" -type f | wc -l) file(s)"

# THE VERIFICATION IS NOT OPTIONAL. A backup that does not pass this is not a
# backup; it says so and fails, so the timer records a failure rather than a
# quiet success around an unrestorable copy.
say "verifying the portal copy with check:store"
if ! ( cd "$CHECKOUT/website" \
       && DB_PATH="$DEST/portal/database.db" STORE_DIR="$DEST/portal/files" \
          npm run --silent check:store ); then
    say "VERIFICATION FAILED — the copy at $DEST is not restorable as it stands"
    exit 1
fi
# check:store opens the copy in WAL mode and leaves its sidecars behind.
# They are not part of a backup.
rm -f "$DEST/portal/database.db-wal" "$DEST/portal/database.db-shm"

say "portal copy verified"

# ---------------------------------------------------------------------------
# The depot: checkpoint, journal, versioned files
# ---------------------------------------------------------------------------

if [ -n "${P4_ROOT:-}" ] && [ -d "$P4_ROOT" ]; then
    mkdir -p "$DEST/perforce"

    say "checkpointing the depot"

    # THE VERSIONED FILES LIVE UNDER THE DEPOT'S OWN NAME, not a fixed "depot"
    # directory: a depot called LowExpectations stores its files in
    # <root>/LowExpectations. The name comes from P4DEPOT.
    DEPOT_NAME="${P4DEPOT:?P4DEPOT is required when P4_ROOT is set}"
    DEPOT_FILES="$P4_ROOT/${DEPOT_NAME#//}"

    if p4 -p "${P4PORT:?P4PORT is required when P4_ROOT is set}" \
          -u "${P4_SUPER_USER:?P4_SUPER_USER is required when P4_ROOT is set}" \
          admin checkpoint; then

        # THE NEWEST CHECKPOINT, not the whole history: the older ones are
        # already in earlier dated directories.
        # The `.md5` beside a checkpoint is its checksum, not the checkpoint.
        newest="$(ls -t "$P4_ROOT"/checkpoint.* 2>/dev/null | grep -v '\.md5$' | head -1 || true)"

        if [ -n "$newest" ]; then
            cp -a "$newest" "$DEST/perforce/"
            [ -f "${newest}.md5" ] && cp -a "${newest}.md5" "$DEST/perforce/"
            say "checkpoint: $(basename "$newest")"
        else
            say "no checkpoint file found in $P4_ROOT — the depot copy is incomplete"
            exit 1
        fi

        [ -f "$P4_ROOT/journal" ] && cp -a "$P4_ROOT/journal" "$DEST/perforce/"

        # THE VERSIONED FILES, because a checkpoint alone points at them.
        if [ -d "$DEPOT_FILES" ]; then
            cp -a "$DEPOT_FILES" "$DEST/perforce/"
            say "versioned files copied from $DEPOT_FILES"
        else
            say "no $DEPOT_FILES directory — the checkpoint refers to files not in this backup"
            exit 1
        fi
    else
        say "checkpoint failed — the depot is NOT in this backup"
        exit 1
    fi
else
    say "no P4_ROOT set — the depot is not backed up by this run"
fi

# ---------------------------------------------------------------------------
# Retention — after the new backup has succeeded, never before
# ---------------------------------------------------------------------------

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '2*T*Z' -mtime "+$KEEP_DAYS" \
    -exec rm -rf {} + 2>/dev/null || true

say "done: $DEST"
