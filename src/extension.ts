/**
 * ACE for Cursor - Native Extension
 *
 * This extension registers the @ace-sdk/mcp server with Cursor's native MCP API.
 * The AI automatically invokes MCP tools based on their descriptions:
 * - ace_get_playbook: "ALWAYS call FIRST" - AI calls before every task
 * - ace_learn: "ALWAYS call AFTER" - AI calls after every substantial task
 *
 * No file watchers, no heuristics - the AI decides based on tool descriptions.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { StatusPanel } from './webviews/statusPanel';
import { ConfigurePanel } from './webviews/configurePanel';
import { readContext, readWorkspaceVersion, writeWorkspaceVersion, type AceContext } from './ace/context';

let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

// Cursor MCP API types (not in @types/vscode)
// These are injected at runtime by Cursor
interface CursorMcpApi {
	registerServer(config: {
		name: string;
		server: {
			command: string;
			args: string[];
			env?: Record<string, string>;
		};
	}): { dispose(): void };
}

interface CursorApi {
	mcp?: CursorMcpApi;
}

// Access Cursor API via vscode namespace extension
const getCursorApi = (): CursorApi | undefined => {
	return (vscode as any).cursor;
};

export async function activate(context: vscode.ExtensionContext) {
	console.log('[ACE] Extension activating...');
	extensionContext = context;

	// Suppress punycode deprecation warnings from dependencies
	const originalEmitWarning = process.emitWarning;
	process.emitWarning = function(warning: any, ...args: any[]) {
		if (typeof warning === 'object' && warning?.name === 'DeprecationWarning' &&
		    typeof warning?.message === 'string' && warning.message.includes('punycode')) {
			return;
		}
		return originalEmitWarning.call(process, warning, ...args);
	};

	try {
		// 1. Register MCP server with Cursor
		await registerMcpServer(context);

		// 2. Create Cursor hooks for learning backup
		await createCursorHooks();

		// 3. Create Cursor Rules file for AI instructions
		await createCursorRules();

		// 4. Create status bar item
		statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		statusBarItem.command = 'ace.status';
		statusBarItem.tooltip = 'Click to view ACE playbook status';
		context.subscriptions.push(statusBarItem);
		statusBarItem.show();

		// Update status bar on activation
		updateStatusBar();

		console.log('[ACE] Extension activated successfully');

		// 5. Check workspace version and prompt for update if needed
		await checkWorkspaceVersionAndPrompt(context);
	} catch (error) {
		console.error('[ACE] Activation error:', error);
		vscode.window.showErrorMessage(`ACE extension activation failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	// Register UI commands (manual fallbacks)
	context.subscriptions.push(
		vscode.commands.registerCommand('ace.initializeWorkspace', initializeWorkspace),
		vscode.commands.registerCommand('ace.configure', () => ConfigurePanel.createOrShow(context.extensionUri)),
		vscode.commands.registerCommand('ace.status', () => StatusPanel.createOrShow(context.extensionUri)),
		vscode.commands.registerCommand('ace.search', runSearchCommand),
		vscode.commands.registerCommand('ace.bootstrap', runBootstrapCommand),
		vscode.commands.registerCommand('ace.learn', runLearnCommand),
		vscode.commands.registerCommand('ace.diagnose', runDiagnosticCommand),
		vscode.commands.registerCommand('ace.taskStart', () => {
			vscode.window.showInformationMessage('ACE task tracking is now automatic via MCP. Just start working!');
		}),
		vscode.commands.registerCommand('ace.taskStop', () => {
			vscode.window.showInformationMessage('ACE learning is now automatic via MCP. The AI will capture lessons learned.');
		}),
		vscode.commands.registerCommand('ace.autoSearch', () => {
			vscode.window.showInformationMessage('ACE search is now automatic via MCP. The AI calls ace_get_playbook before every task.');
		})
	);
}

export function getExtensionContext(): vscode.ExtensionContext | undefined {
	return extensionContext;
}

/**
 * Get the current extension version from package.json
 */
function getExtensionVersion(context: vscode.ExtensionContext): string {
	try {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf-8')
		);
		return packageJson.version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * Check if workspace files need updating and prompt user
 */
async function checkWorkspaceVersionAndPrompt(context: vscode.ExtensionContext): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const extensionVersion = getExtensionVersion(context);
	const workspaceVersion = readWorkspaceVersion();

	// No workspace version means workspace was never initialized with ACE
	if (!workspaceVersion) {
		return; // Let them use Initialize Workspace manually
	}

	// Compare versions (simple string comparison, works for semver)
	if (workspaceVersion !== extensionVersion) {
		console.log(`[ACE] Workspace version (${workspaceVersion}) differs from extension version (${extensionVersion})`);

		const selection = await vscode.window.showInformationMessage(
			`ACE extension updated to v${extensionVersion}. Your workspace files (hooks, rules, commands) are from v${workspaceVersion}. Update now?`,
			'Update Workspace',
			'Remind Me Later',
			'Skip'
		);

		if (selection === 'Update Workspace') {
			await initializeWorkspace();
		} else if (selection === 'Skip') {
			// Write current version to skip future prompts for this version
			writeWorkspaceVersion(extensionVersion);
		}
		// 'Remind Me Later' does nothing - will prompt again next session
	}
}

/**
 * Register the @ace-sdk/mcp server with Cursor's native MCP API
 */
async function registerMcpServer(context: vscode.ExtensionContext): Promise<void> {
	// Check if Cursor MCP API is available
	const cursorApi = getCursorApi();
	if (!cursorApi?.mcp?.registerServer) {
		console.log('[ACE] Cursor MCP API not available - running in VS Code or older Cursor version');
		vscode.window.showWarningMessage(
			'ACE: Cursor MCP API not available. Automatic pattern retrieval and learning disabled. ' +
			'Use manual commands (ACE: Search, ACE: Learn) instead.'
		);
		return;
	}

	// Get ACE configuration
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		console.log('[ACE] No ACE configuration found - MCP server will use defaults');
	}

	// Build environment variables for MCP server
	const env: Record<string, string> = {};
	if (aceConfig?.serverUrl) env.ACE_SERVER_URL = aceConfig.serverUrl;
	if (aceConfig?.apiToken) env.ACE_API_TOKEN = aceConfig.apiToken;
	if (aceConfig?.projectId) env.ACE_PROJECT_ID = aceConfig.projectId;
	if (aceConfig?.orgId) env.ACE_ORG_ID = aceConfig.orgId;

	try {
		// Register the MCP server using Cursor's API
		// The @ace-sdk/mcp package is installed globally via npm
		const disposable = cursorApi.mcp.registerServer({
			name: 'ace-pattern-learning',
			server: {
				command: 'npx',
				args: ['@ace-sdk/mcp'],
				env
			}
		});

		context.subscriptions.push(disposable);
		console.log('[ACE] MCP server registered successfully');

		// Show success message
		vscode.window.showInformationMessage(
			'ACE MCP server registered! AI will automatically retrieve patterns and capture learning.'
		);
	} catch (error) {
		console.error('[ACE] Failed to register MCP server:', error);
		vscode.window.showErrorMessage(
			`ACE: Failed to register MCP server: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Create Cursor hooks for AI-Trail trajectory tracking
 * Full trajectory capture: MCP tools, shell commands, agent responses, file edits
 * Creates bash scripts on Unix, PowerShell scripts on Windows
 */
async function createCursorHooks(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	const cursorDir = path.join(workspaceRoot, '.cursor');
	const scriptsDir = path.join(cursorDir, 'scripts');
	const isWindows = process.platform === 'win32';

	// Ensure directories exist
	if (!fs.existsSync(cursorDir)) {
		fs.mkdirSync(cursorDir, { recursive: true });
	}
	if (!fs.existsSync(scriptsDir)) {
		fs.mkdirSync(scriptsDir, { recursive: true });
	}

	// Helper to get script command prefix for platform
	const scriptPrefix = isWindows ? 'powershell -ExecutionPolicy Bypass -File ' : '';
	const scriptExt = isWindows ? '.ps1' : '.sh';

	// Create hooks.json with FULL AI-Trail support
	const hooksPath = path.join(cursorDir, 'hooks.json');
	const hooksConfig = {
		version: 1,
		hooks: {
			// MCP tool execution tracking (PostToolUse equivalent)
			afterMCPExecution: [{
				command: `${scriptPrefix}.cursor/scripts/ace_track_mcp${scriptExt}`
			}],
			// Shell command tracking
			afterShellExecution: [{
				command: `${scriptPrefix}.cursor/scripts/ace_track_shell${scriptExt}`
			}],
			// Agent response tracking
			afterAgentResponse: [{
				command: `${scriptPrefix}.cursor/scripts/ace_track_response${scriptExt}`
			}],
			// File edit tracking (existing)
			afterFileEdit: [{
				command: `${scriptPrefix}.cursor/scripts/ace_track_edit${scriptExt}`
			}],
			// Stop hook with git context aggregation
			stop: [{
				command: `${scriptPrefix}.cursor/scripts/ace_stop_hook${scriptExt}`
			}]
		}
	};

	// Always update hooks.json to ensure all AI-Trail hooks are present
	let shouldWriteHooks = false;
	if (!fs.existsSync(hooksPath)) {
		shouldWriteHooks = true;
		console.log('[ACE] Creating hooks.json with AI-Trail support');
	} else {
		try {
			const existingHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
			// Check if AI-Trail hooks are missing
			const hasAllHooks = existingHooks?.hooks?.afterMCPExecution &&
			                    existingHooks?.hooks?.afterShellExecution &&
			                    existingHooks?.hooks?.afterAgentResponse;
			if (!hasAllHooks) {
				shouldWriteHooks = true;
				console.log('[ACE] Updating hooks.json with AI-Trail hooks');
			}
			// Also check platform compatibility
			const stopCmd = existingHooks?.hooks?.stop?.[0]?.command || '';
			if (isWindows && stopCmd.endsWith('.sh')) {
				shouldWriteHooks = true;
				console.log('[ACE] Updating hooks.json for Windows platform');
			}
			if (!isWindows && stopCmd.includes('.ps1')) {
				shouldWriteHooks = true;
				console.log('[ACE] Updating hooks.json for Unix platform');
			}
		} catch {
			shouldWriteHooks = true;
			console.log('[ACE] Recreating invalid hooks.json');
		}
	}

	if (shouldWriteHooks) {
		fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2));
		console.log('[ACE] hooks.json ready with AI-Trail support');
	}

	// Create all hook scripts for the current platform
	if (isWindows) {
		createWindowsHookScripts(scriptsDir);
	} else {
		createUnixHookScripts(scriptsDir);
	}
}

/**
 * Create Windows PowerShell hook scripts for AI-Trail
 */
function createWindowsHookScripts(scriptsDir: string): void {
	// MCP Execution Tracking (PostToolUse equivalent)
	const mcpTrackPath = path.join(scriptsDir, 'ace_track_mcp.ps1');
	const mcpTrackScript = `# ACE MCP Tracking Hook - Captures tool executions for AI-Trail
# Input: tool_name, tool_input, result_json, duration

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$input | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8
`;
	if (!fs.existsSync(mcpTrackPath)) {
		fs.writeFileSync(mcpTrackPath, mcpTrackScript);
		console.log('[ACE] Created ace_track_mcp.ps1');
	}

	// Shell Execution Tracking
	const shellTrackPath = path.join(scriptsDir, 'ace_track_shell.ps1');
	const shellTrackScript = `# ACE Shell Tracking Hook - Captures terminal commands for AI-Trail
# Input: command, output, duration

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$input | Out-File -Append -FilePath "$aceDir\\shell_trajectory.jsonl" -Encoding utf8
`;
	if (!fs.existsSync(shellTrackPath)) {
		fs.writeFileSync(shellTrackPath, shellTrackScript);
		console.log('[ACE] Created ace_track_shell.ps1');
	}

	// Agent Response Tracking
	const responseTrackPath = path.join(scriptsDir, 'ace_track_response.ps1');
	const responseTrackScript = `# ACE Response Tracking Hook - Captures agent responses for AI-Trail
# Input: text (assistant final text)

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$input | Out-File -Append -FilePath "$aceDir\\response_trajectory.jsonl" -Encoding utf8
`;
	if (!fs.existsSync(responseTrackPath)) {
		fs.writeFileSync(responseTrackPath, responseTrackScript);
		console.log('[ACE] Created ace_track_response.ps1');
	}

	// File Edit Tracking (existing, unchanged)
	const editTrackPath = path.join(scriptsDir, 'ace_track_edit.ps1');
	const editTrackScript = `# ACE Edit Tracking Hook - Captures file edits for AI-Trail
# Input: file_path, edits[]

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$input | Out-File -Append -FilePath "$aceDir\\edit_trajectory.jsonl" -Encoding utf8
`;
	if (!fs.existsSync(editTrackPath)) {
		fs.writeFileSync(editTrackPath, editTrackScript);
		console.log('[ACE] Created ace_track_edit.ps1');
	}

	// Stop Hook with Git Context Aggregation
	const stopHookPath = path.join(scriptsDir, 'ace_stop_hook.ps1');
	const stopHookScript = `# ACE Stop Hook - Aggregates AI-Trail trajectory with git context
# Input: status, loop_count

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
$status = $data.status
$loopCount = $data.loop_count

if ($status -eq "completed" -and $loopCount -eq 0) {
    # Capture git context
    $gitBranch = git rev-parse --abbrev-ref HEAD 2>$null
    if (-not $gitBranch) { $gitBranch = "unknown" }
    $gitHash = git rev-parse --short HEAD 2>$null
    if (-not $gitHash) { $gitHash = "unknown" }

    # Count trajectory entries
    $aceDir = ".cursor\\ace"
    $mcpCount = 0; $shellCount = 0; $editCount = 0; $responseCount = 0
    if (Test-Path "$aceDir\\mcp_trajectory.jsonl") {
        $mcpCount = (Get-Content "$aceDir\\mcp_trajectory.jsonl" | Measure-Object -Line).Lines
    }
    if (Test-Path "$aceDir\\shell_trajectory.jsonl") {
        $shellCount = (Get-Content "$aceDir\\shell_trajectory.jsonl" | Measure-Object -Line).Lines
    }
    if (Test-Path "$aceDir\\edit_trajectory.jsonl") {
        $editCount = (Get-Content "$aceDir\\edit_trajectory.jsonl" | Measure-Object -Line).Lines
    }
    if (Test-Path "$aceDir\\response_trajectory.jsonl") {
        $responseCount = (Get-Content "$aceDir\\response_trajectory.jsonl" | Measure-Object -Line).Lines
    }

    $summary = "MCP:$mcpCount Shell:$shellCount Edits:$editCount Responses:$responseCount"
    $msg = "Session complete. AI-Trail: $summary. Git: $gitBranch ($gitHash). Call ace_learn to capture patterns."
    Write-Output "{\`"followup_message\`": \`"$msg\`"}"
} else {
    Write-Output '{}'
}
`;
	// Always update stop hook to get git context feature
	fs.writeFileSync(stopHookPath, stopHookScript);
	console.log('[ACE] Updated ace_stop_hook.ps1 with git context');
}

/**
 * Create Unix bash hook scripts for AI-Trail
 */
function createUnixHookScripts(scriptsDir: string): void {
	// MCP Execution Tracking (PostToolUse equivalent)
	const mcpTrackPath = path.join(scriptsDir, 'ace_track_mcp.sh');
	const mcpTrackScript = `#!/bin/bash
# ACE MCP Tracking Hook - Captures tool executions for AI-Trail
# Input: tool_name, tool_input, result_json, duration

input=$(cat)
mkdir -p .cursor/ace
echo "$input" >> .cursor/ace/mcp_trajectory.jsonl
exit 0
`;
	if (!fs.existsSync(mcpTrackPath)) {
		fs.writeFileSync(mcpTrackPath, mcpTrackScript, { mode: 0o755 });
		console.log('[ACE] Created ace_track_mcp.sh');
	}

	// Shell Execution Tracking
	const shellTrackPath = path.join(scriptsDir, 'ace_track_shell.sh');
	const shellTrackScript = `#!/bin/bash
# ACE Shell Tracking Hook - Captures terminal commands for AI-Trail
# Input: command, output, duration

input=$(cat)
mkdir -p .cursor/ace
echo "$input" >> .cursor/ace/shell_trajectory.jsonl
exit 0
`;
	if (!fs.existsSync(shellTrackPath)) {
		fs.writeFileSync(shellTrackPath, shellTrackScript, { mode: 0o755 });
		console.log('[ACE] Created ace_track_shell.sh');
	}

	// Agent Response Tracking
	const responseTrackPath = path.join(scriptsDir, 'ace_track_response.sh');
	const responseTrackScript = `#!/bin/bash
# ACE Response Tracking Hook - Captures agent responses for AI-Trail
# Input: text (assistant final text)

input=$(cat)
mkdir -p .cursor/ace
echo "$input" >> .cursor/ace/response_trajectory.jsonl
exit 0
`;
	if (!fs.existsSync(responseTrackPath)) {
		fs.writeFileSync(responseTrackPath, responseTrackScript, { mode: 0o755 });
		console.log('[ACE] Created ace_track_response.sh');
	}

	// File Edit Tracking
	const editTrackPath = path.join(scriptsDir, 'ace_track_edit.sh');
	const editTrackScript = `#!/bin/bash
# ACE Edit Tracking Hook - Captures file edits for AI-Trail
# Input: file_path, edits[]

input=$(cat)
mkdir -p .cursor/ace
echo "$input" >> .cursor/ace/edit_trajectory.jsonl
exit 0
`;
	if (!fs.existsSync(editTrackPath)) {
		fs.writeFileSync(editTrackPath, editTrackScript, { mode: 0o755 });
		console.log('[ACE] Created ace_track_edit.sh');
	}

	// Stop Hook with Git Context Aggregation
	const stopHookPath = path.join(scriptsDir, 'ace_stop_hook.sh');
	const stopHookScript = `#!/bin/bash
# ACE Stop Hook - Aggregates AI-Trail trajectory with git context
# Input: status, loop_count

input=$(cat)
status=$(echo "$input" | jq -r '.status // empty')
loop_count=$(echo "$input" | jq -r '.loop_count // 0')

# Only process once on completed tasks
if [ "$status" = "completed" ] && [ "$loop_count" = "0" ]; then
  # Capture git context
  git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  git_hash=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

  # Count trajectory entries
  ace_dir=".cursor/ace"
  mcp_count=$(wc -l < "$ace_dir/mcp_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
  shell_count=$(wc -l < "$ace_dir/shell_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
  edit_count=$(wc -l < "$ace_dir/edit_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
  response_count=$(wc -l < "$ace_dir/response_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")

  # Build summary
  summary="MCP:$mcp_count Shell:$shell_count Edits:$edit_count Responses:$response_count"
  msg="Session complete. AI-Trail: $summary. Git: $git_branch ($git_hash). Call ace_learn to capture patterns."

  echo "{\\\"followup_message\\\": \\\"$msg\\\"}"
else
  echo '{}'
fi
`;
	// Always update stop hook to get git context feature
	fs.writeFileSync(stopHookPath, stopHookScript, { mode: 0o755 });
	console.log('[ACE] Updated ace_stop_hook.sh with git context');
}

/**
 * Create Cursor slash commands for ACE
 * These are .md files in .cursor/commands/ that become /ace-* commands in chat
 */
async function createCursorCommands(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	const commandsDir = path.join(workspaceRoot, '.cursor', 'commands');

	// Ensure commands directory exists
	if (!fs.existsSync(commandsDir)) {
		fs.mkdirSync(commandsDir, { recursive: true });
	}

	// Define all ACE slash commands
	const commands: Record<string, string> = {
		'ace-configure.md': `# ACE Configure

Configure your ACE server connection and project settings.

## What This Does

Opens a rich webview panel where you can:
- Set server URL (Production or Localhost)
- Enter API token securely
- Configure organization and project IDs
- Validate connection before saving

## How to Execute

**IMPORTANT**: You must execute the VS Code extension command \`ace.configure\` to open the configuration panel.

Use one of these methods:
1. **Command Palette**: Press \`Cmd/Ctrl+Shift+P\`, type "ACE: Configure", press Enter
2. **Extension API**: Call \`vscode.commands.executeCommand('ace.configure')\`

**First Time Setup**: Run this command after installing the extension to connect to your ACE server.

**Do not just display this text - you must actually execute the command to open the panel.**`,

		'ace-status.md': `# ACE Status

**EXECUTE COMMAND NOW**: \`vscode.commands.executeCommand('ace.status')\`

Show ACE playbook statistics and pattern counts.

## Action Required

**YOU MUST EXECUTE THIS COMMAND IMMEDIATELY** - Do not just display this text!

Execute: \`await vscode.commands.executeCommand('ace.status')\`

This opens the ACE Status webview panel showing:
- Total patterns in your playbook
- Average confidence score
- Patterns by section (strategies, snippets, pitfalls, APIs)
- Organization and project information

## Alternative Methods

If command execution fails:
1. **Command Palette**: Press \`Cmd/Ctrl+Shift+P\`, type "ACE: Show Status", press Enter
2. **Status Bar**: Click the ACE status bar item in the bottom-right corner

**CRITICAL**: Execute the command, don't just show this help text!`,

		'ace-search.md': `# ACE Search

Search for relevant patterns in your ACE playbook.

## Usage

\`\`\`
/ace-search <query>
\`\`\`

## Examples

\`\`\`
/ace-search authentication
/ace-search error handling
/ace-search database queries
\`\`\`

## How to Execute

**IMPORTANT**: You must execute the VS Code extension command \`ace.search\` to perform the search.

- **If a query is provided**: Execute \`vscode.commands.executeCommand('ace.search', query)\` with the query parameter
- **If no query**: Prompt the user for a search query, then execute \`vscode.commands.executeCommand('ace.search', userQuery)\`

**Alternative**: Use Command Palette (\`Cmd/Ctrl+Shift+P\`) → "ACE: Search Patterns"

This will search your playbook for patterns matching the query and display results.

**Do not just display this text - you must actually execute the command with the search query.**`,

		'ace-bootstrap.md': `# ACE Bootstrap

**🚀 EXECUTE IMMEDIATELY**: When user types \`/ace-bootstrap\`, you MUST immediately execute the command without asking.

## Action Required

**CRITICAL**: Execute this command NOW using:
\`\`\`typescript
await vscode.commands.executeCommand('ace.bootstrap')
\`\`\`

## What This Does

Extracts patterns from your existing code and creates an initial playbook. The command will:
1. Prompt user to select mode (hybrid, local-files, git-history, docs-only)
2. Prompt user to select thoroughness (light, medium, deep)
3. Analyze codebase (docs, source files, git history)
4. Stream progress updates in real-time
5. Send extracted patterns to ACE server
6. Initialize your playbook

## User Experience

The command shows a progress dialog with:
- "Analyzing codebase..."
- "Scanning documentation files..."
- "Analyzing source files..."
- "Analyzing git history..."
- Real-time bootstrap progress from ACE server

**DO NOT** just show this help text. **EXECUTE THE COMMAND IMMEDIATELY** when user types \`/ace-bootstrap\`.`,

		'ace-learn.md': `# ACE Learn

Manually capture learning from a completed task.

## What This Does

Starts the manual learning capture process. Use this when you want to explicitly record what you learned from a task, including:
- Task description
- Success/failure outcome
- Key lessons and insights

## How to Execute

**IMPORTANT**: You must execute the VS Code extension command \`ace.learn\` to start the learning capture.

Use one of these methods:
1. **Command Palette**: Press \`Cmd/Ctrl+Shift+P\`, type "ACE: Capture Learning", press Enter
2. **Extension API**: Call \`vscode.commands.executeCommand('ace.learn')\`

**Note**: ACE also automatically captures learning when tasks complete (if automation is enabled).

**Do not just display this text - you must actually execute the command.**`,

		'ace-help.md': `# ACE Help

Show all available ACE commands and usage.

**Action Required**: Display the following help information to the user.

**Available Commands**:
- \`/ace-status\` - Show playbook statistics (executes \`ace.status\`)
- \`/ace-search <query>\` - Search for patterns (executes \`ace.search\`)
- \`/ace-configure\` - Configure ACE connection (executes \`ace.configure\`)
- \`/ace-bootstrap\` - Initialize playbook from codebase (executes \`ace.bootstrap\`)
- \`/ace-learn\` - Manually capture learning (executes \`ace.learn\`)
- \`/ace-help\` - Show this help

**Automatic Features**:
- ✅ Auto-search: ACE automatically searches for patterns on every prompt
- ✅ Auto-learn: ACE automatically captures learning when tasks complete

**Note**: All commands execute corresponding VS Code extension commands. Use the Command Palette (\`Cmd/Ctrl+Shift+P\`) and type "ACE" to see all available commands.`
	};

	// Write each command file (only if doesn't exist)
	for (const [filename, content] of Object.entries(commands)) {
		const filePath = path.join(commandsDir, filename);
		if (!fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, content);
			console.log(`[ACE] Created slash command: ${filename}`);
		}
	}
}

/**
 * Create Cursor Rules file to instruct AI to use ACE tools
 * This is the "belt + suspenders" approach - rules ensure AI calls ACE tools
 */
async function createCursorRules(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	const rulesDir = path.join(workspaceRoot, '.cursor', 'rules');

	// Ensure rules directory exists
	if (!fs.existsSync(rulesDir)) {
		fs.mkdirSync(rulesDir, { recursive: true });
	}

	const rulesPath = path.join(rulesDir, 'ace-patterns.mdc');
	const rulesContent = `---
description: ACE Pattern Learning - MANDATORY playbook retrieval
alwaysApply: true
---

# MANDATORY: ACE Pattern Retrieval

**CRITICAL INSTRUCTION - DO NOT SKIP**

## BEFORE ANY Implementation Task

**You MUST call \`ace_get_playbook\` MCP tool FIRST** before:
- Writing ANY code
- Implementing ANY feature
- Fixing ANY bug
- Making ANY architectural decision

**FAILURE TO CALL ace_get_playbook = INCOMPLETE TASK**

This is NOT optional. Call the tool, review patterns, THEN proceed.

## AFTER Completing Substantial Work

**You MUST call \`ace_learn\` MCP tool** after:
- Successfully implementing features
- Fixing bugs (especially tricky ones)
- Discovering gotchas or edge cases

## Available ACE MCP Tools

1. \`ace_get_playbook\` - **CALL FIRST** - Get all learned patterns
2. \`ace_search\` - Search patterns by query
3. \`ace_learn\` - **CALL AFTER** - Capture learning
4. \`ace_status\` - View playbook statistics
`;

	// Only create if doesn't exist (don't overwrite user customizations)
	if (!fs.existsSync(rulesPath)) {
		fs.writeFileSync(rulesPath, rulesContent);
		console.log('[ACE] Created ace-patterns.mdc rules file');
	}
}

/**
 * Get ACE configuration from settings and config files
 */
function getAceConfig(): { serverUrl?: string; apiToken?: string; projectId?: string; orgId?: string } | null {
	// Try to read from VS Code settings first
	const config = vscode.workspace.getConfiguration('ace');
	const serverUrl = config.get<string>('serverUrl');
	const orgId = config.get<string>('orgId');
	const projectId = config.get<string>('projectId');

	// Try to read from context (workspace settings)
	const ctx = readContext();

	// Try to read from global config
	let globalConfig: any = null;
	const globalConfigPath = path.join(os.homedir(), '.config', 'ace', 'config.json');
	if (fs.existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
		} catch {
			// Ignore parse errors
		}
	}

	// Merge configs with priority: VS Code settings > workspace context > global config
	const finalOrgId = orgId || ctx?.orgId || Object.keys(globalConfig?.orgs || {})[0];
	const finalProjectId = projectId || ctx?.projectId || globalConfig?.projectId;
	const finalServerUrl = serverUrl || globalConfig?.serverUrl || 'https://ace-api.code-engine.app';

	// Get API token for the org
	let apiToken = globalConfig?.apiToken;
	if (finalOrgId && globalConfig?.orgs?.[finalOrgId]?.apiToken) {
		apiToken = globalConfig.orgs[finalOrgId].apiToken;
	}

	if (!finalProjectId) {
		return null; // Not configured
	}

	return {
		serverUrl: finalServerUrl,
		apiToken,
		projectId: finalProjectId,
		orgId: finalOrgId
	};
}

/**
 * Update status bar - shows configuration state
 * Pattern count is available via MCP tools (ace_status)
 */
function updateStatusBar(): void {
	const aceConfig = getAceConfig();
	if (!aceConfig || !aceConfig.serverUrl || !aceConfig.apiToken || !aceConfig.projectId) {
		statusBarItem.text = '$(warning) ACE: Not configured';
		statusBarItem.tooltip = 'Click to configure ACE connection';
	} else {
		statusBarItem.text = '$(book) ACE: Ready';
		statusBarItem.tooltip = 'ACE MCP server active. Click to view status.';
	}
	statusBarItem.show();
}

/**
 * Initialize workspace - creates .cursor/ace directory, hooks, and rules
 */
async function initializeWorkspace(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		vscode.window.showWarningMessage('No workspace folder open.');
		return;
	}

	const aceDir = vscode.Uri.joinPath(workspaceFolders[0].uri, '.cursor', 'ace');
	try {
		await vscode.workspace.fs.createDirectory(aceDir);
	} catch {
		// Directory may already exist
	}

	// Create hooks, rules, and slash commands
	await createCursorHooks();
	await createCursorRules();
	await createCursorCommands();

	// Re-register MCP server in case config changed
	await registerMcpServer(extensionContext);

	// Save workspace version to track future updates
	const extensionVersion = getExtensionVersion(extensionContext);
	writeWorkspaceVersion(extensionVersion);

	vscode.window.showInformationMessage(
		`ACE workspace initialized (v${extensionVersion})! Created: hooks, rules, slash commands (/ace-help, /ace-status, etc.)`
	);
}

// Export for use from configure panel
export { initializeWorkspace };

/**
 * Manual search command - redirects to MCP tool
 */
async function runSearchCommand(): Promise<void> {
	vscode.window.showInformationMessage(
		'ACE search is handled automatically via MCP. ' +
		'In Cursor chat, the AI calls ace_search or ace_get_playbook before tasks.'
	);
}

/**
 * Manual bootstrap command
 */
async function runBootstrapCommand(): Promise<void> {
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		vscode.window.showWarningMessage('ACE not configured. Run ACE: Configure Connection first.');
		return;
	}

	const mode = await vscode.window.showQuickPick(
		['hybrid (recommended)', 'docs-only', 'git-history', 'local-files'],
		{ placeHolder: 'Select bootstrap mode' }
	);

	if (!mode) return;

	vscode.window.showInformationMessage(`ACE bootstrap started in ${mode} mode. This may take a minute...`);

	// The actual bootstrap is handled by the MCP server
	// This is just a UI trigger - user should use MCP tool directly in chat
	vscode.window.showInformationMessage(
		'For best results, use the ace_bootstrap MCP tool directly in Cursor chat: ' +
		'"Please call ace_bootstrap to initialize patterns from this codebase"'
	);
}

/**
 * Manual learn command
 */
async function runLearnCommand(): Promise<void> {
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		vscode.window.showWarningMessage('ACE not configured. Run ACE: Configure Connection first.');
		return;
	}

	const task = await vscode.window.showInputBox({
		prompt: 'What task did you complete?',
		ignoreFocusOut: true
	});

	if (!task) return;

	const outcome = await vscode.window.showQuickPick(['Success', 'Failure'], {
		placeHolder: 'Was the task successful?'
	});

	if (!outcome) return;

	const lessons = await vscode.window.showInputBox({
		prompt: 'What were the key lessons learned?',
		ignoreFocusOut: true
	});

	// The actual learning is handled by the MCP server
	// This is just a UI trigger - user should use MCP tool directly in chat
	vscode.window.showInformationMessage(
		'For best results, use the ace_learn MCP tool directly in Cursor chat. ' +
		'The AI automatically captures learning after substantial tasks.'
	);
}

/**
 * Diagnostic command - checks why ACE search might not be triggering
 */
async function runDiagnosticCommand(): Promise<void> {
	const diagnostics: string[] = [];
	const issues: string[] = [];
	const fixes: string[] = [];

	// 1. Check Cursor MCP API availability
	const cursorApi = getCursorApi();
	if (!cursorApi?.mcp?.registerServer) {
		issues.push('❌ Cursor MCP API not available');
		diagnostics.push('• Cursor MCP API: NOT AVAILABLE');
		diagnostics.push('  → This extension requires Cursor (not VS Code)');
		diagnostics.push('  → Make sure you\'re running Cursor, not VS Code');
		fixes.push('Switch to Cursor IDE (this extension requires Cursor\'s native MCP API)');
	} else {
		diagnostics.push('✅ Cursor MCP API: Available');
	}

	// 2. Check configuration
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		issues.push('❌ ACE not configured');
		diagnostics.push('• Configuration: MISSING');
		diagnostics.push('  → No server URL, API token, or project ID found');
		fixes.push('Run "ACE: Configure Connection" to set up your ACE credentials');
	} else {
		diagnostics.push('✅ Configuration: Found');
		if (!aceConfig.serverUrl) {
			issues.push('⚠️ Server URL missing');
			diagnostics.push('  → Server URL: Missing');
		} else {
			diagnostics.push(`  → Server URL: ${aceConfig.serverUrl}`);
		}
		if (!aceConfig.apiToken) {
			issues.push('⚠️ API token missing');
			diagnostics.push('  → API Token: Missing');
			fixes.push('Add your API token in ACE configuration');
		} else {
			diagnostics.push(`  → API Token: ${aceConfig.apiToken.substring(0, 10)}...`);
		}
		if (!aceConfig.projectId) {
			issues.push('⚠️ Project ID missing');
			diagnostics.push('  → Project ID: Missing');
			fixes.push('Set your project ID in ACE configuration');
		} else {
			diagnostics.push(`  → Project ID: ${aceConfig.projectId}`);
		}
	}

	// 3. Check rules file
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const rulesPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'rules', 'ace-patterns.mdc');
		if (fs.existsSync(rulesPath)) {
			diagnostics.push('✅ Cursor Rules: Found');
			const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
			if (rulesContent.includes('ace_get_playbook')) {
				diagnostics.push('  → Rules mention ace_get_playbook');
			} else {
				issues.push('⚠️ Rules file missing ace_get_playbook reference');
			}
		} else {
			issues.push('⚠️ Cursor rules file not found');
			diagnostics.push('• Cursor Rules: NOT FOUND');
			fixes.push('Run "ACE: Initialize Workspace" to create rules file');
		}
	}

	// 4. Check hooks
	if (workspaceFolders && workspaceFolders.length > 0) {
		const hooksPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'hooks.json');
		if (fs.existsSync(hooksPath)) {
			diagnostics.push('✅ Cursor Hooks: Found');
		} else {
			diagnostics.push('⚠️ Cursor hooks not found (optional)');
		}
	}

	// 5. Check @ace-sdk/mcp package (note: npx will download if needed)
	diagnostics.push('ℹ️ @ace-sdk/mcp: Will be downloaded by npx if needed');
	diagnostics.push('  → MCP server uses: npx @ace-sdk/mcp');

	// Display results
	const message = [
		'=== ACE Diagnostic Report ===',
		'',
		...diagnostics,
		'',
		issues.length > 0 ? 'ISSUES FOUND:' : '✅ No critical issues found',
		...issues,
		'',
		fixes.length > 0 ? 'RECOMMENDED FIXES:' : '',
		...fixes,
		'',
		'NOTE: Even if everything is configured, the AI decides when to call MCP tools.',
		'Try explicitly asking: "Please call ace_get_playbook to retrieve patterns"',
		'',
		'For automatic triggering, ensure:',
		'1. MCP server is registered (requires Cursor, not VS Code)',
		'2. Configuration is complete (API token, project ID)',
		'3. Rules file exists (.cursor/rules/ace-patterns.mdc)',
		'4. The AI recognizes the task as requiring patterns'
	].join('\n');

	const outputChannel = vscode.window.createOutputChannel('ACE Diagnostic');
	outputChannel.appendLine(message);
	outputChannel.show();

	// Also show a summary
	if (issues.length > 0) {
		vscode.window.showWarningMessage(
			`ACE Diagnostic: Found ${issues.length} issue(s). Check output panel for details.`,
			'View Details'
		).then(selection => {
			if (selection === 'View Details') {
				outputChannel.show();
			}
		});
	} else {
		vscode.window.showInformationMessage(
			'ACE Diagnostic: No critical issues found. Check output panel for full report.'
		);
	}
}

export function deactivate() {
	// Cleanup is handled by disposables
}
