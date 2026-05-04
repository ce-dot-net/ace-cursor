import * as path from 'node:path';

/**
 * Decide whether to write ACE hooks + rules without showing the opt-in modal.
 *
 * Returns true if the workspace already has a .cursor/ directory — meaning
 * the user is already using Cursor seriously in this folder. Writing rules
 * + hooks there is cheap, idempotent, and provides ace_search enforcement
 * even when the user dismisses the MCP-registration opt-in modal.
 *
 * Returns false for ad-hoc /tmp scratch folders with no .cursor/ — those
 * stay out of scope (no disk pollution).
 *
 * MCP registration is STILL gated on explicit "Yes, enable" in the modal.
 * This helper only controls the hooks-and-rules side of opt-in.
 */
export function shouldWriteHooksAndRulesWithoutOptin(
	wsRoot: string | undefined,
	existsSync: (p: string) => boolean
): boolean {
	if (!wsRoot) return false;
	return existsSync(path.join(wsRoot, '.cursor'));
}

/**
 * From a list of newly added workspace folders, pick those that have
 * a .cursor/ directory and should therefore receive hooks + rules
 * (silent split-opt-in pattern, see shouldWriteHooksAndRulesWithoutOptin).
 *
 * Pure function — caller (activate's onDidChangeWorkspaceFolders handler)
 * does the actual createCursorHooks / createCursorRules calls.
 */
export function pickFoldersToInitializeOnAdd<T extends { uri: { fsPath: string } }>(
	addedFolders: readonly T[],
	existsSync: (p: string) => boolean
): T[] {
	const out: T[] = [];
	for (const f of addedFolders) {
		if (existsSync(path.join(f.uri.fsPath, '.cursor'))) {
			out.push(f);
		}
	}
	return out;
}
