/**
 * ACE Configuration Panel - Configure server connection
 * Uses @ace-sdk/core for auth and config management
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ensureSettingsDir, writeContext, pickWorkspaceFolder, isMultiRootWorkspace, readContext } from '../ace/context';
import { runLoginCommand } from '../commands/login';
import {
	listProjects,
	isAuthenticated,
	loadUserAuth,
	getDefaultOrgId,
	loadConfig,
	logout,
	refreshOrganizations
} from '@ace-sdk/core';

export class ConfigurePanel {
	public static currentPanel: ConfigurePanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;
		this._update();

		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'save':
						this._saveConfiguration(message.data);
						return;
					case 'executeCommand':
						if (message.commandId) {
							vscode.commands.executeCommand(message.commandId, ...(message.args || []));
						}
						return;
					case 'initializeWorkspace':
						vscode.commands.executeCommand('ace.initializeWorkspace');
						return;
				case 'login':
					this._handleLogin();
					return;
				case 'logout':
					this._handleLogout();
					return;
				case 'fetchProjects':
					this._fetchProjectsForOrg(message.serverUrl, message.orgId);
					return;
				case 'close':
						this._panel.dispose();
						return;
				}
			},
			null,
			this._disposables
		);

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
	}

	public static createOrShow(extensionUri: vscode.Uri) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (ConfigurePanel.currentPanel) {
			ConfigurePanel.currentPanel._panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'aceConfigure',
			'ACE Configuration',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri]
			}
		);

		ConfigurePanel.currentPanel = new ConfigurePanel(panel, extensionUri);
	}

	public dispose() {
		ConfigurePanel.currentPanel = undefined;
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private _update() {
		const existingConfig = this._loadExistingConfig();
		this._panel.webview.html = this._getConfigureHtml(existingConfig);
	}

	/**
	 * Load existing configuration from global config file
	 */
	private _loadExistingConfig(): {
		serverUrl?: string;
		orgId?: string;
		projectId?: string;
		orgs?: Record<string, { orgName: string; projects: Array<string | { project_id: string; project_name?: string }> }>;
		auth?: {
			isLoggedIn: boolean;
			email?: string;
			organizations?: Array<{ org_id: string; name?: string; role?: string }>;
			expiresAt?: string;
			refreshExpiresAt?: string;
			absoluteExpiresAt?: string;
		};
	} | null {
		try {
			// Use SDK to load config - handles all the path resolution
			const config = loadConfig();
			const userAuth = loadUserAuth();

			// Load workspace context
			const ctx = readContext();

			// Build orgs map from user auth organizations
			const orgs: Record<string, { orgName: string; projects: Array<string | { project_id: string; project_name?: string }> }> = {};

			// Add orgs from legacy config.orgs if any
			if ((config as any)?.orgs) {
				for (const [orgId, orgData] of Object.entries((config as any).orgs as Record<string, any>)) {
					orgs[orgId] = {
						orgName: orgData.orgName || orgId,
						projects: orgData.projects || []
					};
				}
			}

			// Add orgs from user auth (device code flow) - SDK provides this
			if (userAuth?.organizations) {
				for (const org of userAuth.organizations) {
					if (org.org_id && !orgs[org.org_id]) {
						orgs[org.org_id] = {
							orgName: org.name || org.org_id,
							projects: [] // Projects fetched on demand
						};
					}
				}
			}

			// Use SDK functions to check auth status
			const isLoggedIn = isAuthenticated();
			const defaultOrgId = getDefaultOrgId();

			const result = {
				serverUrl: config?.serverUrl,
				orgId: ctx?.orgId || defaultOrgId || Object.keys(orgs)[0],
				projectId: ctx?.projectId || config?.projectId,
				orgs,
				auth: isLoggedIn ? {
					isLoggedIn: true,
					email: userAuth?.email,
					organizations: userAuth?.organizations,
					expiresAt: userAuth?.expires_at,
					refreshExpiresAt: userAuth?.refresh_expires_at,
					absoluteExpiresAt: userAuth?.absolute_expires_at
				} : undefined
			};

			console.log('[ACE] _loadExistingConfig result:', JSON.stringify({
				serverUrl: result.serverUrl,
				orgId: result.orgId,
				projectId: result.projectId,
				orgsCount: Object.keys(result.orgs).length,
				isLoggedIn: result.auth?.isLoggedIn
			}));

			return result;
		} catch {
			return null;
		}
	}

	// NOTE: _detectTokenType and _validateConnection removed - device login is the only auth method now

	/**
	 * Fetch projects for a specific organization (used with user tokens)
	 * Uses listProjects() from @ace-sdk/core (v2.7.0+)
	 */
	private async _fetchProjectsForOrg(_serverUrl: string, orgId: string) {
		try {
			// Use SDK's listProjects() which works with user tokens (returns Project[])
			const allProjects = await listProjects();
			console.log('[ACE] listProjects returned:', allProjects.length, 'projects');
			console.log('[ACE] Filtering for orgId:', orgId);

			// Filter projects by orgId if specified
			// Check both org_id and orgId fields for compatibility
			const projects = allProjects.filter((p: { org_id?: string; orgId?: string }) => {
				const projectOrgId = p.org_id || p.orgId;
				const matches = !orgId || projectOrgId === orgId;
				if (!matches) {
					console.log('[ACE] Project filtered out:', p, 'projectOrgId:', projectOrgId);
				}
				return matches;
			});

			console.log('[ACE] Filtered to:', projects.length, 'projects for org', orgId);

			this._panel.webview.postMessage({
				command: 'projectsResult',
				success: true,
				orgId: orgId,
				projects: projects
			});
		} catch (error) {
			console.error('[ACE] Failed to fetch projects:', error);
			this._panel.webview.postMessage({
				command: 'projectsResult',
				success: false,
				orgId: orgId,
				message: `Failed to fetch projects: ${String(error)}`
			});
		}
	}

	/**
	 * Handle browser-based login via device code flow
	 */
	private async _handleLogin() {
		try {
			this._panel.webview.postMessage({
				command: 'loginStarted'
			});

			// Run login command (opens browser, polls for token)
			const user = await runLoginCommand();

			if (user) {
				// v0.2.44: After login, refresh organizations from server
				// This syncs orgs from Clerk via /api/v1/auth/me endpoint
				let organizations = user.organizations || [];
				try {
					console.log('[ACE] Refreshing organizations from server...');
					const refreshedOrgs = await refreshOrganizations();
					if (refreshedOrgs && refreshedOrgs.length > 0) {
						organizations = refreshedOrgs;
						console.log('[ACE] Refreshed orgs:', organizations.length);
					}
				} catch (refreshError) {
					console.warn('[ACE] Failed to refresh orgs, using login response:', refreshError);
				}

				// Login succeeded - send user info to webview
				this._panel.webview.postMessage({
					command: 'loginResult',
					success: true,
					user: {
						email: user.email,
						organizations: organizations
					}
				});
			} else {
				// Login cancelled or failed
				this._panel.webview.postMessage({
					command: 'loginResult',
					success: false,
					message: 'Login cancelled'
				});
			}
		} catch (error) {
			this._panel.webview.postMessage({
				command: 'loginResult',
				success: false,
				message: `Login failed: ${String(error)}`
			});
		}
	}

	/**
	 * Handle logout - clear auth tokens
	 */
	private async _handleLogout() {
		try {
			this._panel.webview.postMessage({
				command: 'logoutStarted'
			});

			// Call SDK logout function
			await logout();

			// Logout succeeded - notify webview
			this._panel.webview.postMessage({
				command: 'logoutResult',
				success: true
			});

			vscode.window.showInformationMessage('ACE: Logged out successfully');
		} catch (error) {
			this._panel.webview.postMessage({
				command: 'logoutResult',
				success: false,
				message: `Logout failed: ${String(error)}`
			});
		}
	}

	/**
	 * Save configuration to global config file and workspace settings
	 */
	private async _saveConfiguration(data: {
		serverUrl: string;
		orgId: string;
		projectId: string;
	}) {
		try {
			const configDir = path.join(os.homedir(), '.config', 'ace');
			const configPath = path.join(configDir, 'config.json');

			// Ensure directory exists
			if (!fs.existsSync(configDir)) {
				fs.mkdirSync(configDir, { recursive: true });
			}

			// Load existing config or create new
			let existingConfig: Record<string, any> = {};
			if (fs.existsSync(configPath)) {
				try {
					existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
				} catch {
					// Start fresh if invalid
				}
			}

			// Check if user is logged in via device code (has auth.token)
			const isUserLoggedIn = !!existingConfig.auth?.token;

			if (!isUserLoggedIn) {
				this._panel.webview.postMessage({
					command: 'saveResult',
					success: false,
					message: 'Please login first using the "Login with Browser" button'
				});
				return;
			}

			// Build config - user token flow only
			const config: Record<string, any> = {
				...existingConfig,
				serverUrl: data.serverUrl,
				projectId: data.projectId,
				cacheTtlMinutes: existingConfig.cacheTtlMinutes || 120,
				auth: {
					...existingConfig.auth,
					default_org_id: data.orgId
				}
			};

			// Write config with secure permissions (Unix only - Windows ignores mode)
			if (process.platform !== 'win32') {
				fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
			} else {
				fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
			}

			// Save project context to workspace
			// For multi-root workspaces, prompt user to select folder
			let targetFolder: vscode.WorkspaceFolder | undefined;
			if (isMultiRootWorkspace()) {
				targetFolder = await pickWorkspaceFolder('Select folder to save ACE configuration');
				if (!targetFolder) {
					this._panel.webview.postMessage({
						command: 'saveResult',
						success: false,
						message: 'No folder selected for workspace configuration'
					});
					return;
				}
			} else {
				targetFolder = vscode.workspace.workspaceFolders?.[0];
			}

			if (targetFolder) {
				ensureSettingsDir(targetFolder);
				writeContext({ orgId: data.orgId, projectId: data.projectId }, targetFolder);
			}

			const folderInfo = isMultiRootWorkspace() && targetFolder ? ` for "${targetFolder.name}"` : '';
			this._panel.webview.postMessage({
				command: 'saveResult',
				success: true,
				message: `Configuration saved${folderInfo}`
			});

			vscode.window.showInformationMessage(`ACE configuration saved${folderInfo}. MCP server will use these settings.`);
		} catch (error) {
			this._panel.webview.postMessage({
				command: 'saveResult',
				success: false,
				message: `Save failed: ${String(error)}`
			});
		}
	}

	private _getNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	private _getConfigureHtml(existingConfig: {
		serverUrl?: string;
		orgId?: string;
		projectId?: string;
		orgs?: Record<string, { orgName: string; projects: Array<string | { project_id: string; project_name?: string }> }>;
		auth?: {
			isLoggedIn: boolean;
			email?: string;
			organizations?: Array<{ org_id: string; name?: string; role?: string }>;
			expiresAt?: string;
			refreshExpiresAt?: string;
			absoluteExpiresAt?: string;
		};
	} | null) {
		const nonce = this._getNonce();
		const cspSource = this._panel.webview.cspSource;

		const escapeHtml = (str: string | undefined): string => {
			if (!str) return '';
			return str
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};

		// Format time remaining
		const formatTimeRemaining = (isoDate: string | undefined): string => {
			if (!isoDate) return '';
			const expires = new Date(isoDate).getTime();
			const now = Date.now();
			const diffMs = expires - now;
			if (diffMs <= 0) return 'Expired';
			const hours = Math.floor(diffMs / (1000 * 60 * 60));
			const days = Math.floor(hours / 24);
			if (days > 0) return `${days}d ${hours % 24}h`;
			return `${hours}h`;
		};

		// Check if user is already logged in via device code
		const isLoggedIn = existingConfig?.auth?.isLoggedIn || false;
		const userEmail = existingConfig?.auth?.email || '';
		const accessExpiry = formatTimeRemaining(existingConfig?.auth?.expiresAt);
		const hardCapExpiry = formatTimeRemaining(existingConfig?.auth?.absoluteExpiresAt);
		const isExpired = accessExpiry === 'Expired' || hardCapExpiry === 'Expired';

		const serverUrl = escapeHtml(existingConfig?.serverUrl) || 'https://ace-api.code-engine.app';
		const orgId = escapeHtml(existingConfig?.orgId);
		const projectId = escapeHtml(existingConfig?.projectId);

		const orgs = existingConfig?.orgs || {};
		const orgsJson = JSON.stringify(orgs);
		const orgsArray = Object.entries(orgs).map(([id, data]) => ({
			id,
			name: data.orgName || id,
			projects: data.projects || []
		}));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}';">
	<title>ACE Configuration</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			padding: 30px;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			max-width: 600px;
			margin: 0 auto;
		}
		.header {
			border-bottom: 2px solid var(--vscode-panel-border);
			padding-bottom: 20px;
			margin-bottom: 30px;
		}
		.header h1 {
			margin: 0 0 10px 0;
			font-size: 24px;
		}
		.form-group {
			margin-bottom: 20px;
		}
		label {
			display: block;
			margin-bottom: 8px;
			font-weight: 500;
		}
		.input-group {
			display: flex;
			gap: 10px;
		}
		input, select {
			flex: 1;
			padding: 10px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			font-size: 14px;
			font-family: var(--vscode-font-family);
		}
		input:focus, select:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}
		.quick-select {
			flex: 0 0 auto;
			padding: 10px 15px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 4px;
			cursor: pointer;
			font-size: 12px;
		}
		.quick-select:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.help-text {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-top: 5px;
		}
		.button-group {
			display: flex;
			gap: 10px;
			margin-top: 30px;
		}
		button {
			flex: 1;
			padding: 12px 20px;
			border: none;
			border-radius: 4px;
			font-size: 14px;
			font-weight: 500;
			cursor: pointer;
		}
		.btn-primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.btn-primary:hover:not(:disabled) {
			background: var(--vscode-button-hoverBackground);
		}
		.btn-primary:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.btn-connected {
			background: var(--vscode-testing-iconPassed) !important;
			color: white !important;
		}
		.btn-secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.btn-secondary:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.status-message {
			margin-top: 15px;
			padding: 12px;
			border-radius: 4px;
			display: none;
		}
		.status-success {
			background: var(--vscode-testing-iconPassed);
			color: white;
		}
		.status-error {
			background: var(--vscode-testing-iconFailed);
			color: white;
		}
		.status-info {
			background: var(--vscode-notifications-background);
			color: var(--vscode-notifications-foreground);
		}
		.mcp-info {
			margin-top: 30px;
			padding: 15px;
			background: var(--vscode-notifications-background);
			border-radius: 6px;
			border-left: 4px solid var(--vscode-textLink-foreground);
		}
		.mcp-info h3 {
			margin: 0 0 10px 0;
			font-size: 14px;
		}
		.mcp-info p {
			margin: 5px 0;
			font-size: 13px;
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>
	<div class="header">
		<h1>ACE Configuration</h1>
		<p style="color: var(--vscode-descriptionForeground); margin: 0;">
			Configure your ACE server connection for automatic pattern learning
		</p>
	</div>

	<form id="configForm">
		<div class="form-group">
			<label for="serverUrl">Server URL</label>
			<div class="input-group">
				<input type="url" id="serverUrl" name="serverUrl"
					value="${serverUrl}"
					placeholder="https://ace-api.code-engine.app" required>
				<button type="button" class="quick-select" id="setProductionUrl">
					Production
				</button>
			</div>
		</div>

		<div class="form-group" id="orgGroup">
			<label for="orgId">Organization</label>
			<select id="orgId" name="orgId" required style="display: ${isLoggedIn && !isExpired && orgsArray.length > 0 ? 'block' : 'none'};">
				<option value="">-- Select Organization --</option>
				${orgsArray.map(org => `
					<option value="${escapeHtml(org.id)}"
						${org.id === orgId ? 'selected' : ''}
						data-projects='${JSON.stringify(org.projects)}'>
						${escapeHtml(org.name)} (${org.id})
					</option>
				`).join('')}
			</select>
			<input type="text" id="orgIdManual" name="orgIdManual"
				value="${orgId || ''}"
				placeholder="org_xxxxx (or select from dropdown above)"
				style="margin-top: 10px; display: ${isLoggedIn && !isExpired && orgsArray.length > 0 ? 'none' : 'block'};"
				${!isLoggedIn || isExpired ? 'readonly' : ''}>
			<p class="help-text" style="display: ${(!isLoggedIn || isExpired) && orgId ? 'block' : 'none'};">
				Current configured organization. Login to change.
			</p>
		</div>

		<div class="form-group">
			<label>Authentication</label>
			<div class="input-group" style="margin-bottom: 10px;">
				<button type="button" class="btn-primary" id="loginBtn" style="flex: 2;">
					Login with Browser
				</button>
				<button type="button" class="btn-secondary" id="logoutBtn" style="flex: 1; display: none;">
					Logout
				</button>
				<button type="button" class="btn-secondary" id="devicesBtn" style="flex: 1;">
					Devices
				</button>
			</div>
			<div id="authStatus" style="padding: 8px; background: var(--vscode-notifications-background); border-radius: 4px; display: none;"></div>
		</div>

		<div class="form-group" id="projectGroup">
			<label for="projectId">Project</label>
			<select id="projectId" name="projectId" required style="display: ${isLoggedIn && !isExpired ? 'block' : 'none'};">
				<option value="">-- Select Project --</option>
				${projectId ? `<option value="${projectId}" selected>${projectId}</option>` : ''}
			</select>
			<input type="text" id="projectIdManual" name="projectIdManual"
				value="${projectId}"
				placeholder="prj_xxxxx (or select from dropdown above)"
				style="margin-top: 10px; display: ${isLoggedIn && !isExpired ? 'none' : 'block'};"
				${!isLoggedIn || isExpired ? 'readonly' : ''}>
			<p class="help-text" style="display: ${(!isLoggedIn || isExpired) && projectId ? 'block' : 'none'};">
				Current configured project. Login to change.
			</p>
		</div>

		<div class="button-group">
			<button type="submit" class="btn-primary" id="saveBtn" disabled title="Login first to save configuration">
				Save Configuration
			</button>
		</div>

		<div id="statusMessage" class="status-message"></div>
	</form>

	<div class="mcp-info">
		<h3>How ACE Works with Cursor</h3>
		<p>After saving, the extension registers an MCP server that Cursor's AI automatically uses.</p>
		<p>The AI calls <code>ace_get_playbook</code> before tasks and <code>ace_learn</code> after.</p>
	</div>

	<div class="mcp-info" style="margin-top: 15px; border-left-color: var(--vscode-charts-green);">
		<h3>First Time Setup?</h3>
		<p>After saving your configuration, initialize your workspace to create the required hooks and rules files.</p>
		<button type="button" class="btn-secondary" id="initWorkspaceBtn" style="margin-top: 10px; flex: none; width: auto; padding: 8px 16px;">
			Initialize Workspace
		</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const orgsData = ${orgsJson};
		// Initialize auth state from existing config
		let isUserToken = ${isLoggedIn ? 'true' : 'false'};
		const existingEmail = '${escapeHtml(userEmail)}';
		const accessExpiry = '${accessExpiry}';
		const hardCapExpiry = '${hardCapExpiry}';
		const isExpired = ${isExpired ? 'true' : 'false'};

		// Get existing workspace config values - GLOBAL scope so populateProjects can access
		const existingOrgId = '${escapeHtml(orgId)}';
		const existingProjectId = '${escapeHtml(projectId)}';

		(function init() {
			document.getElementById('setProductionUrl').addEventListener('click', () => {
				document.getElementById('serverUrl').value = 'https://ace-api.code-engine.app';
			});

			const orgSelect = document.getElementById('orgId');
			orgSelect.addEventListener('change', onOrgChange);

			document.getElementById('configForm').addEventListener('submit', handleSubmit);
			document.getElementById('initWorkspaceBtn').addEventListener('click', () => {
				vscode.postMessage({ command: 'initializeWorkspace' });
				showStatus('Initializing workspace... Creating hooks and rules.', 'info');
			});

			// Login with browser button
			document.getElementById('loginBtn').addEventListener('click', () => {
				document.getElementById('loginBtn').disabled = true;
				document.getElementById('loginBtn').textContent = 'Opening browser...';
				vscode.postMessage({ command: 'login' });
			});

			// Logout button
			document.getElementById('logoutBtn').addEventListener('click', () => {
				document.getElementById('logoutBtn').disabled = true;
				document.getElementById('logoutBtn').textContent = 'Logging out...';
				vscode.postMessage({ command: 'logout' });
			});

			// Manage devices button
			document.getElementById('devicesBtn').addEventListener('click', () => {
				vscode.postMessage({ command: 'executeCommand', commandId: 'ace.devices' });
			});

			// Handle auth state: logged in, expired, or not logged in
			const loginBtn = document.getElementById('loginBtn');
			const logoutBtn = document.getElementById('logoutBtn');
			const authStatus = document.getElementById('authStatus');
			const saveBtn = document.getElementById('saveBtn');
			const orgGroup = document.getElementById('orgGroup');
			const projectGroup = document.getElementById('projectGroup');

			if (isExpired && existingEmail) {
				// Token expired - show warning and prompt re-login
				// But still show existing config as read-only info
				loginBtn.textContent = 'Re-login Required';
				loginBtn.classList.remove('btn-connected');
				loginBtn.style.background = 'var(--vscode-testing-iconFailed)';
				loginBtn.style.color = 'white';
				logoutBtn.style.display = 'block'; // Show logout button

				let expiredStatusHtml = '⚠️ Session expired for ' + existingEmail;
				if (existingOrgId || existingProjectId) {
					expiredStatusHtml += '<br><small style="opacity: 0.8;">Current config: ' + (existingOrgId || 'no org') + ' / ' + (existingProjectId || 'no project') + '</small>';
				}
				expiredStatusHtml += '<br><small style="opacity: 0.8;">Please re-login to continue using ACE.</small>';
				authStatus.innerHTML = expiredStatusHtml;
				authStatus.style.display = 'block';
				authStatus.style.background = 'var(--vscode-inputValidation-warningBackground)';
				saveBtn.disabled = true;
				saveBtn.title = 'Re-login required - session expired';
				orgGroup.style.display = 'none';
				projectGroup.style.display = 'none';

				showStatus('Session expired. Please re-login to continue.', 'error');
			} else if (isUserToken && existingEmail) {
				// Logged in with valid token
				loginBtn.textContent = '✓ Logged In';
				loginBtn.classList.add('btn-connected');
				logoutBtn.style.display = 'block'; // Show logout button

				// Build auth status with expiration info
				let statusHtml = '✅ Logged in as ' + existingEmail;
				if (accessExpiry || hardCapExpiry) {
					statusHtml += '<br><small style="opacity: 0.8;">';
					if (accessExpiry) statusHtml += '⏱️ Session: ' + accessExpiry + ' (auto-extends on use)';
					if (hardCapExpiry) statusHtml += ' · 🔒 Hard cap: ' + hardCapExpiry;
					statusHtml += '</small>';
				}
				authStatus.innerHTML = statusHtml;
				authStatus.style.display = 'block';
				saveBtn.disabled = false;
				saveBtn.title = '';
				orgGroup.style.display = 'block';
				projectGroup.style.display = 'block';

				showStatus('Already logged in. Select organization and project, then save.', 'success');
			} else {
				// Not logged in at all
				authStatus.innerHTML = '🔒 Please login to configure ACE';
				authStatus.style.display = 'block';
				saveBtn.disabled = true;
				saveBtn.title = 'Login first to save configuration';
				orgGroup.style.display = 'none';
				projectGroup.style.display = 'none';

				showStatus('Login required to configure ACE.', 'info');
			}

			// Trigger org change if one is selected
			if (orgSelect.value) {
				onOrgChange();
			}
		})();

		function onOrgChange() {
			const orgSelect = document.getElementById('orgId');
			const projectSelect = document.getElementById('projectId');
			const projectManual = document.getElementById('projectIdManual');
			const orgIdManual = document.getElementById('orgIdManual');

			const selectedOption = orgSelect.options[orgSelect.selectedIndex];
			const orgId = orgSelect.value;

			if (orgId) {
				orgIdManual.value = orgId;
				orgIdManual.style.display = 'none';
			} else {
				orgIdManual.style.display = 'block';
			}

			// Clear and populate projects
			while (projectSelect.firstChild) {
				projectSelect.removeChild(projectSelect.firstChild);
			}
			const defaultOption = document.createElement('option');
			defaultOption.value = '';
			defaultOption.textContent = '-- Select Project --';
			projectSelect.appendChild(defaultOption);

			// For user tokens, fetch projects from server
			if (isUserToken && orgId) {
				const serverUrl = document.getElementById('serverUrl').value || 'https://ace-api.code-engine.app';
				showStatus('Loading projects...', 'info');
				vscode.postMessage({
					command: 'fetchProjects',
					serverUrl: serverUrl,
					orgId: orgId
				});
				projectSelect.style.display = 'block';
				projectManual.style.display = 'none';
				return;
			}

			// For org tokens or cached data, use existing projects
			if (selectedOption && selectedOption.dataset.projects) {
				try {
					const projects = JSON.parse(selectedOption.dataset.projects);
					populateProjects(projects, existingProjectId);
				} catch (e) {
					projectSelect.style.display = 'none';
					projectManual.style.display = 'block';
				}
			} else {
				projectSelect.style.display = 'none';
				projectManual.style.display = 'block';
			}
		}

		function populateProjects(projects, preSelectProjectId) {
			const projectSelect = document.getElementById('projectId');
			const projectManual = document.getElementById('projectIdManual');
			// Use provided preSelectProjectId or fall back to initial config value
			const targetProjectId = preSelectProjectId || existingProjectId;

			console.log('[ACE UI] populateProjects called:', {
				projectCount: projects?.length || 0,
				preSelectProjectId,
				targetProjectId,
				existingProjectId
			});

			while (projectSelect.firstChild) {
				projectSelect.removeChild(projectSelect.firstChild);
			}
			const defaultOption = document.createElement('option');
			defaultOption.value = '';
			defaultOption.textContent = '-- Select Project --';
			projectSelect.appendChild(defaultOption);

			// Track if target project was found in the list
			let targetFound = false;

			if (projects && projects.length > 0) {
				projects.forEach(project => {
					const projectId = typeof project === 'string' ? project : (project.project_id || project.id);
					const projectName = typeof project === 'string' ? project : (project.project_name || project.name || projectId);
					const option = document.createElement('option');
					option.value = projectId;
					option.textContent = projectName + (projectId !== projectName ? ' (' + projectId + ')' : '');
					if (projectId === targetProjectId) {
						option.selected = true;
						targetFound = true;
					}
					projectSelect.appendChild(option);
				});
			}

			// Always add existing project as option if not in list (allows keeping workspace config)
			if (targetProjectId && !targetFound) {
				console.log('[ACE UI] Adding existing project to dropdown:', targetProjectId);
				const existingOption = document.createElement('option');
				existingOption.value = targetProjectId;
				existingOption.textContent = targetProjectId + ' (current)';
				existingOption.selected = true;
				projectSelect.appendChild(existingOption);
			}

			// Show dropdown if we have projects OR existing project
			if ((projects && projects.length > 0) || targetProjectId) {
				projectSelect.style.display = 'block';
				projectManual.style.display = 'none';
			} else {
				projectSelect.style.display = 'none';
				projectManual.style.display = 'block';
			}
		}

		function handleSubmit(e) {
			e.preventDefault();
			const formData = new FormData(e.target);
			const orgId = formData.get('orgId') || formData.get('orgIdManual');
			const projectId = formData.get('projectId') || formData.get('projectIdManual');

			const data = {
				serverUrl: formData.get('serverUrl'),
				orgId: orgId,
				projectId: projectId
			};

			if (!data.serverUrl || !data.orgId || !data.projectId) {
				showStatus('Please fill in all required fields (login first if not done)', 'error');
				return;
			}

			if (!isUserToken) {
				showStatus('Please login first before saving', 'error');
				return;
			}

			showStatus('Saving configuration...', 'info');
			vscode.postMessage({ command: 'save', data: data });
		}

		function showStatus(message, type) {
			const statusEl = document.getElementById('statusMessage');
			statusEl.textContent = message;
			statusEl.className = 'status-message status-' + type;
			statusEl.style.display = 'block';
		}

		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				// Legacy validationResult - kept for compatibility but not used with device login
				case 'validationResult':
					showStatus(message.message, message.success ? 'success' : 'error');
					break;
				case 'saveResult':
					showStatus(message.message, message.success ? 'success' : 'error');
					if (message.success) {
						setTimeout(() => {
							vscode.postMessage({ command: 'close' });
						}, 2000);
					}
					break;
				case 'loginStarted':
					document.getElementById('authStatus').style.display = 'block';
					document.getElementById('authStatus').innerHTML = '⏳ Opening browser for login...';
					break;
				case 'loginResult':
					const loginBtnResult = document.getElementById('loginBtn');
					const authStatusResult = document.getElementById('authStatus');
					const orgGroupResult = document.getElementById('orgGroup');
					const projectGroupResult = document.getElementById('projectGroup');
					loginBtnResult.disabled = false;
					loginBtnResult.style.background = ''; // Reset any custom background
					loginBtnResult.style.color = ''; // Reset any custom color

					if (message.success && message.user) {
						isUserToken = true; // Mark that we're using user token (needs project fetch)
						loginBtnResult.textContent = '✓ Logged In';
						loginBtnResult.classList.add('btn-connected');
						document.getElementById('logoutBtn').style.display = 'block'; // Show logout button
						authStatusResult.innerHTML = '✅ Logged in as ' + message.user.email;
						authStatusResult.style.display = 'block';
						authStatusResult.style.background = ''; // Reset background

						// Enable Save button
						document.getElementById('saveBtn').disabled = false;
						document.getElementById('saveBtn').title = '';

						// Show org and project groups
						orgGroupResult.style.display = 'block';
						projectGroupResult.style.display = 'block';

						// Populate organizations from login
						if (message.user.organizations && message.user.organizations.length > 0) {
							const orgSelect = document.getElementById('orgId');
							// Clear existing options except default
							while (orgSelect.options.length > 1) {
								orgSelect.remove(1);
							}
							// Add organizations from login
							message.user.organizations.forEach(org => {
								const option = document.createElement('option');
								option.value = org.org_id;
								option.textContent = (org.name || org.org_name || 'Unknown') + ' (' + org.org_id + ')';
								option.dataset.projects = '[]'; // Projects loaded on selection
								orgSelect.appendChild(option);
							});

							// Pre-select existing org if it matches, otherwise use first org
							const previousOrgId = existingOrgId;
							const matchingOrg = message.user.organizations.find(org => org.org_id === previousOrgId);
							if (matchingOrg) {
								orgSelect.value = previousOrgId;
							} else if (message.user.organizations.length > 0) {
								orgSelect.value = message.user.organizations[0].org_id;
							}
							// Trigger org change to fetch projects
							orgSelect.dispatchEvent(new Event('change'));
							orgSelect.style.display = 'block';
							document.getElementById('orgIdManual').style.display = 'none';
						}

						showStatus('Login successful! ' + (existingOrgId ? 'Previous config restored.' : 'Select organization and project.'), 'success');
					} else {
						loginBtnResult.textContent = 'Login with Browser';
						authStatusResult.innerHTML = '❌ ' + (message.message || 'Login failed');
						authStatusResult.style.display = 'block';
						showStatus(message.message || 'Login failed', 'error');
					}
					break;
				case 'projectsResult':
					if (message.success && message.projects) {
						populateProjects(message.projects, existingProjectId);
						showStatus('Projects loaded.' + (existingProjectId ? ' Previous project restored.' : ' Select project and save.'), 'success');
					} else {
						showStatus(message.message || 'Failed to load projects', 'error');
						document.getElementById('projectId').style.display = 'none';
						document.getElementById('projectIdManual').style.display = 'block';
					}
					break;
				case 'logoutStarted':
					document.getElementById('authStatus').style.display = 'block';
					document.getElementById('authStatus').innerHTML = '⏳ Logging out...';
					break;
				case 'logoutResult':
					const logoutBtnResult = document.getElementById('logoutBtn');
					const loginBtnLogout = document.getElementById('loginBtn');
					const authStatusLogout = document.getElementById('authStatus');
					const orgGroupLogout = document.getElementById('orgGroup');
					const projectGroupLogout = document.getElementById('projectGroup');
					logoutBtnResult.disabled = false;
					logoutBtnResult.textContent = 'Logout';

					if (message.success) {
						// Reset to logged-out state
						isUserToken = false;
						loginBtnLogout.textContent = 'Login with Browser';
						loginBtnLogout.classList.remove('btn-connected');
						loginBtnLogout.style.background = '';
						loginBtnLogout.style.color = '';
						logoutBtnResult.style.display = 'none'; // Hide logout button

						authStatusLogout.innerHTML = '🔒 Please login to configure ACE';
						authStatusLogout.style.display = 'block';
						authStatusLogout.style.background = '';

						// Disable Save button
						document.getElementById('saveBtn').disabled = true;
						document.getElementById('saveBtn').title = 'Login first to save configuration';

						// Hide org and project groups
						orgGroupLogout.style.display = 'none';
						projectGroupLogout.style.display = 'none';

						showStatus('Logged out successfully. Login again to configure ACE.', 'info');
					} else {
						authStatusLogout.innerHTML = '❌ ' + (message.message || 'Logout failed');
						authStatusLogout.style.display = 'block';
						showStatus(message.message || 'Logout failed', 'error');
					}
					break;
			}
		});
	</script>
</body>
</html>`;
	}
}
