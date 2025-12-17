# Changelog

All notable changes to the "ACE for Cursor" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
