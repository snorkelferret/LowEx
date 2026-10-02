// frontend/src/feedback.js
//
// The report-a-problem button, on every page.
//
// IT BUILDS ITSELF. Nothing else has to be added to a page but the script tag,
// because the alternative is a markup partial that has to be listed in build.js
// for the compiled pages AND pasted into the four hand-written ones, which is
// four chances to forget one and one more place for the two to drift. A page
// that includes this script gets the button; that is the whole contract.
//
// WHO AND WHEN ARE NOT SENT. The server takes the actor from the session and
// the timestamp from its own clock. This file must not be trusted with either,
// so it does not try — the only thing it contributes is what only it knows,
// which is which page the report is about.
//
// The "who" shown in the dialog is read from localStorage and is DISPLAY ONLY.
// It comes from a value the browser already holds, so it can be wrong or
// absent, and nothing on the server reads it.

import { FEEDBACK_KINDS, MAX_MESSAGE_LENGTH } from '../../shared/feedbackRules.mjs';
import { $, escapeHtml } from './utils.js';

const API = '/api';

// Built once, appended to the body. The ids are prefixed so they cannot
// collide with anything a page already defines — this module is dropped into
// eight pages it knows nothing about.
const ID = {
    launch: 'feedback-launch',
    modal: 'feedback-modal',
    form: 'feedback-form',
    kind: 'feedback-kind',
    message: 'feedback-message',
    contact: 'feedback-contact',
    contactWrap: 'feedback-contact-wrap',
    identity: 'feedback-identity',
    page: 'feedback-page',
    error: 'feedback-error',
    submit: 'feedback-submit',
    done: 'feedback-done',
    body: 'feedback-body',
};

function signedInUser() {
    try {
        const raw = localStorage.getItem('user_info');
        return raw ? JSON.parse(raw) : null;
    } catch {
        // A malformed profile is not worth breaking a page over, and it is not
        // a session either.
        return null;
    }
}

function thePage() {
    // Path and query only. The origin is the same for every report and would
    // be noise; the query string is not, because it can name the asset or
    // version the report is about.
    return window.location.pathname + window.location.search;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function buildLaunchButton() {
    const button = document.createElement('button');

    button.id = ID.launch;
    button.type = 'button';
    button.className =
        'btn btn-sm btn-outline-secondary position-fixed shadow-sm ' +
        'd-flex align-items-center gap-2';
    button.style.cssText =
        'right:1rem; bottom:1rem; z-index:1040; border-radius:2rem; padding:.4rem .9rem;';
    button.setAttribute('data-bs-toggle', 'modal');
    button.setAttribute('data-bs-target', `#${ID.modal}`);
    button.setAttribute('aria-label', 'Report a problem');
    button.innerHTML =
        '<i class="bi bi-bug"></i><span class="d-none d-sm-inline">Report a problem</span>';

    return button;
}

function buildModal() {
    const user = signedInUser();

    const wrapper = document.createElement('div');
    wrapper.className = 'modal fade';
    wrapper.id = ID.modal;
    wrapper.tabIndex = -1;
    wrapper.setAttribute('aria-hidden', 'true');

    // Kinds come from the shared list, so the options here and the rule that
    // validates them on the server cannot drift apart.
    const kindOptions = FEEDBACK_KINDS
        .map((k, i) => `
            <div class="form-check">
              <input class="form-check-input" type="radio" name="feedback-kind"
                     id="feedback-kind-${escapeHtml(k.value)}"
                     value="${escapeHtml(k.value)}" ${i === 0 ? 'checked' : ''}>
              <label class="form-check-label"
                     for="feedback-kind-${escapeHtml(k.value)}">
                ${escapeHtml(k.label)}
              </label>
            </div>
        `)
        .join('');

    const identity = user && user.username
        ? `Reporting as <strong>${escapeHtml(user.username)}</strong>.`
        : 'You are not signed in — this will be sent anonymously.';

    wrapper.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content bg-dark text-light border-secondary">

          <div class="modal-header border-secondary">
            <h5 class="modal-title">
              <i class="bi bi-bug me-2"></i>Report a problem
            </h5>
            <button type="button" class="btn-close btn-close-white"
                    data-bs-dismiss="modal" aria-label="Close"></button>
          </div>

          <div class="modal-body" id="${ID.body}">

            <div class="alert alert-danger py-2 px-3 small d-none" id="${ID.error}"></div>

            <p class="text-secondary small mb-3" id="${ID.identity}">${identity}</p>

            <div class="mb-3">
              <label class="form-label d-block">What kind of report is this?</label>
              ${kindOptions}
            </div>

            <div class="mb-3">
              <label for="${ID.message}" class="form-label">What happened?</label>
              <textarea class="form-control" id="${ID.message}" rows="5"
                        maxlength="${MAX_MESSAGE_LENGTH}"
                        placeholder="What you did, what you expected, what happened instead. Paste any error message in full."></textarea>
            </div>

            <div class="mb-3 d-none" id="${ID.contactWrap}">
              <label for="${ID.contact}" class="form-label">
                Email <span class="text-secondary fw-normal">(optional)</span>
              </label>
              <input type="email" class="form-control" id="${ID.contact}"
                     placeholder="Only if you would like a reply" autocomplete="email">
            </div>

            <p class="text-secondary small mb-0">
              This report will say it came from
              <code id="${ID.page}"></code>
              — that is filled in for you, along with who you are and the time,
              so there is nothing to type but the report itself.
            </p>
          </div>

          <div class="modal-footer border-secondary">
            <button type="button" class="btn btn-outline-secondary"
                    data-bs-dismiss="modal">Cancel</button>
            <button type="button" class="btn btn-primary" id="${ID.submit}">
              Send report
            </button>
          </div>
        </div>
      </div>
    `;

    return wrapper;
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

function setError(message) {
    const box = $(ID.error);
    if (!box) return;

    if (!message) {
        box.textContent = '';
        box.classList.add('d-none');
        return;
    }

    box.textContent = message;
    box.classList.remove('d-none');
}

// Errors arrive keyed by field, so point at the input rather than dropping one
// string at the top and hoping they work out which box is wrong.
function showFieldErrors(errors) {
    setError(errors.message || errors.kind || 'That report could not be sent.');

    if (errors.message) {
        $(ID.message)?.focus();
    }
}

async function submit(button) {
    setError('');

    const kind =
        document.querySelector('input[name="feedback-kind"]:checked')?.value || '';
    const message = $(ID.message)?.value || '';
    const contact = $(ID.contact)?.value || '';

    if (button) {
        button.disabled = true;
        button.textContent = 'Sending…';
    }

    try {
        const response = await fetch(`${API}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                kind,
                message,
                contact,
                page_url: thePage(),
            }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            showFieldErrors(data.errors || {});
            if (!data.errors) {
                setError(data.error || 'That report could not be sent.');
            }
            if (button) {
                button.disabled = false;
                button.textContent = 'Send report';
            }
            return;
        }

        showThanks();

    } catch (err) {
        console.error('Could not send the report:', err);
        setError('Could not reach the server. Please try again.');
        if (button) {
            button.disabled = false;
            button.textContent = 'Send report';
        }
    }
}

function showThanks() {
    const body = $(ID.body);
    if (!body) return;

    const user = signedInUser();

    body.innerHTML = `
      <div class="text-center py-4">
        <i class="bi bi-check-circle text-success" style="font-size:2rem;"></i>
        <p class="mt-3 mb-1">Thank you — that has been recorded.</p>
        <p class="text-secondary small mb-0">
          ${user && user.username
            ? 'It is recorded against your account, so you do not need to say who you are.'
            : 'It was recorded anonymously, so there is no way to reply unless you gave an email.'}
        </p>
      </div>
    `;

    // The button that submitted is inside the replaced markup, so restore the
    // dialog to its form for next time by simply closing after a beat.
    setTimeout(() => {
        const modal = document.getElementById(ID.modal);
        if (!modal || !window.bootstrap) return;

        window.bootstrap.Modal.getOrCreateInstance(modal).hide();

        // Rebuild the form so opening it again is not a dead thank-you panel.
        modal.addEventListener('hidden.bs.modal', () => {
            modal.replaceWith(buildModal());
            wire();
        }, { once: true });
    }, 1600);
}

function wire() {
    const submitButton = $(ID.submit);
    submitButton?.addEventListener('click', () => submit(submitButton));

    // Ctrl/Cmd+Enter sends, which is what anyone who has used a comment box
    // will try.
    $(ID.message)?.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            submit(submitButton);
        }
    });

    // The email box is only useful to someone with no session. Showing it to a
    // signed-in reporter invites them to hand over an address the system
    // already has.
    const user = signedInUser();
    if (!user || !user.username) {
        $(ID.contactWrap)?.classList.remove('d-none');
    }

    const page = $(ID.page);
    if (page) page.textContent = thePage();
}

// ---------------------------------------------------------------------------

function init() {
    // Never twice, whatever a page does with its script tags.
    if (document.getElementById(ID.launch)) return;

    document.body.appendChild(buildLaunchButton());
    document.body.appendChild(buildModal());
    wire();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
