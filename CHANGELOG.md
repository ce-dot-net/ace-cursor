# Changelog

All notable changes to the "ACE for Cursor" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
