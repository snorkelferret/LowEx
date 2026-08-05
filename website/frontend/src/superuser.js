/**
 * Superuser Command Center - Modular Event Handler
 * Strictly handles API triggers and identity switching for superuser powers.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ---------------------------------------------------------------------------
  // 1. Session & Superuser Guard
  // ---------------------------------------------------------------------------
  const token = sessionStorage.getItem('jwt_token');
  const user = JSON.parse(sessionStorage.getItem('user_info') || '{}');

  // Client-side route guard
  if (!token || !user.is_superuser) {
    alert('Unauthorized: Superuser access required.');
    window.location.href = '/index.html';
    return;
  }

  // Common request header generator
  const getAuthHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionStorage.getItem('jwt_token')}`
  });

  // Render current user status badge in header
  const currentUserLabel = document.getElementById('currentUserLabel');
  if (currentUserLabel && user.username) {
    currentUserLabel.innerHTML = `Logged in as: <strong>${user.username}</strong> <span class="badge badge-success">(Superuser)</span>`;
  }

  // ---------------------------------------------------------------------------
  // 2. Header Actions & Login / "Sign in as..." Modal
  // ---------------------------------------------------------------------------
  const logoutBtn = document.getElementById('logoutBtn');
  const signInAsBtn = document.getElementById('signInAsBtn');
  const loginModal = document.getElementById('loginModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const modalLoginForm = document.getElementById('modalLoginForm');

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      sessionStorage.clear();
      window.location.href = '/index.html';
    });
  }

  if (signInAsBtn && loginModal) {
    signInAsBtn.addEventListener('click', () => {
      loginModal.classList.remove('hidden');
    });
  }

  if (closeModalBtn && loginModal) {
    closeModalBtn.addEventListener('click', () => {
      loginModal.classList.add('hidden');
    });
  }

  if (modalLoginForm) {
    modalLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('modalUsername').value;
      const password = document.getElementById('modalPassword').value;

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign in failed');

        // Swap active session context
        sessionStorage.setItem('jwt_token', data.token);
        sessionStorage.setItem('user_info', JSON.stringify(data.user));

        // Redirect based on swapped privilege level
        if (data.user.is_superuser) {
          window.location.reload();
        } else {
          window.location.href = '/shopfront.html';
        }
      } catch (err) {
        alert(`Sign in failed: ${err.message}`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Admin Panel Operations
  // ---------------------------------------------------------------------------
  const adminStatsContainer = document.getElementById('adminStatsContainer');
  
  async function loadAdminStats() {
    if (!adminStatsContainer) return;
    try {
      const res = await fetch('/api/admin/stats', { headers: getAuthHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch admin stats');
      
      adminStatsContainer.innerHTML = `
        <div class="stats-grid">
          <div><strong>Active Users:</strong> ${data.activeUsers ?? 'N/A'}</div>
          <div><strong>Total Orders:</strong> ${data.totalOrders ?? 'N/A'}</div>
          <div><strong>Server Status:</strong> ${data.serverStatus ?? 'Online'}</div>
        </div>
      `;
    } catch (err) {
      adminStatsContainer.innerHTML = `<span class="error">Error loading stats: ${err.message}</span>`;
    }
  }

  loadAdminStats();

  // ---------------------------------------------------------------------------
  // 4. Developer Tools & Sandbox Module
  // ---------------------------------------------------------------------------
  const runDiagnosticsBtn = document.getElementById('runDiagnosticsBtn');
  if (runDiagnosticsBtn) {
    runDiagnosticsBtn.addEventListener('click', async () => {
      runDiagnosticsBtn.disabled = true;
      runDiagnosticsBtn.textContent = 'Running Diagnostics...';

      try {
        const res = await fetch('/api/superuser/developer/diagnostics', {
          method: 'POST',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Diagnostics failed');

        alert(`Diagnostics Complete:\n${JSON.stringify(data, null, 2)}`);
      } catch (err) {
        alert(`Developer Engine Error: ${err.message}`);
      } finally {
        runDiagnosticsBtn.disabled = false;
        runDiagnosticsBtn.textContent = 'Run System Diagnostics';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 5. GitHub Repository Management Module
  // ---------------------------------------------------------------------------
  const githubKeysForm = document.getElementById('githubKeysForm');
  const triggerSyncBtn = document.getElementById('triggerSyncBtn');
  const triggerBuildBtn = document.getElementById('triggerBuildBtn');
  const repoStatus = document.getElementById('repoStatus');

  if (githubKeysForm) {
    githubKeysForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tokenInput = document.getElementById('ghToken').value;

      try {
        const res = await fetch('/api/superuser/github/keys', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ token: tokenInput })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update GitHub keys');

        if (repoStatus) repoStatus.textContent = 'Connected';
        alert('GitHub repository deployment keys updated successfully!');
      } catch (err) {
        alert(`GitHub Config Error: ${err.message}`);
      }
    });
  }

  if (triggerSyncBtn) {
    triggerSyncBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/superuser/github/sync', {
          method: 'POST',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sync failed');
        alert(data.message || 'Remote repository synchronized.');
      } catch (err) {
        alert(`Sync Error: ${err.message}`);
      }
    });
  }

  if (triggerBuildBtn) {
    triggerBuildBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/superuser/github/deploy', {
          method: 'POST',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Deploy failed');
        alert(data.message || 'Remote GitHub deployment triggered!');
      } catch (err) {
        alert(`Deploy Error: ${err.message}`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Cloudflare Infrastructure Module
  // ---------------------------------------------------------------------------
  const cfKeysForm = document.getElementById('cfKeysForm');
  const purgeCacheBtn = document.getElementById('purgeCacheBtn');
  const toggleDevModeBtn = document.getElementById('toggleDevModeBtn');

  if (cfKeysForm) {
    cfKeysForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const apiToken = document.getElementById('cfApiToken').value;
      const zoneId = document.getElementById('cfZoneId').value;

      try {
        const res = await fetch('/api/superuser/cloudflare/keys', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ apiToken, zoneId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update Cloudflare credentials');

        alert('Cloudflare credentials saved securely!');
      } catch (err) {
        alert(`Cloudflare Config Error: ${err.message}`);
      }
    });
  }

  if (purgeCacheBtn) {
    purgeCacheBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to purge all global Cloudflare edge caches?')) return;

      try {
        const res = await fetch('/api/superuser/cloudflare/purge', {
          method: 'POST',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Purge failed');

        alert('Cloudflare cache purge completed successfully!');
      } catch (err) {
        alert(`Cache Purge Error: ${err.message}`);
      }
    });
  }

  if (toggleDevModeBtn) {
    toggleDevModeBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/superuser/cloudflare/toggle-devmode', {
          method: 'POST',
          headers: getAuthHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Toggle failed');

        alert(`Cloudflare Development Mode is now: ${data.devMode ? 'ENABLED' : 'DISABLED'}`);
      } catch (err) {
        alert(`Dev Mode Toggle Error: ${err.message}`);
      }
    });
  }
});
