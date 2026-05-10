/**
 * v0.5.0 helpers — Stop-hook ace_learn (TASK 1) + domain-shift inject (TASK 3).
 *
 * Kept in a separate file from hookScripts.ts to keep the SDK helper templates
 * focused on search-time injection. These templates are written to disk by
 * extension.ts at activation/initialization.
 */

// ===========================================================================
// TASK 1 — server-side ace_learn from Stop hook
// ===========================================================================

/**
 * Node helper that calls @ace-sdk/core storeExecutionTrace from the Stop hook.
 *
 * Invoked as: node ace_learn_helper.js <conv_id> <jsonl_path> [transcript_path]
 *
 *   conv_id          — Cursor conversation_id (used as session_id pin)
 *   jsonl_path       — path to .cursor/ace/mcp_trajectory.jsonl
 *   transcript_path  — optional Cursor transcript JSONL (for task + last reply)
 *
 * Stable exit codes:
 *   0  trace stored OK
 *   2  TokenExpiredError
 *   3  AceApiError 5xx
 *   4  network/timeout/other recoverable
 *   5  unknown
 *
 * Side effect: writes .cursor/ace/ace-review-result.json with
 *   { helpful_pct, time_saved_min, reason, timestamp }
 * so the next prompt's pre-tool-use hook can render <ace-roi/>.
 */
export function getLearnHelperContent(): string {
	return `#!/usr/bin/env node
// ACE learn helper (v0.5.0) — in-process @ace-sdk/core storeExecutionTrace.
// Spawned by Stop hook with: node helper.js <conv_id> <jsonl_path> [transcript]
// Writes ace-review-result.json with helpful_pct + time_saved_min for next-prompt ROI.
// Stable exit codes: 0 ok, 2 token-expired, 3 api-5xx, 4 network/other, 5 unknown.
//
// v0.5.0-dev.14 fixes — RICH trajectory data:
//   1. Pattern extraction reads result_json.content[0].text (MCP wrapper) and
//      pulls .results + .session_id from the inner JSON. Old code looked for
//      .similar_patterns at the wrong level → always 0 matches.
//   2. session_id is now the SERVER-assigned id from the last ace_search
//      response (not the Cursor conversation_id). Lets server link the learn
//      back to the correct trajectory in its ledger.
//   3. received_patterns: full pattern objects from the last ace_search are
//      attached so the server can compute "AI used pattern X" without a
//      second query. Each pattern's content is truncated to ~500 chars.
//   4. Diagnostic logging: every entry into the helper writes to
//      .cursor/ace/ace-stop-debug.log so silent rc=5 failures become visible.
//
// v0.5.0-dev.15 fix — RICH trajectory from Cursor transcript:
//   The Cursor transcript carries the full ORDERED tool_use sequence (Shell,
//   ApplyPatch, ReadFile, Glob, CallMcpTool…). mcp_trajectory.jsonl only has
//   MCP calls. We now:
//     a) Parse transcript line-by-line, walking entry.message.content[] for
//        every tool_use block — extracts {name, input} chronologically.
//     b) Build a fingerprint map (tool_name + canonical-args-hash) from
//        mcp_trajectory.jsonl and attach matching result to MCP-tool steps
//        in the transcript stream.
//     c) Non-MCP tools (Shell, ApplyPatch, ReadFile…) keep args from the
//        transcript with empty result — args + ordering alone are valuable.
//     d) ApplyPatch (and similarly large-arg) inputs truncated to 2000 chars.
//   Falls back to mcp_trajectory-only build when transcript missing/unreadable.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProc = require('child_process');

// HOME may be empty when Cursor strips the env. Fall back to os.homedir() so
// loadConfig() can find ~/.config/ace/config.json.
if (!process.env.HOME) {
  try { process.env.HOME = os.homedir(); } catch (_) {}
}

// Resolve debug log path early so we can log even before we know jsonlPath.
// v0.5.0-dev.19 Task A: when jsonlPath is a per-conv path
// (.cursor/ace/tasks/<conv>/mcp_trajectory.jsonl), keep the debug log
// at the top-level .cursor/ace/ace-stop-debug.log so it's visible regardless
// of which conv ran.
// v0.5.0-dev.24: folder renamed from sessions/ → tasks/. Accept both during
// migration window so debug logs still resolve correctly when an older script
// still writes the per-conv jsonl into the old location.
function debugLogPath(jsonlPath) {
  try {
    if (jsonlPath && fs.existsSync(path.dirname(jsonlPath))) {
      const dir = path.dirname(jsonlPath);
      // Walk up from tasks/<conv>/ (or legacy sessions/<conv>/) to .cursor/ace/.
      const baseName = path.basename(path.dirname(dir));
      if (baseName === 'tasks' || baseName === 'sessions') {
        const aceDir = path.dirname(path.dirname(dir));
        return path.join(aceDir, 'ace-stop-debug.log');
      }
      return path.join(dir, 'ace-stop-debug.log');
    }
  } catch (_) {}
  // Fallback: cwd-relative .cursor/ace.
  const cwdAce = path.join(process.cwd(), '.cursor', 'ace');
  try { fs.mkdirSync(cwdAce, { recursive: true }); } catch (_) {}
  return path.join(cwdAce, 'ace-stop-debug.log');
}

function debugLog(jsonlPath, msg) {
  try {
    const p = debugLogPath(jsonlPath);
    fs.appendFileSync(p, new Date().toISOString() + ' helper ' + msg + '\\n');
  } catch (_) {}
}

function gitInfo() {
  let hash = 'unknown', branch = 'unknown';
  try { hash = childProc.execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8', stdio: ['pipe','pipe','ignore'] }).trim(); } catch (_) {}
  try { branch = childProc.execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', stdio: ['pipe','pipe','ignore'] }).trim(); } catch (_) {}
  return { hash, branch };
}

// Caveman: parse the MCP-wrapped result_json. Returns { results, sessionId }.
// Two layers: result_json is { content: [{ type:'text', text:'<inner-json>' }], isError:false }
// and the inner JSON has the actual { results, session_id, query, ... }.
function unwrapAceSearchResultJson(rawResultJson) {
  try {
    const outer = typeof rawResultJson === 'string' ? JSON.parse(rawResultJson) : rawResultJson;
    if (!outer) return { results: [], sessionId: '' };
    // Legacy / direct shape — try .similar_patterns / .results at top level.
    if (Array.isArray(outer.results) || Array.isArray(outer.similar_patterns)) {
      return {
        results: outer.results || outer.similar_patterns || [],
        sessionId: String(outer.session_id || ''),
      };
    }
    // MCP wrapper shape.
    const content = outer.content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0];
      if (first && typeof first.text === 'string') {
        try {
          const inner = JSON.parse(first.text);
          return {
            results: Array.isArray(inner.results) ? inner.results : (inner.similar_patterns || []),
            sessionId: String(inner.session_id || ''),
          };
        } catch (_) { /* not JSON-in-text — fall through */ }
      }
    }
  } catch (_) {}
  return { results: [], sessionId: '' };
}

(async () => {
  const convId = String(process.argv[2] || '');
  const jsonlPath = String(process.argv[3] || '');
  const transcriptPath = String(process.argv[4] || '');

  // Always log invocation up front so we know if helper even started.
  debugLog(jsonlPath, 'invoked argv=' + JSON.stringify({
    conv: convId.slice(0, 8),
    jsonl: jsonlPath ? 'set' : 'unset',
    transcript: transcriptPath ? 'set' : 'unset',
    home: process.env.HOME ? 'set' : 'unset',
  }));

  try {
    if (!convId || !jsonlPath) { debugLog(jsonlPath, 'exit_0 reason=missing_args'); process.exit(0); }

    const sdk = require('@ace-sdk/core');
    const { loadConfig, AceClient, isTokenExpiredError, AceApiError } = sdk;

    const config = await loadConfig();
    if (!config) { debugLog(jsonlPath, 'exit_0 reason=no_config'); process.exit(0); }

    // v0.5.0-dev.18 — Workspace settings.json. Cursor doesn't pass workspace
    // ENV to hook subprocesses, so ACE_PROJECT_ID/ACE_ORG_ID env-var fallbacks
    // come up empty. .cursor/ace/settings.json sits next to mcp_trajectory.jsonl
    // (same dir) and carries the user's selected org/project as an "env" map.
    let workspaceEnv = {};
    try {
      // v0.5.0-dev.19 Task A: jsonlPath may now be the per-conv variant
      // (.cursor/ace/tasks/<conv>/mcp_trajectory.jsonl — was sessions/<conv>/
      // pre v0.5.0-dev.24). settings.json still lives at the top-level
      // .cursor/ace/. Walk up from tasks/ (or legacy sessions/) when needed.
      let aceDirForSettings = path.dirname(jsonlPath);
      const parentName = path.basename(path.dirname(aceDirForSettings));
      if (parentName === 'tasks' || parentName === 'sessions') {
        aceDirForSettings = path.dirname(path.dirname(aceDirForSettings));
      }
      const settingsPath = path.join(aceDirForSettings, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        workspaceEnv = (parsed && parsed.env) || {};
        debugLog(jsonlPath, 'settings_json_loaded path=' + settingsPath +
          ' projectId=' + (workspaceEnv.ACE_PROJECT_ID || 'NONE') +
          ' orgId=' + (workspaceEnv.ACE_ORG_ID || 'NONE'));
      } else {
        debugLog(jsonlPath, 'settings_json_missing path=' + settingsPath);
      }
    } catch (e) {
      debugLog(jsonlPath, 'settings_json_error: ' + (e && e.message || e));
    }

    // v0.5.0-dev.7: loadConfig returns default_org_id (snake_case) but
    // AceClient reads orgId (camelCase). Without normalize, server defaults
    // to user_id and returns 403 "not a member of organization".
    // v0.5.0-dev.18: workspace settings.json takes precedence over env-var
    // and default_* fallbacks (Cursor strips workspace env from hook subprocs).
    if (!config.orgId) {
      config.orgId = workspaceEnv.ACE_ORG_ID
                  || process.env.ACE_ORG_ID
                  || config.default_org_id
                  || config.defaultOrgId
                  || '';
    }
    // v0.5.0-dev.17 — Bug 1: same normalization for projectId. Without
    // X-ACE-Project header, multi-project tokens fail with HTTP 400
    // "Multiple projects found. Set X-ACE-Project header." Mirror the
    // orgId pattern: workspace settings.json, env, snake_case, camelCase.
    if (!config.projectId) {
      config.projectId = workspaceEnv.ACE_PROJECT_ID
                      || process.env.ACE_PROJECT_ID
                      || config.default_project_id
                      || config.defaultProjectId
                      || '';
    }

    debugLog(jsonlPath, 'config_resolved orgId=' + (config.orgId || 'NONE') +
      ' projectId=' + (config.projectId || 'NONE') +
      ' env_orgId=' + (process.env.ACE_ORG_ID || '') +
      ' env_projectId=' + (process.env.ACE_PROJECT_ID || ''));

    const client = new AceClient(config);

    // v0.5.0-dev.6: removed ensureValidToken (not on AceClient prototype).
    // storeExecutionTrace throws TokenExpiredError itself if needed.

    // ----- Read JSONL filtered by conversation_id -----
    // First pass: extract MCP results (ace_search patterns + session_id) AND
    // build a fingerprint→queue map for transcript-based merging.
    let task = '';
    let summary = '';
    let lastAssistant = '';
    const playbookUsed = new Set();
    let serverSessionId = '';
    let lastReceivedPatterns = [];

    // mcpByFingerprint: key = tool_name + '\\u0001' + canonical(args)
    //   → array of { result, raw } in insertion order. We POP from the front
    //   so multiple identical calls can each get their own result.
    const mcpByFingerprint = new Map();
    // Fallback map keyed by tool_name only (used when canonical args don't
    // match — e.g. transcript args got reformatted). Same pop-from-front rule.
    const mcpByTool = new Map();

    function canonicalArgs(obj) {
      try {
        if (obj === null || obj === undefined) return '';
        if (typeof obj !== 'object') return JSON.stringify(obj);
        // Sort keys at top level for stable fingerprint.
        const keys = Object.keys(obj).sort();
        const sorted = {};
        for (const k of keys) sorted[k] = obj[k];
        return JSON.stringify(sorted);
      } catch (_) { return ''; }
    }

    function pushMcpEntry(toolName, argsObj, resultStr) {
      const fp = String(toolName) + '\\u0001' + canonicalArgs(argsObj);
      if (!mcpByFingerprint.has(fp)) mcpByFingerprint.set(fp, []);
      mcpByFingerprint.get(fp).push({ result: resultStr });
      const tk = String(toolName);
      if (!mcpByTool.has(tk)) mcpByTool.set(tk, []);
      mcpByTool.get(tk).push({ result: resultStr });
    }

    if (fs.existsSync(jsonlPath)) {
      const raw = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = raw.split('\\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch (_) { continue; }
        if (!entry || entry.conversation_id !== convId) continue;

        if (entry.tool_name) {
          let argsObj = {};
          try { argsObj = typeof entry.tool_input === 'string' ? JSON.parse(entry.tool_input) : (entry.tool_input || {}); } catch (_) {}
          // Result: prefer result_json (MCP wrapper) for richer payload, else tool_output.
          let resultStr = '';
          if (entry.result_json) {
            resultStr = typeof entry.result_json === 'string' ? entry.result_json : JSON.stringify(entry.result_json);
          } else if (typeof entry.tool_output === 'string') {
            resultStr = entry.tool_output;
          }
          if (resultStr.length > 2000) resultStr = resultStr.slice(0, 2000) + '…';
          pushMcpEntry(entry.tool_name, argsObj, resultStr);
        }

        // Detect ace_search calls — extract returned pattern IDs + server
        // session_id from the (MCP-wrapped) result_json. Latest call wins.
        const tn = String(entry.tool_name || '');
        if (/ace_search/i.test(tn) && entry.result_json) {
          const { results, sessionId } = unwrapAceSearchResultJson(entry.result_json);
          if (Array.isArray(results) && results.length > 0) {
            for (const p of results) { if (p && p.id) playbookUsed.add(String(p.id)); }
            // Truncate content to keep payload reasonable.
            lastReceivedPatterns = results.map(p => {
              const out = Object.assign({}, p);
              if (typeof out.content === 'string' && out.content.length > 500) {
                out.content = out.content.slice(0, 500) + '…';
              }
              return out;
            });
          }
          if (sessionId) serverSessionId = sessionId;
        }
      }
    }

    // ----- Build trajectory from Cursor transcript (preferred) -----
    // The transcript carries the FULL ordered tool_use stream (Shell,
    // ApplyPatch, ReadFile, Glob, CallMcpTool, etc.). For each tool_use we
    // look up matching mcp_trajectory result by (tool_name, canonicalArgs).
    let trajectory = [];

    function popMcpResult(toolName, argsObj) {
      const fp = String(toolName) + '\\u0001' + canonicalArgs(argsObj);
      const arr = mcpByFingerprint.get(fp);
      if (arr && arr.length > 0) return arr.shift().result;
      // Fallback: same tool name, args may differ slightly between transcript
      // and mcp_trajectory (e.g. Cursor reformats nested objects). Take the
      // next un-matched call for that tool.
      const tk = String(toolName);
      const byTool = mcpByTool.get(tk);
      if (byTool && byTool.length > 0) return byTool.shift().result;
      return '';
    }

    function isMcpToolName(name) {
      // CallMcpTool wraps real MCP server calls; ace_* are direct MCP calls.
      const n = String(name || '');
      return /^(ace_|CallMcpTool$|mcp[_:])/i.test(n);
    }

    let transcriptParsed = false;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      try {
        const raw = fs.readFileSync(transcriptPath, 'utf-8');
        const lines = raw.split('\\n').filter(l => l.trim().length > 0);
        let firstUser = '';
        let stepNum = 0;
        const nowMs = Date.now();
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch (_) { continue; }
          const role = (entry && entry.role) || (entry && entry.message && entry.message.role) || '';
          const content = entry && entry.message && Array.isArray(entry.message.content)
            ? entry.message.content
            : (entry && Array.isArray(entry.content) ? entry.content : null);

          // Capture text for task/summary even when role/content nested.
          let textContent = '';
          if (Array.isArray(content)) {
            textContent = content
              .filter(c => c && c.type === 'text')
              .map(c => String(c.text || ''))
              .join(' ');
          } else if (entry && typeof entry.content === 'string') {
            textContent = entry.content;
          }
          if (role === 'user' && !firstUser) firstUser = textContent;
          if (role === 'assistant' && textContent) lastAssistant = textContent;

          // Walk every content block — multiple tool_use per message allowed.
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || block.type !== 'tool_use') continue;
              stepNum += 1;
              const tname = String(block.name || '').slice(0, 200);
              let argsObj = {};
              if (block.input !== undefined && block.input !== null) {
                argsObj = typeof block.input === 'object' ? block.input : { raw: String(block.input) };
              }
              // Truncate huge string values inside args (e.g. ApplyPatch input).
              const truncatedArgs = {};
              try {
                for (const k of Object.keys(argsObj)) {
                  const v = argsObj[k];
                  if (typeof v === 'string' && v.length > 2000) {
                    truncatedArgs[k] = v.slice(0, 2000) + '…';
                  } else {
                    truncatedArgs[k] = v;
                  }
                }
              } catch (_) {}
              const result = isMcpToolName(tname) ? popMcpResult(tname, argsObj) : '';
              trajectory.push({
                step: stepNum,
                action: tname,
                args: truncatedArgs,
                result: result || '',
                start_ms: nowMs,
                end_ms: nowMs,
              });
            }
          }
        }
        task = firstUser.slice(0, 1000);
        summary = lastAssistant.slice(-2000);
        transcriptParsed = stepNum > 0 || lines.length > 0;
      } catch (_) { /* best-effort — fall through to mcp-only build */ }
    }

    // Fallback: no transcript → reconstruct trajectory from mcp_trajectory.jsonl
    // (legacy behaviour). We re-walk jsonl since the fingerprint map doesn't
    // preserve original ordering across different tool names.
    if (trajectory.length === 0 && fs.existsSync(jsonlPath)) {
      const raw = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = raw.split('\\n').filter(l => l.trim().length > 0);
      let stepNum = 0;
      const nowMs = Date.now();
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch (_) { continue; }
        if (!entry || entry.conversation_id !== convId) continue;
        if (!entry.tool_name) continue;
        stepNum += 1;
        let argsObj = {};
        try { argsObj = typeof entry.tool_input === 'string' ? JSON.parse(entry.tool_input) : (entry.tool_input || {}); } catch (_) {}
        let resultStr = '';
        if (entry.result_json) {
          resultStr = typeof entry.result_json === 'string' ? entry.result_json : JSON.stringify(entry.result_json);
        } else if (typeof entry.tool_output === 'string') {
          resultStr = entry.tool_output;
        }
        if (resultStr.length > 2000) resultStr = resultStr.slice(0, 2000) + '…';
        trajectory.push({
          step: stepNum,
          action: String(entry.tool_name).slice(0, 200),
          args: argsObj,
          result: resultStr,
          start_ms: nowMs,
          end_ms: nowMs,
        });
      }
    }

    if (!task) task = 'cursor-task-' + convId.slice(0, 8);

    // ----- Git context (best-effort) -----
    const git = gitInfo();

    // ----- Build ExecutionTrace + send -----
    // session_id: prefer server-assigned (from ace_search response) so the
    // server can link this learn to its trajectory ledger. Fall back to
    // Cursor's conversation_id when no ace_search ran.
    const sessionId = serverSessionId || convId;

    const trace = {
      task,
      trajectory,
      result: { success: true, output: lastAssistant.slice(0, 4000), summary },
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      agent_type: 'cursor',
      agent_id: 'cursor-' + convId.slice(0, 8),
      playbook_used: Array.from(playbookUsed),
      // v0.5.0-dev.14: full pattern payload for server-side helpfulness scoring.
      received_patterns: lastReceivedPatterns,
      git: { branch: git.branch, commit_hash: git.hash, isRepo: git.hash !== 'unknown' },
    };

    debugLog(jsonlPath, 'trace_built session_id=' + sessionId.slice(0, 8) +
      ' patterns=' + lastReceivedPatterns.length +
      ' trajectory_steps=' + trajectory.length +
      ' playbook_used=' + playbookUsed.size);

    const learning = await client.storeExecutionTrace(trace);

    // ----- Write ace-review-result.json for next-prompt ROI inject -----
    let time_saved_min = 0;
    let helpful_pct = 0;
    let reason = '';

    // Look for TIME_SAVED in the output text we sent (AI's own self-report).
    const out = (trace.result && trace.result.output) || '';
    const m = String(out).match(/TIME_SAVED:\\s*(\\d+)\\s*m?\\s*\\|?\\s*(.{0,200})?/i);
    if (m) {
      time_saved_min = parseInt(m[1], 10) || 0;
      reason = String(m[2] || '').trim().slice(0, 200);
    }
    // Map minutes → helpful_pct buckets.
    if (time_saved_min >= 30) helpful_pct = 80;
    else if (time_saved_min >= 15) helpful_pct = 60;
    else if (time_saved_min >= 5) helpful_pct = 30;
    else if (time_saved_min > 0) helpful_pct = 15;

    // Server learning_statistics override if provided.
    if (learning && learning.learning_statistics) {
      const stats = learning.learning_statistics;
      if (typeof stats.helpful_pct === 'number') helpful_pct = stats.helpful_pct;
    }

    // v0.5.0-dev.19 Task A: walk up from tasks/<conv>/ (or legacy sessions/
    // <conv>/) if needed so the ROI marker lives at the top-level
    // .cursor/ace/ (next prompt's pre-tool hook reads it from there).
    // v0.5.0-dev.24: folder renamed sessions/ → tasks/.
    let aceDir = path.dirname(jsonlPath);
    const aceParent = path.basename(path.dirname(aceDir));
    if (aceParent === 'tasks' || aceParent === 'sessions') {
      aceDir = path.dirname(path.dirname(aceDir));
    }
    const reviewPath = path.join(aceDir, 'ace-review-result.json');
    const review = {
      helpful_pct,
      time_saved_min,
      reason,
      timestamp: new Date().toISOString(),
    };
    try { fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2), 'utf-8'); } catch (_) {}

    debugLog(jsonlPath, 'exit_0 stored=' + !!(learning && learning.stored) + ' time_saved=' + time_saved_min);

    process.stdout.write(JSON.stringify({ stored: !!(learning && learning.stored), time_saved_min, helpful_pct }));
    process.exit(0);
  } catch (err) {
    // Bug 3 fix — log raw error BEFORE classification so future rc=5 failures
    // show up in ace-stop-debug.log with their actual message + stack.
    const errMsg = String((err && err.message) || err);
    const errStack = String((err && err.stack) || '').split('\\n').slice(0, 3).join(' | ');
    debugLog(jsonlPath, 'caught name=' + ((err && err.name) || 'Error') +
      ' msg=' + errMsg.slice(0, 300) + ' stack=' + errStack.slice(0, 500));
    try {
      const sdk = require('@ace-sdk/core');
      if (sdk.isTokenExpiredError && sdk.isTokenExpiredError(err)) { debugLog(jsonlPath, 'exit_2 token_expired'); process.exit(2); }
      if (err instanceof sdk.AceApiError) {
        const status = err.status || 0;
        if (status >= 500) { debugLog(jsonlPath, 'exit_3 api_5xx status=' + status); process.exit(3); }
        debugLog(jsonlPath, 'exit_4 api_4xx status=' + status); process.exit(4);
      }
    } catch (_) {}
    const name = (err && err.name) || '';
    if (/TokenExpired/i.test(name)) { debugLog(jsonlPath, 'exit_2 token_expired_byname'); process.exit(2); }
    // v0.5.0-dev.17 — Bug 2: SDK throws plain Error with stringified
    // "Server error (NNN): {detail...}" for HTTP errors. Detect 5xx vs
    // 4xx by status digit BEFORE the name-fallback so HTTP 400 doesn't
    // get misclassified as rc=5.
    if (/Server error \\(5\\d\\d\\)/.test(errMsg)) { debugLog(jsonlPath, 'exit_3 api_5xx_bymsg'); process.exit(3); }
    if (/Server error \\(\\d{3}\\)/.test(errMsg)) { debugLog(jsonlPath, 'exit_4 api_4xx_bymsg'); process.exit(4); }
    // Bug 2 cont. — name-fallback: previously exited 3 (5xx) for ANY
    // AceApiError name match, including 400s. That's wrong without status
    // info. Default to 4 (recoverable 4xx) — the instanceof check above
    // already handles the case where status is known.
    if (/AceApiError/i.test(name)) { debugLog(jsonlPath, 'exit_4 api_byname'); process.exit(4); }
    if (/Network|Timeout|ECONN|ETIMEDOUT/i.test(errMsg)) { debugLog(jsonlPath, 'exit_4 network'); process.exit(4); }
    debugLog(jsonlPath, 'exit_5 unclassified');
    process.exit(5);
  }
})();
`;
}

/**
 * v0.5.0 TASK 1 — Stop hook (bash) that delegates ace_learn to a node helper.
 *
 * @param helperPath  Optional absolute path to ace_learn_helper.js. When set,
 *                    the path is baked into the script (TRUSTED location). When
 *                    omitted, the script falls back to <workspace>/.cursor/scripts.
 */
export function getStopHookScriptContent(helperPath?: string): string {
	const baked = helperPath
		? helperPath.replace(/"/g, '\\"')
		: '.cursor/scripts/ace_learn_helper.js';
	return `#!/bin/bash
# ACE Stop Hook (v0.5.0-dev.10+) — delegate ace_learn to node helper.
# Replaces v0.4.x stop hook that nudged AI to call ace_learn manually.
# Helper writes ace-review-result.json with time_saved_min for next-prompt ROI.
#
# v0.5.0-dev.10+ HOTFIX (Bugs A + C):
#  - Cursor invokes hooks with a stripped PATH (often /usr/bin:/bin only),
#    so bare \`command -v node\` misses Homebrew/nvm installs. We now extend
#    PATH to include the common node install dirs BEFORE any node lookup.
#  - Every gate exit writes a labelled breadcrumb to ace-stop-debug.log so
#    silent failures become diagnosable. Helper stderr is captured to the
#    same log instead of being swallowed by /dev/null.

# Caveman: HELPER baked at write time from extensionContext.extensionPath.
HELPER="${baked}"

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
debug_log="$ace_dir/ace-stop-debug.log"

# Bug A fix — extend PATH with common node install dirs BEFORE any node probe.
# Cursor often hands hooks PATH=/usr/bin:/bin. Homebrew, /usr/local, and nvm
# installs aren't on that minimal PATH, so node disappears. Prepend the usual
# suspects so \`command -v node\` and \`node\` calls succeed.
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$HOME/.nvm/current/bin:$HOME/.nvm/versions/node/current/bin:$HOME/.local/bin:$HOME/bin:$PATH"

# v0.5.0-dev.10: extract status/conv_id/loop_count BEFORE any gate so we can
# write a breadcrumb proving the hook fired regardless of which gate exits.
if command -v jq >/dev/null 2>&1; then
  status=$(echo "$input" | jq -r '.status // empty')
  loop_count=$(echo "$input" | jq -r '.loop_count // 0')
  transcript=$(echo "$input" | jq -r '.transcript_path // empty')
  conv_id=$(echo "$input" | jq -r '.conversation_id // empty')
else
  status=$(echo "$input" | grep -oE '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//')
  loop_count=$(echo "$input" | grep -oE '"loop_count"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -oE '[0-9]+$' || echo "0")
  transcript=$(echo "$input" | grep -oE '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//')
  conv_id=$(echo "$input" | grep -oE '"conversation_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"$//')
fi

# Unconditional breadcrumb — proves the hook fired and shows what Cursor sent us.
printf '%s STOP_FIRED status=%s conv=%s loop=%s\\n' "$(date -Iseconds)" "$status" "$conv_id" "$loop_count" >> "$debug_log" 2>/dev/null

# Bug C fix — every gate exit now writes a LABELLED reason to debug_log
# instead of silently \`exit 0\`. Easier to diagnose what's blocking learn.
log_skip() {
  printf '%s STOP_SKIP reason=%s status=%s conv=%s loop=%s\\n' "$(date -Iseconds)" "$1" "$status" "$conv_id" "$loop_count" >> "$debug_log" 2>/dev/null
}

# Only fire on completed top-of-stack stops
if [ "$status" != "completed" ]; then log_skip status_not_completed; echo '{}'; exit 0; fi
if [ "$loop_count" != "0" ] && [ -n "$loop_count" ]; then log_skip loop_count_nonzero; echo '{}'; exit 0; fi
if [ -z "$conv_id" ]; then log_skip no_conv_id; echo '{}'; exit 0; fi

# Skip if no real work — count ANY trajectory activity for THIS conversation.
# v0.5.0-dev.5: also count mcp_trajectory + shell_trajectory because AI may
# write files via MCP tools (filesystem/serena) which don't fire afterFileEdit.
# v0.5.0-dev.19 Task A: also count per-conversation trajectory file lines (no
# grep filter needed — per-conv file by definition only holds this conv's data).
work_count=0
per_conv_dir="$ace_dir/tasks/$conv_id"
if [ -f "$per_conv_dir/mcp_trajectory.jsonl" ]; then
  pn=$(wc -l < "$per_conv_dir/mcp_trajectory.jsonl" 2>/dev/null | tr -cd '0-9')
  [ -z "$pn" ] && pn=0
  work_count=$((work_count + pn))
fi
for traj in edit_trajectory.jsonl mcp_trajectory.jsonl shell_trajectory.jsonl; do
  if [ -f "$ace_dir/$traj" ]; then
    # grep -c always prints a number; exit 1 means 0 matches, NOT error.
    # Do NOT add: || echo 0 — it concatenates with grep's own "0" output.
    n=$(grep -c "\\"conversation_id\\":\\"$conv_id\\"" "$ace_dir/$traj" 2>/dev/null)
    [ -z "$n" ] && n=0
    n=$(echo "$n" | head -1 | tr -cd '0-9')
    [ -z "$n" ] && n=0
    work_count=$((work_count + n))
  fi
done
if [ "$work_count" -lt 1 ]; then log_skip no_work_count_zero; echo '{}'; exit 0; fi

if [ ! -f "$HELPER" ]; then
  printf '%s STOP_SKIP reason=helper_missing path=%s\\n' "$(date -Iseconds)" "$HELPER" >> "$debug_log" 2>/dev/null
  echo '{}'; exit 0
fi

# Bug A fix — explicit node binary resolver. PATH extension above usually
# does the trick, but on truly minimal environments we still probe known
# candidate paths so we can log a clear node_missing diagnostic if all
# candidates fail.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for candidate in \\
    "/opt/homebrew/bin/node" \\
    "/usr/local/bin/node" \\
    "/opt/local/bin/node" \\
    "$HOME/.nvm/current/bin/node" \\
    "$HOME/.nvm/versions/node/current/bin/node" \\
    "$HOME/.local/bin/node" \\
    "$HOME/bin/node"; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  printf '%s STOP_SKIP reason=node_missing path=%s\\n' "$(date -Iseconds)" "$PATH" >> "$debug_log" 2>/dev/null
  echo '{}'; exit 0
fi

# v0.5.0-dev.19 Task A — prefer per-conv trajectory if it exists, else fall
# back to legacy top-level path. Per-conv path keeps cross-tab data isolated.
# v0.5.0-dev.24 — folder renamed sessions/ → tasks/.
per_conv_jsonl="$ace_dir/tasks/$conv_id/mcp_trajectory.jsonl"
if [ -f "$per_conv_jsonl" ]; then
  jsonl="$per_conv_jsonl"
else
  jsonl="$ace_dir/mcp_trajectory.jsonl"
fi

printf '%s helper_start node=%s helper=%s jsonl=%s\\n' "$(date -Iseconds)" "$NODE_BIN" "$HELPER" "$jsonl" >> "$debug_log" 2>/dev/null

# Run helper (synchronous, 30s budget — server side may stream a learning
# response). Bug C fix: capture helper stderr to debug log instead of
# silencing with >/dev/null 2>&1. stdout still piped to /dev/null since the
# helper writes ace-review-result.json on its own.
if command -v gtimeout >/dev/null 2>&1; then
  gtimeout 30 "$NODE_BIN" "$HELPER" "$conv_id" "$jsonl" "$transcript" >/dev/null 2>>"$debug_log"
  rc=$?
elif command -v timeout >/dev/null 2>&1; then
  timeout 30 "$NODE_BIN" "$HELPER" "$conv_id" "$jsonl" "$transcript" >/dev/null 2>>"$debug_log"
  rc=$?
else
  perl -e 'alarm 30; exec @ARGV' -- "$NODE_BIN" "$HELPER" "$conv_id" "$jsonl" "$transcript" >/dev/null 2>>"$debug_log"
  rc=$?
fi

printf '%s helper_done rc=%s\\n' "$(date -Iseconds)" "$rc" >> "$debug_log" 2>/dev/null

echo '{}'
`;
}

// ===========================================================================
// TASK 3 — domain-shift inject on Read
// ===========================================================================

/**
 * Heuristic: derive an ACE domain name from a file path.
 * Mirrors Claude Code's ace_posttooluse_domain_inject.sh inferDomain logic.
 */
export function inferDomain(filePath: string): string {
	const lc = String(filePath || '').toLowerCase();

	// Caveman: order matters — most specific first.
	if (
		lc.includes('docker') ||
		/(^|\/)dockerfile(\.|$)/.test(lc) ||
		lc.includes('.github/workflows') ||
		lc.endsWith('.yml') ||
		lc.endsWith('.yaml')
	) {
		return 'devops-infrastructure';
	}
	if (
		/\.test\./.test(lc) ||
		/\.spec\./.test(lc) ||
		/(^|\/)__tests__(\/|$)/.test(lc) ||
		/(^|\/)tests?(\/|$)/.test(lc)
	) {
		return 'testing-strategies';
	}
	if (lc.includes('/migrations/') || lc.endsWith('.sql')) {
		return 'database-migrations';
	}
	if (lc.includes('/components/') || lc.endsWith('.tsx') || lc.endsWith('.jsx')) {
		return 'react-components';
	}
	if (
		/(^|\/)auth(\/|$)/.test(lc) ||
		/(^|\/)(login|session|jwt|oauth)/.test(lc)
	) {
		return 'auth-development';
	}
	if (
		/(^|\/)api(\/|$)/.test(lc) ||
		/(^|\/)routes?(\/|$)/.test(lc) ||
		/(^|\/)(controller|endpoint|handler)s?(\/|$)/.test(lc)
	) {
		return 'api-development';
	}

	const parts = lc.split('/').filter(Boolean);
	if (parts.length >= 2) return parts[0];
	return 'general';
}

/**
 * v0.5.0 TASK 3 — Domain-shift inject hook (bash).
 *
 * Fires on afterFileEdit / postToolUse for Read|Edit. When the AI Reads/Edits
 * a file in a different domain than the last cached one, fetch fresh patterns
 * and inject as <ace-patterns-domain-shift domain="...">{JSON}</ace-patterns-domain-shift>
 * via additional_context.
 */
export function getDomainShiftScriptContent(searchHelperPath?: string): string {
	const baked = searchHelperPath
		? searchHelperPath.replace(/"/g, '\\"')
		: '.cursor/scripts/ace_search_helper.js';
	return `#!/bin/bash
# ACE Domain-Shift Inject Hook (v0.5.0-dev.10+) — fires on Read/Edit.
# Detects domain mismatch vs last_domain marker and injects fresh patterns
# wrapped as <ace-patterns-domain-shift domain="..."> ... </ace-patterns-domain-shift>.
#
# v0.5.0-dev.10+ HOTFIX (Bug A clone): Cursor strips PATH on hook invocation,
# so bare \`command -v node\` misses Homebrew/nvm. Extend PATH up front so
# both jq and node lookups succeed even on minimal Cursor PATH.

# Caveman: search helper baked at write time from extensionContext.extensionPath.
HELPER="${baked}"

# Bug A fix — extend PATH before any binary lookup.
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$HOME/.nvm/current/bin:$HOME/.nvm/versions/node/current/bin:$HOME/.local/bin:$HOME/bin:$PATH"

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

if ! command -v jq >/dev/null 2>&1; then echo '{}'; exit 0; fi

tool_name=$(echo "$input" | jq -r '.tool_name // ""')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .file_path // ""')
conv_id=$(echo "$input" | jq -r '.conversation_id // ""')
gen_id=$(echo "$input" | jq -r '.generation_id // ""')

# Only fire on Read/Edit-style tools (not on bash, mcp, etc.)
case "$tool_name" in
  Read|Edit|Write|MultiEdit|edit|read|write) ;;
  *) echo '{}'; exit 0;;
esac

[ -z "$file_path" ] && echo '{}' && exit 0
[ -z "$conv_id" ] || [ -z "$gen_id" ] && echo '{}' && exit 0

# Privacy gate (same as pre-tool-use): only inject when opt-in true.
opt_in=0
settings_file="$ace_dir/runtime-settings.json"
if [ -f "$settings_file" ]; then
  raw=$(jq -r '.shareRawPromptsForRetrievalAnalysis // false' "$settings_file" 2>/dev/null || echo "false")
  if [ "$raw" = "true" ]; then opt_in=1; fi
fi
[ "$opt_in" = "0" ] && echo '{}' && exit 0

# Caveman: derive domain from file path.
# Quick heuristic mirroring inferDomain() — keep in sync with TS.
lc=$(echo "$file_path" | tr '[:upper:]' '[:lower:]')
domain=""
case "$lc" in
  *docker*|*.yml|*.yaml|*.github/workflows*) domain="devops-infrastructure" ;;
  *.test.*|*.spec.*|*__tests__*|*/tests/*|*/test/*) domain="testing-strategies" ;;
  */migrations/*|*.sql) domain="database-migrations" ;;
  */components/*|*.tsx|*.jsx) domain="react-components" ;;
  */auth/*|*login*|*session*|*jwt*|*oauth*) domain="auth-development" ;;
  */api/*|*/routes/*|*/route/*|*/controllers/*|*/handlers/*|*/endpoints/*) domain="api-development" ;;
  *)
    domain=$(echo "$file_path" | cut -d/ -f1)
    [ -z "$domain" ] && domain="general"
    ;;
esac

# Track last-domain per conv/gen.
# v0.5.0-dev.24 — folder renamed sessions/ → tasks/.
session_dir="$ace_dir/tasks/$conv_id"
mkdir -p "$session_dir"
last_domain_file="$session_dir/$gen_id.last-domain"
last_domain=""
[ -f "$last_domain_file" ] && last_domain=$(cat "$last_domain_file" 2>/dev/null)

# Same domain → no shift, no injection.
if [ "$domain" = "$last_domain" ]; then
  echo '{}'; exit 0
fi

# Update last-domain marker BEFORE network call (single inject per domain change).
echo "$domain" > "$last_domain_file"

# Helper exists?
[ ! -f "$HELPER" ] && echo '{}' && exit 0

# Bug A fix — explicit node binary resolver (PATH already extended above).
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for candidate in \\
    "/opt/homebrew/bin/node" \\
    "/usr/local/bin/node" \\
    "/opt/local/bin/node" \\
    "$HOME/.nvm/current/bin/node" \\
    "$HOME/.nvm/versions/node/current/bin/node" \\
    "$HOME/.local/bin/node" \\
    "$HOME/bin/node"; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
[ -z "$NODE_BIN" ] && echo '{}' && exit 0

# Build a query from filename + domain hint.
basename=$(basename "$file_path" 2>/dev/null | sed 's/\\.[^.]*$//')
query="$domain $basename"

# Fetch patterns (8s timeout).
patterns=""
if command -v gtimeout >/dev/null 2>&1; then
  patterns=$(gtimeout 8 "$NODE_BIN" "$HELPER" "$query" 2>/dev/null)
elif command -v timeout >/dev/null 2>&1; then
  patterns=$(timeout 8 "$NODE_BIN" "$HELPER" "$query" 2>/dev/null)
else
  patterns=$(perl -e 'alarm 8; exec @ARGV' -- "$NODE_BIN" "$HELPER" "$query" 2>/dev/null)
fi

[ -z "$patterns" ] || [ "$patterns" = "{}" ] && echo '{}' && exit 0

# Sanity: require at least 1 pattern.
n=$(echo "$patterns" | jq -r '(.similar_patterns // []) | length' 2>/dev/null || echo "0")
[ "$n" = "0" ] && echo '{}' && exit 0

# Wrap as <ace-patterns-domain-shift domain="..."> ... </ace-patterns-domain-shift>.
wrapped=$(printf '<ace-patterns-domain-shift domain="%s">%s</ace-patterns-domain-shift>' "$domain" "$patterns")
ctx_json=$(printf '%s' "$wrapped" | jq -Rs .)

cat <<EOF
{"additional_context":$ctx_json}
EOF
`;
}
