#!/usr/bin/env node
/**
 * Builds the manual into ONE served page.
 *
 *   docs/manual/*.md   ->   backend/generated/manual.html
 *
 * WHY THE OUTPUT IS NOT IN frontend/dist. express.static is mounted on that
 * directory BEFORE any route runs, so anything placed there is fetchable by
 * anyone, whatever guards the route that was supposed to protect it. That is
 * survivable for the dashboards — they are empty shells whose data arrives from
 * authenticated APIs — but a manual's content IS the data, so it cannot live
 * there. It is written under backend/ and served by an authenticated route.
 *
 * ONE FILE, on purpose. The search index is embedded rather than fetched, so
 * there is one artefact to generate, one to serve, and one to protect. A second
 * file would be a second thing to remember to guard.
 *
 *   node scripts/build-manual.js
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, '../docs/manual');
const OUTPUT_DIR = path.join(ROOT, 'backend/generated');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'manual.html');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// A heading becomes an anchor, and the anchor has to be stable: someone will
// link to a section in a message, and the link has to still work after the
// manual is edited. So it is derived from the title, and only the title.
function slugify(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'section';
}

// Strips markup for the search index. Searching should match what the reader
// SEES, not the link syntax around it.
function plainText(markdown) {
    return String(markdown)
        .replace(/```[\s\S]*?```/g, ' ')      // fenced code
        .replace(/`([^`]*)`/g, '$1')          // inline code
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their text
        .replace(/[*_>#|-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Splits one file into a title and sections at every "## " heading.
//
// The split is done HERE rather than by post-processing rendered HTML, because
// the search index and the anchors have to agree: both come from this, so they
// cannot drift apart.
function parseDocument(fileName, source) {
    const lines = source.split('\n');

    const titleLine = lines.findIndex(line => /^#\s+/.test(line));
    const title = titleLine >= 0
        ? lines[titleLine].replace(/^#\s+/, '').trim()
        : fileName.replace(/\.md$/, '');

    const body = titleLine >= 0 ? lines.slice(titleLine + 1) : lines;

    const sections = [];
    let current = null;

    for (const line of body) {
        const heading = /^##\s+(.*)$/.exec(line);

        if (heading) {
            current = { title: heading[1].trim(), markdown: [] };
            sections.push(current);
            continue;
        }

        if (current) current.markdown.push(line);
    }

    // Anything before the first "## " is an introduction to the page.
    const preface = body
        .slice(0, sections.length ? body.findIndex(l => /^##\s+/.test(l)) : body.length)
        .join('\n')
        .trim();

    const slug = slugify(fileName.replace(/^\d+-/, '').replace(/\.md$/, ''));

    return {
        slug,
        title,
        preface,
        sections: sections.map(section => ({
            title: section.title,
            slug: slugify(section.title),
            html: marked.parse(section.markdown.join('\n')),
            text: plainText(section.markdown.join('\n')),
        })),
    };
}

// ---------------------------------------------------------------------------
// Assembling
// ---------------------------------------------------------------------------

function readDocuments() {
    if (!fs.existsSync(SOURCE_DIR)) {
        throw new Error(`No manual source at ${SOURCE_DIR}`);
    }

    // Sorted by filename, so the numeric prefixes decide the running order and
    // there is no separate manifest to keep in step with the directory.
    return fs.readdirSync(SOURCE_DIR)
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(name => parseDocument(
            name,
            fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8')
        ));
}

function renderPage(documents) {
    const nav = documents.map(doc => `
        <div class="manual-nav-page">
          <a class="manual-nav-title" href="#${doc.slug}">${doc.title}</a>
          ${doc.sections.map(section => `
            <a class="manual-nav-section" href="#${doc.slug}--${section.slug}"
               data-nav="${doc.slug}--${section.slug}">
              ${section.title}
            </a>
          `).join('')}
        </div>
    `).join('');

    const content = documents.map(doc => `
        <section class="manual-page" id="${doc.slug}">
          <h1>${doc.title}</h1>
          ${doc.preface ? marked.parse(doc.preface) : ''}
          ${doc.sections.map(section => `
            <section class="manual-section" id="${doc.slug}--${section.slug}">
              <h2>${section.title}</h2>
              ${section.html}
            </section>
          `).join('')}
        </section>
    `).join('');

    // What the browser searches. Titles are indexed as well as body text, so a
    // section can be found by its heading alone.
    const index = documents.flatMap(doc =>
        doc.sections.map(section => ({
            id: `${doc.slug}--${section.slug}`,
            page: doc.title,
            title: section.title,
            text: section.text,
        }))
    );

    return `<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Studio in a Box — Manual</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
  <link rel="stylesheet" href="/styles/styles.css">
  <style>
    .manual-layout { display: grid; grid-template-columns: 18rem 1fr; gap: 2rem; align-items: start; }
    @media (max-width: 900px) { .manual-layout { grid-template-columns: 1fr; } .manual-nav { position: static !important; } }
    .manual-nav { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow-y: auto; }
    .manual-nav-page { margin-bottom: .75rem; }
    .manual-nav-title { display: block; font-weight: 600; color: inherit; text-decoration: none; }
    .manual-nav-title:hover { color: var(--bs-info); }
    .manual-nav-section { display: block; padding-left: .75rem; font-size: .875rem;
                          color: var(--bs-secondary-color); text-decoration: none; }
    .manual-nav-section:hover, .manual-nav-section.active { color: var(--bs-info); }
    .manual-page { padding-bottom: 3rem; }
    .manual-page > h1 { margin-bottom: 1.5rem; }
    .manual-section { padding-top: .5rem; margin-bottom: 1.5rem; }
    .manual-section h2 { padding-top: 1rem; }
    .manual-section table { margin-bottom: 1rem; }
    .manual-section pre { background: rgba(0,0,0,.4); padding: .75rem 1rem; border-radius: .25rem; overflow-x: auto; }
    .manual-section code { color: var(--bs-info); }
    .manual-section pre code { color: inherit; }
    #manual-search-results { max-height: 22rem; overflow-y: auto; }
    mark { padding: 0 .1rem; }
  </style>
</head>
<body class="bg-dark text-light min-vh-100">
  <div class="dashboard-container">

    <div class="d-flex justify-content-between align-items-center mb-4">
      <h1 class="h3 mb-0">Studio in a Box — Manual</h1>
      <!-- The Back target IS FILLED BY THE ROUTE, not here: only the server
           knows which role is asking, and Back must go to THAT role's
           dashboard. It went to "/" (the splash) from every role until
           2026-10-30. See shared/dashboards.mjs. -->
      <a href="{{BACK_HREF}}" class="btn btn-sm btn-outline-secondary">
        <i class="bi bi-arrow-left me-1"></i>Back
      </a>
    </div>

    <div class="mb-4 position-relative">
      <input type="search" id="manual-search" class="form-control"
             placeholder="Search the manual…" autocomplete="off"
             aria-label="Search the manual">
      <div id="manual-search-results" class="list-group position-absolute w-100 d-none shadow"
           style="z-index: 10;"></div>
    </div>

    <div class="manual-layout">
      <nav class="manual-nav" id="manual-nav">${nav}</nav>
      <main id="manual-content">${content}</main>
    </div>

  </div>

  <script>
    const INDEX = ${JSON.stringify(index)};

    const searchBox = document.getElementById('manual-search');
    const results = document.getElementById('manual-search-results');
    const navLinks = document.querySelectorAll('[data-nav]');

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Highlights the matched words in the snippet. Everything is escaped FIRST,
    // then the match is wrapped — the other order would let manual text inject
    // markup into the results list.
    function snippet(text, query) {
      const at = text.toLowerCase().indexOf(query);
      if (at < 0) return escapeHtml(text.slice(0, 140)) + '…';

      const from = Math.max(0, at - 50);
      const before = escapeHtml((from > 0 ? '…' : '') + text.slice(from, at));
      const match = escapeHtml(text.slice(at, at + query.length));
      const after = escapeHtml(text.slice(at + query.length, at + query.length + 90)) + '…';

      return before + '<mark>' + match + '</mark>' + after;
    }

    function render(query) {
      const q = query.trim().toLowerCase();

      if (q.length < 2) {
        results.classList.add('d-none');
        results.innerHTML = '';
        return;
      }

      const hits = INDEX.filter(entry =>
        entry.title.toLowerCase().includes(q) || entry.text.toLowerCase().includes(q)
      ).slice(0, 20);

      results.classList.remove('d-none');

      if (hits.length === 0) {
        results.innerHTML =
          '<div class="list-group-item bg-dark text-secondary">Nothing found.</div>';
        return;
      }

      results.innerHTML = hits.map(entry => \`
        <a class="list-group-item list-group-item-action bg-dark text-light border-secondary"
           href="#\${entry.id}" data-goto="\${entry.id}">
          <div class="d-flex justify-content-between">
            <strong>\${escapeHtml(entry.title)}</strong>
            <span class="text-secondary small">\${escapeHtml(entry.page)}</span>
          </div>
          <div class="small text-secondary">\${snippet(entry.text, q)}</div>
        </a>
      \`).join('');
    }

    searchBox.addEventListener('input', () => render(searchBox.value));

    // Close on click-away and on Escape — a results list that stays open over
    // the page it is meant to help you read is worse than no search.
    document.addEventListener('click', (event) => {
      if (!results.contains(event.target) && event.target !== searchBox) {
        results.classList.add('d-none');
      }
    });

    searchBox.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { results.classList.add('d-none'); searchBox.blur(); }
      if (event.key === 'Enter') {
        const first = results.querySelector('[data-goto]');
        if (first) { window.location.hash = first.dataset.goto; results.classList.add('d-none'); }
      }
    });

    results.addEventListener('click', (event) => {
      if (event.target.closest('[data-goto]')) results.classList.add('d-none');
    });

    // Highlight the section you are reading in the sidebar.
    const sections = [...document.querySelectorAll('.manual-section')];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        navLinks.forEach(link => link.classList.toggle(
          'active', link.dataset.nav === entry.target.id
        ));
      }
    }, { rootMargin: '-10% 0px -70% 0px' });

    sections.forEach(section => observer.observe(section));
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------

function main() {
    const documents = readDocuments();

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, renderPage(documents), 'utf8');

    const sections = documents.reduce((n, doc) => n + doc.sections.length, 0);

    console.log(`📖 Manual: ${documents.length} page(s), ${sections} section(s)`);
    documents.forEach(doc =>
        console.log(`     ${doc.title} — ${doc.sections.length} section(s)`));
    console.log(`   -> ${path.relative(ROOT, OUTPUT_FILE)}`);
}

main();
