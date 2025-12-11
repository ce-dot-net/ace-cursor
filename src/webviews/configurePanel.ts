/**
 * ACE Configuration Panel - Configure server connection
 * Uses simple HTTP requests instead of SDK
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ensureSettingsDir, writeContext } from '../ace/context';

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
					case 'validate':
						this._validateConnection(message.data);
						return;
					case 'save':
						this._saveConfiguration(message.data);
						return;
					case 'executeCommand':
						if (message.commandId) {
							vscode.commands.executeCommand(message.commandId, ...(message.args || []));
						}
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
		apiToken?: string;
		orgId?: string;
		projectId?: string;
		orgs?: Record<string, { orgName: string; apiToken: string; projects: Array<string | { project_id: string; project_name?: string }> }>;
	} | null {
		const globalConfigPath = path.join(process.env.HOME || '', '.config', 'ace', 'config.json');

		if (!fs.existsSync(globalConfigPath)) {
			return null;
		}

		try {
			const config = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));

			// Load workspace context
			const { readContext } = require('../ace/context');
			const ctx = readContext();

			return {
				serverUrl: config.serverUrl,
				apiToken: config.apiToken,
				orgId: ctx?.orgId || Object.keys(config.orgs || {})[0],
				projectId: ctx?.projectId || config.projectId,
				orgs: config.orgs
			};
		} catch {
			return null;
		}
	}

	/**
	 * Validate connection using simple HTTP request
	 */
	private async _validateConnection(data: { serverUrl: string; apiToken: string }) {
		try {
			// Use the config/verify endpoint (matches @ace-sdk/core API)
			const url = `${data.serverUrl}/api/v1/config/verify`;
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${data.apiToken}`,
					'Content-Type': 'application/json'
				}
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const verification = await response.json() as {
				org_id?: string;
				org_name?: string;
				projects?: Array<string | { project_id?: string; id?: string; project_name?: string; name?: string }>;
			};

			this._panel.webview.postMessage({
				command: 'validationResult',
				success: true,
				message: `Connection validated! Organization: ${verification.org_name || verification.org_id}`,
				data: {
					orgId: verification.org_id,
					orgName: verification.org_name,
					projects: verification.projects
				}
			});
		} catch (error) {
			this._panel.webview.postMessage({
				command: 'validationResult',
				success: false,
				message: `Validation failed: ${String(error)}`
			});
		}
	}

	/**
	 * Save configuration to global config file and workspace settings
	 */
	private async _saveConfiguration(data: {
		serverUrl: string;
		apiToken: string;
		orgId: string;
		projectId: string;
	}) {
		try {
			const configDir = path.join(process.env.HOME || '', '.config', 'ace');
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

			// Merge new values
			const config: Record<string, any> = {
				...existingConfig,
				serverUrl: data.serverUrl,
				apiToken: data.apiToken,
				projectId: data.projectId,
				cacheTtlMinutes: existingConfig.cacheTtlMinutes || 120
			};

			// Update orgs section
			if (!config.orgs) {
				config.orgs = {};
			}

			const existingProjects = config.orgs[data.orgId]?.projects || [];
			const projectExists = existingProjects.some((p: any) => {
				const existingId = typeof p === 'string' ? p : (p.project_id || p.id);
				return existingId === data.projectId;
			});

			if (!projectExists) {
				existingProjects.push({ project_id: data.projectId });
			}

			config.orgs[data.orgId] = {
				orgName: config.orgs[data.orgId]?.orgName || data.orgId,
				apiToken: data.apiToken,
				projects: existingProjects
			};

			// Write config with secure permissions
			fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

			// Save project context to workspace
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				ensureSettingsDir();
				writeContext({ orgId: data.orgId, projectId: data.projectId });
			}

			this._panel.webview.postMessage({
				command: 'saveResult',
				success: true,
				message: `Configuration saved to ${configPath}`
			});

			vscode.window.showInformationMessage(`ACE configuration saved. MCP server will use these settings.`);
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
		apiToken?: string;
		orgId?: string;
		projectId?: string;
		orgs?: Record<string, { orgName: string; apiToken: string; projects: Array<string | { project_id: string; project_name?: string }> }>;
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

		const serverUrl = escapeHtml(existingConfig?.serverUrl) || 'https://ace-api.code-engine.app';
		let apiToken = escapeHtml(existingConfig?.apiToken);
		const orgId = escapeHtml(existingConfig?.orgId);
		const projectId = escapeHtml(existingConfig?.projectId);

		const orgs = existingConfig?.orgs || {};
		const orgsJson = JSON.stringify(orgs);
		const orgsArray = Object.entries(orgs).map(([id, data]) => ({
			id,
			name: data.orgName || id,
			apiToken: data.apiToken || '',
			projects: data.projects || []
		}));

		if (orgId && orgs[orgId] && !apiToken && orgs[orgId].apiToken) {
			apiToken = escapeHtml(orgs[orgId].apiToken);
		}

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
		.btn-primary:hover {
			background: var(--vscode-button-hoverBackground);
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

		<div class="form-group">
			<label for="orgId">Organization</label>
			<select id="orgId" name="orgId" required>
				<option value="">-- Select Organization --</option>
				${orgsArray.map(org => `
					<option value="${escapeHtml(org.id)}"
						${org.id === orgId ? 'selected' : ''}
						data-token="${escapeHtml(orgs[org.id]?.apiToken || '')}"
						data-projects='${JSON.stringify(org.projects)}'>
						${escapeHtml(org.name)} (${org.id})
					</option>
				`).join('')}
			</select>
			<input type="text" id="orgIdManual" name="orgIdManual"
				value="${orgsArray.length === 0 ? orgId : ''}"
				placeholder="org_xxxxx (or select from dropdown above)"
				style="margin-top: 10px; display: ${orgsArray.length > 0 ? 'none' : 'block'};">
		</div>

		<div class="form-group">
			<label for="apiToken">API Token</label>
			<input type="password" id="apiToken" name="apiToken"
				value="${apiToken}"
				placeholder="ace_xxxxx" required>
			<div class="help-text">
				Get your token from <a href="https://ace.code-engine.app/settings/tokens" target="_blank">ACE Settings</a>
			</div>
		</div>

		<div class="form-group">
			<label for="projectId">Project</label>
			<select id="projectId" name="projectId" required>
				<option value="">-- Select Project --</option>
			</select>
			<input type="text" id="projectIdManual" name="projectIdManual"
				value="${projectId}"
				placeholder="prj_xxxxx (or select from dropdown above)"
				style="margin-top: 10px; display: none;">
		</div>

		<div class="button-group">
			<button type="button" class="btn-secondary" id="validateBtn">
				Validate Connection
			</button>
			<button type="submit" class="btn-primary">
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

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const orgsData = ${orgsJson};

		(function init() {
			document.getElementById('setProductionUrl').addEventListener('click', () => {
				document.getElementById('serverUrl').value = 'https://ace-api.code-engine.app';
			});

			const orgSelect = document.getElementById('orgId');
			orgSelect.addEventListener('change', onOrgChange);
			if (orgSelect.value) {
				onOrgChange();
			}

			document.getElementById('validateBtn').addEventListener('click', validateConnection);
			document.getElementById('configForm').addEventListener('submit', handleSubmit);
		})();

		function onOrgChange() {
			const orgSelect = document.getElementById('orgId');
			const apiTokenInput = document.getElementById('apiToken');
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

			if (selectedOption && selectedOption.dataset.token) {
				apiTokenInput.value = selectedOption.dataset.token;
			}

			// Clear and populate projects
			while (projectSelect.firstChild) {
				projectSelect.removeChild(projectSelect.firstChild);
			}
			const defaultOption = document.createElement('option');
			defaultOption.value = '';
			defaultOption.textContent = '-- Select Project --';
			projectSelect.appendChild(defaultOption);

			if (selectedOption && selectedOption.dataset.projects) {
				try {
					const projects = JSON.parse(selectedOption.dataset.projects);
					populateProjects(projects);
				} catch (e) {
					projectSelect.style.display = 'none';
					projectManual.style.display = 'block';
				}
			} else {
				projectSelect.style.display = 'none';
				projectManual.style.display = 'block';
			}
		}

		function populateProjects(projects) {
			const projectSelect = document.getElementById('projectId');
			const projectManual = document.getElementById('projectIdManual');

			while (projectSelect.firstChild) {
				projectSelect.removeChild(projectSelect.firstChild);
			}
			const defaultOption = document.createElement('option');
			defaultOption.value = '';
			defaultOption.textContent = '-- Select Project --';
			projectSelect.appendChild(defaultOption);

			if (projects && projects.length > 0) {
				projects.forEach(project => {
					const projectId = typeof project === 'string' ? project : (project.project_id || project.id);
					const projectName = typeof project === 'string' ? project : (project.project_name || project.name || projectId);
					const option = document.createElement('option');
					option.value = projectId;
					option.textContent = projectName + (projectId !== projectName ? ' (' + projectId + ')' : '');
					if (projectId === '${escapeHtml(projectId)}') {
						option.selected = true;
					}
					projectSelect.appendChild(option);
				});
				projectSelect.style.display = 'block';
				projectManual.style.display = 'none';
			} else {
				projectSelect.style.display = 'none';
				projectManual.style.display = 'block';
			}
		}

		function validateConnection() {
			const form = document.getElementById('configForm');
			const formData = new FormData(form);
			const data = {
				serverUrl: formData.get('serverUrl'),
				apiToken: formData.get('apiToken')
			};

			if (!data.serverUrl || !data.apiToken) {
				showStatus('Please fill in server URL and API token', 'error');
				return;
			}

			showStatus('Validating connection...', 'info');
			vscode.postMessage({ command: 'validate', data: data });
		}

		function handleSubmit(e) {
			e.preventDefault();
			const formData = new FormData(e.target);
			const orgId = formData.get('orgId') || formData.get('orgIdManual');
			const projectId = formData.get('projectId') || formData.get('projectIdManual');

			const data = {
				serverUrl: formData.get('serverUrl'),
				apiToken: formData.get('apiToken'),
				orgId: orgId,
				projectId: projectId
			};

			if (!data.serverUrl || !data.apiToken || !data.orgId || !data.projectId) {
				showStatus('Please fill in all required fields', 'error');
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
				case 'validationResult':
					showStatus(message.message, message.success ? 'success' : 'error');
					if (message.success && message.data) {
						const orgSelect = document.getElementById('orgId');
						const orgIdManual = document.getElementById('orgIdManual');

						if (message.data.orgId) {
							let found = false;
							for (let i = 0; i < orgSelect.options.length; i++) {
								if (orgSelect.options[i].value === message.data.orgId) {
									orgSelect.selectedIndex = i;
									orgSelect.dispatchEvent(new Event('change'));
									found = true;
									break;
								}
							}
							if (!found && orgIdManual) {
								orgIdManual.value = message.data.orgId;
								orgIdManual.style.display = 'block';
							}
						}

						if (message.data.projects && message.data.projects.length > 0) {
							populateProjects(message.data.projects);
						}
					}
					break;
				case 'saveResult':
					showStatus(message.message, message.success ? 'success' : 'error');
					if (message.success) {
						setTimeout(() => {
							vscode.postMessage({ command: 'close' });
						}, 2000);
					}
					break;
			}
		});
	</script>
</body>
</html>`;
	}
}
