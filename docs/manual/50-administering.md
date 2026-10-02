# Administering

For administrators and superusers.

## The rule that matters most

**Superuser can do everything an administrator can do, plus more.**

The "plus more" is superuser-only — deploying the game, creating branches. The
"everything an administrator can do" half is the one that gets broken by
accident, because a failure there is silent: a page that allows administrators
and forgets superusers does not error, it just refuses the most privileged
account in the system.

If you are ever refused something you expect to be able to do, that is what to
suspect first.

## Accounts

**Accounts** lists everyone, with their role and whether they are active.

- **Deactivate** revokes access. It takes effect on the very next request — a
  signed-in person is not left working until their session expires.
- **Reactivate** restores access the same way.

Deactivating does **not** delete anything. Assets, versions, submissions and
reviews stay where they are, because that work belongs to the project rather
than to the account.

You cannot act on your own account, and you cannot act on anyone at or above
your own rank. The buttons on each row reflect what the server will actually
allow — they do not re-derive the rule, because a client-side copy of a
permission rule is a permission rule that can disagree with the server.

Every deactivation and reactivation is recorded: who did it, to whom, and when.

## Invitations

**Invites** creates an invitation for an email address at a chosen role.

- Links are valid for **28 days**.
- An invitee can reissue their own link **up to six times**; after that, an
  administrator has to issue a fresh invitation.
- You can withdraw an invitation before it is used.

If the portal has been configured to send mail, the link is emailed. If not, you
are given the link to pass on yourself — so invitations work either way, and a
misconfigured mail server is never the reason nobody can get in.

## What administrators cannot see

**There is no read path into a developer's workspace.** Not for administrators,
not for superusers. If one is needed, it is done by **impersonation**, which is
marked, time-bounded and audit-logged — and impersonation is not built yet.

The workspace is private because developers need to be able to make a mess while
they work, and that only works if nobody is watching over their shoulder.

This is worth stating plainly because an asset-management page looks harmless
and read-only, and it would be the easiest thing in the system to open up by
accident.

## Reports

The portal collects **bug reports and suggestions** from every page, from signed
in or not. The routes to read and resolve them exist and are tested, but **no
page calls them yet**, so reports currently go somewhere nobody looks.

This is the thing most worth building next. See the TODO for the rest.

## What is not built

- **Reading or resolving reports** — the API exists, the page does not
  (TODO 28)
- **Deleting from the game asset store** — no route, no page (TODO 31)
- **Impersonation** — decided, not built (TODO 5)
- **Deploying the game, creating branches** — superuser-only capabilities that
  do not exist yet
- **Storage and health figures**, and warnings when disk or memory runs low
  (TODO 28)
- **Who is logged in** — there is no record of a session anywhere, so this
  cannot be answered at all yet (TODO 10)

## The menu on these pages

The menu carries every section that is planned, and an entry that is not built
says so when clicked, naming the TODO item it belongs to. That is deliberate:
the shape is known and the work is recorded, and a menu entry that does nothing
when clicked is indistinguishable from a bug.
