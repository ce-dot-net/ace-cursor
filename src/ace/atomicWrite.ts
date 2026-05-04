import * as fs from 'node:fs';

/**
 * Write file atomically: write to <path>.tmp then rename.
 *
 * Prevents partial reads if Cursor's hook engine (or any other concurrent
 * reader) opens the file mid-write. Used by createCursorHooks and
 * createCursorRules in extension.ts.
 */
export function writeFileAtomic(
	filePath: string,
	content: string | NodeJS.ArrayBufferView,
	options?: fs.WriteFileOptions
): void {
	const tmpPath = filePath + '.tmp';
	fs.writeFileSync(tmpPath, content, options ?? {});
	fs.renameSync(tmpPath, filePath);
}
