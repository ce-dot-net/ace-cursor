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
 */
const getWorkspaceRoot = (): string | null => {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return null;
	}
	return workspaceFolders[0].uri.fsPath;
};

export const ensureSettingsDir = () => {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) return;
	
	const dir = path.join(workspaceRoot, '.cursor', 'ace');
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
};

export const readContext = (): AceContext | null => {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) return null;

	const SETTINGS_PATHS = [
		path.join(workspaceRoot, '.cursor', 'ace', 'settings.json'),
		path.join(workspaceRoot, '.claude', 'settings.json')
	];

	for (const candidate of SETTINGS_PATHS) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
			const orgId = data.orgId ?? data.env?.ACE_ORG_ID ?? data.env?.orgId;
			const projectId = data.projectId ?? data.env?.ACE_PROJECT_ID ?? data.env?.projectId;
			const aceWorkspaceVersion = data.aceWorkspaceVersion;
			if (projectId) {
				return { orgId, projectId, aceWorkspaceVersion };
			}
		} catch {
			continue;
		}
	}
	return null;
};

/**
 * Read workspace version only (without requiring projectId)
 */
export const readWorkspaceVersion = (): string | null => {
	const workspaceRoot = getWorkspaceRoot();
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
export const writeWorkspaceVersion = (version: string) => {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) return;

	ensureSettingsDir();
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

export const writeContext = (ctx: AceContext) => {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		throw new Error('No workspace folder found. Cannot write context.');
	}
	
	ensureSettingsDir();
	const target = path.join(workspaceRoot, '.cursor', 'ace', 'settings.json');
	const payload = {
		env: {
			ACE_ORG_ID: ctx.orgId,
			ACE_PROJECT_ID: ctx.projectId
		}
	};
	fs.writeFileSync(target, JSON.stringify(payload, null, 2));
};

