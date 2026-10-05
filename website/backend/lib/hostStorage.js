// backend/lib/hostStorage.js
//
// What the DISK is doing, as opposed to what a developer is charged.
//
// A LIBRARY BECAUSE THE QUESTION IS ASKED IN MORE THAN ONE PLACE. The admin
// Storage tab answers it now; the Health tab will answer it too, along with
// memory and CPU. Two places calling statfs and each doing their own arithmetic
// is exactly the divergence that ends with one screen saying 4% free and the
// other saying 12%, so the reading and the thresholds live here and both call
// this.
//
// ============================================================
// WHY THIS IS NOT backend/lib/workspaceUsage.js
// ============================================================
//
// They are different questions and their answers do not reconcile, which is why
// they must not be added together or subtracted from each other on a screen:
//
//   * workspaceUsage says what each developer is CHARGED. It excludes the game
//     store, counts a shared blob once per workspace that holds it, and ignores
//     soft-deleted rows.
//
//   * This says what the HARDWARE holds. Every blob once, whether anybody is
//     charged for it or not.
//
// So "developers are using 2 GB" and "the disk is using 300 GB" are both true
// at once, and the difference is the game store plus everything the GC has not
// reached yet. The Storage tab prints both figures side by side and says so,
// because an administrator who assumes one should equal the other will report
// the accounting as broken.

const fs = require('fs');

// The banding. shared/, so the disk and a developer's quota cannot disagree
// about what "nearly full" means — but the LEVELS are an admin setting, so they
// are read here per call and passed in. shared/ must stay free of the database:
// the frontend may import it.
const { usageStatus, worstStatus } = require('../../shared/usageStatus.mjs');
const settings = require('./settings');

// The flat content-addressed blob directory — where the bytes actually land,
// and therefore the thing to statfs. The repository directory itself may be on
// a different filesystem from the uploads mount, and it is the uploads mount
// that fills up. The path is defined in storagePaths.js, not here: this module
// measures it, it does not own it, and five other callers need the same answer.
const { BLOB_DIR } = require('./storagePaths');

// Used, not merely allocated: bfree counts blocks the filesystem keeps in
// reserve for root, which a non-root process cannot have. bavail is what is
// actually available, so it is the honest figure — reporting bfree would
// overstate the room left by the reserve size, which on ext4 is 5%.
function hostStorage(dir = BLOB_DIR) {
    let stats;

    try {
        stats = fs.statfsSync(dir);
    } catch (err) {
        // The path may not exist yet — nothing has been uploaded, so the blob
        // directory was never created. That is not an error worth failing the
        // whole tab over, but it is worth saying rather than reporting zeros
        // that look like a full disk.
        return {
            path: dir,
            readable: false,
            error: err.code === 'ENOENT'
                ? 'The uploads directory does not exist yet.'
                : err.message
        };
    }

    const total_bytes = stats.blocks * stats.bsize;
    const free_bytes = stats.bavail * stats.bsize;
    const used_bytes = total_bytes - free_bytes;

    // INODES ARE A SEPARATE WAY TO RUN OUT. A content-addressed store holds one
    // file per SHA, and game assets include a great many small ones — textures,
    // icons, individual animation curves — so a store can exhaust its inode
    // table while terabytes of block space remain. It presents identically to a
    // full disk: every write fails. Some filesystems report 0 here, meaning
    // "unlimited"; that is reported as unknown rather than as 100% used.
    const inodes_total = stats.files || 0;
    const inodes_free = stats.ffree || 0;
    const inodes_used_percent = inodes_total > 0
        ? Math.round(((inodes_total - inodes_free) / inodes_total) * 1000) / 10
        : null;

    const percent_used = total_bytes > 0
        ? Math.round((used_bytes / total_bytes) * 1000) / 10
        : 0;

    // READ HERE, PER CALL. Storing these at module scope would freeze them at
    // boot, and an administrator's new warning level would not take effect
    // until the next restart — a save that silently does nothing.
    const levels = {
        warning: settings.getSetting('usage_warning_percent'),
        critical: settings.getSetting('usage_critical_percent'),
    };

    // Each band is reported separately as well as combined: the two bars are
    // separate questions and each is coloured for its own state, while the
    // headline badge is the worse of them, because either one alone stops
    // every write.
    const space_status = usageStatus(percent_used, levels);
    const inode_status = inodes_used_percent === null
        ? 'ok'
        : usageStatus(inodes_used_percent, levels);

    return {
        path: dir,
        readable: true,
        total_bytes,
        used_bytes,
        free_bytes,
        percent_used,
        space_status,
        inodes_total,
        inodes_free,
        inodes_used_percent,
        inode_status,
        status: worstStatus(space_status, inode_status)
    };
}

// Neither BLOB_DIR nor the warning levels are re-exported. Both are owned
// elsewhere — storagePaths.js and the settings registry — and a second way to
// reach a value is a second place to look when it needs changing. The levels
// are not merely owned elsewhere now, they are not fixed values at all.
module.exports = { hostStorage };
