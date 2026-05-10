/**
 * v0.5.0-dev.10+ Stop-hook + MCP-proxy hotfix tests.
 *
 * Confirmed bugs (all on extension side, not Cursor's):
 *
 *  Bug A — `command -v node` gate trips on Cursor's stripped PATH.
 *    Cursor invokes hooks with PATH=/usr/bin:/bin (no /opt/homebrew/bin,
 *    no nvm shims). Helper never runs, no ace-review-result.json written.
 *    Same bug exists in getDomainShiftScriptContent().
 *
 *  Bug B — MCP proxy hides ace_learn from tools/list. With Bug A breaking
 *    server-side learn, AI has no fallback because it cannot see the tool.
 *    Decision: keep ace_get_playbook hidden (legitimately deprecated) but
 *    UN-FILTER ace_learn so the AI can call it as a fallback when the
 *    extension's Stop hook fails to learn server-side.
 *
 *  Bug C — Excessive silent gating in stop hook. Multiple `exit 0` paths
 *    with no breadcrumbs. Replace silent exits with logged exits and pipe
 *    helper stderr to a debug log so failures are diagnosable.
 *
 * RED → GREEN: these tests assert the FIXED behaviour. They fail today.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
	getStopHookScriptContent,
	getDomainShiftScriptContent,
} from '../../ace/v05Helpers';
import { getAceMcpProxyContent, HIDDEN_MCP_TOOLS } from '../../mcp/ace-mcp-proxy';

// ===========================================================================
// Bug A — node-resolution probe in stop hook + domain-shift hook
// ===========================================================================

describe('Bug A — Stop hook resolves node on Cursor stripped PATH', () => {
	it('stop hook prepends common node install dirs to PATH', () => {
		const script = getStopHookScriptContent();
		// Must extend PATH with at least one of the homebrew / nvm / /usr/local
		// install dirs so `command -v node` finds node when Cursor ships
		// PATH=/usr/bin:/bin only.
		expect(script).toMatch(/\/opt\/homebrew\/bin/);
		expect(script).toMatch(/\/usr\/local\/bin/);
		// nvm default install path under HOME
		expect(script).toMatch(/\.nvm\/versions\/node|\.nvm\/current/);
		// PATH= export must precede the FIRST EXECUTABLE node lookup.
		// Search line-by-line and skip comment lines so we don't false-match
		// on commentary that mentions `command -v node`.
		const lines = script.split('\n');
		let exportLine = -1;
		let lookupLine = -1;
		for (let i = 0; i < lines.length; i++) {
			const stripped = lines[i].replace(/^\s*/, '');
			if (stripped.startsWith('#')) continue;
			if (exportLine === -1 && /^export\s+PATH="[^"\n]*\/opt\/homebrew\/bin/.test(stripped)) {
				exportLine = i;
			}
			if (lookupLine === -1 && /^if\s+command\s+-v\s+node|^command\s+-v\s+node/.test(stripped)) {
				lookupLine = i;
			}
		}
		expect(exportLine, 'export PATH=...homebrew... line not found').toBeGreaterThanOrEqual(0);
		if (lookupLine >= 0) {
			expect(exportLine, `export PATH must precede the node lookup (export@${exportLine}, lookup@${lookupLine})`).toBeLessThan(lookupLine);
		}
	});

	it('domain-shift hook prepends common node install dirs to PATH (Bug A clone)', () => {
		const script = getDomainShiftScriptContent();
		expect(script).toMatch(/\/opt\/homebrew\/bin/);
		expect(script).toMatch(/\/usr\/local\/bin/);
		expect(script).toMatch(/\.nvm\/versions\/node|\.nvm\/current/);
	});

	// Functional smoke: when invoked with PATH=/usr/bin:/bin, the script
	// must NOT exit 0 silently because of node-not-found. Easiest way to
	// check: run script with stripped PATH against a synthetic input that
	// fails an EARLIER gate on purpose (e.g. status != completed) and
	// confirm the breadcrumb mentions the EARLIER gate, not "node missing".
	// If node-not-found short-circuits, the breadcrumb file would still be
	// written by the unconditional write — but for a stronger test we check
	// the script itself exposes a NODE_BIN/which-node resolver that survives
	// stripped PATH.
	it('stop hook contains an explicit node binary resolver (not bare command -v)', () => {
		const script = getStopHookScriptContent();
		// Either the script picks the first existing path from a list, or it
		// extends PATH then re-checks. We require at least one explicit
		// candidate path probe with -x test.
		const hasExplicitProbe = /-x\s+["']?(\/opt\/homebrew\/bin\/node|\/usr\/local\/bin\/node|\$HOME\/\.nvm)/.test(script);
		const hasPathExtend = /export PATH="?[^"\n]*\/opt\/homebrew\/bin/.test(script);
		expect(hasExplicitProbe || hasPathExtend).toBe(true);
	});
});

// ===========================================================================
// Bug B — MCP proxy must NOT hide ace_learn
// ===========================================================================

describe('Bug B — MCP proxy un-filters ace_learn (AI needs it as fallback)', () => {
	it('HIDDEN_MCP_TOOLS no longer contains ace_learn', () => {
		expect(HIDDEN_MCP_TOOLS).not.toContain('ace_learn');
	});

	it('HIDDEN_MCP_TOOLS still contains ace_get_playbook (legitimately hidden)', () => {
		expect(HIDDEN_MCP_TOOLS).toContain('ace_get_playbook');
	});

	it('proxy script source does NOT bake ace_learn into the hidden set', () => {
		const src = getAceMcpProxyContent();
		// The hidden-set declaration line shouldn't list ace_learn.
		// We grep specifically for the HIDDEN/Set line.
		const hiddenLineMatch = src.match(/HIDDEN\s*=\s*new Set\(([^)]+)\)/);
		expect(hiddenLineMatch, 'HIDDEN set declaration not found').toBeTruthy();
		const declared = hiddenLineMatch![1];
		expect(declared).not.toMatch(/ace_learn/);
		expect(declared).toMatch(/ace_get_playbook/);
	});

	it('proxy filterLine LEAVES ace_learn in the tools/list response', () => {
		// Re-implement the filterLine contract using the EXPORTED HIDDEN_MCP_TOOLS
		// to prove the proxy passes ace_learn through.
		const HIDDEN = new Set<string>(HIDDEN_MCP_TOOLS);
		const filterLine = (line: string): string => {
			if (!line || !line.trim()) return line;
			let msg: any;
			try { msg = JSON.parse(line); } catch (_) { return line; }
			if (!msg || typeof msg !== 'object') return line;
			if (msg.result && Array.isArray(msg.result.tools)) {
				msg.result.tools = msg.result.tools.filter((t: any) => {
					return !(t && typeof t.name === 'string' && HIDDEN.has(t.name));
				});
				return JSON.stringify(msg);
			}
			return line;
		};
		const resp = JSON.stringify({
			jsonrpc: '2.0', id: 1, result: { tools: [
				{ name: 'ace_search' },
				{ name: 'ace_learn' },
				{ name: 'ace_get_playbook' },
				{ name: 'ace_status' },
			] },
		});
		const out = JSON.parse(filterLine(resp));
		const names = out.result.tools.map((t: any) => t.name);
		expect(names).toContain('ace_learn');
		expect(names).toContain('ace_search');
		expect(names).toContain('ace_status');
		expect(names).not.toContain('ace_get_playbook');
	});
});

// ===========================================================================
// Bug C — diagnosable gating + helper stderr capture
// ===========================================================================

describe('Bug C — Stop hook breadcrumbs every gate failure', () => {
	const writeAndRun = (input: string, env: NodeJS.ProcessEnv = {}) => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stop-bug-c-'));
		const scriptPath = path.join(tmp, 'ace_stop_hook.sh');
		fs.writeFileSync(scriptPath, getStopHookScriptContent(), { mode: 0o755 });
		try {
			execFileSync('bash', [scriptPath], {
				input,
				encoding: 'utf-8',
				cwd: tmp,
				env: { ...process.env, ...env },
				timeout: 5000,
			});
			const logPath = path.join(tmp, '.cursor', 'ace', 'ace-stop-debug.log');
			const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
			return { tmp, log };
		} finally {
			// keep tmp for caller cleanup; here we clean unconditionally
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	};

	it('writes breadcrumb when status != completed (was silent exit 0)', () => {
		const { log } = writeAndRun(JSON.stringify({
			status: 'in_progress',
			conversation_id: 'conv-c1',
			loop_count: 0,
		}));
		expect(log).toMatch(/STOP_FIRED/);
		// Bug C fix: an explicit reason for the gate exit
		expect(log).toMatch(/skip|gate|status_not_completed|status!=completed/i);
	});

	it('writes breadcrumb when conv_id is empty (was silent exit 0)', () => {
		const { log } = writeAndRun(JSON.stringify({
			status: 'completed',
			loop_count: 0,
			conversation_id: '',
		}));
		expect(log).toMatch(/STOP_FIRED/);
		expect(log).toMatch(/no_conv_id|empty conv|no conversation_id/i);
	});

	it('writes breadcrumb when work_count is 0 (was silent exit 0)', () => {
		const { log } = writeAndRun(JSON.stringify({
			status: 'completed',
			loop_count: 0,
			conversation_id: 'conv-no-work',
		}));
		expect(log).toMatch(/STOP_FIRED/);
		expect(log).toMatch(/no_work|work_count.*0|no_trajectory/i);
	});

	it('writes breadcrumb when helper file is missing', () => {
		// Pretend a real conv with work but no helper available.
		// We pre-create a trajectory file so the work_count gate passes.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stop-bug-c-helper-'));
		const aceDir = path.join(tmp, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		fs.writeFileSync(
			path.join(aceDir, 'mcp_trajectory.jsonl'),
			JSON.stringify({ conversation_id: 'conv-h1', tool_name: 'ace_search' }) + '\n',
		);
		const scriptPath = path.join(tmp, 'ace_stop_hook.sh');
		fs.writeFileSync(scriptPath, getStopHookScriptContent('/nonexistent/helper.js'), { mode: 0o755 });
		try {
			execFileSync('bash', [scriptPath], {
				input: JSON.stringify({
					status: 'completed', loop_count: 0, conversation_id: 'conv-h1',
				}),
				encoding: 'utf-8',
				cwd: tmp,
				timeout: 5000,
			});
			const log = fs.readFileSync(path.join(aceDir, 'ace-stop-debug.log'), 'utf-8');
			expect(log).toMatch(/helper_missing|HELPER not found|missing helper/i);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('captures helper stderr to ace-stop-debug.log instead of /dev/null', () => {
		const script = getStopHookScriptContent();
		// The bug-C fix must redirect helper stderr to the debug log,
		// not silence it. Look for any redirection of stderr (2>>) that
		// targets the debug log var or path.
		const capturesStderr = /2>>\s*"?\$?(debug_log|\{?ace_dir\}?[^"\n]*ace-stop-debug\.log)/.test(script)
			|| /2>>\s*"?[^"\n]*ace-stop-debug\.log/.test(script);
		expect(capturesStderr, 'helper stderr must redirect to ace-stop-debug.log, not /dev/null').toBe(true);
	});

	it('does NOT silently swallow helper output with `>/dev/null 2>&1 || true`', () => {
		const script = getStopHookScriptContent();
		// Specifically the helper invocation must not use the silencing pattern.
		// Find every line that calls the helper (node "$HELPER" or
		// "$NODE_BIN" "$HELPER") and check none ends in the silenced
		// "|| true" with both stdout+stderr to /dev/null.
		const helperCallLines = script
			.split('\n')
			.filter(l => /(node|\$\{?NODE_BIN\}?|"\$NODE_BIN")\s+"?\$\{?HELPER\}?"?/.test(l));
		expect(helperCallLines.length).toBeGreaterThan(0);
		for (const line of helperCallLines) {
			expect(line, `helper call still silenced: ${line}`).not.toMatch(/>\/dev\/null\s+2>&1\s*\|\|\s*true/);
		}
	});

	it('passes a syntax check (bash -n) after Bug C edits', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stop-syntax-'));
		try {
			const p = path.join(tmp, 'ace_stop_hook.sh');
			fs.writeFileSync(p, getStopHookScriptContent());
			execFileSync('bash', ['-n', p], { stdio: 'pipe' });
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Cross-cutting: stop hook still resolves node when Cursor strips PATH
// ===========================================================================

describe('Bug A — functional: stop hook finds node with stripped PATH', () => {
	it('with PATH=/usr/bin:/bin, hook does NOT log node_missing (resolver works)', () => {
		// We can't fully exercise the helper (network etc), but we can confirm
		// that the script reaches the helper-spawn step rather than logging
		// "node_missing". We pre-create work so earlier gates pass.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-stop-strippath-'));
		const aceDir = path.join(tmp, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
		fs.writeFileSync(
			path.join(aceDir, 'mcp_trajectory.jsonl'),
			JSON.stringify({ conversation_id: 'conv-pa1', tool_name: 'ace_search' }) + '\n',
		);
		const scriptPath = path.join(tmp, 'ace_stop_hook.sh');
		// Helper that just exits 0 — proves the script reached spawn.
		const fakeHelper = path.join(tmp, 'fake_helper.js');
		fs.writeFileSync(fakeHelper, "process.exit(0);\n", { mode: 0o755 });
		fs.writeFileSync(scriptPath, getStopHookScriptContent(fakeHelper), { mode: 0o755 });
		try {
			execFileSync('bash', [scriptPath], {
				input: JSON.stringify({
					status: 'completed', loop_count: 0, conversation_id: 'conv-pa1',
				}),
				encoding: 'utf-8',
				cwd: tmp,
				// Critical: simulate Cursor's stripped PATH.
				env: {
					HOME: process.env.HOME,
					PATH: '/usr/bin:/bin',
				},
				timeout: 10000,
			});
			const log = fs.readFileSync(path.join(aceDir, 'ace-stop-debug.log'), 'utf-8');
			// Must NOT log node_missing.
			expect(log).not.toMatch(/node_missing|node not found|node-missing/i);
			// Must record that the helper was actually invoked.
			expect(log).toMatch(/STOP_FIRED/);
			expect(log).toMatch(/helper_(start|spawn|invoking|running|done|exit)/i);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
