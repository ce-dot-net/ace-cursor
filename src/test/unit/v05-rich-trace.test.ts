/**
 * v0.5.0-dev.14 — RICH execution-trace tests for the stop-hook learn helper.
 *
 * Verifies the THREE bugs documented in the v0.5.0-dev.14 task brief:
 *
 *  Bug 1 — pattern extraction was looking for `similar_patterns` at the wrong
 *          level. Real MCP responses are wrapped:
 *            result_json = {"content":[{"type":"text","text":"<inner-json>"}]}
 *          and the inner JSON has `.results` (not `.similar_patterns`).
 *  Bug 2 — session_id was always Cursor's conversation_id. The server-assigned
 *          id (inside the inner JSON) is what the server uses to link the
 *          learn back to the trajectory ledger.
 *  Bug 3 — rc=5 (uncaught exception) when invoked under Cursor's stripped env.
 *          Helper must log to .cursor/ace/ace-stop-debug.log so failures are
 *          diagnosable, fall back to os.homedir() when HOME is unset, and
 *          exit 0 (not 5) when loadConfig() returns null.
 *
 * Plus Task B — extension hooks.json must NOT register the redundant
 *               afterShellExecution / afterAgentResponse / ace_track_edit
 *               handlers; the Cursor transcript already covers their data.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { getLearnHelperContent } from '../../ace/v05Helpers';

// ===========================================================================
// Helpers — write the learn helper to a temp dir + run it.
// ===========================================================================

/**
 * Write the helper script + a stub @ace-sdk/core module that records the
 * trace it would have sent. Returns { tmpDir, helperPath, traceFile }.
 *
 * The stub avoids any real network call. It writes the trace to traceFile
 * so the test can assert on its shape.
 */
function writeHelperWithStub(opts: {
	configReturnsNull?: boolean;
	throwOnStore?: 'TokenExpiredError' | 'AceApiError500' | 'NetworkError' | 'WeirdError' | null;
} = {}): { tmpDir: string; helperPath: string; traceFile: string; debugLogPath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-learn-rich-'));
	const aceDir = path.join(tmpDir, '.cursor', 'ace');
	fs.mkdirSync(aceDir, { recursive: true });

	// Stub @ace-sdk/core — record trace, classify-error sentinel.
	const stubDir = path.join(tmpDir, 'node_modules', '@ace-sdk', 'core');
	fs.mkdirSync(stubDir, { recursive: true });
	const traceFile = path.join(tmpDir, 'sent-trace.json');
	const stubBody = `
class AceApiError extends Error { constructor(m, status){ super(m); this.name='AceApiError'; this.status=status; } }
class TokenExpiredError extends Error { constructor(m){ super(m); this.name='TokenExpiredError'; } }
function isTokenExpiredError(e){ return e && e.name === 'TokenExpiredError'; }
async function loadConfig(){
  ${opts.configReturnsNull ? 'return null;' : "return { token:'t', orgId:'o', api_url:'http://x' };"}
}
class AceClient {
  constructor(c){ this.c = c; }
  async storeExecutionTrace(trace){
    require('fs').writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace, null, 2));
    ${opts.throwOnStore === 'TokenExpiredError' ? "throw new TokenExpiredError('expired');" : ''}
    ${opts.throwOnStore === 'AceApiError500' ? "throw new AceApiError('boom', 503);" : ''}
    ${opts.throwOnStore === 'NetworkError' ? "throw Object.assign(new Error('ECONNREFUSED'), { name: 'Error' });" : ''}
    ${opts.throwOnStore === 'WeirdError' ? "throw new Error('mystery');" : ''}
    return { stored: true };
  }
}
module.exports = { loadConfig, AceClient, AceApiError, TokenExpiredError, isTokenExpiredError };
`;
	fs.writeFileSync(path.join(stubDir, 'index.js'), stubBody);
	fs.writeFileSync(
		path.join(stubDir, 'package.json'),
		JSON.stringify({ name: '@ace-sdk/core', version: '0.0.0-stub', main: 'index.js' }),
	);

	const helperPath = path.join(tmpDir, 'helper.js');
	fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });

	const debugLogPath = path.join(aceDir, 'ace-stop-debug.log');
	return { tmpDir, helperPath, traceFile, debugLogPath };
}

/** Build a realistic mcp_trajectory.jsonl with a wrapped ace_search result. */
function writeTrajectory(tmpDir: string, opts: {
	convId: string;
	withAceSearch?: boolean;
	withDoubleAceSearch?: boolean;
	withTopLevelResults?: boolean;
	withMalformedResultJson?: boolean;
}): string {
	const aceDir = path.join(tmpDir, '.cursor', 'ace');
	const jsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
	const lines: string[] = [];
	// Always include some non-ace tool steps + entries from a different conv_id.
	lines.push(JSON.stringify({
		conversation_id: 'OTHER-CONV', tool_name: 'Bash', tool_input: '{"command":"ls"}',
	}));
	lines.push(JSON.stringify({
		conversation_id: opts.convId, tool_name: 'Read', tool_input: '{"file":"a.ts"}',
	}));

	if (opts.withAceSearch) {
		// Realistic MCP-wrapped result_json shape.
		const inner = {
			query: 'jwt auth',
			threshold: 0.5,
			session_id: 'SERVER-SID-1111',
			results: [
				{ id: 'pat-1', domain: 'auth', content: 'A'.repeat(800), confidence: 0.9 },
				{ id: 'pat-2', domain: 'auth', content: 'short', confidence: 0.7 },
			],
		};
		const outer = { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: false };
		lines.push(JSON.stringify({
			conversation_id: opts.convId,
			tool_name: 'ace_search',
			tool_input: '{"query":"jwt auth"}',
			result_json: JSON.stringify(outer),
		}));
	}
	if (opts.withDoubleAceSearch) {
		// Two ace_search calls — LATEST should win for session_id + patterns.
		const inner1 = { results: [{ id: 'pat-A' }], session_id: 'SID-FIRST' };
		const inner2 = {
			results: [{ id: 'pat-LATEST', content: 'latest pattern' }],
			session_id: 'SID-LAST',
		};
		lines.push(JSON.stringify({
			conversation_id: opts.convId,
			tool_name: 'ace_search',
			result_json: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(inner1) }] }),
		}));
		lines.push(JSON.stringify({
			conversation_id: opts.convId,
			tool_name: 'ace_search',
			result_json: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(inner2) }] }),
		}));
	}
	if (opts.withTopLevelResults) {
		// Legacy shape — results at top level, no MCP content wrapper.
		lines.push(JSON.stringify({
			conversation_id: opts.convId,
			tool_name: 'ace_search',
			result_json: JSON.stringify({ session_id: 'LEGACY-SID', results: [{ id: 'pat-legacy' }] }),
		}));
	}
	if (opts.withMalformedResultJson) {
		lines.push(JSON.stringify({
			conversation_id: opts.convId,
			tool_name: 'ace_search',
			result_json: 'not-json-at-all',
		}));
	}
	fs.writeFileSync(jsonl, lines.join('\n') + '\n');
	return jsonl;
}

function runHelper(opts: {
	tmpDir: string;
	helperPath: string;
	convId: string;
	jsonlPath: string;
	transcriptPath?: string;
	strippedEnv?: boolean;
}) {
	const env: NodeJS.ProcessEnv = opts.strippedEnv
		? { HOME: process.env.HOME, PATH: '/opt/homebrew/bin:/usr/bin:/bin' }
		: { ...process.env };
	return spawnSync(
		process.execPath, // node
		[opts.helperPath, opts.convId, opts.jsonlPath, opts.transcriptPath || ''],
		{ cwd: opts.tmpDir, env, encoding: 'utf-8', timeout: 10000 },
	);
}

// ===========================================================================
// Bug 1 — pattern extraction reads MCP-wrapped result_json.content[0].text
// ===========================================================================

describe('Bug 1 — helper extracts received_patterns from wrapped MCP result_json', () => {
	it('helper extracts patterns from result_json.content[0].text (NOT similar_patterns)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-1', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-1', jsonlPath: jsonl });
		expect(r.status, `helper exit code (stderr: ${r.stderr})`).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(Array.isArray(trace.received_patterns)).toBe(true);
		expect(trace.received_patterns.length).toBe(2);
		expect(trace.received_patterns[0].id).toBe('pat-1');
		// content truncated to ~500 chars + ellipsis
		expect(trace.received_patterns[0].content.length).toBeLessThanOrEqual(550);
		expect(trace.received_patterns[0].content.endsWith('…')).toBe(true);
		// playbook_used populated from same source
		expect(trace.playbook_used).toContain('pat-1');
		expect(trace.playbook_used).toContain('pat-2');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('handles legacy top-level results shape (no content wrapper)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-LEG', withTopLevelResults: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-LEG', jsonlPath: jsonl });
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.received_patterns.length).toBe(1);
		expect(trace.received_patterns[0].id).toBe('pat-legacy');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('survives malformed result_json without throwing', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-BAD', withMalformedResultJson: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-BAD', jsonlPath: jsonl });
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		// No patterns extracted → empty array, fallback session_id == convId
		expect(trace.received_patterns).toEqual([]);
		expect(trace.session_id).toBe('CONV-BAD');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});
});

// ===========================================================================
// Bug 2 — session_id pulled from inner JSON, latest ace_search wins, fallback
// ===========================================================================

describe('Bug 2 — session_id uses server-assigned id from ace_search', () => {
	it('helper uses server session_id from inner JSON (not Cursor convId)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-2', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-2', jsonlPath: jsonl });
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.session_id).toBe('SERVER-SID-1111');
		expect(trace.session_id).not.toBe('CONV-2');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('helper picks LATEST session_id when multiple ace_search calls present', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-3', withDoubleAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-3', jsonlPath: jsonl });
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.session_id).toBe('SID-LAST');
		// And received_patterns reflects the LATEST batch.
		expect(trace.received_patterns.some((p: any) => p.id === 'pat-LATEST')).toBe(true);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('falls back to convId when no ace_search call recorded', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-NOSEARCH', withAceSearch: false });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-NOSEARCH', jsonlPath: jsonl });
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.session_id).toBe('CONV-NOSEARCH');
		expect(trace.received_patterns).toEqual([]);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});
});

// ===========================================================================
// Bug 3 — rc=5 robustness: debug log + HOME fallback + null-config exit-0
// ===========================================================================

describe('Bug 3 — helper writes diagnostics + handles env stripping', () => {
	it('writes invocation breadcrumb on every run (success path)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-LOG', withAceSearch: true });
		runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-LOG', jsonlPath: jsonl });
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/helper invoked/i);
		expect(log).toMatch(/exit_0/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('logs the raw error to debug log when storeExecutionTrace throws an unclassified error (rc=5 path)', () => {
		const ctx = writeHelperWithStub({ throwOnStore: 'WeirdError' });
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-ERR', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-ERR', jsonlPath: jsonl });
		expect(r.status).toBe(5);
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/caught/);
		expect(log).toMatch(/mystery/);
		expect(log).toMatch(/exit_5 unclassified/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('exits 0 (NOT 5) when loadConfig returns null', () => {
		const ctx = writeHelperWithStub({ configReturnsNull: true });
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-NULLCFG', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-NULLCFG', jsonlPath: jsonl });
		expect(r.status).toBe(0);
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/no_config/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('falls back to os.homedir() when HOME is unset (Cursor stripped env)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-NOHOME', withAceSearch: true });
		// Drop HOME, but keep PATH so node can find anything it needs.
		const r = spawnSync(
			process.execPath,
			[ctx.helperPath, 'CONV-NOHOME', jsonl, ''],
			{
				cwd: ctx.tmpDir,
				env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
				encoding: 'utf-8',
				timeout: 10000,
			},
		);
		expect(r.status, `helper rc with no HOME (stderr: ${r.stderr})`).toBe(0);
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/helper invoked/);
		// Helper logs whether HOME was set BEFORE its own fallback. We just
		// require the helper completed.
		expect(log).toMatch(/exit_0/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('still exits with stable code 2 on TokenExpiredError + logs it', () => {
		const ctx = writeHelperWithStub({ throwOnStore: 'TokenExpiredError' });
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-T', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-T', jsonlPath: jsonl });
		expect(r.status).toBe(2);
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/exit_2/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('still exits with stable code 3 on 5xx AceApiError + logs status', () => {
		const ctx = writeHelperWithStub({ throwOnStore: 'AceApiError500' });
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-5', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-5', jsonlPath: jsonl });
		expect(r.status).toBe(3);
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/exit_3/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});
});

// ===========================================================================
// Task B — hooks.json no longer registers redundant tracker hooks.
// ===========================================================================

describe('Task B — hooks.json drops afterShellExecution / afterAgentResponse / ace_track_edit', () => {
	function readExtensionTs(): string {
		return fs.readFileSync(path.resolve(__dirname, '../../extension.ts'), 'utf-8');
	}

	it('hooks.json template does NOT register afterShellExecution', () => {
		const src = readExtensionTs();
		// Find the hooksConfig block.
		const m = src.match(/const hooksConfig = \{[\s\S]*?\n\t\};/);
		expect(m, 'hooksConfig block not found').toBeTruthy();
		const block = m![0];
		expect(block, 'afterShellExecution must be removed').not.toMatch(/afterShellExecution\s*:/);
	});

	it('hooks.json template does NOT register afterAgentResponse', () => {
		const src = readExtensionTs();
		const m = src.match(/const hooksConfig = \{[\s\S]*?\n\t\};/);
		expect(m).toBeTruthy();
		const block = m![0];
		expect(block, 'afterAgentResponse must be removed').not.toMatch(/afterAgentResponse\s*:/);
	});

	it('hooks.json template does NOT register ace_track_edit on afterFileEdit', () => {
		const src = readExtensionTs();
		const m = src.match(/afterFileEdit\s*:\s*\[[\s\S]*?\]/);
		expect(m).toBeTruthy();
		const block = m![0];
		expect(block, 'ace_track_edit must be removed').not.toMatch(/ace_track_edit/);
	});

	it('hooks.json template KEEPS ace_domain_shift on afterFileEdit (essential)', () => {
		const src = readExtensionTs();
		const m = src.match(/afterFileEdit\s*:\s*\[[\s\S]*?\]/);
		expect(m).toBeTruthy();
		expect(m![0]).toMatch(/ace_domain_shift/);
	});

	it('hooks.json template KEEPS afterMCPExecution → ace_track_mcp (essential)', () => {
		const src = readExtensionTs();
		expect(src).toMatch(/afterMCPExecution\s*:\s*\[\{[\s\S]*?ace_track_mcp/);
	});

	it('hasAllHooks check no longer requires afterShellExecution / afterAgentResponse', () => {
		const src = readExtensionTs();
		const m = src.match(/const hasAllHooks = [\s\S]*?;\s*\n\s*if \(!hasAllHooks\)/);
		expect(m, 'hasAllHooks not found').toBeTruthy();
		const block = m![0];
		expect(block).not.toMatch(/afterShellExecution/);
		expect(block).not.toMatch(/afterAgentResponse/);
	});

	it('upgrade path detects + prunes redundant hooks from existing hooks.json', () => {
		const src = readExtensionTs();
		// Look for the "hasRemovedHooks" pruning logic introduced in dev.14.
		expect(src).toMatch(/hasRemovedHooks/);
		expect(src).toMatch(/Pruning redundant tracker hooks/);
	});
});

// ===========================================================================
// dev.15 — RICH trajectory from Cursor transcript (Shell, ApplyPatch, MCP merge)
// ===========================================================================

/**
 * Build a Cursor-style transcript JSONL. Each line is a JSON message; tool_use
 * blocks live inside entry.message.content[]. Cursor only emits tool_use
 * (no tool_result) — that's by design: results for MCP calls live in
 * mcp_trajectory.jsonl, results for non-MCP tools (Shell, ApplyPatch, …) are
 * not captured anywhere (which is fine — args + ordering are the signal).
 */
function writeCursorTranscript(tmpDir: string, entries: any[]): string {
	const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
	fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
	return transcriptPath;
}

function userMsg(text: string) {
	return { role: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}
function assistantToolUse(blocks: Array<{ type: 'text' | 'tool_use'; text?: string; name?: string; input?: any }>): any {
	return { role: 'assistant', message: { role: 'assistant', content: blocks } };
}

describe('dev.15 — rich trajectory from Cursor transcript', () => {
	it('trajectory includes Shell tool_use entries from transcript', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-SHELL', withAceSearch: true });
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('install deps and run tests'),
			assistantToolUse([
				{ type: 'tool_use', name: 'Shell', input: { command: 'npm install' } },
				{ type: 'tool_use', name: 'Shell', input: { command: 'npm test' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-SHELL',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status, `exit (stderr: ${r.stderr})`).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		const shellSteps = trace.trajectory.filter((s: any) => s.action === 'Shell');
		expect(shellSteps.length).toBe(2);
		expect(shellSteps[0].args.command).toBe('npm install');
		expect(shellSteps[1].args.command).toBe('npm test');
		// Non-MCP tool → result must be empty.
		expect(shellSteps[0].result).toBe('');
		expect(shellSteps[1].result).toBe('');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('ApplyPatch with huge input is truncated to 2000 chars + ellipsis', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-PATCH' });
		const huge = 'X'.repeat(5000);
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('patch the file'),
			assistantToolUse([
				{ type: 'tool_use', name: 'ApplyPatch', input: { input: huge, file_path: '/foo.ts' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-PATCH',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		const patchStep = trace.trajectory.find((s: any) => s.action === 'ApplyPatch');
		expect(patchStep).toBeTruthy();
		// Truncated to 2000 + '…' (1 char)
		expect(patchStep.args.input.length).toBeLessThanOrEqual(2001);
		expect(patchStep.args.input.endsWith('…')).toBe(true);
		// Other args left untouched.
		expect(patchStep.args.file_path).toBe('/foo.ts');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('trajectory captures ReadFile and Glob entries from transcript', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-READ' });
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('explore'),
			assistantToolUse([
				{ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
				{ type: 'tool_use', name: 'ReadFile', input: { file_path: '/a.ts' } },
				{ type: 'tool_use', name: 'ReadFile', input: { file_path: '/b.ts' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-READ',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		const actions = trace.trajectory.map((s: any) => s.action);
		expect(actions).toContain('Glob');
		expect(actions.filter((a: string) => a === 'ReadFile').length).toBe(2);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('preserves chronological order across the transcript', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-ORDER' });
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('do stuff'),
			assistantToolUse([
				{ type: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } },
			]),
			assistantToolUse([
				{ type: 'tool_use', name: 'ReadFile', input: { file_path: '/a.ts' } },
				{ type: 'tool_use', name: 'Shell', input: { command: 'tsc' } },
			]),
			assistantToolUse([
				{ type: 'tool_use', name: 'ApplyPatch', input: { file_path: '/a.ts', input: 'p' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-ORDER',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		const actions = trace.trajectory.map((s: any) => s.action);
		expect(actions).toEqual(['Glob', 'ReadFile', 'Shell', 'ApplyPatch']);
		// Steps numbered sequentially from 1.
		expect(trace.trajectory.map((s: any) => s.step)).toEqual([1, 2, 3, 4]);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('merges MCP tool result from mcp_trajectory.jsonl into ace_search transcript step', () => {
		const ctx = writeHelperWithStub();
		// mcp_trajectory has the wrapped ace_search response.
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-MERGE', withAceSearch: true });
		// Transcript records the ace_search tool_use with matching args.
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('how do I auth?'),
			assistantToolUse([
				{ type: 'tool_use', name: 'ace_search', input: { query: 'jwt auth' } },
				{ type: 'tool_use', name: 'Shell', input: { command: 'echo done' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-MERGE',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status, `exit (stderr: ${r.stderr})`).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		const searchStep = trace.trajectory.find((s: any) => s.action === 'ace_search');
		expect(searchStep, 'ace_search step missing').toBeTruthy();
		// Args came from transcript.
		expect(searchStep.args.query).toBe('jwt auth');
		// Result merged from mcp_trajectory.jsonl (contains MCP-wrapped JSON).
		expect(searchStep.result).toBeTruthy();
		expect(searchStep.result.length).toBeGreaterThan(0);
		expect(searchStep.result).toMatch(/SERVER-SID-1111|pat-1/);
		// Shell step still has empty result.
		const shellStep = trace.trajectory.find((s: any) => s.action === 'Shell');
		expect(shellStep.result).toBe('');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('non-MCP tools (Shell, ApplyPatch) get empty result even when mcp_trajectory has unrelated entries', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-NOMCP', withAceSearch: true });
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('do work'),
			assistantToolUse([
				{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } },
				{ type: 'tool_use', name: 'ApplyPatch', input: { file_path: '/x', input: 'p' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-NOMCP',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		for (const step of trace.trajectory) {
			if (step.action === 'Shell' || step.action === 'ApplyPatch') {
				expect(step.result).toBe('');
			}
		}
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('falls back to mcp_trajectory-only trajectory when transcript is missing (no crash)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-NOTRANS', withAceSearch: true });
		// transcriptPath unset → empty arg.
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-NOTRANS',
			jsonlPath: jsonl,
			// no transcriptPath
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		// Trajectory NOT empty — falls back to legacy mcp_trajectory.jsonl walk.
		expect(Array.isArray(trace.trajectory)).toBe(true);
		expect(trace.trajectory.length).toBeGreaterThan(0);
		// And ace_search step is present (from mcp_trajectory).
		expect(trace.trajectory.some((s: any) => s.action === 'ace_search')).toBe(true);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('falls back gracefully when transcript path points to non-existent file', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-MISSING', withAceSearch: true });
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-MISSING',
			jsonlPath: jsonl, transcriptPath: '/tmp/nonexistent-transcript-xyz.jsonl',
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.trajectory.length).toBeGreaterThan(0);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('captures multiple tool_use blocks within a single assistant message', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-MULTI' });
		// One assistant message with text + 3 tool_use blocks intermixed.
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('do everything'),
			assistantToolUse([
				{ type: 'text', text: 'Let me start by listing files.' },
				{ type: 'tool_use', name: 'Glob', input: { pattern: '*' } },
				{ type: 'text', text: 'Now read.' },
				{ type: 'tool_use', name: 'ReadFile', input: { file_path: '/a' } },
				{ type: 'tool_use', name: 'ReadFile', input: { file_path: '/b' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-MULTI',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.trajectory.length).toBe(3);
		const actions = trace.trajectory.map((s: any) => s.action);
		expect(actions).toEqual(['Glob', 'ReadFile', 'ReadFile']);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('tool_use with no input field is captured with empty args (no crash)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-NOARGS' });
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('q'),
			assistantToolUse([
				{ type: 'tool_use', name: 'Help' /* no input */ },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-NOARGS',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		const help = trace.trajectory.find((s: any) => s.action === 'Help');
		expect(help).toBeTruthy();
		expect(help.args).toEqual({});
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('preserves received_patterns + server session_id even with rich transcript trajectory', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-PRESERVE', withAceSearch: true });
		const transcript = writeCursorTranscript(ctx.tmpDir, [
			userMsg('jwt help'),
			assistantToolUse([
				{ type: 'tool_use', name: 'ace_search', input: { query: 'jwt auth' } },
				{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } },
			]),
		]);
		const r = runHelper({
			tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-PRESERVE',
			jsonlPath: jsonl, transcriptPath: transcript,
		});
		expect(r.status).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		// Existing fields still populated correctly.
		expect(trace.session_id).toBe('SERVER-SID-1111');
		expect(trace.received_patterns.length).toBe(2);
		expect(trace.playbook_used).toContain('pat-1');
		expect(trace.agent_type).toBe('cursor');
		expect(trace.agent_id).toMatch(/^cursor-/);
		expect(trace.git).toBeTruthy();
		// Task pulled from transcript user message.
		expect(trace.task).toContain('jwt help');
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});
});

// ===========================================================================
// dev.17 — projectId normalization + 4xx vs 5xx error classification
// ===========================================================================
//
// Live HTTP 400 from server: {"detail":"Multiple projects found. Set
// X-ACE-Project header."} surfaced as a plain Error with name='Error' and
// message='Server error (400): {...}'. The previous helper:
//   1. Never set config.projectId → SDK omitted X-ACE-Project header
//   2. Misclassified that Error as rc=5 (unclassified) → no useful diagnostic
// Both paths are now fixed; these tests pin the helper source so future edits
// don't re-regress.

describe('dev.17 — projectId normalization (Bug 1)', () => {
	it('helper source normalizes default_project_id (snake_case)', () => {
		const src = getLearnHelperContent();
		expect(src).toMatch(/default_project_id/);
	});

	it('helper source normalizes defaultProjectId (camelCase)', () => {
		const src = getLearnHelperContent();
		expect(src).toMatch(/defaultProjectId/);
	});

	it('helper source falls back to ACE_PROJECT_ID env var', () => {
		const src = getLearnHelperContent();
		expect(src).toMatch(/process\.env\.ACE_PROJECT_ID/);
	});

	it('helper source guards normalization with !config.projectId (mirrors orgId pattern)', () => {
		const src = getLearnHelperContent();
		// The new block must check `!config.projectId` before assigning, same
		// shape as the existing orgId normalize. Both should appear in source.
		expect(src).toMatch(/if \(!config\.projectId\)/);
		expect(src).toMatch(/if \(!config\.orgId/);
	});
});

describe('dev.17 — config_resolved debug log (Bug 3)', () => {
	it('helper source logs config_resolved with orgId + projectId before AceClient construction', () => {
		const src = getLearnHelperContent();
		expect(src).toMatch(/config_resolved/);
		// Log line must surface BOTH ids so future project mismatches diagnose
		// in one log entry.
		expect(src).toMatch(/config_resolved.*orgId/);
		expect(src).toMatch(/projectId=/);
	});

	it('helper writes config_resolved breadcrumb at runtime (success path)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-CFGLOG', withAceSearch: true });
		runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-CFGLOG', jsonlPath: jsonl });
		const log = fs.readFileSync(ctx.debugLogPath, 'utf-8');
		expect(log).toMatch(/config_resolved/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});
});

describe('dev.17 — error classification by stringified message (Bug 2)', () => {
	it('helper source matches "Server error (5xx)" → exit 3', () => {
		const src = getLearnHelperContent();
		// JS source contains the regex literal /Server error \(5\d\d\)/
		// → in this TS file's regex we escape '\' to '\\' and parens to '\('.
		expect(src).toMatch(/Server error \\\(5\\d\\d\\\)/);
		expect(src).toMatch(/exit_3 api_5xx_bymsg/);
	});

	it('helper source matches "Server error (NNN)" → exit 4 (4xx fallthrough)', () => {
		const src = getLearnHelperContent();
		expect(src).toMatch(/Server error \\\(\\d\{3\}\\\)/);
		expect(src).toMatch(/exit_4 api_4xx_bymsg/);
	});

	it('helper source name-fallback for AceApiError now exits 4 (was 3)', () => {
		const src = getLearnHelperContent();
		// The /AceApiError/i.test(name) branch must map to exit 4 — without
		// status info, default to recoverable 4xx.
		expect(src).toMatch(/AceApiError\/i\.test\(name\)\) \{ debugLog\([^)]*\)?[^,]*, 'exit_4 api_byname'/);
	});

	it('runtime — 5xx AceApiError still exits 3 (instanceof path unchanged)', () => {
		const ctx = writeHelperWithStub({ throwOnStore: 'AceApiError500' });
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-5XX', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-5XX', jsonlPath: jsonl });
		expect(r.status).toBe(3);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('runtime — TokenExpiredError still exits 2 (path unchanged)', () => {
		const ctx = writeHelperWithStub({ throwOnStore: 'TokenExpiredError' });
		const jsonl = writeTrajectory(ctx.tmpDir, { convId: 'CONV-TOK', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-TOK', jsonlPath: jsonl });
		expect(r.status).toBe(2);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('runtime — plain Error with "Server error (400)" message exits 4 (NOT 5)', () => {
		// Custom stub: throw a plain Error with the exact message shape the
		// SDK emits for non-AceApiError HTTP failures (e.g. fetch rejected
		// from server before the SDK could wrap it).
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-learn-400-'));
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		const stubDir = path.join(tmpDir, 'node_modules', '@ace-sdk', 'core');
		fs.mkdirSync(stubDir, { recursive: true });
		const stub = `
class AceApiError extends Error { constructor(m, status){ super(m); this.name='AceApiError'; this.status=status; } }
class TokenExpiredError extends Error { constructor(m){ super(m); this.name='TokenExpiredError'; } }
function isTokenExpiredError(e){ return e && e.name === 'TokenExpiredError'; }
async function loadConfig(){ return { token:'t', orgId:'o' }; }
class AceClient {
  async storeExecutionTrace(){
    // Throw a plain Error matching the live failure shape.
    throw new Error('Server error (400): {"detail":"Multiple projects found. Set X-ACE-Project header."}');
  }
}
module.exports = { loadConfig, AceClient, AceApiError, TokenExpiredError, isTokenExpiredError };
`;
		fs.writeFileSync(path.join(stubDir, 'index.js'), stub);
		fs.writeFileSync(path.join(stubDir, 'package.json'),
			JSON.stringify({ name: '@ace-sdk/core', version: '0.0.0-stub', main: 'index.js' }));
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const jsonl = writeTrajectory(tmpDir, { convId: 'CONV-400', withAceSearch: true });
		const r = spawnSync(process.execPath, [helperPath, 'CONV-400', jsonl, ''],
			{ cwd: tmpDir, env: { ...process.env }, encoding: 'utf-8', timeout: 10000 });
		expect(r.status, `helper exit (stderr: ${r.stderr})`).toBe(4);
		const log = fs.readFileSync(path.join(aceDir, 'ace-stop-debug.log'), 'utf-8');
		expect(log).toMatch(/exit_4 api_4xx_bymsg/);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('runtime — plain Error with "Server error (503)" message exits 3 (5xx)', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-learn-503-'));
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		const stubDir = path.join(tmpDir, 'node_modules', '@ace-sdk', 'core');
		fs.mkdirSync(stubDir, { recursive: true });
		const stub = `
class AceApiError extends Error { constructor(m, status){ super(m); this.name='AceApiError'; this.status=status; } }
class TokenExpiredError extends Error { constructor(m){ super(m); this.name='TokenExpiredError'; } }
function isTokenExpiredError(e){ return e && e.name === 'TokenExpiredError'; }
async function loadConfig(){ return { token:'t', orgId:'o' }; }
class AceClient {
  async storeExecutionTrace(){ throw new Error('Server error (503): upstream unavailable'); }
}
module.exports = { loadConfig, AceClient, AceApiError, TokenExpiredError, isTokenExpiredError };
`;
		fs.writeFileSync(path.join(stubDir, 'index.js'), stub);
		fs.writeFileSync(path.join(stubDir, 'package.json'),
			JSON.stringify({ name: '@ace-sdk/core', version: '0.0.0-stub', main: 'index.js' }));
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const jsonl = writeTrajectory(tmpDir, { convId: 'CONV-503', withAceSearch: true });
		const r = spawnSync(process.execPath, [helperPath, 'CONV-503', jsonl, ''],
			{ cwd: tmpDir, env: { ...process.env }, encoding: 'utf-8', timeout: 10000 });
		expect(r.status).toBe(3);
		const log = fs.readFileSync(path.join(aceDir, 'ace-stop-debug.log'), 'utf-8');
		expect(log).toMatch(/exit_3 api_5xx_bymsg/);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

// ===========================================================================
// dev.18 — Helper loads .cursor/ace/settings.json (workspace env fallback)
// ===========================================================================
//
// Cursor doesn't pass workspace ENV to hook subprocesses, so the helper's
// process.env.ACE_PROJECT_ID / ACE_ORG_ID fallbacks come up empty in the
// stop hook. The extension already writes .cursor/ace/settings.json next to
// mcp_trajectory.jsonl with an "env" map. Helper must load that file and
// resolve org/project from it BEFORE falling back to env or default_*.

describe('dev.18 — helper loads .cursor/ace/settings.json from jsonl dir', () => {
	function writeSettingsJson(tmpDir: string, env: Record<string, string>) {
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		fs.writeFileSync(
			path.join(aceDir, 'settings.json'),
			JSON.stringify({ env, version: '0.5.0-dev.18' }, null, 2),
		);
	}

	// Build a stub that returns config WITHOUT orgId/projectId so the helper
	// must resolve them from settings.json/env/defaults.
	function writeMinimalConfigStub(tmpDir: string, traceFile: string) {
		const stubDir = path.join(tmpDir, 'node_modules', '@ace-sdk', 'core');
		fs.mkdirSync(stubDir, { recursive: true });
		const stub = `
class AceApiError extends Error { constructor(m, status){ super(m); this.name='AceApiError'; this.status=status; } }
class TokenExpiredError extends Error { constructor(m){ super(m); this.name='TokenExpiredError'; } }
function isTokenExpiredError(e){ return e && e.name === 'TokenExpiredError'; }
async function loadConfig(){
  // Bare config — no orgId, no projectId. Helper must populate them.
  return { token:'t', api_url:'http://x' };
}
class AceClient {
  constructor(c){ this.c = c; }
  async storeExecutionTrace(trace){
    // Record BOTH the trace AND the resolved config.
    require('fs').writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
      trace,
      resolvedOrgId: this.c.orgId,
      resolvedProjectId: this.c.projectId,
    }, null, 2));
    return { stored: true };
  }
}
module.exports = { loadConfig, AceClient, AceApiError, TokenExpiredError, isTokenExpiredError };
`;
		fs.writeFileSync(path.join(stubDir, 'index.js'), stub);
		fs.writeFileSync(
			path.join(stubDir, 'package.json'),
			JSON.stringify({ name: '@ace-sdk/core', version: '0.0.0-stub', main: 'index.js' }),
		);
	}

	it('helper resolves projectId from settings.json when config + env are empty', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-settings-'));
		const traceFile = path.join(tmpDir, 'sent.json');
		writeMinimalConfigStub(tmpDir, traceFile);
		writeSettingsJson(tmpDir, {
			ACE_ORG_ID: 'ORG-FROM-SETTINGS',
			ACE_PROJECT_ID: 'PROJ-FROM-SETTINGS',
		});
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		const jsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
		fs.writeFileSync(jsonl, JSON.stringify({
			conversation_id: 'CONV-S1', tool_name: 'Bash', tool_input: '{}',
		}) + '\n');
		// Strip env so settings.json is the only source.
		const r = spawnSync(process.execPath, [helperPath, 'CONV-S1', jsonl, ''], {
			cwd: tmpDir,
			env: { HOME: process.env.HOME, PATH: process.env.PATH || '' },
			encoding: 'utf-8', timeout: 10000,
		});
		expect(r.status, `helper exit (stderr: ${r.stderr})`).toBe(0);
		const sent = JSON.parse(fs.readFileSync(traceFile, 'utf-8'));
		expect(sent.resolvedOrgId).toBe('ORG-FROM-SETTINGS');
		expect(sent.resolvedProjectId).toBe('PROJ-FROM-SETTINGS');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('helper logs settings_json_loaded breadcrumb with both ids', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-settings-log-'));
		const traceFile = path.join(tmpDir, 'sent.json');
		writeMinimalConfigStub(tmpDir, traceFile);
		writeSettingsJson(tmpDir, {
			ACE_ORG_ID: 'ORG-LOG',
			ACE_PROJECT_ID: 'PROJ-LOG',
		});
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		const jsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
		fs.writeFileSync(jsonl, JSON.stringify({
			conversation_id: 'CONV-S2', tool_name: 'Bash', tool_input: '{}',
		}) + '\n');
		const r = spawnSync(process.execPath, [helperPath, 'CONV-S2', jsonl, ''], {
			cwd: tmpDir, env: { ...process.env }, encoding: 'utf-8', timeout: 10000,
		});
		expect(r.status).toBe(0);
		const log = fs.readFileSync(path.join(aceDir, 'ace-stop-debug.log'), 'utf-8');
		expect(log).toMatch(/settings_json_loaded/);
		expect(log).toMatch(/projectId=PROJ-LOG/);
		expect(log).toMatch(/orgId=ORG-LOG/);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('helper handles missing settings.json gracefully + logs settings_json_missing', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-settings-missing-'));
		const traceFile = path.join(tmpDir, 'sent.json');
		writeMinimalConfigStub(tmpDir, traceFile);
		// NO settings.json.
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const jsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
		fs.writeFileSync(jsonl, JSON.stringify({
			conversation_id: 'CONV-S3', tool_name: 'Bash', tool_input: '{}',
		}) + '\n');
		const r = spawnSync(process.execPath, [helperPath, 'CONV-S3', jsonl, ''], {
			cwd: tmpDir, env: { ...process.env }, encoding: 'utf-8', timeout: 10000,
		});
		expect(r.status, `helper exit (stderr: ${r.stderr})`).toBe(0);
		const log = fs.readFileSync(path.join(aceDir, 'ace-stop-debug.log'), 'utf-8');
		expect(log).toMatch(/settings_json_missing/);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('priority chain: workspace settings > env var > default_* in config', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-settings-prio-'));
		const traceFile = path.join(tmpDir, 'sent.json');
		// Stub returns config WITH default_project_id — settings.json must win.
		const stubDir = path.join(tmpDir, 'node_modules', '@ace-sdk', 'core');
		fs.mkdirSync(stubDir, { recursive: true });
		const stub = `
class AceApiError extends Error { constructor(m, status){ super(m); this.name='AceApiError'; this.status=status; } }
class TokenExpiredError extends Error { constructor(m){ super(m); this.name='TokenExpiredError'; } }
function isTokenExpiredError(e){ return e && e.name === 'TokenExpiredError'; }
async function loadConfig(){
  return {
    token:'t',
    default_org_id: 'ORG-DEFAULT',
    default_project_id: 'PROJ-DEFAULT',
  };
}
class AceClient {
  constructor(c){ this.c = c; }
  async storeExecutionTrace(trace){
    require('fs').writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
      resolvedOrgId: this.c.orgId,
      resolvedProjectId: this.c.projectId,
    }));
    return { stored: true };
  }
}
module.exports = { loadConfig, AceClient, AceApiError, TokenExpiredError, isTokenExpiredError };
`;
		fs.writeFileSync(path.join(stubDir, 'index.js'), stub);
		fs.writeFileSync(path.join(stubDir, 'package.json'),
			JSON.stringify({ name: '@ace-sdk/core', version: '0.0.0-stub', main: 'index.js' }));
		writeSettingsJson(tmpDir, {
			ACE_ORG_ID: 'ORG-WIN',
			ACE_PROJECT_ID: 'PROJ-WIN',
		});
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		const jsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
		fs.writeFileSync(jsonl, JSON.stringify({
			conversation_id: 'CONV-PRIO', tool_name: 'Bash', tool_input: '{}',
		}) + '\n');
		const r = spawnSync(process.execPath, [helperPath, 'CONV-PRIO', jsonl, ''], {
			cwd: tmpDir,
			env: {
				HOME: process.env.HOME,
				PATH: process.env.PATH || '',
				// Even env-vars set — settings.json should outrank them.
				ACE_PROJECT_ID: 'PROJ-FROM-ENV',
				ACE_ORG_ID: 'ORG-FROM-ENV',
			},
			encoding: 'utf-8', timeout: 10000,
		});
		expect(r.status, `helper exit (stderr: ${r.stderr})`).toBe(0);
		const sent = JSON.parse(fs.readFileSync(traceFile, 'utf-8'));
		expect(sent.resolvedOrgId).toBe('ORG-WIN');
		expect(sent.resolvedProjectId).toBe('PROJ-WIN');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('priority chain: env var beats default_* when settings.json missing', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-settings-env-'));
		const traceFile = path.join(tmpDir, 'sent.json');
		const stubDir = path.join(tmpDir, 'node_modules', '@ace-sdk', 'core');
		fs.mkdirSync(stubDir, { recursive: true });
		const stub = `
class AceApiError extends Error { constructor(m, status){ super(m); this.name='AceApiError'; this.status=status; } }
class TokenExpiredError extends Error { constructor(m){ super(m); this.name='TokenExpiredError'; } }
function isTokenExpiredError(e){ return e && e.name === 'TokenExpiredError'; }
async function loadConfig(){
  return { token:'t', default_org_id: 'ORG-DEF', default_project_id: 'PROJ-DEF' };
}
class AceClient {
  constructor(c){ this.c = c; }
  async storeExecutionTrace(trace){
    require('fs').writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
      resolvedOrgId: this.c.orgId,
      resolvedProjectId: this.c.projectId,
    }));
    return { stored: true };
  }
}
module.exports = { loadConfig, AceClient, AceApiError, TokenExpiredError, isTokenExpiredError };
`;
		fs.writeFileSync(path.join(stubDir, 'index.js'), stub);
		fs.writeFileSync(path.join(stubDir, 'package.json'),
			JSON.stringify({ name: '@ace-sdk/core', version: '0.0.0-stub', main: 'index.js' }));
		const helperPath = path.join(tmpDir, 'helper.js');
		fs.writeFileSync(helperPath, getLearnHelperContent(), { mode: 0o755 });
		const aceDir = path.join(tmpDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		const jsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
		fs.writeFileSync(jsonl, JSON.stringify({
			conversation_id: 'CONV-ENV', tool_name: 'Bash', tool_input: '{}',
		}) + '\n');
		const r = spawnSync(process.execPath, [helperPath, 'CONV-ENV', jsonl, ''], {
			cwd: tmpDir,
			env: {
				HOME: process.env.HOME,
				PATH: process.env.PATH || '',
				ACE_PROJECT_ID: 'PROJ-FROM-ENV',
				ACE_ORG_ID: 'ORG-FROM-ENV',
			},
			encoding: 'utf-8', timeout: 10000,
		});
		expect(r.status, `helper exit (stderr: ${r.stderr})`).toBe(0);
		const sent = JSON.parse(fs.readFileSync(traceFile, 'utf-8'));
		expect(sent.resolvedOrgId).toBe('ORG-FROM-ENV');
		expect(sent.resolvedProjectId).toBe('PROJ-FROM-ENV');
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('helper source contains settings.json load block + path.dirname(jsonlPath)', () => {
		const src = getLearnHelperContent();
		expect(src).toMatch(/settings_json_loaded/);
		expect(src).toMatch(/path\.dirname\(jsonlPath\)/);
		expect(src).toMatch(/'settings\.json'/);
		// Resolution chain references workspaceEnv for both ids.
		expect(src).toMatch(/workspaceEnv\.ACE_ORG_ID/);
		expect(src).toMatch(/workspaceEnv\.ACE_PROJECT_ID/);
	});
});

// ===========================================================================
// dev.19 Task A — helper handles per-conv jsonl path; settings.json + review
// file still resolve to top-level .cursor/ace/.
// ===========================================================================

describe('dev.19 — helper accepts per-conv jsonl path', () => {
	function writePerConvTrajectory(tmpDir: string, opts: {
		convId: string;
		withAceSearch?: boolean;
	}): string {
		// v0.5.0-dev.24 — folder renamed sessions/ → tasks/ (one conv_id = one task).
		const tasksDir = path.join(tmpDir, '.cursor', 'ace', 'tasks', opts.convId);
		fs.mkdirSync(tasksDir, { recursive: true });
		const jsonl = path.join(tasksDir, 'mcp_trajectory.jsonl');
		const lines: string[] = [];
		lines.push(JSON.stringify({
			conversation_id: opts.convId, tool_name: 'Read', tool_input: '{"file":"a.ts"}',
		}));
		if (opts.withAceSearch) {
			const inner = {
				query: 'jwt auth',
				session_id: 'SERVER-PERCONV-SID',
				results: [{ id: 'pat-1', content: 'A'.repeat(800), confidence: 0.9 }],
			};
			const outer = { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: false };
			lines.push(JSON.stringify({
				conversation_id: opts.convId,
				tool_name: 'ace_search',
				tool_input: '{"query":"jwt auth"}',
				result_json: JSON.stringify(outer),
			}));
		}
		fs.writeFileSync(jsonl, lines.join('\n') + '\n');
		return jsonl;
	}

	it('helper sources from per-conv jsonl path and extracts patterns', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writePerConvTrajectory(ctx.tmpDir, { convId: 'CONV-PC1', withAceSearch: true });
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-PC1', jsonlPath: jsonl });
		expect(r.status, `exit (stderr: ${r.stderr})`).toBe(0);
		const trace = JSON.parse(fs.readFileSync(ctx.traceFile, 'utf-8'));
		expect(trace.session_id).toBe('SERVER-PERCONV-SID');
		expect(trace.received_patterns.length).toBe(1);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('debug log writes to TOP-LEVEL .cursor/ace/ (not nested under tasks/<conv>/)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writePerConvTrajectory(ctx.tmpDir, { convId: 'CONV-PC2', withAceSearch: true });
		runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-PC2', jsonlPath: jsonl });
		// Top-level debug log gets written.
		const topDebug = path.join(ctx.tmpDir, '.cursor', 'ace', 'ace-stop-debug.log');
		expect(fs.existsSync(topDebug)).toBe(true);
		expect(fs.readFileSync(topDebug, 'utf-8')).toMatch(/helper invoked/);
		// v0.5.0-dev.24 — nested path is NOT used (under either tasks/ or
		// legacy sessions/) — diagnostic visibility stays unified at top-level.
		const nestedDebug = path.join(ctx.tmpDir, '.cursor', 'ace', 'tasks', 'CONV-PC2', 'ace-stop-debug.log');
		expect(fs.existsSync(nestedDebug)).toBe(false);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('settings.json resolves at top-level .cursor/ace/ even when jsonl is per-conv', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writePerConvTrajectory(ctx.tmpDir, { convId: 'CONV-PC3', withAceSearch: true });
		// Settings file at TOP-LEVEL .cursor/ace/settings.json (not under tasks/).
		const aceTopDir = path.join(ctx.tmpDir, '.cursor', 'ace');
		fs.writeFileSync(path.join(aceTopDir, 'settings.json'), JSON.stringify({
			env: { ACE_ORG_ID: 'ORG-PC', ACE_PROJECT_ID: 'PROJ-PC' },
		}));
		runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-PC3', jsonlPath: jsonl });
		const log = fs.readFileSync(path.join(aceTopDir, 'ace-stop-debug.log'), 'utf-8');
		expect(log).toMatch(/settings_json_loaded/);
		expect(log).toMatch(/orgId=ORG-PC/);
		expect(log).toMatch(/projectId=PROJ-PC/);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('ace-review-result.json is written to top-level .cursor/ace/ (next prompt reads it)', () => {
		const ctx = writeHelperWithStub();
		const jsonl = writePerConvTrajectory(ctx.tmpDir, { convId: 'CONV-PC4', withAceSearch: true });
		runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-PC4', jsonlPath: jsonl });
		const reviewPath = path.join(ctx.tmpDir, '.cursor', 'ace', 'ace-review-result.json');
		expect(fs.existsSync(reviewPath)).toBe(true);
		// And NOT in the per-conv subdir.
		const nestedReview = path.join(ctx.tmpDir, '.cursor', 'ace', 'tasks', 'CONV-PC4', 'ace-review-result.json');
		expect(fs.existsSync(nestedReview)).toBe(false);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});

	it('top-level jsonl path still works (backwards compatibility)', () => {
		// When per-conv directory doesn't exist, helper should still process the
		// legacy top-level path.
		const ctx = writeHelperWithStub();
		// Build a top-level mcp_trajectory.jsonl directly.
		const aceDir = path.join(ctx.tmpDir, '.cursor', 'ace');
		const topJsonl = path.join(aceDir, 'mcp_trajectory.jsonl');
		fs.writeFileSync(topJsonl, JSON.stringify({
			conversation_id: 'CONV-LEG-PC', tool_name: 'Read', tool_input: '{}',
		}) + '\n');
		const r = runHelper({ tmpDir: ctx.tmpDir, helperPath: ctx.helperPath, convId: 'CONV-LEG-PC', jsonlPath: topJsonl });
		expect(r.status).toBe(0);
		fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
	});
});

// ===========================================================================
// dev.19 Task A — Stop hook script prefers per-conv jsonl path
// ===========================================================================

describe('dev.19 — stop hook script picks per-conv jsonl when present', () => {
	it('stop hook source contains per-conv jsonl preference logic', async () => {
		const { getStopHookScriptContent } = await import('../../ace/v05Helpers');
		const script = getStopHookScriptContent();
		// v0.5.0-dev.24 — prefers tasks/<conv>/mcp_trajectory.jsonl
		// (renamed from sessions/), falls back to top-level.
		expect(script).toMatch(/tasks\/\$conv_id\/mcp_trajectory\.jsonl/);
		expect(script).toMatch(/per_conv_jsonl/);
		// Top-level fallback present (backwards compat).
		expect(script).toMatch(/jsonl="\$ace_dir\/mcp_trajectory\.jsonl"/);
	});

	it('stop hook work_count check inspects per-conv jsonl', async () => {
		const { getStopHookScriptContent } = await import('../../ace/v05Helpers');
		const script = getStopHookScriptContent();
		expect(script).toMatch(/per_conv_dir="\$ace_dir\/tasks\/\$conv_id"/);
		expect(script).toMatch(/per_conv_dir\/mcp_trajectory\.jsonl/);
	});
});

// ===========================================================================
// dev.19 Task A — extension watcher uses tasks/* glob with per-file size map
// (v0.5.0-dev.24 renamed sessions/ → tasks/)
// ===========================================================================

describe('dev.19 — extension trajectory watcher uses tasks/* glob', () => {
	function readExtensionTs(): string {
		return fs.readFileSync(path.resolve(__dirname, '../../extension.ts'), 'utf-8');
	}

	it('watcher RelativePattern targets tasks/*/mcp_trajectory.jsonl', () => {
		const src = readExtensionTs();
		expect(src).toMatch(/\.cursor\/ace\/tasks\/\*\/mcp_trajectory\.jsonl/);
		// Legacy glob MUST be gone.
		expect(src).not.toMatch(/RelativePattern\(workspaceRoot,\s*'\.cursor\/ace\/sessions\/\*\/mcp_trajectory\.jsonl'\)/);
	});

	it('watcher tracks per-file size in a Map (multiple files now)', () => {
		const src = readExtensionTs();
		expect(src).toMatch(/lastMcpSizeByFile/);
		expect(src).toMatch(/Map<string, number>/);
	});
});
