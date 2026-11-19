# Testing

**The suite is `npm run check`.** Twenty checks, one exit code, plus an
opt-in browser check that is not part of it. Run the suite after every
significant change, and after any migration:

```bash
npm run build     # check:dom reads the built pages, not the source
npm run check
```

A single check can be run alone — `npm run check:approval` — which is what to
use while working on that area. The aggregate is what says whether the whole
thing still stands.

The checks live in `website/tests/`, with the shared harness in
`website/tests/lib/check-harness.js`. They are not a separate test framework:
there is no test runner, no describe blocks, and no mocking layer. Each file is
a script that either prints `PASS` and exits 0, or names every failed assertion
and exits 1.

## What each one is

| Aspect | Command | Kind | What it proves |
|---|---|---|---|
| route order | `check:routes` | static | no route is shadowed by the SPA catch-all |
| schema | `check:schema` | static | the live database matches the declaration in `db.js` |
| shared rules | `check:naming` | static | name derivation, hashing and type rules do what they say |
| pages | `check:dom` | static | every element the client looks up exists in the built page |
| storage | `check:store` | data | the blob store and the database agree, by hash |
| cleanup | `check:collector` | code | the nightly collector removes garbage and nothing else |
| previews | `check:preview` | route | production sees previews, and nobody else does |
| approval | `check:approval` | route | submit, lock, approve, reject and unlock |
| upload | `check:upload` | route | the folder names the asset, bytes are stored once, an unchanged version is refused |
| upload while pending | `check:upload-pending` | route | an asset under review refuses changes |
| download | `check:round-trip` | route | an approved version downloads and imports back as references |
| builds | `check:builds` | route | membership, the one-version rule, the manifest tree, the diff, and the build review |
| library | `check:library` | route | content roles read it; the wrong roles do not write |
| Perforce | `check:perforce` | route | the portal is told once, has a cursor, and reports a gap |
| destination and builds | `check:integration` | route | the destination gate, receipts, build reports and stats, review advice, retargeting |
| sign-in | `check:auth` | route | login, session identity, deactivation, logout |
| administration | `check:admin` | route | settings are bounded and audited; the account ladder holds |
| reports | `check:feedback` | route | anyone may report; administrators read and resolve |
| binding | `check:bind` | whole server | it starts, and listens on loopback only |
| configuration | `check:config` | static | no port or address outside `shared/config.mjs` |

## The opt-in browser check

```bash
npm run build
npm run check:browser
```

`check:browser` is **not one of the twenty** and is not in `npm run check`. It
starts the real backend, serves `frontend/dist`, launches headless Chrome and
drives the destination flow: the dialog opens, the game option is enabled, a
submit without a receipt is refused in the dialog, a receipt preselects its
version, the submit closes the dialog, production retargets and approves, and
the store row names both people.

It needs Chrome or Chromium on `PATH` and the built pages. Missing either, it
says so and **fails** rather than skipping: a check that reports PASS without
running is worse than one that is not there.

On failure it leaves a screenshot at `$TMPDIR/lowex-browser-check-failure.png`
and prints the path.

**A "route" check starts the real router on a throwaway Express app, against a
throwaway database whose schema is copied from the live one.** The real
middleware runs; tokens are minted; requests go over HTTP. Nothing in the live
database or the live blob store is read for content or written. Those checks
need `JWT_SECRET` set and a free local port.

`check:collector` runs the collector's own code without a server.
`check:bind` starts the whole backend as a child process, which is also the
only thing that notices the server failing to boot at all. The static checks
read only.

## The rule for a change

**A change that adds a route, a table, a shared rule or a page element adds or
updates a check in the same commit.** The existing checks are named for the
question they answer, not for the file they cover, so the right question is
"what would now be true that a check could catch?"

Two failure modes this catches, in the record:

- a rule written in a comment and never exercised — the collector's foreign key
  (TODO 90);
- a permission change made by adding a role to one list after another — which
  is why `check:library` and `check:builds` assert refusals as well as
  grants.

## What is not covered

Said plainly, so nobody assumes the suite is more than it is.

- **The browser, beyond the destination flow.** `check:browser` covers that
  flow end to end, and it is opt-in because it needs Chrome. No other click in
  the portal is exercised: the upload picker, the bin, the library and the
  builds panel are checked structurally by `check:dom` and not driven.
- **Registration, invitations, 2FA and Google sign-in.** `check:auth` covers the
  username/password path only.
- **The views and manual pages.** That they render, and that a link lands where
  it says, is not asserted.
- **The library's write path** — upload, edit, remove. `check:library` covers
  reads and the refusals around writes.
- **Email and urgent alerts.** SMTP is a deployment configuration; nothing here
  sends mail.
- **Concurrency.** Two uploads landing at once, two approvals racing, preview
  generation under load: all untested. The preview cap is enforced in
  `backend/lib/thumbnails.js` and is not exercised.
- **Performance.** No timing assertions.

## Adding a check

1. Copy the shape of the nearest existing check in `tests/`.
2. `startCheckServer({ prefix, route, mount, seed })` copies the live schema
   into a temporary database, seeds it, and mounts the real router. Pass
   `routes: [{ route, mount }]` when the check spans two families.
3. Assert both the grant and the refusal. A permission check that only proves
   the allowed case proves half of what it claims.
4. Register the script in `package.json` as `check:<aspect>` and add it to the
   aggregate `check` in the order above.
5. Add its row to the table in this file and to the table in
   `docs/manual/10-starting-the-box.md`.
