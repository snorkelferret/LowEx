import { apiFetch } from './api.js';
// frontend/src/admin.js
// No import from sharedInvites.js any more: reissueInvite and getInviteStatus
// were only used by the dead block removed below.

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
});

// REMOVED: a reissue click-handler bound to a table-body id that does not
// exist — the real one is `invite-list-body`.
//
// It was dead three times over, which is why it is deleted rather than fixed:
//
//   1. the id was wrong, so nothing was ever bound;
//   2. sharedInvites.js already handles reissue clicks on that table by
//      delegation, so correcting the id would have made a second handler fire
//      and send the request twice;
//   3. it called reissueInvite(id), and there is no id-based reissue route.
//      Reissue is token-based: POST /api/inviteDevs/request-reissue.




// The counts, as stat tiles.
//
// THIS FUNCTION USED TO END AT "Process and display metrics here...". The fetch
// worked, the endpoint answered, and the result was thrown away — so the panel
// showed the markup's "Loading admin stats..." for ever. Three real numbers
// were being fetched on every page load and discarded.
//
// THREE TILES RATHER THAN A CHART. Three unrelated totals have no shared scale,
// no trend and no magnitude to compare against each other, so bars would invent
// a comparison that does not exist.
function statTile(label, value, attention) {
  const tile = document.createElement('div');
  tile.className = 'stat-tile';

  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = 'stat-value';

  if (attention) {
    // A status colour, which is only ever allowed with an icon AND a label —
    // never colour alone. The hourglass says "waiting on somebody"; the label
    // above says what on.
    valueEl.classList.add('stat-value--attention');

    const icon = document.createElement('i');
    icon.className = 'bi bi-hourglass-split me-2';
    valueEl.appendChild(icon);
  }

  valueEl.appendChild(document.createTextNode(String(value ?? '—')));

  tile.appendChild(labelEl);
  tile.appendChild(valueEl);

  return tile;
}

function renderStats(data) {
  const box = document.getElementById('adminStatsContainer');
  if (!box) return;

  const pending = data.pendingInvitations || 0;

  box.className = 'd-flex flex-wrap gap-4';
  box.innerHTML = '';

  box.appendChild(statTile('Active users', data.activeUsers));
  box.appendChild(statTile('Total users', data.totalUsers));
  // Only a state when it is not zero. A standing "0" in warning amber would
  // cry wolf on every page load and stop meaning anything.
  box.appendChild(statTile('Pending invitations', pending, pending > 0));
}

async function fetchAdminMetrics() {
  const box = document.getElementById('adminStatsContainer');

  try {
    const res = await apiFetch(`${API_URL}/admin/stats`, {
      credentials: 'include'
    });

    if (!res.ok) throw new Error('Could not pull admin dashboard data.');

    renderStats(await res.json());

  } catch (err) {
    console.error(err.message);

    // Said on the page, not only in the console. The alternative is the
    // placeholder sitting there saying "Loading..." for ever, which reads as a
    // slow page rather than as a failure.
    if (box) {
      box.className = 'text-danger small';
      box.textContent = err.message;
    }
  }
}
