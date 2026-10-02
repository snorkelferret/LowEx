# Testing

For testers — that is, anyone with a login and no extra privileges.

## A tester is not a role

There is no "tester" account type and no permission for it. A tester is simply
someone with a login and the plain `user` role.

That is deliberate. Everyone who has a login can be a tester: developers and
administrators too. Downloading a build, leaving a comment or reporting a
problem are things any signed-in person can do, not a special grant.

So being invited "as a tester" just means being invited as a plain user. You get
no workspace and no upload rights, and none of that is a restriction placed on
you — there is simply nothing else a login carries by default.

## What you can do today

- **Sign in**, and see your own landing page.
- **Report a problem**, from the button in the bottom-right of every page. This
  works whether or not you are signed in.
- **Follow the Discussion link** to the team's board — which, see below, is not
  configured yet.

That is genuinely all, and it is worth being blunt about rather than dressing it
up. There is no build to download yet.

## Reporting a problem

The button asks what kind of report it is — something broken, an idea, or
something else — and what happened. That is all you have to write.

Everything else is filled in for you, and **not by your browser**: who you are
comes from your session, and the time comes from the server's clock. That is
deliberate. A report you cannot trust about who sent it is not worth collecting.

If you are signed in, it is recorded against your account and you do not need to
say who you are. If you are not, it is recorded anonymously and you can leave an
email address if you want a reply — optional, because making someone hand over an
address to report a login fault is a good way to get no reports.

## What makes a useful report

The form asks one open question, so what you write is the whole of it. Three or
four sentences is usually enough, and there is a shape that makes a report
possible to act on.

**What you did.** The steps, in order, from something repeatable. *"I opened the
History tab and clicked Re-run check"* is worth far more than *"the check button
is broken"*, because somebody else can follow it and see the same thing.

**What you expected.** This is usually obvious to you and invisible to whoever
reads it, and it is often the whole of the information. *"The upload was
accepted"* means nothing on its own; *"I expected it to refuse a file that isn't
really a PNG"* says everything.

**What actually happened**, including anything on screen that looks like an
error. **Paste it rather than describing it.** A paraphrase loses the one word
that identifies the problem, and error text is written to be read by exactly the
person you are sending it to.

**Whether it happens every time**, if you know. A fault that happens once in ten
attempts is a different problem from one that happens always, and nothing else
in the report reveals the difference.

### Worth not doing

- **"It's broken."** True, and there is nothing to act on. It costs a round trip
  to ask what broke, and the answer usually arrives after whoever could have
  fixed it has moved on.
- **Describing the fix rather than the fault.** *"The button should be blue"*
  skips whatever made you want that. Describe what you were trying to do and
  what stopped you; the fix is somebody else's to choose.
- **Assuming the reader knows what you were doing.** They do not. They have the
  page address, which is filled in for you, and nothing else.

### What you do not need to write

**Who you are, and when it happened.** Both are recorded automatically, from
your session and from the server's clock — so there is no point stating either,
and no way to get them wrong.

**The page you were on** is recorded too. Note that it records the *page*, not
what was open on it: if a report is about a particular asset or version, **name
it**, because the address alone will not say which one you had in front of you.

### If it is an idea rather than a fault

Say what you are trying to achieve, not only what you want built. *"I cannot
tell which of these two assets is the approved one"* is more useful than *"add a
green tick"* — the first describes a problem somebody can solve properly, the
second asks for one particular solution to it.

## What you cannot do

- **See inside a developer's workspace.** It is private to them, and to nobody
  else — including administrators, except by impersonation, which is marked and
  audited rather than routine.
- **Upload or change assets.**
- **Approve anything.**

None of that is a technicality to work around. The workspace is private because
developers need to be able to make a mess while they work, and that only works
if nobody is watching over their shoulder.

## What does not exist yet

Listed so that nobody goes looking:

- Downloading a build of the game, or older versions of it
- Comments on assets, and reading other people's
- Following up on a bug you have reported
- The discussion board itself, which has been decided and designed but not
  installed
