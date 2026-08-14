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
const superuserRoutes = require('./routes/superuser');
const inviteDevRoutes = require('./routes/inviteDevs');
const developerWorkspaceRoutes = require('./routes/developerWorkspace');

const {
  authenticateToken,
  requireSuperuser,
  requireAdmin
} = require('./middleware/auth');



// Import Shared DB Instance
const db = require('./db');


//const superuserRoutes = require('./routes/superuser');


const app = express();

// CONFIGURATION CONSTANTS (Loaded from environment)

const PORT = process.env.PORT ;
const HOST = process.env.HOST;
const CLIENT_URL = process.env.CLIENT_URL ;
const JWT_SECRET = process.env.JWT_SECRET ;

console.log("ENV CONFIG PORT ", PORT, "HOST ", HOST, "CLIENT URL ", CLIENT_URL); 


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

// 3. Admin & Superuser API routes
app.use('/api/admin', require('./routes/admin'));
app.use('/api/superuser', require('./routes/superuser'));
app.use('/api/inviteDevs', inviteDevRoutes);
app.use('/api/developer/workspace', developerWorkspaceRoutes);

// 4. Protected role view routes (/app/user, /app/developer, /app/admin, /app/superuser)
app.use('/app', require('./routes/views'));

// 5. Fallback: Any unknown public route goes back to the splash page
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});



// Prepared DB Queries
const queries = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserByGoogleId: db.prepare('SELECT * FROM users WHERE google_id = ?'),
  update2FASecret: db.prepare('UPDATE users SET two_factor_secret = ? WHERE id = ?'),
  enable2FA: db.prepare('UPDATE users SET is_2fa_enabled = 1 WHERE id = ?'),
  getInvitation: db.prepare('SELECT * FROM invitations WHERE token = ? AND is_used = 0'),
  markInviteUsed: db.prepare('UPDATE invitations SET is_used = 1 WHERE id = ?'),
  createUser: db.prepare(`
    INSERT INTO users (username, email, password_hash, role)
    VALUES (@username, @email, @password_hash, @role)
  `),
  createGoogleUser: db.prepare(`
    INSERT INTO users (username, email, google_id, role)
    VALUES (?, ?, ?, 'user')
  `)
};

// -------------------------------------------------------------
// 2. PASSPORT GOOGLE OAUTH CONFIGURATION
// -------------------------------------------------------------
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'MOCK_GOOGLE_CLIENT_ID',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'MOCK_GOOGLE_CLIENT_SECRET',
    callbackURL: `${HOST}:${PORT}/api/auth/google/callback` // Configured dynamically
    //callbackURL: 'http://localhost:5000/api/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      const googleId = profile.id;
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : `${googleId}@google.user`;
      const username = profile.displayName ? profile.displayName.replace(/\s+/g, '_').toLowerCase() : `google_${googleId}`;

      let user = queries.getUserByGoogleId.get(googleId) || queries.getUserByEmail.get(email);

      if (!user) {
        const result = queries.createGoogleUser.run(username, email, googleId);
        user = queries.getUserById.get(result.lastInsertRowid);
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

    const sessionToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.redirect(`${CLIENT_URL}/portal.html?token=${sessionToken}&user=${encodeURIComponent(user.username)}`);
   // res.redirect(`/portal.html?token=${sessionToken}&user=${encodeURIComponent(user.username)}`);
  })(req, res, next);
});

// -------------------------------------------------------------
// 5. INVITATION & REGISTRATION
// -------------------------------------------------------------

// Admin/Superuser creates an invite token for developers/admins
app.post('/api/auth/create-invite', authenticateToken, requireAdmin, (req, res) => {
  const { email, assigned_role } = req.body;
  const token = require('crypto').randomBytes(16).toString('hex');

  try {
    db.prepare(`
      INSERT INTO invitations (email, assigned_role, token)
      VALUES (?, ?, ?)
    `).run(email, assigned_role, token);

    res.json({ message: 'Invite created successfully', inviteToken: token });
  } catch (err) {
    res.status(400).json({ error: 'Invitation already exists for this email' });
  }
});

// Register via Invitation Token
app.post('/api/auth/register-invited', async (req, res) => {
  const { username, password, inviteToken } = req.body;

  const invite = queries.getInvitation.get(inviteToken);
  if (!invite) {
    return res.status(403).json({ error: 'Invalid or expired invitation token' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 12);
    
    queries.createUser.run({
      username,
      email: invite.email,
      password_hash,
      role: invite.assigned_role
    });

    queries.markInviteUsed.run(invite.id);

    res.json({ success: true, message: 'Account created successfully. You may now log in.' });
  } catch (err) {
    res.status(400).json({ error: 'Username or Email already registered' });
  }
});

// -------------------------------------------------------------
// 6. 2FA SETUP (FOR LOGGED IN HIGH-PRIVILEGE USERS)
// -------------------------------------------------------------
app.get('/api/auth/setup-2fa', authenticateToken, async (req, res) => {
  const user = queries.getUserById.get(req.user.userId);
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

  const sessionToken = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '2h' }
  );

 res.cookie('token', sessionToken, {
  httpOnly: true,
  secure: false,       // true in production over HTTPS
  sameSite: 'lax',
  maxAge: 2 * 60 * 60 * 1000
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
// 8. SUPERUSER ROUTES
// -------------------------------------------------------------
// This replaces your old single app.get('/api/superuser/dashboard') route!
app.use('/api/superuser', authenticateToken, superuserRoutes);



app.listen(PORT, () => {
    console.log(`🚀 Server running on ${HOST}:${PORT}`);
 
});
