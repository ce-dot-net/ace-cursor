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
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { readContext, isMultiRootWorkspace } from '../ace/context';

// Import getAceConfig from extension - will be set via init
let getAceConfigFn: ((folder?: vscode.WorkspaceFolder) => { serverUrl?: string; projectId?: string; orgId?: string } | null) | undefined;

let currentFolder: vscode.WorkspaceFolder | undefined;
let currentDomain: string = 'general';
let statusBarItem: vscode.StatusBarItem;
let promptedFolders: Set<string> = new Set(); // Track folders we've already prompted about

/**
 * Domain detection based on file path patterns
 * Used for domain-aware pattern search (Issue #3)
 */
function detectDomain(filePath: string): string {
	const lowerPath = filePath.toLowerCase();

	// Auth domain
	if (/\/(auth|login|session|jwt|oauth|sso)\//.test(lowerPath) ||
		/(auth|login|session|jwt|oauth)/.test(path.basename(lowerPath))) {
		return 'auth';
	}

	// API domain
	if (/\/(api|routes|endpoint|controller|handler)\//.test(lowerPath) ||
		/(route|endpoint|controller|handler)/.test(path.basename(lowerPath))) {
		return 'api';
	}

	// Cache domain
	if (/\/(cache|redis|memo)\//.test(lowerPath) ||
		/(cache|redis|memo)/.test(path.basename(lowerPath))) {
		return 'cache';
	}

	// Database domain
	if (/\/(db|database|migration|model|schema|repository)\//.test(lowerPath) ||
		/(model|schema|migration|repository)/.test(path.basename(lowerPath))) {
		return 'database';
	}

	// UI domain
	if (/\/(component|ui|view|page|layout)\//.test(lowerPath) ||
		/\.(tsx|jsx)$/.test(lowerPath)) {
		return 'ui';
	}

	// Test domain
	if (/\/(test|spec|__tests__|__mocks__)\//.test(lowerPath) ||
		/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(lowerPath)) {
		return 'test';
	}

	return 'general';
}

/**
 * Log domain shift to trajectory file
 */
function logDomainShift(fromDomain: string, toDomain: string, filePath: string): void {
	const folder = currentFolder;
	if (!folder) return;

	const aceDir = path.join(folder.uri.fsPath, '.cursor', 'ace');
	const shiftLogPath = path.join(aceDir, 'domain_shifts.log');

	try {
		// Ensure directory exists
		if (!fs.existsSync(aceDir)) {
			fs.mkdirSync(aceDir, { recursive: true });
		}

		const entry = JSON.stringify({
			from: fromDomain,
			to: toDomain,
			file: filePath,
			timestamp: new Date().toISOString()
		});

		fs.appendFileSync(shiftLogPath, entry + '\n');
	} catch (err) {
		console.log('[ACE] Failed to log domain shift:', err);
	}
}

/**
 * Write domain state to temp file for MCP Resources
 * MCP server reads this to expose ace://domain/current resource
 */
function writeDomainStateForMcp(domain: string, filePath: string): void {
	const ctx = readContext(currentFolder);
	const projectId = ctx?.projectId || 'default';
	const hash = crypto.createHash('md5').update(projectId).digest('hex').slice(0, 8);
	const tempPath = path.join(os.tmpdir(), `ace-domain-${hash}.json`);

	try {
		fs.writeFileSync(tempPath, JSON.stringify({
			domain,
			file: filePath,
			timestamp: new Date().toISOString()
		}));
		console.log(`[ACE] Domain state written to ${tempPath}: ${domain}`);
	} catch (err) {
		console.log('[ACE] Failed to write domain state:', err);
	}
}

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
	getAceConfig?: (folder?: vscode.WorkspaceFolder) => { serverUrl?: string; projectId?: string; orgId?: string } | null
): void {
	statusBarItem = statusBar;
	getAceConfigFn = getAceConfig;

	// Track active editor's folder
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			// Log immediately to verify event fires
			const folders = vscode.workspace.workspaceFolders;
			const folderCount = folders?.length ?? 0;
			console.log(`[ACE] *** onDidChangeActiveTextEditor *** folders: ${folderCount}, editor: ${editor?.document.uri.fsPath?.split('/').pop() || 'none'}`);

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

			const filePath = uri.fsPath;
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			console.log(`[ACE] Editor folder: ${folder?.name}, Current folder: ${currentFolder?.name}, Same: ${isSameFolder(folder, currentFolder)}`);

			// Domain tracking - detect and log domain shifts
			const newDomain = detectDomain(filePath);
			if (newDomain !== currentDomain) {
				console.log(`[ACE] Domain shift: ${currentDomain} → ${newDomain} (${path.basename(filePath)})`);
				logDomainShift(currentDomain, newDomain, filePath);
				currentDomain = newDomain;
				writeDomainStateForMcp(newDomain, filePath);
			}

			// Check if folder changed - works for both single and multi-root workspaces
			if (folder && !isSameFolder(folder, currentFolder)) {
				console.log(`[ACE] *** FOLDER CHANGED *** ${currentFolder?.name || 'none'} → ${folder.name}`);
				onFolderSwitch(folder);
			}
		})
	);

	// Track workspace folder changes (add/remove)
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(e => {
			console.log(`[ACE] Workspace folders changed: added=${e.added.length}, removed=${e.removed.length}`);
			// Refresh status bar when folders change
			updateStatusBar();
			// Prompt for newly added unconfigured folders
			for (const added of e.added) {
				const ctx = readContext(added);
				if (!ctx?.projectId) {
					showConfigurePrompt(added);
				}
			}
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

	// Prompt to configure if current folder is unconfigured (works for both single and multi-root)
	if (currentFolder) {
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
 * Only skips if user explicitly chose "Later" for this specific folder
 * Uses warning message style to match VSCode extension
 */
function showConfigurePrompt(folder: vscode.WorkspaceFolder): void {
	const folderKey = folder.uri.toString();
	console.log(`[ACE] *** showConfigurePrompt *** folder: "${folder.name}"`);
	console.log(`[ACE] folderKey: ${folderKey}`);
	console.log(`[ACE] promptedFolders:`, Array.from(promptedFolders));

	// Only skip if user explicitly chose "Later" for this folder
	if (promptedFolders.has(folderKey)) {
		console.log(`[ACE] User previously chose "Later" for "${folder.name}", skipping prompt`);
		return;
	}

	console.log(`[ACE] *** SHOWING POPUP *** for folder: ${folder.name}`);

	// Match VSCode style: warning message with "Configure Now" button
	vscode.window.showWarningMessage(
		`ACE not configured for "${folder.name}"`,
		'Configure Now',
		'Later'
	).then(selection => {
		console.log(`[ACE] User selection for "${folder.name}": ${selection}`);
		if (selection === 'Configure Now') {
			vscode.commands.executeCommand('ace.configure');
		} else if (selection === 'Later') {
			// Only add to promptedFolders if user explicitly chose "Later"
			promptedFolders.add(folderKey);
			console.log(`[ACE] User chose Later - will not prompt again for "${folder.name}" this session`);
		}
		// If dismissed (no selection), we'll prompt again on next folder switch
	});
}

/**
 * Update status bar to reflect current folder's configuration state
 * Shows pattern count when available
 */
async function updateStatusBar(): Promise<void> {
	console.log('[ACE] updateStatusBar called', { hasStatusBarItem: !!statusBarItem, hasGetAceConfigFn: !!getAceConfigFn });
	if (!statusBarItem) {
		console.log('[ACE] updateStatusBar: No statusBarItem, returning');
		return;
	}

	try {
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

		// Don't overwrite status bar if preloadPatterns already set a pattern count
		// This avoids race condition where workspaceMonitor overwrites correct count
		const currentText = statusBarItem.text;
		if (currentText.includes('patterns')) {
			console.log('[ACE] updateStatusBar: status bar already has pattern count, not overwriting');
			return;
		}

		// Just show "Ready" state - let preloadPatterns handle pattern count
		// The actual count is available in the status page
		statusBarItem.text = '$(book) ACE: Ready';
		statusBarItem.tooltip = folder
			? `"${folder.name}" - Click to view ACE playbook status`
			: 'Click to view ACE playbook status';
		statusBarItem.show();
	} catch (err) {
		console.error('[ACE] updateStatusBar error:', err);
		// Show fallback status on error
		statusBarItem.text = '$(book) ACE: Ready';
		statusBarItem.show();
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
 * Get the current domain context
 * Used for domain-aware pattern search (Issue #3)
 */
export function getCurrentDomain(): string {
	return currentDomain;
}

/**
 * Manually trigger status bar update (e.g., after configuration changes)
 */
export function refreshStatusBar(): void {
	updateStatusBar();
}
