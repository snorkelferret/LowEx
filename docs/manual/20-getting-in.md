# Getting in

For everyone. What follows is the same for every role; what you can *do* once
inside differs, and that is covered in the sections after this one.

## You are invited, you do not sign up

There is no public sign-up. Someone with administrator rights invites you by
email address, and you receive a link:

```
/register?token=...
```

Opening it asks you to choose a username and password. Your **role is fixed by
the invitation** — you cannot choose it, and if it is wrong, the person who
invited you has to issue a new one.

**Only developers and testers arrive this way.** Administrator accounts are not
invited by anyone: they are created on the machine the portal runs on. If you are expecting one of those, it does not come as a link.

## The invitation link

- **Valid for 28 days.**
- If it expires, the same page offers to generate a new one — **up to six
  times**, after which an administrator must issue a fresh invitation.
- If it was withdrawn, or has already been used, the page says so plainly rather
  than showing you a form that cannot work.

The link is emailed to you if the portal has been configured to send mail. If it
has not, whoever invited you is given the link to pass on themselves — so a link
reaches you either way.

## Signing in

Username and password, then a **code from an authenticator app**. Two-factor is
required; there is no way to skip it.

If you cannot get in at all — the link is dead, the code will not work, the
password is wrong — use the **Report a problem** button in the bottom-right
corner of every page. That button works *without* being signed in, deliberately:
someone locked out is the most likely person to need it.

## Signing out

Signing out clears your session in **that browser only**. It is worth knowing
that a session is a token with an expiry rather than a record the server keeps,
so signing out on one machine does not sign you out on another. Sessions are not
individually revocable yet.

### Being signed out without asking

**A session lasts 8 hours.** After that the portal will bring you back to the
sign-in page and tell you it expired — which is expected, not a fault, and you
simply sign in again.

Nothing is lost when it happens: work in progress stays where it is, and the
8 hours restarts from each sign-in.

If you see *"Your session expired"* and did not expect it, it means more than
8 hours passed since you last signed in — leaving a tab open overnight is the
usual way.

## If your access is taken away

An administrator can deactivate your account. That takes effect **immediately** —
if you are signed in when it happens, your very next action is refused, rather
than you being left working until your session happens to expire.

**Nothing you have made is deleted.** Your assets, versions, submissions and
reviews stay exactly where they are, because that work belongs to the project
rather than to your account. An administrator can reactivate you and access
comes back the same way.

Every deactivation and reactivation is recorded — who did it, to whom, and when —
so it cannot happen quietly.

If you think it was a mistake, contact whoever invited you. There is no
self-service route back in.

## The discussion board

The team talks on a board **separate from this portal**. It is not built into
the portal and will not be — a decision rather than an oversight: the board is
being chosen to be open source and hosted in the UK or the EU, so the
conversation is not subject to US jurisdiction.

What that means for you:

- **Your board account is separate.** Signing in here does not sign you in
  there, and your role here does not carry over.
- Signing out here does not sign you out of the board.
- Revoking your portal access will revoke your board access too. That is being
  built deliberately, because it is the thing a third-party board normally
  cannot do.

**Not built yet.** The board has not been chosen or configured. The Discussion
page says so rather than offering a link that goes nowhere.
