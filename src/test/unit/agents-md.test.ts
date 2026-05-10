/**
 * v0.5.0-dev.19 Task G — Workspace-root AGENTS.md tests.
 *
 * Cursor's AGENTS.md auto-load is unaffected by the Cursor 3.0.16+
 * alwaysApply rule bug. We assert:
 *   1. getAgentsMdContent() emits a non-empty markdown body that mentions
 *      ace_search exactly once or twice (no spam, no forbidden tool names).
 *   2. The activate() block in extension.ts writes AGENTS.md at the
 *      workspace root ONLY when it doesn't already exist (never overwrites
 *      a user-customized file).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAgentsMdContent } from '../../ace/hookScripts';

const EXTENSION_TS = resolve(__dirname, '../../extension.ts');

describe('getAgentsMdContent — content shape', () => {
	it('returns non-empty markdown', () => {
		const md = getAgentsMdContent();
		expect(typeof md).toBe('string');
		expect(md.length).toBeGreaterThan(50);
		expect(md).toContain('# Agent Instructions');
	});

	it('mentions ace_search a small bounded number of times (1-3) — no spam', () => {
		const md = getAgentsMdContent();
		const matches = md.match(/ace_search/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches.length).toBeLessThanOrEqual(3);
	});

	it('does NOT mention forbidden tool names by name', () => {
		const md = getAgentsMdContent();
		// ace_get_playbook + ace_learn — naming them by name causes the AI to
		// explore the filesystem for them (see prior dev iterations).
		expect(md).not.toContain('ace_get_playbook');
		expect(md).not.toContain('ace_learn');
		expect(md).not.toContain('ace_status');
		expect(md).not.toContain('ace_list_domains');
	});

	it('points the AI at .cursor/ace/searches/<session_id>.json full results path', () => {
		const md = getAgentsMdContent();
		expect(md).toContain('.cursor/ace/searches');
		expect(md).toContain('session_id');
	});

	it('directs AI to call ace_search FIRST', () => {
		const md = getAgentsMdContent();
		expect(md).toMatch(/FIRST|first action/);
	});

	it('is short (<1500 chars) — keeps the directive crisp', () => {
		expect(getAgentsMdContent().length).toBeLessThan(1500);
	});
});

describe('extension.ts — AGENTS.md write logic in activate()', () => {
	it('imports getAgentsMdContent from hookScripts', () => {
		const src = readFileSync(EXTENSION_TS, 'utf-8');
		expect(src).toMatch(/getAgentsMdContent/);
	});

	it('checks fs.existsSync before writing AGENTS.md (does not overwrite)', () => {
		const src = readFileSync(EXTENSION_TS, 'utf-8');
		const block = src.match(/agentsMdPath\s*=[\s\S]{0,1000}?writeFileSync\(agentsMdPath/);
		expect(block, 'AGENTS.md write block not found in activate()').toBeTruthy();
		expect(block![0]).toMatch(/!fs\.existsSync\(agentsMdPath\)/);
	});

	it('writes AGENTS.md at workspace root, not a subdirectory', () => {
		const src = readFileSync(EXTENSION_TS, 'utf-8');
		const block = src.match(/agentsMdPath\s*=[\s\S]{0,200}?'AGENTS\.md'/);
		expect(block, 'AGENTS.md path declaration not found').toBeTruthy();
		// Path is wsRoot + 'AGENTS.md' — no subdir interposed.
		expect(block![0]).toMatch(/wsRootForAgents,\s*'AGENTS\.md'/);
	});

	it('logs creation to outputChannel/console when file is new', () => {
		const src = readFileSync(EXTENSION_TS, 'utf-8');
		expect(src).toMatch(/Created AGENTS\.md at workspace root/);
	});
});
