/**
 * Unit tests for rule content getters in src/ace/hookScripts.ts.
 * Covers: ace-patterns trigger phrasing + alwaysApply collapse on
 * the two secondary rules.
 */

import { describe, it, expect } from 'vitest';
import {
	getAcePatternsRuleContent,
	getDomainSearchRuleContent,
	getContinuousSearchRuleContent,
} from '../../ace/hookScripts';

describe('ace-patterns RULE.md content', () => {
	it('keeps alwaysApply: true (primary always-on rule)', () => {
		expect(getAcePatternsRuleContent()).toMatch(/^---[\s\S]*?alwaysApply:\s*true[\s\S]*?---/);
	});

	it('does NOT use the legacy "EVERY NEW CHAT SESSION" trigger phrasing', () => {
		expect(getAcePatternsRuleContent()).not.toContain('EVERY NEW CHAT SESSION');
	});

	it('uses the per-prompt "first response in this conversation" trigger', () => {
		const content = getAcePatternsRuleContent();
		expect(content).toContain('first response in this conversation');
	});

	it('still names the ace_search tool explicitly', () => {
		expect(getAcePatternsRuleContent()).toContain('ace_search');
	});
});

describe('ace-domain-search RULE.md content', () => {
	it('has alwaysApply: false (pulled by description on relevance)', () => {
		expect(getDomainSearchRuleContent()).toMatch(/^---[\s\S]*?alwaysApply:\s*false[\s\S]*?---/);
	});

	it('has a non-empty description: in frontmatter', () => {
		const m = getDomainSearchRuleContent().match(/^---[\s\S]*?description:\s*(.+?)\s*\n[\s\S]*?---/);
		expect(m, 'description field not found').toBeTruthy();
		expect(m![1].trim().length).toBeGreaterThan(10);
	});
});

describe('ace-continuous-search RULE.md content', () => {
	it('has alwaysApply: false', () => {
		expect(getContinuousSearchRuleContent()).toMatch(/^---[\s\S]*?alwaysApply:\s*false[\s\S]*?---/);
	});

	it('has a non-empty description: in frontmatter', () => {
		const m = getContinuousSearchRuleContent().match(/^---[\s\S]*?description:\s*(.+?)\s*\n[\s\S]*?---/);
		expect(m, 'description field not found').toBeTruthy();
		expect(m![1].trim().length).toBeGreaterThan(10);
	});
});

describe('rule getters return non-empty strings', () => {
	it('all three getters return non-empty markdown', () => {
		expect(getAcePatternsRuleContent().length).toBeGreaterThan(100);
		expect(getDomainSearchRuleContent().length).toBeGreaterThan(100);
		expect(getContinuousSearchRuleContent().length).toBeGreaterThan(100);
	});
});
