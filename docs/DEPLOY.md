# Deploying — the checklist

**Everything between "it works on this machine" and "it answers on
`lowexpectations.zone`."** Run it in order, before the portal is reachable from
outside. The last section is the record of the run; a checklist ticked from
memory is worse than no checklist.

**Each item says what to do, why, and what proof looks like.** Proof is output,
a file, or a change you can see — not "I think that is set". Where something is
not built and is being accepted anyway, say so **in the record**, with the
reason. That is what makes this document worth anything the second time.

---

## 0. Take the backup first

```bash
sqlite3 backend/database.db ".backup '/backups/deploy/database.db'"
cp -a backend/uploads/files /backups/deploy/files
```

**Why first.** The steps below change accounts, the session secret and possibly
the schema. A backup taken after them is a backup of a system you have already
altered.

**Proof:** `DB_PATH=/backups/deploy/database.db STORE_DIR=/backups/deploy/files
npm run check:store` passes.

---

## 1. The environment

| Do | Why |
|---|---|
| `git check-ignore .env` prints `.env` | It holds the session secret and mail credentials. If it is ever committed, the secret is in the history for ever. |
| Generate a **new** `JWT_SECRET`: `openssl rand -hex 32` | Every session token is signed with it. A development value that has been in a shell or a note is a value somebody may have. Rotating also signs everyone out — which is what you want before opening the doors. |
| `NODE_ENV=production` | The session cookie is only marked **Secure** when this is set (`routes/auth.js:68`, `server.js:439`). Without it the cookie will travel over plain HTTP. |
| `CLIENT_URL=https://lowexpectations.zone` | It is the CORS origin and the OAuth redirect (`server.js:51,68,231`). Wrong, and sign-in fails in a way that reads like a login bug. |
| `SMTP_*` set, or accept invitation links by hand | With no mail configured, invitations are created and the link comes back in the response for the inviter to pass on. That is a working behaviour, not a fault — but it must be the intended one. |

**Proof** — prints values that are safe, never the secret itself:

```bash
node -e "require('dotenv').config({quiet:true}); console.log({
  node_env: process.env.NODE_ENV,
  secure_cookie: process.env.NODE_ENV === 'production',
  secret_length: (process.env.JWT_SECRET || '').length,
  client_url: process.env.CLIENT_URL,
  smtp: !!process.env.SMTP_HOST
})"
```

---

## 2. Accounts — the known passwords

**This is the one that matters most.** Admin is the top of the ladder:
accounts, invitations, settings, audit, deactivation. `val` and `prod` between
them can upload, approve and put content into the game. All three currently use
development passwords that have been typed into this repository's tests and
notes.

```bash
node scripts/accounts.js --list          # who exists
node scripts/accounts.js --reset admin   # one at a time, typed at a terminal
node scripts/accounts.js --reset val
node scripts/accounts.js --reset prod
```

**Why typed, not scripted:** the script refuses a password on the command line
or in an environment variable, because both are readable by other processes on
the machine and land in shell history. It refuses to run without a terminal.

**Then deactivate every test account** on the admin page — Accounts →
Deactivate. A forgotten account holding a password somebody remembers is the
same problem with a longer fuse.

**Proof:** `--list` shows only accounts that should exist, and every remaining
account is one whose owner has just set their own password. **Nothing is
written down** — not in this file, not in a note, not in a commit.

> **Rotate after step 1.** Rotating `JWT_SECRET` signs everybody out; doing it
> in the other order means the passwords are changed and then the sessions are
> invalidated by a second step, which is harder to reason about mid-deployment.

---

## 3. Exposure

**The application currently listens on every interface.** `app.listen(PORT)` is
called with no host argument (`server.js:489`), so `ss -ltn` shows `*:5000`.
The `HOST` value in `.env` is printed at startup and **does not control
this** — it builds the OAuth callback and nothing else. That is TODO 44, decided
and not yet built.

So, one of:

- **Implement the loopback bind** (`127.0.0.1:5000`) — TODO 44 — or
- **Firewall port 5000** so that only the proxy can reach it.

Then:

| Do | Why |
|---|---|
| Run a reverse proxy on 443, with 80 redirecting to it, forwarding to the app | The app cannot serve HTTPS itself. TLS, rate limiting and "admin routes only from the studio" all belong at the proxy. |
| Do **not** run Vite (`npm run start:frontend`) | It is a development server. In production the backend serves `frontend/dist`. |
| Put Perforce on a subdomain only after reading TODO 88's `IMPORTANT` note | A service sharing the registrable domain changes what the session cookie means: CORS stops a reply being read, not the request being sent. |
| Check that the database and uploads are not served | Only `frontend/dist` and `frontend/public` are mounted as static. Confirm from outside — `curl -I https://<host>/backend/database.db` must not be 200. |

**Proof:** from another machine, only 443 answers; `curl http://<ip>:5000`
fails; `/backend/database.db` and `/backend/uploads/files/<sha>` return 404.

---

## 4. Decisions that must be taken, not skipped

These are not tasks to tick — they are **open, and the deployment proceeds with
or without a decision**. Each one must be either built or accepted in writing
in the record below. Item numbers are in `website/TODO`.

| Question | State today | Decide |
|---|---|---|
| **CSRF** | **Not built.** `SameSite=Lax` is the entire defence. | **A blocker** if anything HTML-serving shares the registrable domain — a Helix Swarm on a subdomain is enough. Otherwise acceptable while the portal is the only service on it, and dated. (TODO 87) |
| **Sessions** | Fixed lifetime from the `session_hours` setting (2 by default, 1–24). No idle timeout, no revocation. Deactivation **is** immediate — the role is re-read every request. | Accept a stolen session for up to its lifetime, or build the session table. (TODO 87, A1) |
| **Impersonation** | **Not built.** There is no admin read path into a workspace at all. | Accept that support means asking the developer, or build it. Previews (TODO 89) are the only sight of a submission. |
| **Multi-role** | **Not built.** An administrator cannot act as prod, so approvals need a real `prod` account. | Accept separate accounts, or build the role switch. (TODO 87) |
| **Perforce notification** | **Not built.** The portal is told nothing by Perforce yet; the trigger and its cursor do not exist. | Accept a portal that shows no changelists that nobody recorded, or build §15. (TODO 88) |
| **Releases, builds, distribution** | Nothing exists. | Out of scope until the game is being built. |
| **Alerts** | Email only, and only if SMTP is configured. The portal cannot report its own failure. | Accept, and watch the box some other way. (TODO 41) |

---

## 5. Backups and the job

| Do | Why |
|---|---|
| Schedule the daily job | Without it, nothing is ever collected and deleted work is never purged. (See the manual, *Starting the box*.) |
| Schedule the backup — **both halves** | The database and `backend/uploads/files` are one thing split in two. A database restored without its files is a store of references to content that is not there. |
| Verify a restore **now**, not on the day | Copy a backup elsewhere and run `check:store` against the copy. |
| Press the alerts **test button** on the admin page | Email is a configuration, and the day to find out it is not configured is not the day of an incident. |

```cron
17 4 * * *  cd /path/to/website && node backend/jobs/daily.js >> /var/log/lowex-daily.log 2>&1
```

---

## 6. Prove it

```bash
npm run build             # generated pages; the backend serves dist, not source
npm run check             # all nine checks
```

Three of them — `check:preview`, `check:approval` and `check:upload-pending` —
start the real routes against a throwaway database, so they need `JWT_SECRET`
set (it is, from step 1) and a free local port. None of them touches the live
data.

**Then in a browser, over HTTPS, as each role:**

1. sign in as `admin` — Accounts, Settings and the audit log load
2. sign in as `dev` — upload a folder, run the technical check, submit it
3. sign in as `prod` — the queue shows the submission, **with its preview**;
   approve it
4. as `dev`, the store shows the approved version and its *In the game* column
   says `—` until an admin records a changelist
5. **devtools → Application → Cookies:** the session cookie is `HttpOnly` and
   `Secure`, and the domain is the real one
6. the report form works signed out

---

## The run record

One row per deployment. A row with "accepted" and no reason is not a record.

| # | Section | Outcome | Date | By | Note / decision |
|---|---|---|---|---|---|
| 1 | 0. Backup taken | not run | — | — | |
| 2 | 1. Environment | not run | — | — | |
| 3 | 2. Passwords rotated | **outstanding** | — | — | all three accounts are on development passwords |
| 4 | 3. Exposure | **outstanding** | — | — | the app binds `*:5000` today (TODO 44) |
| 5 | 4. Decisions | **outstanding** | — | — | CSRF, sessions, impersonation, multi-role, Perforce |
| 6 | 5. Backups and job | not run | — | — | |
| 7 | 6. Prove it | not run | — | — | |
