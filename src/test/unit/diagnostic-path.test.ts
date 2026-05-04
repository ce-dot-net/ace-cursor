/**
 * Unit test for getDiagnosticRulesPath — returns the canonical path
 * to ace-patterns rule file using the folder-based RULE.md layout
 * (Cursor 2.2+), not the legacy ace-patterns.mdc single-file format.
 */

import { describe, it, expect } from 'vitest';
import { getDiagnosticRulesPath } from '../../ace/diagnosticHelpers';

describe('getDiagnosticRulesPath', () => {
	it('returns folder-based RULE.md path for given workspace root', () => {
		const result = getDiagnosticRulesPath('/fake/root');
		expect(result).toContain('ace-patterns');
		expect(result).toContain('RULE.md');
	});

	it('uses the .cursor/rules/ace-patterns/RULE.md layout', () => {
		const result = getDiagnosticRulesPath('/fake/root');
		// Order check: .cursor → rules → ace-patterns → RULE.md
		expect(result).toMatch(/\.cursor[/\\]rules[/\\]ace-patterns[/\\]RULE\.md$/);
	});

	it('does NOT use legacy single-file ace-patterns.mdc path', () => {
		const result = getDiagnosticRulesPath('/fake/root');
		expect(result).not.toMatch(/ace-patterns\.mdc/);
	});

	it('joins with the provided workspace root', () => {
		const result = getDiagnosticRulesPath('/some/ws');
		expect(result.startsWith('/some/ws')).toBe(true);
	});
});
