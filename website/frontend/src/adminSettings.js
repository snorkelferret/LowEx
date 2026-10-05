// frontend/src/adminSettings.js
//
// The Settings panel, on both the admin and superuser dashboards — for the same
// reason adminUsers.js, adminReports.js, adminAudit.js and adminStorage.js are:
// the panel is built into both, and logic living in admin.js would leave it
// stuck on "Loading…" on the superuser dashboard.
//
// IT KNOWS NOTHING ABOUT ANY PARTICULAR SETTING. The server sends each one with
// its label, its bounds, its unit, its default and the note to show beside it,
// and this renders whatever arrives. So adding a setting is a line in
// backend/lib/settings.js and nothing here — there is no second list of keys to
// keep in step, which is the thing that would go stale first.
//
// THE SERVER VALIDATES, AND ITS MESSAGE IS SHOWN. Bounds are checked on the
// server because that is where they are declared; the client does not
// re-implement them, so the two cannot disagree about what is allowed. A
// refusal comes back as the sentence to display, exactly as an acceptance does.

import { $ } from './utils.js';
import { apiFetch } from './api.js';

const API = '/api';

// Which variety of alert for which outcome. Held here rather than sent by the
// server: it is presentation, not policy.
let alertTimer = null;

function showAlert(message, variant) {
    const box = $('settingsAlert');
    if (!box) return;

    clearTimeout(alertTimer);

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.className = `alert alert-${variant || 'danger'} py-2 px-3 small`;
    box.textContent = message;

    // A success message that stays for ever stops meaning anything. A refusal
    // stays until the next action, because it is telling you what to type
    // instead and you may need to read it while you do.
    if (variant === 'success') {
        alertTimer = setTimeout(() => showAlert(''), 6000);
    }
}

function row(setting) {
    const wrap = document.createElement('div');
    wrap.className = 'border-top border-secondary-subtle py-3';
    wrap.dataset.key = setting.key;

    // THE NOTE IS NOT INSIDE THIS FLEX ROW, and that is a layout fix rather
    // than tidiness. With the note in the same row, a long one takes the width
    // it needs and pushes the control onto the next line — so Wastebin retention
    // had its button left-aligned underneath while every other row had it on the
    // right. Keeping the row to the label and the control means every row lines
    // up whatever the note says.
    const head = document.createElement('div');
    head.className = 'd-flex justify-content-between align-items-center gap-3';

    // ---- What it is -------------------------------------------------------
    const label = document.createElement('div');
    label.style.minWidth = '0';

    const title = document.createElement('div');
    title.className = 'fw-semibold';
    title.textContent = setting.label;
    label.appendChild(title);

    const range = document.createElement('div');
    range.className = 'text-secondary small';
    range.textContent =
        `${setting.min}–${setting.max} ${setting.unit}` +
        (setting.overridden
            ? ` · default ${setting.default}`
            : ' · this is the default');
    label.appendChild(range);

    head.appendChild(label);

    // ---- The control ------------------------------------------------------
    const control = document.createElement('div');
    control.className = 'd-flex align-items-start gap-2';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'form-control form-control-sm bg-dark text-light border-secondary';
    input.style.width = '7rem';
    input.value = setting.value;
    input.min = String(setting.min);
    input.max = String(setting.max);
    input.id = `setting-${setting.key}`;
    input.setAttribute('aria-label', setting.label);
    // What the server last said this value was. Kept ON THE INPUT so it
    // survives the re-render that follows every save — a stale one would let an
    // unchanged value be saved again, writing an audit entry saying nothing
    // happened.
    input.dataset.saved = String(setting.value);
    control.appendChild(input);

    const unit = document.createElement('span');
    unit.className = 'text-secondary small pt-1';
    unit.style.minWidth = '2.5rem';
    unit.textContent = setting.unit;
    control.appendChild(unit);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary btn-sm';
    save.dataset.action = 'save';
    save.textContent = 'Save';
    control.appendChild(save);

    // Only where there is something to reset. A "reset" that does nothing
    // because the value is already the default reads as a broken button.
    if (setting.overridden) {
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn btn-outline-secondary btn-sm';
        reset.dataset.action = 'reset';
        reset.textContent = 'Reset';
        reset.title = `Back to the default of ${setting.default} ${setting.unit}`;
        control.appendChild(reset);
    }

    // The control keeps its width; the label gives way if the window is narrow,
    // rather than the button sliding underneath and the rows losing their
    // alignment.
    control.style.flexShrink = '0';

    head.appendChild(control);
    wrap.appendChild(head);

    if (setting.note) {
        const note = document.createElement('div');
        note.className = 'text-secondary small mt-2';
        note.textContent = setting.note;
        wrap.appendChild(note);
    }

    return wrap;
}

function render(settings) {
    const list = $('settingsList');
    if (!list) return;

    list.className = '';
    list.innerHTML = '';

    for (const setting of settings) {
        list.appendChild(row(setting));
    }
}

async function loadSettings() {
    const list = $('settingsList');
    if (!list) return;

    try {
        const response = await apiFetch(`${API}/admin/settings`, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not load settings.');
        }

        render(data.settings || []);

    } catch (err) {
        console.error('Could not load settings:', err.message);

        list.className = 'text-secondary';
        list.textContent = '';
        showAlert(err.message, 'danger');
    }
}

// One delegated listener for the whole panel, not one per button per refresh —
// the same reason the accounts table uses one. Re-rendering after a save must
// not leave listeners attached to elements that no longer exist.
async function onAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const row = button.closest('[data-key]');
    if (!row) return;

    const key = row.dataset.key;
    const input = row.querySelector('input');

    // Nothing to save is not an error, and sending it would write an audit
    // entry recording that nothing changed.
    if (button.dataset.action === 'save' && String(input.value) === String(input.dataset.saved)) {
        showAlert('That is already the value.', 'secondary');
        return;
    }

    const action = button.dataset.action;

    button.disabled = true;
    showAlert('');

    try {
        const options = {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
        };

        if (action === 'save') {
            options.body = JSON.stringify({ value: input.value });
        }

        const response = await apiFetch(
            `${API}/admin/settings/${encodeURIComponent(key)}${action === 'reset' ? '/reset' : ''}`,
            options
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not save the setting.');
        }

        // The server returns the whole list, so the panel is redrawn from what
        // the server now says rather than from what was typed. If a bound moved
        // the value, or a relation refused it, the screen shows the truth.
        if (data.settings) render(data.settings);

        showAlert(
            action === 'reset'
                ? `${key} is back to its default.`
                : `${key} is now ${data.value}. The change is in force — no restart needed.`,
            'success'
        );

    } catch (err) {
        showAlert(err.message, 'danger');

    } finally {
        button.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Urgent alerts
// ---------------------------------------------------------------------------

// SHOWS THE STATE BEFORE THE BUTTON IS PRESSED. Who would be told, and whether
// anything can be sent at all — so that "email is not configured" is something
// read while calmly setting things up rather than discovered during the
// incident the alerts were supposed to report.
function renderNotificationStatus(data) {
    const box = $('notificationStatus');
    if (!box) return;

    box.textContent = '';
    box.className = 'small mb-3';

    const email = data.channels?.email?.configured;
    const recipients = data.recipients || [];

    const line = document.createElement('div');
    line.innerHTML = email
        ? '<span class="badge text-bg-success me-2">email ready</span>' +
          'Messages will be sent from this server.'
        : '<span class="badge text-bg-warning me-2">email not set up</span>' +
          'No mail transport is configured on this server, so nothing will be ' +
          'sent. The SMTP settings live in the server environment, not on this page.';
    box.appendChild(line);

    const who = document.createElement('div');
    who.className = 'mt-1';
    who.textContent = recipients.length === 0
        ? 'Nobody would be told: no admin or superuser account has an email address.'
        : `Would go to ${recipients.length} ` +
          `${recipients.length === 1 ? 'account' : 'accounts'}: ` +
          recipients.map(r => `${r.username} <${r.email}>`).join(', ');
    box.appendChild(who);
}

function showTestResult(message, variant) {
    const box = $('notificationTestResult');
    if (!box) return;

    box.className = variant === 'success'
        ? 'alert alert-success py-2 px-3 small mb-0'
        : 'alert alert-warning py-2 px-3 small mb-0';
    box.textContent = message;
}

async function loadNotificationStatus() {
    const box = $('notificationStatus');
    if (!box) return;

    try {
        const response = await apiFetch(`${API}/admin/notifications`, { credentials: 'include' });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) throw new Error(data.error || 'Could not read the alert setup.');

        renderNotificationStatus(data);

    } catch (err) {
        box.className = 'small mb-3';
        box.textContent = err.message;
    }
}

async function sendTestAlert(button) {
    button.disabled = true;
    showTestResult('Sending...', 'success');

    try {
        const response = await apiFetch(`${API}/admin/notifications/test`, {
            method: 'POST',
            credentials: 'include',
        });

        const data = await response.json().catch(() => ({}));

        // A 200 WITH sent:false IS THE ORDINARY "it could not be sent" ANSWER,
        // not an error — the request succeeded and the answer is that nothing
        // went. Reporting it as a failure would be reporting the wrong thing.
        if (!response.ok) {
            throw new Error(data.error || 'The test could not be sent.');
        }

        if (!data.sent) {
            showTestResult(data.message, 'warning');
            return;
        }

        const cc = (data.cc || []).length
            ? ` (cc: ${data.cc.join(', ')})`
            : '';

        showTestResult(
            `Sent to ${data.to.join(', ')}${cc}. Everyone on it can see who else ` +
            `received it.`,
            'success'
        );

    } catch (err) {
        showTestResult(err.message, 'warning');

    } finally {
        button.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Only present on the admin and superuser dashboards.
    const list = $('settingsList');
    if (!list) return;

    loadNotificationStatus();
    $('notificationTestBtn')?.addEventListener('click', event => {
        sendTestAlert(event.currentTarget);
    });

    // One listener for the whole panel and every redraw, so a save cannot leave
    // a listener attached to an element that no longer exists.
    list.addEventListener('click', onAction);

    loadSettings();
});
