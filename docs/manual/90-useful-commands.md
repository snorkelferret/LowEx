# Useful commands

For whoever runs the box. Read-only unless stated otherwise.

## Creating a privileged account

Administrators and superusers cannot be created through the website. This is the
only way:

```bash
node scripts/create-superuser.js                  # create a superuser
node scripts/create-superuser.js --role admin     # create an administrator
node scripts/create-superuser.js --list           # who is on the system
node scripts/create-superuser.js --reset <name>   # set a new password
```

**Run it on the machine the portal runs on.** Needing access to the machine is
the control, not the obscurity of the command.

**The password is typed, never passed in.** There is no flag for it and no
environment variable: an argument appears in `ps` output and in the shell's
history, and the environment is readable by other processes. The script refuses
to run without a terminal rather than accept one. Nothing is echoed as you type,
and nothing is printed afterwards.

`--reset` is the only way to change a password. There is no in-app password
change and no "forgot my password" link.

**On a brand new installation there are no accounts at all**, so this is how you
get in the first time. That is deliberate — see *Administering*.

## Look at the database

The database is a single SQLite file, so anything you want to know is one query
away.

```bash
sqlite3 backend/database.db \
  'SELECT id, workspace_version_id, stored_file_id, filename, relative_path
   FROM workspace_version_files ORDER BY id DESC;'
```

Useful tables:

| Table | Holds |
|---|---|
| `users` | Accounts, roles, whether they are active, and `created_via` — how each account came to exist. NULL there means nothing in the portal created it. |
| `workspace_assets`, `workspace_versions` | What developers have uploaded |
| `assets`, `asset_versions` | The game asset store |
| `stored_files` | One row per SHA-256. **One copy of any content, ever.** |
| `technical_check_runs`, `technical_check_results` | What each check said and why |
| `creative_approvals` | Who approved or rejected what, and their comment |
| `audit_logs` | Deactivations, category changes, resolved reports, settings changes, invitations, account creation, restores and purges, daily job runs |
| `feedback` | Bug reports and suggestions |

To see what a developer is holding:

```bash
sqlite3 backend/database.db \
  'SELECT wa.name, wv.version_number, wv.version_note, wv.is_active
   FROM workspace_assets wa
   JOIN workspace_versions wv ON wv.workspace_asset_id = wa.id
   ORDER BY wa.name, wv.version_number;'
```

## Look at the content store

Files live at `backend/uploads/files/` and **the filename is the SHA-256 of the
contents**. So you can check a file is intact without any tooling:

```bash
sha256sum backend/uploads/files/<the-filename>
```

The output should equal the filename. If it does not, something has corrupted
that file, and `npm run check:store` will tell you the extent of it.

```bash
du -sh backend/uploads/files     # how much content there is
ls backend/uploads/files | wc -l # how many files
df -h .                          # how much disk is left — ask df, not the database
```

## The checks

```bash
npm run check:store      # content and database agree; re-hashes every file
npm run check:store -- --quick   # same, without re-hashing (fast on a big store)

npm run check:routes     # no route is shadowed by a catch-all
npm run check:schema     # the database matches the schema in code
npm run check:naming     # the shared rules do what they say
npm run check:dom        # every element the client looks for exists
```

`check:store` reads only, so it is safe against a running server. It is the one
to run before a backup and after anything that looks wrong.

Both `check:store` and the others accept `DB_PATH` and `STORE_DIR`, so a backup
can be checked without touching the live one:

```bash
DB_PATH=/backups/database.db STORE_DIR=/backups/files npm run check:store
```

## Backing up

Two things, and they must be taken together:

```bash
sqlite3 backend/database.db ".backup '/backups/database.db'"
cp -a backend/uploads/files /backups/files
```

The `.backup` command is not the same as copying the file — it is safe to run
against a live database, where a plain copy can catch it mid-write.

A database restored without its files is a store full of references to content
that is not there. Verify with `check:store` afterwards.
