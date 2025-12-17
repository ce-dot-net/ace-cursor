import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type AceContext = {
	orgId?: string;
	projectId: string;
	aceWorkspaceVersion?: string;
};

/**
 * Get workspace root directory (absolute path)
 * If folder is provided, uses that folder. Otherwise:
 * - Single folder: returns that folder
 * - Multi-root without folder: returns null (caller should use pickWorkspaceFolder)
 */
export const getWorkspaceRoot = (folder?: vscode.WorkspaceFolder): string | null => {
	if (folder) return folder.uri.fsPath;

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return null;
	}
	// Single folder - safe to use [0]
	if (workspaceFolders.length === 1) {
		return workspaceFolders[0].uri.fsPath;
	}
	// Multi-root without folder param - return null
	return null;
};

/**
 * Pick a workspace folder - returns first if single, prompts if multi-root
 */
export async function pickWorkspaceFolder(
	placeHolder = 'Select a workspace folder'
): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) return undefined;
	if (folders.length === 1) return folders[0];

	// Multi-root: show native picker
	return vscode.window.showWorkspaceFolderPick({ placeHolder });
}

/**
 * Get folder from active editor context, or prompt if needed
 */
export async function getTargetFolder(
	promptMessage = 'Select folder for ACE operation'
): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) return undefined;
	if (folders.length === 1) return folders[0];

	// Try active editor
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri) {
		const folder = vscode.workspace.getWorkspaceFolder(activeUri);
		if (folder) return folder;
	}

	// Fallback to picker
	return pickWorkspaceFolder(promptMessage);
}

/**
 * Check if we're in a multi-root workspace
 */
export function isMultiRootWorkspace(): boolean {
	const folders = vscode.workspace.workspaceFolders;
	return (folders?.length ?? 0) > 1;
}

export const ensureSettingsDir = (folder?: vscode.WorkspaceFolder) => {
	const workspaceRoot = getWorkspaceRoot(folder);
	if (!workspaceRoot) return;

	const dir = path.join(workspaceRoot, '.cursor', 'ace');
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
};

export const readContext = (folder?: vscode.WorkspaceFolder): AceContext | null => {
	const workspaceRoot = getWorkspaceRoot(folder);
	console.log(`[ACE] readContext: folder=${folder?.name}, workspaceRoot=${workspaceRoot}`);
	if (!workspaceRoot) {
		console.log(`[ACE] readContext: no workspaceRoot, returning null`);
		return null;
	}

	const SETTINGS_PATHS = [
		path.join(workspaceRoot, '.cursor', 'ace', 'settings.json'),
		path.join(workspaceRoot, '.claude', 'settings.json')
	];

	for (const candidate of SETTINGS_PATHS) {
		const exists = fs.existsSync(candidate);
		console.log(`[ACE] readContext: checking ${candidate}, exists=${exists}`);
		if (!exists) continue;
		try {
			const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
			console.log(`[ACE] readContext: parsed data from ${candidate}:`, JSON.stringify(data));
			const orgId = data.orgId ?? data.env?.ACE_ORG_ID ?? data.env?.orgId;
			const projectId = data.projectId ?? data.env?.ACE_PROJECT_ID ?? data.env?.projectId;
			const aceWorkspaceVersion = data.aceWorkspaceVersion;
			console.log(`[ACE] readContext: extracted orgId=${orgId}, projectId=${projectId}`);
			if (projectId) {
				return { orgId, projectId, aceWorkspaceVersion };
			}
		} catch (err) {
			console.log(`[ACE] readContext: error parsing ${candidate}:`, err);
			continue;
		}
	}
	console.log(`[ACE] readContext: no valid settings found, returning null`);
	return null;
};

/**
 * Read workspace version only (without requiring projectId)
 */
export const readWorkspaceVersion = (folder?: vscode.WorkspaceFolder): string | null => {
	const workspaceRoot = getWorkspaceRoot(folder);
	if (!workspaceRoot) return null;

	const settingsPath = path.join(workspaceRoot, '.cursor', 'ace', 'settings.json');
	if (!fs.existsSync(settingsPath)) return null;

	try {
		const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
		return data.aceWorkspaceVersion || null;
	} catch {
		return null;
	}
};

/**
 * Write workspace version to settings
 */
export const writeWorkspaceVersion = (version: string, folder?: vscode.WorkspaceFolder) => {
	const workspaceRoot = getWorkspaceRoot(folder);
	if (!workspaceRoot) return;

	ensureSettingsDir(folder);
	const settingsPath = path.join(workspaceRoot, '.cursor', 'ace', 'settings.json');

	let data: Record<string, any> = {};
	if (fs.existsSync(settingsPath)) {
		try {
			data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
		} catch {
			// Start fresh if invalid
		}
	}

	data.aceWorkspaceVersion = version;
	fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
};

export const writeContext = (ctx: AceContext, folder?: vscode.WorkspaceFolder) => {
	const workspaceRoot = getWorkspaceRoot(folder);
	if (!workspaceRoot) {
		throw new Error('No workspace folder found. Cannot write context.');
	}

	ensureSettingsDir(folder);
	const target = path.join(workspaceRoot, '.cursor', 'ace', 'settings.json');
	const payload = {
		env: {
			ACE_ORG_ID: ctx.orgId,
			ACE_PROJECT_ID: ctx.projectId
		}
	};
	fs.writeFileSync(target, JSON.stringify(payload, null, 2));
};
