/**
 * ACE Client Factory with Quota Warning Callbacks
 * 
 * Provides centralized AceClient creation with quota monitoring callbacks.
 * Pattern modeled after ace-vscode extension implementation.
 * 
 * @since v0.2.49
 */

import * as vscode from 'vscode';
import {
	AceClient,
	type AceContext,
	type AceClientOptions,
	type UsageInfo,
	loadUserAuth,
	loadConfig,
	getDefaultOrgId,
	DEFAULT_RUNTIME_SETTINGS,
	isAuthenticated as sdkIsAuthenticated,
} from '@ace-sdk/core';
import { readContext } from './context';

// Cache clients per folder (keyed by folder URI string)
const clientCache = new Map<string, AceClient>();

// Track last usage info for status bar updates
let lastUsageInfo: UsageInfo | undefined;

// Track quota warnings to avoid spamming (keyed by resource name)
const shownQuotaWarnings = new Set<string>();

/**
 * Gets the last known usage info (from quota callbacks).
 */
export function getLastUsageInfo(): UsageInfo | undefined {
	return lastUsageInfo;
}

/**
 * Clears the quota warning tracking (e.g., on new session or extension deactivation).
 */
export function clearQuotaWarningTracking(): void {
	shownQuotaWarnings.clear();
}

/**
 * Gets the user token from device login.
 * Returns null if not authenticated.
 */
function getUserToken(): string | null {
	const userAuth = loadUserAuth();
	return userAuth?.token ?? null;
}

/**
 * Gets project configuration for a specific folder.
 * Returns null if not configured.
 */
function getProjectConfig(folder?: vscode.WorkspaceFolder): {
	serverUrl: string;
	projectId: string;
	orgId: string;
} | null {
	const sdkConfig = loadConfig();
	const ctx = readContext(folder);

	if (!sdkConfig?.serverUrl || !ctx?.projectId) {
		return null;
	}

	const orgId = ctx.orgId || getDefaultOrgId();
	if (!orgId) {
		return null;
	}

	return {
		serverUrl: sdkConfig.serverUrl,
		projectId: ctx.projectId,
		orgId,
	};
}

/**
 * Gets or creates the ACE SDK client for a specific folder.
 * Uses token from device login plus folder/workspace settings.
 * Includes quota warning callbacks for subscription monitoring.
 *
 * @param folder - Optional workspace folder. If not provided, uses workspace-level config.
 * @returns AceClient instance or null if not configured
 */
export function getAceClient(folder?: vscode.WorkspaceFolder): AceClient | null {
	const projectConfig = getProjectConfig(folder);
	const token = getUserToken();

	// Need both project config and a valid token from device login
	if (!token || !projectConfig) {
		return null;
	}

	// Create cache key from folder URI or use 'default' for workspace-level
	const cacheKey = folder?.uri.toString() ?? 'default';

	// Check cache first
	const cached = clientCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	// Create AceContext for the client
	const config: AceContext = {
		serverUrl: projectConfig.serverUrl,
		apiToken: token,
		projectId: projectConfig.projectId,
		orgId: projectConfig.orgId,
		cacheTtlMinutes: 5,
		runtimeSettings: DEFAULT_RUNTIME_SETTINGS,
	};

	// Get feature flags from settings
	const settings = vscode.workspace.getConfiguration('ace');
	const showQuotaWarnings = settings.get<boolean>('features.showQuotaWarnings', true);

	// Create client options with quota callbacks
	const clientOptions: AceClientOptions = {};

	// Usage update callback - tracks last usage for status bar
	clientOptions.onUsageUpdate = (usage: UsageInfo) => {
		lastUsageInfo = usage;
		console.log(`[ACE] Usage update: ${usage.plan} plan, status=${usage.status}`);
	};

	// Quota warning callback - shows notification when >80%
	if (showQuotaWarnings) {
		clientOptions.onQuotaWarning = (message: string, percentage: number, resource: string) => {
			// Only show each warning once per session
			if (!shownQuotaWarnings.has(resource)) {
				shownQuotaWarnings.add(resource);
				vscode.window.showWarningMessage(
					`ACE: ${message}. Consider upgrading your plan.`,
					'View Status'
				).then(selection => {
					if (selection === 'View Status') {
						vscode.commands.executeCommand('ace.status');
					}
				});
				console.log(`[ACE] Quota warning: ${resource} at ${percentage}%`);
			}
		};
	}

	// Read-only mode callback - quota exceeded
	clientOptions.onReadOnlyMode = (daysUntilBlock: number) => {
		vscode.window.showWarningMessage(
			`ACE: Quota exceeded. Account will be blocked in ${daysUntilBlock} days. Please upgrade your plan.`,
			'Upgrade'
		).then(selection => {
			if (selection === 'Upgrade') {
				vscode.env.openExternal(vscode.Uri.parse('https://www.ace-ai.app/dashboard/settings?tab=billing'));
			}
		});
		console.log(`[ACE] Read-only mode: ${daysUntilBlock} days until block`);
	};

	// Account blocked callback
	clientOptions.onAccountBlocked = () => {
		vscode.window.showErrorMessage(
			'ACE: Account blocked due to quota. Please update your payment method.',
			'Manage Account'
		).then(selection => {
			if (selection === 'Manage Account') {
				vscode.env.openExternal(vscode.Uri.parse('https://www.ace-ai.app/dashboard/settings?tab=billing'));
			}
		});
		console.log('[ACE] Account blocked');
	};

	const client = new AceClient(config, clientOptions);

	// Cache for future use
	clientCache.set(cacheKey, client);

	return client;
}

/**
 * Invalidates client cache, forcing recreation on next access.
 * Call this when configuration changes or on extension deactivation.
 * @param folder - Optional folder to invalidate. If not provided, invalidates all.
 */
export function invalidateClient(folder?: vscode.WorkspaceFolder): void {
	if (folder) {
		clientCache.delete(folder.uri.toString());
	} else {
		clientCache.clear();
	}
}

/**
 * Checks if the ACE client can be created for a folder (configuration exists).
 * @param folder - Optional folder to check. If not provided, checks workspace-level.
 */
export function isClientConfigured(folder?: vscode.WorkspaceFolder): boolean {
	const projectConfig = getProjectConfig(folder);
	return sdkIsAuthenticated() && !!projectConfig;
}
