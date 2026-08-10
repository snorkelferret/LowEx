// frontend/src/sharedInvites.js

const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 60 * 60 * 1000;
// ==========================================
// 1. Strict Module-Level Configuration
// ==========================================
/* const apiUrl = import.meta.env.VITE_API_URL;


if (!apiUrl) {
  throw new Error('FATAL: VITE_API_URL is missing from environment variables.');
}

const API_URL = apiUrl;
*/


const API_URL = '/api';

/**
 * Calculates whether an invitation is expired based on the 28-day rule.
 */
export function getInviteStatus(createdAt) {
  const createdDate = new Date(createdAt);
  const expiryDate = new Date(createdDate.getTime() + TWENTY_EIGHT_DAYS_MS);
  const now = new Date();

  if (now > expiryDate) {
    return { isExpired: true, label: 'Expired' };
  }

  const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
  return { isExpired: false, label: `${daysRemaining} days left` };
}

/**
 * Reissues an existing invitation (Generates new token & resets 28-day clock)
 */
export async function reissueInvite(inviteId) {

  try {
      const response = await fetch(`${API_URL}/inviteDevs/${inviteId}/reissue`, {
	  method: 'POST',
	  headers: {
              'Content-Type': 'application/json'
	  },
	  credentials: 'include' // Required if your backend uses session cookies
      });


      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to generate invite token.');

      console.log(`Reissued invite ${inviteId}. New 28-day window active.`);
      return { success: true, data };
  } catch (err) {
      console.error('Failed to reissue invite:', err);
      return { success: false, error: err.message };
  }
    
}

/**
 * Dynamically refreshes the unified invitation list body
 */
async function refreshInvitationsList() {
    const listBody = document.getElementById('invite-list-body');
    if (!listBody) return;

    try {
	
	const res = await fetch(`${API_URL}/inviteDevs/list`, {
	    credentials: 'include' // Ensures cookies/session are sent if your backend uses them
	});
	if (!res.ok) throw new Error('Failed to pull updated invitations list');
	const invites = await res.json();

	if (invites.length === 0) {
	    listBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">No invitations found.</td></tr>';
	    return;
	}

	// Use .map().join('') to cleanly render rows without innerHTML += loop overhead or nested backtick bugs
	listBody.innerHTML = invites.map(invite => {
	    const statusInfo = getInviteStatus(invite.createdAt);
	    
	    let badgeClass = 'bg-warning text-dark';
	    if (invite.status === 'active') badgeClass = 'bg-success';
	    if (statusInfo.isExpired) badgeClass = 'bg-danger';

	    const actionHtml = statusInfo.isExpired
		  ? `<button class="btn btn-sm btn-outline-warning py-0 px-2 btn-reissue-trigger" data-id="${invite.id}"><i class="bi bi-arrow-clockwise"></i> Reissue</button>`
		  : '<span class="text-muted small">Active</span>';

	    return `
        <tr>
          <td><i class="bi bi-envelope-fill text-secondary me-2"></i>${invite.email}</td>
          <td><span class="badge bg-dark border border-secondary text-light">${invite.role || 'developer'}</span></td>
          <td><span class="badge ${badgeClass}">${invite.status}</span></td>
          <td>${statusInfo.label}</td>
          <td><span class="text-secondary">${invite.reissueCount || 0}</span></td>
          <td class="text-end">${actionHtml}</td>
        </tr>
      `;
	}).join('');
	
	// Bind click events safely to all newly rendered reissue triggers
	document.querySelectorAll('.btn-reissue-trigger').forEach(btn => {
	    btn.addEventListener('click', async (e) => {
		const id = e.currentTarget.getAttribute('data-id');
		const outcome = await reissueInvite(id);
		if (outcome.success) {
		    refreshInvitationsList();
		} else {
		    alert(`Could not reissue token: ${outcome.error}`);
		}
	    });
	});

	console.log("🔄 Invitation list display updated successfully.");
    } catch (err) {
	console.error("Could not refresh UI invitation tracking framework:", err.message);
    }
}

/**
 * Handles Form Submission for generating new Developer Invites
 */
export function initInviteDeveloper() {
  const inviteForm = document.getElementById('inviteDevForm');
  const generateBtn = document.getElementById('btn-send-invite');
  const alertBox = document.getElementById('invite-alert');

  if (!inviteForm) return; 

  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput = document.getElementById('invite-email').value.trim();
    const roleSelect = document.getElementById('invite-role');
    const roleInput = roleSelect ? roleSelect.value : 'developer';

    if (!emailInput) return alert('Please enter a valid email address.');

    if (generateBtn) {
      generateBtn.disabled = true;
      generateBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Sending...';
    }

      try {
	  const res = await fetch(`${API_URL}/inviteDevs/generate-invite`, {
              method: 'POST',
              headers: {
		  'Content-Type': 'application/json'
              },
              body: JSON.stringify({ email: emailInput, role: roleInput }),
	      credentials: 'include'
	  });



const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate invite token.');
      
      document.getElementById('invite-email').value = '';
      
      if (alertBox) {
        alertBox.className = "alert alert-success py-2 px-3 small mb-3";
        alertBox.innerHTML = `<i class="bi bi-check-circle-fill me-2"></i>Invite sent successfully to ${emailInput}!`;
        alertBox.classList.remove('d-none');
      }

      await refreshInvitationsList();

    } catch (err) {
      if (alertBox) {
        alertBox.className = "alert alert-danger py-2 px-3 small mb-3";
        alertBox.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-2"></i>Error: ${err.message}`;
        alertBox.classList.remove('d-none');
      }
    } finally {
      if (generateBtn) {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<i class="bi bi-send me-1"></i> Send Invite';
      }
    }
  });
}

// Global copy utility helper
if (!window.copyInviteLink) {
  window.copyInviteLink = function() {
    const copyText = document.getElementById('invite-link-input');
    if (copyText) {
      copyText.select();
      copyText.setSelectionRange(0, 99999);
      navigator.clipboard.writeText(copyText.value);
      alert('Invite link copied to clipboard!');
    }
  };
}

// Attach listeners on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initInviteDeveloper();
  refreshInvitationsList();
});







