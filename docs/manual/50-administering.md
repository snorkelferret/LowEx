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

## Admin and superuser accounts are made on this machine

**Nobody can create an administrator or a superuser through the website.** Not
even a superuser. The role is not offered in the invitations menu, and the
server refuses it if the request is sent anyway — hiding an option is not the
same as preventing it.

They are created on the machine the portal runs on, by somebody with access to
it:

```bash
node scripts/create-superuser.js                  # a superuser
node scripts/create-superuser.js --role admin     # an administrator
node scripts/create-superuser.js --list           # who is on the system
node scripts/create-superuser.js --reset <name>   # set a new password
```

**WHY, because it is not obvious and it is worth knowing before somebody asks
you to relax it.** It limits *persistence*, not impact. If a superuser's session
is stolen, whoever has it can still change settings, read the audit log and
deactivate people. What they cannot do is plant a lasting privileged account —
and an account that can change system-wide settings outlives the incident it was
created during. That is the difference between a mess you clean up and one you
keep finding again.

**The trade is deliberate:** adding an administrator needs access to the
machine. If that is inconvenient, the inconvenience is the control.

**Only developers and testers are invited from the website.** That is what the
invitation system is for.

### Passwords

A password created this way is **typed at the machine and never shown** — not on
screen, not in a log, not in the database except as a one-way hash. It cannot be
passed as a command-line argument or an environment variable, because both are
readable by other processes on the machine, and the script refuses to run
without a terminal rather than accept one.

If you forget it, use `--reset`. There is no "forgot my password" link, and no
way to change a password from the website at all.

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

### Where an account came from

The **Created** column says how each account came to exist — created at setup,
by invitation, through Google sign-in, or by hand. It is there so the question
"where did this login come from?" has an answer that does not require reading
the database.

**If an account has no recorded origin, a warning appears above the table
naming it.** Nothing inside the portal created it, which means the row was put
into the database directly, by something that bypassed the application. It is
not necessarily hostile — somebody may have run a command they did not write
down — but it is always worth finding out about.

The same warning appears if an administrator or superuser account was created
*through the website*, which is not supposed to be possible. That one is a
stronger signal: an account that bypassed a rule deliberately put in place.

Neither check can be complete — anyone who can write the database can write a
convincing origin alongside it — so treat them as a smoke alarm rather than a
lock. They catch the ordinary case, which is what actually happens.

## Invitations

**Invites** creates an invitation for an email address as a **developer or a
tester**. Administrator and superuser are not offered — see above.

- Links are valid for **28 days** by default. That is a setting, changeable in
  **Settings** (see below), and it applies to invitations sent from then on:
  ones already sent keep the date they were issued with. The current figure is
  shown at the top of the invitations table.
- An invitee can reissue their own link **up to six times**; after that, an
  administrator has to issue a fresh invitation.
- You can withdraw an invitation before it is used.

**You cannot invite an address that already has an account.** An invitation to
somebody who can already sign in is a dead link, and it would leave a row in
this table looking like a person is waiting to get in when nobody is. If the
address has an account, you are told which one — reset its password instead, or
reactivate it if it was deactivated.

**A row flagged "Account exists" is an invitation that should not be there.** It
can only be revoked, not reissued. Revoke it.

If the portal has been configured to send mail, the link is emailed. If not, you
are given the link to pass on yourself — so invitations work either way, and a
misconfigured mail server is never the reason nobody can get in.

## Settings

**Settings** holds the values that used to be fixed in the code. A change takes
effect **immediately** — no restart, no deploy — and each one is recorded in the
audit log with who changed it and what it was before.

| Setting | What it does |
|---|---|
| **Invitation validity** | How long a newly issued invitation lasts |
| **Wastebin retention** | How long a deleted asset can be restored |
| **Developer storage allowance** | How much each developer's workspace may hold |
| **Warning level** | When a disk, file table or quota is called "filling up" |
| **Critical level** | When it is called "nearly full" |

Two things about these are worth knowing in advance:

- **Changing the invitation window does not affect invitations already sent.**
  Each one keeps the date it was issued with.
- **Changing the wastebin retention does affect items already in a bin.** The
  deadline is worked out from when the item was deleted, so shortening the
  window can bring something to its purge date immediately. The panel says so
  beside that field.

The critical level must stay above the warning level, and equal is refused as
well as inverted — a warning level equal to the critical level means nothing is
ever warned about in time.

### Urgent alerts

Below the settings is a **test button** for the alerts that go out when
something urgent happens.

Alerts are sent to **every active administrator and superuser, on one message,
so you can all see who else received it.** That is deliberate: several people
receiving the same alarm need to be able to talk to each other about it, and
they cannot do that without knowing who else has it.

The panel tells you **who would be told and whether anything can be sent**
before you press the button, so "email is not set up" is something you read
while calmly configuring things rather than something you discover during the
incident the alerts were meant to report.

**Email is the only channel so far.** Text messages are under discussion and
need a third-party service.

**One limit worth knowing:** the portal cannot report its own failure. If the
server is down, so is the thing that would tell you. Noticing that needs
something outside the portal watching it, which is not built.

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
in or not. **Reports** lists them with their kind, who sent them and when, what
they wrote, and the page they were on.

Anonymous reports are shown as information — "sent without signing in" — rather
than as missing data, because someone who cannot sign in is the most likely
person to want to report something.

Resolving one takes an optional note, and the panel tells you when a report was
skipped rather than resolved.

## What is not built

- **Health figures** — memory and CPU, and a warning banner that appears without
  you going to look for it. The disk figures and their warning levels exist, but
  they live behind a tab. (TODO 28)
- **Text message alerts** — email only, and email needs configuring before it
  sends anything. (TODO 41)
- **Noticing that the server itself is down** — needs something outside the
  portal watching it. (TODO 41)
- **Who is logged in** — there is no record of a session anywhere, so this
  cannot be answered at all yet. (TODO 10)
- **Deleting from the game asset store** — no route, no page. (TODO 31)
- **Impersonation** — decided, not built. (TODO 5)
- **Deploying the game, creating branches** — superuser-only capabilities that
  do not exist yet.
- **Storage by game version** — shown as an empty section on the Storage tab,
  because nothing records which content belongs to which version yet. Provision
  only, on purpose. (TODO 38)

## The menu on these pages

The menu carries every section that is planned, and an entry that is not built
says so when clicked, naming the TODO item it belongs to. That is deliberate:
the shape is known and the work is recorded, and a menu entry that does nothing
when clicked is indistinguishable from a bug.
