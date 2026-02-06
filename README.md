# ACE for Cursor

> 🔐 **Account Required** - This extension requires an ACE account to work.
>
> **[→ Sign up for ACE](https://ace-ai.app)** to create your account and start using ACE.
>
> 💬 **[→ Join our Slack Community](https://www.ace-ai.app/community)** for support, tips, and pattern sharing!
>
> Without an account, the extension cannot connect to the ACE server.

**Automatic Code Evolution** - Pattern learning for Cursor IDE via MCP.

By [Code Engine GmbH](https://ace-ai.app)

## Features

- 🔄 **Automatic pattern retrieval** before tasks via MCP
- 📚 **Learning capture** after substantial work
- 🔌 **Native MCP integration** with Cursor
- 📊 **Status bar** shows pattern count (e.g., "ACE: 257 patterns") and configuration state
- 📁 **Multi-root workspace support** - each folder gets its own ACE configuration
- 🔄 **Real-time folder monitoring** - status bar updates when switching folders
- 🔐 **Browser-based login** - secure device code authentication (no API tokens)
- 📱 **Device management** - manage your logged-in devices
- ⚙️ **Configure panel** for easy setup with logout support

## Quick Start

> **Step 1 is required** - The extension won't work without an ACE account!

1. **[Sign up for ACE](https://ace-ai.app)** - Create your account (required!)
2. **Install** from Cursor Extensions marketplace
3. **Open Command Palette** (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux)
4. **Run** `ACE: Initialize Workspace` - sets up MCP server and rules
5. **Run** `ACE: Configure Connection` - opens setup panel
6. **Click "Login with Browser"** - authenticates via your browser
7. **Select your organization and project**
8. **Start coding!** - AI automatically retrieves patterns before tasks

## Commands

| Command | Description |
|---------|-------------|
| **ACE: Login** | Login via browser-based device code authentication |
| **ACE: Logout** | Logout and clear authentication tokens |
| **ACE: Initialize Workspace** | Set up ACE in current workspace (creates `.cursor/` config files, registers MCP server) |
| **ACE: Configure Connection** | Opens webview panel to login, select organization/project, and manage settings |
| **ACE: Show Status** | Opens webview panel showing playbook statistics (pattern count, session expiry) |
| **ACE: Search Patterns** | Search learned patterns by keyword |
| **ACE: Bootstrap Playbook** | Initialize patterns from existing codebase (git history, docs) |
| **ACE: Capture Learning** | Manually trigger learning capture after work |
| **ACE: Manage Devices** | View and manage your logged-in devices |

## Webview Panels

### Configure Panel
Interactive setup wizard for:
- **Browser-based login** - Click "Login with Browser" to authenticate
- **Logout** - Click "Logout" to clear your session
- **Device management** - Click "Devices" to manage logged-in devices
- Selecting organization and project from your account
- Setting ACE server URL (advanced)

### Status Panel
Real-time dashboard showing:
- Total patterns in playbook
- Average confidence score
- Patterns by section (strategies, snippets, troubleshooting, APIs)
- Session expiry info (access token + 7-day hard cap)
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
- ACE account at [ace-ai.app](https://ace-ai.app)

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

- [ACE Website](https://ace-ai.app)
- [Documentation](https://ace-ai.app/docs)
- [Community & Support](https://www.ace-ai.app/community) - Join our Slack!
- [GitHub](https://github.com/ce-dot-net/ace-cursor)
- [Report Issues](https://github.com/ce-dot-net/ace-cursor/issues)

## License

MIT - Code Engine GmbH
