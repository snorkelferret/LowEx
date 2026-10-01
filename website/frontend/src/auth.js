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
  
  // 3. Immediate Superuser Dashboard Load OR Page Refresh   
  switch (user?.role) {
    case 'superuser':
      window.location.href = '/superuserDashboard.html';
      break;
    case 'admin':
      window.location.href = '/adminDashboard.html';
      break;
    case 'developer':
      window.location.href = '/devDashboard.html';
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
