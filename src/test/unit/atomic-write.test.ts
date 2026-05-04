/**
 * Unit tests for writeFileAtomic — write to <path>.tmp then rename.
 * Prevents partial reads if Cursor's hook engine reads a file mid-write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { writeFileAtomic } from '../../ace/atomicWrite';

vi.mock('node:fs', () => ({
	writeFileSync: vi.fn(),
	renameSync: vi.fn(),
}));

describe('writeFileAtomic', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('writes content to <path>.tmp then renames to final path', () => {
		writeFileAtomic('/some/path/file.sh', 'hello');
		expect(fs.writeFileSync).toHaveBeenCalledWith('/some/path/file.sh.tmp', 'hello', {});
		expect(fs.renameSync).toHaveBeenCalledWith('/some/path/file.sh.tmp', '/some/path/file.sh');
	});

	it('passes options (e.g. mode) through to writeFileSync', () => {
		writeFileAtomic('/p/script.sh', 'content', { mode: 0o755 });
		expect(fs.writeFileSync).toHaveBeenCalledWith('/p/script.sh.tmp', 'content', { mode: 0o755 });
	});

	it('writes before renaming (sequence matters)', () => {
		const order: string[] = [];
		(fs.writeFileSync as any).mockImplementation(() => order.push('write'));
		(fs.renameSync as any).mockImplementation(() => order.push('rename'));
		writeFileAtomic('/p/x.txt', 'y');
		expect(order).toEqual(['write', 'rename']);
	});
});
