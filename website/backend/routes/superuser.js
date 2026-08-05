const express = require('express');
const router = express.Router();
const { authenticateToken, requireSuperuser } = require('../middleware/auth');

// Protect ALL routes in this file strictly for Superusers
router.use(authenticateToken, requireSuperuser);

// Helper for Cloudflare API headers
function getCloudflareHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
}

// =============================================================================
// 1. DEVELOPER TOOLS & SANDBOX ENDPOINTS
// =============================================================================

/**
 * POST /api/superuser/developer/diagnostics
 * Runs system diagnostics and returns environment/DB connection states.
 */
router.post('/developer/diagnostics', async (req, res) => {
  try {
    const memoryUsage = process.memoryUsage();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
      },
      envConfigured: {
        hasCloudflareToken: Boolean(process.env.CLOUDFLARE_API_TOKEN),
        hasCloudflareZone: Boolean(process.env.CLOUDFLARE_ZONE_ID),
        hasGitHubToken: Boolean(process.env.GITHUB_TOKEN),
      },
    });
  } catch (err) {
    res.status(500).json({ error: `Diagnostics failed: ${err.message}` });
  }
});

// =============================================================================
// 2. GITHUB REPOSITORY MANAGEMENT ENDPOINTS
// =============================================================================

/**
 * POST /api/superuser/github/keys
 * Save or update GitHub deployment key/PAT (Updates environment at runtime)
 */
router.post('/github/keys', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'GitHub token is required.' });
  }

  // Store in process.env (or persist to vault / secure store as needed)
  process.env.GITHUB_TOKEN = token;

  res.json({
    success: true,
    message: 'GitHub access token updated for active session.',
  });
});

/**
 * POST /api/superuser/github/sync
 * Sync local state with remote repository
 */
router.post('/github/sync', async (req, res) => {
  const ghToken = process.env.GITHUB_TOKEN;
  const repoOwner = process.env.GITHUB_OWNER;
  const repoName = process.env.GITHUB_REPO;

  if (!ghToken || !repoOwner || !repoName) {
    return res.status(400).json({
      error: 'GitHub credentials (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO) not set in environment.',
    });
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'User-Agent': 'Superuser-Command-Center',
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.message || 'GitHub API error');
    }

    const repoData = await response.json();
    res.json({
      success: true,
      message: `Synchronized with ${repoData.full_name}`,
      defaultBranch: repoData.default_branch,
      pushedAt: repoData.pushed_at,
    });
  } catch (err) {
    res.status(500).json({ error: `GitHub Sync Failed: ${err.message}` });
  }
});

/**
 * POST /api/superuser/github/deploy
 * Trigger remote repository deployment via repository_dispatch event
 */
router.post('/github/deploy', async (req, res) => {
  const ghToken = process.env.GITHUB_TOKEN;
  const repoOwner = process.env.GITHUB_OWNER;
  const repoName = process.env.GITHUB_REPO;

  if (!ghToken || !repoOwner || !repoName) {
    return res.status(400).json({
      error: 'GitHub credentials not configured in server environment.',
    });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ghToken}`,
          'User-Agent': 'Superuser-Command-Center',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ event_type: 'superuser_deploy_trigger' }),
      }
    );

    if (response.status === 204) {
      return res.json({
        success: true,
        message: 'Deployment workflow dispatch triggered on GitHub successfully!',
      });
    }

    const errData = await response.json();
    throw new Error(errData.message || 'Failed to dispatch workflow event');
  } catch (err) {
    res.status(500).json({ error: `Deploy Trigger Failed: ${err.message}` });
  }
});

// =============================================================================
// 3. CLOUDFLARE EDGE & INFRASTRUCTURE ENDPOINTS
// =============================================================================

/**
 * POST /api/superuser/cloudflare/keys
 * Update Cloudflare API Token and Zone ID in session environment
 */
router.post('/cloudflare/keys', async (req, res) => {
  const { apiToken, zoneId } = req.body;
  if (!apiToken || !zoneId) {
    return res.status(400).json({ error: 'Both API Token and Zone ID are required.' });
  }

  process.env.CLOUDFLARE_API_TOKEN = apiToken;
  process.env.CLOUDFLARE_ZONE_ID = zoneId;

  res.json({
    success: true,
    message: 'Cloudflare infrastructure credentials updated successfully.',
  });
});

/**
 * POST /api/superuser/cloudflare/purge
 * Purge all edge cache across the global Cloudflare CDN
 */
router.post('/cloudflare/purge', async (req, res) => {
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!cfToken || !zoneId) {
    return res.status(400).json({
      error: 'Cloudflare credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID) not configured.',
    });
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: getCloudflareHeaders(cfToken),
        body: JSON.stringify({ purge_everything: true }),
      }
    );

    const data = await response.json();
    if (!data.success) {
      const msg = data.errors?.[0]?.message || 'Cloudflare purge failed';
      throw new Error(msg);
    }

    res.json({
      success: true,
      message: 'Global Cloudflare edge cache purged successfully.',
      result: data.result,
    });
  } catch (err) {
    res.status(500).json({ error: `Cloudflare Purge Failed: ${err.message}` });
  }
});

/**
 * POST /api/superuser/cloudflare/toggle-devmode
 * Toggle Cloudflare Development Mode (bypasses cache for 3 hours)
 */
router.post('/cloudflare/toggle-devmode', async (req, res) => {
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!cfToken || !zoneId) {
    return res.status(400).json({ error: 'Cloudflare credentials missing in environment.' });
  }

  try {
    // 1. Get current Dev Mode status
    const getRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/development_mode`,
      { headers: getCloudflareHeaders(cfToken) }
    );
    const getData = await getRes.json();
    if (!getData.success) throw new Error('Could not fetch current Dev Mode status.');

    const currentMode = getData.result.value === 'on';
    const nextMode = currentMode ? 'off' : 'on';

    // 2. Toggle status
    const patchRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/development_mode`,
      {
        method: 'PATCH',
        headers: getCloudflareHeaders(cfToken),
        body: JSON.stringify({ value: nextMode }),
      }
    );

    const patchData = await patchRes.json();
    if (!patchData.success) throw new Error('Failed to update Dev Mode setting.');

    res.json({
      success: true,
      devMode: nextMode === 'on',
      message: `Cloudflare Development Mode turned ${nextMode.toUpperCase()}`,
    });
  } catch (err) {
    res.status(500).json({ error: `Dev Mode Toggle Failed: ${err.message}` });
  }
});

module.exports = router;
