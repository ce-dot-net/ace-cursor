# ACE Task Helpfulness — Time Saved Transparency

## Goal

Show Cursor users how much time ACE pattern knowledge saved them per task.
After each task completes, the user sees in the status panel:

```
◆ ACE Task Summary
─────────────────────────────
  42 patterns injected │ 3 domains
  Relevance: 72%

  ⏱ ~15m saved
  "Auth patterns avoided 30min of OAuth docs research"
─────────────────────────────
```

## Architecture (v2 — afterMCPExecution approach)

### Data Flow

```
beforeSubmitPrompt        → Logs pattern injection to ace-relevance.jsonl
afterMCPExecution         → Detects ace_learn call, extracts TIME_SAVED from output field
                            → Writes ace-review-result.json
Extension file watcher    → Detects ace-review-result.json change, flashes status bar
stop                      → Logs trajectory summary to ace-relevance.jsonl (no followup_message)
Status panel webview      → Reads ace-review-result.json + ace-relevance.jsonl, shows summary
```

### Why afterMCPExecution (not stop + ACE_REVIEW)

The previous approach used the `stop` hook to send a `followup_message` asking the AI to
self-evaluate with `ACE_REVIEW: Xm saved | reason`. This was fragile because:
- Required an extra agent loop (stop → followup → response → parse)
- Text parsing of agent response was error-prone
- Only fired once per session, not per task

The new approach detects `ace_learn` MCP calls directly:
- Fires per task (every time ace_learn is called)
- Extracts structured data from `tool_input.output` field
- No extra agent loop needed
- Clean parsing of `TIME_SAVED:` prefix

### Files

| File | Purpose |
|---|---|
| `.cursor/ace/ace-relevance.jsonl` | Per-event metrics log |
| `.cursor/ace/ace-review-result.json` | Task helpfulness result (time saved + reason) |
| `.cursor/ace/pattern_cache.json` | Cached patterns (existing) |

## Implementation

### 1. Enhanced `ace_track_mcp.sh/.ps1` (afterMCPExecution hook)
- Detects when `tool_name` matches `ace_learn`
- Parses `tool_input.output` for `TIME_SAVED: Xm | reason` on first line
- Calculates `helpful_pct` from minutes (0=0%, 1-4=15%, 5-14=30%, 15-29=60%, 30+=80%)
- Writes `ace-review-result.json`

### 2. Updated `ace-patterns.mdc` rules
- Instructs AI to prefix `output` field with `TIME_SAVED: Xm | reason\n`
- Example format in rules ensures AI compliance

### 3. Simplified `ace_stop_hook.sh/.ps1`
- No longer sends `followup_message` for self-eval
- Only aggregates trajectory summary to `ace-relevance.jsonl`
- Returns `{}` (empty output)

### 4. Simplified `ace_track_response.sh/.ps1`
- No longer parses `ACE_REVIEW:` from response text
- Only logs response to trajectory

### 5. Extension file watcher
- Watches `.cursor/ace/ace-review-result.json` for changes
- On change: reads time_saved, flashes status bar with `$(clock) ~Xm saved by ACE`
- Reverts to normal status bar after 8 seconds

### 6. Status panel webview
- Reads `ace-review-result.json` + `ace-relevance.jsonl`
- Shows: patterns injected, domains, relevance %, time saved, reason

### 7. Tests (E2E + unit)
- Unix + PowerShell: ace_track_mcp detects ace_learn, parses TIME_SAVED, writes result
- Unix + PowerShell: simplified stop hook outputs {} and logs stop event
- Session tracking: validates new flow end-to-end
