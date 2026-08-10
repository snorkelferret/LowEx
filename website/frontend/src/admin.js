// frontend/src/admin.js
import { reissueInvite, getInviteStatus } from './sharedInvites.js';

// ==========================================
// 1. Strict Module-Level Configuration
// ==========================================
//const apiUrl = import.meta.env.VITE_API_URL;
/*
if (!apiUrl) {
  throw new Error('FATAL: VITE_API_URL is missing from environment variables.');
}
*/

const API_URL = '/api';


document.addEventListener('DOMContentLoaded', async () => {
  await fetchAdminMetrics();

  // Binds directly to target reissue elements inside the admin DOM view layer
  document.getElementById('invites-table-body')?.addEventListener('click', async (e) => {
    if (e.target.classList.contains('btn-reissue-trigger')) {
      const inviteId = e.target.dataset.id;
      
      // Fires shared utility seamlessly - cookies handle authorization invisibly
      const result = await reissueInvite(inviteId);
      if (result.success) {
        alert('Invitation successfully extended for another 28 days!');
        window.location.reload();
      } else {
        alert(`Action failed: ${result.error}`);
      }
    }
  });
});



async function fetchAdminMetrics() {
  try {
    const res = await fetch(`${API_URL}/admin/stats`, {
      credentials: 'include'
    });
      
    if (!res.ok) throw new Error('Could not pull admin dashboard data.');
    const data = await res.json();
    
    // Process and display metrics here...
  } catch (err) {
    console.error(err.message);
  }
}
