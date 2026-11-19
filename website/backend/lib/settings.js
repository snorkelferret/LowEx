// backend/lib/settings.js
//
// The values an administrator can change from the admin page.
//
// ============================================================
// WHY THIS EXISTS AT ALL
// ============================================================
//
// These were compile-time constants. Changing one meant editing a file,
// redeploying, and restarting — and the invites panel printed the invite window
// as a hardcoded string in HTML, so the number on screen and the number the
// server used were two copies that agreed by luck.
//
// A setting is worth the machinery only when it has to be CHANGEABLE WHILE THE
// SERVER IS RUNNING. That is the whole design constraint, and it decides
// everything below.
//
// ============================================================
// THE ONE RULE: READ IT, DO NOT REMEMBER IT
// ============================================================
//
// NOTHING HERE CACHES. Every getSetting() is a database read.
//
// This is not an oversight and it is not worth optimising. A cached value is
// the exact failure this module exists to prevent: the admin saves a new
// window, the page says "saved", and nothing changes until the next restart.
// That silent no-op is how people stop trusting a settings page — and it is
// invisible, because the save really did succeed.
//
// The cost of doing it correctly is a point lookup on SQLite, which is
// microseconds, against operations that write files to disk.
//
// THE SAME TRAP APPLIES TO CALLERS, and it is sneakier. This is CommonJS, so
//
//     const { INVITE_VALID_DAYS } = require('../lib/invites');
//
// copies the value ONCE, at require time. Reading a getter at module scope and
// storing the result has the same problem. Call the function where the value is
// used, every time.
//
// ============================================================
// A MISSING ROW MEANS "NOT OVERRIDDEN"
// ============================================================
//
// The default lives here, in code, not in a seeded row. So a fresh database
// needs no seeding, a setting cannot be broken by deleting a row, and the
// admin page can show what a value would fall back to before anyone touches
// it.

const db = require('./../db');
const audit = require('./audit');

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------
//
// ONE ENTRY PER SETTING, and every one of them is required. A key that exists
// in the database but not here cannot be read (there is no type or default to
// interpret it with) and cannot be written (there is no bound to check it
// against), so the registry is the list — adding a setting is adding a line
// here, not a migration.

const DEFINITIONS = {
    invite_valid_days: {
        type: 'integer',
        default: 28,
        min: 1,
        max: 365,
        label: 'Invitation validity',
        unit: 'days',
        // Existing invitations keep the expiry they were issued with — the
        // deadline is stored per row, not recomputed. Said here because it is
        // the first thing an administrator expects to be untrue.
        note: 'Applies to invitations sent from now on. Ones already sent keep ' +
              'the date they were issued with.',
    },

    retention_days: {
        type: 'integer',
        default: 14,
        min: 1,
        max: 365,
        label: 'Wastebin retention',
        unit: 'days',
        // The opposite of the above, and worth the warning: this window is
        // derived from deleted_at every time it is read, so shortening it
        // brings things already in a bin to their deadline at once.
        note: 'How long a deleted asset can be restored. Shortening this ' +
              'affects items already in a wastebin — anything that has now ' +
              'been in longer than the new window becomes due for purge.',
    },

    workspace_limit_gb: {
        type: 'integer',
        default: 5,
        min: 1,
        max: 10000,
        label: 'Developer storage allowance',
        unit: 'GB',
        // GIGABYTES HERE, BYTES UNDERNEATH. The figure is stated in GB because
        // that is the unit a person thinks in and the one they would type; the
        // conversion to bytes happens in exactly one place
        // (backend/lib/workspaceUsage.js), so there is no second spot that
        // could use a different definition of GB.
        note: 'How much each developer’s workspace may hold. Only content ' +
              'they are staging counts — the shared game store is not deducted ' +
              'from anyone.',
    },

    // WHEN A BUILD IS TOO BIG OR TOO SLOW, FOR THE REVIEWER. 0 means no
    // limit. These are advice, not gates: a build over either is marked on the
    // builds page, and production decides what to do about it (TODO 113).
    //
    // GB AND MINUTES, BYTES AND SECONDS UNDERNEATH, for the same reason as
    // the workspace allowance: the person types the unit they think in, and
    // the conversion happens in one place (backend/routes/builds.js).
    build_max_gb: {
        type: 'integer',
        // 50 GB IS A CEILING FOR A MID-SIZE OPEN WORLD, not the target. A
        // healthy packaged build of that shape is 20–35 GB; 50 gives headroom
        // for growth while still catching the accidental double or triple —
        // uncooked content, a duplicated pak, symbols left in the package.
        // Adjust it after the first few real builds; those say more than a
        // guessed figure.
        default: 50,
        min: 0,
        max: 10000,
        label: 'Maximum build size',
        unit: 'GB',
        note: 'A build larger than this is marked for the reviewer on the builds ' +
              'page. 0 means no limit. It is a warning, not a refusal.',
    },

    build_max_minutes: {
        type: 'integer',
        // A full cook and package of a mid-size open world is commonly 30–90
        // minutes; 90 flags a runaway cook without flagging a slow machine.
        default: 90,
        min: 0,
        max: 1440,
        label: 'Maximum build time',
        unit: 'minutes',
        note: 'A build that takes longer than this is marked for the reviewer. ' +
              '0 means no limit. Build duration is not runtime speed — how long ' +
              'the level takes to load is a test result, not this.',
    },

    // WHICH PERFORCE ACCOUNT THE TOOL RUNS AS. Val's own account to begin
    // with; a dedicated process account when a seat is bought, and neither the
    // tool nor the portal changes — this value does.
    //
    // THE PORTAL CANNOT CHECK IT. It never talks to Perforce, so an account
    // named here may not exist; the tool learns that when p4 refuses. The
    // receipt records the account it actually used, which is the check that
    // matters.
    integration_p4_user: {
        type: 'string',
        default: '',
        max_length: 64,
        pattern: /^[A-Za-z0-9._-]*$/,
        patternMessage: 'use letters, digits, dots, dashes or underscores',
        label: 'Integration account',
        note: 'The Perforce user the integration tool runs as. Empty means ' +
              'not configured, and the tool should refuse to record ' +
              'anything. The portal cannot check that the account exists. ' +
              'Each change is audited.',
    },

    integration_tooling: {
        type: 'boolean',
        default: false,
        label: 'Integration tooling',
        // THE EXCEPTION, WITH A DATE AND A NAME. Unreal is off limits by
        // standing rule (RULES 2); this switch is the portal's side of the
        // only exception — whether it will accept an integration recorded by
        // the editor tool rather than typed in by hand.
        //
        // IT IS NOT "THE PORTAL CAN SEE PERFORCE": it decides whether a
        // receipt is accepted, and nothing else. Off by default, so a fresh
        // install is closed, and every change is audited by the settings
        // machinery like any other.
        note: 'Whether the portal accepts an integration recorded by the ' +
              'Unreal tool rather than typed in by hand. Off unless ' +
              'deliberately opened, and each change is recorded. It does not ' +
              'let the portal see Perforce — the tool sends a receipt.',
    },

    session_hours: {
        type: 'integer',
        default: 2,
        min: 1,
        max: 24,
        label: 'Session lifetime',
        unit: 'hours',
        // IT APPLIES TO THE NEXT SIGN-IN. An existing session keeps the expiry
        // it was issued with, because the deadline is inside the token — the
        // same property as the invitation window above, and the first thing
        // anybody expects to be untrue.
        note: 'How long a sign-in lasts before the portal asks you to sign in ' +
              'again. Applies from the next sign-in; sessions already running ' +
              'keep the expiry they were issued with.',
    },

    usage_warning_percent: {
        type: 'integer',
        default: 85,
        min: 1,
        max: 99,
        label: 'Warning level',
        unit: '%',
        note: 'Disks, file tables and developer quotas are marked as filling ' +
              'up at this percentage.',
    },

    usage_critical_percent: {
        type: 'integer',
        default: 95,
        min: 2,
        max: 100,
        label: 'Critical level',
        unit: '%',
        note: 'Behind the warning level, and must stay above it.',
    },
};

// Settings whose values constrain each other.
//
// Two independent keys with a relationship between them is how a system ends
// up with a warning level of 95 and a critical level of 85 — a band in which
// everything is critical, which reads on screen as "nothing is ever a warning"
// and is not obviously wrong until somebody looks.
//
// Checked on write, against the other key's CURRENT value, so the pair cannot
// be put into that state by either route: setting critical below warning is
// refused, and setting warning above critical is refused.
// THE REFUSAL NAMES THE FIELD THE CALLER ACTUALLY CHANGED, and says what the
// other one is. One shared sentence — "the critical level must be above the
// warning level" — is true whichever way it is approached, and useless when it
// appears beside a field labelled Warning: the reader has to work out that the
// complaint is about a value they are not editing.
const RELATIONS = [
    {
        lower: 'usage_warning_percent',
        higher: 'usage_critical_percent',
        // Shown when the LOWER key is being set too high.
        lowerMessage: (other) =>
            `The warning level must stay below the critical level, which is ${other}.`,
        // Shown when the HIGHER key is being set too low.
        higherMessage: (other) =>
            `The critical level must stay above the warning level, which is ${other}.`,
    },
];

// Fails at require time rather than at the first request, like a missing
// translation would. A relation naming a key that does not exist is a bug in
// this file, and finding it now is cheaper than finding it in the admin page.
for (const relation of RELATIONS) {
    for (const side of ['lower', 'higher']) {
        if (!DEFINITIONS[relation[side]]) {
            throw new Error(
                `settings: relation names unknown key "${relation[side]}"`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const selectOne = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const selectAll = db.prepare('SELECT key, value FROM app_settings');

/**
 * The definition for a key, or throw.
 *
 * A key with no definition is a programming error — a typo, or a caller left
 * behind by a removed setting — and it is better to fail loudly here than to
 * return undefined and have it compared against a number somewhere else.
 */
function definitionOf(key) {
    const definition = DEFINITIONS[key];

    if (!definition) {
        throw new Error(`settings: unknown key "${key}"`);
    }

    return definition;
}

/**
 * A stored or default value, coerced to its declared type.
 *
 * AN UNPARSEABLE STORED VALUE FALLS BACK TO THE DEFAULT rather than throwing.
 * The database is not editable by hand in normal operation, but a value that
 * cannot be read is not a reason to stop serving requests — and the default is
 * by definition safe. It would take deliberate damage to reach this branch.
 */
function coerce(definition, raw) {
    if (definition.type === 'string') {
        if (raw === null || raw === undefined) return null;

        return String(raw).trim();
    }

    if (definition.type === 'boolean') {
        const text = String(raw ?? '').trim().toLowerCase();

        if (['1', 'true', 'on', 'yes'].includes(text)) return true;
        if (['0', 'false', 'off', 'no', ''].includes(text)) return false;

        return null;
    }

    if (definition.type === 'integer') {
        const value = Number(raw);

        if (!Number.isFinite(value) || !Number.isInteger(value)) return null;

        return value;
    }

    return raw === null || raw === undefined ? null : String(raw);
}

function readKey(key) {
    const definition = definitionOf(key);

    let row;

    try {
        row = selectOne.get(key);
    } catch {
        // The table is missing, which means this database predates the
        // settings table and db.js has not run against it yet. The defaults
        // are correct for that state.
        row = undefined;
    }

    if (!row) {
        return { value: definition.default, is_default: true };
    }

    const value = coerce(definition, row.value);

    if (value === null) {
        return { value: definition.default, is_default: true };
    }

    return { value, is_default: false };
}

/**
 * The value of one setting. THE ONLY WAY TO READ ONE.
 *
 * Hits the database every call. See the header — do not store the result.
 */
function getSetting(key) {
    return readKey(key).value;
}

/**
 * Every setting, for the admin page: the value in force, what it would fall
 * back to, what it may be set to, and the note to show beside it.
 */
function getSettings() {
    return Object.entries(DEFINITIONS).map(([key, definition]) => {
        const { value, is_default } = readKey(key);

        return {
            key,
            type: definition.type || 'integer',
            value,
            is_default,
            default: definition.default,
            min: definition.min,
            max: definition.max,
            unit: definition.unit,
            label: definition.label,
            note: definition.note || null,
            // True when a row exists, so the page can offer "reset to default"
            // only where there is something to reset.
            overridden: !is_default,
        };
    });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = excluded.updated_by
`);

const remove = db.prepare('DELETE FROM app_settings WHERE key = ?');

/**
 * Check a proposed value against its bounds and the relations.
 *
 * THROWS A MESSAGE A PERSON CAN READ, because the only caller is an HTTP route
 * that puts it straight on screen. "Invalid" would be worse than useless there.
 */
function validate(key, raw) {
    const definition = definitionOf(key);
    const value = coerce(definition, raw);

    // A STRING HAS A SHAPE RATHER THAN BOUNDS. Empty is allowed where the
    // definition permits it — "not configured" is a state, not an error.
    if (definition.type === 'string') {
        if (value === null) {
            throw new Error(`${definition.label} must be text.`);
        }

        if (definition.max_length && value.length > definition.max_length) {
            throw new Error(
                `${definition.label} must be ${definition.max_length} characters or fewer.`
            );
        }

        if (definition.pattern && !definition.pattern.test(value)) {
            throw new Error(
                `${definition.label} may ${definition.patternMessage || 'contain only letters, digits and punctuation'}.`
            );
        }

        return value;
    }

    // A BOOLEAN HAS NO BOUNDS. It is on or off, and there is no pair of values
    // for it to stay in order with.
    if (definition.type === 'boolean') {
        if (value === null) {
            throw new Error(`${definition.label} must be on or off.`);
        }

        return value;
    }

    if (value === null) {
        throw new Error(
            `${definition.label} must be a whole number.`
        );
    }

    if (value < definition.min || value > definition.max) {
        throw new Error(
            `${definition.label} must be between ${definition.min} and ` +
            `${definition.max} ${definition.unit}.`
        );
    }

    // Checked against the other key's current value, so the pair cannot be
    // left in a state where the critical band is below the warning band.
    for (const relation of RELATIONS) {
        if (key !== relation.lower && key !== relation.higher) continue;

        const otherKey = key === relation.lower
            ? relation.higher
            : relation.lower;

        const other = getSetting(otherKey);
        const isLower = key === relation.lower;

        // Equal is refused as well as inverted: a warning level of 85 with a
        // critical level of 85 means the warning band is empty, so every
        // measurement is either fine or critical and nothing is ever warned
        // about in time.
        const broken = isLower ? value >= other : value <= other;

        if (broken) {
            throw new Error(
                isLower ? relation.lowerMessage(other) : relation.higherMessage(other)
            );
        }
    }

    return value;
}

/**
 * Set a value, and record who did it.
 *
 * THE WRITE AND THE AUDIT ARE ONE TRANSACTION. A change to the invite window or
 * the retention period is a change to the rules everyone else is being held to,
 * so "who moved this, and when" is part of the change rather than a note about
 * it — the same reasoning as every other audited action in this system.
 */
function setSetting(key, raw, actorId) {
    definitionOf(key);

    const value = validate(key, raw);
    const previous = getSetting(key);

    const apply = db.transaction(() => {
        upsert.run(key, String(value), actorId ?? null);

        audit.record(actorId, 'settings.update', key, {
            from: previous,
            to: value,
        });
    });

    apply();

    return { key, value, previous };
}

/**
 * Put a setting back to its default by removing the row, so there is one place
 * the default can come from.
 *
 * Audited, and recorded as a change like any other: "reset to default" is a
 * decision somebody made, and the trail should read the same way whether the
 * value moved to 3 or back to 28.
 */
function resetSetting(key, actorId) {
    definitionOf(key);

    const previous = readKey(key);

    if (previous.is_default) {
        return { key, value: previous.value, previous: previous.value, changed: false };
    }

    const apply = db.transaction(() => {
        remove.run(key);

        audit.record(actorId, 'settings.reset', key, {
            from: previous.value,
            to: definitionOf(key).default,
        });
    });

    apply();

    return {
        key,
        value: definitionOf(key).default,
        previous: previous.value,
        changed: true,
    };
}

module.exports = {
    DEFINITIONS,
    getSetting,
    getSettings,
    setSetting,
    resetSetting,
};
