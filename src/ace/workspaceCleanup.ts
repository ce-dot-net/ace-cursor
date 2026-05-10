/**
 * v0.5.0-dev.20 — Workspace cleanup + initializer overhaul.
 *
 * Pure-function helpers used by the activation flow in extension.ts to:
 *   - guarantee all required ACE folders + files exist (Task C)
 *   - delete orphan hook scripts left behind by previous versions (Task D)
 *   - archive top-level trajectory files into tasks/_legacy/ (Task E)
 *   - remove hidden MCP tool cache entries Cursor doesn't honor (Task F)
 *   - prune stale per-conv session subdirs (Task H)
 *
 * Each function is fs-pure (no vscode imports) so they can be unit-tested
 * with tmpdirs without mocking the VS Code API surface. extension.ts wires
 * them into the version-bump init flow (Task G).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Task D — orphan scripts cleanup
// ---------------------------------------------------------------------------

/**
 * Hook scripts removed in dev.14+ that linger on disk after upgrades.
 * Listed verbatim from the task spec.
 */
export const ORPHAN_SCRIPTS: readonly string[] = [
	'ace_stop_hook.sh.bak',
	'ace_track_edit.sh',
	'ace_track_response.sh',
	'ace_track_shell.sh',
];

/**
 * Delete any file in `scriptsDir` whose basename matches an entry in
 * ORPHAN_SCRIPTS. Returns the names of files that were actually removed.
 *
 * Best-effort: missing dir / permission errors are swallowed and the
 * partial result is returned. Never throws.
 */
export function cleanupOrphanScripts(scriptsDir: string): string[] {
	const removed: string[] = [];
	if (!fs.existsSync(scriptsDir)) return removed;
	for (const name of ORPHAN_SCRIPTS) {
		const target = path.join(scriptsDir, name);
		try {
			if (fs.existsSync(target)) {
				fs.unlinkSync(target);
				removed.push(name);
			}
		} catch {
			// Ignore — best-effort cleanup.
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Task E — archive legacy top-level trajectory files
// ---------------------------------------------------------------------------

const LEGACY_TRAJECTORY_FILES: readonly string[] = [
	'mcp_trajectory.jsonl',
	'shell_trajectory.jsonl',
	'response_trajectory.jsonl',
	'edit_trajectory.jsonl',
];

/**
 * Move non-empty top-level trajectory files into
 * `<aceDir>/tasks/_legacy/<timestamp>/<file>` and truncate the originals
 * to size 0. Empty files are skipped (no churn).
 *
 * Returns the names of files that were archived.
 */
export function archiveLegacyTrajectoryFiles(aceDir: string): string[] {
	const archived: string[] = [];
	if (!fs.existsSync(aceDir)) return archived;

	// Identify candidates with non-zero size first; bail early if none.
	const candidates: string[] = [];
	for (const name of LEGACY_TRAJECTORY_FILES) {
		const p = path.join(aceDir, name);
		try {
			if (fs.existsSync(p) && fs.statSync(p).size > 0) candidates.push(name);
		} catch {
			/* ignore */
		}
	}
	if (candidates.length === 0) return archived;

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const dest = path.join(aceDir, 'tasks', '_legacy', stamp);
	try {
		fs.mkdirSync(dest, { recursive: true });
	} catch {
		return archived;
	}

	for (const name of candidates) {
		const src = path.join(aceDir, name);
		const dst = path.join(dest, name);
		try {
			fs.copyFileSync(src, dst);
			// Truncate in place (don't unlink — track scripts append on next write).
			fs.writeFileSync(src, '');
			archived.push(name);
		} catch {
			// Best-effort; partial failures don't abort the rest.
		}
	}
	return archived;
}

// ---------------------------------------------------------------------------
// Task F — hidden MCP tool cache cleanup
// ---------------------------------------------------------------------------

/**
 * Tools the MCP proxy filters out of tools/list. If the tool ever leaked
 * into Cursor's per-project tool cache it stays callable until removed,
 * so we delete the cache file on every activation.
 */
export const HIDDEN_MCP_TOOLS: readonly string[] = ['ace_get_playbook'];

const CURSOR_PROJECTS_REL = path.join('.cursor', 'projects');
const ACE_MCP_SERVER_DIR = 'user-ce-dot-net.cursor-ace-extension-extension-ace-pattern-learning';

/**
 * Walk every project subdir under `<homeDir>/.cursor/projects/<proj>/mcps/<srv>/tools`
 * and delete any json file matching a name in HIDDEN_MCP_TOOLS. Returns the
 * absolute paths of files that were removed.
 *
 * Best-effort: missing dirs / permission errors are swallowed.
 */
export function cleanupHiddenToolCache(homeDir: string): string[] {
	const removed: string[] = [];
	const projectsRoot = path.join(homeDir, CURSOR_PROJECTS_REL);
	if (!fs.existsSync(projectsRoot)) return removed;

	let projects: string[] = [];
	try {
		projects = fs.readdirSync(projectsRoot);
	} catch {
		return removed;
	}

	for (const proj of projects) {
		const toolsDir = path.join(projectsRoot, proj, 'mcps', ACE_MCP_SERVER_DIR, 'tools');
		if (!fs.existsSync(toolsDir)) continue;
		for (const toolName of HIDDEN_MCP_TOOLS) {
			const target = path.join(toolsDir, `${toolName}.json`);
			try {
				if (fs.existsSync(target)) {
					fs.unlinkSync(target);
					removed.push(target);
				}
			} catch {
				/* ignore */
			}
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Task H — prune stale per-conv session subdirs
// ---------------------------------------------------------------------------

const PRESERVED_SESSION_DIRS = new Set<string>(['_legacy']);

/**
 * Delete task subdirs whose mtime is older than `olderThanDays`.
 * `_legacy/` (Task E archive) is always preserved.
 *
 * The `tasksDir` argument is the conventional `.cursor/ace/tasks/` (renamed
 * from `sessions/` in v0.5.0-dev.24); the parameter name preserves history.
 *
 * Returns the names of dirs that were pruned.
 */
export function pruneStaleSessions(tasksDir: string, olderThanDays = 30): string[] {
	const pruned: string[] = [];
	if (!fs.existsSync(tasksDir)) return pruned;

	const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(tasksDir);
	} catch {
		return pruned;
	}

	for (const name of entries) {
		if (PRESERVED_SESSION_DIRS.has(name)) continue;
		const p = path.join(tasksDir, name);
		try {
			const st = fs.statSync(p);
			if (!st.isDirectory()) continue;
			if (st.mtimeMs < cutoff) {
				fs.rmSync(p, { recursive: true, force: true });
				pruned.push(name);
			}
		} catch {
			/* ignore */
		}
	}
	return pruned;
}

// ---------------------------------------------------------------------------
// Task C — initializer ensures all needed folders exist
// ---------------------------------------------------------------------------

/**
 * Folders the initializer must guarantee exist on every activation.
 * Files (RULE.mdc / hooks.json / settings.json / AGENTS.md) are written
 * by the existing createCursorRules / createCursorHooks paths in extension.ts.
 */
const REQUIRED_FOLDERS: readonly string[] = [
	path.join('.cursor', 'ace'),
	path.join('.cursor', 'ace', 'tasks'),
	path.join('.cursor', 'ace', 'searches'),
	path.join('.cursor', 'scripts'),
	path.join('.cursor', 'rules'),
	path.join('.cursor', 'rules', 'ace-patterns'),
	path.join('.cursor', 'rules', 'ace-domain-search'),
	path.join('.cursor', 'commands'),
];

/**
 * Ensure every required ACE folder exists under `workspaceRoot`. Returns
 * the absolute paths of folders that were freshly created (existing ones
 * are not in the result list).
 */
export function ensureWorkspaceFolders(workspaceRoot: string): string[] {
	const created: string[] = [];
	for (const rel of REQUIRED_FOLDERS) {
		const abs = path.join(workspaceRoot, rel);
		if (!fs.existsSync(abs)) {
			try {
				fs.mkdirSync(abs, { recursive: true });
				created.push(abs);
			} catch {
				/* ignore */
			}
		}
	}
	return created;
}

// ---------------------------------------------------------------------------
// v0.5.0-dev.21 — migrate RULE.md → RULE.mdc
// ---------------------------------------------------------------------------

/**
 * Per Cursor docs (cursor.com/docs/rules):
 *   - .mdc with frontmatter (description / globs) → auto-attach
 *   - .md → @-mention only (frontmatter ignored)
 *
 * Earlier extension versions wrote `.cursor/rules/<name>/RULE.md`. Cursor
 * silently treats these as @-mention-only, so the auto-injection path
 * never fires. Rename to `.mdc` so the existing frontmatter takes effect.
 *
 * Behaviour for each `.md` file under `<rulesDir>/<name>/`:
 *   - sibling `.mdc` exists → DELETE the `.md` (mdc is canonical)
 *   - no sibling `.mdc`     → RENAME `.md` to `.mdc` (preserve content)
 *
 * Idempotent — safe to run on every activation. Best-effort: missing dir /
 * permission errors are swallowed and the partial result is returned.
 *
 * @returns { migrated, removed } — basenames (e.g. "ace-patterns/RULE.md")
 *   relative to `rulesDir` for telemetry/logging.
 */
export function migrateLegacyMdRules(rulesDir: string): { migrated: string[]; removed: string[] } {
	const migrated: string[] = [];
	const removed: string[] = [];
	if (!fs.existsSync(rulesDir)) return { migrated, removed };

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(rulesDir, { withFileTypes: true });
	} catch {
		return { migrated, removed };
	}

	const mdTargets: string[] = []; // absolute paths to .md files

	// Top-level legacy *.md (rare — old extension versions wrote flat files).
	for (const entry of entries) {
		try {
			if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
				mdTargets.push(path.join(rulesDir, entry.name));
			}
		} catch {
			/* ignore */
		}
	}

	// Folder-based RULE.md files at <rulesDir>/<name>/RULE.md.
	for (const entry of entries) {
		try {
			if (!entry.isDirectory()) continue;
			const subdir = path.join(rulesDir, entry.name);
			let subEntries: fs.Dirent[] = [];
			try {
				subEntries = fs.readdirSync(subdir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const sub of subEntries) {
				if (sub.isFile() && sub.name.toLowerCase().endsWith('.md')) {
					mdTargets.push(path.join(subdir, sub.name));
				}
			}
		} catch {
			/* ignore */
		}
	}

	for (const mdPath of mdTargets) {
		const mdcPath = mdPath.slice(0, -3) + '.mdc';
		const rel = path.relative(rulesDir, mdPath);
		try {
			if (fs.existsSync(mdcPath)) {
				// .mdc is canonical — drop the stale .md sibling.
				fs.unlinkSync(mdPath);
				removed.push(rel);
			} else {
				// Preserve content: rename .md → .mdc (atomic on same fs).
				fs.renameSync(mdPath, mdcPath);
				migrated.push(rel);
			}
		} catch {
			// Best-effort — permission issues / races skip this entry.
		}
	}

	return { migrated, removed };
}

// ---------------------------------------------------------------------------
// v0.5.0-dev.24 — migrate legacy sessions/ folder → tasks/
// ---------------------------------------------------------------------------

/**
 * v0.5.0-dev.24: rename `.cursor/ace/sessions/` to `.cursor/ace/tasks/` to
 * match the user's mental model (one Cursor `conversation_id` = one task =
 * one user prompt + AI's full response, not a chat-panel session).
 *
 * Behaviour:
 *   - sessions/ missing, tasks/ missing → create tasks/, return migrated=false
 *   - sessions/ missing, tasks/ present → no-op, return migrated=false
 *   - sessions/ present, tasks/ missing → atomic rename, mergedFromBoth=false
 *   - both present                       → merge non-conflicting subdirs from
 *     sessions/ into tasks/, leave conflicting names in place, remove empty
 *     sessions/. Returns mergedFromBoth=true.
 *
 * Idempotent — safe to run on every activation. Best-effort: rename / merge
 * errors are swallowed so partial state is preserved (next activation retries).
 */
export function migrateLegacySessionsFolder(
	aceDir: string,
): { migrated: boolean; mergedFromBoth: boolean } {
	const oldPath = path.join(aceDir, 'sessions');
	const newPath = path.join(aceDir, 'tasks');

	if (!fs.existsSync(oldPath)) {
		// Already migrated or fresh install — ensure tasks/ exists.
		if (!fs.existsSync(newPath)) {
			try { fs.mkdirSync(newPath, { recursive: true }); } catch { /* best-effort */ }
		}
		return { migrated: false, mergedFromBoth: false };
	}

	if (!fs.existsSync(newPath)) {
		// Simple atomic rename — preserves _legacy/ and every per-conv subdir.
		try {
			fs.renameSync(oldPath, newPath);
			return { migrated: true, mergedFromBoth: false };
		} catch {
			// Cross-device or permission failure — fall through to merge path
			// (which copies/recreates instead of rename).
		}
	}

	// Both folders exist (or rename failed) — merge non-conflicting entries
	// from sessions/ into tasks/.
	let oldEntries: fs.Dirent[] = [];
	try {
		oldEntries = fs.readdirSync(oldPath, { withFileTypes: true });
	} catch {
		return { migrated: false, mergedFromBoth: false };
	}

	for (const entry of oldEntries) {
		const src = path.join(oldPath, entry.name);
		const dst = path.join(newPath, entry.name);
		try {
			if (!fs.existsSync(dst)) {
				fs.renameSync(src, dst);
			}
			// If dst exists, leave src in place — caller can detect conflicts
			// by listing remaining entries in oldPath after this call.
		} catch {
			/* best-effort */
		}
	}

	// Remove old dir if it ended up empty after the merge.
	try {
		if (fs.readdirSync(oldPath).length === 0) {
			fs.rmdirSync(oldPath);
		}
	} catch {
		/* may not be empty if conflicts remained */
	}

	return { migrated: true, mergedFromBoth: true };
}
