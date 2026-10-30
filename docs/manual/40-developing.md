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

## Three places, and what each is for

| | what it holds | who sees it | ships? |
|---|---|---|---|
| **your workspace** | what you are working on now | only you | no |
| **the library** | shared source material — reference, textures, scans, anything | the studio | not by itself |
| **the game store** | content approved into the game | the studio | yes |

**AN ASSET IS NOT DEFINED BY WHAT KIND OF FILE IT IS.** A texture or a photograph
can be a game asset, and so can a Blender file. What decides is whether it is
approved into the game — not whether it is an image.

Use the **library** for material the studio should be able to find and reuse: a
set of reference photographs, a scan, a texture nobody has built anything with
yet. Use your **workspace** for the thing you are assembling and intend to
submit.

> **A NOTE ON WHERE THIS IS GOING.** The intended model is **one** library
> holding everything, with the game's content as a tagged subset of it, and a
> version moving through stages — private, published, submitted, tested,
> approved. The three places above are what the portal does today; the stages
> are decided and not built. Where the two differ, `docs/SPEC.md` is the
> current statement and this page describes what you will actually see.

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

The system keeps its own version counter per asset — upload 1, upload 2 — shown
under the asset's history. **A version is the asset's file set**, so it counts
only when that set changes:

- **Anything different** — a file added, removed, renamed, moved or changed —
  makes the next version.
- **Nothing different** — the same files at the same paths — makes **no
  version**. The portal says so and uploads nothing.
- If the files are identical but you have changed the description or category,
  it offers to **create a new version anyway**. That version holds the same
  files; only the details differ.

Unchanged files are never stored twice: the portal already holds that content,
so a new version references it rather than copying it.

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

Every upload **offers** a **category** — Character, Environment, Prop, Vehicle,
Weapon, FX, Audio, UI, Other. It is **optional**: leave it blank and the asset is
simply uncategorised, which is a normal state rather than an error. It is a hint
rather than a rule — type something else and it is kept as you wrote it — and
production can change it later.

This is the one question about an asset that no machine can answer.

## What happens to a version

**1. Technical check.** Run it yourself with the button on any version, as often
as you like. See below for what it looks at.

**2. Submit for creative approval.** Only possible once the technical check has
passed **on exactly this content** — the check records what it tested, and a
submission whose content differs is refused. This locks the version *and the
asset*, so what a reviewer looks at cannot change underneath them. While it is pending you cannot change or delete
the asset, and you cannot re-run the check.

**3. Review.** **Production** — the `prod` role — approves or rejects it. Not an
administrator: approving work is a judgement about the work, and administration
is a different job. A rejection carries a reason. If it is rejected the lock is
released and you can work on it again.

**The reviewer sees a thumbnail of every image and video in your submission**,
and cannot open the files themselves. That is the whole of what they see, which
is worth knowing when you choose what to send: for a model or a scene file
there is no picture at all, so your note is the only description they have.

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

**The game store is a tab on your dashboard.** It lists everything approved into
the game — including work by other developers — and it is searchable.

Two things you can do with a version:

**Download** gives you the files. You choose the folder they belong in, and the
portal reads that folder **in your browser** to see which files you already
have, then fetches **only the missing ones**, as a single zip. Nothing is
uploaded: only a list of hashes is sent to the server.

> Your browser's folder dialog says **"Upload"**. That word is the browser's,
> not the portal's — reading a folder is the one thing a browser only knows how
> to do with its upload control. No file leaves your machine.

Before anything is fetched you are shown **what will be downloaded, by name and
size**, with a Cancel button. Files that would replace something you already
have are listed separately, so they are never overwritten quietly. Every
version's manifest names each file, its size and its SHA-256, so what arrived
can be checked rather than trusted.

**Import** takes a copy into your workspace and records which store asset and
version it came from — so submitting it again becomes a **new version of that
asset** rather than a second asset with the same name.

**What you have downloaded is in your History tab**, so you can see what you
took and when.

**The "In the game" column** says which version of each asset is actually in the
game, and which Perforce changelist put it there — `v2 · CL 15407`. That is not
necessarily the newest version.

A dash means nobody has recorded an integration, which covers two different
things the portal cannot tell apart: never put in the game, and put in but not
noticed here. **An administrator records it** when adding the version to a
release, after importing the asset into Unreal and committing it — it is a note
about what happened, not something the portal can see for itself.

## Discussion

There will be a board separate from this portal — not built into it, and that
is a decision rather than an oversight. See **Getting in → The discussion
board**.

Your board account will be separate: signing in here will not sign you in
there, and your role will not carry over. Revoking your portal access will
revoke your board access too — assume that works from the day the board exists.
