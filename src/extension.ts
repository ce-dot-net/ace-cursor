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
import { readContext, readWorkspaceVersion, writeWorkspaceVersion, pickWorkspaceFolder, getTargetFolder, isMultiRootWorkspace, type AceContext } from './ace/context';
import { initWorkspaceMonitor, getCurrentFolder, refreshStatusBar } from './automation/workspaceMonitor';
import { runLoginCommand, logout, isAuthenticated, getTokenExpiration, handleAuthError, getValidToken, getHardCapInfo } from './commands/login';
import { AceClient, loadConfig, loadUserAuth, getDefaultOrgId } from '@ace-sdk/core';
import { showDevicesQuickPick } from './commands/devices';
import { getAceClient, clearQuotaWarningTracking, getLastUsageInfo, invalidateClient } from './ace/client';

let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

// Preloaded pattern info for status bar display
let preloadedPatternCount: number = 0;
let preloadedDomains: string[] = [];

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

/**
 * Preload pattern count on extension activation using /analytics API
 * Uses the same endpoint as the status page for consistent results
 */
async function preloadPatterns(): Promise<void> {
	try {
		// Use AceClient with quota callbacks for proper usage monitoring
		const client = getAceClient();
		if (!client) {
			console.log('[ACE] Preload skipped: no valid client (not configured or not authenticated)');
			return;
		}

		console.log('[ACE] Preload: fetching analytics via AceClient');

		// Use getStatus() which calls /analytics endpoint and triggers quota callbacks
		const analytics = await client.getStatus();
		console.log(`[ACE] Preload: analytics response - total_patterns=${analytics.total_patterns}, total_bullets=${analytics.total_bullets}`);

		// Use total_patterns first (same transformation as status page)
		preloadedPatternCount = analytics.total_patterns || analytics.total_bullets || 0;

		// Extract domains from by_domain
		const byDomain = analytics.by_domain || {};
		preloadedDomains = Object.keys(byDomain);

		console.log(`[ACE] Preloaded ${preloadedPatternCount} patterns from ${preloadedDomains.length} domains`);

		// Update status bar with pattern count
		if (statusBarItem && preloadedPatternCount > 0) {
			statusBarItem.text = `$(book) ACE: ${preloadedPatternCount} patterns`;
			statusBarItem.tooltip = `ACE Pattern Learning\n${preloadedPatternCount} patterns in playbook\nDomains: ${preloadedDomains.slice(0, 3).join(', ')}${preloadedDomains.length > 3 ? ` (+${preloadedDomains.length - 3} more)` : ''}\n\nClick for status`;
		}

		// Check for quota usage info from the client
		const usageInfo = getLastUsageInfo();
		if (usageInfo) {
			console.log(`[ACE] Usage info: ${usageInfo.plan} plan, status=${usageInfo.status}`);
		}
	} catch (error) {
		console.log('[ACE] Preload error:', error instanceof Error ? error.message : String(error));
		// Non-fatal: continue without preload
	}
}

// Export for external access (e.g., status panel)
export function getPreloadedPatternInfo(): { count: number; domains: string[] } {
	return { count: preloadedPatternCount, domains: preloadedDomains };
}

/**
 * Check auth status on activation and prompt for login if needed
 *
 * WARNING UX FIX (per GitHub issue):
 * - DON'T warn about access token expiration for active users (sliding window extends it!)
 * - ONLY warn about:
 *   1. 7-day hard cap approaching (absolute_expires_at)
 *   2. Refresh token expired (can't auto-recover)
 *   3. Not logged in at all
 */
async function checkAuthOnActivation(): Promise<void> {
	if (!isAuthenticated()) {
		// Not logged in - show gentle prompt (non-blocking)
		vscode.window.showInformationMessage(
			'ACE not configured. Login to enable pattern learning.',
			'Login'
		).then(action => {
			if (action === 'Login') {
				vscode.commands.executeCommand('ace.login');
			}
		});
		return;
	}

	// Check token expiration
	const expiration = getTokenExpiration();
	if (!expiration) return;

	// Check if refresh token expired (can't auto-recover)
	if (expiration.refreshExpires) {
		const refreshExpired = new Date(expiration.refreshExpires).getTime() < Date.now();
		if (refreshExpired) {
			vscode.window.showErrorMessage(
				'ACE session expired. Please login again.',
				'Login'
			).then(action => {
				if (action === 'Login') {
					vscode.commands.executeCommand('ace.login');
				}
			});
			return;
		}
	}

	// Check 7-day hard cap approaching (absolute_expires_at)
	// This is the absolute maximum session duration regardless of activity
	if (expiration.absoluteExpires) {
		const absoluteExpiresAt = new Date(expiration.absoluteExpires).getTime();
		const hoursUntilHardCap = (absoluteExpiresAt - Date.now()) / (1000 * 60 * 60);

		if (hoursUntilHardCap < 0) {
			// Already expired
			vscode.window.showErrorMessage(
				'ACE session hard limit reached. Please login again.',
				'Login'
			).then(action => {
				if (action === 'Login') {
					vscode.commands.executeCommand('ace.login');
				}
			});
			return;
		} else if (hoursUntilHardCap < 24) {
			// Approaching hard cap (within 24 hours)
			vscode.window.showWarningMessage(
				`ACE session hard limit in ${Math.round(hoursUntilHardCap)} hours. Must re-login after 7 days of continuous use.`,
				'Login Now'
			).then(action => {
				if (action === 'Login Now') {
					vscode.commands.executeCommand('ace.login');
				}
			});
		}
	}

	// DO NOT warn about access token expiration for active users!
	// Sliding window extends it on every use (48h extension per API call).
	// The SDK's ensureValidToken() handles auto-refresh transparently.
}

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

	// 1. Create status bar item FIRST so it always shows
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = '$(sync~spin) ACE';  // Initial text while loading
	statusBarItem.command = 'ace.status';
	statusBarItem.tooltip = 'Click to view ACE playbook status';
	context.subscriptions.push(statusBarItem);
	statusBarItem.show();
	console.log('[ACE] Status bar created and shown');

	try {
		// 2. Register MCP server with Cursor
		await registerMcpServer(context);

		// 3. Create Cursor hooks for learning backup
		await createCursorHooks();

		// 4. Create Cursor Rules file for AI instructions
		await createCursorRules();

		// 5. Initialize workspace monitor for real-time folder tracking
		console.log('[ACE] Initializing workspace monitor with getAceConfig');
		initWorkspaceMonitor(context, statusBarItem, getAceConfig);

		// 6. Check auth status and prompt for login if needed
		await checkAuthOnActivation();

		// 7. Preload patterns in background (non-blocking)
		// Uses ace_search with generic query to get pattern count + domains for status bar
		preloadPatterns().catch(err => {
			console.log('[ACE] Background preload failed (non-fatal):', err);
		});

		console.log('[ACE] Extension activated successfully');

		// 7. Check workspace version and prompt for update if needed
		await checkWorkspaceVersionAndPrompt(context);
	} catch (error) {
		console.error('[ACE] Activation error:', error);
		vscode.window.showErrorMessage(`ACE extension activation failed: ${error instanceof Error ? error.message : String(error)}`);
		// Show error state in status bar
		if (statusBarItem) {
			statusBarItem.text = '$(error) ACE: Error';
			statusBarItem.tooltip = `ACE activation failed: ${error instanceof Error ? error.message : String(error)}`;
			statusBarItem.show();
		}
	}

	// Register UI commands (manual fallbacks)
	context.subscriptions.push(
		vscode.commands.registerCommand('ace.login', runLoginCommand),
		vscode.commands.registerCommand('ace.logout', logout),
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
		}),
		vscode.commands.registerCommand('ace.devices', showDevicesQuickPick)
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
 * Initialize workspace files for a specific folder
 * Used by both auto-init and manual initialization
 * @param folder - Target workspace folder
 * @param version - Extension version to write
 * @param forceUpdate - If true, overwrite existing files
 */
async function initializeWorkspaceForFolder(
	folder: vscode.WorkspaceFolder,
	version: string,
	forceUpdate: boolean = false
): Promise<void> {
	const aceDir = vscode.Uri.joinPath(folder.uri, '.cursor', 'ace');
	try {
		await vscode.workspace.fs.createDirectory(aceDir);
	} catch {
		// Directory may already exist
	}
	await createCursorHooks(folder, forceUpdate);
	await createCursorRules(folder, forceUpdate);
	await createCursorCommands(folder, forceUpdate);
	writeWorkspaceVersion(version, folder);
}

/**
 * Check workspace version and auto-initialize or auto-update as needed
 *
 * UX Improvements (v0.2.48):
 * - FIRST INSTALL (no workspace version): Auto-initialize silently
 * - UPDATE (version mismatch): Auto-update and show non-blocking notification
 * - MATCH (versions equal): Do nothing
 *
 * For multi-root workspaces, handles each folder independently
 */
async function checkWorkspaceVersionAndPrompt(context: vscode.ExtensionContext): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const extensionVersion = getExtensionVersion(context);

	// Check each folder for ACE initialization
	for (const folder of workspaceFolders) {
		const workspaceVersion = readWorkspaceVersion(folder);
		const folderName = workspaceFolders.length > 1 ? ` for ${folder.name}` : '';

		if (!workspaceVersion) {
			// FIRST INSTALL: Auto-initialize silently
			console.log(`[ACE] First install detected${folderName}, auto-initializing...`);
			await initializeWorkspaceForFolder(folder, extensionVersion, false);
			vscode.window.showInformationMessage(`ACE initialized${folderName}`);
			continue;
		}

		if (workspaceVersion !== extensionVersion) {
			// UPDATE: Auto-update and show non-blocking notification
			console.log(`[ACE] Updating workspace${folderName} from v${workspaceVersion} to v${extensionVersion}`);
			await initializeWorkspaceForFolder(folder, extensionVersion, true); // forceUpdate=true
			vscode.window.showInformationMessage(`ACE updated to v${extensionVersion}${folderName}`);
		}
		// MATCH: Do nothing - workspace is up to date
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
 * @param folder - Target workspace folder
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
async function createCursorHooks(folder?: vscode.WorkspaceFolder, forceUpdate: boolean = false): Promise<void> {
	const targetFolder = folder || await getTargetFolder('Select folder for ACE hooks');
	if (!targetFolder) {
		return;
	}

	const workspaceRoot = targetFolder.uri.fsPath;
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
	let shouldWriteHooks = forceUpdate;  // Force update if version upgrade
	if (forceUpdate) {
		console.log('[ACE] Force updating hooks.json (version upgrade)');
	} else if (!fs.existsSync(hooksPath)) {
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

	// Create all hook scripts for the current platform (pass forceUpdate)
	if (isWindows) {
		createWindowsHookScripts(scriptsDir, forceUpdate);
	} else {
		createUnixHookScripts(scriptsDir, forceUpdate);
	}
}

/**
 * Create Windows PowerShell hook scripts for AI-Trail
 * @param scriptsDir - Directory to write scripts to
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
function createWindowsHookScripts(scriptsDir: string, forceUpdate: boolean = false): void {
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
	if (forceUpdate || !fs.existsSync(mcpTrackPath)) {
		fs.writeFileSync(mcpTrackPath, mcpTrackScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_mcp.ps1`);
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
	if (forceUpdate || !fs.existsSync(shellTrackPath)) {
		fs.writeFileSync(shellTrackPath, shellTrackScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_shell.ps1`);
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
	if (forceUpdate || !fs.existsSync(responseTrackPath)) {
		fs.writeFileSync(responseTrackPath, responseTrackScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_response.ps1`);
	}

	// File Edit Tracking with Domain Detection
	const editTrackPath = path.join(scriptsDir, 'ace_track_edit.ps1');
	const editTrackScript = `# ACE Edit Tracking Hook - Captures file edits with domain detection
# Input: file_path, edits[]
# Writes domain state to temp file for MCP Resources (Issue #3 fix)

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$inputJson | Out-File -Append -FilePath "$aceDir\\edit_trajectory.jsonl" -Encoding utf8

# Domain detection function
function Detect-Domain {
    param([string]$FilePath)
    switch -Regex ($FilePath) {
        '(auth|login|session|jwt)' { return 'auth' }
        '(api|routes|endpoint|controller)' { return 'api' }
        '(cache|redis|memo)' { return 'cache' }
        '(db|migration|model|schema)' { return 'database' }
        '(component|ui|view|\\.tsx|\\.jsx)' { return 'ui' }
        '(test|spec|mock)' { return 'test' }
        default { return 'general' }
    }
}

# Extract file path and detect domain
try {
    $data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
    $filePath = $data.file_path
    if (-not $filePath) { $filePath = $data.path }

    if ($filePath) {
        $currentDomain = Detect-Domain -FilePath $filePath
        $lastDomainFile = "$aceDir\\last_domain.txt"
        $lastDomain = if (Test-Path $lastDomainFile) { Get-Content $lastDomainFile } else { "" }

        if ($currentDomain -ne $lastDomain -and $lastDomain) {
            $shift = @{
                from = $lastDomain
                to = $currentDomain
                file = $filePath
                timestamp = (Get-Date -Format "o")
            } | ConvertTo-Json -Compress
            $shift | Out-File -Append -FilePath "$aceDir\\domain_shifts.log" -Encoding utf8
        }

        $currentDomain | Out-File -FilePath $lastDomainFile -Encoding utf8

        # Write domain state to temp file for MCP Resources
        # MCP server reads this to expose ace://domain/current resource
        $settingsPath = "$aceDir\\settings.json"
        $projectId = "default"
        if (Test-Path $settingsPath) {
            try {
                $settings = Get-Content $settingsPath | ConvertFrom-Json
                if ($settings.projectId) { $projectId = $settings.projectId }
            } catch {}
        }
        $md5 = [System.Security.Cryptography.MD5]::Create()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($projectId)
        $hash = [BitConverter]::ToString($md5.ComputeHash($bytes)).Replace("-","").Substring(0,8).ToLower()
        $tempFile = "$env:TEMP\\ace-domain-$hash.json"
        @{
            domain = $currentDomain
            file = $filePath
            timestamp = (Get-Date -Format "o")
        } | ConvertTo-Json | Out-File -FilePath $tempFile -Encoding utf8
    }
} catch {
    # Silently continue on parse errors
}
`;
	// Always update to get domain detection
	fs.writeFileSync(editTrackPath, editTrackScript);
	console.log('[ACE] Updated ace_track_edit.ps1 with MCP temp file');

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
 * @param scriptsDir - Directory to write scripts to
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
function createUnixHookScripts(scriptsDir: string, forceUpdate: boolean = false): void {
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
	if (forceUpdate || !fs.existsSync(mcpTrackPath)) {
		fs.writeFileSync(mcpTrackPath, mcpTrackScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_mcp.sh`);
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
	if (forceUpdate || !fs.existsSync(shellTrackPath)) {
		fs.writeFileSync(shellTrackPath, shellTrackScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_shell.sh`);
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
	if (forceUpdate || !fs.existsSync(responseTrackPath)) {
		fs.writeFileSync(responseTrackPath, responseTrackScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_response.sh`);
	}

	// File Edit Tracking with Domain Detection
	const editTrackPath = path.join(scriptsDir, 'ace_track_edit.sh');
	const editTrackScript = `#!/bin/bash
# ACE Edit Tracking Hook - Captures file edits with domain detection
# Input: file_path, edits[]
# Writes domain state to temp file for MCP Resources (Issue #3 fix)

input=$(cat)
mkdir -p .cursor/ace
echo "$input" >> .cursor/ace/edit_trajectory.jsonl

# Domain detection function
detect_domain() {
  local file_path="$1"
  case "$file_path" in
    */auth/*|*login*|*session*|*jwt*) echo "auth" ;;
    */api/*|*routes*|*endpoint*|*controller*) echo "api" ;;
    */cache/*|*redis*|*memo*) echo "cache" ;;
    */db/*|*migration*|*model*|*schema*) echo "database" ;;
    */component*|*/ui/*|*/view*|*.tsx|*.jsx) echo "ui" ;;
    */test*|*spec*|*mock*) echo "test" ;;
    *) echo "general" ;;
  esac
}

# Extract file path from input JSON
file_path=$(echo "$input" | jq -r '.file_path // .path // empty' 2>/dev/null)

if [ -n "$file_path" ]; then
  current_domain=$(detect_domain "$file_path")
  last_domain=$(cat .cursor/ace/last_domain.txt 2>/dev/null || echo "")

  # Log domain transition if changed
  if [ "$current_domain" != "$last_domain" ] && [ -n "$last_domain" ]; then
    echo "{\\"from\\": \\"$last_domain\\", \\"to\\": \\"$current_domain\\", \\"file\\": \\"$file_path\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> .cursor/ace/domain_shifts.log
  fi

  echo "$current_domain" > .cursor/ace/last_domain.txt

  # Write domain state to temp file for MCP Resources
  # MCP server reads this to expose ace://domain/current resource
  # Uses $TMPDIR (macOS) with fallback to /tmp (Linux)
  project_id=$(jq -r '.projectId // "default"' .cursor/ace/settings.json 2>/dev/null || echo "default")
  hash=$(echo -n "$project_id" | md5sum | cut -c1-8)
  temp_dir="\${TMPDIR:-/tmp}"
  temp_file="\${temp_dir%/}/ace-domain-\${hash}.json"
  echo "{\\"domain\\": \\"$current_domain\\", \\"file\\": \\"$file_path\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" > "$temp_file"
fi

exit 0
`;
	// Always update to get domain detection
	fs.writeFileSync(editTrackPath, editTrackScript, { mode: 0o755 });
	console.log('[ACE] Updated ace_track_edit.sh with domain detection');

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
 * @param folder - Target workspace folder
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
async function createCursorCommands(folder?: vscode.WorkspaceFolder, forceUpdate: boolean = false): Promise<void> {
	const targetFolder = folder || await getTargetFolder('Select folder for ACE commands');
	if (!targetFolder) {
		return;
	}

	const workspaceRoot = targetFolder.uri.fsPath;
	const commandsDir = path.join(workspaceRoot, '.cursor', 'commands');

	// Ensure commands directory exists
	if (!fs.existsSync(commandsDir)) {
		fs.mkdirSync(commandsDir, { recursive: true });
	}

	// Define all ACE slash commands
	const commands: Record<string, string> = {
		'ace-configure.md': `# ACE Configure

Configure your ACE server connection and project settings.

## Action Required

Tell the user to open the ACE configuration panel:

1. Press \`Cmd/Ctrl+Shift+P\` to open Command Palette
2. Type "ACE: Configure Connection"
3. Press Enter

This opens a panel where users can:
- Set server URL (Production or Localhost)
- Login with browser-based authentication
- View organization and project settings

**Note**: This requires a UI panel that you cannot open directly. Guide the user to use the Command Palette.`,

		'ace-status.md': `# ACE Status

Show ACE playbook statistics and pattern counts.

## Action Required

You have two options:

### Option 1: Use MCP Tool (Recommended)
Call the \`ace_status\` MCP tool to get status information:
\`\`\`
ace_status()
\`\`\`

### Option 2: Guide User to UI
Tell the user:
1. Click the ACE status bar item in the bottom-right corner, OR
2. Press \`Cmd/Ctrl+Shift+P\`, type "ACE: Show Status", press Enter

The status shows:
- Total patterns in playbook
- Average confidence score
- Patterns by section (strategies, snippets, pitfalls, APIs)
- Organization and project information`,

		'ace-search.md': `# ACE Search

Search for relevant patterns in your ACE playbook.

## Action Required

Use the \`ace_search\` MCP tool with the user's query:

\`\`\`
ace_search(query: "<user's search terms>")
\`\`\`

## Examples

If user types \`/ace-search authentication\`:
\`\`\`
ace_search(query: "authentication")
\`\`\`

If user types \`/ace-search error handling\`:
\`\`\`
ace_search(query: "error handling")
\`\`\`

The MCP tool will return matching patterns from the playbook that you can share with the user.`,

		'ace-bootstrap.md': `# ACE Bootstrap

Initialize your ACE playbook by extracting patterns from your existing codebase.

## Action Required

Use the \`ace_bootstrap\` MCP tool:

\`\`\`
ace_bootstrap(mode: "hybrid", thoroughness: "medium")
\`\`\`

## Parameters

- **mode**: "hybrid" (recommended), "local-files", "git-history", or "docs-only"
- **thoroughness**: "light", "medium" (recommended), or "deep"

## What This Does

1. Analyzes your codebase (docs, source files, git history)
2. Extracts patterns and best practices
3. Sends them to ACE server for processing
4. Initializes your playbook with learned patterns

The tool will stream progress updates as it analyzes your code.`,

		'ace-learn.md': `# ACE Learn

Capture learning from a completed task to improve future AI assistance.

## Action Required

Use the \`ace_learn\` MCP tool to capture what was learned:

\`\`\`
ace_learn(
  task: "Brief description of what was done",
  trajectory: "Key steps taken during the task",
  output: "Important lessons, patterns, or insights discovered",
  success: true
)
\`\`\`

## Example

After implementing a feature:
\`\`\`
ace_learn(
  task: "Implemented JWT authentication",
  trajectory: "1. Added auth middleware 2. Created login endpoint 3. Added token refresh",
  output: "Always use httpOnly cookies for refresh tokens. Access tokens should be short-lived (15min).",
  success: true
)
\`\`\`

## When to Use

- After completing a significant task
- When you discovered something important
- After fixing a tricky bug
- When a pattern worked well (or didn't)`,

		'ace-help.md': `# ACE Help

Available ACE commands and MCP tools.

## Slash Commands

- \`/ace-status\` - Show playbook statistics
- \`/ace-search <query>\` - Search for patterns
- \`/ace-configure\` - Configure ACE connection (opens UI)
- \`/ace-bootstrap\` - Initialize playbook from codebase
- \`/ace-learn\` - Capture learning from completed task
- \`/ace-help\` - Show this help

## MCP Tools (Use These Directly)

- \`ace_get_playbook()\` - Get all patterns (call BEFORE tasks)
- \`ace_search(query)\` - Search for specific patterns
- \`ace_learn(task, trajectory, output, success)\` - Capture learning (call AFTER tasks)
- \`ace_bootstrap(mode, thoroughness)\` - Initialize playbook
- \`ace_status()\` - Get playbook statistics

## Automatic Features

The MCP tools are designed for automatic invocation:
- **ace_get_playbook**: Called automatically before every task
- **ace_learn**: Called automatically after substantial work

## UI Commands (Command Palette)

Press \`Cmd/Ctrl+Shift+P\` and type "ACE" to see:
- ACE: Login / Logout
- ACE: Configure Connection
- ACE: Show Status
- ACE: Manage Devices`
	};

	// Write each command file (create if doesn't exist OR if force update)
	for (const [filename, content] of Object.entries(commands)) {
		const filePath = path.join(commandsDir, filename);
		if (forceUpdate || !fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, content);
			console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} slash command: ${filename}`);
		}
	}
}

/**
 * Create Cursor Rules file to instruct AI to use ACE tools
 * This is the "belt + suspenders" approach - rules ensure AI calls ACE tools
 * @param folder - Target workspace folder
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
async function createCursorRules(folder?: vscode.WorkspaceFolder, forceUpdate: boolean = false): Promise<void> {
	const targetFolder = folder || await getTargetFolder('Select folder for ACE rules');
	if (!targetFolder) {
		return;
	}

	const workspaceRoot = targetFolder.uri.fsPath;
	const rulesDir = path.join(workspaceRoot, '.cursor', 'rules');

	// Ensure rules directory exists
	if (!fs.existsSync(rulesDir)) {
		fs.mkdirSync(rulesDir, { recursive: true });
	}

	const rulesPath = path.join(rulesDir, 'ace-patterns.mdc');
	const rulesContent = `---
description: ACE Pattern Learning - MANDATORY pattern search EVERY SESSION
alwaysApply: true
---

# MANDATORY: ACE Pattern Search - EVERY SESSION

**CRITICAL INSTRUCTION - DO NOT SKIP**

## PER-SESSION REQUIREMENT

**On EVERY NEW CHAT SESSION, you MUST call \`ace_search\` FIRST.**

Do NOT assume you "already know" the patterns from a previous session.
Do NOT skip because patterns seem "familiar" or "unchanged".
EVERY session is a fresh context - patterns MUST be retrieved again.

## BEFORE ANY Implementation Task

**You MUST call \`ace_search\` MCP tool FIRST** before:
- Writing ANY code
- Implementing ANY feature
- Fixing ANY bug
- Making ANY architectural decision

## HOW TO USE ace_search

1. **Read the user's task/request**
2. **Call ace_search with the task as query:**
   \`\`\`
   ace_search(query="<user's task description>")
   \`\`\`
3. **Review returned patterns** (5-10 relevant ones)
4. **Apply patterns to implementation**

**Example:**
- User: "Implement JWT authentication"
- You call: \`ace_search(query="JWT authentication")\`
- Returns: 5-10 patterns about JWT, auth, tokens, security

**FAILURE TO CALL ace_search = INCOMPLETE TASK**

## WHY ace_search (NOT ace_get_playbook)?

- \`ace_search\` → Returns 5-10 RELEVANT patterns (semantic search)
- \`ace_get_playbook\` → Returns ALL 1000+ patterns (context explosion!)

Always prefer ace_search with user's task as query.

## WHY EVERY SESSION?

1. Your context resets between sessions - previous patterns are NOT retained
2. Playbook may have been updated since your last session
3. New patterns from other team members may be available
4. Caching ensures fast retrieval (RAM → SQLite → Server)

## AFTER Completing Substantial Work - SINGLE ace_learn Call

**Wait for the AI-Trail summary, THEN call \`ace_learn\` ONCE.**

Do NOT call ace_learn immediately after each implementation step.
Wait until you see the session summary with AI-Trail statistics:
\`\`\`
Session complete. AI-Trail: MCP:X Shell:Y Edits:Z Responses:W. Git: branch (hash).
\`\`\`

**THEN call ace_learn with the full context:**
\`\`\`
ace_learn(
  task="<what you accomplished>",
  trajectory=["<key steps>"],
  success=true,
  output="<lessons learned>",
  git={commit_hash: "<from AI-Trail>", branch: "<from AI-Trail>"}
)
\`\`\`

**WHY single call at end?**
- AI-Trail summary includes full execution statistics
- Git context (branch + commit hash) is available
- Avoids redundant captures
- More efficient server processing

## Available ACE MCP Tools

1. \`ace_search\` - **CALL FIRST** - Search patterns by query (5-10 relevant)
2. \`ace_list_domains\` - List available domains for filtering
3. \`ace_learn\` - **CALL AFTER** - Capture learning
4. \`ace_status\` - View playbook statistics
5. \`ace_get_playbook\` - Get ALL patterns (only for export/backup)
`;

	// Create if doesn't exist OR if force update requested (during version upgrade)
	if (forceUpdate || !fs.existsSync(rulesPath)) {
		fs.writeFileSync(rulesPath, rulesContent);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace-patterns.mdc rules file`);
	}

	// Create domain-aware search rule (Issue #3) - Updated for ace_list_domains (v0.2.30)
	const domainRulePath = path.join(rulesDir, 'ace-domain-search.md');
	const domainRuleContent = `---
description: Domain-aware ACE pattern search - discover and use actual domain names
alwaysApply: true
---

# Domain-Aware Pattern Search

## CRITICAL: Discover Domains First

**NEVER guess domain names** like "auth", "api", "test".
Server domains are SEMANTIC like "typescript-development-practices".

### Step 1: Call ace_list_domains

**BEFORE using domain filtering**, discover available domains:

\`\`\`
ace_list_domains()
→ Returns: {
    "domains": [
      { "name": "mcp-cli-testing-and-api-resilience", "count": 34 },
      { "name": "typescript-development-practices", "count": 27 },
      { "name": "cli-and-package-version-diagnostics", "count": 23 }
    ],
    "total_domains": 17,
    "total_patterns": 206
  }
\`\`\`

### Step 2: Match Domain to Task

Read domain names semantically to find the best match:

| Task Context | Look for domains containing |
|--------------|----------------------------|
| TypeScript code | "typescript", "development", "practices" |
| Testing work | "testing", "test", "resilience" |
| CLI/API work | "cli", "api", "config" |
| Debugging | "diagnostics", "troubleshooting" |

### Step 3: Use Actual Domain Names

\`\`\`
# CORRECT - use exact domain name from ace_list_domains
ace_search("testing patterns", allowed_domains=["mcp-cli-testing-and-api-resilience"])

# WRONG - hardcoded domain that doesn't exist on server
ace_search("testing patterns", allowed_domains=["test"])
\`\`\`

## Workflow

1. \`ace_list_domains()\` - See what domains exist
2. Pick relevant domain(s) based on task context
3. \`ace_search("query", allowed_domains=["picked-domain"])\`

## Why This Matters

Using non-existent domains returns 0 results. Always verify domain names exist first.
`;

	// Always update domain rule to get latest patterns
	fs.writeFileSync(domainRulePath, domainRuleContent);
	console.log('[ACE] Updated ace-domain-search.md rules file');

	// Create continuous search rule (v0.2.28) - Updated for ace_list_domains (v0.2.30)
	const continuousSearchRulePath = path.join(rulesDir, 'ace-continuous-search.md');
	const continuousSearchRuleContent = `---
description: Continuous pattern retrieval during extended work
alwaysApply: true
---

# Continuous Pattern Retrieval

## When to Re-Search Patterns

Call \`ace_search\` again during extended work sessions when:

1. **Extended work** - 5+ tool calls since last pattern retrieval
2. **Hitting errors** - Encountering issues not covered by current patterns
3. **New context** - Switching to different file type or codebase area
4. **Task shift** - Moving from one feature area to another

## Domain Filtering for Focused Results

For focused results, use domain filtering:

1. **First**: Call \`ace_list_domains()\` to see available domains
2. **Match**: Pick domain(s) that match your current task context
3. **Search**: Call \`ace_search("query", allowed_domains=["picked-domain"])\`

**IMPORTANT**: Domain names are semantic (e.g., "typescript-development-practices"),
not simple paths. Always use \`ace_list_domains\` to discover actual domain names.

## Example Workflow

1. Start task → \`ace_get_playbook()\` to retrieve all patterns
2. 5+ edits later → \`ace_search("error handling")\` for fresh patterns
3. Need focused results → \`ace_list_domains()\` then \`ace_search(..., allowed_domains=[...])\`
4. Task complete → \`ace_learn(...)\` to capture lessons
`;

	// Always update continuous search rule
	fs.writeFileSync(continuousSearchRulePath, continuousSearchRuleContent);
	console.log('[ACE] Updated ace-continuous-search.md rules file');
}

/**
 * Get ACE configuration from settings and config files
 * For multi-root workspaces, uses getCurrentFolder() if no folder specified
 * Note: Authentication is handled via @ace-sdk/core device login, not API tokens
 */
function getAceConfig(folder?: vscode.WorkspaceFolder): { serverUrl?: string; projectId?: string; orgId?: string } | null {
	console.log('[ACE] getAceConfig called', { folder: folder?.name });
	// Use provided folder, or get from workspace monitor (tracks active editor)
	const targetFolder = folder || getCurrentFolder();
	console.log('[ACE] getAceConfig targetFolder:', targetFolder?.name);

	// Try to read from VS Code settings first
	const config = vscode.workspace.getConfiguration('ace');
	const serverUrl = config.get<string>('serverUrl');
	const orgId = config.get<string>('orgId');
	const projectId = config.get<string>('projectId');

	// Try to read from context (workspace settings for the specific folder)
	const ctx = readContext(targetFolder);

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
	// User auth (device code flow) with auth.default_org_id and auth.organizations
	const finalOrgId = orgId || ctx?.orgId || Object.keys(globalConfig?.orgs || {})[0]
		|| globalConfig?.default_org_id
		|| globalConfig?.auth?.default_org_id
		|| globalConfig?.auth?.organizations?.[0]?.org_id;
	const finalProjectId = projectId || ctx?.projectId || globalConfig?.projectId;
	const finalServerUrl = serverUrl || globalConfig?.serverUrl || 'https://ace-api.code-engine.app';

	if (!finalProjectId) {
		console.log('[ACE] getAceConfig: no projectId, returning null');
		return null; // Not configured
	}

	const result = {
		serverUrl: finalServerUrl,
		projectId: finalProjectId,
		orgId: finalOrgId
	};
	console.log('[ACE] getAceConfig result:', {
		hasServerUrl: !!result.serverUrl,
		hasProjectId: !!result.projectId,
		serverUrl: result.serverUrl
	});
	return result;
}

/**
 * Update status bar - delegates to workspace monitor
 * @deprecated Use refreshStatusBar() from workspaceMonitor instead
 */
function updateStatusBar(): void {
	refreshStatusBar();
}

/**
 * Initialize workspace - creates .cursor/ace directory, hooks, and rules
 * For multi-root workspaces, prompts user to select a folder
 */
async function initializeWorkspace(): Promise<void> {
	const folder = await pickWorkspaceFolder('Select folder to initialize ACE');
	if (!folder) {
		vscode.window.showWarningMessage('No workspace folder selected.');
		return;
	}

	const aceDir = vscode.Uri.joinPath(folder.uri, '.cursor', 'ace');
	try {
		await vscode.workspace.fs.createDirectory(aceDir);
	} catch {
		// Directory may already exist
	}

	// Create hooks, rules, and slash commands for selected folder
	await createCursorHooks(folder);
	await createCursorRules(folder);
	await createCursorCommands(folder);

	// Re-register MCP server in case config changed
	await registerMcpServer(extensionContext);

	// Save workspace version to track future updates
	const extensionVersion = getExtensionVersion(extensionContext);
	writeWorkspaceVersion(extensionVersion, folder);

	const folderInfo = isMultiRootWorkspace() ? ` in "${folder.name}"` : '';
	vscode.window.showInformationMessage(
		`ACE workspace initialized${folderInfo} (v${extensionVersion})! Created: hooks, rules, slash commands (/ace-help, /ace-status, etc.)`
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
 * For multi-root workspaces, checks the selected folder
 */
async function runDiagnosticCommand(): Promise<void> {
	const diagnostics: string[] = [];
	const issues: string[] = [];
	const fixes: string[] = [];

	// Get target folder for diagnostics
	const targetFolder = await getTargetFolder('Select folder to diagnose');

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
	const aceConfig = getAceConfig(targetFolder);
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
		if (!aceConfig.projectId) {
			issues.push('⚠️ Project ID missing');
			diagnostics.push('  → Project ID: Missing');
			fixes.push('Set your project ID in ACE configuration');
		} else {
			diagnostics.push(`  → Project ID: ${aceConfig.projectId}`);
		}
	}

	// 3. Check rules file
	if (targetFolder) {
		const rulesPath = path.join(targetFolder.uri.fsPath, '.cursor', 'rules', 'ace-patterns.mdc');
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
	if (targetFolder) {
		const hooksPath = path.join(targetFolder.uri.fsPath, '.cursor', 'hooks.json');
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
	// Clear quota warning tracking on deactivation
	clearQuotaWarningTracking();
	// Invalidate all cached clients
	invalidateClient();
	// Cleanup is handled by disposables
}
