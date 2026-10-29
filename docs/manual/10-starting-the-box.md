# Starting the box

For whoever runs the server. Everyone else can skip to **Getting in**.

## What it is

A Node application: an Express backend, a SQLite database, and a Vite-built
frontend that the backend serves. One process, one file, no external services —
which is the point, and also the limitation. It does not scale sideways.

## What you need

- **Node 22 or newer.** Not a preference: parts of the code use features that
  do not exist in older versions, and one of them is in the rule that decides
  what is a file and what is an asset.
- A shell, and the repository checked out.

## Setting it up

```bash
cd website
npm install
cp .env.example .env      # then edit it — see below
```

`.env` is not committed and never should be. It holds the JWT secret and any
mail credentials. Three values matter:

| Key | What it is |
|---|---|
| `JWT_SECRET` | Signs every session. **The server refuses to start without it** — deliberately, because a fallback secret in the repo is not a secret. |
| `PORT` | Where the backend listens. Default 5000. |
| `VITE_PORT` | Where the dev frontend listens. Default 5173. |

Mail is optional. With no SMTP settings the portal behaves exactly as it did
before email existed: invitations are still created, and the link comes back in
the response for the inviter to pass on.

## Running it

**For development** — both halves, with reload:

```bash
npm run dev
```

**For anything real** — build the pages once, then run the backend:

```bash
npm run build
npm run start:backend
```

The build matters. Several pages are generated rather than committed, so
running the backend without building first serves a site with pages missing.

## What is on disk

| Path | What it holds |
|---|---|
| `backend/database.db` | Everything: accounts, workspaces, the asset store, the audit log. |
| `backend/uploads/files/` | The actual asset content, one file per SHA-256. |
| `frontend/dist/` | The built site. Generated — never edit it. |

**Back up the first two together.** They are one thing split across two places,
and a database restored without its files is a store full of references to
content that is not there. Nothing else on disk is worth keeping.

`npm run check:store` tells you whether the two currently agree.

## Keeping it healthy

Nine checks, safe against a running server, and one command to run them all:

```bash
npm run check            # all nine, stopping at the first failure
```

| Check | What it proves |
|---|---|
| `check:routes` | no route is shadowed by a catch-all |
| `check:schema` | the database matches the schema in code |
| `check:naming` | the shared rules do what they say |
| `check:dom` | every element the client looks for exists |
| `check:store` | the content store and the database agree |
| `check:collector` | the nightly cleanup removes garbage and nothing else |
| `check:preview` | the preview route serves production, and nobody else |
| `check:approval` | submit, lock, approve, reject and unlock behave |
| `check:upload-pending` | an asset under review refuses changes |

**Three of them start the real routes against a throwaway database and
directories** — they never touch the live data, but they do need `JWT_SECRET`
and a free local port. The rest read only.

Run them after a migration and before a backup. `check:store` is the one to
trust when something looks wrong — it re-hashes every stored file and will tell
you if any content no longer matches its own name.

## Before it goes public

There is a separate page for this, because it is a sequence of steps rather than
a document to read: **`docs/DEPLOY.md`**. It covers the backup, the environment,
rotating every known password, how the app is exposed, the decisions that must
be taken in writing before it is reachable, and the run record.

## The daily job

One script, run from cron. It does two things in order, because the second
feeds on the first:

1. **Empties expired bins.** Anything deleted longer ago than the **wastebin
   retention** setting — 14 days by default, an admin can change it — loses its
   files. The version and everything that happened to it stay.
2. **Collects unreferenced content.** Blobs nothing points at any more lose
   their row and their file. This is what actually frees disk.

```bash
node backend/jobs/daily.js
```

**Put it in cron, do not run it by hand.** A job nobody schedules is a job that
does not happen: deleted work would pile up in bins for ever and the disk would
only ever grow.

```cron
# once a day, at a time nobody is waiting for anything
17 4 * * *  cd /path/to/website && node backend/jobs/daily.js >> /var/log/lowex-daily.log 2>&1
```

Cron is deliberate rather than a timer inside the server. A timer dies with the
process, would run once per instance if there were ever two, and leaves no
record. Cron leaves a log — so "it silently stopped six weeks ago" is something
you can find, rather than discover when the disk fills.

### The flags

| | |
|---|---|
| *(none)* | Empties bins, and **reports** what collection would remove without removing it |
| `--collect` | Collection actually removes content |
| `--dry-run` | Changes nothing at all; says what would happen |

**Collection does not delete by default, on purpose.** It is the only thing in
this system that can destroy content outright, and a collector that starts
deleting on its first run — having never been watched — is how a store gets
emptied by a bug. Run it plain for a week, read what it says it *would* remove,
then add `--collect`.

It also refuses to collect at all if the store is inconsistent, and will not
touch anything written in the last 24 hours. Bins still empty either way: the
two halves depend on different things, and a store problem should not stop
deleted work being cleaned up.

### If it fails

It exits non-zero and prints why. Collection refusing is *not* a failure — it is
the safety catch working, and the fix is to run `npm run check:store`, deal with
what it reports, and let the next run collect.

## The Perforce sandbox

The game is versioned in **Perforce**, not here — see TODO 62 and 88. That
server does not exist yet, so there is a **local sandbox**: a Helix Core server
on this machine holding a copy of the game, for rehearsing the workflow.

**It is not the production server, and nothing depends on it.** It lives beside
the portal so the mechanics could be proven before a VPS was paid for.

Both `p4` (the client) and `p4d` (the server) are in the development shell.

### Starting it

```bash
p4d -r tmp/p4d -p 127.0.0.1:1666 \
    -J tmp/p4d/journal -L tmp/p4d/log -d
```

`-r` is the server root, `-p` the address it listens on, `-J` its journal, `-L`
its log, and `-d` detaches it. The root sits under `tmp/`, which is gitignored —
**the depot is never committed to this repository**, and must not be.

**Use `127.0.0.1`, not `localhost`.** `p4d` listens on IPv4 only, and
`localhost` resolves to `::1` first — the client then *hangs* rather than
failing, which looks exactly like a broken server.

### Using it

```bash
export P4PORT=127.0.0.1:1666 P4USER=val P4CLIENT=val-sandbox

p4 info                                  # is it there, and who am I
p4 sync //LowExpectations/dev/Content/... # fetch a piece of the game
p4 opened                                # what have I got checked out
```

The depot is **`//LowExpectations`**, a *stream* depot, with `main` (the
stable line) and `dev` (development). The sandbox client is mapped onto
`game/LE001`.

### Stopping it

```bash
p4 admin stop
```

The root persists. Starting it again brings everything back.

### One thing that will catch you out

**`p4 sync` does not restore a file you deleted locally.** It compares the depot
against its *have list*, not against the disk — so it reports "up-to-date" and
does nothing. `p4 sync -f` is the one that fetches the file back.

### Where the reasoning is

**TODO 88** — the plan for the real server, what a "cell" is on disk, who
integrates, and the four things this sandbox taught.

## When something is wrong

- **The server will not start.** Almost always a missing `JWT_SECRET`. It says
  so explicitly rather than starting with a fallback.
- **Pages 404 or look empty.** The build has not been run. `npm run build`.
- **Someone cannot sign in.** Check the account is still active before anything
  else — deactivation takes effect on the very next request, so a session can
  be valid and still be refused.
- **Disk filling up.** Ask `df`, not the database. Content added by one person
  can be shared by several, so per-account figures do not sum to the disk and
  are not supposed to.
