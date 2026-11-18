# The integration contract

**Between the portal and the Unreal side.** For whoever works on the game —
person or agent — and for the portal's own receipts.

*State: the test receipt is **built and proven**. The build record is
**proposed and not built**: everything under "The build record" is a contract
to build against, not a description of something that answers today. That
distinction is kept throughout, because a contract that describes an endpoint
that returns 404 is worse than one that says so.*

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

## 2. The build record — PROPOSED, NOT BUILT

**`POST /api/integration/builds`** does not exist yet. This is the contract to
build against.

It records: **the game was built from this stream at this changelist.** A
release in the portal today is an administrator typing a name and optionally a
changelist; nothing connects it to a receipt or to a stream.

### Body

| field | type | required | meaning |
|---|---|---|---|
| `stream` | string | yes | the game stream the build came from |
| `changelist` | integer ≥ 1 | yes | the changelist built |
| `name` | string | no | the build's name; defaults to `<stream> @ CL <changelist>` |
| `build_id` | string | no | the build machine's own identifier |
| `built_at` | ISO 8601 | no | when the build ran; the server clock otherwise |
| `base_stream` | string | no | for a candidate build: the game stream it was built over |
| `base_changelist` | integer | no | for a candidate build: that stream's changelist |
| `notes` | string | no | free text |

**Proposed behaviour**, following the receipt's rules:

- authenticated by the same key, and refused while integration tooling is off;
- idempotent on `(stream, changelist)`;
- creates or updates a `releases` row marked as **reported by the build**
  rather than typed, gaining a `stream` column and a source;
- `base_stream` / `base_changelist` describe a **candidate build** — a task
  stream over a game stream — which is the build that lets a change be tested
  in the game without changing the game (TODO 110, option b).

### Why it matters

Without it the portal can say "a receipt exists" but not **which version of
the game that build is**. With it, "built against" is answerable: *asset
version 35 was tested at CL 7, which is build 0.4 Experimental of `//LE/main`
on 18 November*.

It also lets the submission gate tighten later: a receipt whose changelist
matches no known build is a test in something the portal cannot name.

---

## How the two join

**The changelist is the join.**

```
   build record   stream //LE/main, CL 7, "0.4 Experimental"
   receipt        asset version 35, stream //LE/task-1, parent //LE/main, CL 7
   submission     destination //LE/main
                                              ↓
   tested in CL 7, which is a build of //LE/main, for a submission to //LE/main
```

The submission gate (built) requires a passing receipt whose stream **or
parent stream** is the destination. It does not yet require the changelist to
be a known build, because no build records exist. That is the next rule, not a
rewrite.

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
log is how a log stops being trustworthy.
