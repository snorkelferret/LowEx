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
// ONE BAR PER PAGE, and exactly one placeholder is expected today — but the
// FIRST is kept and any others removed, because a spare placeholder left in a
// component does not fail loudly: it renders as a small empty box with a border
// around it, which looks like a broken control rather than a mistake.
//
// Marked with a DATA attribute rather than an id precisely so that a page
// carrying two is not invalid HTML before this runs.

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

// THE TOOLS EVERY SIGNED-IN PAGE HAS, whatever the role. They live here rather
// than in a page because there is no component they belong to — the bar's
// contents are built once, here, and a page only supplies the empty container.
//
// ON THE BOARD LINK. It was removed from the sign-in form and the invitation
// page, which are seen only by people who are not signed in — but that left
// nothing anywhere, and a board nobody can reach is not private, it is
// missing. This is the right home for it: a page you are already signed in to.
//
// The address is deliberately NOT listed here as a fact about the board. The
// page it opens says whether the board is configured, and it is the page's job
// to say that rather than this one's to imply it.
//
// THE ORDER HERE IS THE ORDER ON SCREEN — the whole block is prepended, so a
// page's own items (the bin) always follow, whatever order the scripts run in.
const UNIVERSAL_ITEMS = [
    {
        href: '/app/manual',
        icon: 'bi-book',
        label: 'Manual',
        title: 'Read the manual',
    },
    {
        href: '/discussion.html',
        icon: 'bi-chat-square-text',
        label: 'Discussion',
        title: 'The team board',
    },
];

function linkItem({ href, icon, label, title }) {
    const link = document.createElement('a');

    link.href = href;
    link.title = title;
    link.className = 'utility-item';
    link.innerHTML =
        `<i class="bi ${icon}"></i><span class="utility-label">${label}</span>`;

    return link;
}

function init() {
    const host = bar();
    if (!host) return;

    // Prepended as one block rather than one item at a time, so the order is
    // this list and not the reverse of it.
    const block = document.createDocumentFragment();
    for (const item of UNIVERSAL_ITEMS) block.appendChild(linkItem(item));

    host.prepend(block);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
