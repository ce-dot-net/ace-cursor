/**
 * Unit tests for the surgical ace-hooks removal from a parsed hooks.json.
 * The helper preserves user customizations: only entries whose command
 * references an ace_* script are removed; empty hook arrays are dropped.
 */

import { describe, it, expect } from 'vitest';
import { removeAceHooksFromHooksJson } from '../../ace/uninstallHelpers';

describe('removeAceHooksFromHooksJson', () => {
	it('removes entries whose command references an ace_* script', () => {
		const input = {
			version: 1,
			hooks: {
				sessionStart: [
					{ command: '.cursor/scripts/ace_session_start.sh' },
					{ command: 'user_session_start.sh' },
				],
			},
		};
		const result = removeAceHooksFromHooksJson(input);
		expect(result.hooks!.sessionStart).toHaveLength(1);
		expect(result.hooks!.sessionStart[0].command).toBe('user_session_start.sh');
	});

	it('deletes hook keys that become empty after filtering', () => {
		const input = {
			version: 1,
			hooks: {
				stop: [{ command: '.cursor/scripts/ace_stop_hook.sh' }],
				preToolUse: [{ command: 'user_validation.sh' }],
			},
		};
		const result = removeAceHooksFromHooksJson(input);
		expect(result.hooks!.stop).toBeUndefined();
		expect(result.hooks!.preToolUse).toBeDefined();
	});

	it('preserves the version field and unrelated keys', () => {
		const input = {
			version: 1,
			hooks: { afterFileEdit: [{ command: 'format.sh' }] },
			somethingElse: 'preserve me',
		} as any;
		const result = removeAceHooksFromHooksJson(input) as any;
		expect(result.version).toBe(1);
		expect(result.somethingElse).toBe('preserve me');
		expect(result.hooks.afterFileEdit).toEqual([{ command: 'format.sh' }]);
	});

	it('handles a hooks.json with no ace entries (no-op)', () => {
		const input = {
			version: 1,
			hooks: { sessionStart: [{ command: 'something_user.sh' }] },
		};
		const result = removeAceHooksFromHooksJson(input);
		expect(result).toEqual(input);
	});

	it('handles a hooks.json that is entirely ace (returns empty hooks object)', () => {
		const input = {
			version: 1,
			hooks: {
				sessionStart: [{ command: '.cursor/scripts/ace_session_start.sh' }],
				stop: [{ command: '.cursor/scripts/ace_stop_hook.sh' }],
			},
		};
		const result = removeAceHooksFromHooksJson(input);
		expect(result.hooks).toEqual({});
		expect(result.version).toBe(1);
	});

	it('handles missing hooks key gracefully', () => {
		const input = { version: 1 } as any;
		const result = removeAceHooksFromHooksJson(input) as any;
		expect(result).toEqual({ version: 1 });
	});

	it('handles entries with no command field (defensive)', () => {
		const input = {
			version: 1,
			hooks: {
				sessionStart: [
					{ command: 'ace_x.sh' },
					{ /* no command */ } as any,
				],
			},
		};
		const result = removeAceHooksFromHooksJson(input);
		expect(result.hooks!.sessionStart).toHaveLength(1);
	});

	it('does not mutate the input object', () => {
		const input = {
			version: 1,
			hooks: { sessionStart: [{ command: 'ace_x.sh' }, { command: 'user.sh' }] },
		};
		const snapshot = JSON.parse(JSON.stringify(input));
		removeAceHooksFromHooksJson(input);
		expect(input).toEqual(snapshot);
	});
});
