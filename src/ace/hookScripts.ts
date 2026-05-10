/**
 * Pure-function getters for ACE rule file content.
 * Extracted from extension.ts to make rule content unit-testable
 * without fs/vscode mocking. Used by createCursorRules in extension.ts.
 */

// v0.5.0 — re-export new helpers (TASK 1 + TASK 3) from v05Helpers.
export {
	getLearnHelperContent,
	getStopHookScriptContent,
	getDomainShiftScriptContent,
	inferDomain,
} from './v05Helpers';

// Cursor rule injection: .mdc with `globs: ["**\/*"]` is one of three
// orthogonal paths we use:
//   1. .mdc rule (this file)
//   2. AGENTS.md at workspace root (written by createAgentsMdIfMissing)
//   3. MCP server `instructions` field (proxy injects in initialize response)
// Rules with .md extension are @-mention-only per Cursor docs — must be .mdc.
export function getAcePatternsRuleContent(): string {
	// v0.5.0-dev.19 Task F: replace \`alwaysApply: true\` with \`globs: ["**/*"]\`.
	// Cursor 3.0.16+ silently downgrades alwaysApply rules
	// (forum.cursor.com/t/158551), but glob-based rules are unaffected.
	return `---
description: ACE Pattern Learning - call ace_search first with the user's task as query
globs: ["**/*"]
---

# ACE Pattern Search

For every user prompt, the FIRST tool call MUST be \`ace_search(query="<user's task>")\`.

Use the user's prompt directly as the query. Do NOT explore the filesystem first. Once results return, apply the patterns to your work.
`;
}

/**
 * v0.5.0-dev.19 Task G — Workspace-root AGENTS.md content.
 *
 * Cursor's AGENTS.md is auto-loaded per Cursor docs ("nested AGENTS.md
 * support") and is NOT affected by the alwaysApply rule bug. The extension
 * writes this file at activation time IF AND ONLY IF it does not already
 * exist (never overwrites a user-customized AGENTS.md).
 *
 * Body kept minimal so the AI sees the directive without filler. Mentions
 * ace_search at most twice — once in the workflow paragraph and once in
 * the full-results path note.
 */
export function getAgentsMdContent(): string {
	return `# Agent Instructions

## ACE Pattern Workflow

For every user prompt, your FIRST action MUST be calling the \`ace_search\` MCP tool with the user's prompt verbatim as the \`query\` parameter.

After ace_search returns, review the patterns it provides and apply them to your implementation. The full result set may be available at \`.cursor/ace/searches/<session_id>.json\` — read that file if the inline patterns don't fully address the task.

Do NOT explore filesystem files (mcps/.../tools/*.json) before calling ace_search. The MCP tool list is sufficient.
`;
}

export function getDomainSearchRuleContent(): string {
	return `---
description: Domain-aware ACE pattern search — discover actual server domain names before filtering ace_search results
alwaysApply: false
---

# Domain-Aware Pattern Search

## CRITICAL: Discover Domains First

**NEVER guess domain names** like "auth", "api", "test".
Server domains are SEMANTIC like "typescript-development-practices".

### Step 1: Call ace_list_domains

**BEFORE using domain filtering**, discover available domains:

\`\`\`
ace_list_domains()
→ Returns: {
    "domains": [
      { "name": "mcp-cli-testing-and-api-resilience", "count": 34 },
      { "name": "typescript-development-practices", "count": 27 },
      { "name": "cli-and-package-version-diagnostics", "count": 23 }
    ],
    "total_domains": 17,
    "total_patterns": 206
  }
\`\`\`

### Step 2: Match Domain to Task

Read domain names semantically to find the best match:

| Task Context | Look for domains containing |
|--------------|----------------------------|
| TypeScript code | "typescript", "development", "practices" |
| Testing work | "testing", "test", "resilience" |
| CLI/API work | "cli", "api", "config" |
| Debugging | "diagnostics", "troubleshooting" |

### Step 3: Use Actual Domain Names

\`\`\`
# CORRECT - use exact domain name from ace_list_domains
ace_search(query="testing patterns", allowed_domains=["mcp-cli-testing-and-api-resilience"])

# WRONG - hardcoded domain that doesn't exist on server
ace_search(query="testing patterns", allowed_domains=["test"])
\`\`\`

## Workflow

1. \`ace_list_domains()\` - See what domains exist
2. Pick relevant domain(s) based on task context
3. \`ace_search(query="<your query>", allowed_domains=["picked-domain"])\`

## Why This Matters

Using non-existent domains returns 0 results. Always verify domain names exist first.
`;
}

export function getMcpTrackScriptContent(): string {
	return `#!/bin/bash
# ACE MCP Tracking Hook - Captures tool executions for AI-Trail
# Also detects ace_learn calls and extracts task helpfulness (TIME_SAVED)
# Input: tool_name, tool_input, result_json, duration
# Requires: jq (checked at extension activation)

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

# v0.5.0-dev.19 Task A — per-conversation trajectory rotation. The legacy
# top-level mcp_trajectory.jsonl grew unbounded across all chat tabs in a
# Cursor session. Writes now go to .cursor/ace/tasks/<conv_id>/
# mcp_trajectory.jsonl when conv_id is present, else fall back to the
# top-level path (older Cursor versions / malformed input).
# v0.5.0-dev.24 — folder renamed sessions/ → tasks/ (one conv_id = one task).
conv_id_for_traj=""
if command -v jq >/dev/null 2>&1; then
  conv_id_for_traj=$(echo "$input" | jq -r '.conversation_id // .conv_id // ""' 2>/dev/null || echo "")
fi
if [ -n "$conv_id_for_traj" ] && [ "$conv_id_for_traj" != "null" ]; then
  per_conv_dir="$ace_dir/tasks/$conv_id_for_traj"
  mkdir -p "$per_conv_dir"
  echo "$input" >> "$per_conv_dir/mcp_trajectory.jsonl"
else
  echo "$input" >> "$ace_dir/mcp_trajectory.jsonl"
fi

# Bail if jq is not available
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

# Detect ace_learn call — extract helpfulness from tool_input.output
tool_name=$(echo "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")

# Per-prompt ace_search gate: when ace_search completes, write a flag
# file so the preToolUse gate unblocks subsequent tool calls within the
# same generation_id. afterMCPExecution delivers bare tool_name (no
# "MCP:" prefix), so compare against "ace_search" directly.
if [ "$tool_name" = "ace_search" ]; then
  conv_id=$(echo "$input" | jq -r '.conversation_id // "unknown"')
  gen_id=$(echo "$input" | jq -r '.generation_id // "unknown"')
  # v0.5.0-dev.24 — folder renamed sessions/ → tasks/.
  flag_dir="$ace_dir/tasks/$conv_id"
  mkdir -p "$flag_dir"
  touch "$flag_dir/$gen_id.search-done"
fi

# Cursor known bug 150043: agent sometimes calls MCP tools without arguments.
# Detect empty/no-args ace_search and ace_learn for observability.
if [ "$tool_name" = "ace_search" ] || [ "$tool_name" = "ace_learn" ]; then
  tool_input_str=$(echo "$input" | jq -r '.tool_input // ""')
  is_empty=0
  if [ -z "$tool_input_str" ] || [ "$tool_input_str" = "{}" ] || [ "$tool_input_str" = "null" ]; then
    is_empty=1
  else
    # Check object with all empty/null values: jq returns true if every value is null or empty string
    all_empty=$(echo "$tool_input_str" | jq -r 'try (if type == "object" then ([.[] | (. == null or . == "")] | all) else false end) catch false' 2>/dev/null || echo "false")
    if [ "$all_empty" = "true" ]; then is_empty=1; fi
  fi
  if [ "$is_empty" = "1" ]; then
    echo "{\\"event\\": \\"schema_violation_detected\\", \\"tool\\": \\"$tool_name\\", \\"reason\\": \\"empty_arguments_likely_cursor_callmcptool_bug_150043\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/ace-relevance.jsonl"
  fi
fi

if echo "$tool_name" | grep -qi "ace_learn"; then
  # tool_input is a JSON string — parse it to get the output field
  tool_input_raw=$(echo "$input" | jq -r '.tool_input // ""' 2>/dev/null || echo "")
  # tool_input may be a string or object; try parsing as JSON
  output_field=$(echo "$tool_input_raw" | jq -r '.output // ""' 2>/dev/null || echo "")
  if [ -z "$output_field" ]; then
    # Fallback: tool_input might be a JSON string that needs double-parse
    output_field=$(echo "$tool_input_raw" | jq -r '. | fromjson? | .output // ""' 2>/dev/null || echo "")
  fi

  # Look for TIME_SAVED: Xm | reason on the first line of output
  if echo "$output_field" | head -1 | grep -q "TIME_SAVED:"; then
    first_line=$(echo "$output_field" | head -1)
    # Extract time (e.g., "15m", "2m", "30s")
    time_saved=$(echo "$first_line" | sed 's/TIME_SAVED:[[:space:]]*//' | sed 's/[[:space:]]*|.*//' | sed 's/[[:space:]]*\$//')
    # Extract reason (after the first pipe only)
    reason=""
    if echo "$first_line" | grep -q '|'; then
      reason=$(echo "$first_line" | sed 's/^[^|]*|[[:space:]]*//' | head -c 200)
    fi
    # Sanitize reason — remove quotes that would break JSON
    reason=$(echo "$reason" | sed 's/"/\\\\"/g')
    # Extract numeric minutes for helpful_pct
    minutes=$(echo "$time_saved" | grep -oE '[0-9]+' | head -1)
    minutes=\${minutes:-0}
    # Map time to helpful %: 0m=0%, 1-4m=15%, 5-14m=30%, 15-29m=60%, 30m+=80%
    if [ "$minutes" -ge 30 ] 2>/dev/null; then helpful_pct=80
    elif [ "$minutes" -ge 15 ] 2>/dev/null; then helpful_pct=60
    elif [ "$minutes" -ge 5 ] 2>/dev/null; then helpful_pct=30
    elif [ "$minutes" -gt 0 ] 2>/dev/null; then helpful_pct=15
    else helpful_pct=0; fi

    # Write review result (overwrites previous)
    echo "{\\"helpful_pct\\": $helpful_pct, \\"time_saved\\": \\"$time_saved\\", \\"reason\\": \\"$reason\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" > "$ace_dir/ace-review-result.json"
  fi
fi

exit 0
`;
}

/**
 * ACE Pre-Tool Use Hook (bash) — per-prompt ace_search gate.
 *
 * Cursor canonical output format: {"permission":"allow"|"deny","agent_message":"..."}
 * NOT {"decision":...} which is Claude Code format and is silently
 * ignored by Cursor's hook engine.
 *
 * Input fields (verified from .cursor/ace/mcp_trajectory.jsonl):
 *   tool_name       e.g. "MCP:ace_search", "Grep", "Read" (with MCP: prefix for MCP tools)
 *   conversation_id stable per chat tab
 *   generation_id   regenerated per user prompt — the gate key
 *
 * Behavior:
 *   - tool_name starts with "MCP:ace_" → always allow (no recursion, lets ace_search itself through)
 *   - else: check .cursor/ace/tasks/<conv_id>/<gen_id>.search-done
 *       - flag exists → allow
 *       - missing     → deny with agent_message instructing the AI to call ace_search first
 *   - missing IDs    → fail-open allow (don't break workflow on malformed input)
 */
export function getPreToolUseScriptContent(): string {
	// Caveman: hook fetches patterns server-side, wraps as <ace-patterns> XML JSON,
	// injects via deny+agent_message. Also injects <ace-roi> from prior task's
	// ace-review-result.json once per generation. Privacy gate is now JSON config
	// (runtime-settings.json) instead of marker file existence.
	//
	// v0.5.0-dev.4 TASK 2 — when AI somehow finds ace_get_playbook (proxy bypassed
	// or out of sync) we silently REWRITE the call to ace_search via Cursor's
	// preToolUse `updated_input` field. AI no see retry loop, AI no fallback.
	// Same for ace_learn — extension Stop hook handles learn server-side.
	return `#!/bin/bash
# ACE Pre-Tool Use Hook (v0.5.0-dev.4) — XML-wrapped pattern injection + ROI +
# silent updated_input rewrite for ace_get_playbook / ace_learn (belt+suspenders
# behind the MCP proxy).

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
conv_id=$(echo "$input" | jq -r '.conversation_id // ""')
gen_id=$(echo "$input" | jq -r '.generation_id // ""')
transcript=$(echo "$input" | jq -r '.transcript_path // ""')

# v0.5.0-dev.20 Task A — per-conv trajectory rotation. Same fallback logic
# as ace_track_mcp.sh (dev.19): write to .cursor/ace/tasks/<conv>/
# mcp_trajectory.jsonl when conv_id present; top-level when missing.
# v0.5.0-dev.24 — folder renamed sessions/ → tasks/.
pre_event_line="{\\"event\\": \\"pre_tool_use\\", \\"tool_name\\": \\"$tool_name\\", \\"conv_id\\": \\"$conv_id\\", \\"gen_id\\": \\"$gen_id\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}"
if [ -n "$conv_id" ] && [ "$conv_id" != "null" ]; then
  per_conv_dir="$ace_dir/tasks/$conv_id"
  mkdir -p "$per_conv_dir"
  echo "$pre_event_line" >> "$per_conv_dir/mcp_trajectory.jsonl"
else
  echo "$pre_event_line" >> "$ace_dir/mcp_trajectory.jsonl"
fi

# v0.5.0-dev.4 TASK 2: silent rewrite for ace_get_playbook + ace_learn.
# Cursor preToolUse output supports \`updated_input\` (per docs) which REWRITES
# the tool call before forwarding to MCP. AI sees no error and no redirect
# nudge — call simply ran with different args.
case "$tool_name" in
  MCP:ace_search)
    # v0.5.0-dev.10 — Cursor known bug 150043: \`arguments\` field is dropped
    # from tools/call when the agent invokes ace_search. The MCP server then
    # returns missing_required_arguments and the AI gives up. Detect empty/
    # missing query and rewrite via \`updated_input\` (same trick as the
    # ace_get_playbook branch below).
    query_arg=$(echo "$input" | jq -r '.tool_input.query // ""' 2>/dev/null)
    if [ -z "$query_arg" ] || [ "$query_arg" = "null" ]; then
      prompt=""
      if [ -n "$transcript" ] && [ -f "$transcript" ]; then
        prompt=$(grep '"role":"user"' "$transcript" 2>/dev/null | tail -1 | jq -r '
          if .message.content and (.message.content | type == "array") then
            [.message.content[] | select(.type=="text") | .text] | join(" ")
          elif .content then .content
          else empty end
        ' 2>/dev/null | head -c 500)
      fi
      [ -z "$prompt" ] && prompt="continue current task"
      prompt_json=$(printf '%s' "$prompt" | jq -Rs .)
      cat <<REWRITE_SEARCH_EOF
{"permission":"allow","updated_input":{"name":"ace_search","arguments":{"query":$prompt_json}},"tool_input":{"name":"ace_search","arguments":{"query":$prompt_json}}}
REWRITE_SEARCH_EOF
      echo "{\\"event\\": \\"rewrote_empty_ace_search\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/ace-relevance.jsonl"
      exit 0
    fi
    # Args look fine — allow as-is.
    echo '{"permission":"allow"}'
    exit 0
    ;;
  MCP:ace_get_playbook|ace_get_playbook)
    # Rewrite to ace_search using user's prompt as query. Read last user
    # message from transcript; fallback to "continue current task".
    prompt=""
    if [ -n "$transcript" ] && [ -f "$transcript" ]; then
      prompt=$(grep '"role":"user"' "$transcript" 2>/dev/null | tail -1 | jq -r '
        if .message.content and (.message.content | type == "array") then
          [.message.content[] | select(.type=="text") | .text] | join(" ")
        elif .content then .content
        else empty end
      ' 2>/dev/null | head -c 500)
    fi
    [ -z "$prompt" ] && prompt="continue current task"
    prompt_json=$(printf '%s' "$prompt" | jq -Rs .)
    # Caveman: per Cursor hooks docs, output uses \`updated_input\` to swap the
    # entire tool invocation. Some hook surfaces use \`tool_input\` — emit both
    # for forward-compat. Cursor will use whichever it recognizes.
    cat <<REWRITE_PLAYBOOK_EOF
{"permission":"allow","updated_input":{"name":"ace_search","arguments":{"query":$prompt_json}},"tool_input":{"name":"ace_search","arguments":{"query":$prompt_json}}}
REWRITE_PLAYBOOK_EOF
    echo "{\\"event\\": \\"rewrote_get_playbook_to_search\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/ace-relevance.jsonl"
    exit 0
    ;;
  MCP:ace_learn|ace_learn)
    # v0.5.0-dev.10+ HOTFIX: Stop hook is the PRIMARY path (server-side
    # storeExecutionTrace via learn helper), but it can fail silently when
    # Cursor strips PATH and \`command -v node\` misses the install. ALLOW
    # the AI's manual ace_learn as a fallback so server-side learn happens
    # even when the Stop hook can't run the helper. The MCP proxy also no
    # longer hides ace_learn for the same reason.
    echo '{"permission":"allow"}'
    echo "{\\"event\\": \\"allowed_ace_learn_fallback\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/ace-relevance.jsonl"
    exit 0
    ;;
  MCP:ace_*)
    echo '{"permission":"allow"}'
    exit 0
    ;;
esac

# Fail-open if missing IDs
[ -z "$conv_id" ] || [ -z "$gen_id" ] && echo '{"permission":"allow"}' && exit 0

# Per-generation flag
# v0.5.0-dev.24 — folder renamed sessions/ → tasks/.
flag_file="$ace_dir/tasks/$conv_id/$gen_id.patterns-injected"
mkdir -p "$ace_dir/tasks/$conv_id"
if [ -f "$flag_file" ]; then
  echo '{"permission":"allow"}'; exit 0
fi

# v0.5.0 TASK 6 — runtime-settings.json privacy gate (replaces share-raw-prompts.optin).
# Falls back to allow-injection only if explicitly enabled in JSON.
opt_in=0
settings_file="$ace_dir/runtime-settings.json"
if [ -f "$settings_file" ]; then
  raw=$(jq -r '.shareRawPromptsForRetrievalAnalysis // false' "$settings_file" 2>/dev/null || echo "false")
  if [ "$raw" = "true" ]; then opt_in=1; fi
fi
if [ "$opt_in" = "0" ]; then
  # Caveman: opt-in OFF → no injection, no flag, no helper call.
  echo '{"permission":"allow"}'; exit 0
fi

# Mark flag IMMEDIATELY (atomic) — if helper takes long or fails, we don't
# loop forever. AI gets fallback "no patterns" but workflow proceeds.
touch "$flag_file"

# v0.5.0 TASK 4 — ROI feedback. Read prior task's review result if present, render
# <ace-roi/> tag, then rename file to -consumed so we don't re-inject.
roi_xml=""
review_file="$ace_dir/ace-review-result.json"
if [ -f "$review_file" ]; then
  time_saved_min=$(jq -r '.time_saved_min // 0' "$review_file" 2>/dev/null || echo "0")
  reason=$(jq -r '.reason // ""' "$review_file" 2>/dev/null || echo "")
  if [ -n "$time_saved_min" ] && [ "$time_saved_min" != "0" ] && [ "$time_saved_min" != "null" ]; then
    # Caveman: jq @xml escapes attribute values safely.
    reason_xml=$(printf '%s' "$reason" | jq -Rr @xml 2>/dev/null || echo "$reason")
    roi_xml="<ace-roi prev-task-saved-min=\\"$time_saved_min\\" reason=\\"$reason_xml\\"/>"
  fi
  # Always rename (consumed marker) so we don't re-inject even when 0 minutes
  mv -f "$review_file" "$ace_dir/ace-review-result-consumed.json" 2>/dev/null || true
fi

# Read user prompt from transcript (last user message).
prompt=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  prompt=$(grep '"role":"user"' "$transcript" 2>/dev/null | tail -1 | jq -r '
    if .message.content and (.message.content | type == "array") then
      [.message.content[] | select(.type=="text") | .text] | join(" ")
    elif .content then .content
    else empty end
  ' 2>/dev/null | head -c 500)
fi

# Fail-open if no prompt (rare — first turn before user input parsed)
[ -z "$prompt" ] && echo '{"permission":"allow"}' && exit 0

# Spawn helper script
helper="$ace_dir/../scripts/ace_search_helper.js"
[ ! -f "$helper" ] && echo '{"permission":"allow"}' && exit 0

# Run helper, capture FULL SearchResponse JSON (not just patterns array).
patterns=""
if command -v node >/dev/null 2>&1; then
  if command -v gtimeout >/dev/null 2>&1; then
    patterns=$(gtimeout 8 node "$helper" "$prompt" 2>/dev/null)
  elif command -v timeout >/dev/null 2>&1; then
    patterns=$(timeout 8 node "$helper" "$prompt" 2>/dev/null)
  else
    patterns=$(perl -e 'alarm 8; exec @ARGV' -- node "$helper" "$prompt" 2>/dev/null)
  fi
fi

# Empty/null/no-results → fail-open
if [ -z "$patterns" ] || [ "$patterns" = "{}" ] || [ "$patterns" = "null" ]; then
  echo '{"permission":"allow"}'; exit 0
fi

# Sanity check: must have at least 1 similar_pattern.
n=$(echo "$patterns" | jq -r '(.similar_patterns // []) | length' 2>/dev/null || echo "0")
if [ "$n" = "0" ] || [ -z "$n" ]; then
  echo '{"permission":"allow"}'; exit 0
fi

# v0.5.0 TASK 2 — wrap as <ace-patterns agent-type="main">{full JSON}</ace-patterns>.
patterns_wrapped=$(printf '<ace-patterns agent-type="main">%s</ace-patterns>' "$patterns")

# Compose final agent_message: optional <ace-roi/> first, then patterns wrapper.
if [ -n "$roi_xml" ]; then
  agent_msg="$roi_xml
$patterns_wrapped"
else
  agent_msg="$patterns_wrapped"
fi

agent_msg_json=$(printf '%s' "$agent_msg" | jq -Rs .)

# Inject via deny + agent_message; AI sees patterns, retries tool, flag exists, allowed
cat <<EOF
{"permission":"deny","user_message":"📚 ACE patterns retrieved","agent_message":$agent_msg_json}
EOF
`;
}

/**
 * Windows PowerShell equivalent of ace_pre_tool_use.sh.
 * Same behavior, same Cursor canonical output format.
 */
export function getPreToolUsePsScriptContent(): string {
	return `# ACE Pre-Tool Use Hook (PowerShell) — v0.5.0-dev.4 fail-open stub.
# Bash counterpart does pattern injection + updated_input rewrite via
# @ace-sdk/core helper. PS variant fail-open (Windows users skip the gate;
# manual ace_search works; MCP proxy hides ace_get_playbook + ace_learn).

$inputJson = [Console]::In.ReadToEnd()
$aceDir = ".cursor/ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }

Write-Output '{"permission":"allow"}'
exit 0
`;
}

/**
 * v0.5.0-dev.4 — getContinuousSearchRuleContent removed. The rule used to
 * tell the AI to re-call ace_search after 5+ tool calls AND to call
 * ace_learn at end of task. Both are now handled automatically:
 *   - domain-shift inject hook fires on Read/Edit when domain changes
 *   - Stop hook delegates ace_learn server-side via the learn helper
 * The AI calling ace_learn manually now contradicts v0.5.0 architecture, so
 * the rule is gone. Activation cleanup removes the obsolete folder from
 * existing workspaces.
 */

/**
 * v0.4.1: Search helper script (Node, in-process @ace-sdk/core).
 *
 * Replaces v0.4.0's ace-cli subprocess approach. SDK team correction: this use
 * case (in-process control, MCP bypass, custom logic around search call) is
 * better served by helper.js + @ace-sdk/core directly.
 *
 * The helper is written to <extensionPath>/scripts/ace_search_helper.js — a
 * TRUSTED location (extension install dir), NOT workspace. The bash + PowerShell
 * postToolUse hooks spawn `node "<baked path>" "<prompt>"`.
 *
 * Stable exit codes (per SDK team contract):
 *   0  success — patterns JSON on stdout
 *   2  TokenExpiredError — caller writes auth-status.txt
 *   3  AceApiError 5xx — server transient issue, fail-open
 *   4  network/timeout/other recoverable — fail-open
 *   5  unknown — fail-open
 *
 * Output: {"similar_patterns":[...], ...} (full SearchResponseWithMetadata).
 *
 * NOTE: The helper requires @ace-sdk/core to be resolvable from the extension's
 * node_modules. extension.ts writes the helper next to the extension's bundled
 * node_modules so `require('@ace-sdk/core')` walks up and finds it.
 */
export function getSearchHelperContent(): string {
	return `#!/usr/bin/env node
// ACE search helper (v0.4.1) — in-process @ace-sdk/core call.
// Spawned by postToolUse hooks (bash + PowerShell). Output: SearchResponseWithMetadata JSON.
// Stable exit codes: 0 ok, 2 token-expired, 3 api-5xx, 4 network/other, 5 unknown.

'use strict';

(async () => {
  try {
    const query = String(process.argv[2] || '').slice(0, 500);
    if (!query) { process.stdout.write('{}'); process.exit(0); }

    const sdk = require('@ace-sdk/core');
    const { loadConfig, AceClient, isTokenExpiredError, AceApiError } = sdk;

    const config = await loadConfig();
    if (!config) { process.stdout.write('{}'); process.exit(0); }

    // v0.5.0-dev.7: orgId normalize (loadConfig returns default_org_id but
    // AceClient reads orgId — without normalize, server returns 403).
    if (!config.orgId && config.default_org_id) config.orgId = config.default_org_id;
    if (!config.orgId && config.defaultOrgId) config.orgId = config.defaultOrgId;

    const client = new AceClient(config);

    // v0.5.0-dev.6: removed ensureValidToken (not on AceClient prototype).

    const threshold = (config.search_threshold !== undefined && config.search_threshold !== null)
      ? config.search_threshold
      : ((config.constitution_threshold !== undefined && config.constitution_threshold !== null)
        ? config.constitution_threshold
        : 0.85);
    const top_k = config.search_top_k || 5;

    const result = await client.searchPatterns({
      query,
      threshold,
      top_k,
      include_metadata: false,
      agent_type: 'cursor',
    });

    process.stdout.write(JSON.stringify(result || {}));
    process.exit(0);
  } catch (err) {
    // Caveman: classify error, map to stable exit code.
    try {
      const sdk = require('@ace-sdk/core');
      if (sdk.isTokenExpiredError && sdk.isTokenExpiredError(err)) { process.exit(2); }
      if (err instanceof sdk.AceApiError) {
        const status = err.status || 0;
        if (status >= 500) { process.exit(3); }
        process.exit(4);
      }
    } catch (_) { /* fall through */ }
    const name = (err && err.name) || '';
    if (/TokenExpired/i.test(name)) { process.exit(2); }
    if (/AceApiError/i.test(name)) { process.exit(3); }
    if (/Network|Timeout|ECONN|ETIMEDOUT/i.test(String(err && err.message || err))) { process.exit(4); }
    process.exit(5);
  }
})();
`;
}

