// frontend/src/header.js
import { executeGlobalLogout } from './authUtils.js';


// 1. Immediate Page Protection / Workspace Guard
(() => {
  const rawUser = localStorage.getItem('user_info');
  const path = window.location.pathname;

  // Protect dashboard routes if no session metadata exists
  if (!rawUser && !path.includes('index.html')) {
    window.location.href = '/index.html';
    return;
  }

  try {
    const user = JSON.parse(rawUser || '{}');
    
    // Guard Superuser views
    if (path.includes('superuserDashboard.html') && user.role !== 'superuser') {
      alert('Access Denied: Superuser clearance required.');
      window.location.href = '/index.html';
    }
    // Guard Admin views
    if (path.includes('adminDashboard.html') && user.role !== 'admin' && user.role !== 'superuser') {
      alert('Access Denied: Admin clearance required.');
      window.location.href = '/index.html';
    }
  } catch (err) {
    localStorage.clear();
    window.location.href = '/index.html';
  }
})();

// 2. Dynamic UI Population and Navbar Interactive States
document.addEventListener('DOMContentLoaded', () => {
  updateNavbarState();
});

export function updateNavbarState() {
  const rawUser = localStorage.getItem('user_info');
  const user = rawUser ? JSON.parse(rawUser) : null;
  
  const nameEl = document.getElementById('headerUsernameTarget');
  const titleEl = document.getElementById('headerDashboardTitle');
  const logoutBtn = document.getElementById('logoutBtn');
  const loginSection = document.getElementById('navbar-login-section');
  const profileSection = document.getElementById('navbar-profile-section');

  if (user) {
    // Show Profile UI / Hide Guest Login options
    if (loginSection) loginSection.classList.add('d-none');
    if (profileSection) profileSection.classList.remove('d-none');

    // Populate Username display element
    if (nameEl) nameEl.textContent = user.username || user.email || 'User';

    // Populate Dynamic Workspace Title
    if (titleEl && user.role) {
      const roleLower = user.role.toLowerCase().trim();
      const formattedRole = roleLower.charAt(0).toUpperCase() + roleLower.slice(1);
      
      let prefix = '🖥️';
      if (roleLower === 'superuser') prefix = '⚡';
      else if (roleLower === 'admin') prefix = '🛡️';
      else if (roleLower === 'developer') prefix = '💻';

      titleEl.textContent = `${prefix} ${formattedRole} Dashboard`;
    }
  } else {
      // User is logged out: show Guest state
      if (loginSection) loginSection.classList.remove('d-none');
      if (profileSection) profileSection.classList.add('d-none');
      if (titleEl) titleEl.textContent = 'Project Console';
  }

    // Bind the global Logout / Switch User action button cleanly
    if (logoutBtn && !logoutBtn.dataset.bound) {
	logoutBtn.dataset.bound = "true";
	logoutBtn.addEventListener('click', executeGlobalLogout);
    }
}

// Make globally accessible if invoked inline by legacy view templates
window.updateNavbarState = updateNavbarState;
