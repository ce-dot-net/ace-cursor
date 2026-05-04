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
ace_search("testing patterns", allowed_domains=["mcp-cli-testing-and-api-resilience"])

# WRONG - hardcoded domain that doesn't exist on server
ace_search("testing patterns", allowed_domains=["test"])
\`\`\`

## Workflow

1. \`ace_list_domains()\` - See what domains exist
2. Pick relevant domain(s) based on task context
3. \`ace_search("query", allowed_domains=["picked-domain"])\`

## Why This Matters

Using non-existent domains returns 0 results. Always verify domain names exist first.
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
3. **Search**: Call \`ace_search("query", allowed_domains=["picked-domain"])\`

**IMPORTANT**: Domain names are semantic (e.g., "typescript-development-practices"),
not simple paths. Always use \`ace_list_domains\` to discover actual domain names.

## Example Workflow

1. Start task → \`ace_search("your task description")\` to retrieve relevant patterns
2. 5+ edits later → \`ace_search("error handling")\` for fresh patterns
3. Need focused results → \`ace_list_domains()\` then \`ace_search(..., allowed_domains=[...])\`
4. Task complete → \`ace_learn(...)\` to capture lessons
`;
}
