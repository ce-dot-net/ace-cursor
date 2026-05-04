import * as path from 'node:path';

/**
 * Canonical path to the ace-patterns rule file.
 *
 * Uses the folder-based RULE.md layout (Cursor 2.2+). The legacy
 * single-file path .cursor/rules/ace-patterns.mdc is no longer written
 * by this extension; the diagnostic must check the new location to
 * avoid false "rules not found" reports on migrated workspaces.
 */
export function getDiagnosticRulesPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.cursor', 'rules', 'ace-patterns', 'RULE.md');
}
