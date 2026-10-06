// backend/lib/roles.js
//
// Who may invite whom.
//
// This exists because the invitation endpoints took `assigned_role` straight
// from the request body, gated only by requireAdmin — so ANY ADMIN could mint
// an admin invitation and then redeem it themselves, since the token was
// returned in the response:
//
//     POST /api/auth/create-invite    { email, assigned_role: 'superuser' }
//       -> { inviteToken }
//     POST /api/auth/register-invited { username, password, inviteToken }
//       -> an account with role superuser
//
// Two requests, from the second-highest role to the highest. The rule below
// closes it: you may only ever invite someone BELOW you.

// FOUR ROLES. 'superuser' was removed on 2026-10-06: it had no accounts, no
// routes and no page, and the only thing it still conferred — being above an
// admin, so an admin cannot act on a peer — already holds at the admin level,
// because isStrictlyBelow is strictly below.
//
// 'prod' IS NOT A SENIORITY AND INHERITS NOTHING. Its rank is here for the few
// questions that genuinely are about order — who sorts above whom in a list —
// and NOT as a way to grant it powers. It has no workspace, no admin powers,
// and cannot deactivate or invite anyone. Everything it may do comes from the
// capability map in backend/lib/capabilities.js. See TODO 51 and 52.
const ROLE_RANK = {
    user: 0,
    developer: 1,
    prod: 2,
    admin: 3,
};

// THE ROLES THE WEB INTERFACE MAY GRANT AT ALL.
//
// Admin is NOT here, and its absence is the rule rather than an oversight: it
// cannot be created through the web interface by anybody. They are created on the studio machine, by somebody
// with shell access to it, with scripts/accounts.js.
//
// WHY: it limits PERSISTENCE rather than impact. A stolen superuser session can
// still change settings, deactivate people and read everything — but it cannot
// plant a lasting privileged account, which is the difference between an
// incident you clean up and one you keep finding again.
//
// A REFUSAL, NOT A HIDDEN OPTION. canAssignRole below checks this list, so the
// server refuses the request itself. A rule that lives only in a dropdown is a
// convention, not a control.
//
// The list is deliberately short and explicit rather than derived from
// ROLE_RANK by subtracting the top two: adding a role in future should be a
// decision somebody makes here, not something that happens by arithmetic.
const WEB_ASSIGNABLE_ROLES = ['user', 'developer'];

// The rank comparison itself, named for what it is because two different
// operations need it: inviting someone (you may only create accounts below
// you) and deactivating someone (you may only remove accounts below you).
//
// STRICTLY below, not at your own level. Two consequences worth knowing:
//
//   * NOBODY CAN REMOVE A PEER. An admin cannot deactivate another admin, so
//     the last one standing cannot be locked out by a rival. This is the
//     property 'superuser' used to provide and it did not need a role above
//     admin to exist — which is why that role was removed.
//   * Within the web interface, nobody can create a peer either.
//
// AND ADMIN IS THE TOP. There is nothing above it. A rogue or compromised
// admin is therefore removed on the machine, not from the web — consistent with
// every other privileged act in this system.
function isStrictlyBelow(higherRole, lowerRole) {
    const higher = ROLE_RANK[higherRole];
    const lower = ROLE_RANK[lowerRole];

    if (higher === undefined || lower === undefined) {
        return false;
    }

    return lower < higher;
}

// WHO HAS AUTHORITY OVER WHOM — WHICH IS NOT THE SAME AS WHO SORTS ABOVE WHOM.
//
// 'prod' sits between developer and admin in ROLE_RANK, and that is for ORDERING
// LISTS. It confers nothing. A prod has authority over NOBODY: it cannot invite,
// it cannot deactivate, and it is not above anyone — a rank comparison alone
// would have handed it both, because it is numerically above a developer, and it
// did until this was separated out.
//
// So every question of the form "may A act on B" goes through
// hasAuthorityOver() below, which refuses prod whatever its rank says. ROLE_RANK
// remains for ordering and for "is this at least an admin".
//
// IF ANOTHER CRAFT ROLE IS ADDED, it belongs OUT of this list by default. The
// list is the seniority ladder; a role that is not on it has no power over
// anyone.
const AUTHORITY_ROLES = ['user', 'developer', 'admin'];

/**
 * May `higher` act on `lower` — invite them, deactivate them?
 *
 * Both halves matter: the actor has to be ON the authority ladder at all, and
 * strictly above the target on it. A craft role fails the first test, and a peer
 * fails the second.
 */
function hasAuthorityOver(higherRole, lowerRole) {
    if (!AUTHORITY_ROLES.includes(higherRole)) return false;

    return isStrictlyBelow(higherRole, lowerRole);
}

// "Admin and above" — which, now that superuser is gone, is admin and only
// admin. Kept as a rank comparison rather than `role === 'admin'` so that a
// role inserted above admin later is included by definition rather than by
// somebody remembering to widen this.
function isAdminOrAbove(role) {
    return (ROLE_RANK[role] ?? -1) >= ROLE_RANK.admin;
}

function canAssignRole(inviterRole, targetRole) {
    // A role the web cannot grant is refused whoever is asking, before rank is
    // even considered — see webAssignable() for telling the two refusals apart.
    if (!webAssignable(targetRole)) {
        return false;
    }

    return hasAuthorityOver(inviterRole, targetRole);
}

// May the web interface grant this role at all, whatever the rank of whoever is
// asking? Asked separately from canAssignRole so the refusal can say which of
// the two reasons applies — "only the studio machine can make an admin" and
// "you are not senior enough to make a developer" are different sentences and
// the person reading them needs the right one.
function webAssignable(targetRole) {
    return WEB_ASSIGNABLE_ROLES.includes(targetRole);
}

// Roles the given inviter is allowed to hand out — used to tell the UI which
// options to offer rather than letting someone pick one that will be refused.
function assignableRolesFor(inviterRole) {
    return WEB_ASSIGNABLE_ROLES.filter(role => canAssignRole(inviterRole, role));
}

module.exports = {
    ROLE_RANK,
    WEB_ASSIGNABLE_ROLES,
    AUTHORITY_ROLES,
    hasAuthorityOver,
    canAssignRole,
    webAssignable,
    assignableRolesFor,
    isStrictlyBelow,
    isAdminOrAbove,
};
