// backend/lib/capabilities.js
//
// NAMED CAPABILITIES — the roles that may do one thing, named in one place.
//
// ============================================================
// WHY NOT JUST WRITE THE ROLES ON EACH ROUTE
// ============================================================
//
// requireRole checks a list literally, never a rank, and that is deliberate
// (middleware/auth.js). The cost is that a capability spread over several
// routes is written several times, and the next route somebody adds is gated by
// habit rather than by the decision. Item 83 put it plainly: the answer wants to
// be a named capability rather than 'prod' added by hand to one list after
// another.
//
// ============================================================
// CONTENT_READERS — WHO MAY READ THE STUDIO'S CONTENT
// ============================================================
//
// THE STORE AND THE LIBRARY, READ ONLY. Production decides what is good enough
// for the game; reviewing is reading, and the person deciding on a submission is
// the person most likely to want to compare it against what is already there
// (item 83).
//
// WHAT IT DOES NOT GRANT:
//
//   * IMPORT — that writes repository ids onto a WORKSPACE asset, and prod has
//     no workspace. It stays developer/admin.
//   * anything in the library that writes: upload, update, remove.
//   * approving, integrating, administering. Those keep their own routes.
//
// The reads include the archive endpoint (a POST only because the hash list
// does not fit in a URL) and the record-of-a-read endpoint, because refusing
// prod the one route the download negotiation uses would grant "may read" and
// withhold reading.

const CONTENT_READERS = Object.freeze(['developer', 'prod', 'admin']);

module.exports = { CONTENT_READERS };
