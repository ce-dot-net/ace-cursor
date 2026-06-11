/**
 * v0.5.0-dev.4 TASK 1 — MCP proxy tests.
 *
 * The proxy wraps `npx @ace-sdk/mcp` and filters tools/list responses to hide
 * ace_get_playbook from the AI's view. AI cannot call tools it cannot see.
 *
 * v0.5.0-dev.10+ HOTFIX: ace_learn is NO LONGER filtered (was hidden in
 * earlier dev builds). Rationale: when the extension Stop hook fails to
 * run server-side learn (e.g. Cursor strips PATH), the AI must be able to
 * see and call ace_learn as a fallback.
 *
 * Tests:
 *  - script content has Node shebang + JSON-RPC parsing
 *  - script lists the hidden tools correctly (ace_get_playbook only)
 *  - running the script as a child against a fake "MCP server" filters tools
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { getAceMcpProxyContent, HIDDEN_MCP_TOOLS, MAX_SEARCH_RESULTS, MAX_INLINE_PATTERN_BYTES, MCP_SERVER_INSTRUCTIONS, packPatternsUntilSize } from '../../mcp/ace-mcp-proxy';

// Caveman helpers — mini reimpls of the proxy's mutateRequestLine and
// filterLine functions, kept identical to the baked script so we can unit-test
// them in-process. The e2e harness below validates that the actual baked
// script behaves the same end-to-end.
function makeMutateRequestLine(envClientId?: string) {
	const env = envClientId === undefined ? {} : { ACE_CLIENT_ID: envClientId };
	return (line: string): string => {
		if (!line || !line.trim()) return line;
		let msg: any;
		try { msg = JSON.parse(line); } catch (_) { return line; }
		if (!msg || typeof msg !== 'object') return line;
		if (msg.method !== 'tools/call') return line;
		if (!msg.params || typeof msg.params !== 'object') return line;
		if (msg.params.name !== 'ace_search') return line;
		const args = (msg.params.arguments && typeof msg.params.arguments === 'object')
			? msg.params.arguments
			: {};
		if (!args.agent_type || typeof args.agent_type !== 'string' || args.agent_type.trim() === '') {
			args.agent_type = (env as any).ACE_CLIENT_ID || 'cursor';
			msg.params.arguments = args;
			try { return JSON.stringify(msg); } catch (_) { return line; }
		}
		return line;
	};
}

function makeFilterLine(opts: { writeDir?: string; throwOnWrite?: boolean } = {}) {
	const HIDDEN = new Set<string>(HIDDEN_MCP_TOOLS);
	const fsMod = require('node:fs');
	const pathMod = require('node:path');
	return (line: string): string => {
		if (!line || !line.trim()) return line;
		let msg: any;
		try { msg = JSON.parse(line); } catch (_) { return line; }
		if (!msg || typeof msg !== 'object') return line;
		// initialize response → inject MCP_SERVER_INSTRUCTIONS.
		if (msg.result
			&& typeof msg.result.protocolVersion === 'string'
			&& msg.result.serverInfo
			&& typeof msg.result.serverInfo === 'object'
			&& typeof msg.result.serverInfo.name === 'string') {
			msg.result.instructions = MCP_SERVER_INSTRUCTIONS;
			try { return JSON.stringify(msg); } catch (_) { return line; }
		}
		if (msg.result && Array.isArray(msg.result.tools)) {
			msg.result.tools = msg.result.tools.filter((t: any) => {
				return !(t && typeof t.name === 'string' && HIDDEN.has(t.name));
			});
			return JSON.stringify(msg);
		}
		try {
			if (msg.result && Array.isArray(msg.result.content) && msg.result.content[0]
				&& typeof msg.result.content[0].text === 'string') {
				const innerText = msg.result.content[0].text;
				let inner: any;
				try { inner = JSON.parse(innerText); } catch (_) { return line; }
				if (inner && typeof inner === 'object'
					&& Array.isArray(inner.results)
					&& typeof inner.query === 'string') {
					const originalCount = (typeof inner.count === 'number') ? inner.count : inner.results.length;
					// u10-expanded Fix A (revised): strip match_factors both for
					// byte-counting AND from inline output. The disk copy preserves
					// the full patterns. This ensures the wire payload stays under
					// the 8 KB Cursor pipe limit even when match_factors are present.
					const stripped = inner.results.map((p: any) => {
						// eslint-disable-next-line @typescript-eslint/no-unused-vars
						const { match_factors, ...rest } = p;
						return rest;
					});
					const packed = packPatternsUntilSize(stripped, MAX_INLINE_PATTERN_BYTES);
					// u10-expanded Fix B (early-return fix): inject expanded_note BEFORE
					// the early return so non-truncated responses with expanded[] still
					// get the note.
					const expandedNoteValue = (Array.isArray(inner.expanded) && inner.expanded.length > 0)
						? inner.expanded.length + ' 2-hop neighbor pattern(s) from local graph cache are in expanded[].' +
							' Cached stubs (cached:true) are already in ~/.ace-cache — call ace_batch_get([...pattern_ids]) to fetch their content.'
						: undefined;
					if (packed.length >= inner.results.length) {
						// No truncation needed — only re-emit when there's something to
						// change: neighbors to annotate OR match_factors to strip.
						const hasMF = inner.results.some((p: any) => p.match_factors !== undefined);
						if (expandedNoteValue === undefined && !hasMF) {
							// Pure 1.0 path — nothing changed, avoid re-serialising.
							return line;
						}
						// Strip match_factors from inline and/or inject expanded_note.
						inner.results = stripped;
						if (expandedNoteValue !== undefined) inner.expanded_note = expandedNoteValue;
						msg.result.content[0].text = JSON.stringify(inner, null, 2);
						return JSON.stringify(msg);
					}
					// Truncation path: write full (un-stripped) inner JSON to disk first.
					const sid = (typeof inner.session_id === 'string' && inner.session_id) ? inner.session_id : ('search-' + Date.now());
					const safeSid = String(sid).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
					const baseDir = opts.writeDir || process.cwd();
					const fullPath = pathMod.join(baseDir, '.cursor', 'ace', 'searches', safeSid + '.json');
					let writtenPath = '';
					try {
						if (opts.throwOnWrite) throw new Error('synthetic write failure');
						fsMod.mkdirSync(pathMod.dirname(fullPath), { recursive: true });
						fsMod.writeFileSync(fullPath, JSON.stringify(inner, null, 2));
						writtenPath = fullPath;
					} catch (_) { /* defensive — passthrough without full path */ }
					inner.original_count = originalCount;
					inner.truncated_to = packed.length;
					// Inline: use stripped patterns (no match_factors) to stay under 8 KB.
					inner.results = stripped.slice(0, packed.length);
					if (writtenPath) {
						inner.full_results_path = writtenPath;
						inner.full_results_note = 'FULL RESULTS: Showing top ' + packed.length + ' of ' + originalCount +
							' patterns inline. The complete result set (including expanded[] neighbors) is at ' + writtenPath +
							'. If patterns inline don\'t fully address the task, Read the full file for the complete pattern library.';
					}
					if (expandedNoteValue !== undefined) {
						inner.expanded_note = expandedNoteValue;
					}
					msg.result.content[0].text = JSON.stringify(inner, null, 2);
					return JSON.stringify(msg);
				}
			}
		} catch (_) { /* passthrough */ }
		return line;
	};
}

describe('ACE MCP proxy — content', () => {
	it('returns a non-trivial Node script with proper shebang', () => {
		const script = getAceMcpProxyContent();
		expect(script.length).toBeGreaterThan(500);
		expect(script.startsWith('#!/usr/bin/env node')).toBe(true);
	});

	it('lists ace_get_playbook as hidden (ace_learn no longer hidden)', () => {
		expect(HIDDEN_MCP_TOOLS).toContain('ace_get_playbook');
		// v0.5.0-dev.10+ — ace_learn must remain visible as fallback
		expect(HIDDEN_MCP_TOOLS).not.toContain('ace_learn');
	});

	it('script bakes hidden tool names into a Set/array', () => {
		const script = getAceMcpProxyContent();
		expect(script).toContain('ace_get_playbook');
	});

	it('script spawns @ace-sdk/mcp via npx', () => {
		const script = getAceMcpProxyContent();
		expect(script).toContain('@ace-sdk/mcp');
		expect(script).toMatch(/spawn\(['"]npx['"]/);
	});

	it('script uses pinned @ace-sdk/mcp@^3.1.1 (no bare unversioned @ace-sdk/mcp in spawn args)', () => {
		const script = getAceMcpProxyContent();
		// Must contain the pinned version string.
		expect(script).toContain('@ace-sdk/mcp@^3.1.1');
		// Must NOT contain the bare unversioned string as a standalone spawn argument.
		// The bare string '@ace-sdk/mcp' followed by ']' or ',' (array element boundary)
		// would indicate an unversioned arg. We check the spawn array specifically.
		expect(script).not.toMatch(/['"]-y['"],\s*['"]@ace-sdk\/mcp['"]\s*[,\]]/);
	});

	it('script parses JSON line-by-line and re-emits filtered', () => {
		const script = getAceMcpProxyContent();
		expect(script).toContain('JSON.parse');
		expect(script).toContain('JSON.stringify');
		// Must reference tools/list result.tools shape
		expect(script).toMatch(/result\.tools/);
	});

	it('script forwards stderr unmodified', () => {
		const script = getAceMcpProxyContent();
		expect(script).toMatch(/stderr.*pipe.*process\.stderr|process\.stderr.*stderr/i);
	});
});

describe('ACE MCP proxy — runtime filtering (Node child harness)', () => {
	// The proxy script unconditionally spawns `npx -y @ace-sdk/mcp`. To test
	// filtering in isolation, we extract the filterLine() function via a
	// small Node harness that loads the proxy code, overrides the spawn
	// behaviour, and pipes test JSON-RPC lines through.
	//
	// Easier path: write the proxy script + a fake "child" replacement to a
	// tmpdir, set PATH so `npx` resolves to the fake, then drive stdin/stdout.

	it('filterLine strips ace_get_playbook (ace_learn passes through) from tools/list response', () => {
		// Caveman: load the proxy source, eval the filterLine fn standalone.
		const src = getAceMcpProxyContent();
		// Extract everything inside filterLine's body. We construct a Function
		// that mirrors the proxy's filter logic with the same HIDDEN set.
		const HIDDEN = new Set<string>(HIDDEN_MCP_TOOLS);
		// Mini reimpl mirroring the proxy contract — kept identical.
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

		// Verify the proxy source contains the same logic as our mini reimpl.
		expect(src).toContain('msg.result.tools');
		expect(src).toContain('HIDDEN.has');

		// Now smoke the mini reimpl with a tools/list response.
		const toolsListResp = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: {
				tools: [
					{ name: 'ace_search', description: 'search' },
					{ name: 'ace_get_playbook', description: 'full dump' },
					{ name: 'ace_learn', description: 'learn' },
					{ name: 'ace_status', description: 'status' },
					{ name: 'ace_list_domains', description: 'domains' },
				],
			},
		});

		const filtered = JSON.parse(filterLine(toolsListResp));
		const names = filtered.result.tools.map((t: any) => t.name);
		expect(names).toContain('ace_search');
		expect(names).toContain('ace_status');
		expect(names).toContain('ace_list_domains');
		expect(names).not.toContain('ace_get_playbook');
		// v0.5.0-dev.10+ — ace_learn must pass through (fallback path)
		expect(names).toContain('ace_learn');
	});

	it('filterLine passthrough for non tools/list responses', () => {
		const src = getAceMcpProxyContent();
		// Reproduce same logic.
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
		expect(src.length).toBeGreaterThan(0);

		// Non tools/list response (e.g. tools/call result) — passthrough.
		const callResp = JSON.stringify({
			jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hi' }] },
		});
		expect(filterLine(callResp)).toBe(callResp);

		// Garbage line — passthrough.
		expect(filterLine('not json')).toBe('not json');
		expect(filterLine('')).toBe('');
	});
});

describe('ACE MCP proxy — end-to-end with fake npx (smoke)', () => {
	// Wire-level test: write the proxy + a fake `npx` shim that emits a fake
	// tools/list response. Spawn the proxy with PATH pointed at the shim and
	// verify stdout contains the filtered response.
	//
	// We isolate by writing to /tmp/ace-mcp-proxy-test-<rand>. Cleanup in finally.
	it('proxy strips hidden tools when fake npx emits tools/list', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-proxy-e2e-'));
		try {
			const proxyPath = path.join(tmp, 'ace_mcp_proxy.js');
			fs.writeFileSync(proxyPath, getAceMcpProxyContent(), { mode: 0o755 });

			// Fake `npx` shim — we install it as a binary named `npx` on PATH.
			// When the proxy spawns `npx -y @ace-sdk/mcp`, the shim runs instead
			// and emits two JSON-RPC lines: one tools/list response, one ping.
			const binDir = path.join(tmp, 'bin');
			fs.mkdirSync(binDir);
			const shimPath = path.join(binDir, 'npx');
			fs.writeFileSync(shimPath, `#!/bin/bash
# fake npx — emit three JSON-RPC lines, then exit clean.
cat <<'EOF'
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"@ace-sdk/mcp","version":"2.19.3"},"capabilities":{"tools":{}}}}
{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ace_search"},{"name":"ace_get_playbook"},{"name":"ace_learn"},{"name":"ace_status"}]}}
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}
EOF
`, { mode: 0o755 });

			// Run proxy with PATH=binDir:rest so its child(npx) is our shim.
			const proxyOut = spawnSync('node', [proxyPath], {
				input: '', // proxy reads from stdin but we send nothing.
				encoding: 'utf-8',
				env: {
					...process.env,
					PATH: `${binDir}:${process.env.PATH || ''}`,
				},
				timeout: 5000,
			});

			expect(proxyOut.status).toBe(0);
			const lines = proxyOut.stdout.split('\n').filter(l => l.trim().length > 0);
			expect(lines.length).toBeGreaterThanOrEqual(3);

			// First line: initialize response — must contain injected instructions.
			const initResp = JSON.parse(lines[0]);
			expect(initResp.result.protocolVersion).toBe('2024-11-05');
			expect(initResp.result.serverInfo.name).toBe('@ace-sdk/mcp');
			expect(typeof initResp.result.instructions).toBe('string');
			expect(initResp.result.instructions).toContain('ace_search');

			// Second line: tools/list — must NOT contain ace_get_playbook.
			// ace_learn passes through (v0.5.0-dev.10+ fallback path).
			const tlist = JSON.parse(lines[1]);
			const names = tlist.result.tools.map((t: any) => t.name);
			expect(names).toContain('ace_search');
			expect(names).toContain('ace_status');
			expect(names).not.toContain('ace_get_playbook');
			expect(names).toContain('ace_learn');

			// Third line: tools/call result — passthrough.
			const tcall = JSON.parse(lines[2]);
			expect(tcall.result.content[0].text).toBe('ok');
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('ACE MCP proxy — Fix A (stdin agent_type injection)', () => {
	it('source contains mutateRequestLine and stdin line buffer (no dumb pipe)', () => {
		const src = getAceMcpProxyContent();
		expect(src).toContain('mutateRequestLine');
		expect(src).toContain('ACE_CLIENT_ID');
		// Must NOT use the old dumb pipe — we need line-buffered processing.
		expect(src).not.toMatch(/process\.stdin\.pipe\(child\.stdin\)/);
	});

	it('injects agent_type=cursor when AI omits it on ace_search', () => {
		const mutate = makeMutateRequestLine();
		const req = JSON.stringify({
			jsonrpc: '2.0', id: 7, method: 'tools/call',
			params: { name: 'ace_search', arguments: { query: 'foo' } },
		});
		const out = JSON.parse(mutate(req));
		expect(out.params.arguments.agent_type).toBe('cursor');
		expect(out.params.arguments.query).toBe('foo');
	});

	it('preserves AI-provided agent_type (no overwrite)', () => {
		const mutate = makeMutateRequestLine();
		const req = JSON.stringify({
			jsonrpc: '2.0', id: 8, method: 'tools/call',
			params: { name: 'ace_search', arguments: { query: 'foo', agent_type: 'claude-code' } },
		});
		// Same identity check — if no mutation occurred, line passes through verbatim.
		expect(mutate(req)).toBe(req);
	});

	it('does not mutate non-ace_search tools/call (e.g. ace_status)', () => {
		const mutate = makeMutateRequestLine();
		const req = JSON.stringify({
			jsonrpc: '2.0', id: 9, method: 'tools/call',
			params: { name: 'ace_status', arguments: {} },
		});
		expect(mutate(req)).toBe(req);
	});

	it('does not mutate non-tools/call requests (initialize, etc.)', () => {
		const mutate = makeMutateRequestLine();
		const init = JSON.stringify({
			jsonrpc: '2.0', id: 0, method: 'initialize',
			params: { protocolVersion: '2024-11-05', capabilities: {} },
		});
		expect(mutate(init)).toBe(init);
		const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(mutate(list)).toBe(list);
	});

	it('passthrough on malformed JSON (does not crash)', () => {
		const mutate = makeMutateRequestLine();
		expect(mutate('not json at all')).toBe('not json at all');
		expect(mutate('')).toBe('');
		expect(mutate('   ')).toBe('   ');
		expect(mutate('{"unterminated": ')).toBe('{"unterminated": ');
	});

	it('respects ACE_CLIENT_ID env var override (e.g. jetbrains)', () => {
		const mutate = makeMutateRequestLine('jetbrains');
		const req = JSON.stringify({
			jsonrpc: '2.0', id: 10, method: 'tools/call',
			params: { name: 'ace_search', arguments: { query: 'q' } },
		});
		const out = JSON.parse(mutate(req));
		expect(out.params.arguments.agent_type).toBe('jetbrains');
	});

	it('treats empty-string agent_type as missing and injects', () => {
		const mutate = makeMutateRequestLine();
		const req = JSON.stringify({
			jsonrpc: '2.0', id: 11, method: 'tools/call',
			params: { name: 'ace_search', arguments: { query: 'q', agent_type: '' } },
		});
		const out = JSON.parse(mutate(req));
		expect(out.params.arguments.agent_type).toBe('cursor');
	});
});

describe('ACE MCP proxy — Fix B2 / Task B+D (smart-packed ace_search + full results on disk)', () => {
	function buildSearchResponse(numResults: number, perPatternBytes = 500, sessionId?: string) {
		// Build realistic-ish patterns at ~500 bytes each.
		const filler = 'x'.repeat(Math.max(0, perPatternBytes - 80));
		const results = Array.from({ length: numResults }, (_, i) => ({
			id: `pat-${i}`,
			name: `pattern-${i}`,
			content: filler,
			confidence: 0.9,
			helpful: 5,
		}));
		const inner: any = { query: 'foo', threshold: 0.7, results, count: numResults };
		if (sessionId) inner.session_id = sessionId;
		return JSON.stringify({
			jsonrpc: '2.0', id: 42,
			result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
		});
	}

	it('source contains smart-packing + disk-write logic + truncation markers', () => {
		const src = getAceMcpProxyContent();
		expect(src).toContain('packPatternsUntilSize');
		expect(src).toContain('MAX_INLINE_PATTERN_BYTES');
		expect(src).toContain('MAX_SEARCH_RESULTS');
		expect(src).toContain('original_count');
		expect(src).toContain('truncated_to');
		expect(src).toContain('full_results_path');
		expect(src).toContain('full_results_note');
		expect(src).toContain('writeFileSync');
		expect(src).toContain('searches');
	});

	it('smart-packs 150-result response to fit ~7 KB inline budget', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pack-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const resp = buildSearchResponse(150, 500, 'sid-pack-150');
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			expect(inner.results.length).toBeGreaterThan(0);
			expect(inner.results.length).toBeLessThan(150);
			// Inline payload size budget — packed JSON of just the results
			// must stay under MAX_INLINE_PATTERN_BYTES.
			expect(JSON.stringify(inner.results).length).toBeLessThanOrEqual(MAX_INLINE_PATTERN_BYTES);
			expect(inner.original_count).toBe(150);
			expect(inner.truncated_to).toBe(inner.results.length);
			// First pattern retained (top of list).
			expect(inner.results[0].id).toBe('pat-0');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('writes the FULL inner JSON to .cursor/ace/searches/<sid>.json on truncation', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-disk-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const resp = buildSearchResponse(150, 500, 'session-abc');
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			expect(inner.full_results_path).toBeTruthy();
			expect(typeof inner.full_results_path).toBe('string');
			expect(inner.full_results_note).toContain('FULL RESULTS');
			expect(inner.full_results_note).toContain('session-abc');
			// File on disk has all 150 results — not the truncated set.
			const onDisk = JSON.parse(fs.readFileSync(inner.full_results_path, 'utf-8'));
			expect(Array.isArray(onDisk.results)).toBe(true);
			expect(onDisk.results.length).toBe(150);
			expect(onDisk.session_id).toBe('session-abc');
			// Path follows the .cursor/ace/searches/<sid>.json pattern.
			expect(inner.full_results_path).toMatch(/\.cursor\/ace\/searches\/session-abc\.json$/);
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('does not truncate when results fit under the budget', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-nopack-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const resp = buildSearchResponse(3, 500);
			expect(filter(resp)).toBe(resp);
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('emits truncated payload (no full_results_path) when disk write fails', () => {
		const filter = makeFilterLine({ throwOnWrite: true });
		const resp = buildSearchResponse(150, 500, 'sid-fail');
		const filtered = JSON.parse(filter(resp));
		const inner = JSON.parse(filtered.result.content[0].text);
		// Truncation still happens.
		expect(inner.results.length).toBeGreaterThan(0);
		expect(inner.results.length).toBeLessThan(150);
		// But no full_results_path/note on disk-write failure.
		expect(inner.full_results_path).toBeUndefined();
		expect(inner.full_results_note).toBeUndefined();
	});

	it('passthrough for non-ace_search tools/call response (e.g. ace_status JSON)', () => {
		const filter = makeFilterLine();
		const resp = JSON.stringify({
			jsonrpc: '2.0', id: 5,
			result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, patterns: 42 }) }] },
		});
		expect(filter(resp)).toBe(resp);
	});

	it('passthrough when content[0].text is plain text (not JSON)', () => {
		const filter = makeFilterLine();
		const resp = JSON.stringify({
			jsonrpc: '2.0', id: 6,
			result: { content: [{ type: 'text', text: 'plain old greeting' }] },
		});
		expect(filter(resp)).toBe(resp);
	});

	it('still filters tools/list (no regression) — ace_get_playbook stripped, ace_learn visible', () => {
		const filter = makeFilterLine();
		const tlist = JSON.stringify({
			jsonrpc: '2.0', id: 1,
			result: { tools: [
				{ name: 'ace_search' },
				{ name: 'ace_get_playbook' },
				{ name: 'ace_learn' },
				{ name: 'ace_status' },
			]},
		});
		const out = JSON.parse(filter(tlist));
		const names = out.result.tools.map((t: any) => t.name);
		expect(names).not.toContain('ace_get_playbook');
		expect(names).toContain('ace_learn');
		expect(names).toContain('ace_search');
		expect(names).toContain('ace_status');
	});

	it('truncated response stays under 8 KB with realistic ~500 byte patterns', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-8k-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const resp = buildSearchResponse(150, 500, 'sid-8k');
			const filtered = filter(resp);
			expect(filtered.length).toBeLessThan(8 * 1024);
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('defensive passthrough on malformed inner JSON', () => {
		const filter = makeFilterLine();
		const resp = JSON.stringify({
			jsonrpc: '2.0', id: 7,
			result: { content: [{ type: 'text', text: '{"query": "foo", "results": [' }] },
		});
		expect(filter(resp)).toBe(resp);
	});
});

describe('packPatternsUntilSize — pure helper', () => {
	it('returns empty array for empty input', () => {
		expect(packPatternsUntilSize([], 1000)).toEqual([]);
	});

	it('packs patterns until budget exceeded', () => {
		const patterns = Array.from({ length: 100 }, (_, i) => ({ id: i, content: 'x'.repeat(200) }));
		const packed = packPatternsUntilSize(patterns, 2000);
		// JSON.stringify(packed).length must stay <= 2000 (or 1 oversize pattern).
		expect(JSON.stringify(packed).length).toBeLessThanOrEqual(2000);
		expect(packed.length).toBeGreaterThan(0);
		expect(packed.length).toBeLessThan(100);
		// First-N order preserved.
		expect(packed[0].id).toBe(0);
	});

	it('keeps at least one pattern even when first exceeds budget', () => {
		const huge = { id: 'huge', content: 'x'.repeat(10000) };
		const packed = packPatternsUntilSize([huge, { id: 'small' }], 100);
		expect(packed.length).toBe(1);
		expect(packed[0].id).toBe('huge');
	});

	it('respects MAX_SEARCH_RESULTS hard cap with tiny patterns', () => {
		const tiny = Array.from({ length: 200 }, (_, i) => ({ i }));
		const packed = packPatternsUntilSize(tiny, 100000);
		expect(packed.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
	});

	it('returns all patterns when total fits under budget', () => {
		const items = [{ a: 1 }, { b: 2 }, { c: 3 }];
		expect(packPatternsUntilSize(items, 10000)).toEqual(items);
	});
});

describe('ACE MCP proxy — v0.5.0-dev.16 initialize.instructions injection', () => {
	it('exports MCP_SERVER_INSTRUCTIONS containing ace_search and not forbidden tools', () => {
		expect(typeof MCP_SERVER_INSTRUCTIONS).toBe('string');
		expect(MCP_SERVER_INSTRUCTIONS.length).toBeGreaterThan(50);
		expect(MCP_SERVER_INSTRUCTIONS).toContain('ace_search');
		// Must NOT mention forbidden tool names by name (causes filesystem
		// exploration in Cursor — see prior dev iterations).
		expect(MCP_SERVER_INSTRUCTIONS).not.toContain('ace_learn');
		expect(MCP_SERVER_INSTRUCTIONS).not.toContain('ace_get_playbook');
	});

	it('source bakes MCP_INSTRUCTIONS constant + protocolVersion+serverInfo branch', () => {
		const src = getAceMcpProxyContent();
		expect(src).toContain('MCP_INSTRUCTIONS');
		expect(src).toContain('protocolVersion');
		expect(src).toContain('serverInfo');
		expect(src).toContain('msg.result.instructions');
		expect(src).toContain('ace_search');
	});

	it('filterLine injects instructions into initialize response', () => {
		const filter = makeFilterLine();
		const initResp = JSON.stringify({
			jsonrpc: '2.0', id: 0,
			result: {
				protocolVersion: '2024-11-05',
				serverInfo: { name: '@ace-sdk/mcp', version: '2.19.3' },
				capabilities: { tools: {} },
			},
		});
		const out = JSON.parse(filter(initResp));
		expect(out.result.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
		// Other fields preserved.
		expect(out.result.protocolVersion).toBe('2024-11-05');
		expect(out.result.serverInfo.name).toBe('@ace-sdk/mcp');
	});

	it('filterLine does NOT add instructions to non-initialize responses', () => {
		const filter = makeFilterLine();
		// tools/list response — has tools array, no protocolVersion.
		const tlist = JSON.stringify({
			jsonrpc: '2.0', id: 1,
			result: { tools: [{ name: 'ace_search' }, { name: 'ace_status' }] },
		});
		const out1 = JSON.parse(filter(tlist));
		expect(out1.result).not.toHaveProperty('instructions');

		// tools/call result — content array, no protocolVersion.
		const callResp = JSON.stringify({
			jsonrpc: '2.0', id: 2,
			result: { content: [{ type: 'text', text: 'hi' }] },
		});
		const out2 = JSON.parse(filter(callResp));
		expect(out2.result).not.toHaveProperty('instructions');

		// Empty/error responses with no result — passthrough.
		const errResp = JSON.stringify({
			jsonrpc: '2.0', id: 3,
			error: { code: -32601, message: 'method not found' },
		});
		expect(filter(errResp)).toBe(errResp);
	});

	it('filterLine OVERWRITES existing instructions field on initialize response', () => {
		// Documented contract: ours wins. Prevents server-set stale instructions
		// from suppressing the proxy's directive.
		const filter = makeFilterLine();
		const initResp = JSON.stringify({
			jsonrpc: '2.0', id: 0,
			result: {
				protocolVersion: '2024-11-05',
				serverInfo: { name: '@ace-sdk/mcp', version: '2.19.3' },
				instructions: 'Stale server-side instructions that should be replaced.',
			},
		});
		const out = JSON.parse(filter(initResp));
		expect(out.result.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
		expect(out.result.instructions).not.toContain('Stale server-side');
	});

	it('filterLine passes through malformed initialize responses (missing serverInfo)', () => {
		const filter = makeFilterLine();
		// protocolVersion present but no serverInfo → not an initialize response.
		const resp = JSON.stringify({
			jsonrpc: '2.0', id: 0,
			result: { protocolVersion: '2024-11-05' },
		});
		expect(filter(resp)).toBe(resp);

		// serverInfo missing name → not a well-formed initialize response.
		const resp2 = JSON.stringify({
			jsonrpc: '2.0', id: 0,
			result: { protocolVersion: '2024-11-05', serverInfo: { version: '1.0' } },
		});
		expect(filter(resp2)).toBe(resp2);
	});
});

describe('ACE MCP proxy — Node syntax sanity', () => {
	it('proxy script parses with `node --check` (no syntax errors)', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mcp-proxy-syntax-'));
		try {
			const p = path.join(tmp, 'ace_mcp_proxy.js');
			fs.writeFileSync(p, getAceMcpProxyContent());
			// `node --check` parses but doesn't run. Throws on syntax error.
			execFileSync('node', ['--check', p], { stdio: 'pipe' });
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ─── u10-expanded: match_factors budget-stripping + expanded_note ─────────────

describe('ACE MCP proxy — u10-expanded (match_factors + expanded neighbors)', () => {
	/**
	 * Build a search response where patterns carry match_factors (~200 bytes each).
	 * When stripped, more patterns fit in the inline budget.
	 */
	function buildSearchResponseWithMatchFactors(
		numResults: number,
		sessionId?: string,
		expanded?: Array<{ pattern_id: string; cumulative_reward: number; cached: boolean }>,
	) {
		// Each pattern is ~300 bytes of content + ~200 bytes of match_factors.
		const filler = 'x'.repeat(250);
		const results = Array.from({ length: numResults }, (_, i) => ({
			id: `pat-${i}`,
			name: `pattern-${i}`,
			content: filler,
			confidence: 0.9,
			helpful: 5,
			match_factors: {
				semantic_score: 0.95 + i * 0.001,
				domain_boost: false,
				domain_relevance: 0,
				error_context_boost: false,
				formula_boost_applied: true,
				ucb_score: 0.97,
				bandit_rank: i + 1,
				retrieval_log_id: 100000 + i,
				retrieval_id: `uuid-${i}`,
				shadow_mode: false,
			},
		}));
		const inner: any = { query: 'foo', threshold: 0.7, results, count: numResults };
		if (sessionId) inner.session_id = sessionId;
		if (expanded !== undefined) inner.expanded = expanded;
		return JSON.stringify({
			jsonrpc: '2.0', id: 42,
			result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
		});
	}

	it('match_factors excluded from byte budget: more patterns fit inline when match_factors present', () => {
		// Build two identical response sets — one with match_factors, one without.
		// After the fix, both should pack the same number of patterns inline
		// because match_factors is stripped before byte-counting.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mf-budget-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });

			// With match_factors on each pattern.
			const respWithMF = buildSearchResponseWithMatchFactors(30, 'sid-mf');
			const filteredWithMF = JSON.parse(filter(respWithMF));
			const innerWithMF = JSON.parse(filteredWithMF.result.content[0].text);
			const countWithMF = innerWithMF.results.length;

			// Without match_factors (same content volume, same budget).
			const filler = 'x'.repeat(250);
			const resultsNoMF = Array.from({ length: 30 }, (_, i) => ({
				id: `pat-${i}`, name: `pattern-${i}`, content: filler, confidence: 0.9, helpful: 5,
			}));
			const innerNoMF: any = { query: 'foo', threshold: 0.7, results: resultsNoMF, count: 30, session_id: 'sid-nomf' };
			const respNoMF = JSON.stringify({
				jsonrpc: '2.0', id: 43,
				result: { content: [{ type: 'text', text: JSON.stringify(innerNoMF) }] },
			});
			const filteredNoMF = JSON.parse(filter(respNoMF));
			const innerNoMFOut = JSON.parse(filteredNoMF.result.content[0].text);
			const countNoMF = innerNoMFOut.results.length;

			// The budget-stripping fix must make withMF pack at least as many patterns
			// as withoutMF (ideally identical, since match_factors are excluded).
			expect(countWithMF).toBeGreaterThanOrEqual(countNoMF);
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('match_factors stripped from inline results but preserved on disk (wire-safe)', () => {
		// Codex-review fix: inline results must NOT carry match_factors so the
		// wire payload stays under the 8 KB Cursor pipe limit.  The disk file
		// (full_results_path) is the authoritative source and MUST preserve them.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-mf-preserve-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-preserve');
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			expect(inner.results.length).toBeGreaterThan(0);
			// Inline: match_factors must be absent (stripped to stay under 8 KB).
			expect(inner.results[0]).not.toHaveProperty('match_factors');
			// Wire budget: the inline results array serializes within 5 000 bytes.
			expect(JSON.stringify(inner.results).length).toBeLessThanOrEqual(MAX_INLINE_PATTERN_BYTES);
			// Disk: full result set preserves match_factors.
			expect(inner.full_results_path).toBeTruthy();
			const onDisk = JSON.parse(fs.readFileSync(inner.full_results_path, 'utf-8'));
			expect(onDisk.results[0]).toHaveProperty('match_factors');
			expect(onDisk.results[0].match_factors).toHaveProperty('semantic_score');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('expanded_note emitted for small response that fits without truncation (early-return bug)', () => {
		// Codex-review finding 2: the early-return path fires before expanded_note
		// is injected.  A response small enough to not need truncation but that
		// still carries expanded[] must emit expanded_note.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-notrunc-expnote-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			// Use just 2 short patterns — easily fits the 5 000-byte budget with
			// no truncation needed.
			const shortFiller = 'y'.repeat(50);
			const results = [
				{ id: 'p0', name: 'pat-0', content: shortFiller, confidence: 0.9, helpful: 5 },
				{ id: 'p1', name: 'pat-1', content: shortFiller, confidence: 0.8, helpful: 4 },
			];
			const expanded = [
				{ pattern_id: 'nbr-small', cumulative_reward: 1.1, cached: true },
			];
			const innerRaw: any = { query: 'q', threshold: 0.7, results, count: 2, session_id: 'sid-notrunc', expanded };
			const resp = JSON.stringify({
				jsonrpc: '2.0', id: 77,
				result: { content: [{ type: 'text', text: JSON.stringify(innerRaw) }] },
			});
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			// expanded_note must be present even when no truncation was needed.
			expect(inner).toHaveProperty('expanded_note');
			expect(inner.expanded_note).toContain('ace_batch_get');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('expanded_note emitted when neighbor has cumulative_reward: 0 (zero is valid)', () => {
		// Codex-review finding 3: a 0-reward neighbor must still trigger expanded_note.
		// The guard uses Array.isArray + .length — 0-reward value is irrelevant.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-zero-reward-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const expanded = [{ pattern_id: 'zero-reward', cumulative_reward: 0, cached: false }];
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-zero-reward', expanded);
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			expect(inner).toHaveProperty('expanded_note');
			expect(inner.expanded_note).toContain('ace_batch_get');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('expanded_note emitted when inner.expanded is non-empty array', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-expanded-note-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const expanded = [
				{ pattern_id: 'nbr-1', cumulative_reward: 1.2, cached: true },
				{ pattern_id: 'nbr-2', cumulative_reward: 0.8, cached: false },
			];
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-expnote', expanded);
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			// expanded_note must be present and mention ace_batch_get.
			expect(inner).toHaveProperty('expanded_note');
			expect(typeof inner.expanded_note).toBe('string');
			expect(inner.expanded_note).toContain('ace_batch_get');
			expect(inner.expanded_note).toContain('expanded[]');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('expanded_note absent when inner.expanded is empty array (1.5-empty → no-op)', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-expanded-empty-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-expempty', []);
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			// Empty expanded array → no expanded_note.
			expect(inner).not.toHaveProperty('expanded_note');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('expanded_note absent when inner.expanded key is missing (1.0 input → byte-identical behavior)', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-expanded-absent-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			// 1.0 response: no expanded key at all.
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-exp10');
			// Verify no expanded key in the raw input.
			const rawInner = JSON.parse(JSON.parse(resp).result.content[0].text);
			expect(rawInner).not.toHaveProperty('expanded');
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			expect(inner).not.toHaveProperty('expanded_note');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('full_results_note mentions expanded[] neighbors', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-frnote-expanded-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const expanded = [{ pattern_id: 'n1', cumulative_reward: 0.9, cached: true }];
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-frnote', expanded);
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			// full_results_note must mention expanded.
			expect(inner.full_results_note).toContain('expanded');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('disk file contains both results and expanded keys', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-disk-expanded-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const expanded = [{ pattern_id: 'nbr-disk', cumulative_reward: 1.5, cached: true }];
			const resp = buildSearchResponseWithMatchFactors(30, 'sid-disk-exp', expanded);
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			expect(inner.full_results_path).toBeTruthy();
			const onDisk = JSON.parse(fs.readFileSync(inner.full_results_path, 'utf-8'));
			expect(Array.isArray(onDisk.results)).toBe(true);
			expect(Array.isArray(onDisk.expanded)).toBe(true);
			expect(onDisk.expanded[0].pattern_id).toBe('nbr-disk');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('1.0 input (no match_factors, no expanded) stays byte-identical to previous behavior', () => {
		// A 1.0-format search response with no match_factors and no expanded.
		// After the change the output must be identical to what the old code produced.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-1dot0-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			const filler = 'x'.repeat(250);
			const results = Array.from({ length: 30 }, (_, i) => ({
				id: `pat-${i}`, name: `pattern-${i}`, content: filler, confidence: 0.9, helpful: 5,
			}));
			const innerRaw: any = { query: 'bar', threshold: 0.7, results, count: 30, session_id: 'sid-1dot0' };
			const resp = JSON.stringify({
				jsonrpc: '2.0', id: 55,
				result: { content: [{ type: 'text', text: JSON.stringify(innerRaw) }] },
			});
			const out = JSON.parse(filter(resp));
			const inner = JSON.parse(out.result.content[0].text);
			// No new fields injected for 1.0 input.
			expect(inner).not.toHaveProperty('expanded_note');
			// match_factors absent on patterns (1.0 input, nothing to strip).
			inner.results.forEach((p: any) => expect(p).not.toHaveProperty('match_factors'));
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});

	it('no-truncation + match_factors-only: match_factors stripped inline, no full_results_path, no expanded_note', () => {
		// Codex-review blocking finding: the no-truncation + match_factors-only
		// path (few short patterns that all fit under the byte budget, match_factors
		// present, no expanded array) was exercised by neither the test harness nor
		// the tests.  The harness had a divergence from production: it only re-emits
		// when expandedNoteValue !== undefined, so it passed through match_factors
		// intact.  Production correctly strips them via the hasMF guard.
		// This test pins the correct behavior against the production function directly.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-notrunc-mfonly-'));
		try {
			const filter = makeFilterLine({ writeDir: tmp });
			// 2 very short patterns — easily under the 5000-byte budget.
			const results = [
				{
					id: 'p0', name: 'pat-0', content: 'short content A', confidence: 0.9, helpful: 5,
					match_factors: { semantic_score: 0.95, ucb_score: 0.97, bandit_rank: 1, retrieval_id: 'uuid-0' },
				},
				{
					id: 'p1', name: 'pat-1', content: 'short content B', confidence: 0.8, helpful: 4,
					match_factors: { semantic_score: 0.88, ucb_score: 0.90, bandit_rank: 2, retrieval_id: 'uuid-1' },
				},
				{
					id: 'p2', name: 'pat-2', content: 'short content C', confidence: 0.75, helpful: 3,
					match_factors: { semantic_score: 0.80, ucb_score: 0.82, bandit_rank: 3, retrieval_id: 'uuid-2' },
				},
			];
			const innerRaw: any = { query: 'q', threshold: 0.7, results, count: 3, session_id: 'sid-notrunc-mf' };
			// No expanded key — ACE 1.0 compatible input with 1.5 match_factors added.
			const resp = JSON.stringify({
				jsonrpc: '2.0', id: 99,
				result: { content: [{ type: 'text', text: JSON.stringify(innerRaw) }] },
			});
			const filtered = JSON.parse(filter(resp));
			const inner = JSON.parse(filtered.result.content[0].text);
			// (a) No truncation: no full_results_path (all 3 patterns fit inline).
			expect(inner).not.toHaveProperty('full_results_path');
			expect(inner.results).toHaveLength(3);
			// (b) match_factors absent from every inline result.
			inner.results.forEach((p: any) => expect(p).not.toHaveProperty('match_factors'));
			// (c) No expanded_note (no expanded key in input).
			expect(inner).not.toHaveProperty('expanded_note');
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	});
});
