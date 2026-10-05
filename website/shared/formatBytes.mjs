// shared/formatBytes.mjs
//
// Bytes as a person reads them. The ONE implementation, used by both halves of
// the app.
//
// WHY IT LIVES HERE. There were two: a formatBytes in the developer route,
// used to build the quota-refusal message, and a formatFileSize in
// frontend/src/utils.js, used everywhere a size was displayed. They were
// already wrong in the same way they were always going to be — one rendered a
// 5 GiB limit as "5.0 GB" and the other as "5.00 GB" — so the same figure
// reached a developer with two different spellings, depending on whether it
// came from the server's sentence or the panel's own render. That is the exact
// divergence a shared module exists to make impossible.
//
// DELIBERATELY ADAPTIVE PRECISION, which is why neither original is the one
// kept. A fixed number of decimals is wrong somewhere: two decimals makes a
// column of figures noisy ("1.00 MB", "2.00 MB", "3.00 MB") and one decimal
// throws away the difference between 1.04 MB and 1.0 MB, which is the range
// where a developer is looking for a few stray kilobytes. So the decimals
// follow the magnitude: whole bytes are whole, and the smaller the number the
// more of it is shown.
//
// Binary units (1024), not decimal, because this reports what a filesystem
// holds and filesystems count in 1024s. "GB" here means GiB, which is what
// every tool the developer will compare against — du, df, their file manager —
// also means by it.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes) {
    const value = Number(bytes);

    // Negative is not a size, and NaN is not a number. Both render as zero
    // rather than as "NaN PB", which is what a missing figure would otherwise
    // put on a screen about storage.
    if (!Number.isFinite(value) || value <= 0) return '0 B';

    let scaled = value;
    let unit = 0;

    while (scaled >= 1024 && unit < UNITS.length - 1) {
        scaled /= 1024;
        unit += 1;
    }

    // No decimals for raw bytes: "512.00 B" is precision the number does not
    // have. Otherwise the smaller the figure, the more detail it keeps.
    const decimals = unit === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;

    return `${scaled.toFixed(decimals)} ${UNITS[unit]}`;
}
