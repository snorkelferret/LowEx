// frontend/src/superuser.js
import { checkAuthGuard, executeGlobalLogout } from './authUtils.js';

// ==========================================
// 1. Strict Module-Level Configuration
// ==========================================
const apiUrl = import.meta.env.VITE_API_URL;

if (!apiUrl) {
  throw new Error('FATAL: VITE_API_URL is missing from environment variables.');
}

const API_URL = apiUrl;

// =============================================================================
// 2. MODULE INITIALIZERS (Purely Unique Superuser Functionality)
// =============================================================================

function setupIdentityModal() {
  const signInAsBtn = document.getElementById('signInAsBtn');
  const loginModal = document.getElementById('loginModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const modalLoginForm = document.getElementById('modalLoginForm');

  if (signInAsBtn && loginModal) {
    signInAsBtn.addEventListener('click', () => loginModal.classList.remove('hidden'));
  }

  if (closeModalBtn && loginModal) {
    closeModalBtn.addEventListener('click', () => loginModal.classList.add('hidden'));
  }

  if (modalLoginForm) {
    modalLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('modalUsername').value;
      const password = document.getElementById('modalPassword').value;

      try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
          credentials: 'include'
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Sign in failed');

        localStorage.setItem('user_info', JSON.stringify(data.user));

        if (data.user?.role === 'superuser') {
          window.location.reload();
        } else {
          window.location.href = '/shopfront.html';
        }
      } catch (err) {
        alert(`Sign in failed: ${err.message}`);
      }
    });
  }
}

function setupAdminStats() {
  const adminStatsContainer = document.getElementById('adminStatsContainer');
  if (!adminStatsContainer) return;

  (async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/stats`, {
        credentials: 'include'
      });
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
  })();
}

function setupDiagnostics() {
  const runDiagnosticsBtn = document.getElementById('runDiagnosticsBtn');
  if (!runDiagnosticsBtn) return;

  runDiagnosticsBtn.addEventListener('click', async () => {
    runDiagnosticsBtn.disabled = true;
    runDiagnosticsBtn.textContent = 'Running Diagnostics...';

    try {
      const res = await fetch(`${API_URL}/api/superuser/developer/diagnostics`, {
        method: 'POST',
        credentials: 'include'
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

function setupGitHubModule() {
  const githubKeysForm = document.getElementById('githubKeysForm');
  const triggerSyncBtn = document.getElementById('triggerSyncBtn');
  const triggerBuildBtn = document.getElementById('triggerBuildBtn');

  if (githubKeysForm) {
    githubKeysForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tokenInput = document.getElementById('ghToken').value;

      try {
        const res = await fetch(`${API_URL}/api/superuser/github/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tokenInput }),
          credentials: 'include'
        });
        if (!res.ok) throw new Error('Failed to update GitHub keys');
        alert('GitHub repository deployment keys updated successfully!');
      } catch (err) {
        alert(`GitHub Config Error: ${err.message}`);
      }
    });
  }

  if (triggerSyncBtn) {
    triggerSyncBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API_URL}/api/superuser/github/sync`, {
          method: 'POST',
          credentials: 'include'
        });
        if (!res.ok) throw new Error('Sync failed');
        alert('Remote repository synchronized.');
      } catch (err) {
        alert(`Sync Error: ${err.message}`);
      }
    });
  }

  if (triggerBuildBtn) {
    triggerBuildBtn.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API_URL}/api/superuser/github/deploy`, {
          method: 'POST',
          credentials: 'include'
        });
        if (!res.ok) throw new Error('Deploy failed');
        alert('Remote GitHub deployment triggered!');
      } catch (err) {
        alert(`Deploy Error: ${err.message}`);
      }
    });
  }
}

// =============================================================================
// 3. MASTER ENTRY POINT
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {
  const session = checkAuthGuard('superuser');
  if (!session) {
    alert('Unauthorized: Superuser access required.');
    window.location.href = '/index.html';
    return;
  }

 
  setupIdentityModal();
  setupAdminStats();
  setupDiagnostics();
  setupGitHubModule();
});
