import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR_NAME_RE = /^ce-dot-net\.cursor-ace-extension-(\d+\.\d+\.\d+)-universal$/;

/**
 * Extract a semver-string (e.g. "0.2.71") from a Cursor extension dir name.
 * Returns null if the name does not match the canonical pattern.
 */
export function parseVersionFromExtensionDirName(name: string): string | null {
    const m = name.match(DIR_NAME_RE);
    return m ? m[1] : null;
}

/**
 * Compare two semver-style "X.Y.Z" version strings numerically.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(n => Number(n));
    const pb = b.split('.').map(n => Number(n));
    for (let i = 0; i < 3; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/**
 * Pure function: from a list of sibling dir names, pick those that are
 * older same-publisher extension installs and should be cleaned.
 *
 * - Skips the current dir name (caller passes basename of currentExtensionPath)
 * - Skips dirs with no parseable version
 * - Skips dirs whose version >= currentVersion (never downgrade-clean,
 *   never re-delete the active version)
 */
export function pickDirsToCleanup(
    dirNames: readonly string[],
    currentVersion: string,
    currentDirBasename: string
): string[] {
    const out: string[] = [];
    for (const name of dirNames) {
        if (name === currentDirBasename) continue;
        const v = parseVersionFromExtensionDirName(name);
        if (!v) continue;
        if (compareVersions(v, currentVersion) < 0) {
            out.push(name);
        }
    }
    return out;
}

/**
 * Side-effecting orchestrator: scan the parent of currentExtensionPath,
 * pick older same-publisher dirs, and remove them.
 *
 * Safe-by-default: errors on individual dirs are caught and reported
 * via the result rather than thrown — one stuck dir does not block
 * the others.
 */
export async function cleanupOldExtensionDirs(
    currentExtensionPath: string,
    currentVersion: string
): Promise<{ removed: string[]; errors: string[] }> {
    const parent = path.dirname(currentExtensionPath);
    const currentBasename = path.basename(currentExtensionPath);

    let entries: string[];
    try {
        entries = fs.readdirSync(parent);
    } catch (err) {
        return { removed: [], errors: [`readdir(${parent}) failed: ${(err as Error).message}`] };
    }

    const toClean = pickDirsToCleanup(entries, currentVersion, currentBasename);

    const removed: string[] = [];
    const errors: string[] = [];

    for (const name of toClean) {
        const full = path.join(parent, name);
        try {
            fs.rmSync(full, { recursive: true, force: true });
            removed.push(full);
        } catch (err) {
            errors.push(`rmSync(${full}) failed: ${(err as Error).message}`);
        }
    }

    return { removed, errors };
}
