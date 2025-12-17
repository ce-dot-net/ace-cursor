# ACE for Cursor

> 🔐 **CLOSED BETA** - This extension requires an ACE account to work.
>
> **[→ Join the Waitlist](https://ace.code-engine.app/waitlist)** to get your API token and start using ACE.
>
> Without an account, the extension cannot connect to the ACE server.

**Automatic Code Evolution** - Pattern learning for Cursor IDE via MCP.

By [Code Engine GmbH](https://ace.code-engine.app)

## Features

- 🔄 **Automatic pattern retrieval** before tasks via MCP
- 📚 **Learning capture** after substantial work
- 🔌 **Native MCP integration** with Cursor
- 📊 **Status bar** shows pattern count (e.g., "ACE (257)") and configuration state
- 📁 **Multi-root workspace support** - each folder gets its own ACE configuration
- 🔄 **Real-time folder monitoring** - status bar updates when switching folders
- ⚙️ **Configure panel** for easy setup

## Quick Start

> **Step 1 is required** - The extension won't work without an ACE account!

1. **[Sign up for ACE](https://ace.code-engine.app/waitlist)** - Get your API token (required!)
2. **Install** from Cursor Extensions marketplace
3. **Open Command Palette** (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux)
4. **Run** `ACE: Initialize Workspace` - sets up MCP server and rules
5. **Run** `ACE: Configure Connection` - opens setup panel
6. **Enter your API token** and select your project
7. **Start coding!** - AI automatically retrieves patterns before tasks

## Commands

| Command | Description |
|---------|-------------|
| **ACE: Initialize Workspace** | Set up ACE in current workspace (creates `.cursor/` config files, registers MCP server) |
| **ACE: Configure Connection** | Opens webview panel to configure server URL, API token, and select project |
| **ACE: Show Status** | Opens webview panel showing playbook statistics (pattern count, confidence scores) |
| **ACE: Search Patterns** | Search learned patterns by keyword |
| **ACE: Bootstrap Playbook** | Initialize patterns from existing codebase (git history, docs) |
| **ACE: Capture Learning** | Manually trigger learning capture after work |

## Webview Panels

### Configure Panel
Interactive setup wizard for:
- Setting ACE server URL
- Entering API token
- Selecting organization and project
- Testing connection
- Link to create new projects at [ace.code-engine.app](https://ace.code-engine.app)

### Status Panel
Real-time dashboard showing:
- Total patterns in playbook
- Average confidence score
- Patterns by section (strategies, snippets, troubleshooting, APIs)
- Connection status

## How It Works

ACE registers an MCP server with Cursor. The AI automatically:

1. Calls `ace_get_playbook` **before** tasks to retrieve learned patterns
2. Calls `ace_learn` **after** substantial work to capture new patterns

This creates a self-improving learning cycle where each session benefits from previous work.

### The Learning Cycle

| Step | Action | Description |
|:----:|--------|-------------|
| 🚀 | **Start Task** | You begin work in Cursor |
| ⬇️ | | |
| 📖 | **Retrieve Patterns** | AI calls `ace_get_playbook` → Fetches learned strategies |
| ⬇️ | | |
| ⚡ | **Execute** | AI completes task using patterns |
| ⬇️ | | |
| 💡 | **Capture Learning** | AI calls `ace_learn` → Playbook grows smarter |
| ⬇️ | | |
| 🔄 | **Next Session** | Enhanced patterns available → Back to Start! |

## Requirements

- Cursor IDE (v0.44+)
- ACE account at [ace.code-engine.app](https://ace.code-engine.app)
- API token from the ACE dashboard

## Configuration

### Workspace Settings
Stored in `.cursor/ace/settings.json`:
- `orgId` - Your ACE organization ID
- `projectId` - Your ACE project ID

### Global Settings
Configure in Cursor Settings (`Cmd+,`):
- `ace.serverUrl` - ACE server endpoint (default: https://ace-api.code-engine.app)
- `ace.orgId` - Default organization ID
- `ace.projectId` - Default project ID

## Multi-Root Workspace Support

ACE fully supports VS Code multi-root workspaces:

- **Per-folder configuration**: Each folder in a multi-root workspace can have its own ACE project
- **Automatic detection**: Status bar updates when you switch between folders
- **Configuration prompts**: Shows popup when switching to an unconfigured folder
- **Initialize per folder**: `ACE: Initialize Workspace` lets you select which folder to configure

### Status Bar

The status bar shows (matches VSCode extension styling):
- **Ready**: `$(book) ACE: 257 patterns` - configured and showing pattern count
- **Loading**: `$(sync~spin) ACE: Loading...` - fetching pattern count
- **Unconfigured**: `$(warning) ACE: Not configured` - with warning background color

Click the status bar item to open the Status panel.

## Links

- [ACE Website](https://ace.code-engine.app)
- [Documentation](https://ace.code-engine.app/docs)
- [GitHub](https://github.com/ce-dot-net/ace-cursor)
- [Report Issues](https://github.com/ce-dot-net/ace-cursor/issues)

## License

MIT - Code Engine GmbH
