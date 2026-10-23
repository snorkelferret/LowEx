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

An asset can be shared with colleagues, downloaded, discussed and used as a
starting point without ever being submitted for the game. Being *in the store* is
not being *in the game*.

---

## 2. One library, not three spaces

*State: DECIDED — the model is settled, the code is a step behind*

> "The OpenWorld Asset Library is the central place for storing, discovering and
> sharing the things we create for the game." — *Library PDF*

**There is ONE library.** It can contain anything from a reference photograph to
a finished Unreal asset. Every asset in it carries three things:

| | |
|---|---|
| **an owner** | the developer who uploaded it |
| **a stage** | private → published → submitted → tested → approved |
| **game versions** | production, candidate dev, experimental — one, several, or none |

**The workspace is the private end of the same thing**, not a separate place with
separate files. The game store is the subset approved into a game version.

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

---

## 4. Upload

*State: BUILT, with the versioning rule DECIDED and not yet applied*

The developer uploads a folder, a zip, or a selection of files. The request
carries the components and, **optionally**, a name, category and description —
which are the developer's *proposal*. The studio may override them later.

**The flow, in order:**

1. **Compare the components first** — `relative_path`, `filename`, `sha256` —
   before any asset metadata is written.
2. **Any pathname, filename or content changed** → a new version, carrying the
   developer's metadata with it.
3. **Nothing changed in the components** → nothing is written yet. A popup says
   *"Nothing has really changed except the description you provided"* and offers
   **Create a new version with this description** or **Cancel**.
4. **Either way the outcome is recorded in the history** — refusals and
   cancellations included.

**Unchanged components are never stored twice.** The SHA store holds one copy of
any content; a new version references the same rows. The same file uploaded a
hundred times costs one blob.

> **DECIDED, NOT BUILT:** the code creates a version on *every* upload and
> compares nothing (TODO 87, A5/A10). `uploadmodel01` and `dbspec01` already
> describe the rule above; they are the specification for the fix.

**The comparison is the deterministic manifest hash** — `filename + SHA256 +
size`, sorted by canonical path, then hashed. One implementation serves three
purposes: detecting change, identifying content, and proving that *the version
tested is the version submitted*.

> The manifest hash identifies **content**, not the version. Two versions may
> share one, because an insisted metadata change makes a version without changing
> a byte. It must never be `UNIQUE`, and never used as a version identifier.

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
- **TECHNICAL TEST** — against an official game build (§8).
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
| **prod** | production — a **craft** role, not a seniority. Approvals, comments, categories, boards |
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

> **PREREQUISITE:** the audit trail (below). A role switch that is not audited is
> only a way of doing things invisibly.

---

## 7. Approval

*State: BUILT*

A developer submits a workspace version; `prod` approves or rejects it. Approval
writes an immutable `asset_version` into the store, copies the file references
(never the bytes — one copy), and records which asset and version it came from.

**Technical and artistic decisions are separate records**: `technical_check_runs`
for the first, the approval for the second. "Technically correct but artistically
rejected" and "artistically excellent but technically not ready" must both be
expressible.

> **DEFECT (TODO 87, C1):** there is **no audit record** anywhere on this path —
> submit, test, approve and reject all record nothing, while the specification
> requires that all security-sensitive state changes are auditable.

---

## 8. Releases, and the game's versions

*State: DECIDED — not built (TODO 53, 60, 67)*

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

*State: BUILT; the idle model is DECIDED — not built*

**Sessions expire on idleness, not on a fixed clock.**

| | |
|---|---|
| developer | idle **2 hours**, warning, then **3 minutes** to respond |
| prod / admin | idle **30 minutes**, absolute cap **8 hours** |
| everyone | absolute cap **24 hours**, however active |

**An active session is never logged out.** The 24-hour cap is the outer bound: a
token somebody else is using dies within a day.

**The server enforces; the popup is a courtesy.** A closed or sleeping tab runs
no timer, so client-side-only expiry logs nobody out.

> **SUPERSEDES:** the manual says "a session lasts 8 hours", and the browser's
> login issues 2. There are also two login endpoints with different lifetimes;
> the dead one is removed. See TODO 87, A1.

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

## 13. What is not built at all

*State: DEFERRED — each was specified and none exists*

| | |
|---|---|
| permissions, licences, commercial-use provenance | nothing at all; a Steam release needs the right to use an asset |
| game builds, branches, official builds | nothing |
| the test receipt protocol | nothing — the only mechanism proving *the version tested is the version submitted* |
| asynchronous processing with a visible state | hashing is synchronous inside the request |
| AI classification and suggested tags | nothing |
| signed upload URLs | uploads go through Express |
| a storage-provider abstraction | local disk |
| the Browser Sandbox as an asset consumer | a canvas minigame that fetches nothing |
| `user`-role access to assets made available to users | no route names `user` |

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
| "every asset has an owner" | **NOT BUILT** — `assets` has no owner column (§6, TODO 87 C2) |
| "do not use a single category column" | **NOT BUILT** — a single free-text column (§3, TODO 87 C3) |
| private versions visible to "you, admin, superuser" | **SUPERSEDED** — owner only; admin by impersonation (§2) |
| roles: user, developer, admin, superuser | **SUPERSEDED** — user, developer, prod, admin (§6) |
| the Director decides | **BUILT as `prod`** (§6) |
| notifications to the owner | **NOT BUILT** (§11) |
| discussion attached to assets, versions, submissions, approvals | **DEFERRED** — a link-out (§12) |
