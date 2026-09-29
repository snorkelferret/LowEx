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
  // The session cookie is httpOnly, so only the server can clear it. If that
  // call fails we must not pretend the user is signed out.
  let serverLogoutFailed = false;

  try {
    const res = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    if (!res.ok) {
      serverLogoutFailed = true;
      console.error('Server refused to terminate the session:', res.status);
    }
  } catch (err) {
    serverLogoutFailed = true;
    console.error('Network failure during server session teardown:', err);
  }

  // Wipe local identity profiles regardless — the user asked to leave.
  localStorage.clear();

  if (serverLogoutFailed) {
    alert(
      'You have been signed out of this browser, but the server could not be ' +
      'reached to end the session. On a shared machine, close the browser.'
    );
  }

  window.location.href = '/index.html';
}
