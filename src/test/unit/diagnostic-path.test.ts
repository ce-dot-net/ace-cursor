/**
 * Unit test for getDiagnosticRulesPath — returns the canonical path
 * to ace-patterns rule file using the folder-based RULE.mdc layout
 * (Cursor 2.2+), not the legacy ace-patterns.mdc single-file format.
 */

import { describe, it, expect } from 'vitest';
import { getDiagnosticRulesPath } from '../../ace/diagnosticHelpers';

describe('getDiagnosticRulesPath', () => {
	it('returns folder-based RULE.mdc path for given workspace root', () => {
		const result = getDiagnosticRulesPath('/fake/root');
		expect(result).toContain('ace-patterns');
		expect(result).toContain('RULE.mdc');
	});

	it('uses the .cursor/rules/ace-patterns/RULE.mdc layout', () => {
		const result = getDiagnosticRulesPath('/fake/root');
		// Order check: .cursor → rules → ace-patterns → RULE.mdc
		expect(result).toMatch(/\.cursor[/\\]rules[/\\]ace-patterns[/\\]RULE\.mdc$/);
	});

	it('does NOT use legacy flat single-file ace-patterns.mdc path', () => {
		const result = getDiagnosticRulesPath('/fake/root');
		// Negative: must NOT be the flat .cursor/rules/ace-patterns.mdc file.
		// Folder-based path is .cursor/rules/ace-patterns/RULE.mdc — assert that
		// the basename is RULE.mdc (i.e. there is a separator before .mdc, not
		// "ace-patterns.mdc" as a leaf filename).
		expect(result).not.toMatch(/[/\\]ace-patterns\.mdc$/);
	});

	it('joins with the provided workspace root', () => {
		const result = getDiagnosticRulesPath('/some/ws');
		expect(result.startsWith('/some/ws')).toBe(true);
	});
});
