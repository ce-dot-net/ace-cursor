# SDK Request: Make ace_learn fire-and-forget (non-blocking)

## From: Cursor Extension Team
## To: @ace-sdk team + ACE Server team
## Priority: Critical — real user feedback, users uninstalling

## Problem

When the AI calls `ace_learn` at the end of a task, the MCP tool blocks for 10-17
seconds while the server analyzes the trace. The user can't send another message or
switch to a new task during this time. Users are uninstalling the extension because
of this.

Real user feedback (Wagner):
> "I need to wait until ace pattern messages are finished until I can send another
> message to fix. It consume time."

## Current behavior

```
ace_learn called → storeExecutionTraceStream(trace) → SSE streaming → 10-17s wait
                                                                       ↑
                                                               User blocked here
```

The MCP `ace_learn` handler at `packages/mcp/src/index.ts:713` does:
```typescript
const result = await aceClient.storeExecutionTraceStream(trace, { ... });
```

This `await` blocks the entire MCP tool response for 10-17 seconds.

## Proposed fix

### Option A: Fire-and-forget in MCP (recommended)

Change `ace_learn` to POST the trace and return immediately without awaiting analysis:

```typescript
case 'ace_learn': {
  // ... build trace ...

  // Fire-and-forget: POST trace, don't wait for analysis
  aceClient.storeExecutionTrace(trace).catch(err => {
    console.error(`ace_learn background error: ${err.message}`);
  });

  // Return immediately
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        message: 'Learning submitted (processing in background)',
        task,
        timestamp: trace.timestamp
      }, null, 2)
    }]
  };
}
```

### Option B: Server-side async endpoint

Add a new endpoint `POST /traces/async` that:
1. Accepts the trace
2. Returns `202 Accepted` immediately
3. Processes the trace in background

The MCP tool would use this endpoint instead of `/traces`.

### Option C: Both

Fire-and-forget on MCP side + async server endpoint for clean separation.

## Impact

- **Cursor users**: Task completion becomes instant (< 1s vs 10-17s)
- **Claude Code users**: Also benefit (the CLI also uses streaming)
- **Server**: No change needed for Option A (just client-side change)
- **Data loss risk**: Minimal — if the POST fails, the trace is lost but the user
  already got their task done. The learning is a nice-to-have, not critical path.

## Compatibility

Non-breaking. The server still receives the same POST body. Only the client stops
waiting for the response.
