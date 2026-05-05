/**
 * Pure-function getters for ACE rule file content.
 * Extracted from extension.ts to make rule content unit-testable
 * without fs/vscode mocking. Used by createCursorRules in extension.ts.
 */

export function getAcePatternsRuleContent(): string {
	return `---
description: ACE Pattern Learning - MANDATORY pattern search EVERY SESSION
alwaysApply: true
---

# MANDATORY: ACE Pattern Search - EVERY SESSION

**CRITICAL INSTRUCTION - DO NOT SKIP**

## PER-PROMPT REQUIREMENT

**On your first response in this conversation, before producing any output other than a brief acknowledgement, call \`ace_search\` with the user's request (or its core intent) as the query.**

Do NOT assume you "already know" the patterns from a previous session.
Do NOT skip because patterns seem "familiar" or "unchanged".
EVERY session is a fresh context - patterns MUST be retrieved again.

## Tool Call Shape

ace_search and ace_learn use **named arguments only** (MCP spec — JSON object \`{[key: string]: unknown}\`). Never call positionally:

- ✓ CORRECT: \`ace_search(query="JWT authentication")\` — named \`query=\` argument
- ✗ WRONG: passing the query string as the first positional argument with no \`query=\` label — \`query\` will arrive as \`undefined\` at the server and the call will fail with HTTP 400

If you cannot determine a query, do **not** call ace_search with empty arguments — call it with the user's most recent message text as the query.

## BEFORE ANY Implementation Task

**You MUST call \`ace_search\` MCP tool FIRST** before:
- Writing ANY code
- Implementing ANY feature
- Fixing ANY bug
- Making ANY architectural decision

## HOW TO USE ace_search

1. **Read the user's task/request**
2. **Call ace_search with the task as query:**
   \`\`\`
   ace_search(query="<user's task description>")
   \`\`\`
3. **Review returned patterns** (5-10 relevant ones)
4. **Apply patterns to implementation**

**Example:**
- User: "Implement JWT authentication"
- You call: \`ace_search(query="JWT authentication")\`
- Returns: 5-10 patterns about JWT, auth, tokens, security

**FAILURE TO CALL ace_search = INCOMPLETE TASK**

## WHY ace_search (NOT ace_get_playbook)?

- \`ace_search\` → Returns 5-10 RELEVANT patterns (semantic search)
- \`ace_get_playbook\` → Returns ALL 1000+ patterns (context explosion!)

Always prefer ace_search with user's task as query.

## WHY EVERY SESSION?

1. Your context resets between sessions - previous patterns are NOT retained
2. Playbook may have been updated since your last session
3. New patterns from other team members may be available
4. Caching ensures fast retrieval (RAM → SQLite → Server)

## AFTER Completing Substantial Work - SINGLE ace_learn Call

**Call \`ace_learn\` ONCE after completing your task.**

Do NOT call ace_learn immediately after each implementation step.
Wait until the task is fully complete, then call ace_learn with the full context.

**IMPORTANT: Include TIME_SAVED on the FIRST LINE of the output field.**
Estimate how much time the ACE patterns saved the developer (vs researching docs, exploring code, trial-and-error).

\`\`\`
ace_learn(
  task="<what you accomplished>",
  trajectory=["<key steps>"],
  success=true,
  output="TIME_SAVED: Xm | <one-line reason>\\n<lessons learned>",
  summary="<your last response — include WHAT you built, WHY you made key decisions, and what you LEARNED>"
)
\`\`\`

**summary tips** (the server uses this for better pattern extraction):
- Include what you built AND why (architectural decisions)
- Mention what went wrong or what you changed approach on
- Note which ACE patterns helped and how
- Example: "Initially tried X but switched to Y because Z. The playbook pattern about W saved time."

**Example:**
\`\`\`
ace_learn(
  task="Implemented JWT authentication",
  trajectory=["Added auth middleware", "Created login endpoint", "Added token refresh"],
  success=true,
  output="TIME_SAVED: 15m | Auth patterns avoided OAuth docs research\\nAlways use httpOnly cookies for refresh tokens.",
  summary="I implemented JWT auth with HS256 signing. Initially tried RS256 but switched to HS256 because the project has no key rotation infra. Used httpOnly cookies after the playbook warned against localStorage tokens. The /login endpoint validates credentials, /protected verifies with timingSafeEqual."
)
\`\`\`

**TIME_SAVED format:** \`TIME_SAVED: Xm | reason\`
- X = estimated minutes saved (0 if patterns weren't helpful)
- reason = one-line explanation of what patterns helped with
- Rest of output = normal lessons learned (after newline)

## Available ACE MCP Tools

1. \`ace_search\` - **CALL FIRST** - Search patterns by query (5-10 relevant)
2. \`ace_list_domains\` - List available domains for filtering
3. \`ace_learn\` - **CALL AFTER** - Capture learning
4. \`ace_status\` - View playbook statistics
5. \`ace_get_playbook\` - Get ALL patterns (only for export/backup)
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

# Always log to trajectory
echo "$input" >> "$ace_dir/mcp_trajectory.jsonl"

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
  flag_dir="$ace_dir/sessions/$conv_id"
  mkdir -p "$flag_dir"
  touch "$flag_dir/$gen_id.search-done"
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
 *   - else: check .cursor/ace/sessions/<conv_id>/<gen_id>.search-done
 *       - flag exists → allow
 *       - missing     → deny with agent_message instructing the AI to call ace_search first
 *   - missing IDs    → fail-open allow (don't break workflow on malformed input)
 */
export function getPreToolUseScriptContent(): string {
	return `#!/bin/bash
# ACE Pre-Tool Use Hook — per-prompt ace_search gate
# Cursor canonical schema: {"permission":"allow"|"deny","agent_message":"..."}
# NOT {"decision":...} (Claude Code format, ignored by Cursor)

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
conv_id=$(echo "$input" | jq -r '.conversation_id // ""')
gen_id=$(echo "$input" | jq -r '.generation_id // ""')

# Log (always)
echo "{\\"event\\": \\"pre_tool_use\\", \\"tool_name\\": \\"$tool_name\\", \\"conv_id\\": \\"$conv_id\\", \\"gen_id\\": \\"$gen_id\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/mcp_trajectory.jsonl"

# Allow ace_* MCP tools unconditionally (avoids recursion, permits ace_search itself)
case "$tool_name" in
  MCP:ace_*)
    echo '{"permission":"allow"}'
    exit 0
    ;;
esac

# Fail-open if IDs missing (malformed input — don't break workflow)
if [ -z "$conv_id" ] || [ -z "$gen_id" ]; then
  echo '{"permission":"allow"}'
  exit 0
fi

# Check per-generation flag
flag_file="$ace_dir/sessions/$conv_id/$gen_id.search-done"
if [ -f "$flag_file" ]; then
  echo '{"permission":"allow"}'
  exit 0
fi

# No flag — deny and instruct AI to call ace_search first.
# Heredoc with single-quoted delimiter: no expansion, no escape gymnastics.
# JSON body stays a single line so the deny payload is one self-contained record.
cat <<'ACE_DENY_EOF'
{"permission":"deny","agent_message":"You must call ace_search FIRST for every user prompt before any other tool. Required call shape: ace_search with named argument query=\\"<user message text or core intent>\\" (non-empty string). Do not call ace_search without arguments. After ace_search returns, retry your original tool call."}
ACE_DENY_EOF
`;
}

/**
 * Windows PowerShell equivalent of ace_pre_tool_use.sh.
 * Same behavior, same Cursor canonical output format.
 */
export function getPreToolUsePsScriptContent(): string {
	return `# ACE Pre-Tool Use Hook (PowerShell) — per-prompt ace_search gate
# Cursor canonical schema: {"permission":"allow"|"deny","agent_message":"..."}

$inputJson = [Console]::In.ReadToEnd()
$aceDir = ".cursor/ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }

try {
    $payload = $inputJson | ConvertFrom-Json
    $toolName = $payload.tool_name
    $convId = $payload.conversation_id
    $genId = $payload.generation_id
} catch {
    Write-Output '{"permission":"allow"}'
    exit 0
}

# Log
$logEntry = @{
    event = "pre_tool_use"
    tool_name = $toolName
    conv_id = $convId
    gen_id = $genId
    timestamp = (Get-Date -Format "o")
} | ConvertTo-Json -Compress
Add-Content -Path "$aceDir/mcp_trajectory.jsonl" -Value $logEntry

# Allow ace_* MCP tools unconditionally
if ($toolName -like "MCP:ace_*") {
    Write-Output '{"permission":"allow"}'
    exit 0
}

# Fail-open if IDs missing
if ([string]::IsNullOrEmpty($convId) -or [string]::IsNullOrEmpty($genId)) {
    Write-Output '{"permission":"allow"}'
    exit 0
}

# Check per-generation flag
$flagFile = "$aceDir/sessions/$convId/$genId.search-done"
if (Test-Path $flagFile) {
    Write-Output '{"permission":"allow"}'
    exit 0
}

# No flag — deny
$denyResponse = @{
    permission = "deny"
    agent_message = "You must call ace_search FIRST for every user prompt before any other tool. Required call shape: ace_search with named argument query=\`"<user's most recent message text or its core intent>\`" (a non-empty string). Do not call ace_search without arguments — query is required. After ace_search returns, retry your original tool call."
} | ConvertTo-Json -Compress
Write-Output $denyResponse
`;
}

export function getContinuousSearchRuleContent(): string {
	return `---
description: Re-call ace_search after 5+ tool calls or when switching file domain during extended work sessions
alwaysApply: false
---

# Continuous Pattern Retrieval

## When to Re-Search Patterns

Call \`ace_search\` again during extended work sessions when:

1. **Extended work** - 5+ tool calls since last pattern retrieval
2. **Hitting errors** - Encountering issues not covered by current patterns
3. **New context** - Switching to different file type or codebase area
4. **Task shift** - Moving from one feature area to another

## Domain Filtering for Focused Results

For focused results, use domain filtering:

1. **First**: Call \`ace_list_domains()\` to see available domains
2. **Match**: Pick domain(s) that match your current task context
3. **Search**: Call \`ace_search(query="<your query>", allowed_domains=["picked-domain"])\`

**IMPORTANT**: Domain names are semantic (e.g., "typescript-development-practices"),
not simple paths. Always use \`ace_list_domains\` to discover actual domain names.

## Example Workflow

1. Start task → \`ace_search(query="your task description")\` to retrieve relevant patterns
2. 5+ edits later → \`ace_search(query="error handling")\` for fresh patterns
3. Need focused results → \`ace_list_domains()\` then \`ace_search(query="...", allowed_domains=[...])\`
4. Task complete → \`ace_learn(task="...", trajectory=[...], success=true, output="...", summary="...")\` to capture lessons
`;
}
