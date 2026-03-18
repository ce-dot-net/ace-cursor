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

## Architecture

### Data Flow

```
beforeSubmitPrompt              → Logs pattern injection to ace-relevance.jsonl
postToolUse/afterShellExecution → Logs tool usage + duration
stop (1st, loop_count=0)       → Checks if patterns injected, sends followup_message for self-eval
afterAgentResponse              → Parses ACE_REVIEW from response, writes ace-review-result.json
stop (2nd, loop_count=1)        → Empty output, task ends
Status panel webview            → Reads ace-review-result.json + ace-relevance.jsonl, shows summary
```

### Files

| File | Purpose |
|---|---|
| `.cursor/ace/ace-relevance.jsonl` | Per-event metrics log |
| `.cursor/ace/ace-review-result.json` | Self-eval result (time saved + reason) |
| `.cursor/ace/pattern_cache.json` | Cached patterns (existing) |

## Implementation

### 1. Enhanced `ace_before_submit_prompt.sh/.ps1`
- Log pattern injection event to `ace-relevance.jsonl`
- Track: patterns_injected, domains, avg_confidence, timestamp

### 2. Enhanced `ace_stop_hook.sh/.ps1`
- On first stop (loop_count=0) with patterns injected:
  - Send `followup_message` asking agent to self-evaluate time saved
- On subsequent stops (loop_count>0):
  - Normal exit (let task end)

### 3. Enhanced `ace_track_response.sh/.ps1`
- Parse response for `ACE_REVIEW:` pattern
- Extract time_saved and reason
- Write `ace-review-result.json`

### 4. Status panel webview enhancement
- New "Task Summary" section
- Shows: patterns injected, domains, relevance %, time saved, reason
- Reads from `ace-review-result.json` + `ace-relevance.jsonl`

### 5. Status bar update
- After self-eval: flash `$(clock) ~15m saved by ACE`

### 6. Tests (E2E + unit)
- Script execution tests for enhanced hooks
- Self-eval parsing tests
- Status panel rendering tests
