/**
 * Workspace Monitor - Real-time workspace folder monitoring
 *
 * Detects when user switches between workspace folders and:
 * - Updates status bar to show current folder's configuration state
 * - Shows pattern count in status bar
 * - Prompts to configure ACE if switching to unconfigured folder
 * - Tracks current folder for other modules to use
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readContext, isMultiRootWorkspace, type AceContext } from '../ace/context';

// Import getAceConfig from extension - will be set via init
let getAceConfigFn: ((folder?: vscode.WorkspaceFolder) => { serverUrl?: string; apiToken?: string; projectId?: string; orgId?: string } | null) | undefined;

let currentFolder: vscode.WorkspaceFolder | undefined;
let statusBarItem: vscode.StatusBarItem;
let patternCache: Map<string, { count: number; timestamp: number }> = new Map();
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Initialize workspace monitor with event listeners
 */
export function initWorkspaceMonitor(
	context: vscode.ExtensionContext,
	statusBar: vscode.StatusBarItem,
	getAceConfig?: (folder?: vscode.WorkspaceFolder) => { serverUrl?: string; apiToken?: string; projectId?: string; orgId?: string } | null
): void {
	statusBarItem = statusBar;
	getAceConfigFn = getAceConfig;

	// Track active editor's folder
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			// Only monitor in multi-root workspaces
			if (!isMultiRootWorkspace()) return;

			const uri = editor?.document.uri;
			if (!uri) return;

			// Skip non-file schemes (output panels, git diffs, etc.)
			if (uri.scheme !== 'file') return;

			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (folder && folder !== currentFolder) {
				onFolderSwitch(folder);
			}
		})
	);

	// Track workspace folder changes (add/remove)
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(_e => {
			// Refresh status bar when folders change
			updateStatusBar();
		})
	);

	// Initialize with current folder
	initializeCurrentFolder();
}

/**
 * Set initial folder from active editor or first workspace folder
 */
function initializeCurrentFolder(): void {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) return;

	// Try to get folder from active editor
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri && activeUri.scheme === 'file') {
		currentFolder = vscode.workspace.getWorkspaceFolder(activeUri);
	}

	// Fallback to first folder
	if (!currentFolder) {
		currentFolder = folders[0];
	}

	updateStatusBar();
}

/**
 * Handle folder switch - update status bar and prompt if unconfigured
 */
function onFolderSwitch(folder: vscode.WorkspaceFolder): void {
	const previousFolder = currentFolder;
	currentFolder = folder;

	console.log(`[ACE] Folder switch: ${previousFolder?.name || 'none'} → ${folder.name}`);

	updateStatusBar();

	// Check if folder is configured
	const ctx = readContext(folder);
	if (!ctx?.projectId) {
		showConfigurePrompt(folder);
	}
}

/**
 * Show configuration prompt for unconfigured folder
 */
function showConfigurePrompt(folder: vscode.WorkspaceFolder): void {
	vscode.window.showInformationMessage(
		`ACE is not configured for "${folder.name}". Configure now?`,
		'Configure',
		'Later'
	).then(selection => {
		if (selection === 'Configure') {
			vscode.commands.executeCommand('ace.configure');
		}
	});
}

/**
 * Update status bar to reflect current folder's configuration state
 * Shows pattern count when available
 */
async function updateStatusBar(): Promise<void> {
	if (!statusBarItem) return;

	const folder = isMultiRootWorkspace() ? currentFolder : undefined;
	const ctx = readContext(folder);

	// Not configured
	if (!ctx?.projectId) {
		const folderInfo = folder ? `: ${folder.name}` : '';
		statusBarItem.text = `$(warning) ACE${folderInfo}`;
		statusBarItem.tooltip = folder
			? `"${folder.name}" - Not configured. Click to configure.`
			: 'Click to configure ACE connection';
		statusBarItem.show();
		return;
	}

	// Show loading state while fetching pattern count
	const folderName = folder?.name;
	statusBarItem.text = folderName ? `$(sync~spin) ACE: ${folderName}` : '$(sync~spin) ACE';
	statusBarItem.show();

	// Fetch pattern count
	const patternCount = await fetchPatternCount(ctx, folder);

	// Update with pattern count
	if (patternCount !== null) {
		statusBarItem.text = folderName
			? `$(book) ACE: ${folderName} (${patternCount})`
			: `$(book) ACE (${patternCount})`;
		statusBarItem.tooltip = folderName
			? `"${folderName}" - ${patternCount} patterns. Click to view status.`
			: `${patternCount} patterns. Click to view status.`;
	} else {
		statusBarItem.text = folderName ? `$(book) ACE: ${folderName}` : '$(book) ACE: Ready';
		statusBarItem.tooltip = folderName
			? `"${folderName}" - Project: ${ctx.projectId}`
			: 'ACE MCP server active. Click to view status.';
	}
	statusBarItem.show();
}

/**
 * Fetch pattern count from ACE server with caching
 */
async function fetchPatternCount(ctx: AceContext, folder?: vscode.WorkspaceFolder): Promise<number | null> {
	const cacheKey = ctx.projectId;

	// Check cache
	const cached = patternCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.count;
	}

	// Get config for API call - use injected function or fallback
	const config = getAceConfigFn ? getAceConfigFn(folder) : getAceConfigForPatterns(ctx);
	if (!config?.serverUrl || !config?.apiToken) {
		console.log('[ACE] Pattern count: missing config', { hasServerUrl: !!config?.serverUrl, hasApiToken: !!config?.apiToken });
		return null;
	}

	try {
		const url = `${config.serverUrl}/api/v1/analytics`;
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${config.apiToken}`,
				'Content-Type': 'application/json',
				'X-ACE-Project': ctx.projectId
			}
		});

		if (!response.ok) {
			console.log(`[ACE] Pattern count API error: ${response.status} ${response.statusText}`);
			return null;
		}

		const data = await response.json() as { total_patterns?: number; total_bullets?: number };
		const count = data.total_patterns || data.total_bullets || 0;
		console.log(`[ACE] Pattern count fetched: ${count}`);

		// Cache the result
		patternCache.set(cacheKey, { count, timestamp: Date.now() });

		return count;
	} catch (err) {
		console.log('[ACE] Pattern count fetch error:', err);
		return null;
	}
}

/**
 * Get ACE config for pattern fetching
 */
function getAceConfigForPatterns(ctx: AceContext): { serverUrl?: string; apiToken?: string } | null {
	const globalConfigPath = path.join(os.homedir(), '.config', 'ace', 'config.json');

	if (!fs.existsSync(globalConfigPath)) {
		return null;
	}

	try {
		const config = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
		let apiToken = config.apiToken;

		// Get org-specific token if available
		if (ctx.orgId && config.orgs?.[ctx.orgId]?.apiToken) {
			apiToken = config.orgs[ctx.orgId].apiToken;
		}

		return {
			serverUrl: config.serverUrl || 'https://ace-api.code-engine.app',
			apiToken
		};
	} catch {
		return null;
	}
}

/**
 * Get the currently active workspace folder
 * Used by other modules to get folder context
 */
export function getCurrentFolder(): vscode.WorkspaceFolder | undefined {
	return currentFolder;
}

/**
 * Manually trigger status bar update (e.g., after configuration changes)
 */
export function refreshStatusBar(): void {
	updateStatusBar();
}
