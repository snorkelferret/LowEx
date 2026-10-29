# The standing rules

**Ten rules that apply to every change.** They are not tasks and they are never
"done". `docs/SPEC.md` says what the system is; `website/TODO` says why; this
file says what must not be broken while changing either.

**Why it is short.** A rule earns a place here only if a breach would be caught
by nothing but somebody remembering. Anything enforced by a check, a module or
the database already — `check:routes`, `check:store`, `UNIQUE(sha256)`,
`storagePaths` — is not listed. The list is for the invisible ones.

**How to use it.** Every commit ends with one line:

```
Rules touched: none
```

or

```
Rules touched: item 35 — see TODO 89
```

Writing "none" is a claim you have had to check. **Crossing a rule is allowed**
— it is sometimes the right call — but the decision goes in the TODO with the
reason, and the commit names it. A rule crossed silently is the thing this file
exists to prevent; a rule crossed in writing is a decision.

**If this file and the TODO disagree, the TODO wins** and this file is wrong.
It is a doorway into the reasoning, not a replacement for it.

---

## 1. Nothing uploaded ever runs

**No content a developer uploads is executed, and no parser we did not write is
pointed at it without a decision.** Not a script, not a build file, not a `.json`
some tool would read as configuration. Not an archive extracted into a path
somebody chose.

*A breach looks like:* a feature that "just renders" a file, a thumbnailer or a
transcoder added as a convenience, or an unzip that trusts the central
directory. **Writing a new decoder of uploaded content is a decision, not a
detail** — TODO 89 is the one recorded exception (previews, with its risks
written down beside it).

TODO 35. `docs/assettypes01` for the upload types.

## 2. Unreal, Blender, Maya and Nuke are off limits

**Not installed, launched, configured or fiddled with.** They are installed and
working, nothing about this repository requires touching them, and an agent
investigating them is risk with no upside. **If something seems to need one of
them, ask.**

*A breach looks like:* "I'll just run Blender headless to render a preview" —
which is how a working install gets changed, and how `model_preview` would have
been built wrong.

The TODO's game-project section, after item 52.

## 3. Images are not game assets

**An image never enters the game on its own.** It goes to the library, and it is
in the game only by being part of something that ships.

    image   ->  the library                    shared    does not ship
    asset   ->  the game store                 the game  ships

*A breach looks like:* a route, a tab or a filter that treats an approved image
as game content, or "publish this image to the game" appearing as an action.

TODO 58. The one-library model that follows from it is TODO 86.

## 4. Authoring happens outside the engine; the engine is downstream

**Assets are made in the DCC and flow one way.** Level layout, lighting and set
dressing are engine work and stay there. **You do not edit an asset in the
engine and carry it back.**

*A breach looks like:* a feature that reads a change out of Unreal and rewrites
the Blender source, or a review step whose canonical copy is the engine's.
Reimport metadata belongs to one artist on one machine; it is not a studio
record.

TODO 61.

## 5. One mechanism, not one per space

**If something exists, use it or point at it.** A second implementation is how
two answers to the same question start — and they always agree on the day they
are written.

*A breach looks like:* a thumbnailer copied from the library into the store
route — the duplication item 84 audited — a second path builder, a second "is
this file an image" list, a second definition of "what counts as garbage".
**Fixing the shared one is the work**, even when copying is faster.

TODO 84. `backend/lib/thumbnails.js` and `backend/lib/collector.js` are the
arrangements this rule produces: one implementation, dependencies as arguments.

**The system's own addresses and ports are one instance of this.** Every port,
hostname and domain comes from `shared/config.mjs`; the backend and the Vite
config both resolve from it, and `npm run check:config` fails on any literal
found anywhere else. It was five defaults for three values in four files until
2026-10-29, and they agreed by coincidence until one of them did not.

## 6. The library is the whole system; the game is a tagged subset

**One store.** The game's content is a subset of it, marked as in the game.
Publishing something does not put it in the game, and putting it in the game
does not move it anywhere.

*A breach looks like:* a second store for game content, or an approval that
copies bytes instead of marking a version.

TODO 86.

## 7. No read path into a developer's workspace

**Not for other developers, not for production, not for administrators.** The
workspace is private because people need to make a mess while they work. When a
privileged person genuinely needs to look, it is **impersonation** — marked,
time-bounded and audit-logged. It is not built yet (TODO 5), and until it is
there is no way in at all.

*A breach looks like:* a read-only "browse" route, an admin listing, a
convenience endpoint "just for support". **A preview is not a breach** — it is a
picture the portal made from the content, reachable only through the approval it
belongs to (TODO 89).

TODO 85, TODO 86. Stated in the manual under *Administering*.

## 8. Perforce tells the portal; the portal never asks

**One direction.** Perforce sends the portal what happened. The portal does not
query it, poll it, or write to it — not even to check.

*A breach looks like:* a live `p4 files` to draw a cell map, a periodic sync
check, an accounts reconciliation that reads from Perforce instead of being
given a list. **It is a design change, not a convenience**: it changes which
system depends on which, and a record is allowed to lag but must not be
depended on.

TODO 88 §16.

## 9. A thing true by absence is not a control

**"There is no route for that" lasts until somebody writes one.** Version
immutability holds today only because nothing rewrites a version — there is no
PUT, PATCH or DELETE route on the game store — and the CSRF defence was a
browser default rather than a control of ours. Both are real, both could
disappear in one commit, and neither is written down anywhere the next person
would look.

*A breach looks like:* a security property argued from what does not exist —
no link to it, no button, no path today. If a property matters, something must
**check** it: a route list, a test, a constraint, an audit record.

TODO 87 — the CSRF entry states it, and the immutability note is the other
instance of the same mistake.

## 10. The docs move with the code

**Three documents, three jobs, and all three are the same change:**

| | |
|---|---|
| `docs/SPEC.md` | what is — every section carries BUILT / DECIDED / DEFERRED / OPEN |
| `website/TODO` | why — the decision, the alternatives rejected, the mistakes |
| `docs/manual/` | what users see; the only one written for them |

*A breach looks like:* a change whose commit does not touch the manual, or a
spec section still marked **NOT BUILT** months after it was built. Both happened
in the same week (TODO 89's follow-up). **Check the claim against the code
before writing it down** — a document asserting what nobody ran is how a manual
becomes a wish.

**When the three disagree, the code is right, the SPEC is corrected, and the
TODO gains a dated correction rather than a rewrite.** The TODO is a log; its
old entries stay wrong on purpose, with the correction beside them.

TODO 78, TODO 87.

---

## Not in the list, and why

| Rule | Enforced by |
|---|---|
| one copy of any content, ever | `UNIQUE(sha256)`, `check:store` |
| one definition of where the bytes live | `backend/lib/storagePaths.js` is the only builder |
| privileged accounts are made on the machine | `backend/lib/roles.js` refuses an admin from the website, whatever the inviter's rank; `scripts/accounts.js` is the route that can |
| never write a password down | the pre-deployment checklist; nothing mechanical, and it stays on the checklist rather than here |
| static assets in `frontend/public/` (TODO 75) | visible when broken — the asset 404s |
| new UI uses the theme tokens (TODO 74) | not enforced, and the theme itself is half-applied — a rule here would be premature |
| the game is not tracked in this repository | `git ls-files game/` is empty — visible the moment it stops being |
| pushing is done by the owner, from another machine | an instruction about how we work, not a rule a change can break |
