const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'super_secret_game_engine_key_2026';

// --- IN-MEMORY SUPERUSER ACCOUNT ---
// In production, this lives in your database.
const superuserAccount = {
    id: 'usr_super_01',
    username: 'admin',
    email: 'admin@lowexpectations.com',
    password: 'SuperPassword123!', // Plaintext for demo, hash with bcrypt in production
    role: 'superuser',
    // Generated TOTP secret for 2FA app (e.g., Google Authenticator)
    twoFactorSecret: null, 
    is2FAEnabled: false
};

// -------------------------------------------------------------
// 1. GENERATE 2FA QR CODE (For initial Superuser Setup)
// -------------------------------------------------------------
app.get('/api/auth/setup-2fa', async (req, res) => {
    // Generate a new TOTP secret key
    const secret = speakeasy.generateSecret({
        name: `Low Expectations (Superuser: ${superuserAccount.username})`
    });

    superuserAccount.twoFactorSecret = secret.base32;

    // Generate QR Code Data URL to scan with Google Authenticator / 1Password
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
// 2. STEP 1: VERIFY PRIMARY CREDENTIALS
// -------------------------------------------------------------
app.post('/api/auth/login-step1', (req, res) => {
    const { username, password } = req.body;

    // Check credentials against Superuser account
    if (username !== superuserAccount.username || password !== superuserAccount.password) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Pass: Tell client 2FA is required for this role
    res.json({
        success: true,
        role: superuserAccount.role,
        requires2FA: true,
        message: 'Credentials valid. Proceed to Step 2FA.'
    });
});

// -------------------------------------------------------------
// 3. STEP 2: VERIFY 2FA TOTP CODE & ISSUE SUPERUSER JWT
// -------------------------------------------------------------
app.post('/api/auth/login-step2', (req, res) => {
    const { username, code } = req.body;

    if (username !== superuserAccount.username) {
        return res.status(400).json({ error: 'User mismatch' });
    }

    // If 2FA hasn't been configured yet via /setup-2fa, allow temporary bypass code '000000'
    let verified = false;

    if (superuserAccount.twoFactorSecret) {
        verified = speakeasy.totp.verify({
            secret: superuserAccount.twoFactorSecret,
            encoding: 'base32',
            token: code,
            window: 1 // Allows 30s clock drift
        });
    } else if (code === '000000') {
        verified = true; // Fallback demo code
    }

    if (!verified) {
        return res.status(401).json({ error: 'Invalid 2FA Authenticator code' });
    }

    // Mark 2FA as active once verified
    superuserAccount.is2FAEnabled = true;

    // Issue Superuser JWT Session Token
    const sessionToken = jwt.sign(
        {
            userId: superuserAccount.id,
            username: superuserAccount.username,
            role: superuserAccount.role
        },
        JWT_SECRET,
        { expiresIn: '2h' }
    );

    res.json({
        success: true,
        token: sessionToken,
        user: {
            username: superuserAccount.username,
            role: superuserAccount.role
        }
    });
});

// -------------------------------------------------------------
// 4. PROTECTED SUPERUSER ROUTE (Example Dashboard Access)
// -------------------------------------------------------------
app.get('/api/superuser/dashboard', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'superuser') {
            return res.status(403).json({ error: 'Access denied: Superuser role required' });
        }
        res.json({
            status: 'Authorized',
            welcome: `Welcome Commander ${decoded.username}!`,
            systemMetrics: { serverStatus: 'ONLINE', connectedPlayers: 142, memoryUsage: '42%' }
        });
    } catch (err) {
        res.status(401).json({ error: 'Invalid or expired session token' });
    }
});

app.listen(5000, () => {
    console.log('🚀 Auth Service running on http://localhost:5000');
});
