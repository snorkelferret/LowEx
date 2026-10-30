// shared/dashboards.mjs
//
// WHICH PAGE A ROLE LANDS ON — one definition, because there were three.
//
//   frontend/src/auth.js        the login redirect, with a switch of four cases
//   frontend/src/discussion.js  the board page's Back link, with a map of three
//   scripts/build-manual.js     the manual's Back link, with none at all — "/"
//
// THE DISCUSSION COPY WAS WRONG. It listed admin, developer and user, so a
// production reviewer clicking Back from the board was sent to the TESTER
// page — the one role that is not a developer and has its own dashboard.
//
// THE MANUAL HAD NO MAP, so Back went to "/", the splash, from every role. The
// manual is served by the backend, which knows who is asking, so it uses this
// too: the page is sent with the right target already in it.
//
// A role that is not in the map has no dashboard, and the callers decide what
// that means: the login page says "No match for login", and a Back link falls
// back to the splash.

export const DASHBOARDS = Object.freeze({
    admin: '/adminDashboard.html',
    developer: '/devDashboard.html',
    prod: '/prodDashboard.html',
    user: '/user.html'
});

export function dashboardFor(role) {
    return DASHBOARDS[role] || null;
}
