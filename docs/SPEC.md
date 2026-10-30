# The OpenWorld Asset System — the living specification

**This document is the current truth.** The three PDFs in **`docs/archive/`**
are the historical record of intent (August 2026) and are kept as such. They
were archived on 2026-10-23 because they cannot be corrected; see the README
beside them. Where they disagree with this document, **this document wins** —
and every place they disagree is marked `SUPERSEDED` below, so the old text can
still be read with the right meaning.

**What this is not.** This says *what is*. `website/TODO` says *why it is that
way* — the decisions, the alternatives rejected, and the mistakes. When a
section here says something surprising, the reasoning is in the TODO, by item
number.

**`docs/RULES.md` holds the ten standing rules** — the things that must not be
broken while changing any of this, and which nothing mechanically catches. Read
it before a change that touches uploads, storage, permissions or Perforce.

**`docs/DEPLOY.md` is the pre-deployment checklist** — what must be true before
the portal answers on its real domain, including the decisions that are open
and have to be accepted in writing rather than quietly skipped.

**Every section carries a state:**

| state | meaning |
|---|---|
| **BUILT** | exists in the code and behaves as described |
| **DECIDED** | settled, not built |
| **DEFERRED** | deliberately not being done yet, and why |
| **OPEN** | not settled; the question is written down |
| **UNRECONCILED** | still only in the PDFs; not yet brought across |

Last reconciled against the code: **2026-10-23**.

---

## 1. What this system is

*State: BUILT (partially)*

A private web portal for a game studio. It holds the things the studio makes for
the game, records who made them and what happened to them, and gets them from a
developer's machine into the game under deliberate approval.

**The central rule, from the Library PDF and still true:**

> **Publishing an asset does not put it in the game.**

An asset can be **shared with colleagues, downloaded and used as a starting
point** without ever being submitted for the game. Being *in the store* is not
being *in the game*.

> **Discussion is not built** — comments and boards are intended, and there is
> no portal-side discussion at all yet (§11, §12). It belongs in that list and
> is not in it.

---

## 2. One library, not three spaces

*State: DECIDED — the model is settled, the code is a step behind*

> "The OpenWorld Asset Library is the central place for storing, discovering and
> sharing the things we create for the game." — *Library PDF*

**There is ONE library.** It can contain anything from a reference photograph to
a finished Unreal asset. Every asset in it carries three things:

| | |
|---|---|
| **an owner** | *see below* — the developer while private, **the studio** once it is in |
| **a stage** | private → published → submitted → tested → approved |
| **game versions** | production, candidate dev, experimental — one, several, or none |

**The workspace is the private end of the same thing**, not a separate place with
separate files.

**The game store is the subset approved into it** — not, yet, the subset in a
game *version*. Those are different questions and only the first is built: what
is in the store is content the studio has approved, and which release holds it
is §8, unbuilt.

### Who owns it

| | owned by | what that means |
|---|---|---|
| **private** (in a workspace) | the developer | only they read it, only they delete it |
| **published, in the store, in the game** | **the studio** | **none.** The original developer has no more right to it than anyone else |

**Once it is uploaded, the developer has no special privileges.** Anyone with the
role may add a version to it. The original version is untouched, and the
**history records who created each version** — that is where a person's name
lives, not in a privilege.

Ownership by the studio does **not** answer whether the studio may use something:
an asset can be studio-owned and still carry a licence or a restriction. That is
a separate record and it is **not built** (§13).

**Provenance per file.** Files are content-addressed, so one blob can be
referenced by many assets and versions. The store records **the first uploader of
each blob** — who brought that content in, and when — once, at the moment it
enters. It is not per-asset and it never changes.

> **NOT BUILT:** `stored_files` has no first-uploader column.
> **NOT BUILT:** `assets` has no owner column — and does not need one, under this
> model. The owner is the studio; private assets are owned by their workspace.

> **SUPERSEDES:** the code built a third space (TODO 57), and recorded that "an
> image is not a game asset" (TODO 58). Both are wrong — see TODO 86. An image
> is not a *game* asset, but it belongs in the *library*, which holds both.

Privacy is the owner's alone. Admins reach private work only by **impersonation**
(§10) — there is no admin read path, and there should not be.

---

## 3. An asset, a version, and its components

*State: BUILT*

Three levels, and confusing them causes most of the confusion in this system:

| level | what it is | example |
|---|---|---|
| **asset** | the thing | "Old Factory" |
| **version** | a snapshot of its files | v3 |
| **component** | one file in that snapshot | `models/factory.blend` |

**A version IS its file set**: the list of components, each identified by
`relative_path`, `filename` and `sha256`.

The asset carries `name`, `asset_type`, `category` and `description`. Pathnames
are **not** asset metadata — they belong to the version, because v1 and v2 can
hold different trees of the same asset.

**File metadata** — EXIF, XMP, container and scene metadata — is inside the
bytes. A change to it changes the hash, so it is a content change and needs no
mechanism of its own.

`asset_type` is **derived**, not typed: every file is classified by extension,
and the type is recorded only when every file in the version agrees. A `.blend`
plus forty textures has no single type, and "Image" would be a confident wrong
answer.

### Category and tags — two different questions

**One category: which part of the game.** Character, Environment, Prop,
Vehicle, Weapon, FX, Audio, UI. **A single value on the asset**, because an asset
is placed in one part of the game. Blank means "not categorised", which is a
normal state and not an error.

**Many tags: what the thing is.** Free-form, per asset, many-to-many. "African
vegetation", "rust", "concrete texture" — the words somebody would actually
search for. A tree is Environment *and* Vegetation; the second word is a tag.

> **SUPERSEDES:** the System PDF says *"Do not use a single category column. Use
> a many-to-many relationship."* That is right about **classifications** and
> wrong about the **category** — they are two questions, and the category is one
> answer. The many-to-many is the tags.

> **NOT BUILT:** there is no tag table for assets. `library_item_tags` is the
> shape to copy, and its `normaliseTag` should move into `shared/` rather than
> being copied — otherwise the library and the store can disagree about what a
> tag is.

---

## 4. Upload

*State: BUILT*

The developer uploads a **folder**, or a **selection of loose files** named
afterwards. The request carries the components and, **optionally**, a name,
category and description — which are the developer's *proposal*. The studio may
override them later.

> **NOT BUILT: a zip.** The upload does not unpack an archive, and a monolithic
> zip is not the intended mechanism — a folder or a file selection is. Item 55's
> "unzip is a feeder, not a second upload path" is about a future one, not this.

**The flow, in order:**

1. **Compare the components first** — `relative_path`, `filename`, `sha256` —
   before any asset metadata is written.
2. **Any pathname, filename or content changed** → a new version, carrying the
   developer's metadata with it.
3. **Nothing changed in the components** → nothing is written yet. A popup says
   *"Nothing has really changed except the description you provided"* and offers
   **Create a new version with this description** or **Cancel**.
4. **A refusal is recorded in the history.** A *cancellation* is not: pressing
   Cancel never reaches the server, so there is nothing to record and nothing
   was changed.

**Unchanged components are never stored twice.** The SHA store holds one copy of
any content; a new version references the same rows. The same file uploaded a
hundred times costs one blob.

**BUILT.** The upload hashes its components and compares that with the newest
version's `manifest_hash` — **before the quota check and before any write**, so
a refusal leaves no partial state and changes no metadata.

**The refusal says which metadata differs**, and only counts a value the
developer actually sent: an absent name/category/description leaves the asset's
value alone, so it is not a change. That is what lets the popup say *"nothing
has really changed except the description you provided"* honestly, and say
*"nothing has changed"* when nothing did.

**The developer can insist** (`force_new_version`), which is the one case where
a version is created without a byte changing. The refusal is recorded in the
developer's history, because an upload that stored nothing leaves no other
trace.

**The comparison is the deterministic manifest hash** — `filename + SHA256 +
size`, sorted by canonical path, then hashed. One implementation serves three
purposes: detecting change, identifying content, and proving that *the version
tested is the version submitted*.

**BUILT** — `shared/manifest.mjs` canonicalises the components and
`backend/lib/manifestHash.js` hashes them. Every version carries one, and it is
returned by the manifest endpoint and written into every archive manifest.

> The value identifies **content**, not the version: two versions may hold it
> (an insisted description change makes a version without changing a byte). It
> is never `UNIQUE` and never a version identifier.
>
> **A version has one hash; a zip may hold only part of it.** A negotiated
> download sends a developer only the files they lack, so an archive is often a
> subset. Manifests therefore carry **two** values, computed the same way over
> the same canonical paths:
>
> | | |
> |---|---|
> | `manifest_hash` | the **version** — every component |
> | `archive_hash` | **this zip** — the components it holds |
>
> Equal means the zip is the whole version; different means it is a subset. No
> flag is needed, because the comparison says it exactly.
>
> **And a subset says what it left out.** A caller with a slightly stale list
> still gets everything that matches, and the manifest names every requested
> hash the version does not hold (`unknown`) — otherwise the delivery is
> silently incomplete and the receiver cannot tell a stale manifest from a
> corrupt one.

**An imported version carries the same identity as the version it came from.**
Import copies the file *references*, then recomputes the manifest hash from the
rows it just copied — so work brought back from the store has a `manifest_hash`
even though no upload created it, and the test receipt for it can be compared
to what was approved.

**Tech check at upload.** Nothing enters the store untested (TODO 86). File
contents *are* inspected — the first 512 bytes against a signature table — so a
JPEG renamed `.png` is refused. What does not exist is format compliance: polygon
counts, texture dimensions, naming conventions.

---

## 5. Stages

*State: DECIDED — not built*

The five stages, from the Library PDF, and still the intent:

```
PRIVATE → PUBLISHED → SUBMIT FOR GAME → TECHNICAL TEST → DIRECTOR REVIEW
                                                              ↓
                                                       GAME APPROVED
```

- **PRIVATE** — the owner's working area. Only the owner reads it (admins by
  impersonation). Only the owner deletes it.
- **PUBLISHED** — visible to colleagues, downloadable, discussable, usable as a
  starting point. **Not approved.** A published version's content never changes:
  a correction is a new version.
- **SUBMIT FOR GAME** — the owner decides when a version is ready to be
  considered.
- **TECHNICAL TEST** — and the **test receipt**. The run records the
  `manifest_hash` of the content it tested, and submission refuses unless that
  matches the version being submitted: *"the version I tested is the version I
  submitted"*, as a fact rather than an assumption. The receipt is returned by
  the check and names the version, the content, the checks, who ran it and when.

  > **Half of it is missing, and says so.** The spec's receipt also identifies
  > the **game build** — branch, build number, commit. No game build exists
  > (§8), so the receipt carries `game: null`. An absent field says that; an
  > empty or invented one would not.
- **DIRECTOR REVIEW** — the artistic decision, recorded **separately** from the
  technical one. `prod` is the director (TODO 87, A6).

> **OPEN:** whether the technical test against a *build* happens here or at
> upload. The owner settled that **upload** is gated (above); the PDF's
> "tested against Build 203" rule belongs to this stage. They are two tests at
> two stages, and only this one is about a build.

> **OPEN:** a version can be withdrawn (deleted) but never rewritten. Withdrawal
> is a last resort behind deliberately heavy friction, decided 2026-10-02, and
> **not built** — `assets.is_active` exists and is never written.

---

## 6. Roles and access

*State: BUILT*

| role | what it is |
|---|---|
| **user** | a tester |
| **developer** | works in a private workspace; uploads, versions, submits |
| **prod** | production — a **craft** role, not a seniority. Approvals and comments **are built**; categories and boards are **intended and not built** |
| **admin** | administers the system. Accounts, invitations, reports, settings, audit, deactivation. **Top of the ladder** |

**Admin administers the system and nothing else. Craft powers are not admin's
own.**

`requireRole` checks the list literally — no rank, no implicit admin. Every route
names the role whose *job* it is.

**Two mechanisms reach the rest:**

- **Multi-role, for permission-shaped acts** — approvals, categories, comments.
  An admin's account acts *as a role*, recorded, with a **big obvious banner**
  ("Acting as prod") and a button that returns to admin-only. That button must
  not be called "Sign out" — that already means end the session.
- **Impersonation, for data-shaped acts** — a developer's workspace, history,
  uploads. Role-switching cannot reach those: the data is scoped to a developer
  id, and "acting as developer" sees nobody's workspace.

> **DECIDED, NOT BUILT:** multi-role (`sessions.active_role`) and impersonation
> (`sessions.is_impersonated`, `impersonated_by` — columns that exist and are
> never written). Under this model admin currently has **no route to any craft
> power at all**.

> **THE AUDIT TRAIL IS THE PREREQUISITE, AND IT IS NOW BUILT** (§7). A role switch
> that is not audited would only be a way of doing things invisibly — so the role
> switch itself still has to be recorded when it is built.

---

## 7. Approval

*State: BUILT*

A developer submits a workspace version; `prod` approves or rejects it. Approval
writes an immutable `asset_version` into the store, copies the file references
(never the bytes — one copy), and records which asset and version it came from.

**A reviewer sees a picture, not the files.** Production decides, and production
does not have Blender, Nuke or Unreal — so a download is useless to them even
where the rules allow one. The queue therefore shows a **thumbnail of every
image and video** in a submission, and clicking one opens it full size
(`docs/assettypes01 §1 B`). **A model or scene file has no preview**: a picture
of a model needs a renderer and none is connected, so `model_preview` exists in
the schema and is never produced. A version without one is still judged from
what was submitted, by whom, and what they said.

Images are decoded by `sharp` — JPEG, PNG, WebP, TIFF, GIF, AVIF — **falling
back to `ffmpeg` for the formats libvips does not read**, TGA and EXR among
them, which are ordinary texture and render formats in game art. That fallback
is the same frame path the video posters use, not a second preview system. What
neither can read gets no preview and no error.

**Previews never delay an upload, and never take the server with them.** The
upload responds first and the pictures follow, two at a time through a shared
queue, with a 64-megapixel input ceiling — sharp and ffmpeg both run on
resources every other request shares. A preview lost to a restart is not
regenerated on demand yet; the file simply shows no picture until it is
uploaded again.

**A preview is derived content, not store content.** It is made from the blob
and written outside the store (`THUMB_DIR`), gets no `stored_files` row, is
counted against no quota, and is never collected as authored work; deleting
every preview costs regeneration, not data. `file_thumbnails` is therefore a
**cache of what has been made**, addressed by `storage_key` + kind, and the
image is served **scoped to the approval** — a reviewer can see exactly the
files submitted for the decision in front of them and nothing else in the
workspace.

**Technical and artistic decisions are separate records**: `technical_check_runs`
for the first, the approval for the second. "Technically correct but artistically
rejected" and "artistically excellent but technically not ready" must both be
expressible.

**Every act is audited.** Upload, submit, technical check, approve and reject
each write an audit record — who did it, to what, and with what result — **inside
the same transaction as the act**, so a decision and its record land together or
not at all.

**The role is not repeated on every row.** When multi-role exists (§6), an admin
acting as prod will be recorded by the **role switch** — once — and the log's
chronology carries the rest; repeating it per decision would be the same fact
said twice.

> **NOT BUILT:** the role switch itself. Until it is, every audit row records the
> actor and the approval routes admit `prod` only, so there is no ambiguity to
> disambiguate.

**After approval: the changelist.** Approval puts a version in the **store**, not
in the **game**. Putting it into the game is an **admin's** work — importing into
Unreal and committing a changelist — and the portal records **which changelist**,
who said so, and when (`asset_integrations`).

> **It cannot see Perforce**, so this is an **assertion**, kept as one: the store
> shows `v2 · CL 15407`, or `—`. A dash covers both "never integrated" and
> "nobody recorded it", and the portal does not pretend to tell them apart.

---

## 8. Releases, and the game's versions

*State: PARTLY BUILT — releases and membership exist. Builds, automatic
membership and the release diff do not (TODO 53, 104).*

**Named releases, not channels.** "0.4 Experimental, 12 Nov" — a specific build
with a date. Channels (production / development / experimental) are a small
fixed set of tracks and cannot express a history; a game version has one.

**A release is identified by** a name, a Perforce changelist, who built it, and
when. Not a git tag: the game is versioned in Perforce, so the changelist is the
tag.

**Membership is derived by query, not maintained as a field**, and is
many-to-many **at the version level**: a release holds many asset versions, and
one version can be in many releases.

**The game's current version is not the newest version.** An asset may have v5
published while the game holds v3, because v4 and v5 are experimental or still
under review. The game records which version it uses.

> **NOT BUILT:** `asset_recommended_versions` (one version per asset) exists and
> is never written. It cannot express an asset being in production *and*
> candidate-dev at once — that needs the release dimension.

**BUILT 2026-10-30 — the record and the admin's queue.** `releases` (a name, an
optional date, an optional changelist, notes) and `release_assets` (which
approved versions are in it). The admin page lists every release and, for one
selected release, **the candidates**: approved store versions it does not hold.
Adding a candidate writes the membership, and — when a changelist is given —
also the `asset_integrations` row, so the import and the membership are one act.

**One version per asset per release**, enforced by name in the routes: a build
cannot ship two versions of BigTree, and the refusal says which one is in the
way.

**The changelist is an assertion**, like every other link to Perforce: the
portal records what a person says, with who said it and when.

**Not built:** a build (there is nothing to build yet), membership derived from
a delivered changelist rather than chosen by hand, a diff between two releases,
prod seeing the release list, and the `releases` idea reaching the developer
page.

---

## 9. Storage

*State: BUILT (local disk); the eventual host is DEFERRED*

**One copy of any SHA-256, ever.** `stored_files` has `UNIQUE(sha256)` and
`storage_key === sha256`. Every reference — a workspace, the store, a release —
points at that row. None owns the bytes, and none gets a second copy.

**Large content is not in any repository.** The website's source and schema are
in git; the asset blobs are on a machine, outside version control. The uploads
directory and the database are both gitignored.

**Where the bytes live is not settled.** The PDFs propose object storage
(Cloudflare R2); the code uses local disk. The owner's position is "storage is
temp TBD", and the wording "some machine" suggests self-hosting may be preferred.
**Deferred, not drifted.**

> **SUPERSEDES:** the PDFs say large files go to object storage behind a
> `storage_provider` abstraction. No such column or abstraction exists.

---

## 10. Sessions and identity

*State: BUILT as fixed 2-hour sessions; the idle model is DECIDED — not built*

**The current lifetime is a setting** — `session_hours`, default **2**, bounded
1–24, edited by an admin at Admin → Settings. It applies from the next sign-in;
a running session keeps the expiry it was issued with.

**Sessions expire on idleness, not on a fixed clock.** *(The model below is
decided and not built; the setting above is what exists today.)*

| | |
|---|---|
| developer | idle **2 hours**, warning, then **3 minutes** to respond |
| prod / admin | idle **30 minutes**, absolute cap **8 hours** |
| everyone | absolute cap **24 hours**, however active |

**An active session is never logged out.** The 24-hour cap is the outer bound: a
token somebody else is using dies within a day.

**The server enforces; the popup is a courtesy.** A closed or sleeping tab runs
no timer, so client-side-only expiry logs nobody out.

> **SUPERSEDES:** the manual used to say "a session lasts 8 hours" while the
> browser's login issued 2 — corrected. A third login endpoint
> (`POST /api/auth/login`, which the browser does not use) had its own hardcoded
> 8 hours: it now reads the same setting, and **is still there** — TODO 87 A1
> decided it should be removed, and that has not been carried out.

---

## 11. Notifications

*State: DEFERRED — not built*

The owner is told when a technical test passes or fails, and when the director
approves or rejects. Notifications appear on the site, with email where
appropriate.

> **NOT BUILT.** `lib/notify.js` emails *administrators* about disk and incident
> conditions only — an admin alert channel, not an asset event system.

---

## 12. Discussion

*State: DEFERRED — a link-out; the in-portal board is not being built*

A board **separate** from the portal, reached by a link. Separate accounts; a
portal role does not carry over.

> **SUPERSEDES:** `Specification_v04_web.html` specifies "integrated real-time
> Skype-style voice/text chat built directly into the private contributor web
> portal". That is not being built, deliberately.

> **DECIDED, NOT BUILT:** revoking portal access revokes board access. It is the
> reason the board is worth the operational cost, and it needs a portal-side
> deactivation hook — which now exists.

---

## 13. Specified and not built

*State: DEFERRED — specified and unbuilt, except three that are now built: the manifest hash (§4), the receipt's asset half (§5) and image/video previews (§7)*

| | |
|---|---|
| previews of models and scene files | images and video are built (§7); a picture of a model needs a renderer, and none is connected |
| permissions, licences, commercial-use provenance | nothing at all; a Steam release needs the right to use an asset |
| game builds, branches, official builds | nothing |
| the test receipt protocol | **asset half BUILT** (§5); the game-build half waits on builds (§8) |
| asynchronous processing with a visible state | hashing is synchronous inside the request |
| AI classification and suggested tags | nothing |
| signed upload URLs | uploads go through Express |
| a storage-provider abstraction | local disk |
| the Browser Sandbox as an asset consumer | a canvas minigame that fetches nothing |
| `user`-role access to assets made available to users | no route names `user` |
| deploying a branch to a shared online sandbox | **superseded** — no git, no shared sandbox, and deploying is the build machine's job, not the portal's |
| anti-piracy: HWID fingerprinting, signed build URLs, telemetry in client binaries | nothing at all — asserted as architecture in `Specification_v04_web.html` §01, no code anywhere |

---

## 14. Open questions

- The **technical test's placement**: upload (settled) versus submit-for-game
  against a build (the PDF's rule). They may be two different tests.
- **Who recommends a version** (`asset_recommended_versions` has no writer).
- **SSO handoff into GitHub**: it was justified by the game living in GitHub.
  With Perforce, what is it for?
- **Whether the studio's override of a developer's metadata** applies at
  approval or afterwards, and whether the store and the workspace can hold
  different descriptions of the same asset.

---

## 15. The relationship to the PDFs, in one place

| PDF says | status |
|---|---|
| the game is maintained separately in GitHub | **SUPERSEDED** — Perforce (§8) |
| one central GitHub repository for everything | **SUPERSEDED** — two repositories, two tools |
| published files are immutable; admin may read/write/delete | **PARTLY SUPERSEDED** — immutable stands; "write" means withdraw, not rewrite (§5) |
| `assets.status` and `asset_versions.visibility` | **SUPERSEDED** — the stage is per version (§5) |
| "every asset has an owner" | **RESOLVED** — the owner is the studio; private assets belong to their workspace, and creators are recorded per version. No column is needed (§2) |
| "do not use a single category column" | **RESOLVED** — right about classifications, wrong about the category. The many-to-many is **tags**; the category stays one (§3) |
| private versions visible to "you, admin, superuser" | **SUPERSEDED** — owner only; admin by impersonation (§2) |
| roles: user, developer, admin, superuser | **SUPERSEDED** — user, developer, prod, admin (§6) |
| the Director decides | **BUILT as `prod`** (§6) |
| notifications to the owner | **NOT BUILT** (§11) |
| discussion attached to assets, versions, submissions, approvals | **DEFERRED** — a link-out (§12) |

---

## 16. The steward

*State: BUILT — an agent definition. Not a portal role, and no account.*

A Claude Code agent defined at **`.claude/agents/steward.md`** that looks after
the **running box** rather than the codebase. Four duties:

- **garbage collection** — is the nightly job running, is the store sound, what
  is accumulating, what would the collector remove
- **audit-log growth** — how fast `audit_logs` is growing, what it is costing,
  and what archiving would mean (there is no archiving mechanism today)
- **bug reports** — working through open reports with the owner: what each says,
  whether it still happens, whether a commit already fixed it, and what the
  resolution note should name
- **deployment** — walking `docs/DEPLOY.md` section by section, running the
  proofs it can and naming the steps that are only the owner's

**It is advisory.** It measures, verifies and reports in four parts — what it
checked, what is true, what the documents claim that the box does not do, and
what needs the owner's decision. It does not write files, commit, resolve a
report, change a setting, or run a collection.

**It is not a role.** There is no account, no `requireRole` entry, and nothing
in `roles.js`. It runs the same read-only commands and checks a person would,
and its findings are proposals to the owner or to whoever is building.

> **If it is ever given the power to act** — writing a row, resolving a report,
> collecting garbage — it needs its own identity first. Acting as `admin` would
> record every agent action as the administrator's, and the "who did what"
> record (§6, and the note on sessions in §7) would stop being true.
