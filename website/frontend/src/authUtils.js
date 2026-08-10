// frontend/src/authUtils.js

/**
 * Validates whether the logged-in user possesses the required authorization tier.
 * Relies on the public user metadata profile synchronized during the login step.
 */
export function checkAuthGuard(requiredRole) {
  const rawUser = localStorage.getItem('user_info');
  if (!rawUser) return null;

  try {
    const user = JSON.parse(rawUser);
    if (!user.role) return null;

    if (requiredRole && user.role.toLowerCase().trim() !== requiredRole.toLowerCase().trim()) {
      return null;
    }
    return user;
  } catch (err) {
    console.error('Session structure profile read error:', err);
    return null;
  }
}

/**
 * Centralized Application Logout sequence handling client cleanup tasks
 * and structural state synchronization.
 */
export async function executeGlobalLogout() {
  try {
    // Terminate session state token context on backend server (removes httpOnly cookie)
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('Network failure during server session teardown:', err);
  } finally {
    // Always wipe local identity profiles and redirect to main gate
    localStorage.clear();
    window.location.href = '/index.html';
  }
}
