// frontend/src/utilityBar.js
//
// The utility bar: a small panel of always-available tools, inline with the
// page heading.
//
// WHAT IT REPLACED, and why neither worked.
//
//   * The manual was a floating glyph fixed to the bottom-left. Fixed means it
//     sits over whatever the page puts there — which is what happened, over
//     the empty-workspace message — and a lone icon in a corner reads as
//     decoration rather than as a control.
//
//   * The bin was a tab. A tab is somewhere you go and STAY; the bin is
//     something you open, deal with, and close. As a tab it also had the same
//     standing as Upload and History, which it does not have.
//
// Both are tools rather than places, so they belong in a bar together, and the
// bar has room for the next one.
//
// THE PLACEHOLDER IS MARKUP, THE CONTENTS ARE NOT. build.js concatenates
// components and cannot nest them, so a bar written as markup would have to be
// duplicated in every file that hosts one. A host file carries
// `<div class="utility-bar" data-utility-bar></div>` and nothing else; what
// goes in it is built here, once.
//
// ONE BAR PER PAGE. The superuser dashboard carries both adminPanel and
// developerPanel, so both render a placeholder. The first is kept — it is the
// one at the top — and the rest are removed. They are marked with a DATA
// attribute rather than an id precisely so the markup is not invalid before
// this runs.

const BAR_SELECTOR = '[data-utility-bar]';

let resolved = null;

// The bar for this page, resolving it once. Returns null on a page that has
// none, so every caller can simply do nothing.
function bar() {
    if (resolved && document.contains(resolved)) return resolved;

    const bars = [...document.querySelectorAll(BAR_SELECTOR)];
    if (bars.length === 0) return null;

    const [first, ...duplicates] = bars;
    duplicates.forEach(element => element.remove());

    first.id = 'utilityBar';
    resolved = first;

    return resolved;
}

/**
 * Put a control in the utility bar.
 *
 * @param element  a ready-made <a> or <button>. Built by the caller because
 *                 the bar has no business knowing what a "bin" is, and the
 *                 caller usually needs the element back to update it — a
 *                 count, a disabled state.
 *
 * @returns the element, or null if this page has no utility bar.
 */
export function addUtility(element) {
    const host = bar();
    if (!host) return null;

    element.classList.add('utility-item');
    host.appendChild(element);

    return element;
}

// Builds the manual link. It is here rather than in a page because it is the
// one tool that appears on EVERY page with a bar, whatever the role.
function manualItem() {
    const link = document.createElement('a');

    link.href = '/app/manual';
    link.title = 'Read the manual';
    link.innerHTML =
        '<i class="bi bi-book"></i><span class="utility-label">Manual</span>';

    return link;
}

function init() {
    const host = bar();
    if (!host) return;

    // PREPENDED rather than appended, so the order does not depend on which
    // script happens to run first. The bin is registered by developerWorkspace,
    // which is listed before this file, so an append would put the bin first —
    // and would silently swap the two the day that list is reordered.
    const link = manualItem();
    link.classList.add('utility-item');
    host.prepend(link);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
