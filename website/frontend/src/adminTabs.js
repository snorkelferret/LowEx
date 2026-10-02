// frontend/src/adminTabs.js
//
// The admin sections, as tabs.
//
// WHY A SCRIPT RATHER THAN BOOTSTRAP'S TABS. Bootstrap's tab markup needs every
// pane to be a sibling inside one .tab-content. These panels are separate
// COMPONENTS that build.js concatenates — adminPanel, devInvites, adminReports,
// repoControl, cloudflareControl — and no one of them can wrap the others, so
// the panes cannot be nested by markup.
//
// What it does instead is show one section and hide the rest, by id. Same look,
// and no assumption about where the components sit relative to each other.
//
// ONE MENU FOR BOTH PAGES. The nav lists every section INCLUDING the
// superuser-only ones, and an entry whose section is not on the page is
// REMOVED. So the admin dashboard shows three tabs and the superuser dashboard
// shows five, from the same markup, without either having to know what the
// other has — and adding a panel later is one line in the nav, in one file.
//
// The unbuilt entries (Sessions, Storage, Health, Audit log) have no
// data-section and are left alone: they are wired by notBuilt.js, which reports
// them as missing when clicked rather than switching to an empty pane.

const NAV_ID = 'adminTabs';
const HIDDEN = 'd-none';

function entries(nav) {
    return [...nav.querySelectorAll('[data-section]')];
}

// Shows one section and hides the others.
//
// EVERY entry's target is visited, not just the two that changed — a section
// left visible by a previous state is how two panels end up on screen at once,
// and it is invisible in testing because the first click always looks right.
function select(nav, section) {
    for (const entry of entries(nav)) {
        const target = document.getElementById(entry.dataset.section);
        if (!target) continue;

        const active = entry.dataset.section === section;

        target.classList.toggle(HIDDEN, !active);
        entry.classList.toggle('active', active);
        entry.setAttribute('aria-selected', String(active));
    }
}

function init() {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;

    // Drop entries whose section this page does not have. The admin dashboard
    // would otherwise offer Repository and Cloudflare, which lead nowhere.
    for (const entry of entries(nav)) {
        if (!document.getElementById(entry.dataset.section)) {
            (entry.closest('.nav-item') || entry).remove();
        }
    }

    const remaining = entries(nav);
    if (remaining.length === 0) return;

    for (const entry of remaining) {
        entry.addEventListener('click', () => select(nav, entry.dataset.section));
    }

    select(nav, remaining[0].dataset.section);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
