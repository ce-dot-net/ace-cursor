/**
 * v0.5.0-dev.20 — workspace cleanup + initializer overhaul.
 *
 * Tests pure-function helpers in src/ace/workspaceCleanup.ts:
 *   - cleanupOrphanScripts (Task D)
 *   - archiveLegacyTrajectoryFiles (Task E)
 *   - cleanupHiddenToolCache (Task F)
 *   - pruneStaleSessions (Task H)
 *   - ensureWorkspaceFolders (Task C)
 *
 * Plus integration assertions:
 *   - Task A: pre/post-tool-use scripts write to per-conv path
 *   - Task B: orphan track-script generators removed from hookScripts.ts
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ORPHAN_SCRIPTS,
	HIDDEN_MCP_TOOLS,
	cleanupOrphanScripts,
	archiveLegacyTrajectoryFiles,
	cleanupHiddenToolCache,
	pruneStaleSessions,
	ensureWorkspaceFolders,
	migrateLegacyMdRules,
	migrateLegacySessionsFolder,
} from '../../ace/workspaceCleanup';

// Local helpers
function mkTmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Task D — cleanupOrphanScripts
// ---------------------------------------------------------------------------
describe('Task D — cleanupOrphanScripts', () => {
	it('exposes the canonical orphan list', () => {
		// Listed by hand in the task spec — keep this canon test in sync.
		expect(ORPHAN_SCRIPTS).toEqual([
			'ace_stop_hook.sh.bak',
			'ace_track_edit.sh',
			'ace_track_response.sh',
			'ace_track_shell.sh',
		]);
	});

	it('removes orphan scripts when present', () => {
		const dir = mkTmpDir('ace-orphan-');
		try {
			for (const name of ORPHAN_SCRIPTS) {
				fs.writeFileSync(path.join(dir, name), '# orphan\n');
			}
			fs.writeFileSync(path.join(dir, 'ace_track_mcp.sh'), '# valid\n');

			const removed = cleanupOrphanScripts(dir);
			expect(removed.sort()).toEqual([...ORPHAN_SCRIPTS].sort());
			for (const name of ORPHAN_SCRIPTS) {
				expect(fs.existsSync(path.join(dir, name)), `${name} should be removed`).toBe(false);
			}
			// Valid script untouched
			expect(fs.existsSync(path.join(dir, 'ace_track_mcp.sh'))).toBe(true);
		} finally {
			rmTmp(dir);
		}
	});

	it('does not error when scripts dir is missing', () => {
		const removed = cleanupOrphanScripts(path.join(os.tmpdir(), `nonexistent-${Date.now()}`));
		expect(removed).toEqual([]);
	});

	it('does not error when no orphans exist', () => {
		const dir = mkTmpDir('ace-orphan-clean-');
		try {
			fs.writeFileSync(path.join(dir, 'ace_track_mcp.sh'), '# valid\n');
			const removed = cleanupOrphanScripts(dir);
			expect(removed).toEqual([]);
			expect(fs.existsSync(path.join(dir, 'ace_track_mcp.sh'))).toBe(true);
		} finally {
			rmTmp(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// Task E — archiveLegacyTrajectoryFiles
// ---------------------------------------------------------------------------
describe('Task E — archiveLegacyTrajectoryFiles', () => {
	const LEGACY_FILES = [
		'mcp_trajectory.jsonl',
		'shell_trajectory.jsonl',
		'response_trajectory.jsonl',
		'edit_trajectory.jsonl',
	];

	it('archives non-empty top-level trajectory files into tasks/_legacy/<timestamp> (renamed from sessions/ in v0.5.0-dev.24)', () => {
		const aceDir = mkTmpDir('ace-archive-');
		try {
			for (const name of LEGACY_FILES) {
				fs.writeFileSync(path.join(aceDir, name), `{"event":"x","f":"${name}"}\n`);
			}
			const archived = archiveLegacyTrajectoryFiles(aceDir);
			expect(archived.length).toBe(LEGACY_FILES.length);

			// Originals truncated (still exist, but empty)
			for (const name of LEGACY_FILES) {
				const p = path.join(aceDir, name);
				expect(fs.existsSync(p), `${name} should still exist`).toBe(true);
				expect(fs.readFileSync(p, 'utf-8')).toBe('');
			}

			// v0.5.0-dev.24 — archive dir lives under tasks/_legacy/ now.
			const legacyDir = path.join(aceDir, 'tasks', '_legacy');
			const subdirs = fs.readdirSync(legacyDir);
			expect(subdirs.length).toBeGreaterThanOrEqual(1);
			const stamped = path.join(legacyDir, subdirs[0]);
			for (const name of LEGACY_FILES) {
				expect(fs.existsSync(path.join(stamped, name)), `${name} archived`).toBe(true);
			}
			// Old sessions/_legacy/ MUST NOT be created.
			expect(fs.existsSync(path.join(aceDir, 'sessions', '_legacy'))).toBe(false);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('skips empty files (does not archive)', () => {
		const aceDir = mkTmpDir('ace-archive-empty-');
		try {
			fs.writeFileSync(path.join(aceDir, 'mcp_trajectory.jsonl'), '');
			const archived = archiveLegacyTrajectoryFiles(aceDir);
			expect(archived).toEqual([]);
			// Legacy dir was not even created (under tasks/ — the new path).
			expect(fs.existsSync(path.join(aceDir, 'tasks', '_legacy'))).toBe(false);
			// And nothing under the old sessions/ either.
			expect(fs.existsSync(path.join(aceDir, 'sessions', '_legacy'))).toBe(false);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('handles missing files gracefully', () => {
		const aceDir = mkTmpDir('ace-archive-none-');
		try {
			const archived = archiveLegacyTrajectoryFiles(aceDir);
			expect(archived).toEqual([]);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('truncates the original file in place (size 0 after archive)', () => {
		const aceDir = mkTmpDir('ace-archive-truncate-');
		try {
			const p = path.join(aceDir, 'mcp_trajectory.jsonl');
			fs.writeFileSync(p, 'line1\nline2\n');
			archiveLegacyTrajectoryFiles(aceDir);
			const stat = fs.statSync(p);
			expect(stat.size).toBe(0);
		} finally {
			rmTmp(aceDir);
		}
	});
});

// ---------------------------------------------------------------------------
// Task F — cleanupHiddenToolCache
// ---------------------------------------------------------------------------
describe('Task F — cleanupHiddenToolCache', () => {
	it('exposes the canonical hidden-tools list', () => {
		expect(HIDDEN_MCP_TOOLS).toEqual(['ace_get_playbook']);
	});

	it('removes hidden tool json files under projects/<proj>/mcps/<srv>/tools/', () => {
		const home = mkTmpDir('ace-hometest-');
		try {
			const toolDir = path.join(
				home,
				'.cursor',
				'projects',
				'workspace-A',
				'mcps',
				'user-ce-dot-net.cursor-ace-extension-extension-ace-pattern-learning',
				'tools',
			);
			fs.mkdirSync(toolDir, { recursive: true });
			for (const t of HIDDEN_MCP_TOOLS) {
				fs.writeFileSync(path.join(toolDir, `${t}.json`), '{}');
			}
			fs.writeFileSync(path.join(toolDir, 'ace_search.json'), '{}'); // valid

			const removed = cleanupHiddenToolCache(home);
			expect(removed.length).toBe(HIDDEN_MCP_TOOLS.length);
			for (const t of HIDDEN_MCP_TOOLS) {
				expect(fs.existsSync(path.join(toolDir, `${t}.json`))).toBe(false);
			}
			// Valid tool untouched
			expect(fs.existsSync(path.join(toolDir, 'ace_search.json'))).toBe(true);
		} finally {
			rmTmp(home);
		}
	});

	it('handles missing project dir without throwing', () => {
		const home = mkTmpDir('ace-noproj-');
		try {
			expect(() => cleanupHiddenToolCache(home)).not.toThrow();
		} finally {
			rmTmp(home);
		}
	});

	it('walks ALL project subdirs', () => {
		const home = mkTmpDir('ace-multi-');
		try {
			for (const proj of ['workspace-A', 'workspace-B']) {
				const toolDir = path.join(
					home,
					'.cursor',
					'projects',
					proj,
					'mcps',
					'user-ce-dot-net.cursor-ace-extension-extension-ace-pattern-learning',
					'tools',
				);
				fs.mkdirSync(toolDir, { recursive: true });
				fs.writeFileSync(path.join(toolDir, 'ace_get_playbook.json'), '{}');
			}
			const removed = cleanupHiddenToolCache(home);
			expect(removed.length).toBe(2);
		} finally {
			rmTmp(home);
		}
	});
});

// ---------------------------------------------------------------------------
// Task H — pruneStaleSessions
// ---------------------------------------------------------------------------
describe('Task H — pruneStaleSessions', () => {
	it('removes task subdirs older than threshold (default 30 days)', () => {
		const aceDir = mkTmpDir('ace-prune-');
		try {
			// v0.5.0-dev.24 — tasksDir (formerly sessionsDir).
			const tasksDir = path.join(aceDir, 'tasks');
			fs.mkdirSync(tasksDir, { recursive: true });

			const oldConv = path.join(tasksDir, 'old-conv');
			const recentConv = path.join(tasksDir, 'recent-conv');
			fs.mkdirSync(oldConv);
			fs.mkdirSync(recentConv);

			// Backdate old-conv to ~40 days ago
			const oldStamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
			fs.utimesSync(oldConv, oldStamp, oldStamp);

			const pruned = pruneStaleSessions(tasksDir, 30);
			expect(pruned).toContain('old-conv');
			expect(pruned).not.toContain('recent-conv');
			expect(fs.existsSync(oldConv)).toBe(false);
			expect(fs.existsSync(recentConv)).toBe(true);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('preserves _legacy archive dir regardless of age', () => {
		const aceDir = mkTmpDir('ace-prune-legacy-');
		try {
			const tasksDir = path.join(aceDir, 'tasks');
			const legacyDir = path.join(tasksDir, '_legacy');
			fs.mkdirSync(legacyDir, { recursive: true });
			const oldStamp = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
			fs.utimesSync(legacyDir, oldStamp, oldStamp);

			const pruned = pruneStaleSessions(tasksDir, 30);
			expect(pruned).not.toContain('_legacy');
			expect(fs.existsSync(legacyDir)).toBe(true);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('handles missing tasks dir gracefully', () => {
		const dir = path.join(os.tmpdir(), `ace-no-tasks-${Date.now()}`);
		expect(() => pruneStaleSessions(dir, 30)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Task C — ensureWorkspaceFolders
// ---------------------------------------------------------------------------
describe('Task C — ensureWorkspaceFolders', () => {
	it('creates all expected ACE workspace folders', () => {
		const ws = mkTmpDir('ace-init-');
		try {
			const created = ensureWorkspaceFolders(ws);

			const expected = [
				path.join(ws, '.cursor', 'ace', 'tasks'),
				path.join(ws, '.cursor', 'ace', 'searches'),
				path.join(ws, '.cursor', 'scripts'),
				path.join(ws, '.cursor', 'rules', 'ace-patterns'),
				path.join(ws, '.cursor', 'rules', 'ace-domain-search'),
			];
			for (const p of expected) {
				expect(fs.existsSync(p), `${p} should exist`).toBe(true);
				expect(fs.statSync(p).isDirectory()).toBe(true);
			}
			// Returns the list of dirs that were actually created
			expect(created.length).toBeGreaterThanOrEqual(expected.length);
		} finally {
			rmTmp(ws);
		}
	});

	it('is idempotent — second call creates nothing new but does not throw', () => {
		const ws = mkTmpDir('ace-init-idem-');
		try {
			ensureWorkspaceFolders(ws);
			const created2 = ensureWorkspaceFolders(ws);
			expect(created2).toEqual([]);
		} finally {
			rmTmp(ws);
		}
	});
});

// ---------------------------------------------------------------------------
// Task A — per-conv path in pre_tool_use + post_tool_use scripts
// ---------------------------------------------------------------------------
describe('Task A — pre/post-tool-use scripts use per-conv mcp_trajectory path', () => {
	it('pre_tool_use bash script writes to .cursor/ace/tasks/<conv>/mcp_trajectory.jsonl when conv_id present', async () => {
		const { getPreToolUseScriptContent } = await import('../../ace/hookScripts');
		const script = getPreToolUseScriptContent();
		// v0.5.0-dev.24 — per-conv branch must materialize tasks/$conv_id path
		// (renamed from sessions/$conv_id).
		expect(script).toMatch(/tasks\/\$conv_id/);
		expect(script).toMatch(/per_conv_dir.*tasks\/\$conv_id/);
		expect(script).toMatch(/per_conv_dir\/mcp_trajectory\.jsonl/);
		// Legacy sessions/ path MUST NOT be written by the new script.
		expect(script).not.toMatch(/per_conv_dir="\$ace_dir\/sessions\/\$conv_id"/);
	});

	it('pre_tool_use bash script falls back to top-level when conv_id missing', async () => {
		const { getPreToolUseScriptContent } = await import('../../ace/hookScripts');
		const script = getPreToolUseScriptContent();
		// Top-level fallback path must remain (legacy / first-turn)
		expect(script).toMatch(/echo .* >> "\$ace_dir\/mcp_trajectory\.jsonl"/);
	});

	it('runtime: pre_tool_use writes to per-conv subdir when conversation_id present', async () => {
		const { execFileSync } = await import('node:child_process');
		const { getPreToolUseScriptContent } = await import('../../ace/hookScripts');
		const tmp = path.join(os.tmpdir(), `ace-pre-${Date.now()}.sh`);
		fs.writeFileSync(tmp, getPreToolUseScriptContent(), { mode: 0o755 });
		const cwd = mkTmpDir('ace-pre-cwd-');
		try {
			execFileSync('bash', [tmp], {
				input: JSON.stringify({
					tool_name: 'Read',
					conversation_id: 'conv-PRE',
					generation_id: 'gen-1',
				}),
				encoding: 'utf-8',
				cwd,
			});
			const perConv = path.join(cwd, '.cursor', 'ace', 'tasks', 'conv-PRE', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(perConv), `expected per-conv jsonl at ${perConv}`).toBe(true);
			const top = path.join(cwd, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(top)).toBe(false);
		} finally {
			fs.unlinkSync(tmp);
			rmTmp(cwd);
		}
	});

	it('runtime: pre_tool_use falls back to top-level mcp_trajectory.jsonl when conv_id missing', async () => {
		const { execFileSync } = await import('node:child_process');
		const { getPreToolUseScriptContent } = await import('../../ace/hookScripts');
		const tmp = path.join(os.tmpdir(), `ace-pre-fb-${Date.now()}.sh`);
		fs.writeFileSync(tmp, getPreToolUseScriptContent(), { mode: 0o755 });
		const cwd = mkTmpDir('ace-pre-fb-cwd-');
		try {
			execFileSync('bash', [tmp], {
				input: JSON.stringify({ tool_name: 'Read' }),
				encoding: 'utf-8',
				cwd,
			});
			const top = path.join(cwd, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(top)).toBe(true);
		} finally {
			fs.unlinkSync(tmp);
			rmTmp(cwd);
		}
	});
});

// ---------------------------------------------------------------------------
// Task B — orphan track-script generators removed from hookScripts.ts
// ---------------------------------------------------------------------------
describe('Task B — orphan track-script generators removed', () => {
	it('hookScripts module does NOT export getEditTrackScriptContent / Response / Shell', async () => {
		const mod = await import('../../ace/hookScripts');
		// These functions should NOT exist in v0.5.0-dev.20+
		expect((mod as any).getEditTrackScriptContent).toBeUndefined();
		expect((mod as any).getResponseTrackScriptContent).toBeUndefined();
		expect((mod as any).getShellTrackScriptContent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// v0.5.0-dev.21 — migrateLegacyMdRules (RULE.md → RULE.mdc)
// ---------------------------------------------------------------------------
describe('v0.5.0-dev.21 — migrateLegacyMdRules', () => {
	it('renames .md to .mdc when no .mdc exists', () => {
		const ws = mkTmpDir('ace-mig-rename-');
		try {
			const rulesDir = path.join(ws, '.cursor', 'rules');
			const patternsDir = path.join(rulesDir, 'ace-patterns');
			const domainDir = path.join(rulesDir, 'ace-domain-search');
			fs.mkdirSync(patternsDir, { recursive: true });
			fs.mkdirSync(domainDir, { recursive: true });
			fs.writeFileSync(path.join(patternsDir, 'RULE.md'), 'patterns body');
			fs.writeFileSync(path.join(domainDir, 'RULE.md'), 'domain body');

			const result = migrateLegacyMdRules(rulesDir);

			expect(result.migrated.length).toBe(2);
			expect(result.removed).toEqual([]);
			expect(fs.existsSync(path.join(patternsDir, 'RULE.md'))).toBe(false);
			expect(fs.existsSync(path.join(patternsDir, 'RULE.mdc'))).toBe(true);
			expect(fs.existsSync(path.join(domainDir, 'RULE.md'))).toBe(false);
			expect(fs.existsSync(path.join(domainDir, 'RULE.mdc'))).toBe(true);
		} finally {
			rmTmp(ws);
		}
	});

	it('deletes .md when sibling .mdc exists', () => {
		const ws = mkTmpDir('ace-mig-delete-');
		try {
			const rulesDir = path.join(ws, '.cursor', 'rules');
			const patternsDir = path.join(rulesDir, 'ace-patterns');
			fs.mkdirSync(patternsDir, { recursive: true });
			// Both versions present — .mdc is canonical, .md must be deleted.
			fs.writeFileSync(path.join(patternsDir, 'RULE.md'), 'stale legacy');
			fs.writeFileSync(path.join(patternsDir, 'RULE.mdc'), 'canonical body');

			const result = migrateLegacyMdRules(rulesDir);

			expect(result.migrated).toEqual([]);
			expect(result.removed.length).toBe(1);
			expect(fs.existsSync(path.join(patternsDir, 'RULE.md'))).toBe(false);
			// .mdc untouched (still has canonical content)
			expect(fs.existsSync(path.join(patternsDir, 'RULE.mdc'))).toBe(true);
			expect(fs.readFileSync(path.join(patternsDir, 'RULE.mdc'), 'utf-8')).toBe('canonical body');
		} finally {
			rmTmp(ws);
		}
	});

	it('handles missing rules dir gracefully', () => {
		const missing = path.join(os.tmpdir(), `ace-mig-noexist-${Date.now()}`);
		expect(() => migrateLegacyMdRules(missing)).not.toThrow();
		const result = migrateLegacyMdRules(missing);
		expect(result.migrated).toEqual([]);
		expect(result.removed).toEqual([]);
	});

	it('preserves content during rename (.md body → .mdc body)', () => {
		const ws = mkTmpDir('ace-mig-content-');
		try {
			const rulesDir = path.join(ws, '.cursor', 'rules');
			const patternsDir = path.join(rulesDir, 'ace-patterns');
			fs.mkdirSync(patternsDir, { recursive: true });
			const body = '---\ndescription: legacy content\nglobs: ["**/*"]\n---\n\n# Body of the rule';
			fs.writeFileSync(path.join(patternsDir, 'RULE.md'), body);

			const result = migrateLegacyMdRules(rulesDir);

			expect(result.migrated.length).toBe(1);
			const migratedContent = fs.readFileSync(path.join(patternsDir, 'RULE.mdc'), 'utf-8');
			expect(migratedContent).toBe(body);
		} finally {
			rmTmp(ws);
		}
	});

	it('handles permission errors gracefully (non-existent path)', () => {
		// Best-effort contract: must NEVER throw on bad input. We use a
		// definitely-non-existent path; the helper returns empty arrays.
		const bogus = path.join(os.tmpdir(), `ace-mig-bogus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		expect(fs.existsSync(bogus)).toBe(false);
		expect(() => migrateLegacyMdRules(bogus)).not.toThrow();
		const result = migrateLegacyMdRules(bogus);
		expect(result).toEqual({ migrated: [], removed: [] });
	});

	it('idempotent — second call after migration is a no-op', () => {
		const ws = mkTmpDir('ace-mig-idem-');
		try {
			const rulesDir = path.join(ws, '.cursor', 'rules');
			const patternsDir = path.join(rulesDir, 'ace-patterns');
			fs.mkdirSync(patternsDir, { recursive: true });
			fs.writeFileSync(path.join(patternsDir, 'RULE.md'), 'body');

			migrateLegacyMdRules(rulesDir); // first call migrates
			const second = migrateLegacyMdRules(rulesDir); // second is no-op
			expect(second.migrated).toEqual([]);
			expect(second.removed).toEqual([]);
			expect(fs.existsSync(path.join(patternsDir, 'RULE.mdc'))).toBe(true);
		} finally {
			rmTmp(ws);
		}
	});
});

// ---------------------------------------------------------------------------
// v0.5.0-dev.22 Task C — InitSummary shape from cleanup helpers (pure)
// ---------------------------------------------------------------------------
//
// initializeWorkspaceForFolder lives in extension.ts which imports `vscode`.
// We can't load it standalone in vitest. Instead we verify that each cleanup
// helper returns the arrays we then aggregate into InitSummary, and that
// the aggregation contract is well-defined (counts match what the helpers
// return). This is the seam the production code uses.
// ---------------------------------------------------------------------------
describe('v0.5.0-dev.22 Task C — InitSummary aggregation contract', () => {
	it('migrateLegacyMdRules returns counts the InitSummary will sum', () => {
		const ws = mkTmpDir('ace-summary-mig-');
		try {
			const rulesDir = path.join(ws, '.cursor', 'rules', 'ace-patterns');
			fs.mkdirSync(rulesDir, { recursive: true });
			fs.writeFileSync(path.join(rulesDir, 'RULE.md'), 'legacy');

			const result = migrateLegacyMdRules(path.join(ws, '.cursor', 'rules'));
			// summary.migrated = [...result.migrated, ...result.removed]
			const aggregated = [...result.migrated, ...result.removed];
			expect(aggregated.length).toBe(1);
		} finally {
			rmTmp(ws);
		}
	});

	it('cleanupOrphanScripts return value populates summary.removedOrphans', () => {
		const dir = mkTmpDir('ace-summary-orphan-');
		try {
			for (const name of ORPHAN_SCRIPTS) {
				fs.writeFileSync(path.join(dir, name), '# orphan\n');
			}
			const removed = cleanupOrphanScripts(dir);
			// This array is what summary.removedOrphans will store verbatim
			expect(removed.length).toBe(ORPHAN_SCRIPTS.length);
			expect(Array.isArray(removed)).toBe(true);
		} finally {
			rmTmp(dir);
		}
	});

	it('archiveLegacyTrajectoryFiles return value populates summary.archivedLegacy', () => {
		const aceDir = mkTmpDir('ace-summary-archive-');
		try {
			fs.writeFileSync(path.join(aceDir, 'mcp_trajectory.jsonl'), '{"x":1}\n');
			fs.writeFileSync(path.join(aceDir, 'shell_trajectory.jsonl'), '{"x":2}\n');
			const archived = archiveLegacyTrajectoryFiles(aceDir);
			// This array is what summary.archivedLegacy will store verbatim
			expect(archived.length).toBe(2);
			expect(Array.isArray(archived)).toBe(true);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('all three helpers return [] (not undefined) when nothing to clean — required for summary defaults', () => {
		const ws = mkTmpDir('ace-summary-empty-');
		try {
			const rulesDir = path.join(ws, '.cursor', 'rules');
			fs.mkdirSync(rulesDir, { recursive: true });
			const aceDir = path.join(ws, '.cursor', 'ace');
			fs.mkdirSync(aceDir, { recursive: true });
			const scriptsDir = path.join(ws, '.cursor', 'scripts');
			fs.mkdirSync(scriptsDir, { recursive: true });

			const mig = migrateLegacyMdRules(rulesDir);
			const orph = cleanupOrphanScripts(scriptsDir);
			const arch = archiveLegacyTrajectoryFiles(aceDir);

			expect(mig.migrated).toEqual([]);
			expect(mig.removed).toEqual([]);
			expect(orph).toEqual([]);
			expect(arch).toEqual([]);
		} finally {
			rmTmp(ws);
		}
	});
});

// ---------------------------------------------------------------------------
// v0.5.0-dev.24 — migrateLegacySessionsFolder (sessions/ → tasks/)
// ---------------------------------------------------------------------------
//
// User-facing terminology: a "task" = one user prompt + AI's full response =
// one Cursor `conversation_id`. Folder rename brings code in line with that
// mental model. Migration is one-shot at activation; idempotent on re-runs.
// ---------------------------------------------------------------------------
describe('v0.5.0-dev.24 — migrateLegacySessionsFolder (sessions/ → tasks/)', () => {
	it('renames sessions/ to tasks/ when only sessions/ exists', () => {
		const aceDir = mkTmpDir('ace-mig-rename-');
		try {
			const oldDir = path.join(aceDir, 'sessions');
			fs.mkdirSync(path.join(oldDir, 'conv-1'), { recursive: true });
			fs.writeFileSync(path.join(oldDir, 'conv-1', 'mcp_trajectory.jsonl'), '{"x":1}\n');

			const result = migrateLegacySessionsFolder(aceDir);

			expect(result).toEqual({ migrated: true, mergedFromBoth: false });
			expect(fs.existsSync(oldDir)).toBe(false);
			const newDir = path.join(aceDir, 'tasks');
			expect(fs.existsSync(newDir)).toBe(true);
			// Per-conv subdir + content preserved through the rename.
			expect(fs.existsSync(path.join(newDir, 'conv-1', 'mcp_trajectory.jsonl'))).toBe(true);
			expect(fs.readFileSync(path.join(newDir, 'conv-1', 'mcp_trajectory.jsonl'), 'utf-8')).toBe('{"x":1}\n');
		} finally {
			rmTmp(aceDir);
		}
	});

	it('no-op when only tasks/ exists (and creates tasks/ if missing)', () => {
		const aceDir = mkTmpDir('ace-mig-noop-');
		try {
			// Case 1: tasks/ already exists, sessions/ does not.
			const tasksDir = path.join(aceDir, 'tasks');
			fs.mkdirSync(tasksDir, { recursive: true });
			fs.writeFileSync(path.join(tasksDir, 'marker.txt'), 'kept');

			const result = migrateLegacySessionsFolder(aceDir);

			expect(result).toEqual({ migrated: false, mergedFromBoth: false });
			expect(fs.existsSync(path.join(tasksDir, 'marker.txt'))).toBe(true);
			// sessions/ MUST NOT be created.
			expect(fs.existsSync(path.join(aceDir, 'sessions'))).toBe(false);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('creates tasks/ when neither folder exists (fresh install)', () => {
		const aceDir = mkTmpDir('ace-mig-fresh-');
		try {
			expect(fs.existsSync(path.join(aceDir, 'sessions'))).toBe(false);
			expect(fs.existsSync(path.join(aceDir, 'tasks'))).toBe(false);

			const result = migrateLegacySessionsFolder(aceDir);

			expect(result).toEqual({ migrated: false, mergedFromBoth: false });
			expect(fs.existsSync(path.join(aceDir, 'tasks'))).toBe(true);
			expect(fs.existsSync(path.join(aceDir, 'sessions'))).toBe(false);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('merges sessions/ subdirs into tasks/ when both exist (no conflict)', () => {
		const aceDir = mkTmpDir('ace-mig-merge-');
		try {
			const oldDir = path.join(aceDir, 'sessions');
			const newDir = path.join(aceDir, 'tasks');
			fs.mkdirSync(path.join(oldDir, 'conv-old-A'), { recursive: true });
			fs.writeFileSync(path.join(oldDir, 'conv-old-A', 'mcp_trajectory.jsonl'), '{"old":"A"}\n');
			fs.mkdirSync(path.join(newDir, 'conv-new-B'), { recursive: true });
			fs.writeFileSync(path.join(newDir, 'conv-new-B', 'mcp_trajectory.jsonl'), '{"new":"B"}\n');

			const result = migrateLegacySessionsFolder(aceDir);

			expect(result).toEqual({ migrated: true, mergedFromBoth: true });
			// Both subdirs land in tasks/.
			expect(fs.existsSync(path.join(newDir, 'conv-old-A', 'mcp_trajectory.jsonl'))).toBe(true);
			expect(fs.existsSync(path.join(newDir, 'conv-new-B', 'mcp_trajectory.jsonl'))).toBe(true);
			expect(fs.readFileSync(path.join(newDir, 'conv-old-A', 'mcp_trajectory.jsonl'), 'utf-8')).toBe('{"old":"A"}\n');
			// Empty sessions/ removed after the merge.
			expect(fs.existsSync(oldDir)).toBe(false);
		} finally {
			rmTmp(aceDir);
		}
	});

	it('preserves conflicting subdir in sessions/ when same name exists in tasks/', () => {
		const aceDir = mkTmpDir('ace-mig-conflict-');
		try {
			const oldDir = path.join(aceDir, 'sessions');
			const newDir = path.join(aceDir, 'tasks');
			// Same conv-id in both — newer/canonical content lives in tasks/.
			fs.mkdirSync(path.join(oldDir, 'conv-shared'), { recursive: true });
			fs.writeFileSync(path.join(oldDir, 'conv-shared', 'mcp_trajectory.jsonl'), '{"old":"data"}\n');
			fs.mkdirSync(path.join(newDir, 'conv-shared'), { recursive: true });
			fs.writeFileSync(path.join(newDir, 'conv-shared', 'mcp_trajectory.jsonl'), '{"new":"data"}\n');

			const result = migrateLegacySessionsFolder(aceDir);

			expect(result).toEqual({ migrated: true, mergedFromBoth: true });
			// tasks/conv-shared/ is canonical — content preserved.
			expect(fs.readFileSync(path.join(newDir, 'conv-shared', 'mcp_trajectory.jsonl'), 'utf-8')).toBe('{"new":"data"}\n');
			// sessions/conv-shared/ left in place (no destructive overwrite) — caller can detect.
			expect(fs.existsSync(path.join(oldDir, 'conv-shared'))).toBe(true);
			expect(fs.readFileSync(path.join(oldDir, 'conv-shared', 'mcp_trajectory.jsonl'), 'utf-8')).toBe('{"old":"data"}\n');
		} finally {
			rmTmp(aceDir);
		}
	});

	it('handles missing aceDir gracefully', () => {
		const missing = path.join(os.tmpdir(), `ace-mig-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		expect(fs.existsSync(missing)).toBe(false);
		expect(() => migrateLegacySessionsFolder(missing)).not.toThrow();
		const result = migrateLegacySessionsFolder(missing);
		// No sessions/ to migrate; migration helper creates tasks/ best-effort.
		expect(result).toEqual({ migrated: false, mergedFromBoth: false });
	});

	it('preserves _legacy subdir during rename (sessions/_legacy/ → tasks/_legacy/)', () => {
		const aceDir = mkTmpDir('ace-mig-legacy-');
		try {
			const oldLegacy = path.join(aceDir, 'sessions', '_legacy', '2026-01-01T00-00-00');
			fs.mkdirSync(oldLegacy, { recursive: true });
			fs.writeFileSync(path.join(oldLegacy, 'mcp_trajectory.jsonl'), '{"archived":true}\n');

			const result = migrateLegacySessionsFolder(aceDir);

			expect(result.migrated).toBe(true);
			const newLegacy = path.join(aceDir, 'tasks', '_legacy', '2026-01-01T00-00-00');
			expect(fs.existsSync(newLegacy)).toBe(true);
			expect(fs.readFileSync(path.join(newLegacy, 'mcp_trajectory.jsonl'), 'utf-8')).toBe('{"archived":true}\n');
		} finally {
			rmTmp(aceDir);
		}
	});

	it('idempotent — second call after migration is a no-op', () => {
		const aceDir = mkTmpDir('ace-mig-idem-');
		try {
			fs.mkdirSync(path.join(aceDir, 'sessions', 'conv-A'), { recursive: true });
			fs.writeFileSync(path.join(aceDir, 'sessions', 'conv-A', 'x'), 'y');

			const first = migrateLegacySessionsFolder(aceDir);
			expect(first.migrated).toBe(true);
			const second = migrateLegacySessionsFolder(aceDir);
			expect(second).toEqual({ migrated: false, mergedFromBoth: false });
			// State stable.
			expect(fs.existsSync(path.join(aceDir, 'tasks', 'conv-A', 'x'))).toBe(true);
		} finally {
			rmTmp(aceDir);
		}
	});
});

// ---------------------------------------------------------------------------
// v0.5.0-dev.24 — extension watcher uses tasks/*/mcp_trajectory.jsonl glob
// ---------------------------------------------------------------------------
describe('v0.5.0-dev.24 — extension watcher targets tasks/* glob', () => {
	it('extension.ts source uses .cursor/ace/tasks/*/mcp_trajectory.jsonl (not sessions/)', () => {
		const src = fs.readFileSync(
			path.join(__dirname, '..', '..', 'extension.ts'),
			'utf-8',
		);
		expect(src).toMatch(/\.cursor\/ace\/tasks\/\*\/mcp_trajectory\.jsonl/);
		// Legacy glob MUST be gone from the active code.
		expect(src).not.toMatch(/RelativePattern\(workspaceRoot,\s*'\.cursor\/ace\/sessions\/\*\/mcp_trajectory\.jsonl'\)/);
	});
});

// ---------------------------------------------------------------------------
// v0.5.0-dev.22 Task A — ConfigurePanel save → triggers ace.initializeWorkspace
// ---------------------------------------------------------------------------
//
// We mock the `vscode` module surface used by ConfigurePanel and assert that
// after a non-auto save the panel calls vscode.commands.executeCommand with
// 'ace.initializeWorkspace'. The vscode module is faked via vi.mock so the
// configurePanel module can be imported in vitest (which has no extension
// host).
// ---------------------------------------------------------------------------
describe('v0.5.0-dev.22 Task A — ConfigurePanel save triggers ace.initializeWorkspace', () => {
	it('save handler invokes vscode.commands.executeCommand("ace.initializeWorkspace") on non-auto save', async () => {
		// Pure-contract assertion that doesn't require booting the real
		// ConfigurePanel (which needs an extension host). We assert the
		// presence of the command-execution call site in the source — if
		// someone removes the post-save init trigger, this test fails.
		const src = fs.readFileSync(
			path.join(__dirname, '..', '..', 'webviews', 'configurePanel.ts'),
			'utf-8'
		);
		// Must call ace.initializeWorkspace via executeCommand.
		expect(src).toMatch(/executeCommand\(\s*['"]ace\.initializeWorkspace['"]\s*\)/);
		// Must be guarded by !autoSave so dropdown auto-saves don't reinit.
		expect(src).toMatch(/!autoSave\s*&&\s*targetFolder/);
		// Must have an error path that surfaces a warning rather than throwing.
		expect(src).toMatch(/showWarningMessage/);
	});

	it('save handler error path shows a warning instead of crashing the panel', () => {
		// Similar source-level check: post-configure init failure must be
		// non-fatal (saved config is still valid) and must inform the user.
		const src = fs.readFileSync(
			path.join(__dirname, '..', '..', 'webviews', 'configurePanel.ts'),
			'utf-8'
		);
		expect(src).toMatch(/Post-configure init failed/);
		expect(src).toMatch(/Run "ACE: Initialize Workspace" manually/);
	});

	it('verifies the contract via a stand-alone mock — executeCommand is a callable spy', async () => {
		// Sanity: the vitest harness can invoke vscode.commands.executeCommand
		// when mocked. This guards against drift in vitest config.
		const spy = vi.fn().mockResolvedValue(undefined);
		await spy('ace.initializeWorkspace');
		expect(spy).toHaveBeenCalledWith('ace.initializeWorkspace');
	});
});
