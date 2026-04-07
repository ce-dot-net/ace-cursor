# SDK Request: Add `summary` field to MCP ace_learn tool

## From: Cursor Extension Team
## To: @ace-sdk team
## Priority: High — server already supports it, Claude Code already sends it

## Problem

The ACE server's server uses `result.summary` (the AI's last assistant message) for
higher-fidelity pattern extraction. The Claude Code plugin (`ace_after_task.py:489`) already
sends this field:

```python
"result": {
    "success": not has_errors,
    "output": f"Executed {len(tools)} tool calls",
    "summary": last_assistant_message[:2000],  # v5.5.0
}
```

But the MCP `ace_learn` tool schema has NO `summary` field. Cursor users get lower-quality
pattern extraction because the server never sees what the AI actually said.

## What we need

Add `summary` as an optional string param to `ace_learn` in `@ace-sdk/mcp`.

### 1. `packages/mcp/src/tools/definitions.ts` (~line 317)

```typescript
// Inside ace_learn inputSchema.properties, add:
summary: {
  type: 'string',
  description: 'Last assistant message or conversation summary. Used by server server for higher-fidelity pattern extraction. Keep under 2000 chars.'
}
```

### 2. `packages/core/src/types/pattern.ts` (~line 30)

```typescript
export interface ExecutionTrace {
  task: string;
  trajectory: TrajectoryStep[] | string[];
  result: {
    success: boolean;
    output: string;
    error?: string;
    summary?: string;  // ← ADD THIS
  };
  playbook_used: string[];
  timestamp: string;
  git?: GitContext;
}
```

### 3. `packages/mcp/src/index.ts` (~line 645)

```typescript
case 'ace_learn': {
  const { task, trajectory, success, output, error, summary, playbook_used, verbosity, git, session_id } = args as {
    // ... existing fields ...
    summary?: string;  // ← ADD THIS
  };

  // ... later in trace construction:
  const trace: ExecutionTrace = {
    task,
    trajectory: formattedTrajectory,
    result: { success, output, error, ...(summary && { summary }) },  // ← ADD summary
    playbook_used: mergedPlaybookUsed,
    timestamp: new Date().toISOString(),
    ...(git && { git })
  };
```

## Non-breaking

- Optional field, no schema validation change
- Server already accepts and processes `result.summary`
- Existing clients unaffected
- Cursor extension will start sending it once the MCP tool accepts it

## What Cursor will send

Once the SDK ships this, our `afterMCPExecution` hook or stop hook will read the Cursor
transcript file (already available via `transcript_path`), extract the last assistant message,
and the AI will pass it in the `summary` field of `ace_learn`.

## Workaround (current)

Until the SDK ships this, Cursor's ace_learn calls have no `result.summary`. The AI writes
a brief `output` field from memory, which the server uses — but it's lossy compared to
the actual assistant response text.
