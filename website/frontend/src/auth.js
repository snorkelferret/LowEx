// frontend/auth.js

const API_URL = '/api/auth';

let activeUsername = '';

const errorEl = document.getElementById('login-error');

function showError(message) {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove('d-none');
  }
}

function clearError() {
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('d-none');
  }
}

// Global UI switcher for back-arrow button
window.showStep = function (stepNumber) {
  clearError();
  document.getElementById('login-step-1')?.classList.toggle('d-none', stepNumber !== 1);
  document.getElementById('login-step-2')?.classList.toggle('d-none', stepNumber !== 2);
};

// Global Handler for OAuth buttons
window.handleOAuth = function (provider) {
  alert(`Redirecting to ${provider} authentication...`);
};

// Handle Step 1: Username + Password Submission
document.getElementById('step1Form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;

  console.log("app frontend fetch from ", `${API_URL}`);
    
  try {
      const res = await fetch(`${API_URL}/login-step1`, {
	  method: 'POST',
	  headers: { 'Content-Type': 'application/json' },
	  body: JSON.stringify({ username: user, password: pass }),
	  credentials: 'include'
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Login failed. Check your credentials.');
      return;
    }

    activeUsername = user;

    if (data.requires2FA) {
      window.showStep(2);
    } else {
      // ✅ CLEANED: Removed data.token parameter
      saveSessionAndFinish(data.user);
    }
  } catch (err) {
    showError('Could not connect to backend server. Ensure node server.js is running.');
  }
});

// Handle Step 2: 2FA Verification Submission
document.getElementById('step2Form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

    const code = document.getElementById('2fa-code').value.trim();

  try {
      const res = await fetch(`${API_URL}/login-step2`, {
	  method: 'POST',
	  headers: { 'Content-Type': 'application/json' },
	  body: JSON.stringify({ username: activeUsername, code: code }),
	  credentials: 'include'
      });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || '2FA Verification Failed');
      return;
    }

    // ✅ CLEANED: Removed data.token parameter
    saveSessionAndFinish(data.user);
  } catch (err) {
    showError('Verification request failed.');
  }
});

// ✅ CLEANED: Removed token argument. Cookies handle auth automatically now!
function saveSessionAndFinish(user) {
  localStorage.setItem('user_info', JSON.stringify(user));

  // 1. Hide Bootstrap Dropdown Modal if open
  const dropdownEl = document.getElementById('loginDropdown');
  const DEFAULT_START_PAGE = import.meta.env.VITE_DEFAULT_START_PAGE || '/index.html';

  if (window.bootstrap && dropdownEl) {
    const bsDropdown = window.bootstrap.Dropdown.getInstance(dropdownEl);
    if (bsDropdown) bsDropdown.hide();
  }

  // 2. Update Top-Right Header Navbar State
  if (typeof updateNavbarState === 'function') {
    updateNavbarState();
  }
    
  console.log("auth.js got role ", user?.role);
  
  // 3. Immediate Dashboard Load OR Page Refresh
  //
  // THE LADDER IS user < developer < prod < admin. There is no superuser — the
  // role was removed on 2026-10-06 along with its dashboard, and admin is the
  // top.
  switch (user?.role) {
    case 'admin':
      window.location.href = '/adminDashboard.html';
      break;
    case 'developer':
      window.location.href = '/devDashboard.html';
      break;
    case 'prod':
      // Production reviews work; it has no workspace and no admin powers, so
      // the reviewer's queue is its whole page. Until 2026-10-06 this case did
      // not exist and a prod signing in was told "No match for login".
      window.location.href = '/prodDashboard.html';
      break;
    case 'user':
      alert(`Welcome back, ${user?.username || 'user'}!`);
      window.location.href = '/user.html';
      break;
    default:
      alert("No match for login");
      window.location.href = DEFAULT_START_PAGE;
      break;
  }
}
// REMOVED: handleDeveloperReissueRequest(), which reissued an invitation from
// the developer dashboard.
//
// It was dead four times over, so it is deleted rather than moved:
//
//   1. nothing called it — the inline onclick that did lived in
//      developerInviteExp.html, which is gone;
//   2. two of the ids it reached for, reissue-allowed-state and
//      reissue-limit-state, exist nowhere at all;
//   3. the two that DO exist, btn-request-reissue and reissue-status-msg, are
//      on the REGISTER page — and this file is not loaded there;
//   4. it fetched /api/invites/request-reissue. The route is
//      /api/inviteDevs/request-reissue; /api/invites/ has never existed.
//
// The working reissue lives in frontend/src/register.js, on the page where an
// expired invitation actually lands — which is the only place it can work,
// since an expired-invite holder has no account to sign in with.

// ---------------------------------------------------------------------------
// Arriving here because a session ended
//
// frontend/src/api.js sends you to this page with ?session=expired when an API
// call is refused for having no session. Without this the redirect would be
// unexplained, and a page that moves you without saying why reads as a bug.
//
// FROM THE URL, not from a query of localStorage: localStorage is exactly the
// thing that was stale, and is already cleared by the time we get here.
// ---------------------------------------------------------------------------

(function explainExpiredSession() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('session') !== 'expired') return;

  const notice = document.getElementById('session-notice');
  if (notice) notice.classList.remove('d-none');

  // Open the sign-in panel, so the next step is in front of them rather than
  // behind a button they have to find. The notice above says why it is open.
  const dropdown = document.getElementById('loginDropdown');
  if (dropdown && window.bootstrap) {
    window.bootstrap.Dropdown.getOrCreateInstance(dropdown).show();
  }

  // Drop the parameter, so a reload or a shared link does not keep claiming a
  // session just expired.
  params.delete('session');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
})();
