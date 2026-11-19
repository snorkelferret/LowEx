# Production

For production: deciding what is good enough for the game.

## What this job is

Developers submit work; **you decide** whether it goes into the game's asset
store. A rejection is not a punishment — it is how work gets better — so it
carries a reason.

It is a **craft role, not a seniority**. You are not an administrator, you do
not have a workspace, and you cannot invite, deactivate or change anybody. What
you have is the judgement, and this page is about the information you are given
to exercise it with.

## The queue

**Awaiting your decision** lists every version a developer has submitted and
nobody has decided yet. For each one you see:

- **the asset and which version of it this is** — `bigTree v3` — and its
  category, if the developer chose one;
- **who submitted it**, their note on what changed, and anything they wrote when
  they submitted it;
- **where it is going** — the library, or a named game version — and **what was
  tested where**: the stream, the game changelist and the level, from the
  in-editor tool's receipt. A game destination with **no receipt** is called out
  in the row;
- **when** it arrived.

**You may change the destination.** Pick the library or a game version and
press **Set**. The server refuses a game version that has no passing test in it
— the evidence does not exist for that version, and no decision changes that.
Moving it back to its tested version, or to the library, always works.

The list is the whole job. There is no separate "review" screen to open.

## Seeing the work

**Images and videos show a thumbnail** under the asset name, taken from the
submitted files. Click one to open it at full size in a new tab.

That covers the formats the portal can decode, which includes the usual ones —
JPEG, PNG, WebP, TIFF — and the texture and render formats artists actually
send, TGA and EXR. A format this machine cannot read gets no thumbnail, and
shows nothing rather than a broken picture.

That is deliberate, and it is new. Production normally does not have Blender,
Nuke or Unreal installed, so a download would be useless even where one is
allowed. A reviewer who cannot see the work is not reviewing it.

**The thumbnail is of the submitted file, not a copy you can take away.** It is
made from the content that was submitted for this decision, and nothing else in
a developer's private workspace can be reached through it.

### What has no picture

**A model, a scene file or a level has no preview.** A `.blend`, a `.uasset`, an
`.nk` or an `.obj` yields no thumbnail — making a picture of a model needs a
renderer, and none is connected to the portal yet.

Those versions are still judged from what was submitted, by whom, and what they
said about it. **The panel says so on the page**, so that a missing picture
reads as a limitation rather than a fault.

## Approving and rejecting

**Approve** copies the version into the game's asset store. It does not put it
in the game: getting it into Unreal is an administrator's work, and the portal
records the changelist they used afterwards. The destination on the row says
which game version it was submitted for; that is the build the integrator is
expected to put it into.

**Reject** hands the work back with your reason. The developer can change it
again immediately.

Either way an audit record is written — who decided, what, and when — so the
decision can be looked up later rather than remembered.

## Builds

**Game builds** is below the queue. It shows the named builds the studio has
made, and what is in each one — the same page developers and administrators
use, read-only for you.

**The words.** A **stream** is a branch of the game. A **build** is a package
made from one stream at one changelist. A **release** is a build that shipped.
An asset has versions; the game has builds.

- **Click a build** to open it; click it again, or press **Hide**, to close it.
- **Files** opens a version's manifest as a tree, with each file's hash and size.
- **Compare builds** shows what changed between two builds.

It answers the question the queue cannot: **where did the work you approved end
up?** Approving puts a version in the store; an administrator puts it into a
build, and this is where that shows.

**You cannot add work to a build.** That is the administrator's job — putting
content into the game is engineering, not craft.

## The store and the library

Below the queue are the **Game store** and **Source material** — the same
panels developers use, read-only for you.

- **The store** is everything approved for the game, including work by other
  developers. It is what a submission is being compared against, and it is where
  approved work lives before it is in a build.
- **The library** is shared source material — reference photographs, textures,
  scans. Nothing there is approved into anything; an image reaches the game only
  as part of an asset somebody builds.

**You can browse and download. You cannot import, upload, edit or remove.** An
import writes into a personal workspace, and production has none; the rest is
authoring. The page does not offer what the server would refuse.

## What you cannot do

- **You cannot open the files themselves**, only the pictures of them. There is
  no read path into a developer's workspace for anybody.
- **You cannot change a submitted version.** The version is locked while it is
  waiting, so what you looked at is what gets approved.
- **You cannot manage categories or the discussion board yet.** That is intended
  for this role and is not built. (TODO 87)
- **You cannot change what you can see.** You may read the store and the
  library; importing, uploading and editing are not yours.

## If something is missing

If a preview does not appear for a file you expect to see one for, it is worth a
report rather than a guess — the report form is on every page and tells us which
page you were on.
