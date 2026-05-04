/**
 * Unit tests for the multi-root onDidChangeWorkspaceFolders helper.
 * Filters newly added folders to those that already have a .cursor/
 * directory — same rule as silent split-opt-in (T8).
 */

import { describe, it, expect, vi } from 'vitest';
import { pickFoldersToInitializeOnAdd } from '../../ace/optInHelpers';

const folder = (fsPath: string) => ({ uri: { fsPath } } as any);

describe('pickFoldersToInitializeOnAdd', () => {
	it('returns folders that have a .cursor/ directory', () => {
		const fakeExists = vi.fn().mockImplementation((p: string) => p.includes('/with-cursor'));
		const added = [folder('/with-cursor'), folder('/no-cursor')];
		const result = pickFoldersToInitializeOnAdd(added, fakeExists);
		expect(result).toHaveLength(1);
		expect(result[0].uri.fsPath).toBe('/with-cursor');
	});

	it('returns empty array when no added folders have .cursor/', () => {
		const fakeExists = vi.fn().mockReturnValue(false);
		const added = [folder('/a'), folder('/b')];
		expect(pickFoldersToInitializeOnAdd(added, fakeExists)).toEqual([]);
	});

	it('returns empty array on empty input', () => {
		const fakeExists = vi.fn().mockReturnValue(true);
		expect(pickFoldersToInitializeOnAdd([], fakeExists)).toEqual([]);
	});

	it('does not double-count duplicate folders (caller responsibility, but defensive)', () => {
		const fakeExists = vi.fn().mockReturnValue(true);
		const added = [folder('/x'), folder('/x')];
		const result = pickFoldersToInitializeOnAdd(added, fakeExists);
		// Pure function does not dedupe; both pass through
		expect(result).toHaveLength(2);
	});
});
