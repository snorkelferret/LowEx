// frontend/src/register.js
//
// Accepting an invitation.
//
// Four states, only one of which is a form. The others say something useful
// rather than presenting a form that would fail on submit:
//
//   pending   show the form
//   expired   offer a reissue
//   revoked   withdrawn by an administrator
//   used      already accepted — point at login
//
// No header and no auth guard on this page: whoever arrives here has no
// account yet, which is the whole reason they are here.

const API = '/api';

const $ = (id) => document.getElementById(id);

const SECTIONS = [
    'register-checking',
    'register-form-wrap',
    'register-done',
    'register-expired',
    'register-blocked'
];

let inviteToken = '';

function showSection(id) {
    for (const section of SECTIONS) {
        const el = $(section);
        if (el) el.classList.toggle('d-none', section !== id);
    }
}

function showError(message) {
    const el = $('register-error');
    if (!el) return;

    if (!message) {
        el.textContent = '';
        el.classList.add('d-none');
        return;
    }

    el.textContent = message;
    el.classList.remove('d-none');
}

function blocked(title, message) {
    const titleEl = $('register-blocked-title');
    const messageEl = $('register-blocked-message');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    showSection('register-blocked');
}

function showForm(state) {
    const roleEl = $('register-role');
    const emailEl = $('register-email');

    if (roleEl) roleEl.textContent = state.role || 'member';
    if (emailEl) emailEl.textContent = state.email || '';

    showSection('register-form-wrap');
    $('register-username')?.focus();
}

// ---------------------------------------------------------------------------

async function loadTokenState() {
    const params = new URLSearchParams(window.location.search);
    inviteToken = (params.get('token') || '').trim();

    if (!inviteToken) {
        blocked(
            'No invitation token',
            'This page needs an invitation link. Check you copied the whole link.'
        );
        return;
    }

    let state;

    try {
        const response = await fetch(
            `${API}/inviteDevs/token-state?token=${encodeURIComponent(inviteToken)}`
        );
        state = await response.json();
    } catch (err) {
        console.error('Could not check the invitation:', err);
        blocked('Could not check the invitation', 'Please try again in a moment.');
        return;
    }

    switch (state.state) {
        case 'pending':
            showForm(state);
            break;

        case 'expired':
            showSection('register-expired');
            break;

        case 'revoked':
            blocked(
                'Invitation withdrawn',
                'This invitation has been withdrawn by an administrator. ' +
                'Please contact them if you think that is a mistake.'
            );
            break;

        case 'used':
            blocked(
                'Invitation already accepted',
                'This invitation has already been used to create an account. ' +
                'Try logging in instead.'
            );
            break;

        default:
            blocked(
                'Invitation not recognised',
                'This link is not valid. Check you copied the whole link, or ask ' +
                'for a new invitation.'
            );
    }
}

// ---------------------------------------------------------------------------

$('registerForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');

    const username = $('register-username')?.value.trim() || '';
    const password = $('register-password')?.value || '';
    const confirmation = $('register-password-confirm')?.value || '';
    const button = $('register-submit');

    if (!username || !password) {
        showError('A username and password are required.');
        return;
    }

    if (password.length < 8) {
        showError('Use at least 8 characters for the password.');
        return;
    }

    if (password !== confirmation) {
        showError('The passwords do not match.');
        return;
    }

    if (button) button.disabled = true;

    try {
        const response = await fetch(`${API}/auth/register-invited`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, inviteToken })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            showError(data.error || 'Could not create the account.');
            if (button) button.disabled = false;
            return;
        }

        showSection('register-done');

    } catch (err) {
        console.error('Registration failed:', err);
        showError('Could not reach the server. Please try again.');
        if (button) button.disabled = false;
    }
});

// ---------------------------------------------------------------------------

$('btn-request-reissue')?.addEventListener('click', async () => {
    const button = $('btn-request-reissue');
    const message = $('reissue-status-msg');

    if (button) {
        button.disabled = true;
        button.textContent = 'Requesting…';
    }

    try {
        const response = await fetch(`${API}/inviteDevs/request-reissue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: inviteToken })
        });

        const data = await response.json().catch(() => ({}));

        if (!message) return;

        message.classList.remove('d-none');

        if (!response.ok) {
            message.className = 'alert alert-danger mt-3 mb-0 py-2 small';
            message.textContent =
                data.message || data.error || 'Could not request a new link.';

            if (button) {
                button.disabled = false;
                button.textContent = 'Request a new link';
            }
            return;
        }

        message.className = 'alert alert-success mt-3 mb-0 py-2 small';
        message.textContent = data.message || 'A new link has been generated.';

        // No mail transport yet, so the link is shown here rather than sent.
        // When email exists this becomes a courtesy, not the mechanism.
        if (data.inviteLink) {
            const link = document.createElement('a');
            link.href = data.inviteLink;
            link.className = 'd-block mt-1 text-break';
            link.textContent = data.inviteLink;
            message.appendChild(link);
        }

        if (button) button.textContent = 'New link generated';

    } catch (err) {
        console.error('Reissue failed:', err);

        if (message) {
            message.classList.remove('d-none');
            message.className = 'alert alert-danger mt-3 mb-0 py-2 small';
            message.textContent = 'Could not reach the server. Please try again.';
        }

        if (button) {
            button.disabled = false;
            button.textContent = 'Request a new link';
        }
    }
});

// ---------------------------------------------------------------------------

loadTokenState();
