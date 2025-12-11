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
import { StatusPanel } from './webviews/statusPanel';
import { ConfigurePanel } from './webviews/configurePanel';
import { readContext, type AceContext } from './ace/context';

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
 * Create Cursor hooks for learning backup (belt + suspenders)
 * The stop hook sends a followup_message to remind AI to call ace_learn
 */
async function createCursorHooks(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const workspaceRoot = workspaceFolders[0].uri.fsPath;
	const cursorDir = path.join(workspaceRoot, '.cursor');
	const scriptsDir = path.join(cursorDir, 'scripts');

	// Ensure directories exist
	if (!fs.existsSync(cursorDir)) {
		fs.mkdirSync(cursorDir, { recursive: true });
	}
	if (!fs.existsSync(scriptsDir)) {
		fs.mkdirSync(scriptsDir, { recursive: true });
	}

	// Create hooks.json
	const hooksPath = path.join(cursorDir, 'hooks.json');
	const hooksConfig = {
		version: 1,
		hooks: {
			stop: [{
				command: '.cursor/scripts/ace_stop_hook.sh'
			}],
			afterFileEdit: [{
				command: '.cursor/scripts/ace_track_edit.sh'
			}]
		}
	};

	// Only create if doesn't exist (don't overwrite user customizations)
	if (!fs.existsSync(hooksPath)) {
		fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2));
		console.log('[ACE] Created hooks.json');
	}

	// Create stop hook script (learning reminder)
	const stopHookPath = path.join(scriptsDir, 'ace_stop_hook.sh');
	const stopHookScript = `#!/bin/bash
# ACE Stop Hook - Reminds AI to capture learning
# This hook fires when the AI session ends

input=$(cat)
status=$(echo "$input" | jq -r '.status // empty')
loop_count=$(echo "$input" | jq -r '.loop_count // 0')

# Only remind once (loop_count=0), and only on completed tasks
if [ "$status" = "completed" ] && [ "$loop_count" = "0" ]; then
  # Remind AI to call ace_learn if it didn't already
  echo '{"followup_message": "If you completed substantial work, please call the ace_learn MCP tool to capture valuable patterns for future use."}'
else
  echo '{}'
fi
`;

	if (!fs.existsSync(stopHookPath)) {
		fs.writeFileSync(stopHookPath, stopHookScript, { mode: 0o755 });
		console.log('[ACE] Created ace_stop_hook.sh');
	}

	// Create edit tracking hook script
	const trackEditPath = path.join(scriptsDir, 'ace_track_edit.sh');
	const trackEditScript = `#!/bin/bash
# ACE Edit Tracking Hook - Builds trajectory for learning
# This hook fires after each file edit

input=$(cat)

# Ensure ace directory exists
mkdir -p .cursor/ace

# Append to session trajectory file
echo "$input" >> .cursor/ace/session_trajectory.jsonl

exit 0
`;

	if (!fs.existsSync(trackEditPath)) {
		fs.writeFileSync(trackEditPath, trackEditScript, { mode: 0o755 });
		console.log('[ACE] Created ace_track_edit.sh');
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
	const globalConfigPath = path.join(process.env.HOME || '', '.config', 'ace', 'config.json');
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
 * Initialize workspace - creates .cursor/ace directory and hooks
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
		await createCursorHooks();
		vscode.window.showInformationMessage('ACE workspace initialized. MCP tools available in Cursor chat.');
	} catch (error) {
		await createCursorHooks();
		vscode.window.showInformationMessage('ACE hooks created. MCP tools available in Cursor chat.');
	}
}

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
