/**
 * v0.5.0 TASK 1 — ACE MCP proxy.
 *
 * Caveman: AI no see tool, AI no call tool. Proxy wraps `npx @ace-sdk/mcp` and
 * intercepts the JSON-RPC stream. When the child emits a `tools/list` response,
 * we filter out the tools we don't want the AI to see (ace_get_playbook,
 * ace_learn). All other traffic (stdin → child, child stderr → process.stderr,
 * non tools/list responses) is passthrough.
 *
 * The script is written to <extensionPath>/scripts/ace_mcp_proxy.js and the MCP
 * server registration uses `node <baked-path>` instead of `npx @ace-sdk/mcp`.
 * The path is baked at extension activation time — workspace cannot influence.
 *
 * v0.5.0+ Cursor IDE bug workarounds (proxy-side):
 *  - Fix A: AI sometimes omits `agent_type` arg in ace_search calls. We
 *    intercept stdin line-by-line and inject `agent_type='cursor'` (or
 *    ACE_CLIENT_ID env var) when missing — preserves AI's value if set.
 *  - Fix B2: Cursor's stdio MCP transport hangs/returns empty when a single
 *    JSON-RPC response > ~8 KB on macOS (kernel pipe buffer exhaustion). We
 *    truncate `ace_search` responses to the top MAX_SEARCH_RESULTS patterns,
 *    preserving original count for AI awareness.
 */

/**
 * Tool names hidden from the AI's view. The proxy strips them from any
 * `tools/list` response coming from the child MCP server.
 *
 * - ace_get_playbook: returns ALL 700+ patterns, blows the AI's context.
 *
 * v0.5.0-dev.10+ HOTFIX (Bug B): ace_learn is NO LONGER hidden.
 * Rationale: extension's Stop hook is the primary path for server-side
 * learn, but it can fail silently (Bug A — Cursor's stripped PATH breaks
 * `command -v node`). When the Stop hook can't run the helper, the AI
 * has no fallback unless it can still see ace_learn in tools/list.
 * Keep ace_learn visible so the AI can call it as a manual fallback.
 */
export const HIDDEN_MCP_TOOLS = ['ace_get_playbook'] as const;

/**
 * Max number of patterns to leave in an `ace_search` response. Anything
 * above this gets truncated to stay under Cursor macOS 8 KB pipe limit.
 *
 * v0.5.0-dev.19 Task B/D: replaced fixed 5-pattern cap with a SIZE budget
 * (`MAX_INLINE_PATTERN_BYTES`). `MAX_SEARCH_RESULTS` is preserved as a hard
 * upper bound so a pathologically tiny pattern stream can't include more
 * than 50 inline patterns by accident.
 */
export const MAX_SEARCH_RESULTS = 50;

/**
 * v0.5.0-dev.19 Task D — smart packing budget.
 *
 * Cursor's macOS stdio pipe buffer breaks at ~8 KB. We aim for ~5 KB of
 * stringified inline patterns (the value passed to packPatternsUntilSize),
 * leaving room for the surrounding JSON-RPC envelope, full_results_note,
 * pretty-print indentation, and the inner.query/threshold/session_id keys.
 * Total wire payload stays comfortably under 8 KB.
 */
export const MAX_INLINE_PATTERN_BYTES = 5000;

/**
 * Pure helper — given a list of pattern objects, return a prefix that fits
 * under `maxChars` of stringified JSON. The size estimate uses
 * `JSON.stringify(packed)` after each insertion so commas, brackets, and
 * key overhead are all counted. Stable: tests rely on its determinism.
 */
export function packPatternsUntilSize<T>(patterns: T[], maxChars: number): T[] {
	if (!Array.isArray(patterns) || patterns.length === 0) return [];
	const packed: T[] = [];
	for (const p of patterns) {
		const trial = packed.concat([p]);
		const sz = JSON.stringify(trial).length;
		if (sz > maxChars) {
			// Caveman: first pattern alone is bigger than budget — keep it
			// anyway so we don't return zero patterns. AI still has signal.
			if (packed.length === 0) packed.push(p);
			break;
		}
		packed.push(p);
		if (packed.length >= MAX_SEARCH_RESULTS) break;
	}
	return packed;
}

/**
 * v0.5.0-dev.16 — Server-level MCP `instructions` injected into the proxy's
 * `initialize` response. The MCP spec allows servers to send a top-level
 * `instructions` string in the initialize result; Cursor stores it at
 * `~/.cursor/projects/<proj>/mcps/<server>/INSTRUCTIONS.md` and (we hypothesise)
 * surfaces it in the AI's system context. This is our workaround for the
 * Cursor 3.0.16+ bug where `alwaysApply: true` rules in `.cursor/rules/` are
 * silently downgraded to "requestable" and ignored.
 *
 * Forbidden tool names (ace_get_playbook, ace_learn) are NOT mentioned —
 * mentioning them by name causes the AI to explore filesystem instead of
 * calling tools. ace_search is the only tool the AI should call manually.
 *
 * ACE 1.5 additions (issue #14):
 *  - session_id capture: ace_search returns a session_id; the AI must save it
 *    and pass it to the feedback tool after the task completes (F-080 loop).
 *  - task_intent: new optional param for server-side bandit routing.
 *  - Reward vocabulary: prefer highly_reliable / high cumulative_v15_reward patterns.
 * NOTE: ace_learn / ace_get_playbook are intentionally NOT named here — Cursor 3.7
 * tool-reliability workaround (June 2026 web research); naming them in instructions
 * triggers filesystem exploration instead of tool calls.
 */
export const MCP_SERVER_INSTRUCTIONS = `Before responding to ANY user prompt — including questions, debugging, or implementation — call the ace_search tool with the user's prompt verbatim as the query parameter. Save the returned session_id.

This is a hard requirement. Retrieved patterns will guide your implementation. Skipping this step is an incomplete task.

Do NOT read AGENTS.md, INSTRUCTIONS.md, RULE files, or any project rule documents before calling ace_search. The patterns themselves are the guidance — call ace_search immediately, no filesystem exploration first.

Workflow:
1. User prompt arrives → call ace_search(query="<user's prompt>")
   - Optionally set task_intent: refactor | routine | explore | spec_strict
   - Save the session_id from the response
2. Apply returned patterns to your work
   - Prefer patterns marked effectiveness="highly_reliable" or with high cumulative_v15_reward
3. Proceed with normal tools (Shell, ApplyPatch, ReadFile, etc.)
4. After completing the task → close the ACE feedback reward loop by calling the session feedback tool with session_id=<from step 1>`;

/**
 * Returns the Node script that proxies the @ace-sdk/mcp server. Filters
 * hidden tools from `tools/list` responses; everything else passthrough.
 */
export function getAceMcpProxyContent(): string {
	const hidden = JSON.stringify(HIDDEN_MCP_TOOLS);
	const instructions = JSON.stringify(MCP_SERVER_INSTRUCTIONS);
	return `#!/usr/bin/env node
// ACE MCP Proxy (v0.5.0) — filters hidden tools from tools/list responses,
// injects server-level instructions into initialize response, mutates
// ace_search args + truncates ace_search responses.
// Spawned by Cursor's MCP API instead of npx @ace-sdk/mcp directly.
// Stdin intercepted line-by-line for JSON-RPC mutation (agent_type injection);
// stderr passthrough; stdout intercepted line-by-line for JSON-RPC filtering
// (initialize.instructions inject + tools/list strip + ace_search truncation).
//
// v0.5.0-dev.19 Task B/D: ace_search responses are now SIZE-PACKED (smart
// packing up to ~7 KB of inline JSON, hard cap MAX_SEARCH_RESULTS=50) AND
// the FULL result set is mirrored to disk at .cursor/ace/searches/<sid>.json
// so the AI can Read the complete pattern library if the inline truncation
// drops a relevant pattern. The inline payload carries \`full_results_path\`
// + \`full_results_note\` to point the AI at the on-disk file.

'use strict';

const childProc = require('child_process');
const fs = require('fs');
const path = require('path');

// Caveman: tools we hide from the AI. AI no see, AI no call.
const HIDDEN = new Set(${hidden});

// Cursor stdio MCP transport breaks at ~8 KB (macOS pipe buffer). We trim
// ace_search responses with smart packing (size budget) to stay under the limit.
const MAX_SEARCH_RESULTS = ${MAX_SEARCH_RESULTS};
const MAX_INLINE_PATTERN_BYTES = ${MAX_INLINE_PATTERN_BYTES};

// v0.5.0-dev.19 Task D — smart packing helper. Pure function so disk write
// failures don't corrupt the result. Mirrors the TS export of the same name.
function packPatternsUntilSize(patterns, maxChars) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const packed = [];
  for (const p of patterns) {
    const trial = packed.concat([p]);
    const sz = JSON.stringify(trial).length;
    if (sz > maxChars) {
      if (packed.length === 0) packed.push(p);
      break;
    }
    packed.push(p);
    if (packed.length >= MAX_SEARCH_RESULTS) break;
  }
  return packed;
}

// v0.5.0-dev.16 — server-level MCP instructions, injected into the
// initialize response. Workaround for Cursor 3.0.16+ alwaysApply rule bug.
const MCP_INSTRUCTIONS = ${instructions};

// Spawn the real MCP server. ACE_* env vars come from Cursor MCP registration.
const child = childProc.spawn('npx', ['-y', '@ace-sdk/mcp@^3.1.1'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

// Bail loud if child can't start.
child.on('error', (err) => {
  process.stderr.write('[ace-mcp-proxy] child spawn error: ' + (err && err.message || err) + '\\n');
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // Forward exit code so Cursor sees the same status as the unwrapped server.
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code == null ? 0 : code);
  }
});

// Stdin → child — line-buffered so we can mutate JSON-RPC requests
// (Fix A: inject agent_type into ace_search calls when AI omits it).
let stdinBuf = '';
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk.toString('utf8');
  let nl;
  while ((nl = stdinBuf.indexOf('\\n')) !== -1) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    child.stdin.write(mutateRequestLine(line) + '\\n');
  }
});
process.stdin.on('end', () => {
  if (stdinBuf.length > 0) {
    child.stdin.write(mutateRequestLine(stdinBuf));
    stdinBuf = '';
  }
  try { child.stdin.end(); } catch (_) { /* noop */ }
});

// Child stderr → process stderr (passthrough — server logs).
child.stderr.pipe(process.stderr);

// Child stdout → filtered → process stdout. JSON-RPC is line-delimited per the
// MCP stdio transport; we buffer until newline, parse, filter, re-emit.
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    process.stdout.write(filterLine(line) + '\\n');
  }
});
child.stdout.on('end', () => {
  // Flush any trailing partial line as-is.
  if (buf.length > 0) {
    process.stdout.write(filterLine(buf));
    buf = '';
  }
});

/**
 * Fix A: intercept stdin JSON-RPC requests. If it's a tools/call for
 * ace_search and agent_type is missing/empty, inject ACE_CLIENT_ID (or
 * 'cursor'). Any parse failure → passthrough. Never break the pipe.
 */
function mutateRequestLine(line) {
  if (!line || !line.trim()) return line;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return line; }
  if (!msg || typeof msg !== 'object') return line;
  if (msg.method !== 'tools/call') return line;
  if (!msg.params || typeof msg.params !== 'object') return line;
  if (msg.params.name !== 'ace_search') return line;

  const args = (msg.params.arguments && typeof msg.params.arguments === 'object')
    ? msg.params.arguments
    : {};
  if (!args.agent_type || typeof args.agent_type !== 'string' || args.agent_type.trim() === '') {
    args.agent_type = process.env.ACE_CLIENT_ID || 'cursor';
    msg.params.arguments = args;
    try { return JSON.stringify(msg); } catch (_) { return line; }
  }
  return line;
}

/**
 * Parse a single JSON-RPC line. If it's a tools/list response, strip hidden
 * tools. If it's an ace_search response, truncate results to top-N. Otherwise
 * return the line unchanged. Failure to parse → passthrough.
 */
function filterLine(line) {
  if (!line || !line.trim()) return line;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return line; }
  if (!msg || typeof msg !== 'object') return line;

  // v0.5.0-dev.16 — initialize response shape:
  //   { jsonrpc, id, result: { protocolVersion, serverInfo: {name,version}, ... } }
  // Inject server-level \`instructions\` field. Overwrites any existing one.
  if (msg.result
      && typeof msg.result.protocolVersion === 'string'
      && msg.result.serverInfo
      && typeof msg.result.serverInfo === 'object'
      && typeof msg.result.serverInfo.name === 'string') {
    msg.result.instructions = MCP_INSTRUCTIONS;
    try { return JSON.stringify(msg); } catch (_) { return line; }
  }

  // tools/list response shape: { jsonrpc, id, result: { tools: [...] } }
  // We don't see the request here (it's in stdin). Heuristic: any response
  // with result.tools array gets filtered. Belt + suspenders.
  if (msg.result && Array.isArray(msg.result.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => {
      return !(t && typeof t.name === 'string' && HIDDEN.has(t.name));
    });
    return JSON.stringify(msg);
  }

  // v0.5.0-dev.19 Task B/D: smart-packing + full-results-on-disk for
  // ace_search responses. Avoids Cursor's 8 KB stdio pipe limit while
  // preserving access to the entire pattern library on disk.
  // Shape: { jsonrpc, id, result: { content: [{type:'text', text: <inner JSON>}] } }
  // Inner JSON shape (ace_search): { query, threshold, results, count, session_id, ... }
  try {
    if (msg.result && Array.isArray(msg.result.content) && msg.result.content[0]
        && typeof msg.result.content[0].text === 'string') {
      const innerText = msg.result.content[0].text;
      let inner;
      try { inner = JSON.parse(innerText); } catch (_) { return line; }
      if (inner && typeof inner === 'object'
          && Array.isArray(inner.results)
          && typeof inner.query === 'string') {
        const originalResults = inner.results;
        const originalCount = (typeof inner.count === 'number') ? inner.count : originalResults.length;
        // Real constraint: the WHOLE JSON-RPC line (pretty-printed inner + envelope
        // + expanded[] + notes) must stay under Cursor's ~8 KB macOS pipe limit.
        // Budgeting only inner.results is insufficient (issue #13).
        const WIRE_LIMIT = 7500; // BYTES — Cursor's macOS pipe limit is ~8 KB on the wire.
        const byteLen = (s) => Buffer.byteLength(s, 'utf8');
        // Coarse first cut on the results array. Issue #13: match_factors are kept
        // inline, so the FULL patterns are counted here.
        const packed = packPatternsUntilSize(originalResults, MAX_INLINE_PATTERN_BYTES);
        // Feature-detect expanded[] neighbors: 1.0 (key absent) and 1.5-empty both
        // produce nothing.
        const expandedNote = (Array.isArray(inner.expanded) && inner.expanded.length > 0)
          ? inner.expanded.length + ' 2-hop neighbor pattern(s) from local graph cache are in expanded[].' +
            ' Cached stubs (cached:true) are already in ~/.ace-cache — call ace_batch_get([...pattern_ids]) to fetch their content.'
          : undefined;
        // Fast path: all results fit, no neighbors to annotate, and the incoming
        // line is already wire-safe → pass through untouched (1.0 / small responses
        // stay byte-identical).
        if (packed.length >= originalResults.length && expandedNote === undefined && byteLen(line) <= WIRE_LIMIT) {
          return line;
        }
        // Build the inline view and enforce the wire limit by trimming whole
        // patterns until the FULLY-annotated line fits.
        inner.results = originalResults.slice(0, packed.length);
        if (expandedNote !== undefined) inner.expanded_note = expandedNote;
        const sid = (typeof inner.session_id === 'string' && inner.session_id) ? inner.session_id : ('search-' + Date.now());
        const safeSid = String(sid).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
        const fullPath = path.join('.cursor', 'ace', 'searches', safeSid + '.json');
        let writtenPath = '';
        // Persist the COMPLETE record to disk once (idempotent) and point the inline
        // view at it. Called before ANY data is dropped (results, expanded, or query)
        // so nothing is ever lost.
        const persist = () => {
          if (!writtenPath) {
            try {
              fs.mkdirSync(path.dirname(fullPath), { recursive: true });
              fs.writeFileSync(fullPath, JSON.stringify(JSON.parse(innerText), null, 2));
              writtenPath = fullPath;
            } catch (writeErr) {
              process.stderr.write('[ace-mcp-proxy] full-results write failed: ' + (writeErr && writeErr.message || writeErr) + '\\n');
            }
          }
          if (writtenPath && inner.full_results_path === undefined) {
            inner.full_results_path = writtenPath;
            inner.full_results_note = 'FULL RESULTS: the complete record — full query, all ' + originalCount +
              ' results, and expanded[] neighbors — is at ' + writtenPath +
              '. The inline view is trimmed to fit Cursor\\'s ~8 KB wire limit; Read the file if the inline subset is insufficient.';
          }
        };
        const rebuild = () => {
          if (inner.results.length < originalResults.length) {
            persist();
            inner.original_count = originalCount;
            inner.truncated_to = inner.results.length;
          }
          msg.result.content[0].text = JSON.stringify(inner, null, 2);
          return JSON.stringify(msg);
        };
        let out = rebuild();
        // 1. If a large expanded[] inflates the line, persist and drop the raw
        //    stubs inline first — they're the least valuable inline (summary note +
        //    disk copy keep them reachable), so we shed them before real patterns.
        if (byteLen(out) > WIRE_LIMIT && inner.expanded !== undefined) {
          persist();
          delete inner.expanded;
          out = rebuild();
        }
        // 2. Drop whole patterns until the line fits — down to zero (all on disk).
        while (byteLen(out) > WIRE_LIMIT && inner.results.length > 0) {
          inner.results = originalResults.slice(0, inner.results.length - 1);
          out = rebuild();
        }
        // 3. Last resort → persist and truncate the echoed query inline (the full
        //    query is on disk) so the frame is always wire-safe.
        if (byteLen(out) > WIRE_LIMIT && typeof inner.query === 'string' && inner.query.length > 64) {
          persist();
          inner.query = inner.query.slice(0, 64) + '…';
          out = rebuild();
        }
        // 4. The only remaining unbounded value is a server-assigned session_id
        //    (normally a 36-char UUID). Persist + clamp it inline so the frame is
        //    provably bounded even for a pathologically long session_id.
        if (byteLen(out) > WIRE_LIMIT && typeof inner.session_id === 'string' && inner.session_id.length > 64) {
          persist();
          inner.session_id = inner.session_id.slice(0, 64) + '…';
          out = rebuild();
        }
        return out;
      }
    }
  } catch (_) { /* fall through to passthrough */ }

  return line;
}
`;
}
