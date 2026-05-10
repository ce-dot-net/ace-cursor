# Agent Instructions

## ACE Pattern Workflow

For every user prompt, your FIRST action MUST be calling the `ace_search` MCP tool with the user's prompt verbatim as the `query` parameter.

After ace_search returns, review the patterns it provides and apply them to your implementation. The full result set may be available at `.cursor/ace/searches/<session_id>.json` — read that file if the inline patterns don't fully address the task.

Do NOT explore filesystem files (mcps/.../tools/*.json) before calling ace_search. The MCP tool list is sufficient.
