/**
 * ACE Status Panel - Displays playbook statistics
 * Uses simple HTTP requests instead of SDK
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { readContext } from '../ace/context';

export class StatusPanel {
	public static currentPanel: StatusPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	private constructor(panel: vscode.WebviewPanel) {
		this._panel = panel;
		this._update();
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.onDidChangeViewState(
			() => {
				if (this._panel.visible) {
					this._update();
				}
			},
			null,
			this._disposables
		);

		// Handle messages from webview
		this._panel.webview.onDidReceiveMessage(
			message => {
				switch (message.command) {
					case 'executeCommand':
						if (message.commandId) {
							vscode.commands.executeCommand(message.commandId, ...(message.args || []))
								.then(
									() => console.log(`[ACE] Executed command: ${message.commandId}`),
									err => console.error(`[ACE] Command execution failed: ${message.commandId}`, err)
								);
						}
						break;
					case 'refresh':
						this._update();
						break;
				}
			},
			null,
			this._disposables
		);
	}

	public static createOrShow(extensionUri: vscode.Uri) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		if (StatusPanel.currentPanel) {
			StatusPanel.currentPanel._panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'aceStatus',
			'ACE Playbook Status',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri]
			}
		);

		StatusPanel.currentPanel = new StatusPanel(panel);
	}

	public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		StatusPanel.currentPanel = new StatusPanel(panel);
	}

	public dispose() {
		StatusPanel.currentPanel = undefined;
		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private async _update() {
		const ctx = readContext();
		if (!ctx) {
			this._panel.webview.html = this._getErrorHtml('ACE not configured. Run ACE: Configure Connection first.');
			return;
		}

		try {
			const stats = await this._fetchStatus(ctx);
			this._panel.webview.html = this._getStatusHtml(stats);
		} catch (error) {
			this._panel.webview.html = this._getErrorHtml(`Failed to load status: ${String(error)}`);
		}
	}

	/**
	 * Fetch status using simple HTTP request
	 */
	private async _fetchStatus(ctx: { orgId?: string; projectId: string }): Promise<any> {
		const config = this._getAceConfig();
		if (!config || !config.serverUrl || !config.apiToken) {
			throw new Error('ACE not fully configured');
		}

		// Fetch analytics
		const analyticsUrl = `${config.serverUrl}/analytics`;
		const analyticsResponse = await fetch(analyticsUrl, {
			headers: {
				'Authorization': `Bearer ${config.apiToken}`,
				'Content-Type': 'application/json',
				'X-ACE-Project': ctx.projectId
			}
		});

		if (!analyticsResponse.ok) {
			throw new Error(`HTTP ${analyticsResponse.status}`);
		}

		const analytics = await analyticsResponse.json() as Record<string, any>;

		// Try to get org/project names from verify endpoint
		let orgName = '';
		let projectName = '';
		try {
			const verifyUrl = `${config.serverUrl}/api/v1/config/verify`;
			const verifyResponse = await fetch(verifyUrl, {
				headers: {
					'Authorization': `Bearer ${config.apiToken}`,
					'Content-Type': 'application/json'
				}
			});
			if (verifyResponse.ok) {
				const verifyData = await verifyResponse.json() as Record<string, any>;
				orgName = verifyData.org_name || '';
				// Find project name from projects list
				const projects = verifyData.projects || [];
				const project = projects.find((p: any) =>
					(p.project_id || p.id) === ctx.projectId
				);
				projectName = project?.project_name || project?.name || '';
			}
		} catch {
			// Ignore verify errors - names are optional
		}

		return {
			...analytics,
			// Support both old and new field names
			total_bullets: analytics.total_patterns || analytics.total_bullets || 0,
			org_id: ctx.orgId,
			org_name: orgName,
			project_id: ctx.projectId,
			project_name: projectName
		};
	}

	/**
	 * Get ACE configuration from global config file
	 */
	private _getAceConfig(): { serverUrl?: string; apiToken?: string } | null {
		const ctx = readContext();
		const globalConfigPath = path.join(os.homedir(), '.config', 'ace', 'config.json');

		if (!fs.existsSync(globalConfigPath)) {
			return null;
		}

		try {
			const config = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
			let apiToken = config.apiToken;

			// Get org-specific token if available
			if (ctx?.orgId && config.orgs?.[ctx.orgId]?.apiToken) {
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

	private _getNonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) {
			text += possible.charAt(Math.floor(Math.random() * possible.length));
		}
		return text;
	}

	private _getStatusHtml(stats: any) {
		const bySection = stats.by_section || {};
		const total = stats.total_bullets || 0;
		const avgConf = stats.avg_confidence ? Math.round(stats.avg_confidence * 100) : 0;
		const nonce = this._getNonce();
		const cspSource = this._panel.webview.cspSource;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}';">
	<title>ACE Status</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			padding: 20px;
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
		}
		.header {
			border-bottom: 2px solid var(--vscode-panel-border);
			padding-bottom: 15px;
			margin-bottom: 20px;
		}
		.header h1 {
			margin: 0 0 10px 0;
			font-size: 24px;
		}
		.meta {
			color: var(--vscode-descriptionForeground);
			font-size: 14px;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.meta-item {
			display: flex;
			align-items: baseline;
			gap: 8px;
		}
		.meta-label {
			font-weight: 600;
			min-width: 100px;
		}
		.meta-value {
			flex: 1;
		}
		.meta-id {
			color: var(--vscode-descriptionForeground);
			opacity: 0.7;
			font-size: 0.9em;
			margin-left: 4px;
		}
		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
			gap: 15px;
			margin: 20px 0;
		}
		.stat-card {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			padding: 15px;
			transition: transform 0.2s;
		}
		.stat-card:hover {
			transform: translateY(-2px);
			border-color: var(--vscode-focusBorder);
		}
		.stat-label {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			text-transform: uppercase;
			letter-spacing: 0.5px;
			margin-bottom: 8px;
		}
		.stat-value {
			font-size: 32px;
			font-weight: bold;
			color: var(--vscode-textLink-foreground);
		}
		.section-breakdown {
			margin-top: 30px;
		}
		.section-item {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 12px;
			margin: 8px 0;
			background: var(--vscode-list-inactiveSelectionBackground);
			border-radius: 4px;
		}
		.section-name {
			font-weight: 500;
		}
		.section-count {
			font-size: 18px;
			color: var(--vscode-textLink-foreground);
		}
		.confidence-bar {
			width: 100%;
			height: 8px;
			background: var(--vscode-progressBar-background);
			border-radius: 4px;
			margin-top: 10px;
			overflow: hidden;
		}
		.confidence-fill {
			height: 100%;
			background: var(--vscode-progressBar-background);
			background: linear-gradient(90deg, #4CAF50 0%, #8BC34A 100%);
			transition: width 0.3s;
		}
		.refresh-btn {
			margin-top: 20px;
			padding: 8px 16px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: 14px;
		}
		.refresh-btn:hover {
			background: var(--vscode-button-hoverBackground);
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
		<h1>ACE Playbook Status</h1>
		<div class="meta">
			<div class="meta-item">
				<span class="meta-label">Organization:</span>
				<span class="meta-value">${stats.org_name ? `${stats.org_name} <span class="meta-id">(${stats.org_id})</span>` : (stats.org_id || 'n/a')}</span>
			</div>
			<div class="meta-item">
				<span class="meta-label">Project:</span>
				<span class="meta-value">${stats.project_name ? `${stats.project_name} <span class="meta-id">(${stats.project_id})</span>` : (stats.project_id || 'n/a')}</span>
			</div>
		</div>
	</div>

	<div class="stats-grid">
		<div class="stat-card">
			<div class="stat-label">Total Patterns</div>
			<div class="stat-value">${total}</div>
		</div>
		<div class="stat-card">
			<div class="stat-label">Average Confidence</div>
			<div class="stat-value">${avgConf}%</div>
			<div class="confidence-bar">
				<div class="confidence-fill" style="width: ${avgConf}%"></div>
			</div>
		</div>
	</div>

	<div class="section-breakdown">
		<h2>Patterns by Section</h2>
		<div class="section-item">
			<span class="section-name">Strategies & Hard Rules</span>
			<span class="section-count">${bySection.strategies_and_hard_rules || 0}</span>
		</div>
		<div class="section-item">
			<span class="section-name">Useful Code Snippets</span>
			<span class="section-count">${bySection.useful_code_snippets || 0}</span>
		</div>
		<div class="section-item">
			<span class="section-name">Troubleshooting & Pitfalls</span>
			<span class="section-count">${bySection.troubleshooting_and_pitfalls || 0}</span>
		</div>
		<div class="section-item">
			<span class="section-name">APIs to Use</span>
			<span class="section-count">${bySection.apis_to_use || 0}</span>
		</div>
	</div>

	<div class="mcp-info">
		<h3>Automatic Pattern Learning via MCP</h3>
		<p>The AI automatically retrieves patterns before tasks and captures learning after.</p>
		<p>MCP Tools: <code>ace_get_playbook</code> (before) | <code>ace_learn</code> (after)</p>
	</div>

	<button class="refresh-btn" id="refreshBtn">Refresh</button>
	<button class="refresh-btn" id="configureBtn" style="margin-left: 10px;">Configure</button>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		function refresh() {
			vscode.postMessage({ command: 'refresh' });
		}

		function executeCommand(commandId) {
			vscode.postMessage({ command: 'executeCommand', commandId: commandId });
		}

		// Attach event listeners
		(function init() {
			const refreshBtn = document.getElementById('refreshBtn');
			if (refreshBtn) {
				refreshBtn.addEventListener('click', refresh);
			}

			const configureBtn = document.getElementById('configureBtn');
			if (configureBtn) {
				configureBtn.addEventListener('click', () => {
					executeCommand('ace.configure');
				});
			}
		})();

		// Auto-refresh every 60 seconds
		setInterval(() => {
			refresh();
		}, 60000);
	</script>
</body>
</html>`;
	}

	private _getErrorHtml(message: string) {
		const nonce = this._getNonce();
		const cspSource = this._panel.webview.cspSource;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}';">
	<title>ACE Status</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			padding: 40px;
			color: var(--vscode-errorForeground);
			background: var(--vscode-editor-background);
			text-align: center;
		}
		.error-icon {
			font-size: 48px;
			margin-bottom: 20px;
		}
		.configure-btn {
			margin-top: 20px;
			padding: 10px 20px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: 14px;
		}
	</style>
</head>
<body>
	<div class="error-icon">!</div>
	<h2>${message}</h2>
	<p>Use the command palette to configure ACE or check your settings.</p>
	<button class="configure-btn" id="configureBtn">Configure ACE</button>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.getElementById('configureBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'executeCommand', commandId: 'ace.configure' });
		});
	</script>
</body>
</html>`;
	}
}
