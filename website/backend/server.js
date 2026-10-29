require('dotenv').config(); // Load variables from .env file

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const inviteDevRoutes = require('./routes/inviteDevs');
const developerWorkspaceRoutes = require('./routes/developerWorkspace');

const {
  authenticateToken,
  requireAdmin
} = require('./middleware/auth');



// Import Shared DB Instance
const db = require('./db');
const audit = require('./lib/audit');

// A SETTING, NOT A CONSTANT — `session_hours`, default 2, admin-editable.
// Read at the point of use in each login path rather than stored here, because
// a value copied at require time stops changing when the admin saves a new one.
const { getSetting } = require('./lib/settings');

// DATA REPAIRS RUN ONCE THE DATABASE IS OPEN, not inside db.js — see that
// file's note on why it may not require a sibling. This fills in the content
// identity of any version created before the column existed, and does nothing
// on every subsequent start.
require('./lib/backfillManifestHashes').backfillManifestHashes(db);

// Shared invitation rules, so registration and creation cannot disagree about
// what "still valid" means.
const { isAcceptable } = require('./lib/invites');


const app = express();

// CONFIGURATION CONSTANTS (Loaded from environment)

// EVERY ADDRESS AND PORT COMES FROM ONE PLACE. See shared/config.mjs for what
// each one means and why they are not derived from each other.
const { resolveConfig } = require('../shared/config.mjs');
const config = resolveConfig(process.env);

const PORT = config.port;

// WHERE THE SOCKET LISTENS — loopback by default, so nothing on the network
// can reach the application directly; the proxy is the only front door.
const BIND = config.bind;

// The OAuth callback is built from this, never from the bind address: Google
// cannot reach 127.0.0.1, and in production it must be the public origin.
const PUBLIC_URL = config.publicUrl;

const CLIENT_URL = config.clientUrl;
const JWT_SECRET = process.env.JWT_SECRET ;

// Fail fast. Without a secret every session would be signed with a value that
// lives in this repo, so a missing JWT_SECRET must stop the server rather than
// silently degrade into forgeable tokens.
if (!JWT_SECRET) {
  console.error(
    'FATAL: JWT_SECRET is missing from the environment. Refusing to start.'
  );
  process.exit(1);
}

console.log("ENV CONFIG PORT ", PORT, "BIND ", BIND, "PUBLIC ", PUBLIC_URL, "CLIENT URL ", CLIENT_URL);


// Enable CORS dynamically for client URL
app.use(cors({ origin: CLIENT_URL, credentials: true }));
//app.use(cors());
app.use(express.json());
app.use(passport.initialize());
app.use(cookieParser());

// 1. Serve static frontend assets built by build.js
app.use(express.static(path.join(__dirname, '../frontend/dist')));
app.use(express.static(path.join(__dirname, '../frontend/public')));

// 2. Authentication endpoints (/api/auth/login, etc.)
app.use('/api/auth', require('./routes/auth'));

// 3. Admin API routes
//
// /api/superuser WAS MOUNTED HERE until 2026-10-06, and is gone. Its seven
// endpoints were the website's superuser-only powers — GitHub and Cloudflare
// credentials entered through web forms, a deployment trigger, cache purge,
// devmode and diagnostics.
//
// THEY ARE NOT SIMPLY DELETED; each one needs a home, and the inventory is in
// TODO 50. Two of them were wrong wherever they lived (a long-lived API token
// typed into a browser and put into process.env), one is a release trigger that
// should not answer to a cookie, and the rest are operations that belong on the
// machine.
//
// What remains web-reachable is the ADMIN set, and requireAdmin accepts the
// role 'admin' and nothing else. There is no longer a role above it.
app.use('/api/admin', require('./routes/admin'));
app.use('/api/inviteDevs', inviteDevRoutes);
app.use('/api/developer/workspace', developerWorkspaceRoutes);

// THE LIBRARY — the third space. Source material, not game assets: reference
// photographs, textures in waiting, scans. Nothing here is approved into
// anything, because nothing in a library ships. See routes/library.js, which
// also names the two places that had to learn about the third table pointing at
// stored_files.
app.use('/api/library', require('./routes/library'));

// THE GAME STORE, READ. The consumption side — find what has been approved,
// download it, and import a version into a workspace to work on. The THIRD
// access class: a workspace is the owner's alone, the library is the studio's,
// and this is readable by any developer, which is what makes the store a studio
// resource rather than a personal one. See routes/game.js.
app.use('/api/game', require('./routes/game'));

// Bug reports and suggestions. Reachable from every page, signed in or not —
// the route applies its own optionalAuth rather than requiring a session,
// because someone who cannot sign in is the most likely person to want to
// report something. See routes/feedback.js for what it refuses to read.
app.use('/api/feedback', require('./routes/feedback'));

// 4. Protected role view routes (/app/user, /app/developer, /app/admin, /app/superuser)
app.use('/app', require('./routes/views'));



// Prepared DB Queries
const queries = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserByGoogleId: db.prepare('SELECT * FROM users WHERE google_id = ?'),
  update2FASecret: db.prepare('UPDATE users SET two_factor_secret = ? WHERE id = ?'),
  enable2FA: db.prepare('UPDATE users SET is_2fa_enabled = 1 WHERE id = ?'),
  // Fetched by token alone, so registration can say WHY it refused — revoked,
  // already used, or expired — instead of reporting all three as invalid.
  getInvitation: db.prepare('SELECT * FROM invitations WHERE token = ?'),
  markInviteUsed: db.prepare("UPDATE invitations SET status = 'used' WHERE id = ?"),
  // created_via is set EXPLICITLY by both of these. It has no default, so a
  // row inserted without it lands as NULL — which is how the admin's check
  // spots an account that nothing in this application created. A DEFAULT here
  // would make every insert look explained and the check useless.
  //
  // AND IT IS BOUND RATHER THAN FIXED, because the answer depends on where the
  // invitation was issued: a console-issued admin invitation produces an
  // account whose privilege was granted on the machine, and that is what the
  // origin has to say. Hardcoding 'invitation' would make the accounts check
  // flag every legitimately-granted administrator as "created through the
  // website" — the exact alarm it exists to raise, fired at the wrong people.
  createUser: db.prepare(`
    INSERT INTO users (username, email, password_hash, role, created_via)
    VALUES (@username, @email, @password_hash, @role, @created_via)
  `),
  createGoogleUser: db.prepare(`
    INSERT INTO users (username, email, google_id, role, created_via)
    VALUES (?, ?, ?, 'user', 'google')
  `)
};

// -------------------------------------------------------------
// 2. PASSPORT GOOGLE OAUTH CONFIGURATION
// -------------------------------------------------------------
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'MOCK_GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'MOCK_GOOGLE_CLIENT_SECRET',
    callbackURL: `${PUBLIC_URL}/api/auth/google/callback` // the PUBLIC origin, never the bind address
    //callbackURL: 'http://localhost:5000/api/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      const googleId = profile.id;
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : `${googleId}@google.user`;
      const username = profile.displayName ? profile.displayName.replace(/\s+/g, '_').toLowerCase() : `google_${googleId}`;

      let user = queries.getUserByGoogleId.get(googleId) || queries.getUserByEmail.get(email);

      if (!user) {
        // One transaction, like the invitation path: the account and the record
        // of where it came from are one fact, and this was the third and last
        // way an account could appear with nothing written down about it.
        //
        // The actor is null, for the same reason it is on a redeemed
        // invitation — nobody signed in acted; this is a person arriving
        // through Google for the first time and having an account created for
        // them.
        let created = null;

        db.transaction(() => {
          const result = queries.createGoogleUser.run(username, email, googleId);

          created = result.lastInsertRowid;

          audit.record(null, 'user.create', username, {
            email,
            role: 'user',
            via: 'google',
            google_id: googleId,
          });
        })();

        user = queries.getUserById.get(created);
      }

      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));



// -------------------------------------------------------------
// 4. OAUTH ROUTES
// -------------------------------------------------------------
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

app.get('/api/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user) => {
    if (err || !user) {
      return res.redirect('/portal.html?error=oauth_failed');
    }

    // THE LIFETIME IS A SETTING, read here rather than remembered at module
    // scope — lib/settings.js explains why that distinction matters.
    const hours = getSetting('session_hours');

    const sessionToken = jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: `${hours}h` }
    );
    res.redirect(`${CLIENT_URL}/portal.html?token=${sessionToken}&user=${encodeURIComponent(user.username)}`);
   // res.redirect(`/portal.html?token=${sessionToken}&user=${encodeURIComponent(user.username)}`);
  })(req, res, next);
});

// -------------------------------------------------------------
// 5. INVITATION & REGISTRATION
// -------------------------------------------------------------

// NOTE: invitations are created at POST /api/inviteDevs/generate-invite.
//
// There used to be a second endpoint here — /api/auth/create-invite — doing
// the same job differently: it took assigned_role straight from the body
// behind requireAdmin and returned the token, so any admin could mint and
// redeem a superuser invitation. Removed rather than patched, so there is one
// place that decides who may invite whom.

// Register via Invitation Token
app.post('/api/auth/register-invited', async (req, res) => {
  const { username, password, inviteToken } = req.body;

  const invite = queries.getInvitation.get(inviteToken);

  if (!invite) {
    return res.status(403).json({ error: 'Invalid invitation token' });
  }

  // Refuse with a reason rather than lumping every failure into "invalid or
  // expired" — a revoked invitation and an expired one need different
  // responses from whoever is trying to use it.
  const acceptable = isAcceptable(db, invite);

  if (!acceptable.ok) {
    const messages = {
      revoked: 'This invitation has been withdrawn. Please contact your administrator.',
      used: 'This invitation has already been accepted. Try logging in instead.',
      expired: 'This invitation has expired. You can request a new link.',
    };

    return res.status(403).json({
      error: messages[acceptable.reason] || 'This invitation cannot be used.',
      reason: acceptable.reason,
    });
  }

  try {
    const password_hash = await bcrypt.hash(password, 12);

    // ONE TRANSACTION, and it was two statements before. The account and the
    // invitation that authorised it have to appear together or not at all:
    // creating the account and then failing to mark the invitation leaves a
    // live account beside an invitation that still looks unredeemed — someone
    // could try to use it, and an administrator looking at the list would see
    // a pending invitation for a person who already has a login, with nothing
    // saying why. That is the exact state the invites panel was found in.
    //
    // The audit record goes in the same transaction, for the same reason it
    // does everywhere else here: the fact that this account exists and the
    // record of where it came from are one fact, not two.
    const redeem = db.transaction(() => {
      queries.createUser.run({
        username,
        email: invite.email,
        password_hash,
        role: invite.assigned_role,
        // 'console' when the invitation was issued on the studio machine, so
        // an administrator made that way reads as having been granted on the
        // machine rather than through the web. See the `source` column in
        // db.js and the check in routes/admin.js.
        created_via: invite.source === 'console' ? 'console' : 'invitation',
      });

      queries.markInviteUsed.run(invite.id);

      audit.record(null, 'user.create', username, {
        email: invite.email,
        role: invite.assigned_role,
        via: invite.source === 'console' ? 'console' : 'invitation',
        invitation_id: invite.id,
        // Who issued the invitation that was redeemed. The actor on this
        // record is null because nobody with a session did anything — the
        // person registering had no account yet. This is the link back to the
        // administrator who let them in.
        invited_by: invite.created_by ?? null,
      });
    });

    redeem();

    res.json({
      success: true,
      role: invite.assigned_role,
      message: 'Account created successfully. You may now log in.'
    });
  } catch (err) {
    console.error('Failed to redeem invitation:', err.message);
    res.status(400).json({ error: 'Username or Email already registered' });
  }
});

// -------------------------------------------------------------
// 6. 2FA SETUP (FOR LOGGED IN HIGH-PRIVILEGE USERS)
// -------------------------------------------------------------
app.get('/api/auth/setup-2fa', authenticateToken, async (req, res) => {
  const user = queries.getUserById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const secret = speakeasy.generateSecret({
    name: `Low Expectations (${user.username})`
  });

  queries.update2FASecret.run(secret.base32, user.id);

  try {
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({
      message: 'Scan this QR code with your 2FA app',
      qrCodeUrl: qrCodeUrl,
      manualKey: secret.base32
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// -------------------------------------------------------------
// 7. TWO-STEP LOGIN FLOW
// -------------------------------------------------------------

// STEP 1: Verify Password
app.post('/api/auth/login-step1', async (req, res) => {
  const { username, password } = req.body;

  const user = queries.getUserByUsername.get(username);
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: 'Account is disabled' });
  }

  const isPasswordValid = await bcrypt.compare(password, user.password_hash);
  if (!isPasswordValid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Check if role requires 2FA or if account has it enabled
  //const requires2FA = user.is_2fa_enabled === 1 || ['admin', 'superuser'].includes(user.role);
    const  requires2FA = true;
    
  res.json({
    success: true,
    role: user.role,
    requires2FA: requires2FA,
    message: requires2FA ? 'Credentials valid. Proceed to Step 2FA.' : 'Credentials valid. Logged in.'
  });
});

// STEP 2: Verify 2FA & Issue JWT
app.post('/api/auth/login-step2', (req, res) => {
  const { username, code } = req.body;

  const user = queries.getUserByUsername.get(username);
  if (!user) return res.status(400).json({ error: 'User mismatch' });

  let verified = false;

  if (user.two_factor_secret) {
    verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: 'base32',
      token: code,
      window: 1
    });
  } else if (code === '000000') {
    // Fallback demo code before initial 2FA setup
    verified = true;
  }

  if (!verified) {
    return res.status(401).json({ error: 'Invalid 2FA Authenticator code' });
  }

  if (user.is_2fa_enabled === 0) {
    queries.enable2FA.run(user.id);
  }

  // THE LIFETIME IS A SETTING. The token and the cookie MUST agree: a cookie
  // that outlives its token is a browser holding a credential the server will
  // refuse, and one that expires first signs the user out while the token is
  // still valid. Both come from one number, here.
  const hours = getSetting('session_hours');

  const sessionToken = jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: `${hours}h` }
  );

 // Cookie attributes must match res.clearCookie() in routes/auth.js or the
 // logout route cannot reliably remove this cookie.
 res.cookie('token', sessionToken, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: hours * 60 * 60 * 1000
});

res.json({
  success: true,
  user: {
    username: user.username,
    role: user.role
  }
});
});



// -------------------------------------------------------------
// 8. FALLBACKS — MUST REMAIN LAST
// -------------------------------------------------------------
//
// Express matches in registration order, so a catch-all registered earlier
// silently swallows every route declared below it. That is not theoretical:
// with these two handlers sitting up at section 4, login-step1, login-step2,
// the Google OAuth routes, create-invite, register-invited and setup-2fa were
// all unreachable — /api/* returned this 404 body and GET routes got handed
// index.html.
//
// Run `npm run check:routes` after touching this file; it fails if anything
// ends up registered below this block.
//
// Add new routes ABOVE this block, never below it.

// Unknown API routes must stay JSON. Without this they would fall through to
// the SPA fallback and return index.html with a 200, which is a miserable
// failure mode for anything calling the API.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Any other unknown public route goes back to the splash page.
//
// '/*splat' is the Express 5 wildcard syntax. A bare '*' is a hard error under
// Express 5 ("Missing parameter name at index 1") — it was valid under the
// Express 4 the root manifest used to claim.
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});


// LOOPBACK, EXPLICITLY. If this ever loses its address argument the app goes
// back to listening on every interface without saying so — and check:bind
// exists to catch exactly that.
app.listen(PORT, BIND, () => {
    console.log(`🚀 Server running on ${BIND}:${PORT} — public at ${PUBLIC_URL}`);
});
