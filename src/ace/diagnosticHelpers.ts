import * as path from 'node:path';

/**
 * Canonical path to the ace-patterns rule file.
 *
 * Uses the folder-based RULE.mdc layout (Cursor 2.2+). v0.5.0-dev.21
 * flipped the extension from .md to .mdc — per Cursor docs (cursor.com/docs/rules)
 * .md files are @-mention-only, while .mdc with frontmatter triggers
 * auto-attach via globs. The legacy single-file path .cursor/rules/ace-patterns.mdc
 * is no longer written; the diagnostic must check the folder-based location
 * to avoid false "rules not found" reports on migrated workspaces.
 */
export function getDiagnosticRulesPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.cursor', 'rules', 'ace-patterns', 'RULE.mdc');
}
