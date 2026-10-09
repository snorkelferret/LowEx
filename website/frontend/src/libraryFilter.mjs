// frontend/src/libraryFilter.mjs
//
// WHICH ITEMS A SEARCH IS ASKING FOR.
//
// ============================================================
// WHY .mjs, ALONE AMONG THE FRONTEND'S FILES
// ============================================================
//
// package.json declares "type": "commonjs", because the backend and build.js
// need require(). So a .js file containing `export` is parsed as COMMONJS by
// node — the other modules under frontend/src are only ever loaded by vite,
// which does not care, so it has never mattered.
//
// IT MATTERS HERE. This file is a PURE RULE with no imports, which means node
// can load it directly and the rule can be TESTED BY CALLING IT rather than by
// rendering a page and looking. `.mjs` is what makes that possible, and it is
// the only difference between this file and its neighbours.
//
// Vite resolves .mjs without comment — shared/*.mjs have always been imported
// this way.
//
// ============================================================
// WHY THIS IS ITS OWN FILE
// ============================================================
//
// It was three lines inside render(), and it is the kind of three lines that
// looks obvious and is not. There are TWO filters, they mean different things,
// they combine, and the combining rule is the part a later edit gets wrong.
//
// SO IT IS A PURE FUNCTION, which means it can be tested by calling it. That is
// the entire reason it is not inline: not tidiness, but being able to say what
// it does without rendering a page.
//
// ============================================================
// THE TWO FILTERS ARE NOT THE SAME FILTER
// ============================================================
//
//   * THE SEARCH BOX IS A GUESS AT WHAT SOMEBODY MEANT. It reads the name, the
//     note AND the tags, because a person typing "wales" does not know or care
//     which of those it was filed under.
//
//   * THE TAG FILTER IS WHAT THE ITEM WAS FILED AS. It reads nothing else. A
//     search for "river" matches an item whose NOTE mentions a river; a filter
//     for `river` matches only what somebody tagged river. That difference is
//     the whole value of tagging, so they must not be collapsed into one box.
//
// BOTH APPLY AT ONCE when both are used.
//
// ============================================================
// AND IT IS AND, NOT OR
// ============================================================
//
// Item 54's example is "big trees with river" — the ones that are BOTH. An OR
// would answer a question nobody asked, and it would GROW as tags were added,
// which is the wrong way round for a filter: adding a condition should narrow
// what you are looking at, never widen it.
//
// Tags arrive already normalised — lowercased and trimmed by the edit dialog and
// again by the server — so this compares them as they are rather than
// normalising a third time and having three places that can disagree.

/**
 * The items a search and a tag filter are asking for.
 *
 * @param {Array} items   every item, each with display_name, note and tags
 * @param {Object} opts
 * @param {string} opts.query   the search box, matched loosely against name,
 *                              note and tags
 * @param {Iterable} opts.tags  selected tags, ALL of which must be present
 * @returns {Array} the items to show, in the order they were given
 */
export function filterLibrary(items, { query = '', tags = [] } = {}) {
    const needle = String(query ?? '').trim().toLowerCase();
    const wanted = Array.from(tags ?? []);

    if (!needle && wanted.length === 0) return items;

    return items.filter(item => {
        const itemTags = item.tags || [];

        for (const tag of wanted) {
            if (!itemTags.includes(tag)) return false;
        }

        if (!needle) return true;

        return [item.display_name, item.note, ...itemTags]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(needle);
    });
}
