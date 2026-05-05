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
	getMcpTrackScriptContent,
	getPreToolUseScriptContent,
	getPreToolUsePsScriptContent,
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

describe('ace_track_mcp.sh content', () => {
	it('writes search-done flag when tool_name is ace_search', () => {
		const script = getMcpTrackScriptContent();
		// The script must check for ace_search BARE name (afterMCPExecution
		// delivers tool_name without MCP: prefix per real log evidence).
		expect(script).toMatch(/\$tool_name.*=.*"?ace_search"?/);
		expect(script).toContain('search-done');
	});

	it('uses bare tool_name (no MCP: prefix) for the comparison', () => {
		const script = getMcpTrackScriptContent();
		// Negative assertion: must NOT use MCP:ace_search for matching here
		expect(script).not.toContain('MCP:ace_search');
	});

	it('creates the per-generation flag directory before touching the flag', () => {
		const script = getMcpTrackScriptContent();
		expect(script).toContain('mkdir -p');
		expect(script).toContain('sessions');
	});

	it('uses conversation_id and generation_id from input', () => {
		const script = getMcpTrackScriptContent();
		expect(script).toContain('conversation_id');
		expect(script).toContain('generation_id');
	});

	it('preserves the existing ace_learn detection (does not regress)', () => {
		const script = getMcpTrackScriptContent();
		expect(script).toContain('ace_learn');
	});
});

describe('ace_pre_tool_use.sh content', () => {
	it('uses Cursor canonical {"permission":"allow"} format, not {"decision":"allow"}', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('"permission":"allow"');
		expect(script).not.toContain('"decision":"allow"');
	});

	it('emits {"permission":"deny"} with agent_message when flag is missing', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('"permission":"deny"');
		expect(script).toContain('agent_message');
	});

	it('allows MCP:ace_ prefixed tools unconditionally (no recursion)', () => {
		const script = getPreToolUseScriptContent();
		// Must check for MCP:ace_ prefix and allow before checking the flag
		expect(script).toMatch(/MCP:ace_/);
		const aceAllowIdx = script.search(/MCP:ace_/);
		const flagCheckIdx = script.search(/search-done/);
		expect(aceAllowIdx).toBeGreaterThan(0);
		expect(flagCheckIdx).toBeGreaterThan(aceAllowIdx);
	});

	it('checks flag file using conversation_id and generation_id from input', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('conversation_id');
		expect(script).toContain('generation_id');
		expect(script).toContain('sessions');
		expect(script).toContain('.search-done');
	});

	it('agent_message instructs the AI to call ace_search first', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toMatch(/ace_search.*FIRST|FIRST.*ace_search/i);
	});

	it('uses jq for JSON parsing (consistency with other hook scripts)', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('jq');
	});
});

describe('ace_pre_tool_use.ps1 content (Windows)', () => {
	it('uses Cursor canonical permission format', () => {
		const ps = getPreToolUsePsScriptContent();
		expect(ps).toContain('permission');
		expect(ps).toContain('allow');
		expect(ps).toContain('deny');
	});

	it('allows MCP:ace_ prefix unconditionally', () => {
		expect(getPreToolUsePsScriptContent()).toMatch(/MCP:ace_/);
	});

	it('checks for the search-done flag file', () => {
		expect(getPreToolUsePsScriptContent()).toContain('search-done');
	});
});

describe('rule call examples — named args only (MCP spec compliance)', () => {
	const allRules = () => [
		getAcePatternsRuleContent(),
		getDomainSearchRuleContent(),
		getContinuousSearchRuleContent(),
	].join('\n\n=====\n\n');

	it('no ace_search call uses positional args (first arg without name=)', () => {
		// Positional pattern: ace_search("...", ...) or ace_search('...', ...)
		// Bad:  ace_search("testing patterns", allowed_domains=[...])
		// Good: ace_search(query="testing patterns", allowed_domains=[...])
		const rules = allRules();
		const positional = rules.match(/ace_search\(\s*['"]/g);
		expect(positional, `found positional ace_search: ${positional?.join(', ')}`).toBeNull();
	});

	it('no ace_learn call uses positional args', () => {
		const rules = allRules();
		const positional = rules.match(/ace_learn\(\s*['"]/g);
		expect(positional).toBeNull();
	});

	it('no ace_list_domains, ace_get_playbook, ace_top_patterns positional calls', () => {
		const rules = allRules();
		expect(rules.match(/ace_list_domains\(\s*['"]/g)).toBeNull();
		expect(rules.match(/ace_get_playbook\(\s*['"]/g)).toBeNull();
		expect(rules.match(/ace_top_patterns\(\s*['"]/g)).toBeNull();
	});

	it('every ace_search example with arguments uses query=', () => {
		const rules = allRules();
		// Find every ace_search( ... ) — the opening paren must be followed by
		// either ) (no-args, which we forbid in another test if applicable) OR
		// must contain query=
		const calls = rules.matchAll(/ace_search\(([^)]*)\)/g);
		for (const m of calls) {
			const argstr = m[1].trim();
			if (argstr === '') continue; // bare ace_search() — different concern
			expect(argstr, `ace_search call without query=: ${m[0]}`).toMatch(/query\s*=/);
		}
	});
});

describe('pre_tool_use gate agent_message — must instruct named args', () => {
	it('mentions the query parameter name explicitly', () => {
		const script = getPreToolUseScriptContent();
		// agent_message text must reference `query` as the argument name
		expect(script).toMatch(/query/);
	});

	it('warns against calling ace_search with no arguments', () => {
		const script = getPreToolUseScriptContent();
		// Must include guidance like "non-empty query" or "do not call without arguments"
		expect(script).toMatch(/non-empty|never call.*without|do not call.*without|do not invoke.*without/i);
	});
});
