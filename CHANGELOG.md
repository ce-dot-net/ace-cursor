# Changelog

All notable changes to the "ACE for Cursor" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.34] - 2026-01-05

### Changed
- **Single ace_learn call at end** - Wait for AI-Trail summary before calling ace_learn
  - Previous: ace_learn called twice (after implementation + after summary)
  - Now: Single call at end with full AI-Trail stats + git context
  - More efficient, captures complete execution trace

### Technical
- Updated `.cursor/rules/ace-patterns.mdc` with explicit "SINGLE ace_learn Call" instructions
- AI now waits for "Session complete. AI-Trail: MCP:X Shell:Y..." before calling ace_learn
- Includes git context (branch + commit hash) from AI-Trail

## [0.2.33] - 2026-01-05

### Fixed
- **Changelog now visible on Open VSX** - v0.2.32 was published before changelog was committed

## [0.2.32] - 2026-01-05

### Added
- **HTTP pattern preload on activation** - Preloads patterns via `ace_search` API in background
- **Pattern count in status bar** - Shows "ACE: X patterns" after preload completes
- **New tests** - Added tests for `getPreloadedPatternInfo` and preload endpoint format

### Changed
- **Cursor rules prioritize `ace_search` over `ace_get_playbook`**
  - `ace_search(query="<task>")` returns 5-10 relevant patterns (semantic search)
  - `ace_get_playbook()` returns ALL 1000+ patterns (context explosion risk)
  - Rules now include "HOW TO USE ace_search" instructions with examples
- Updated test to verify rules mention `ace_search`

### Technical
- `preloadPatterns()` uses `/patterns/search` endpoint with generic query
- Status bar updated after preload with pattern count and domain tooltip
- Exported `getPreloadedPatternInfo()` for external access

### Companion Release
- **@ace-sdk/mcp v2.5.0** adds MCP Resources (future-ready for when Cursor fixes Resources support):
  - `ace://playbook/search?query=...` - Semantic search resource
  - `ace://domains` - Domain listing resource

## [0.2.31] - 2025-12-23

### Fixed
- **"Update Workspace" now actually updates all files** (v0.2.30 follow-up fix)
  - Previously: Clicking "Update Workspace" called update functions but they didn't overwrite existing files
  - Root cause: `if (!fs.existsSync())` checks prevented updates to existing files
  - Added `forceUpdate` parameter to: `createCursorRules()`, `createCursorCommands()`, `createCursorHooks()`, `createWindowsHookScripts()`, `createUnixHookScripts()`
  - Version upgrade popup now passes `forceUpdate=true` to force overwrite stale files

### Technical
- Files now updated on version upgrade: hook scripts (.sh/.ps1), ace-patterns.mdc, all slash commands
- Initial workspace setup (forceUpdate=false) still only creates missing files
- Version update (forceUpdate=true) overwrites all workspace files with latest templates

## [0.2.30] - 2025-12-23

### Fixed
- **Domain filtering now works** (Issue #3 final fix)
  - Updated Cursor rules to use `ace_list_domains` for dynamic domain discovery
  - Rule files now instruct AI to call `ace_list_domains` BEFORE using `allowed_domains`
  - Fixes 0-result issue caused by hardcoded domain names that don't exist on server

### Changed
- `ace-patterns.mdc` - Added `ace_list_domains` to available tools list
- `ace-domain-search.md` - Complete rewrite for dynamic domain discovery workflow
- `ace-continuous-search.md` - Removed hardcoded domain references, simplified to retrieval focus

### Technical
- Server domains are SEMANTIC (e.g., "typescript-development-practices")
- Previous hardcoded "auth", "api", "test" domains returned 0 results
- Now AI discovers actual domain names via `ace_list_domains` MCP tool

## [0.2.29] - 2025-12-22

### Added
- MCP Resources exploration (later reverted - Cursor doesn't support MCP Resources yet)
- Temp file domain state writing for MCP integration attempts

### Note
- This version was an intermediate step exploring MCP Resources approach
- Changes were reverted after discovering Cursor only supports MCP Tools, not Resources

## [0.2.28] - 2025-12-22

### Added
- **Continuous search with domain output** (extends Issue #3)
  - Hook scripts now output domain JSON for AI to use
  - `afterFileEdit` hook outputs: `{"file": "...", "domain": "api", "domain_hint": "..."}`
  - AI can read domain from hook output and use `allowed_domains` in ace_search
  - New rule `.cursor/rules/ace-continuous-search.md` instructs AI on domain-aware re-search
  - No MCP changes needed - uses existing `allowed_domains` parameter

### Changed
- Hook script templates (Unix + Windows) updated to output domain context
- Domain reference table in rules for auth, api, cache, database, ui, test, general

### Added Tests
- Continuous search rule structure validation
- Hook script domain output verification

## [0.2.27] - 2025-12-21

### Added
- **Domain-aware continuous search** (Issue #3: Claude Code v5.3.0 parity)
  - New Cursor rule `.cursor/rules/ace-domain-search.md` guides AI to use domain filtering
  - Domain detection in TypeScript (`detectDomain()` in workspaceMonitor.ts)
  - Domain shift logging to `.cursor/ace/domain_shifts.log`
  - Console logs show domain transitions: `[ACE] Domain shift: auth → api`
  - Hook scripts updated with domain detection (Unix + Windows)

### Changed
- Hook scripts now always update to get latest domain detection features
- Domains supported: auth, api, cache, database, ui, test, general

### Added Tests
- `getCurrentDomain` should return valid domain string
- Domain detection path identification tests (auth, api, ui, test)
- Domain-aware search rule structure validation
- Domain shifts log write test

## [0.2.26] - 2025-12-17

### Fixed
- **Critical: Workspace monitor now detects folder switches correctly**
  - Root cause: `isMultiRootWorkspace()` guard was blocking ALL folder tracking
  - Removed guard from `onDidChangeActiveTextEditor` handler
  - Now status bar updates immediately when switching between folders
  - Popup appears for each unconfigured folder (not just on startup)
- **Startup prompt now works for both single and multi-root workspaces**
- **Handle newly added workspace folders** - prompts to configure when folder added

### Changed
- Added debug logging to `isMultiRootWorkspace()` for diagnostics

## [0.2.25] - 2025-12-17

### Changed
- **Simplified status bar**: Reverted to cleaner format without folder name
  - Configured: `ACE: 257 patterns`
  - Not configured: `ACE: Not configured`
  - Folder name shown in tooltip only

## [0.2.24] - 2025-12-17

### Fixed
- **Configure popup now shows for each unconfigured folder**
  - Previously: popup shown once, then suppressed for all folders
  - Now: popup only suppressed if user clicks "Later" for that specific folder
  - Dismissing popup (clicking elsewhere) allows it to reappear on next switch

### Changed
- Enhanced logging with `***` markers for easy console filtering

## [0.2.23] - 2025-12-17

### Fixed
- **Multi-root workspace debugging**: Added comprehensive logging to diagnose folder switch detection
  - Logs `readContext()` path resolution and settings file parsing
  - Logs `onFolderSwitch()` folder details and configuration state
  - Logs `showConfigurePrompt()` invocation and user response

## [0.2.22] - 2025-12-17

### Added
- **Single-folder workspace prompt**: Shows configure popup on startup for unconfigured single-folder workspaces
  - 2-second delay to allow extension to fully activate
  - Complements multi-root folder switch detection

### Changed
- Added detailed logging for workspace monitoring and folder switch detection

## [0.2.21] - 2025-12-17

### Fixed
- **Multi-root folder switch detection**: Fixed folder comparison using URI instead of object reference
  - Added `isSameFolder()` helper to properly compare workspace folders
  - Configure popup now correctly appears when switching to unconfigured folder

## [0.2.20] - 2025-12-17

### Changed
- **Status bar styling**: Now matches VSCode extension exactly
  - Shows `$(book) ACE: 257 patterns` format (was "ACE (257)")
  - Shows `$(warning) ACE: Not configured` with warning background color
  - Loading state shows `$(sync~spin) ACE: Loading...`
- **Configure popup**: Uses warning message style like VSCode
  - Text: `ACE not configured for "folder-name"`
  - Buttons: "Configure Now", "Later"

## [0.2.19] - 2025-12-17

### Fixed
- **Single-folder workspace detection**: Status bar now correctly identifies and shows configuration state for single-folder workspaces (matches VSCode extension behavior)
- **Popup tracking**: Added `promptedFolders` Set to prevent repeated "Configure ACE?" prompts for the same folder in a session
- Status bar now always uses `currentFolder` instead of ignoring it for single-folder workspaces

## [0.2.18] - 2025-12-16

### Fixed
- **Status bar pattern count**: Fixed API endpoint from `/api/v1/analytics` to `/analytics`
- Pattern count now shows correctly (e.g., "ACE (257)")

## [0.2.17] - 2025-12-16

### Fixed
- **Status bar pattern count**: Now uses main `getAceConfig()` function to read API token from all sources (workspace settings, global config)
- Added debug logging for pattern count fetch failures

## [0.2.16] - 2025-12-16

### Added
- **Real-Time Workspace Monitoring**: Detects folder switches and updates context automatically
  - Status bar shows current folder name and pattern count
  - Shows configuration popup when switching to unconfigured folder
  - `src/automation/workspaceMonitor.ts` - Real-time workspace folder monitoring
- `onDidChangeActiveTextEditor` listener for folder switch detection
- `onDidChangeWorkspaceFolders` listener for workspace changes
- Pattern count fetched from ACE server with 1-minute cache

### Changed
- Status bar now shows pattern count (e.g., "ACE: folder-name (42)")
- `getAceConfig()` now uses `getCurrentFolder()` as default for multi-root workspaces

## [0.2.15] - 2025-12-15

### Added
- **Multi-Root Workspace Support**: Each folder in multi-root workspaces now gets its own ACE configuration
  - `ACE: Initialize Workspace` prompts to select which folder to initialize
  - `ACE: Configure Connection` saves settings to selected folder
  - Update prompts check each folder individually
- Folder picker utilities: `pickWorkspaceFolder()`, `getTargetFolder()`, `isMultiRootWorkspace()`
- Context-aware folder detection from active editor

### Changed
- All folder-dependent functions now accept optional `folder` parameter
- Version update prompt now works per-folder (each folder can have different version)
- Diagnostic command now checks selected folder's configuration

## [0.2.14] - 2025-12-15

### Changed
- **README**: Clearer "CLOSED BETA" notice - account required to use extension
- **Quick Start**: Sign up is now step 1 (required!) - makes clear extension won't work without API token

## [0.2.13] - 2025-12-14

### Added
- **AI-Trail Support** (Closes [#2](https://github.com/ce-dot-net/ace-cursor/issues/2))
  - Full trajectory tracking using Cursor's native hooks
  - `afterMCPExecution`: Captures all MCP tool calls (tool name, input, output, duration)
  - `afterShellExecution`: Captures terminal commands (command, output, duration)
  - `afterAgentResponse`: Captures agent final responses
  - `afterFileEdit`: Captures file edits (path, changes)
  - `stop`: Enhanced with git context aggregation (branch, hash, trajectory summary)
- New trajectory files in `.cursor/ace/`:
  - `mcp_trajectory.jsonl` - MCP tool execution trace
  - `shell_trajectory.jsonl` - Shell command trace
  - `response_trajectory.jsonl` - Agent response trace
  - `edit_trajectory.jsonl` - File edit trace

### Changed
- Stop hook now provides AI-Trail summary with git context for `ace_learn`
- ~80% trajectory coverage vs Claude Code's ~95% (Cursor's built-in tools don't go through MCP hooks)

## [0.2.12] - 2025-12-12

### Added
- **Workspace Version Tracking**: Extension now stores version in `.cursor/ace/settings.json`
- **Update Notification**: Popup prompts to update workspace files when extension is upgraded
- Options: "Update Workspace", "Remind Me Later", "Skip"

### Fixed
- **Windows**: hooks.json now auto-updates to point to .ps1 scripts if previously created with .sh references
- Fixes issue where upgrading from pre-0.2.10 on Windows left hooks pointing to wrong scripts

## [0.2.11] - 2025-12-11

### Fixed
- **Windows**: `process.env.HOME` replaced with `os.homedir()` for cross-platform config paths
- **Windows**: File permission modes now conditional (Unix-only) to prevent errors

## [0.2.10] - 2025-12-11

### Added
- **Windows**: PowerShell hooks (.ps1) instead of bash scripts
- Platform-aware hook creation: `.sh` on Unix, `.ps1` on Windows
- hooks.json now uses `powershell -ExecutionPolicy Bypass -File` on Windows

## [0.2.9] - 2025-12-11

### Fixed
- **Windows**: Skip bash hook creation (ace_track_edit.sh was opening in text editor instead of executing)
- Windows users now rely on MCP tools + rules file (primary mechanism) instead of bash hooks

## [0.2.8] - 2025-12-11

### Fixed
- CHANGELOG.md now included in package (was excluded by .vscodeignore)

## [0.2.7] - 2025-12-11

### Changed
- **UX improvement**: Save button disabled until user clicks "Connect"
- Renamed "Validate Connection" to "Connect" for clarity
- Connect button shows "✓ Connected" with green background on success
- Added helper text: "Then click Connect to load your organizations"
- Returning users see "✓ Connected" and enabled Save button immediately

## [0.2.6] - 2025-12-11

### Added
- "Initialize Workspace" button in Configure panel for first-time users
- Initialize Workspace now creates Cursor slash commands (/ace-help, /ace-status, /ace-search, /ace-configure, /ace-bootstrap, /ace-learn)
- Initialize Workspace now also creates Cursor rules file (.cursor/rules/ace-patterns.mdc)

### Fixed
- Initialize Workspace command now creates hooks, rules, AND slash commands

## [0.2.5] - 2025-12-11

### Fixed
- First-time users: org now properly added to dropdown after validation
- Save button now works correctly on initial setup

## [0.2.4] - 2025-12-11

### Added
- Beta notice with waitlist link at top of README

## [0.2.3] - 2025-12-11

### Fixed
- Learning Cycle diagram now uses markdown table (Mermaid not supported on OpenVSX)

## [0.2.2] - 2025-12-11

### Changed
- Learning Cycle diagram converted to interactive Mermaid flowchart
- Enhanced visual design with colored nodes and circular flow

## [0.2.1] - 2025-12-11

### Added
- Quick Start guide in README
- Webview Panels documentation (Configure & Status)
- Learning Cycle diagram showing how ACE works

### Changed
- Improved command descriptions with more detail
- Better organized configuration section in README

### Documentation
- Windows users: VSIX must be installed via Cursor, not Visual Studio
  (Use Ctrl+Shift+P → "Extensions: Install from VSIX...")

## [0.2.0] - 2025-12-11

### Changed
- Stronger rules directives with MANDATORY playbook retrieval
- Improved MCP integration and error handling
- Updated rule file structure for better Cursor compatibility

### Fixed
- Fixed rules file not being created on workspace initialization

## [0.1.0] - 2024-12-01

### Added
- Initial release
- MCP server registration with Cursor
- Cursor rules integration for automatic pattern retrieval
- Status panel showing playbook statistics
- Configure panel for server connection setup
- Commands: Initialize Workspace, Configure, Status, Search, Bootstrap, Learn
- Support for workspace-level and global configuration
- HTTP API integration with ACE server
