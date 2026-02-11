/**
 * ACE Status Panel - Displays playbook statistics
 * Uses @ace-sdk/core for config and auth
 */

import * as vscode from 'vscode';
import { readContext } from '../ace/context';
import { getValidToken, getHardCapInfo } from '../commands/login';
import { loadConfig, loadUserAuth, getDefaultOrgId, getUsagePercentage, isNearLimit, isOverLimit } from '@ace-sdk/core';
import type { UsageInfo, UsageMetric } from '@ace-sdk/core';
import { getLastUsageInfo, getAceClient } from '../ace/client';

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
	 * Uses getValidToken for auto-refresh (sliding window TTL)
	 */
	private async _fetchStatus(ctx: { orgId?: string; projectId: string }): Promise<any> {
		const config = this._getAceConfig();
		if (!config || !config.serverUrl) {
			throw new Error('ACE not fully configured');
		}

		// Get valid user token with auto-refresh (sliding window TTL)
		const tokenResult = await getValidToken(config.serverUrl);
		const token = tokenResult?.token;

		if (!token) {
			throw new Error('No valid authentication token');
		}

		// For user tokens, we need the org ID
		const orgId = ctx.orgId || config.auth?.default_org_id;
		if (!orgId) {
			throw new Error('Organization ID required. Please configure ACE.');
		}

		// Fetch analytics - include X-ACE-Org header for user token auth
		const analyticsUrl = `${config.serverUrl}/analytics`;
		const analyticsResponse = await fetch(analyticsUrl, {
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'X-ACE-Org': orgId,
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
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json',
					'X-ACE-Org': orgId
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

		// Fetch top patterns for display
		let topPatterns: any[] = [];
		try {
			const topUrl = `${config.serverUrl}/top?limit=5&min_helpful=1`;
			const topResponse = await fetch(topUrl, {
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json',
					'X-ACE-Org': orgId,
					'X-ACE-Project': ctx.projectId
				}
			});
			if (topResponse.ok) {
				const topData = await topResponse.json() as Record<string, any>;
				topPatterns = topData.bullets || topData.patterns || [];
			}
		} catch {
			// Ignore top patterns errors - optional display
		}

		// Get org usage data from cached AceClient usage info
		// Usage headers are parsed on every API call via @ace-sdk/core
		let usage: UsageInfo | undefined = getLastUsageInfo();

		// If no cached usage yet, trigger it via AceClient (which parses X-ACE-* headers)
		if (!usage) {
			try {
				const client = getAceClient();
				if (client) {
					// Any SDK call triggers usage header parsing
					await client.getAnalytics();
					usage = client.getLastUsage();
				}
			} catch {
				// Usage data is optional - continue without it
			}
		}

		return {
			...analytics,
			// Support both old and new field names
			total_bullets: analytics.total_patterns || analytics.total_bullets || 0,
			org_id: orgId,
			org_name: orgName,
			project_id: ctx.projectId,
			project_name: projectName,
			top_patterns: topPatterns,
			helpful_total: analytics.helpful_total || 0,
			harmful_total: analytics.harmful_total || 0,
			by_domain: analytics.by_domain || {},
			usage
		};
	}

	/**
	 * Get ACE configuration from global config file
	 * Authentication is handled via @ace-sdk/core device login
	 */
	private _getAceConfig(): { serverUrl?: string; auth?: { token?: string; default_org_id?: string } } | null {
		try {
			// Use SDK to load config - loadConfig returns AceConfig directly
			const config = loadConfig();
			const userAuth = loadUserAuth();

			return {
				serverUrl: config?.serverUrl || 'https://ace-api.code-engine.app',
				auth: userAuth ? {
					token: userAuth.token,
					default_org_id: getDefaultOrgId() || undefined
				} : undefined
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

	/**
	 * Generate HTML for hard cap display
	 * Shows 7-day session hard limit status
	 */
	private _getHardCapHtml(hardCap: { daysRemaining: number; hoursRemaining: number; isApproaching: boolean; isExpired: boolean }): string {
		if (hardCap.isExpired) {
			return `
				<div class="hard-cap-warning expired">
					<div class="hard-cap-icon">⚠️</div>
					<div class="hard-cap-content">
						<div class="hard-cap-title">Session Expired</div>
						<div class="hard-cap-desc">Your 7-day session has expired. Please login again.</div>
					</div>
					<button class="hard-cap-btn" id="loginBtn">Login</button>
				</div>`;
		}

		if (hardCap.isApproaching) {
			return `
				<div class="hard-cap-warning approaching">
					<div class="hard-cap-icon">⏳</div>
					<div class="hard-cap-content">
						<div class="hard-cap-title">Session Expiring Soon</div>
						<div class="hard-cap-desc">Hard cap in ${hardCap.daysRemaining > 0 ? hardCap.daysRemaining + ' day(s)' : hardCap.hoursRemaining + ' hour(s)'}. Re-login before it expires.</div>
					</div>
					<button class="hard-cap-btn" id="loginBtn">Login Now</button>
				</div>`;
		}

		// Normal status - show remaining time
		return `
			<div class="hard-cap-info">
				<span class="hard-cap-label">Session Hard Cap (7d):</span>
				<span class="hard-cap-value">${hardCap.daysRemaining} days remaining</span>
			</div>`;
	}

	/**
	 * Generate HTML for a single usage progress bar
	 */
	private _getUsageBarHtml(label: string, metric: UsageMetric): string {
		const pct = getUsagePercentage(metric);
		const near = isNearLimit(metric);
		const over = isOverLimit(metric);
		const colorClass = over ? 'usage-over' : near ? 'usage-warning' : 'usage-ok';

		return `
			<div class="usage-row">
				<div class="usage-label">${label}</div>
				<div class="usage-bar-container">
					<div class="usage-bar ${colorClass}" style="width: ${pct}%"></div>
				</div>
				<div class="usage-numbers">${metric.used} / ${metric.limit === -1 ? '∞' : metric.limit}</div>
			</div>`;
	}

	/**
	 * Generate HTML for org usage section
	 * Shows plan tier, status, usage progress bars, team info, and features
	 */
	private _getUsageHtml(usage: UsageInfo): string {
		const planLabel = `${usage.subscriptionType}/${usage.planTier}`;
		const statusColor = usage.status === 'active' ? 'var(--vscode-testing-iconPassed)' :
			usage.status === 'trialing' ? 'var(--vscode-textLink-foreground)' :
			usage.status === 'read_only' ? 'var(--vscode-inputValidation-warningBorder)' :
			'var(--vscode-testing-iconFailed)';

		const bars = [
			this._getUsageBarHtml('Patterns (Project)', usage.patterns),
			this._getUsageBarHtml('Patterns (Org)', usage.patternsTotal),
			this._getUsageBarHtml('Projects', usage.projects),
			this._getUsageBarHtml('API Calls', usage.apiCalls),
			this._getUsageBarHtml('Daily Traces', usage.tracesToday),
		].join('');

		const teamHtml = usage.team ? `
			<div class="usage-team">
				<span class="usage-team-label">Team Seats:</span>
				<span class="usage-team-value">${usage.team.seatsUsed} / ${usage.team.seatsLimit}</span>
			</div>` : '';

		const featuresList = [
			usage.features.teams ? 'Teams' : null,
			usage.features.sharing ? 'Sharing' : null,
			usage.features.apiAccess ? 'API Access' : null,
			usage.features.prioritySupport ? 'Priority Support' : null,
		].filter(Boolean);

		const featuresHtml = featuresList.length > 0 ? `
			<div class="usage-features">
				${featuresList.map(f => `<span class="usage-feature-badge">${f}</span>`).join('')}
			</div>` : '';

		return `
		<div class="usage-section">
			<h2>Organization Usage</h2>
			<div class="usage-plan-row">
				<span class="usage-plan-badge ${usage.planTier}">${planLabel}</span>
				<span class="usage-status" style="color: ${statusColor}">${usage.status}</span>
			</div>
			<div class="usage-bars">
				${bars}
			</div>
			${teamHtml}
			${featuresHtml}
		</div>`;
	}

	private _getStatusHtml(stats: any) {
		const bySection = stats.by_section || {};
		const total = stats.total_bullets || 0;
		const avgConf = stats.avg_confidence ? Math.round(stats.avg_confidence * 100) : 0;
		const nonce = this._getNonce();
		const cspSource = this._panel.webview.cspSource;

		// Enhanced metrics
		const topPatterns = stats.top_patterns || [];
		const helpfulTotal = stats.helpful_total || 0;
		const harmfulTotal = stats.harmful_total || 0;
		const byDomain = stats.by_domain || {};
		const trustScore = helpfulTotal + harmfulTotal > 0 
			? Math.round((helpfulTotal / (helpfulTotal + harmfulTotal)) * 100) 
			: 100;

		// Get hard cap info for session expiration display
		const hardCap = getHardCapInfo();
		const hardCapHtml = hardCap ? this._getHardCapHtml(hardCap) : '';

		// Get org usage display
		const usageHtml = stats.usage ? this._getUsageHtml(stats.usage) : '';

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
		.hard-cap-info {
			margin-top: 15px;
			padding: 10px 15px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.hard-cap-label {
			color: var(--vscode-descriptionForeground);
			font-size: 13px;
		}
		.hard-cap-value {
			color: var(--vscode-textLink-foreground);
			font-weight: 500;
		}
		.hard-cap-warning {
			margin-top: 15px;
			padding: 15px;
			border-radius: 6px;
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.hard-cap-warning.approaching {
			background: var(--vscode-inputValidation-warningBackground);
			border: 1px solid var(--vscode-inputValidation-warningBorder);
		}
		.hard-cap-warning.expired {
			background: var(--vscode-inputValidation-errorBackground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
		}
		.hard-cap-icon {
			font-size: 24px;
		}
		.hard-cap-content {
			flex: 1;
		}
		.hard-cap-title {
			font-weight: 600;
			margin-bottom: 4px;
		}
		.hard-cap-desc {
			font-size: 13px;
			color: var(--vscode-descriptionForeground);
		}
		.hard-cap-btn {
			padding: 6px 12px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: 13px;
		}
		.hard-cap-btn:hover {
			background: var(--vscode-button-hoverBackground);
		}
		/* Org usage section */
		.usage-section {
			margin-top: 25px;
			padding: 20px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
		}
		.usage-section h2 {
			margin: 0 0 15px 0;
			font-size: 16px;
		}
		.usage-plan-row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 18px;
		}
		.usage-plan-badge {
			padding: 4px 12px;
			border-radius: 12px;
			font-size: 12px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		.usage-plan-badge.free {
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.usage-plan-badge.basic {
			background: var(--vscode-textLink-foreground);
			color: var(--vscode-editor-background);
		}
		.usage-plan-badge.pro {
			background: linear-gradient(135deg, #7c3aed, #a855f7);
			color: #fff;
		}
		.usage-status {
			font-size: 13px;
			font-weight: 500;
		}
		.usage-bars {
			display: flex;
			flex-direction: column;
			gap: 10px;
		}
		.usage-row {
			display: grid;
			grid-template-columns: 140px 1fr 80px;
			align-items: center;
			gap: 10px;
		}
		.usage-label {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
		}
		.usage-bar-container {
			height: 8px;
			background: var(--vscode-input-background);
			border-radius: 4px;
			overflow: hidden;
		}
		.usage-bar {
			height: 100%;
			border-radius: 4px;
			transition: width 0.3s ease;
		}
		.usage-bar.usage-ok {
			background: var(--vscode-testing-iconPassed);
		}
		.usage-bar.usage-warning {
			background: var(--vscode-inputValidation-warningBorder);
		}
		.usage-bar.usage-over {
			background: var(--vscode-testing-iconFailed);
		}
		.usage-numbers {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			text-align: right;
			font-variant-numeric: tabular-nums;
		}
		.usage-team {
			margin-top: 15px;
			padding-top: 12px;
			border-top: 1px solid var(--vscode-panel-border);
			display: flex;
			justify-content: space-between;
			align-items: center;
		}
		.usage-team-label {
			font-size: 13px;
			color: var(--vscode-descriptionForeground);
		}
		.usage-team-value {
			font-size: 14px;
			font-weight: 600;
			color: var(--vscode-textLink-foreground);
		}
		.usage-features {
			margin-top: 12px;
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}
		.usage-feature-badge {
			padding: 3px 8px;
			border-radius: 10px;
			font-size: 11px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		/* Quality metrics */
		.quality-metrics {
			display: flex;
			gap: 15px;
			margin: 15px 0;
		}
		.quality-item {
			flex: 1;
			padding: 12px;
			background: var(--vscode-list-inactiveSelectionBackground);
			border-radius: 6px;
			text-align: center;
		}
		.quality-value {
			font-size: 24px;
			font-weight: bold;
		}
		.quality-value.positive { color: var(--vscode-testing-iconPassed); }
		.quality-value.negative { color: var(--vscode-testing-iconFailed); }
		.quality-value.neutral { color: var(--vscode-textLink-foreground); }
		.quality-label {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			text-transform: uppercase;
			margin-top: 4px;
		}
		/* Top patterns */
		.top-patterns {
			margin-top: 25px;
		}
		.top-patterns h2 {
			font-size: 16px;
			margin-bottom: 12px;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.pattern-item {
			padding: 12px 15px;
			margin: 8px 0;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-left: 3px solid var(--vscode-textLink-foreground);
			border-radius: 4px;
			font-size: 13px;
			line-height: 1.5;
		}
		.pattern-meta {
			display: flex;
			gap: 12px;
			margin-top: 8px;
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
		}
		.pattern-badge {
			padding: 2px 6px;
			border-radius: 10px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		/* Domain breakdown - collapsible */
		.domain-breakdown {
			margin-top: 25px;
		}
		.domain-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			cursor: pointer;
			padding: 8px 0;
		}
		.domain-header h2 {
			margin: 0;
			font-size: 16px;
		}
		.domain-toggle {
			padding: 4px 12px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			font-size: 12px;
		}
		.domain-toggle:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.domain-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
			gap: 10px;
			margin-top: 10px;
		}
		.domain-grid.collapsed .domain-item:nth-child(n+13) {
			display: none;
		}
		.domain-item {
			padding: 12px 10px;
			background: var(--vscode-list-inactiveSelectionBackground);
			border-radius: 8px;
			text-align: center;
			transition: transform 0.2s, box-shadow 0.2s;
		}
		.domain-item:hover {
			transform: translateY(-2px);
			box-shadow: 0 4px 8px rgba(0,0,0,0.2);
		}
		.domain-name {
			font-size: 11px;
			font-weight: 500;
			margin-bottom: 6px;
			color: var(--vscode-descriptionForeground);
			word-break: break-word;
		}
		.domain-count {
			font-size: 24px;
			font-weight: bold;
			color: var(--vscode-textLink-foreground);
		}
		.domain-summary {
			margin-top: 8px;
			padding: 8px 12px;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			font-size: 12px;
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

	${hardCapHtml}

	${usageHtml}

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

	<!-- Quality Metrics -->
	<div class="quality-metrics">
		<div class="quality-item">
			<div class="quality-value positive">${helpfulTotal}</div>
			<div class="quality-label">👍 Helpful</div>
		</div>
		<div class="quality-item">
			<div class="quality-value negative">${harmfulTotal}</div>
			<div class="quality-label">👎 Harmful</div>
		</div>
		<div class="quality-item">
			<div class="quality-value neutral">${trustScore}%</div>
			<div class="quality-label">🎯 Trust Score</div>
		</div>
	</div>

	<!-- Top Patterns -->
	${topPatterns.length > 0 ? `
	<div class="top-patterns">
		<h2>🏆 Top Performing Patterns</h2>
		${topPatterns.slice(0, 5).map((p: any) => `
			<div class="pattern-item">
				${p.content?.substring(0, 200)}${p.content?.length > 200 ? '...' : ''}
				<div class="pattern-meta">
					<span class="pattern-badge">${p.section?.replace(/_/g, ' ') || 'general'}</span>
					<span>👍 ${p.helpful || 0}</span>
					<span>📊 ${Math.round((p.confidence || 0) * 100)}% confidence</span>
					${p.domain ? `<span>🏷️ ${p.domain}</span>` : ''}
				</div>
			</div>
		`).join('')}
	</div>
	` : ''}

	<!-- Domain Breakdown -->
	${Object.keys(byDomain).length > 0 ? `
	<div class="domain-breakdown">
		<div class="domain-header" id="domainHeader">
			<h2>🗂️ Patterns by Domain (${Object.keys(byDomain).length} domains)</h2>
			<button class="domain-toggle" id="domainToggle">${Object.keys(byDomain).length > 12 ? 'Show All' : ''}</button>
		</div>
		<div class="domain-grid ${Object.keys(byDomain).length > 12 ? 'collapsed' : ''}" id="domainGrid">
			${Object.entries(byDomain)
				.sort((a: [string, any], b: [string, any]) => (b[1] as number) - (a[1] as number))
				.map(([domain, count]: [string, any]) => `
				<div class="domain-item">
					<div class="domain-name">${domain.replace(/-/g, ' ')}</div>
					<div class="domain-count">${count}</div>
				</div>
			`).join('')}
		</div>
		${Object.keys(byDomain).length > 12 ? `
		<div class="domain-summary" id="domainSummary">
			Showing top 12 of ${Object.keys(byDomain).length} domains · Total: ${Object.values(byDomain).reduce((a: number, b: any) => a + (b as number), 0)} patterns
		</div>
		` : `
		<div class="domain-summary">
			${Object.keys(byDomain).length} domains · Total: ${Object.values(byDomain).reduce((a: number, b: any) => a + (b as number), 0)} patterns
		</div>
		`}
	</div>
	` : ''}

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

			const loginBtn = document.getElementById('loginBtn');
			if (loginBtn) {
				loginBtn.addEventListener('click', () => {
					executeCommand('ace.login');
				});
			}

			// Domain breakdown expand/collapse toggle
			const domainToggle = document.getElementById('domainToggle');
			const domainGrid = document.getElementById('domainGrid');
			const domainSummary = document.getElementById('domainSummary');
			if (domainToggle && domainGrid) {
				domainToggle.addEventListener('click', () => {
					const isCollapsed = domainGrid.classList.contains('collapsed');
					if (isCollapsed) {
						domainGrid.classList.remove('collapsed');
						domainToggle.textContent = 'Show Less';
						if (domainSummary) {
							domainSummary.textContent = 'Showing all domains';
						}
					} else {
						domainGrid.classList.add('collapsed');
						domainToggle.textContent = 'Show All';
						if (domainSummary) {
							const totalDomains = domainGrid.children.length;
							domainSummary.textContent = 'Showing top 12 of ' + totalDomains + ' domains';
						}
					}
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
