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
