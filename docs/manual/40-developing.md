# Developing

For developers: uploading work, getting it checked, and getting it approved into
the game.

## What this portal is

A **staging area** for game assets. You upload work, it is checked and reviewed,
and approved work goes into the game's asset store.

It is not a file store you can lean on. Your workspace is meant to hold what you
are working on now, not an archive of everything you have ever made. It has a
size limit for that reason, and the panel says so rather than leaving you to
discover it.

## Your workspace is private

Nobody else can see inside it — not other developers, and not administrators. If
an administrator needs to look, they do it by impersonating you, which is marked
and audited, and is not routine.

**Your own copy stays on your machine.** The portal is a copy, not the original.
Uploading does not move your work anywhere.

**Approved content does not count against your limit.** Pulling your own approved
work back to iterate on it is free.

## Uploading

Upload a **folder**. Its name becomes the asset name:

```
bigTree_v04/          ->  asset "bigTree"
  scripts/nuke.nk
  models/tree.blend
```

The `_v04` is **your** labelling, your own iteration marker — not the system's
version. Rename the folder as you iterate; `bigTree_v05` is still the same asset.

The system keeps its own version counter per asset — upload 1, upload 2 — which
is bookkeeping, shown under the asset's history.

**The panel tells you what an upload will do before you do it:** which asset it
will join, and which upload number it will become.

### What cannot be uploaded

- **A folder whose name ends in a file extension.** `nuke_v10.nk` is a file, not
  an asset, and is refused.
- **Loose files with no folder** — there is no name to take. Pick the asset they
  belong to instead, or name a new one.
- **Backup files.** Editor backups are dropped automatically — `thing.blend1`,
  `shot.nk~`, `.DS_Store` and the rest. They are copies of files you already
  sent, and the upload tells you how many it skipped.
- **Anything that would take you over the workspace limit.**

### Names that look like an existing asset

If you upload `Assets_v04` and you already have `Asset`, you are asked which you
meant, because a forgotten capital or underscore is usually a typo rather than a
new asset. You can still choose "new asset" — it is a sandbox, and a badly named
asset is yours to live with.

### Saying which part of the game it belongs to

Every upload asks for a **category** — Character, Environment, Prop, Vehicle,
Weapon, FX, Audio, UI, Other. It is a hint rather than a rule: type something
else and it is kept as you wrote it.

This is the one question about an asset that no machine can answer.

## What happens to a version

**1. Technical check.** Run it yourself with the button on any version, as often
as you like. See below for what it looks at.

**2. Submit for creative approval.** Only possible once the technical check has
passed. This locks the version *and the asset*, so what a reviewer looks at
cannot change underneath them. While it is pending you cannot change or delete
the asset, and you cannot re-run the check.

**3. Review.** An admin or superuser approves or rejects it. A rejection carries
a reason. If it is rejected the lock is released and you can work on it again.

**4. Approved.** Your version is moved into the game's asset store. The store
holds the content; your workspace version keeps a pointer to it and is marked as
being in the game store. **Ownership passes to the game at this point** — but you
can always download a copy.

## The technical check

Run it from the button on any version. It reports **every check it ran**, not
just the failures, and you are shown the whole list.

| Check | What it means |
|---|---|
| `files_present` | The version has files. |
| `stored_file:*` | Each file exists on disk and its size matches what was recorded. |
| `logical_paths_unique` | No two files claim the same path. |
| `files_not_empty` | No file is zero bytes. A failed export passes everything else. |
| `asset_types_recognised` | Every file's extension is one the system knows. |
| `no_executable_content` | Nothing contains a program, whatever it is named. |
| `content_matches_extension` | The bytes are what the name claims. |

The last two are worth understanding, because they can fail for reasons that are
not your fault and are still worth knowing about.

**`no_executable_content`** fails if a file's contents are a program — Windows,
Linux or macOS — regardless of what it is called. Renaming it does not help; the
check reads the contents, not the name.

**`content_matches_extension`** reports three different things:

- **confirmed** — the bytes match the format the name claims.
- **does not match** — the bytes are a *different* format. A JPEG named `.png`
  fails here, and the message says what it actually looks like.
- **could not be verified** — nothing reliable to check against. Many formats
  have no signature at all: `.obj`, `.ma`, `.nk` and `.dae` are text. This is
  **not** a pass and **not** a failure. The check tells you which files it
  verified and which it merely could not contradict, because a tick that cannot
  fail would tell you nothing.

## Your asset history

The **History** tab lists every asset you have worked on, including versions no
longer in your workspace. Each one opens to show every version of it and what
happened to each: when it was uploaded, its note, the check result and why
anything failed, the reviewer's decision and comment, and whether it is in the
game store.

The workspace shows what is in it. The history is for everything that has left
it — work that is finished, rejected, or superseded, and which used to vanish
from sight.

## Deleting

You can delete anything in your own workspace — a version, or a whole asset.

It is a **soft delete**: the content stays if anything else uses it — the game
store, or another workspace — and your review history is kept. Only your copy and
your quota go.

You cannot delete something that is under review.

You **can** delete a version that has been approved into the game store: the
store keeps its own copy, so only yours goes.

**A developer can never remove a game asset.** That is not a permission check
that might be wrong — it is what the storage does. Content in the game store is
kept alive by the store's own reference, and deleting your copy cannot remove it.

## Getting your work back

Not built yet, and listed here so you do not go looking:

- **Downloading.** There is no download button and no archive download. The
  manifest that would drive it exists on the server and nothing uses it yet.
- **Browsing the game store.** So there is no way to pick up your own approved
  work as the basis for continuing. Deliberately deferred until the game itself
  is being built.

## Discussion

The team talks on a board separate from this portal — not built into it, and
that is a decision rather than an oversight. See **Getting in → The discussion
board**.

Your board account is separate: signing in here does not sign you in there, and
your role does not carry over. Revoking your portal access will revoke your board
access too — assume that works from the day the board exists.
