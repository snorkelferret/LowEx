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

export async function handleDeveloperReissueRequest() {
  const btn = document.getElementById('btn-request-reissue');
  const statusMsg = document.getElementById('reissue-status-msg');
  
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>Requesting...`;

  try {
    // ✅ CLEANED: Headers no longer manually attach the Bearer token
    const res = await fetch('/api/invites/request-reissue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.error === 'LIMIT_REACHED') {
        document.getElementById('reissue-allowed-state').classList.add('d-none');
        document.getElementById('reissue-limit-state').classList.remove('d-none');
        return;
      }
      throw new Error(data.message || 'Failed to request reissue.');
    }

    statusMsg.className = 'alert alert-success mt-3 mb-0 py-2 small';
    statusMsg.textContent = data.message;
    statusMsg.classList.remove('d-none');
    btn.textContent = 'Request Sent!';

  } catch (err) {
    statusMsg.className = 'alert alert-danger mt-3 mb-0 py-2 small';
    statusMsg.textContent = err.message;
    statusMsg.classList.remove('d-none');
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-arrow-repeat me-1"></i> Retry Request`;
  }
}
