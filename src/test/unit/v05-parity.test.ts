/**
 * v0.5.0 parity tests — Claude Code ACE plugin alignment.
 *
 * Tests the 6 SDK-team-recommended changes:
 *  1. Stop-hook server-side ace_learn (replaces AI-side MCP call)
 *  2. <ace-patterns agent-type="main">{JSON}</ace-patterns> wrapper format
 *  3. Domain-shift inject on Read (postToolUse domain shift)
 *  4. ROI feedback loop (TIME_SAVED in next prompt)
 *  5. session_id pinning (covered in #1)
 *  6. Privacy toggle JSON config (runtime-settings.json)
 */

import { describe, it, expect } from 'vitest';
import {
	getAcePatternsRuleContent,
	getPreToolUseScriptContent,
	getLearnHelperContent,
	getStopHookScriptContent,
	getDomainShiftScriptContent,
	inferDomain,
} from '../../ace/hookScripts';

// ===========================================================================
// TASK 1 — server-side ace_learn from Stop hook
// ===========================================================================

describe('v0.5.0 TASK 1 — Stop-hook ace_learn', () => {
	it('exports getLearnHelperContent', () => {
		expect(typeof getLearnHelperContent).toBe('function');
		expect(getLearnHelperContent().length).toBeGreaterThan(200);
	});

	it('learn helper requires @ace-sdk/core (not @ace-sdk/cli)', () => {
		const helper = getLearnHelperContent();
		expect(helper).toContain('@ace-sdk/core');
		expect(helper).not.toContain('@ace-sdk/cli');
	});

	it('learn helper calls storeExecutionTrace on AceClient', () => {
		const helper = getLearnHelperContent();
		expect(helper).toContain('storeExecutionTrace');
	});

	it('learn helper passes session_id to storeExecutionTrace (TASK 5)', () => {
		const helper = getLearnHelperContent();
		// Caveman: somewhere in the script the session_id field is set on the trace
		expect(helper).toMatch(/session_id\s*:/);
	});

	it('learn helper sets agent_type to "cursor"', () => {
		const helper = getLearnHelperContent();
		expect(helper).toMatch(/agent_type\s*:\s*['"]cursor['"]/);
	});

	it('learn helper writes ace-review-result.json with helpful_pct + time_saved_min + reason', () => {
		const helper = getLearnHelperContent();
		expect(helper).toContain('ace-review-result.json');
		expect(helper).toContain('helpful_pct');
		expect(helper).toContain('time_saved_min');
		expect(helper).toContain('reason');
	});

	it('exports getStopHookScriptContent (bash spawning the helper)', () => {
		expect(typeof getStopHookScriptContent).toBe('function');
		const script = getStopHookScriptContent();
		expect(script).toMatch(/^#!\/bin\/bash/);
	});

	it('stop hook spawns node helper with conv_id + jsonl path', () => {
		const script = getStopHookScriptContent();
		// Caveman: must invoke node, must reference learn helper
		expect(script).toContain('node');
		expect(script).toContain('ace_learn_helper.js');
		// Either passes conv_id as arg or via env
		expect(script).toMatch(/conv|conversation/i);
	});

	it('rule no longer instructs AI to call ace_learn at end of task', () => {
		const rule = getAcePatternsRuleContent();
		// v0.5.0-dev.13 — rule is now minimal and does not name ace_learn at all.
		expect(rule).not.toMatch(/ace_learn/i);
	});

	// v0.5.0-dev.13 — the "tool table marks ace_learn as auto-handled" test is
	// retired. The new minimal rule does not name ace_learn at all (server-side
	// learn happens via Stop hook regardless of what the rule says).
});

// ===========================================================================
// TASK 2 — pattern wrapper format <ace-patterns>
// ===========================================================================

describe('v0.5.0 TASK 2 — <ace-patterns> wrapper format', () => {
	it('preToolUse hook wraps patterns as <ace-patterns agent-type="main">{JSON}</ace-patterns>', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('<ace-patterns');
		expect(script).toContain('agent-type="main"');
		expect(script).toContain('</ace-patterns>');
	});

	it('preToolUse hook does NOT use bullet-list format (legacy "- [section/domain]")', () => {
		const script = getPreToolUseScriptContent();
		// Should not be the dominant formatting anymore — the wrapper is JSON.
		// Bullet-style was: jq '... map("- [...] " + ...) | .[]'
		expect(script).not.toMatch(/map\("- \[" \+/);
	});
});

// ===========================================================================
// TASK 3 — domain-shift inject
// ===========================================================================

describe('v0.5.0 TASK 3 — domain-shift inject', () => {
	it('exports inferDomain helper', () => {
		expect(typeof inferDomain).toBe('function');
	});

	it('inferDomain detects auth files', () => {
		expect(inferDomain('src/auth/login.ts')).toBe('auth-development');
		expect(inferDomain('app/auth/jwt.go')).toBe('auth-development');
	});

	it('inferDomain detects api/routes', () => {
		expect(inferDomain('src/api/users.ts')).toBe('api-development');
		expect(inferDomain('routes/posts.js')).toBe('api-development');
	});

	it('inferDomain detects testing files', () => {
		expect(inferDomain('foo.test.ts')).toBe('testing-strategies');
		expect(inferDomain('__tests__/bar.spec.js')).toBe('testing-strategies');
	});

	it('inferDomain detects database migrations', () => {
		expect(inferDomain('db/migrations/001.sql')).toBe('database-migrations');
		expect(inferDomain('schema.sql')).toBe('database-migrations');
	});

	it('inferDomain detects react components', () => {
		expect(inferDomain('src/components/Button.tsx')).toBe('react-components');
	});

	it('inferDomain detects devops/docker', () => {
		expect(inferDomain('docker-compose.yml')).toBe('devops-infrastructure');
		expect(inferDomain('Dockerfile')).toBe('devops-infrastructure');
		expect(inferDomain('.github/workflows/ci.yml')).toBe('devops-infrastructure');
	});

	it('inferDomain falls back to top-level dir for unknown patterns', () => {
		const d = inferDomain('packages/foo/bar.ts');
		expect(d.length).toBeGreaterThan(0);
	});

	it('exports getDomainShiftScriptContent', () => {
		expect(typeof getDomainShiftScriptContent).toBe('function');
		const script = getDomainShiftScriptContent();
		expect(script).toMatch(/^#!\/bin\/bash/);
	});

	it('domain-shift script wraps as <ace-patterns-domain-shift domain="..."> ... </ace-patterns-domain-shift>', () => {
		const script = getDomainShiftScriptContent();
		expect(script).toContain('<ace-patterns-domain-shift');
		expect(script).toContain('</ace-patterns-domain-shift>');
		expect(script).toContain('domain=');
	});

	it('domain-shift script tracks last-domain per session/generation', () => {
		const script = getDomainShiftScriptContent();
		expect(script).toMatch(/last-domain|last_domain/i);
		expect(script).toContain('tasks');
	});

	it('domain-shift script emits additional_context (postToolUse output)', () => {
		const script = getDomainShiftScriptContent();
		expect(script).toContain('additional_context');
	});
});

// ===========================================================================
// TASK 4 — ROI feedback loop
// ===========================================================================

describe('v0.5.0 TASK 4 — ROI feedback loop (TIME_SAVED → next prompt)', () => {
	it('preToolUse script reads ace-review-result.json (prior task ROI)', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('ace-review-result.json');
	});

	it('preToolUse script renames consumed review file to ace-review-result-consumed.json', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('ace-review-result-consumed.json');
	});

	it('preToolUse script wraps ROI as <ace-roi prev-task-saved-min="X" reason="..."/>', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('<ace-roi');
		expect(script).toContain('prev-task-saved-min');
	});
});

// ===========================================================================
// TASK 6 — privacy toggle JSON config
// ===========================================================================

describe('v0.5.0 TASK 6 — runtime-settings.json privacy toggle', () => {
	it('preToolUse script reads runtime-settings.json (replaces share-raw-prompts.optin file)', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('runtime-settings.json');
	});

	it('preToolUse script parses shareRawPromptsForRetrievalAnalysis JSON field', () => {
		const script = getPreToolUseScriptContent();
		expect(script).toContain('shareRawPromptsForRetrievalAnalysis');
	});
});
