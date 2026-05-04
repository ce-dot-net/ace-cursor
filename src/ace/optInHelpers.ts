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
