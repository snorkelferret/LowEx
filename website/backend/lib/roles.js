// backend/lib/roles.js
//
// Who may invite whom.
//
// This exists because the invitation endpoints took `assigned_role` straight
// from the request body, gated only by requireAdmin — so ANY ADMIN could mint
// a superuser invitation and then redeem it themselves, since the token was
// returned in the response:
//
//     POST /api/auth/create-invite    { email, assigned_role: 'superuser' }
//       -> { inviteToken }
//     POST /api/auth/register-invited { username, password, inviteToken }
//       -> an account with role superuser
//
// Two requests, from the second-highest role to the highest. The rule below
// closes it: you may only ever invite someone BELOW you.

const ROLE_RANK = {
    user: 0,
    developer: 1,
    admin: 2,
    superuser: 3,
};

// Every role the users table permits. Kept in step with the CHECK in db.js.
const ASSIGNABLE_ROLES = Object.keys(ROLE_RANK);

// The rank comparison itself, named for what it is because two different
// operations need it: inviting someone (you may only create accounts below
// you) and deactivating someone (you may only remove accounts below you).
//
// STRICTLY below, not at your own level. Two consequences worth knowing:
//
//   * There can only ever be one superuser, and no backup exists. The initial
//     one is seeded by db.js when the users table is empty, so the system
//     cannot be left with none — but it also cannot be left with two.
//   * Nobody can remove a peer. A superuser cannot deactivate another
//     superuser, so the last one standing cannot be locked out by a rival.
function isStrictlyBelow(higherRole, lowerRole) {
    const higher = ROLE_RANK[higherRole];
    const lower = ROLE_RANK[lowerRole];

    if (higher === undefined || lower === undefined) {
        return false;
    }

    return lower < higher;
}

// `user` is the tester: a login with no extra privileges. It is invitable
// because that is how a tester is created.
function canAssignRole(inviterRole, targetRole) {
    if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, targetRole)) {
        return false;
    }

    return isStrictlyBelow(inviterRole, targetRole);
}

// Roles the given inviter is allowed to hand out — used to tell the UI which
// options to offer rather than letting someone pick one that will be refused.
function assignableRolesFor(inviterRole) {
    return ASSIGNABLE_ROLES.filter(role => canAssignRole(inviterRole, role));
}

module.exports = {
    ROLE_RANK,
    ASSIGNABLE_ROLES,
    canAssignRole,
    assignableRolesFor,
    isStrictlyBelow,
};
