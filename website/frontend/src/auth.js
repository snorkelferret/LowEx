// frontend/auth.js

// Relative path works automatically when deployed behind Nginx or bundled via Vite proxy
const API_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:5000/api/auth' 
  : '/api/auth';

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

  try {
    const res = await fetch(`${API_URL}/login-step1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
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
      saveSessionAndFinish(data.token, data.user);
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
      body: JSON.stringify({ username: activeUsername, code: code })
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || '2FA Verification Failed');
      return;
    }

    saveSessionAndFinish(data.token, data.user);
  } catch (err) {
    showError('Verification request failed.');
  }
});


function saveSessionAndFinish(token, user) {
  localStorage.setItem('jwt_token', token);
  localStorage.setItem('user_info', JSON.stringify(user));

  // 1. Hide Bootstrap Dropdown Modal if open
  const dropdownEl = document.getElementById('loginDropdown');
  if (window.bootstrap && dropdownEl) {
    const bsDropdown = window.bootstrap.Dropdown.getInstance(dropdownEl);
    if (bsDropdown) bsDropdown.hide();
  }

  // 2. Update Top-Right Header Navbar State
  if (typeof updateNavbarState === 'function') {
    updateNavbarState();
  }

  // 3. Immediate Superuser Dashboard Load OR Page Refresh
  if (user && user.role === 'superuser') {
    window.location.href = '/superuserDashboard.html';
  } else {
    alert(`Welcome back, ${user.username}!`);
    window.location.reload(); 
  }
}
