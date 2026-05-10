/**
 * Unit tests for rule content getters in src/ace/hookScripts.ts.
 * Covers: ace-patterns trigger phrasing + alwaysApply collapse on
 * the two secondary rules.
 */

import { describe, it, expect } from 'vitest';
import {
	getAcePatternsRuleContent,
	getDomainSearchRuleContent,
	getMcpTrackScriptContent,
	getPreToolUseScriptContent,
	getPreToolUsePsScriptContent,
} from '../../ace/hookScripts';

describe('ace-patterns RULE.mdc content', () => {
	// v0.5.0-dev.19 Task F — Cursor 3.0.16+ silently ignores alwaysApply: true
	// (forum.cursor.com/t/158551). Glob-based rules are unaffected per docs.
	// We now use globs: ["**/*"] in the rule frontmatter; the alwaysApply test
	// is replaced by a globs assertion. We don't forbid alwaysApply outright —
	// having both keys present remains valid YAML, just leave room.
	it('uses globs: ["**/*"] frontmatter (Cursor 3.0.16+ alwaysApply bug workaround)', () => {
		const content = getAcePatternsRuleContent();
		const fm = content.match(/^---[\s\S]*?---/);
		expect(fm, 'frontmatter not found').toBeTruthy();
		const block = fm![0];
		expect(block).toMatch(/globs\s*:\s*\[\s*"\*\*\/\*"\s*\]/);
	});

	it('does NOT use the legacy "EVERY NEW CHAT SESSION" trigger phrasing', () => {
		expect(getAcePatternsRuleContent()).not.toContain('EVERY NEW CHAT SESSION');
	});

	it('still names the ace_search tool explicitly', () => {
		expect(getAcePatternsRuleContent()).toContain('ace_search');
	});

	// v0.5.0-dev.13 — minimal rule. The rule used to mention several ACE
	// tools explicitly (even as "NEVER call X"). Naming a tool gives it
	// salience to the AI, which then explores the filesystem looking for
	// it. New rule lists ONLY ace_search.
	it('does NOT mention ace_get_playbook (forbidden tool naming)', () => {
		expect(getAcePatternsRuleContent()).not.toContain('ace_get_playbook');
	});

	it('does NOT mention ace_learn (forbidden tool naming)', () => {
		expect(getAcePatternsRuleContent()).not.toContain('ace_learn');
	});

	it('does NOT mention ace_list_domains (forbidden tool naming)', () => {
		expect(getAcePatternsRuleContent()).not.toContain('ace_list_domains');
	});

	it('does NOT mention ace_status (forbidden tool naming)', () => {
		expect(getAcePatternsRuleContent()).not.toContain('ace_status');
	});

	it('does NOT contain a retry / missing_required_arguments section', () => {
		const content = getAcePatternsRuleContent();
		expect(content).not.toMatch(/missing_required_arguments/);
		expect(content).not.toMatch(/retry/i);
	});

	it('does NOT mention trajectory (legacy ace_learn schema)', () => {
		expect(getAcePatternsRuleContent()).not.toMatch(/trajectory/i);
	});

	it('does NOT mention Cursor 150043 / CallMcpTool bug (rule-layer noise)', () => {
		const content = getAcePatternsRuleContent();
		expect(content).not.toMatch(/150043/);
		expect(content).not.toMatch(/CallMcpTool/);
	});

	it('rule body is short (<1500 chars) — forces brevity', () => {
		expect(getAcePatternsRuleContent().length).toBeLessThan(1500);
	});

	it('contains ace_search at most twice (no repetition)', () => {
		const content = getAcePatternsRuleContent();
		const matches = content.match(/ace_search/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches.length).toBeLessThanOrEqual(2);
	});
});

describe('ace-domain-search RULE.mdc content', () => {
	it('has alwaysApply: false (pulled by description on relevance)', () => {
		expect(getDomainSearchRuleContent()).toMatch(/^---[\s\S]*?alwaysApply:\s*false[\s\S]*?---/);
	});

	it('has a non-empty description: in frontmatter', () => {
		const m = getDomainSearchRuleContent().match(/^---[\s\S]*?description:\s*(.+?)\s*\n[\s\S]*?---/);
		expect(m, 'description field not found').toBeTruthy();
		expect(m![1].trim().length).toBeGreaterThan(10);
	});
});

// v0.5.0-dev.4 — ace-continuous-search rule retired (Stop hook + domain-shift
// inject + auto-injection make it redundant; "call ace_learn at end" instruction
// contradicted v0.5.0 architecture).

describe('rule getters return non-empty strings', () => {
	it('both surviving getters return non-empty markdown', () => {
		expect(getAcePatternsRuleContent().length).toBeGreaterThan(100);
		expect(getDomainSearchRuleContent().length).toBeGreaterThan(100);
	});
});

// ===========================================================================
// v0.5.0-dev.19 Task A — per-conversation trajectory rotation
// ===========================================================================
describe('ace_track_mcp.sh — Task A per-conversation trajectory rotation', () => {
	const writeScript = async (content: string) => {
		const fsMod = await import('node:fs');
		const osMod = await import('node:os');
		const pathMod = await import('node:path');
		const tmp = pathMod.join(osMod.tmpdir(), `ace-mcptrack-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
		fsMod.writeFileSync(tmp, content, { mode: 0o755 });
		return { tmp, fsMod, osMod, pathMod };
	};

	it('source mentions tasks/<conv_id>/mcp_trajectory.jsonl path', () => {
		const script = getMcpTrackScriptContent();
		expect(script).toContain('tasks/$conv_id_for_traj');
		// The script materializes the per-conv path through $per_conv_dir.
		expect(script).toMatch(/per_conv_dir="\$ace_dir\/tasks\/\$conv_id_for_traj"/);
		expect(script).toMatch(/per_conv_dir\/mcp_trajectory\.jsonl/);
	});

	it('source still falls back to top-level path when conv_id is missing', () => {
		const script = getMcpTrackScriptContent();
		// Top-level fallback path is still written for backwards compat.
		expect(script).toMatch(/echo "\$input" >> "\$ace_dir\/mcp_trajectory\.jsonl"/);
	});

	it('runtime — writes to per-conv subdir when conversation_id present', async () => {
		const { execFileSync } = await import('node:child_process');
		const { tmp, fsMod, osMod, pathMod } = await writeScript(getMcpTrackScriptContent());
		const cwd = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mcptrack-cwd-'));
		try {
			execFileSync('bash', [tmp], {
				input: JSON.stringify({
					tool_name: 'Bash',
					tool_input: '{"command":"ls"}',
					conversation_id: 'conv-A1',
				}),
				encoding: 'utf-8',
				cwd,
			});
			const perConvPath = pathMod.join(cwd, '.cursor', 'ace', 'tasks', 'conv-A1', 'mcp_trajectory.jsonl');
			expect(fsMod.existsSync(perConvPath), `expected per-conv jsonl at ${perConvPath}`).toBe(true);
			const content = fsMod.readFileSync(perConvPath, 'utf-8');
			expect(content).toMatch(/conv-A1/);
			// Top-level should NOT be written when conv_id present.
			const topLevel = pathMod.join(cwd, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fsMod.existsSync(topLevel)).toBe(false);
		} finally {
			fsMod.unlinkSync(tmp);
			fsMod.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it('runtime — falls back to top-level when conversation_id missing', async () => {
		const { execFileSync } = await import('node:child_process');
		const { tmp, fsMod, osMod, pathMod } = await writeScript(getMcpTrackScriptContent());
		const cwd = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mcptrack-fallback-'));
		try {
			execFileSync('bash', [tmp], {
				input: JSON.stringify({
					tool_name: 'Bash',
					tool_input: '{"command":"ls"}',
					// no conversation_id
				}),
				encoding: 'utf-8',
				cwd,
			});
			const topLevel = pathMod.join(cwd, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fsMod.existsSync(topLevel)).toBe(true);
		} finally {
			fsMod.unlinkSync(tmp);
			fsMod.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it('runtime — multiple conv_ids produce isolated jsonl files', async () => {
		const { execFileSync } = await import('node:child_process');
		const { tmp, fsMod, osMod, pathMod } = await writeScript(getMcpTrackScriptContent());
		const cwd = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'mcptrack-multi-'));
		try {
			for (const conv of ['conv-X', 'conv-Y', 'conv-X']) {
				execFileSync('bash', [tmp], {
					input: JSON.stringify({
						tool_name: 'Read',
						tool_input: '{}',
						conversation_id: conv,
					}),
					encoding: 'utf-8',
					cwd,
				});
			}
			const xPath = pathMod.join(cwd, '.cursor', 'ace', 'tasks', 'conv-X', 'mcp_trajectory.jsonl');
			const yPath = pathMod.join(cwd, '.cursor', 'ace', 'tasks', 'conv-Y', 'mcp_trajectory.jsonl');
			expect(fsMod.existsSync(xPath)).toBe(true);
			expect(fsMod.existsSync(yPath)).toBe(true);
			expect(fsMod.readFileSync(xPath, 'utf-8').split('\n').filter(Boolean).length).toBe(2);
			expect(fsMod.readFileSync(yPath, 'utf-8').split('\n').filter(Boolean).length).toBe(1);
		} finally {
			fsMod.unlinkSync(tmp);
			fsMod.rmSync(cwd, { recursive: true, force: true });
		}
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
		expect(script).toContain('tasks');
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

// v0.3.1+ retired the preToolUse "search-first" gate (deny + agent_message).
// v0.4.0 retired the helper.js subprocess that replaced it. Pattern injection
// now lives in postToolUse via additional_context (covered by
// src/test/unit/v04-security-cli.test.ts). The two getters below survive only
// to write a fail-open allow stub for any orphan workspace still wired to the
// retired hook path.
describe('ace_pre_tool_use.sh content (v0.4.0 fail-open stub)', () => {
	it('emits canonical {"permission":"allow"} (no decision: format)', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('"permission":"allow"');
		expect(script).not.toContain('"decision":"allow"');
	});
});

describe('ace_pre_tool_use.ps1 content (v0.4.0 fail-open stub)', () => {
	it('emits canonical permission format', () => {
		const ps = getPreToolUsePsScriptContent();
		expect(ps).toContain('permission');
		expect(ps).toContain('allow');
	});
});

describe('rule call examples — named args only (MCP spec compliance)', () => {
	const allRules = () => [
		getAcePatternsRuleContent(),
		getDomainSearchRuleContent(),
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

// v0.4.0: gate agent_message tests retired with the gate. Named-args guidance
// now lives in the rules (covered by 'rule call examples — named args only').

describe('pre_tool_use script — bash syntax + runtime regression guards', () => {
	// v0.2.76 shipped a broken script (line 39 unmatched single-quote inside an
	// echo of a JSON string with embedded apostrophe). Fix uses a single-quoted
	// heredoc instead of escape-laden echo. These tests guard against ever
	// shipping a syntactically broken hook script again — they invoke bash -n
	// and run the script with mock input via execFileSync (no shell pipe).
	const writeScript = async (content: string) => {
		const fs = await import('node:fs');
		const os = await import('node:os');
		const path = await import('node:path');
		const tmp = path.join(os.tmpdir(), `ace-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
		fs.writeFileSync(tmp, content, { mode: 0o755 });
		return { tmp, fs };
	};

	it('bash -n parses the gate script with no syntax errors', async () => {
		const { execFileSync } = await import('node:child_process');
		const script = getPreToolUseScriptContent();
		const { tmp, fs } = await writeScript(script);
		try {
			// bash -n: parse only, no execute. Throws on syntax error.
			execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it('emits canonical {"permission":"allow"} for any tool input (v0.4.0 fail-open stub)', async () => {
		const { execFileSync } = await import('node:child_process');
		const script = getPreToolUseScriptContent();
		const { tmp, fs } = await writeScript(script);
		try {
			const out = execFileSync('bash', [tmp], {
				input: '{"tool_name":"Grep","conversation_id":"c1","generation_id":"g1"}',
				encoding: 'utf-8',
			});
			const parsed = JSON.parse(out.trim());
			expect(parsed.permission).toBe('allow');
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it('emits valid JSON on the allow path (MCP:ace_search)', async () => {
		const { execFileSync } = await import('node:child_process');
		const script = getPreToolUseScriptContent();
		const { tmp, fs } = await writeScript(script);
		try {
			const out = execFileSync('bash', [tmp], {
				input: '{"tool_name":"MCP:ace_search","conversation_id":"c1","generation_id":"g1"}',
				encoding: 'utf-8',
			});
			const parsed = JSON.parse(out.trim());
			expect(parsed.permission).toBe('allow');
		} finally {
			fs.unlinkSync(tmp);
		}
	});
});

describe('hook scripts — Cursor canonical permission schema (no Claude-Code "decision" key)', () => {
	const readExt = async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		return fs.readFileSync(path.resolve(__dirname, '../../extension.ts'), 'utf-8');
	};

	it('no hook script in extension.ts emits {"decision":"allow"} (Claude Code legacy format)', async () => {
		const src = await readExt();
		// Pattern: literal "decision":"allow" or "decision": "allow" anywhere.
		// This catches both bash echo single-quoted and JS-template escaped variants.
		const matches = src.match(/"decision"\s*:\s*"allow"/g);
		expect(matches, `found ${matches?.length} legacy decision-format strings`).toBeNull();
	});

	it('no hook script in extension.ts emits {"decision":"deny"}', async () => {
		const src = await readExt();
		expect(src.match(/"decision"\s*:\s*"deny"/g)).toBeNull();
	});

	it('blocking hooks use {"permission":"allow"} canonical format', async () => {
		const src = await readExt();
		// At least 5 occurrences (the 5 blocking bash hooks) plus their PS1 twins
		const matches = src.match(/"permission"\s*:\s*"allow"/g);
		expect(matches?.length ?? 0, 'expected ≥5 permission:"allow" sites in extension.ts').toBeGreaterThanOrEqual(5);
	});
});

// v0.5.0-dev.13 — Cursor 150043 / CallMcpTool bug mitigation moved entirely
// out of the rule layer (which is now minimal). The schema_violation_detected
// log path still lives in ace_track_mcp.sh — covered below.
describe('Cursor CallMcpTool bug mitigation (script-level)', () => {
	it('ace_track_mcp.sh detects empty-args ace_search/ace_learn', () => {
		const script = getMcpTrackScriptContent();
		expect(script).toContain('schema_violation_detected');
		expect(script).toContain('ace_learn');
		// must check for empty/null tool_input
		expect(script).toMatch(/tool_input.*empty|is_empty/);
	});
});

describe('gate enforcement — search-only allow-list (v0.2.80)', () => {
	const writeScript = async (content: string) => {
		const fs = await import('node:fs');
		const os = await import('node:os');
		const path = await import('node:path');
		const tmp = path.join(os.tmpdir(), `ace-gate-v80-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
		fs.writeFileSync(tmp, content, { mode: 0o755 });
		return { tmp, fs };
	};

	const runGate = async (toolName: string, withFlag = false) => {
		const { execFileSync } = await import('node:child_process');
		const fs = await import('node:fs');
		const os = await import('node:os');
		const path = await import('node:path');
		const script = getPreToolUseScriptContent();
		const { tmp, fs: fsMod } = await writeScript(script);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-gate-cwd-'));
		try {
			if (withFlag) {
				const flagDir = path.join(cwd, '.cursor', 'ace', 'tasks', 'c1');
				fs.mkdirSync(flagDir, { recursive: true });
				fs.writeFileSync(path.join(flagDir, 'g1.search-done'), '');
			}
			const out = execFileSync('bash', [tmp], {
				input: JSON.stringify({ tool_name: toolName, conversation_id: 'c1', generation_id: 'g1' }),
				encoding: 'utf-8',
				cwd,
			});
			return JSON.parse(out.trim());
		} finally {
			fsMod.unlinkSync(tmp);
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	};

	// v0.5.0-dev.4: ace_get_playbook + ace_learn are now SPECIAL-CASED in the
	// preToolUse gate (silent rewrite + silent deny respectively). All other
	// ace_* tools still pass through unconditionally.
	it('ALLOWS most ace_* MCP tools unconditionally', async () => {
		for (const t of [
			'MCP:ace_search',
			'MCP:ace_top_patterns',
			'MCP:ace_list_domains',
			'MCP:ace_status',
			'MCP:ace_delta',
			'MCP:ace_clear',
			'MCP:ace_batch_get',
			'MCP:ace_bootstrap',
		]) {
			const r = await runGate(t, false);
			expect(r.permission, `expected allow for ${t} (no flag)`).toBe('allow');
			const r2 = await runGate(t, true);
			expect(r2.permission, `expected allow for ${t} (with flag)`).toBe('allow');
		}
	});

	it('REWRITES MCP:ace_get_playbook to ace_search via updated_input (TASK 2)', async () => {
		const r = await runGate('MCP:ace_get_playbook', false);
		expect(r.permission).toBe('allow');
		expect(r.updated_input).toBeDefined();
		expect(r.updated_input.name).toBe('ace_search');
		expect(r.updated_input.arguments.query).toBeDefined();
	});

	it('ALLOWS MCP:ace_learn as fallback (v0.5.0-dev.10+ — Stop hook may fail on Cursor stripped PATH)', async () => {
		const r = await runGate('MCP:ace_learn', false);
		// Was deny in earlier dev builds. Now allow so AI can fall back when
		// the extension Stop hook can't run the helper (e.g. PATH missing node).
		expect(r.permission).toBe('allow');
		// No agent_message — AI calls ace_learn at its own discretion.
		expect(r.agent_message).toBeUndefined();
	});
});
