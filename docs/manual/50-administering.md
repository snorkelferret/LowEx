# Administering

For administrators.

## The four roles

| Role | What it is |
|---|---|
| **user** | A tester. No extra privileges; the tester features are available to anyone signed in. |
| **developer** | Works in their own private workspace. Uploads, versions, submits for review. |
| **prod** | Production — a craft role, not a seniority. **Decides creative approvals and comments.** Managing categories and discussion boards is intended for this role and **is not built yet**. **No workspace, no admin powers, cannot deactivate or invite anybody.** |
| **admin** | Administers the system. Accounts, invitations, reports, settings, audit log, deactivation. **The top of the ladder — there is nothing above it.** |

**The ladder is `user < developer < admin`.** `prod` sits between developer and
admin for ordering, and that rank confers *nothing*: it is not above anybody and
has authority over nobody. See "Admin accounts are made on this machine" below.

**If you are refused something you expect to be able to do**, suspect a role
list that does not name your role. That failure is silent by nature — the route
does not error, it simply refuses.

## Admin accounts are made on this machine

**Nobody can create an administrator through the website.** The role is not
offered in the invitations menu, and the server refuses it if the request is
sent anyway — hiding an option is not the same as preventing it.

**There is no superuser.** The role was removed on 2026-10-06: it had no
accounts, no routes and no page, and the one thing it provided — that nobody can
act on a peer, so the last administrator cannot be locked out by a rival —
already holds at the administrator level. **Administrator is the top of the
ladder.** A rogue administrator is therefore dealt with on the machine rather
than from the website, which is consistent with every other privileged act
here.

They are created on the machine the portal runs on, by somebody with access to
it.

### The usual way: invite them

```bash
node scripts/accounts.js --invite --email them@example.com
node scripts/accounts.js --invite --role prod --email them@example.com
```

This issues an invitation that carries the privileged role. It arrives exactly
like any other invitation, and **the person chooses their own username and
password** when they open the link. Nobody has to pick a password on somebody
else's behalf and then find a way to pass it on — which is the whole reason this
is the preferred route.

The invitation is marked **"issued on the studio machine"** in the invitations
list, so nobody has to wonder who created a privileged row.

### Someone who already has a login

```bash
node scripts/accounts.js --promote <username> --role admin
```

An invitation cannot do this. Redeeming one *creates* an account, and both
invitations and accounts are unique per email address — so a developer you want
to promote cannot be invited again. This changes the role and **leaves their
password alone**. It takes effect on their next request.

### The first account, and emergencies

```bash
node scripts/accounts.js                  # create an administrator
node scripts/accounts.js --role prod      # create a production reviewer
node scripts/accounts.js --reset <name>   # set a new password
node scripts/accounts.js --list           # who is on the system
```

Creating an account directly means typing a password at the machine for somebody
else. That is why it is not the usual way — it exists for the first account on a
new installation, where there is nobody to send an invitation, and for the day
the mail path is broken and somebody needs in now.

`--reset` is also the only way to change an existing password.

**WHY, because it is not obvious and it is worth knowing before somebody asks
you to relax it.** It limits *persistence*, not impact. If an administrator's session
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

**A password is never shown, anywhere** — not on screen, not in a log, not in an
audit record, not in the database except as a one-way hash.

Where the script asks you to type one, it is not echoed as you type and it
cannot be passed as a command-line argument or an environment variable: both are
readable by other processes on the machine, so the script refuses to run without
a terminal rather than accept one.

**Where possible, nobody types a password but its owner.** That is what
`--invite` is for — the person sets their own, through the same page every other
account is created with.

There is no "forgot my password" link and no way to change a password from the
website at all. `--reset` at the machine is the only route.

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

The same warning appears if an administrator account was created
*through the website*, which is not supposed to be possible. That one is a
stronger signal: an account that bypassed a rule deliberately put in place.

Neither check can be complete — anyone who can write the database can write a
convincing origin alongside it — so treat them as a smoke alarm rather than a
lock. They catch the ordinary case, which is what actually happens.

## Invitations

**Invites** creates an invitation for an email address as a **developer or a
tester**. Administrator is not offered — see above.

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
| **Session lifetime** | How long a sign-in lasts before it is refused — **2 hours by default**, between 1 and 24 |

Three things about these are worth knowing in advance:

- **Changing the invitation window does not affect invitations already sent.**
  Each one keeps the date it was issued with.
- **Changing the session lifetime applies from the next sign-in.** The deadline
  is inside the session token, so anyone signed in now keeps the expiry they
  were issued with.
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

Alerts are sent to **every active administrator, on one message,
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
not for anyone. If one is needed, it is done by **impersonation**, which is
marked, time-bounded and audit-logged — and impersonation is not built yet.

**Production does see a thumbnail of each submitted image and video**, in the
approval queue. That is not an exception: a preview is a picture the portal made
from the content, not the content, and it is reachable only through the approval
it belongs to. The files themselves stay as private as they were.

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

**The steward can work through these with you** — see *Starting the box*. It
reads them, checks whether each still happens, and proposes the resolution note.
It cannot resolve one; that is your click, and the note is the record.

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
- **Deploying the game, creating branches** — privileged capabilities that do
  not exist yet, and that will not live on the website when they do (TODO 50).
- **Storage by game version** — shown as an empty section on the Storage tab,
  because nothing records which content belongs to which version yet. Provision
  only, on purpose. (TODO 38)

## The menu on these pages

The menu carries every section that is planned, and an entry that is not built
says so when clicked, naming the TODO item it belongs to. That is deliberate:
the shape is known and the work is recorded, and a menu entry that does nothing
when clicked is indistinguishable from a bug.
