/**
 * Unit tests for the split opt-in helper. Decides whether to write
 * hooks + rules silently (without showing the opt-in modal) based on
 * whether the workspace already has a .cursor/ directory.
 */

import { describe, it, expect, vi } from 'vitest';
import { shouldWriteHooksAndRulesWithoutOptin } from '../../ace/optInHelpers';

describe('shouldWriteHooksAndRulesWithoutOptin', () => {
	it('returns true when .cursor/ exists in workspace root', () => {
		const fakeExists = vi.fn().mockImplementation((p: string) => p.endsWith('/.cursor'));
		expect(shouldWriteHooksAndRulesWithoutOptin('/some/ws', fakeExists)).toBe(true);
	});

	it('returns false when .cursor/ does not exist', () => {
		const fakeExists = vi.fn().mockReturnValue(false);
		expect(shouldWriteHooksAndRulesWithoutOptin('/tmp/scratch', fakeExists)).toBe(false);
	});

	it('returns false when wsRoot is undefined or empty', () => {
		const fakeExists = vi.fn().mockReturnValue(true);
		expect(shouldWriteHooksAndRulesWithoutOptin(undefined, fakeExists)).toBe(false);
		expect(shouldWriteHooksAndRulesWithoutOptin('', fakeExists)).toBe(false);
	});

	it('checks the correct path (workspace root + .cursor)', () => {
		const fakeExists = vi.fn().mockReturnValue(true);
		shouldWriteHooksAndRulesWithoutOptin('/my/proj', fakeExists);
		expect(fakeExists).toHaveBeenCalledWith(expect.stringMatching(/\/my\/proj[/\\]\.cursor$/));
	});
});
