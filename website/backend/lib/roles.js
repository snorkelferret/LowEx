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

// THE ROLES THE WEB INTERFACE MAY GRANT AT ALL.
//
// Admin and superuser are NOT here, and their absence is the rule rather than
// an oversight: they cannot be created through the web interface by anybody,
// including a superuser. They are created on the studio machine, by somebody
// with shell access to it, with scripts/create-superuser.js.
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
//   * Nobody can remove a peer. A superuser cannot deactivate another
//     superuser, so the last one standing cannot be locked out by a rival.
//   * Within the web interface, nobody can create a peer either — which is what
//     makes a superuser unable to invite another one.
//
// IT NO LONGER MEANS THERE IS ONLY EVER ONE SUPERUSER. It used to: the rank
// rule was the only way to make one, so the single account db.js seeded could
// never be joined. Now that the seed is gone and scripts/create-superuser.js is
// the way in, a second superuser can be created deliberately on the machine.
// That is better for recovery — the old arrangement had no backup at all — and
// it is a change to a property that used to be guaranteed.
function isStrictlyBelow(higherRole, lowerRole) {
    const higher = ROLE_RANK[higherRole];
    const lower = ROLE_RANK[lowerRole];

    if (higher === undefined || lower === undefined) {
        return false;
    }

    return lower < higher;
}

// "Admin and above" — the people an alert goes to.
//
// Named rather than written as `role === 'admin' || role === 'superuser'` at
// each call site. Comparing ranks means a role inserted between admin and
// superuser later is included by definition rather than by somebody
// remembering to add it.
function isAdminOrAbove(role) {
    return (ROLE_RANK[role] ?? -1) >= ROLE_RANK.admin;
}

function canAssignRole(inviterRole, targetRole) {
    // A role the web cannot grant is refused whoever is asking, before rank is
    // even considered. "You are not senior enough" would be the wrong
    // explanation for a superuser asking for admin — see webAssignable() for
    // telling the two refusals apart.
    if (!webAssignable(targetRole)) {
        return false;
    }

    return isStrictlyBelow(inviterRole, targetRole);
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
    canAssignRole,
    webAssignable,
    assignableRolesFor,
    isStrictlyBelow,
    isAdminOrAbove,
};
