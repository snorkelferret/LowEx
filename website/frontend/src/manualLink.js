// frontend/src/manualLink.js
//
// The way into the manual: a small glyph in the corner, not a button in the
// header.
//
// WHY IT MOVED. It was a labelled button in the top right, beside Log out —
// where a sign-out control lives, and where a link to a document does not
// belong. That bar is about WHO YOU ARE and how to stop being signed in. A
// manual is neither, and sitting next to Log out it read as a session action.
//
// IT BUILDS ITSELF, like frontend/src/feedback.js and for the same reason: it
// is wanted on four pages that share no common component. The three dashboards
// come from header.html, and the tester landing page is hand-written, so a
// markup partial would have to be added in two places and kept in step. A page
// gets the glyph by including this script; that is the whole contract.
//
// POSITIONED BOTTOM-LEFT, opposite the report button. Both are small permanent
// affordances, and putting them on opposite corners means neither is ever
// adjacent to the other or to whatever a page puts in its own corners.

const LINK_ID = 'manual-link';

function init() {
    // Never twice, whatever a page does with its script tags.
    if (document.getElementById(LINK_ID)) return;

    // Deliberately NOT shown on the manual page itself. A link to where you
    // already are is clutter, and the one page that can tell is this one.
    if (window.location.pathname.startsWith('/app/manual')) return;

    const link = document.createElement('a');

    link.id = LINK_ID;
    link.href = '/app/manual';
    link.className =
        'btn btn-sm btn-outline-secondary position-fixed shadow-sm ' +
        'd-flex align-items-center justify-content-center';
    link.style.cssText =
        'left:1rem; bottom:1rem; z-index:1040; border-radius:2rem; ' +
        'width:2.25rem; height:2.25rem; padding:0;';
    link.setAttribute('aria-label', 'Manual');
    link.title = 'Manual';
    link.innerHTML = '<i class="bi bi-book"></i>';

    document.body.appendChild(link);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
