# The integration contract

**Between the portal and the Unreal side.** For whoever works on the game —
person or agent — and for the portal's own records.

It covers three questions, and they are separate:

| question | record | state |
|---|---|---|
| was this asset tested, and where? | **test receipt** | **built and proven** |
| what version of the game exists? | **build record** | **built** |
| which approved assets are in the game? | **approved list** (portal → tool) | **built** |
| | **inclusion receipt** (tool → portal) | proposed |

*State: the test receipt, the build record and the approved list answer today.
The inclusion receipt is marked **proposed** — a contract to build against,
not a description of something that answers now. That distinction is kept
throughout, because a contract that describes an endpoint returning 404 is
worse than one that says so.*

---

## The agenda

*2026-11-19. The open items between the two sides, in the order they unblock
each other. The detail is in the sections below; this is the list to work
from.*

| # | item | state | who moves next |
|---|---|---|---|
| **A1** | A test receipt from inside the editor: the stream the developer worked in, its parent, the game changelist, the levels, the exchange file and hash | portal built; nothing reports | **game side** |
| **A2** | One real build report, with the stats the pipeline can produce | portal built; nothing reports | **game side** |
| **A3** | Candidate builds name `base_stream` and `base_changelist` | portal built | **game side** |
| **A4** | The approved list — what the tool may import | **built**, and proven | game side: confirm the shape suits the tool |
| **A5** | The inclusion receipt — what actually went into the game | proposed | **both**: the shape, and whether it replaces the typed integration or coexists |
| **A6** | The account, client and key: `val`, `val-agent`, ticket, 0600 key, tooling on | decided | **you**: issue the key on the portal machine |
| **A7** | The submission gate | **closed by decision**: the gate is the stream, the build is advice; a failed build cannot be accepted | — |

**A1 and A2 are the two that make the portal's pages real.** Until a receipt
arrives, the portal cannot say which stream a developer used; until a build
report arrives, the Streams page has nothing from a machine to show.

---

## The one rule

**The portal never asks.** It does not query Perforce, it does not call the
game, and it does not call Unreal. Everything arrives as a **push** from the
side that knows:

```
   Unreal editor / build machine  ──push──►  portal
   Perforce change-commit trigger ──push──►  portal   (already built)
   portal                         ──X──►    neither
```

The reason is not taste. The portal holds reviews, approvals and provenance;
the game holds hundreds of gigabytes of binary content and a version-control
server. A portal that could ask would need credentials to both, would fail
when either is down, and would make the review system a dependency of the
build. A push can be queued and retried; a query has to succeed.

**The same rule applies to content.** The tool reads approved blobs from the
store by SHA on the machine where the store lives (TODO 109). It does not ask
the portal for files.

**The tool may read from the portal** — the approved list below is exactly
that. The rule forbids the portal from calling out, not the tool from asking a
question the portal can answer from its own records.

---

## Getting a key

A key is a program's way in. It is not an account, has no role, and cannot
approve, browse or administer anything.

```bash
node scripts/api-key.js --create "unreal-editor-tool"
```

The plaintext is printed **once** and never stored — only a prefix and a
SHA-256 are. Put it in a file with mode 0600 on the machine that runs the
tool. Never in a command line, never in git, never in a message to another
agent.

The receipt endpoint also honours the **Integration tooling** setting. It is
off by default; with it off, a valid key is refused. That switch is the
recorded exception to standing rule 2 (Unreal is off limits), and turning it
off withdraws the capability without a deploy.

Revoke with `node scripts/api-key.js --revoke <id>`.

## The Perforce account, for now

**The game agent runs as `val`** — decided 2026-11-18, to stay inside the five
standard users until more seats are bought.

**The arithmetic, recorded so it is not re-derived.** The free tier is five
standard users and twenty workspaces. Four developers (Val is one), a build
machine, and the operator admin is five — the admin is an operator user, free
and doing no file work. The agent therefore shares Val's seat rather than
taking a sixth, and its submits read as `val` in the depot history, which is
true of the account and not of the person. A dedicated seat is a later
purchase: get the quote before it is needed, and know that work done before it
exists stays attributed to `val` for ever. That is the cost of starting now.

- **Use your own client**, named for what it is: `val-agent`. The change-commit
  notification records the client, so that is what tells the agent's submits
  apart from Val's. Nothing else will.
- **Authenticate by ticket**, not by typing a password into a script. Keep the
  ticket file at mode 0600 on the machine that uses it; never in a message,
  a repository, or a command line.
- **Report `p4_user: "val"`** in a receipt, because that is the account that
  did the work. The portal stores what the tool reports; it cannot verify it.
- **When the seats are bought**, a dedicated account changes nothing already
  submitted: that work stays attributed to `val`. That is the cost of starting
  now.

---

## 1. The test receipt — BUILT

**`POST /api/integration/receipts`**

```
Authorization: Bearer <key>
Content-Type: application/json
```

It records: **this asset version was tested in this game version, in this
level, and the result was this.** It cannot approve anything. It is evidence.

### Body

| field | type | required | meaning |
|---|---|---|---|
| `workspace_version_id` | integer | yes | the portal version tested |
| `changelist` | integer ≥ 1 | yes | the game changelist the client was synced to |
| `stream` | string | yes | the Perforce stream the editor was on, e.g. `//LowExpectations/dev` |
| `parent_stream` | string | no | for a task stream, the stream it was branched from — the game version |
| `levels` | string[] | yes | the level(s) the asset was placed in, 1–20 entries |
| `exchange_filename` | string | yes | the interchange file imported: `.fbx`, `.glb`, `.gltf`, `.usd`, `.usda`, `.usdc`, `.usdz` |
| `exchange_sha256` | string | yes | lowercase SHA-256 of that file |
| `result` | `passed` \| `failed` | yes | a failed test is recorded, not discarded |
| `checks` | array | no | `{ name, status, message }`, status one of `passed`, `failed`, `warning`, `skipped`, `error` |
| `p4_user` | string | no | the Perforce user the editor was running as |
| `editor_build` | string | no | the editor version |

**Streams must be absolute Perforce paths**: `//Depot/Name`, no spaces.

### What the server checks

- **Integration tooling is on** — otherwise `403`.
- The version exists, is active, and has a content identity — otherwise `404`
  or `409`.
- **The exchange file is in that version**: the same filename and hash must be
  a component of the version, or `409`. This is the binding. A receipt for
  something the developer did not upload is not a receipt for this submission.
- **The same receipt twice is harmless.** The key is
  `(workspace_version_id, changelist)`; a retry returns `200` with
  `duplicate: true` instead of a second row.
- The server records `trigger_confirmed: true` when the same changelist has
  already arrived from the change-commit trigger. Two independent statements
  of one fact; an unconfirmed receipt is still evidence, so this is a flag,
  not a refusal.

### Responses

| status | meaning |
|---|---|
| `201` | recorded |
| `200` | duplicate — already recorded, nothing changed |
| `400` | a malformed field; the message names it |
| `401` | no key, or the wrong one |
| `403` | integration tooling is off |
| `404` | no such version |
| `409` | the exchange file is not in the version, or the version has no content identity |

### Example

```bash
curl -sS -X POST "$PORTAL_URL/api/integration/receipts" \
  -H "Authorization: Bearer $LOWEX_TOOL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "workspace_version_id": 35,
    "changelist": 7,
    "stream": "//LowExpectations/task-val-1",
    "parent_stream": "//LowExpectations/main",
    "levels": ["/Game/Levels/LE_Forest_01"],
    "exchange_filename": "tree.fbx",
    "exchange_sha256": "<64 hex>",
    "result": "passed",
    "p4_user": "val",
    "editor_build": "UE 5.5"
  }'
```

### What it is evidence for, and what it is not

It proves **these bytes** (by exchange-file hash) were imported and placed in
**this level**, in **this build**. It does not prove a person looked at the
result — production's judgement remains production's. It is first-party code
on a trusted machine; a rewritten tool can lie. It makes the honest path the
easy path and leaves a record.

---

## 2. The build record — BUILT

**`POST /api/integration/builds`**

It records: **the game was built from this stream at this changelist.** A
build typed into the admin page by hand was the only kind available before
this; nothing connected it to a stream or to a receipt.

### Body

| field | type | required | meaning |
|---|---|---|---|
| `stream` | string | yes | the game stream the build came from |
| `changelist` | integer ≥ 1 | yes | the changelist built |
| `released_on` | `YYYY-MM-DD` | no | when the build was released, if it was |
| `name` | string | no | the build's name; defaults to `<stream> @ CL <changelist>` |
| `build_id` | string | no | the build machine's own identifier |
| `built_at` | ISO 8601 | no | when the build ran; stored in UTC |
| `base_stream` | string | no | for a candidate build: the game stream it was built over |
| `base_changelist` | integer | no | for a candidate build: that stream's changelist |
| `result` | `succeeded` \| `failed` | no | the build's own result |
| `failed_stage` | string | no | where it stopped — cook, compile, package |
| `duration_seconds` | integer ≥ 0 | no | wall-clock time of the build |
| `output_bytes` | integer ≥ 0 | no | size of the packaged build |
| `warnings` | integer ≥ 0 | no | the build's warning count |
| `errors` | integer ≥ 0 | no | the build's error count |
| `log_excerpt` | string ≤ 2000 | no | the first errors, not the whole log |
| `notes` | string | no | free text |

`base_stream` and `base_changelist` go together or not at all: a base stream
with no changelist does not identify a state of the game.

### What the server checks

- **Integration tooling is on** — otherwise `403`.
- `stream` and `base_stream` are absolute Perforce paths; `changelist` is a
  positive integer; `built_at`, when given, is an ISO 8601 date or date-time.
- `result` is `succeeded` or `failed`; every count and size is a non-negative
  integer; `log_excerpt` is at most 2000 characters. A field that is absent is
  absent, not zero — a failed build has no output size.
- **The same build twice is harmless.** The key is `(stream, changelist)`; a
  retry fills in anything missing and returns `200` with `duplicate: true`.
  **A retry never overwrites a value already recorded.**
- The row is written with `source = 'reported'` and `created_by` null. A build
  typed by hand before the machine reported builds has `source = 'typed'` and
  no stream; the page no longer creates them.

### Responses

| status | meaning |
|---|---|
| `201` | recorded |
| `200` | duplicate — already recorded; missing fields filled, nothing overwritten |
| `400` | a malformed field; the message names it |
| `401` | no key, or the wrong one |
| `403` | integration tooling is off |
| `409` | that name, or that stream and changelist, is already recorded |

### Example

```bash
curl -sS -X POST "$PORTAL_URL/api/integration/builds" \
  -H "Authorization: Bearer $LOWEX_TOOL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "stream": "//LowExpectations/main",
    "changelist": 7,
    "name": "0.4 Experimental, 18 Nov",
    "build_id": "LE-2026.11.18-01",
    "built_at": "2026-11-18T17:30:00Z",
    "released_on": "2026-11-18"
  }'
```

A candidate build adds the stream and changelist it was built over, and a
failed build reports what the machine measured:

```json
{
  "stream": "//LowExpectations/main",
  "changelist": 8,
  "result": "failed",
  "failed_stage": "cook",
  "duration_seconds": 2734,
  "warnings": 41,
  "errors": 3,
  "log_excerpt": "LogCook: Error: could not cook /Game/Levels/LE_Forest_01"
}
```

### Who reviews it

The build machine reports the build; **it does not judge it.** Production or an
administrator accepts or rejects the build itself, with a reason for a
rejection. That record is the portal's, not the machine's, and it is what makes
"a good build" mean something for the advice shown on a submission.

**A build whose `result` is `failed` cannot be accepted.** Rejecting it, with
the reason, is the record. A fixed build is a new build at a new changelist.
A failed build is also never offered as freshness advice.

### The stats, and what is easy to produce

The easy set, and the one the portal shows: **result** from the exit code,
**duration** from two timestamps, **output size** from the packaged folder,
**warning and error counts** from the build tool's summary, **the failing
stage**, and **the first error lines**. Per-stage timings, peak memory and
shader counts exist in the log but their format varies by engine version; they
are not part of the contract.

**Build duration is not runtime speed.** How long the machine took is a build
stat; how slowly the level loads is a test result, and it belongs in the
receipt's `checks`.

### Why it matters

Without it the portal can say "a receipt exists" but not **which version of
the game that build is**. With it, "built against" is answerable: *asset
version 35 was tested at CL 7, which is build 0.4 Experimental of `//LE/main`
on 18 November*.

It also lets the submission gate tighten later: a receipt whose changelist
matches no known build is a test in something the portal cannot name. **That
rule is not built yet** — the gate still checks the stream, not the build.

---

## 3. The approved list — BUILT

**`GET /api/integration/approved?stream=//LowExpectations/main`**

This is the portal → tool half of "which assets are in the game", and the one
place the portal ANSWERS rather than is told. The one-way rule forbids the
portal from calling out; it does not forbid the tool from asking a question the
portal can answer from its own records.

It returns the versions **approved for that stream** that a build of the stream
does not already hold — the import list. A version approved for another stream
is not here. The exclusion is inferred from build membership until the
inclusion receipt exists; then it becomes exact.

**Request**

```
GET /api/integration/approved?stream=//LowExpectations/main
Authorization: Bearer <key>
```

| status | meaning |
|---|---|
| `200` | the list |
| `400` | no stream, or a malformed one |
| `401` | no key, or the wrong one |
| `403` | integration tooling is off |

### Response

```json
{
  "stream": "//LowExpectations/main",
  "versions": [
    {
      "asset_id": 4,
      "asset_name": "Factory",
      "asset_version_id": 4,
      "version_number": 1,
      "manifest_hash": "77dc…",
      "category": "Prop",
      "approved_at": "2026-11-18 17:55:36",
      "files": [
        {
          "relative_path": "export",
          "filename": "factory.fbx",
          "sha256": "be28…",
          "size": 4119
        }
      ]
    }
  ]
}
```

**The list is a set of addresses, not a content API.** The SHAs are paths into
the store on the same machine (`uploads/files/<sha>`, TODO 109). The tool
verifies each file against its SHA as it reads it; no bytes travel through the
portal.

**Scope of the key.** Approved versions only. Never a workspace version, never
a private asset, never a session. The key that posts receipts may hold this
read as well — the same key, one capability set: *receive the approved list,
report what you did*.

**When the portal is unavailable**, the tool can start from a list fetched
earlier: the addresses do not change, and an import of a version that is still
approved is still correct. The receipt is what cannot happen offline.

---

## 4. The inclusion receipt — PROPOSED, NOT BUILT

**`POST /api/integration/inclusions`** does not exist yet. This is the tool →
portal half, and the one that answers **"which assets are in the game?"**

Today the portal has `asset_integrations`: an administrator types a changelist
after integrating. It is an assertion. The inclusion is the same fact **pushed
by the thing that did it**.

### Body

| field | type | required | meaning |
|---|---|---|---|
| `asset_version_id` | integer | yes | the approved version that went in |
| `changelist` | integer ≥ 1 | yes | the Perforce changelist that contains it |
| `stream` | string | yes | the stream written to |
| `depot_paths` | string[] | yes | the depot files the integration wrote, 1–2000 |
| `levels` | string[] | no | levels the asset was placed in |
| `result` | `included` \| `failed` | yes | a failed integration is recorded too |
| `notes` | string | no | |

**Proposed behaviour**, following the receipt's rules:

- the same key, refused while integration tooling is off;
- idempotent on `(asset_version_id, changelist)`;
- writes the `asset_integrations` record (who, when, changelist) marked as
  **reported**, not typed;
- `depot_paths` is the **matcher's answer, supplied rather than guessed**: the
  change-commit notification says which depot files changed, and this says
  which approved version those files are. Without it the portal has a file
  list and no way to resolve it (TODO 88 §15).

### What it enables

- **The build page shows what is actually in it.** An asset appears in a build
  because an inclusion names that build's changelist — not because somebody
  ticked a box.
- **"Is this in the game?" stops being a dash.** The store's `In the game`
  column currently means "somebody typed a changelist"; after an inclusion it
  means the thing that wrote the files said so.
- **A build's contents can be reconstructed** from inclusions + the trigger,
  and two independent statements of the same changelist are worth more than
  one.

**Not decided:** whether an inclusion replaces the administrator's assertion
entirely, or coexists while both paths exist. The direction of the record
suggests replacement; the transition needs to be stated before it is built.

---

## How the records join

**The changelist is the join.**

```
   build record   stream //LE/main, CL 7, "0.4 Experimental"
   receipt        asset version 35, stream //LE/task-1, parent //LE/main, CL 7
   submission     destination //LE/main
                                              ↓
   tested in CL 7, which is a build of //LE/main, for a submission to //LE/main
```

And for what is in the game:

```
   inclusion      asset version 4, stream //LE/main, CL 9, depot paths…
   build record   stream //LE/main, CL 9, "0.4"
                                              ↓
   asset "Factory" v1 is in build 0.4, because the integration that wrote the
   files said so and Perforce's notification names the same changelist
```

The submission gate (built) requires a passing receipt whose stream **or
parent stream** is the destination. It does not yet require the changelist to
be a known build: build records exist now, but the gate has not been tightened
to consult them. That is the next rule, not a rewrite.

---

## Requests to the game side

*2026-11-19. The portal's side of both records is built and proven with test
payloads; nothing real has arrived yet. These are the things needed next, in
the order they become useful. Propose a change below or in a message; the
portal records the decision in `website/TODO`.*

### R1 — Say which stream the developer worked in

That is the **test receipt** (§1, built). When a developer tests an asset, the
thing running inside the editor posts it: `workspace_version_id`, the
**stream the editor was on** (the task stream), its `parent_stream` (the game
stream it was branched from), the game `changelist`, the `levels` the asset was
placed in, the exchange file and its hash, and the result.

The portal cannot work this out for itself — it has no game content and never
asks Perforce. Without this report it cannot say which stream a developer used,
which is exactly the question the submission gate is built on.

If the editor tool is not yours, say who produces it; the report has to come
from whatever is running inside the editor.

### R2 — Report one real build

`POST /api/integration/builds` is waiting. Send one report for the stream you
actually build, with as many of the measured fields as the pipeline can honestly
produce:

```json
{
  "stream": "//LowExpectations/main",
  "changelist": 7,
  "name": "0.4 Experimental, 18 Nov",
  "build_id": "LE-2026.11.18-01",
  "built_at": "2026-11-18T17:30:00Z",
  "released_on": "2026-11-18",
  "result": "succeeded",
  "duration_seconds": 2734,
  "output_bytes": 19327352832,
  "warnings": 41,
  "errors": 3,
  "log_excerpt": "LogCook: Display: done"
}
```

The easy set, so nobody goes hunting: **exit code** for `result`; two
timestamps for `duration_seconds`; `du` of the packaged folder, **excluding
PDBs and symbols**, for `output_bytes`; the build tool's summary for the
counts; the last stage that ran for `failed_stage`; the first error lines for
`log_excerpt`. If one of these cannot be produced reliably from UAT, say so
here rather than sending a guess.

The first real report is also the test that the page reads it: the portal shows
it under the stream, with its stats, and marks it over the size or time limit
if it is.

### R3 — Candidate builds name their base

When you build from a task stream, send `base_stream` and `base_changelist` as
well. That is what tells the portal which game stream the candidate was built
over, and it is the pair that lets a change be tested in the game without
changing the game.

### R4 — Report failures too

A build that failed is a fact, not a missing report. Send `result: "failed"`,
the stage, and the excerpt. The portal refuses to accept a failed build and
shows it with its reason; a fixed build is a new report at a new changelist.

### R5 — Say what is in the game

That is the **inclusion receipt** (§4, proposed). When an approved version is
integrated, the thing that did it reports the `asset_version_id`, the
`changelist` that contains it, the `stream` written to, the `depot_paths` it
wrote, the levels it was placed in, and whether it went in.

It answers "which assets are in the game" with a record made by the process
that did it, rather than an administrator typing a changelist afterwards. It
also completes the file matcher: the change-commit notification says which
depot files changed, and this says which approved version those files are.

The other half is the **approved list** (§3, proposed):
`GET /api/integration/approved?stream=...`, a set of addresses and hashes the
tool imports from. If neither shape suits the tool, propose the shape you need
— the portal owns the document because the portal validates against it.

### R6 — The account, the client, the key

`val` for now, in **your own client** named `val-agent`, authenticated by
ticket. Receipts and build reports say `p4_user: "val"`, because that is the
account that did the work. The key is issued on the portal machine with
`node scripts/api-key.js --create "..."`, shown once, kept in a 0600 file, and
never in a message or a repository. **Integration tooling** must be on, or the
endpoints refuse the key.

---

## What the portal does with a receipt

- **A game destination needs one.** A submission for `//LE/main` with no
  passing receipt covering that stream is refused, and the refusal is shown in
  the dialog.
- **A receipt names one stream and counts for no other.** If production
  retargets a submission to a different game version, the receipt does not
  cover it and the submission returns to needing a test.
- **The library needs none.** Publishing is not a game submission.

---

## When the portal is down

- A **receipt** cannot be posted. The tool should keep it and retry; the
  submission that needs it cannot proceed until it lands. The test itself is
  not lost.
- The **trigger** loses a notification and nothing else. A gap is visible via
  the cursor (`GET /api/perforce/cursor`) and a later receipt for the same
  changelist records `trigger_confirmed: false`, which is a fact rather than a
  fault.

Neither path can stop a Perforce submit. That is deliberate: the trigger is
`change-commit`, after the fact.

---

## Changing this contract

This file is the contract. If the game side needs a field, a different name,
or a new record, **propose it here** — in this file or in a message — and the
portal records the decision in `website/TODO` (item 109 for the tool, item 110
for the destination and receipt). The portal owns this document because the
portal validates against it.

**Do not edit `website/TODO` from the game side.** Two authors in one decision
log is how a log stops being trustworthy. **Decisions about how the game side
operates** — the account, the client, the ticket, the build machine — are
recorded here; they are not portal decisions and do not need a TODO row. The
portal copies a product decision into the TODO when there is one.
