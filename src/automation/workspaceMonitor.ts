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
let promptedFolders: Set<string> = new Set(); // Track folders we've already prompted about
const CACHE_TTL_MS = 60000; // 1 minute cache

/**
 * Compare two workspace folders by URI (not object reference)
 * VSCode may create new folder objects, so we need to compare by URI
 */
function isSameFolder(a: vscode.WorkspaceFolder | undefined, b: vscode.WorkspaceFolder | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.uri.toString() === b.uri.toString();
}

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
			console.log(`[ACE] onDidChangeActiveTextEditor fired. isMultiRoot: ${isMultiRootWorkspace()}`);

			// Only monitor folder switches in multi-root workspaces
			if (!isMultiRootWorkspace()) {
				console.log('[ACE] Single-folder workspace - skipping folder switch detection');
				return;
			}

			const uri = editor?.document.uri;
			if (!uri) {
				console.log('[ACE] No document URI');
				return;
			}

			// Skip non-file schemes (output panels, git diffs, etc.)
			if (uri.scheme !== 'file') {
				console.log(`[ACE] Skipping non-file scheme: ${uri.scheme}`);
				return;
			}

			const folder = vscode.workspace.getWorkspaceFolder(uri);
			console.log(`[ACE] Editor folder: ${folder?.name}, Current folder: ${currentFolder?.name}`);

			if (folder && !isSameFolder(folder, currentFolder)) {
				console.log(`[ACE] Folder changed! Triggering onFolderSwitch`);
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
 * Also prompts to configure if folder is unconfigured (first time only)
 */
function initializeCurrentFolder(): void {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) return;

	console.log(`[ACE] Initializing workspace monitor. Folders: ${folders.length}, isMultiRoot: ${isMultiRootWorkspace()}`);

	// Try to get folder from active editor
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri && activeUri.scheme === 'file') {
		currentFolder = vscode.workspace.getWorkspaceFolder(activeUri);
	}

	// Fallback to first folder
	if (!currentFolder) {
		currentFolder = folders[0];
	}

	console.log(`[ACE] Current folder set to: ${currentFolder?.name}`);

	updateStatusBar();

	// For single-folder workspaces, prompt to configure if not configured
	// (Multi-root workspaces get prompted on folder switch instead)
	if (!isMultiRootWorkspace() && currentFolder) {
		const ctx = readContext(currentFolder);
		if (!ctx?.projectId) {
			// Delay prompt slightly to let extension fully activate
			setTimeout(() => {
				showConfigurePrompt(currentFolder!);
			}, 2000);
		}
	}
}

/**
 * Handle folder switch - update status bar and prompt if unconfigured
 */
function onFolderSwitch(folder: vscode.WorkspaceFolder): void {
	const previousFolder = currentFolder;
	currentFolder = folder;

	console.log(`[ACE] Folder switch: ${previousFolder?.name || 'none'} → ${folder.name}`);
	console.log(`[ACE] Folder URI: ${folder.uri.toString()}`);
	console.log(`[ACE] Folder fsPath: ${folder.uri.fsPath}`);

	updateStatusBar();

	// Check if folder is configured
	const ctx = readContext(folder);
	console.log(`[ACE] readContext result for "${folder.name}":`, JSON.stringify(ctx));

	if (!ctx?.projectId) {
		console.log(`[ACE] No projectId found - will show configure prompt`);
		showConfigurePrompt(folder);
	} else {
		console.log(`[ACE] Folder "${folder.name}" is configured with projectId: ${ctx.projectId}`);
	}
}

/**
 * Show configuration prompt for unconfigured folder
 * Tracks prompted folders to avoid repeated prompts in the same session
 * Uses warning message style to match VSCode extension
 */
function showConfigurePrompt(folder: vscode.WorkspaceFolder): void {
	const folderKey = folder.uri.toString();
	console.log(`[ACE] showConfigurePrompt called for "${folder.name}", folderKey: ${folderKey}`);
	console.log(`[ACE] Current promptedFolders:`, Array.from(promptedFolders));

	// Don't prompt twice for the same folder in one session
	if (promptedFolders.has(folderKey)) {
		console.log(`[ACE] Already prompted for folder "${folder.name}", skipping`);
		return;
	}
	promptedFolders.add(folderKey);

	console.log(`[ACE] Showing warning message for folder: ${folder.name}`);

	// Match VSCode style: warning message with "Configure Now" button
	vscode.window.showWarningMessage(
		`ACE not configured for "${folder.name}"`,
		'Configure Now',
		'Later'
	).then(selection => {
		console.log(`[ACE] User selection: ${selection}`);
		if (selection === 'Configure Now') {
			vscode.commands.executeCommand('ace.configure');
		}
	});
}

/**
 * Update status bar to reflect current folder's configuration state
 * Shows pattern count when available
 */
async function updateStatusBar(): Promise<void> {
	console.log('[ACE] updateStatusBar called', { hasStatusBarItem: !!statusBarItem, hasGetAceConfigFn: !!getAceConfigFn });
	if (!statusBarItem) return;

	// Always use currentFolder - works for both single-folder and multi-root workspaces
	const folder = currentFolder;
	const ctx = readContext(folder);
	console.log('[ACE] updateStatusBar context:', { folder: folder?.name, projectId: ctx?.projectId, orgId: ctx?.orgId });

	// Not configured - match VSCode style with warning background
	if (!ctx?.projectId) {
		statusBarItem.text = '$(warning) ACE: Not configured';
		statusBarItem.tooltip = folder
			? `"${folder.name}" - Click to view status and configure ACE`
			: 'Click to view status and configure ACE';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		statusBarItem.show();
		return;
	}

	// Clear any warning background from unconfigured state
	statusBarItem.backgroundColor = undefined;

	// Show loading state while fetching pattern count
	statusBarItem.text = '$(sync~spin) ACE: Loading...';
	statusBarItem.show();

	// Fetch pattern count
	const patternCount = await fetchPatternCount(ctx, folder);

	// Update with pattern count - match VSCode style: "ACE: {count} patterns"
	if (patternCount !== null) {
		statusBarItem.text = `$(book) ACE: ${patternCount} patterns`;
		statusBarItem.tooltip = 'Click to view ACE playbook status';
	} else {
		statusBarItem.text = '$(book) ACE: ? patterns';
		statusBarItem.tooltip = 'Click to view ACE playbook status';
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
	console.log('[ACE] fetchPatternCount: getting config', { hasGetAceConfigFn: !!getAceConfigFn });
	const config = getAceConfigFn ? getAceConfigFn(folder) : getAceConfigForPatterns(ctx);
	console.log('[ACE] fetchPatternCount: config result', {
		hasConfig: !!config,
		hasServerUrl: !!config?.serverUrl,
		hasApiToken: !!config?.apiToken,
		serverUrl: config?.serverUrl
	});
	if (!config?.serverUrl || !config?.apiToken) {
		console.log('[ACE] Pattern count: missing config - returning null');
		return null;
	}

	try {
		const url = `${config.serverUrl}/analytics`;
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
