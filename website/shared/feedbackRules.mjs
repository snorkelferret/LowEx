// shared/feedbackRules.mjs
//
// The bug-report / feedback rules, in ONE place, used by both sides.
//
//   backend  require()s it   (Node 22 supports require() of an ES module)
//   frontend imports it      (vite resolves the sibling directory)
//
// Same reasoning as shared/assetRules.mjs: the browser validates before sending
// so the reporter gets an answer without a round trip, and the server validates
// again because that is the copy that counts. Two copies of these limits would
// drift, and the drift would be silent — the browser would accept what the
// server refuses, and the reporter would be told their message was fine and
// then watch it be rejected.
//
// WHAT IS NOT HERE: the actor and the timestamp. Those are the two things the
// client is not allowed to state. See backend/routes/feedback.js.

// What kind of report this is.
//
// Three, not ten. The point of the field is to let someone triage a list at a
// glance; past about three options people start guessing, and a wrong label is
// worse than no label because it is confidently wrong. `value` is what is
// stored, `label` is what is shown, so the wording can change without
// rewriting rows.
const FEEDBACK_KINDS = [
    { value: 'bug',   label: 'Something is broken' },
    { value: 'idea',  label: 'An idea or suggestion' },
    { value: 'other', label: 'Something else' },
];

// A report is free text and people paste stack traces into it, so the ceiling
// is generous. The floor is there to catch an empty or accidental submit, not
// to editorialise about what counts as a real report.
const MIN_MESSAGE_LENGTH = 3;
const MAX_MESSAGE_LENGTH = 4000;

// 254 is the RFC 5321 maximum for an email address. An address longer than that
// cannot be delivered to, so accepting it would only store a reply that can
// never be sent.
const MAX_CONTACT_LENGTH = 254;

// Long enough for any real URL, short enough that the column cannot be used as
// free storage. The client supplies this and it is untrusted.
const MAX_PAGE_URL_LENGTH = 500;

// Returns the canonical kind, or null if it is not one of the three.
//
// Unlike the asset category, this one DOES reject: the kind is a closed set
// because the list is what makes the field worth having, and there is an
// explicit 'other' for anything that does not fit. Being strict here costs the
// reporter nothing, since 'other' is always available.
function normaliseKind(value) {
    const wanted = String(value ?? '').trim().toLowerCase();
    if (!wanted) return null;

    return FEEDBACK_KINDS.some(k => k.value === wanted) ? wanted : null;
}

// Truncates rather than rejects. The page URL is context, not content — losing
// the tail of an absurdly long one is better than refusing the whole report
// over it.
function normalisePageUrl(value) {
    return String(value ?? '').trim().slice(0, MAX_PAGE_URL_LENGTH);
}

// Checks a report and returns the cleaned values, or the reasons it was
// refused.
//
// Returns { ok, errors, value } — errors is an object keyed by field so the
// client can point at the offending input rather than dumping one string
// somewhere and hoping.
//
// This validates the SHAPE only. It knows nothing about who is sending it or
// when, which is exactly the boundary: everything this function touches came
// from the browser, and everything it does not touch did not.
function validateFeedback({ kind, message, contact } = {}) {
    const errors = {};

    const cleanKind = normaliseKind(kind);
    if (!cleanKind) errors.kind = 'Choose what kind of report this is.';

    const cleanMessage = String(message ?? '').trim();
    if (cleanMessage.length < MIN_MESSAGE_LENGTH) {
        errors.message = 'Please describe what happened.';
    } else if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
        errors.message =
            `Please keep it under ${MAX_MESSAGE_LENGTH} characters ` +
            `(this one is ${cleanMessage.length}).`;
    }

    // Optional. Only meaningful for a report from someone with no session, who
    // otherwise has no way to be answered — but it is not required even then,
    // because making someone hand over an address to report a login fault is a
    // good way to get no reports.
    const cleanContact = String(contact ?? '').trim().slice(0, MAX_CONTACT_LENGTH);

    return {
        ok: Object.keys(errors).length === 0,
        errors,
        value: {
            kind: cleanKind,
            message: cleanMessage,
            contact: cleanContact || null,
        },
    };
}

export {
    FEEDBACK_KINDS,
    MIN_MESSAGE_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_CONTACT_LENGTH,
    MAX_PAGE_URL_LENGTH,
    normaliseKind,
    normalisePageUrl,
    validateFeedback,
};
