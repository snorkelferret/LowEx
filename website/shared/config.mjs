// shared/config.mjs
//
// THE ONE PLACE AN ADDRESS OR A PORT IS DEFINED.
//
// ============================================================
// WHY THIS EXISTS
// ============================================================
//
// The portal's own addresses were spread over four files in three languages'
// worth of habits:
//
//   backend/server.js        PORT, BIND, PUBLIC_URL, CLIENT_URL — read here
//   backend/routes/inviteDevs.js  CLIENT_URL AGAIN, with its own default
//   backend/lib/invites.js        a third default, 'http://localhost:5173'
//   vite.config.mjs          VITE_PORT and SERVER_URL, with two more defaults
//
// Five defaults for three values. They agreed by coincidence, and the IPv6
// incident on 2026-10-29 showed what that costs: the backend moved to IPv4
// loopback and the dev proxy kept pointing at "localhost", which resolves to
// ::1 on this machine, and nothing connected. One file would have made the
// mismatch visible before it was a bug.
//
// ============================================================
// HOW IT IS USED
// ============================================================
//
// The caller passes the environment it has — the backend passes process.env,
// Vite passes what loadEnv found — and gets the same answers from the same
// defaults. Nothing else in the application is allowed to name a port or an
// address; scripts/check-config.js enforces that (scripts/ is exempt: a TEST
// MUST KNOW WHAT IT EXPECTS independently of the code it is testing).
//
// NO ADDRESS IS DERIVED FROM ANOTHER, deliberately:
//
//   BIND        where the socket is attached     127.0.0.1
//   PUBLIC_URL  how the world addresses it       https://lowexpectations.zone
//   SERVER_URL  where the DEV PROXY reaches it   http://127.0.0.1:5000
//   CLIENT_URL  the frontend origin (CORS, links, invitations)
//
// They are frequently the same value and they are not the same question, so
// each is read from its own variable. Sharing one "address" setting is how the
// OAuth callback nearly became 127.0.0.1.

export const DEFAULTS = Object.freeze({
    port: 5000,
    bind: '127.0.0.1',
    clientPort: 5173,
    mailFrom: 'Low Expectations <no-reply@lowexpectations.zone>'
});

// A trailing slash on a base URL produces 'https://host//api/...' when joined
// with a path, which some proxies treat as a different route.
const strip = value => String(value).replace(/\/+$/, '');

/**
 * Resolve the portal's addresses from an environment.
 *
 * @param {object} env  a bag of strings — process.env, or Vite's loadEnv
 */
export function resolveConfig(env = process.env) {
    const port = Number(env.PORT || DEFAULTS.port);

    return {
        port,
        bind: env.BIND || DEFAULTS.bind,

        // The address a browser or Google uses. NOT the bind address: in
        // production this is https://lowexpectations.zone while the socket is
        // on 127.0.0.1:5000.
        publicUrl: strip(env.PUBLIC_URL || `http://localhost:${port}`),

        // Where the development frontend proxies /api. 127.0.0.1, not
        // localhost — the backend binds IPv4 loopback and localhost may
        // resolve to ::1 first.
        serverUrl: strip(env.SERVER_URL || `http://127.0.0.1:${port}`),

        // The frontend origin: CORS, the OAuth return, invitation links.
        clientUrl: strip(env.CLIENT_URL || `http://localhost:${DEFAULTS.clientPort}`),

        // The From: address on outgoing mail. It is here because it carries the
        // portal's domain, and a domain hardwired in a second file is the same
        // mistake as a port hardwired in a second file.
        mailFrom: env.MAIL_FROM || DEFAULTS.mailFrom,

        vitePort: Number(env.VITE_PORT || DEFAULTS.clientPort)
    };
}
