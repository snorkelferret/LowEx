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

Five checks, all read-only, all safe against a running server:

```bash
npm run check:routes     # no route is shadowed by a catch-all
npm run check:schema     # the database matches the schema in code
npm run check:naming     # the shared rules do what they say
npm run check:dom        # every element the client looks for exists
npm run check:store      # the content store and the database agree
```

Run them after a migration and before a backup. `check:store` is the one to
trust when something looks wrong — it re-hashes every stored file and will tell
you if any content no longer matches its own name.

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
