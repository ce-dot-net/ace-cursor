/**
 * ACE Status Panel - Displays playbook statistics
 * Uses @ace-sdk/core for config and auth
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readContext } from '../ace/context';
import { getValidToken, getHardCapInfo } from '../commands/login';
import { loadConfig, loadUserAuth, getDefaultOrgId, getUsagePercentage, isNearLimit, isOverLimit } from '@ace-sdk/core';
import type { UsageInfo, UsageMetric } from '@ace-sdk/core';
import { getLastUsageInfo, getAceClient } from '../ace/client';

/**
 * Escape special HTML characters to prevent XSS injection in webview HTML.
 * Applied to any server-supplied string fields (reward_tier, reason, etc.)
 * before interpolation into HTML templates.
 */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Format a numeric count for display in the status panel.
 *
 * Server-side aggregates (e.g. helpful_total) can arrive as noisy floats like
 * 148.7999999999998. Round to 1 decimal place and strip a trailing ".0" so
 * integers render cleanly (e.g. 5 → "5", 148.7999999999998 → "148.8").
 */
export function formatCount(n: number): string {
	const rounded = Math.round(n * 10) / 10;
	const s = rounded.toFixed(1);
	return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Normalized view of the quality/reward fields returned by /analytics.
 *
 * ACE 1.5 servers send `cumulative_reward_total` (and tier counters).
 * ACE 1.0 servers send only `helpful_total` / `harmful_total`.
 * Discriminator: presence of `cumulative_reward_total` (not truthiness —
 * 0 is a valid 1.5 value and MUST take the 1.5 path).
 */
export interface NormalizedStats {
	/** Defined (incl. 0) when server is ACE 1.5. Undefined on 1.0 servers. */
	rewardTotal: number | undefined;
	hotTotal: number;
	warmTotal: number;
	coldTotal: number;
	atRiskCount: number;
	/** ACE 1.0 legacy fields */
	helpfulTotal: number;
	harmfulTotal: number;
	legacyTrustScore: number;
}

/**
 * Pure adapter — extract reward/legacy fields from a raw analytics payload.
 * Safe to call with any shape; missing fields default to 0.
 */
export function normalizeStats(stats: Record<string, any>): NormalizedStats {
	// typeof-number check: 0 is a valid 1.5 value (kept), but a server `null`
	// (cold-shadow row / error path) must route to the 1.0 fallback — `null !==
	// undefined` is true, so a bare presence check would later throw on .toFixed().
	const rewardTotal: number | undefined =
		typeof stats.cumulative_reward_total === 'number' ? stats.cumulative_reward_total : undefined;
	const hotTotal = stats.hot_total ?? 0;
	const warmTotal = stats.warm_total ?? 0;
	const coldTotal = stats.cold_total ?? 0;
	const atRiskCount = stats.at_risk_count ?? 0;
	// Legacy 1.0 fallback fields
	const helpfulTotal = stats.helpful_total ?? 0;
	const harmfulTotal = stats.harmful_total ?? 0;
	const legacyTrustScore =
		helpfulTotal + harmfulTotal > 0
			? Math.round((helpfulTotal / (helpfulTotal + harmfulTotal)) * 100)
			: 100;
	return { rewardTotal, hotTotal, warmTotal, coldTotal, atRiskCount, helpfulTotal, harmfulTotal, legacyTrustScore };
}

/**
 * Pure renderer — produce the three quality-metric card HTML fragments.
 *
 * 1.5 path (rewardTotal !== undefined): cumulative reward + tier counters + at-risk.
 * 1.0 fallback (rewardTotal === undefined): legacy helpful / harmful / trust-score.
 *
 * rewardTotal is rendered with .toFixed(1) (NOT formatCount) because it is a
 * raw float aggregate, not a rounded integer count.
 */
export function renderQualityCards(ns: NormalizedStats): string {
	if (ns.rewardTotal !== undefined) {
		return `<div class="quality-item">
    <div class="quality-value">${ns.rewardTotal.toFixed(1)}</div>
    <div class="quality-label">Cumulative Reward</div>
</div>
<div class="quality-item">
    <div class="quality-value">${ns.hotTotal} / ${ns.warmTotal} / ${ns.coldTotal}</div>
    <div class="quality-label">Hot / Warm / Cold</div>
</div>
<div class="quality-item">
    <div class="quality-value">${ns.atRiskCount}</div>
    <div class="quality-label">At-Risk Patterns</div>
</div>`;
	}
	// 1.0 server fallback — legacy cards unchanged
	return `<div class="quality-item">
    <div class="quality-value positive">${formatCount(ns.helpfulTotal)}</div>
    <div class="quality-label">👍 Helpful</div>
</div>
<div class="quality-item">
    <div class="quality-value negative">${formatCount(ns.harmfulTotal)}</div>
    <div class="quality-label">👎 Harmful</div>
</div>
<div class="quality-item">
    <div class="quality-value neutral">${ns.legacyTrustScore}%</div>
    <div class="quality-label">🎯 Trust Score</div>
</div>`;
}

// ---------------------------------------------------------------------------
// ACE 1.5 — top-patterns vocab helpers (u07-toppatterns)
// ---------------------------------------------------------------------------

/**
 * Build the URL for fetching top patterns from the ACE server.
 *
 * ACE 1.5 change: drop the legacy `min_helpful=1` filter (it excludes cold-tier
 * 1.5 patterns) and fetch more items so client-side reward-sort can pick the
 * best. The server `/top` path is unchanged (not /patterns/top — see issue #11).
 * NOTE: `min_reward` is a CLI UX alias only; the server does NOT accept it.
 */
export function buildTopPatternsUrl(serverUrl: string, limit: number): string {
	return `${serverUrl}/top?limit=${limit}`;
}

/**
 * Sort an array of patterns by reward descending.
 *
 * 1.5 patterns carry `cumulative_v15_reward`; 1.0 patterns do not.
 * Discriminator: `typeof === 'number'` — 0 is a valid 1.5 value, but a server
 * `null` must fall back to `helpful` (a bare presence check would sort null as 0).
 * Sort key: `cumulative_v15_reward ?? helpful ?? 0`.
 * Returns a new array (does not mutate the input).
 */
export function sortTopPatternsByReward(patterns: Record<string, any>[]): Record<string, any>[] {
	return [...patterns].sort((a, b) => {
		const ra = typeof a.cumulative_v15_reward === 'number' ? a.cumulative_v15_reward : (a.helpful ?? 0);
		const rb = typeof b.cumulative_v15_reward === 'number' ? b.cumulative_v15_reward : (b.helpful ?? 0);
		return rb - ra;
	});
}

/**
 * Render the per-pattern reward/helpful badge.
 *
 * 1.5 path (cumulative_v15_reward is a number): "Reward: 4.20"
 * 1.0 fallback (absent OR null):               "Helpful: N"
 * Discriminator: `typeof === 'number'` — 0 is a valid 1.5 value, but a server
 * `null` must fall back (else `(null).toFixed(2)` throws and collapses the view).
 */
export function renderPatternRewardBadge(p: Record<string, any>): string {
	if (typeof p.cumulative_v15_reward === 'number') {
		return `<span>Reward: ${p.cumulative_v15_reward.toFixed(2)}</span>`;
	}
	return `<span>Helpful: ${formatCount(p.helpful || 0)}</span>`;
}

/**
 * Render the task-summary reward/helpful metric tile from an ace-review-result.json object.
 *
 * ACE 1.5: server populates `reward_delta` + `reward_tier` → renders "0.50 reward (warm)".
 * ACE 1.0 / unpatched: only `helpful_pct` present → renders "30% helpful" (legacy fallback).
 * Discriminator: presence of `reward_delta` (not truthiness — 0 is valid).
 *
 * Returns an empty string when there is no data to show.
 */
export function renderTaskSummaryReward(review: Record<string, any>): string {
	// 1.5 path: reward_delta present and is a number (including 0 — valid reward value).
	// Explicitly exclude null: JSON.parse of a server response can produce null for numeric
	// fields, and null !== undefined evaluates true in JS, so without this guard
	// (null).toFixed(2) would throw a TypeError at runtime.
	if (typeof review.reward_delta === 'number') {
		const delta = (review.reward_delta as number).toFixed(2);
		// Escape tier: reward_tier is a free-form string from the server — no enum
		// constraint in the ACE SDK. Escaping prevents tag/attribute injection in
		// the webview (e.g. `<img src=x onerror=...>` → `&lt;img src=x onerror=...&gt;`).
		const tier = escapeHtml(String(review.reward_tier || 'n/a'));
		return `
				<div class="task-metric">
					<div class="task-metric-value">${delta}</div>
					<div class="task-metric-label">reward (${tier})</div>
				</div>`;
	}
	// 1.0 legacy fallback: helpful_pct > 0
	const helpfulPct = review.helpful_pct || 0;
	if (helpfulPct > 0) {
		return `
				<div class="task-metric">
					<div class="task-metric-value">${helpfulPct}%</div>
					<div class="task-metric-label">helpful</div>
				</div>`;
	}
	return '';
}

/**
 * Renders an org/project meta value: "Name (id)" when a display name exists,
 * else the bare id, else "n/a". `name` and `id` are server-supplied strings
 * and are HTML-escaped to prevent injection into the webview.
 */
export function renderMetaValue(name: any, id: any): string {
	if (name) {
		return `${escapeHtml(String(name))} <span class="meta-id">(${escapeHtml(String(id ?? ''))})</span>`;
	}
	return id ? escapeHtml(String(id)) : 'n/a';
}

/**
 * Truncates a server-supplied pattern content string to `max` chars and
 * HTML-escapes it for safe webview interpolation.
 */
export function formatPatternContent(content: any, max = 200): string {
	const s = String(content ?? '');
	return escapeHtml(s.substring(0, max)) + (s.length > max ? '...' : '');
}

/**
 * Formats a server-supplied domain key for display ("foo-bar" -> "foo bar"),
 * HTML-escaped.
 */
export function formatDomainName(domain: any): string {
	return escapeHtml(String(domain ?? '').replace(/-/g, ' '));
}

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
					'X-ACE-Org': orgId,
					'X-ACE-Project': ctx.projectId
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
		// ACE 1.5: drop min_helpful filter; fetch more and sort client-side by reward
		let topPatterns: any[] = [];
		try {
			const topUrl = buildTopPatternsUrl(config.serverUrl, 10);
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
				const raw: any[] = topData.bullets || topData.patterns || [];
				topPatterns = sortTopPatternsByReward(raw).slice(0, 5);
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
				${featuresList.map(f => `<span class="usage-feature-badge">${escapeHtml(String(f))}</span>`).join('')}
			</div>` : '';

		return `
		<div class="usage-section">
			<h2>Organization Usage</h2>
			<div class="usage-plan-row">
				<span class="usage-plan-badge ${escapeHtml(String(usage.planTier))}">${escapeHtml(String(planLabel))}</span>
				<span class="usage-status" style="color: ${statusColor}">${escapeHtml(String(usage.status))}</span>
			</div>
			<div class="usage-bars">
				${bars}
			</div>
			${teamHtml}
			${featuresHtml}
		</div>`;
	}

	/**
	 * Read local workspace files to build task helpfulness summary
	 */
	private _getTaskSummaryHtml(): string {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			return '';
		}
		const wsRoot = workspaceFolders[0].uri.fsPath;
		const aceDir = path.join(wsRoot, '.cursor', 'ace');
		const relevanceFile = path.join(aceDir, 'ace-relevance.jsonl');
		const reviewFile = path.join(aceDir, 'ace-review-result.json');

		let patternsInjected = 0;
		let domains = new Set<string>();
		let avgRelevance = 0;

		// Parse ace-relevance.jsonl for current task metrics
		if (fs.existsSync(relevanceFile)) {
			try {
				const lines = fs.readFileSync(relevanceFile, 'utf8').split('\n').filter(l => l.trim());
				const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
				// Find last execution boundary
				let lastExec = -1;
				events.forEach((e: any, i: number) => { if (e.event === 'execution') { lastExec = i; } });
				const current = lastExec >= 0 ? events.slice(lastExec + 1) : events;
				const searches = current.filter((e: any) => e.event === 'search');
				patternsInjected = searches.reduce((sum: number, s: any) => sum + (s.patterns_injected || 0), 0);
				searches.forEach((s: any) => { (s.domains || []).forEach((d: string) => domains.add(d)); });
				if (searches.length > 0) {
					avgRelevance = Math.round(
						searches.reduce((sum: number, s: any) => sum + (s.avg_confidence || 0), 0) / searches.length * 100
					);
				}
			} catch {
				// Ignore parse errors
			}
		}

		// Parse ace-review-result.json for self-eval
		let reviewData: Record<string, any> = {};
		let timeSaved = '';
		let reason = '';
		if (fs.existsSync(reviewFile)) {
			try {
				reviewData = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
				timeSaved = reviewData.time_saved || '';
				reason = reviewData.reason || '';
			} catch {
				// Ignore parse errors
			}
		}

		const rewardMetricHtml = renderTaskSummaryReward(reviewData);
		const hasRewardData = rewardMetricHtml.length > 0;

		// Only show if there's data
		if (patternsInjected === 0 && !hasRewardData) {
			return '';
		}

		const relColor = avgRelevance >= 70 ? 'var(--vscode-testing-iconPassed)' :
			avgRelevance >= 40 ? 'var(--vscode-inputValidation-warningBorder)' :
			'var(--vscode-testing-iconFailed)';

		const timeSavedHtml = timeSaved ? `<span class="task-time-saved">~${escapeHtml(String(timeSaved))} saved</span>` : '';
		const reasonHtml = reason ? `<div class="task-reason">"${escapeHtml(String(reason))}"</div>` : '';

		return `
		<div class="task-summary">
			<h2>◆ ACE Task Summary</h2>
			<div class="task-metrics">
				<div class="task-metric">
					<div class="task-metric-value">${patternsInjected}</div>
					<div class="task-metric-label">patterns injected</div>
				</div>
				<div class="task-metric">
					<div class="task-metric-value">${domains.size}</div>
					<div class="task-metric-label">domains</div>
				</div>
				<div class="task-metric">
					<div class="task-metric-value" style="color: ${relColor}">${avgRelevance}%</div>
					<div class="task-metric-label">relevance</div>
				</div>
				${rewardMetricHtml}
			</div>
			${timeSaved || reason ? `
			<div class="task-eval">
				${timeSavedHtml}
				${reasonHtml}
			</div>` : ''}
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
		const byDomain = stats.by_domain || {};
		const ns = normalizeStats(stats);

		// Get hard cap info for session expiration display
		const hardCap = getHardCapInfo();
		const hardCapHtml = hardCap ? this._getHardCapHtml(hardCap) : '';

		// Get org usage display
		const usageHtml = stats.usage ? this._getUsageHtml(stats.usage) : '';

		// Get task helpfulness data from local workspace files
		const taskSummaryHtml = this._getTaskSummaryHtml();

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
		/* Task summary */
		.task-summary {
			background: var(--vscode-editor-inactiveSelectionBackground);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 8px;
			padding: 15px;
			margin: 15px 0;
		}
		.task-summary h2 {
			margin: 0 0 12px 0;
			font-size: 14px;
			color: var(--vscode-textLink-foreground);
		}
		.task-metrics {
			display: flex;
			gap: 15px;
			margin-bottom: 10px;
		}
		.task-metric {
			flex: 1;
			text-align: center;
			padding: 8px;
			background: var(--vscode-editor-background);
			border-radius: 6px;
		}
		.task-metric-value {
			font-size: 20px;
			font-weight: bold;
		}
		.task-metric-label {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin-top: 2px;
		}
		.task-eval {
			padding-top: 8px;
			border-top: 1px solid var(--vscode-panel-border);
		}
		.task-time-saved {
			font-weight: bold;
			color: var(--vscode-testing-iconPassed);
			font-size: 14px;
		}
		.task-reason {
			font-style: italic;
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
			margin-top: 4px;
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
				<span class="meta-value">${renderMetaValue(stats.org_name, stats.org_id)}</span>
			</div>
			<div class="meta-item">
				<span class="meta-label">Project:</span>
				<span class="meta-value">${renderMetaValue(stats.project_name, stats.project_id)}</span>
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

	${taskSummaryHtml}

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
		${renderQualityCards(ns)}
	</div>

	<!-- Top Patterns -->
	${topPatterns.length > 0 ? `
	<div class="top-patterns">
		<h2>🏆 Top Performing Patterns</h2>
		${topPatterns.slice(0, 5).map((p: any) => `
			<div class="pattern-item">
				${formatPatternContent(p.content)}
				<div class="pattern-meta">
					<span class="pattern-badge">${escapeHtml(p.section ? String(p.section).replace(/_/g, ' ') : 'general')}</span>
					${renderPatternRewardBadge(p)}
					<span>📊 ${Math.round((p.confidence || 0) * 100)}% confidence</span>
					${p.domain ? `<span>🏷️ ${escapeHtml(String(p.domain))}</span>` : ''}
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
					<div class="domain-name">${formatDomainName(domain)}</div>
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
