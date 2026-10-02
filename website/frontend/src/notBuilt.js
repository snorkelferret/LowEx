// frontend/src/notBuilt.js
//
// The stub behind a menu entry whose feature does not exist yet.
//
// WHY THIS EXISTS AT ALL. The menu is being built ahead of the features behind
// it, so the shape of the product is visible and nothing quietly falls off the
// list. But a menu entry that does nothing when clicked is indistinguishable
// from a bug — so every stub says what it is, and WHERE THE WORK IS RECORDED.
// One click tells you where to look instead of leaving you to guess, which is
// the difference between a stub and a dead end.
//
// WIRED BY MARKUP, NOT BY CODE. Any element carrying data-not-built gets a
// click handler, so a page adds a stub by describing it rather than by
// remembering to come back here:
//
//     <a data-not-built="admin.reports" data-todo="28">Reports</a>
//
// That is one function and one place to delete it from. When the last stub
// goes, this file goes with it.
//
// IT IS DELIBERATELY CONSOLE-AND-VISIBLE. The console line is for whoever is
// reading the logs; the on-screen notice is for whoever just clicked, who
// otherwise sees nothing happen and concludes the page is broken.

import { escapeHtml } from './utils.js';

const NOTICE_ID = 'not-built-notice';
const VISIBLE_MS = 6000;

// Replaces any existing notice rather than stacking them. Clicking three stubs
// in a row should leave one message on screen, not three overlapping ones.
function showNotice(name, todoItem) {
    document.getElementById(NOTICE_ID)?.remove();

    const notice = document.createElement('div');
    notice.id = NOTICE_ID;
    notice.className = 'alert alert-warning shadow';
    notice.setAttribute('role', 'status');
    notice.style.cssText =
        'position:fixed; top:1rem; left:50%; transform:translateX(-50%); ' +
        'z-index:1050; max-width:32rem; margin:0;';

    // escapeHtml on both: they come from markup written by hand, and a stray
    // angle bracket should render rather than execute.
    notice.innerHTML = `
      <div class="d-flex align-items-start gap-2">
        <i class="bi bi-cone-striped mt-1"></i>
        <div class="small">
          <strong>${escapeHtml(name)} is not built yet.</strong>
          ${todoItem ? `See TODO item ${escapeHtml(todoItem)}.` : ''}
          <div class="text-secondary mt-1">
            <code>missing method: ${escapeHtml(name)}</code>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(notice);

    setTimeout(() => notice.remove(), VISIBLE_MS);
}

/**
 * Report that something is not built.
 *
 * @param name      the method or feature, dotted like the console line people
 *                  already grep for: 'admin.reports', 'developer.download'
 * @param todoItem  the TODO item number, so the click points at the work
 */
export function notBuilt(name, todoItem) {
    console.log(`missing method: ${name}${todoItem ? ` (TODO item ${todoItem})` : ''}`);
    showNotice(name, todoItem);
}

// ---------------------------------------------------------------------------

function wire() {
    for (const element of document.querySelectorAll('[data-not-built]')) {
        element.addEventListener('click', (event) => {
            // The stub is often written on an <a>, which would otherwise
            // navigate to '#' and jump the page to the top.
            event.preventDefault();
            notBuilt(
                element.dataset.notBuilt,
                element.dataset.todo || null
            );
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
} else {
    wire();
}
