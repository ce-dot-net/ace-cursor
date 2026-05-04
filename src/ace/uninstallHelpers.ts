/**
 * Pure helpers for ACE uninstall cleanup.
 *
 * The interactive command lives in extension.ts. This module contains
 * the unit-testable filter logic that removes ace_* hook entries from
 * a parsed hooks.json while preserving user customizations.
 */

interface HookEntry {
	command?: string;
	[key: string]: unknown;
}

interface HooksJson {
	version?: number;
	hooks?: Record<string, HookEntry[]>;
	[key: string]: unknown;
}

/**
 * Return a new HooksJson object with ace_* hook entries filtered out.
 * Pure: does not mutate the input.
 *
 * - An entry is "ace" iff its command references an "ace_" prefix (e.g.
 *   ".cursor/scripts/ace_session_start.sh", "ace_stop_hook.sh").
 * - Hook keys with zero entries after filtering are deleted (Cursor
 *   loads empty arrays as no-op but cleaner files are easier to read).
 * - Top-level keys other than "hooks" are preserved verbatim.
 */
export function removeAceHooksFromHooksJson(input: HooksJson): HooksJson {
	const out: HooksJson = { ...input };
	if (!input.hooks) return out;
	const newHooks: Record<string, HookEntry[]> = {};
	for (const [key, entries] of Object.entries(input.hooks)) {
		const filtered = entries.filter(e => !String(e.command ?? '').includes('ace_'));
		if (filtered.length > 0) {
			newHooks[key] = filtered;
		}
	}
	out.hooks = newHooks;
	return out;
}
