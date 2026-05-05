import { describe, it, expect } from 'vitest';
import {
    parseVersionFromExtensionDirName,
    pickDirsToCleanup,
} from '../../lifecycle/cleanupOldVersions';

describe('parseVersionFromExtensionDirName', () => {
    it('extracts version from canonical dir name', () => {
        expect(parseVersionFromExtensionDirName('ce-dot-net.cursor-ace-extension-0.2.71-universal'))
            .toBe('0.2.71');
        expect(parseVersionFromExtensionDirName('ce-dot-net.cursor-ace-extension-0.2.74-universal'))
            .toBe('0.2.74');
    });

    it('returns null for non-matching names', () => {
        expect(parseVersionFromExtensionDirName('something-else')).toBeNull();
        expect(parseVersionFromExtensionDirName('ce-dot-net.cursor-ace-extension-universal')).toBeNull();
    });
});

describe('pickDirsToCleanup', () => {
    it('returns dirs strictly older than current version', () => {
        const dirs = [
            'ce-dot-net.cursor-ace-extension-0.2.71-universal',
            'ce-dot-net.cursor-ace-extension-0.2.73-universal',
            'ce-dot-net.cursor-ace-extension-0.2.74-universal',
            'ce-dot-net.cursor-ace-extension-0.2.75-universal',
        ];
        const result = pickDirsToCleanup(dirs, '0.2.74', 'ce-dot-net.cursor-ace-extension-0.2.74-universal');
        expect(result).toEqual([
            'ce-dot-net.cursor-ace-extension-0.2.71-universal',
            'ce-dot-net.cursor-ace-extension-0.2.73-universal',
        ]);
    });

    it('does not include the current dir even if version matches', () => {
        const dirs = ['ce-dot-net.cursor-ace-extension-0.2.74-universal'];
        const result = pickDirsToCleanup(dirs, '0.2.74', 'ce-dot-net.cursor-ace-extension-0.2.74-universal');
        expect(result).toEqual([]);
    });

    it('does not include newer-version dirs (defensive — never downgrade-clean)', () => {
        const dirs = ['ce-dot-net.cursor-ace-extension-0.3.0-universal'];
        const result = pickDirsToCleanup(dirs, '0.2.74', 'ce-dot-net.cursor-ace-extension-0.2.74-universal');
        expect(result).toEqual([]);
    });

    it('skips dir names that do not parse to a version', () => {
        const dirs = [
            'ce-dot-net.cursor-ace-extension-0.2.71-universal',
            'unrelated-dir',
            'ce-dot-net.something-else',
        ];
        const result = pickDirsToCleanup(dirs, '0.2.74', 'ce-dot-net.cursor-ace-extension-0.2.74-universal');
        expect(result).toEqual(['ce-dot-net.cursor-ace-extension-0.2.71-universal']);
    });

    it('handles patch-version comparison correctly (semver-aware, not lexical)', () => {
        const dirs = [
            'ce-dot-net.cursor-ace-extension-0.2.9-universal',
            'ce-dot-net.cursor-ace-extension-0.2.10-universal',
        ];
        // 0.2.10 > 0.2.9 numerically (lexical would say "10" < "9")
        const result = pickDirsToCleanup(dirs, '0.2.10', 'ce-dot-net.cursor-ace-extension-0.2.10-universal');
        expect(result).toEqual(['ce-dot-net.cursor-ace-extension-0.2.9-universal']);
    });
});
