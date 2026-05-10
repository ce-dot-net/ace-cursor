/**
 * ACE for Cursor - Native Extension
 *
 * This extension registers the @ace-sdk/mcp server with Cursor's native MCP API.
 * The AI automatically invokes MCP tools based on their descriptions:
 * - ace_search: "ALWAYS call FIRST" - AI searches relevant patterns before every task
 * - ace_learn: "ALWAYS call AFTER" - AI calls after every substantial task
 *
 * No file watchers, no heuristics - the AI decides based on tool descriptions.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getAceGlobalConfigPath } from './ace/globalConfigPath';
import { getDiagnosticRulesPath } from './ace/diagnosticHelpers';
import { StatusPanel } from './webviews/statusPanel';
import { ConfigurePanel } from './webviews/configurePanel';
import { readContext, readWorkspaceVersion, writeWorkspaceVersion, pickWorkspaceFolder, getTargetFolder, isMultiRootWorkspace, type AceContext } from './ace/context';
import { removeAceHooksFromHooksJson } from './ace/uninstallHelpers';
import { writeFileAtomic } from './ace/atomicWrite';
import { initWorkspaceMonitor, getCurrentFolder, refreshStatusBar } from './automation/workspaceMonitor';
import { runLoginCommand, logout, isAuthenticated, getTokenExpiration, handleAuthError, getValidToken, getHardCapInfo } from './commands/login';
import { AceClient, loadConfig, loadUserAuth, getDefaultOrgId } from '@ace-sdk/core';
import { showDevicesQuickPick } from './commands/devices';
import { getAceClient, clearQuotaWarningTracking, getLastUsageInfo, invalidateClient } from './ace/client';
import {
	getAcePatternsRuleContent,
	getDomainSearchRuleContent,
	getMcpTrackScriptContent,
	getPreToolUseScriptContent,
	getPreToolUsePsScriptContent,
	getSearchHelperContent,
	// v0.5.0 — server-side learn helper + domain-shift inject
	getLearnHelperContent,
	getStopHookScriptContent,
	getDomainShiftScriptContent,
	// v0.5.0-dev.19 Task G — workspace AGENTS.md
	getAgentsMdContent,
} from './ace/hookScripts';
import {
	shouldWriteHooksAndRulesWithoutOptin,
	pickFoldersToInitializeOnAdd,
} from './ace/optInHelpers';
import { cleanupOldExtensionDirs } from './lifecycle/cleanupOldVersions';
import { getAceMcpProxyContent } from './mcp/ace-mcp-proxy';
import { trajectoryLineToUiUpdate } from './ace/trajectoryWatcher';
// v0.5.0-dev.20 — workspace cleanup + initializer overhaul (Tasks C–H).
// v0.5.0-dev.21 — adds migrateLegacyMdRules (RULE.md → RULE.mdc).
import {
	cleanupOrphanScripts,
	archiveLegacyTrajectoryFiles,
	cleanupHiddenToolCache,
	pruneStaleSessions,
	ensureWorkspaceFolders,
	migrateLegacyMdRules,
	migrateLegacySessionsFolder,
} from './ace/workspaceCleanup';

let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

// Output channel for ACE activity visibility
let aceOutput: vscode.OutputChannel | undefined;

/**
 * Get the ACE activity output channel (for use by other modules).
 */
export function getAceOutputChannel(): vscode.OutputChannel | undefined {
	return aceOutput;
}

// Preloaded pattern info for status bar display
let preloadedPatternCount: number = 0;
let preloadedDomains: string[] = [];

// Cursor MCP API types (not in @types/vscode)
// These are injected at runtime by Cursor
interface CursorMcpApi {
	registerServer(config: {
		name: string;
		server: {
			command: string;
			args: string[];
			env?: Record<string, string>;
		};
	}): { dispose(): void };
}

interface CursorApi {
	mcp?: CursorMcpApi;
}

// Access Cursor API via vscode namespace extension
const getCursorApi = (): CursorApi | undefined => {
	return (vscode as any).cursor;
};

/**
 * Preload pattern count on extension activation using /analytics API
 * Uses the same endpoint as the status page for consistent results
 */
async function preloadPatterns(): Promise<void> {
	try {
		// Use AceClient with quota callbacks for proper usage monitoring
		const client = getAceClient();
		if (!client) {
			console.log('[ACE] Preload skipped: no valid client (not configured or not authenticated)');
			return;
		}

		console.log('[ACE] Preload: fetching analytics via AceClient');

		// Show loading animation in status bar
		if (statusBarItem) {
			statusBarItem.text = '$(sync~spin) ACE: Loading patterns...';
		}

		// Use getStatus() which calls /analytics endpoint and triggers quota callbacks
		const analytics = await client.getStatus();
		console.log(`[ACE] Preload: analytics response - total_patterns=${analytics.total_patterns}, total_bullets=${analytics.total_bullets}`);

		// Use total_patterns first (same transformation as status page)
		preloadedPatternCount = analytics.total_patterns || analytics.total_bullets || 0;

		// Extract domains from by_domain
		const byDomain = analytics.by_domain || {};
		preloadedDomains = Object.keys(byDomain);

		console.log(`[ACE] Preloaded ${preloadedPatternCount} patterns from ${preloadedDomains.length} domains`);

		// Write pattern cache for sessionStart hook to read
		try {
			const activeFolder = vscode.workspace.workspaceFolders?.[0];
			if (activeFolder) {
				const cacheDir = path.join(activeFolder.uri.fsPath, '.cursor', 'ace');
				if (!fs.existsSync(cacheDir)) {
					fs.mkdirSync(cacheDir, { recursive: true });
				}
				const cacheData = {
					patternCount: preloadedPatternCount,
					domains: preloadedDomains,
					timestamp: new Date().toISOString(),
				};
				fs.writeFileSync(
					path.join(cacheDir, 'pattern_cache.json'),
					JSON.stringify(cacheData, null, 2)
				);
				console.log('[ACE] Pattern cache written for sessionStart hook');
			}
		} catch (cacheErr) {
			console.log('[ACE] Pattern cache write failed (non-fatal):', cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
		}

		// Update status bar with pattern count - show brief success state
		if (statusBarItem && preloadedPatternCount > 0) {
			statusBarItem.text = `$(check) ACE: ${preloadedPatternCount} patterns loaded`;
			statusBarItem.tooltip = `ACE Pattern Learning\n${preloadedPatternCount} patterns in playbook\nDomains: ${preloadedDomains.slice(0, 3).join(', ')}${preloadedDomains.length > 3 ? ` (+${preloadedDomains.length - 3} more)` : ''}\n\nClick for status`;
			aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Loaded ${preloadedPatternCount} patterns from ${preloadedDomains.length} domains`);
			// Revert to standard format after 3 seconds
			setTimeout(() => {
				if (statusBarItem) {
					statusBarItem.text = `$(book) ACE: ${preloadedPatternCount} patterns`;
				}
			}, 3000);
		}

		aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] ACE activated - monitoring ${preloadedPatternCount} patterns`);

		// Check for quota usage info from the client
		const usageInfo = getLastUsageInfo();
		if (usageInfo) {
			console.log(`[ACE] Usage info: ${usageInfo.plan} plan, status=${usageInfo.status}`);
		}
	} catch (error) {
		console.log('[ACE] Preload error:', error instanceof Error ? error.message : String(error));
		// Non-fatal: continue without preload
	}
}

// Export for external access (e.g., status panel)
export function getPreloadedPatternInfo(): { count: number; domains: string[] } {
	return { count: preloadedPatternCount, domains: preloadedDomains };
}

/**
 * Check auth status on activation and prompt for login if needed
 *
 * WARNING UX FIX (per GitHub issue):
 * - DON'T warn about access token expiration for active users (sliding window extends it!)
 * - ONLY warn about:
 *   1. 7-day hard cap approaching (absolute_expires_at)
 *   2. Refresh token expired (can't auto-recover)
 *   3. Not logged in at all
 */
async function checkAuthOnActivation(): Promise<void> {
	if (!isAuthenticated()) {
		// Not logged in - show gentle prompt (non-blocking)
		vscode.window.showInformationMessage(
			'ACE not configured. Login to enable pattern learning.',
			'Login'
		).then(action => {
			if (action === 'Login') {
				vscode.commands.executeCommand('ace.login');
			}
		});
		return;
	}

	// Check token expiration
	const expiration = getTokenExpiration();
	if (!expiration) return;

	// Check if refresh token expired (can't auto-recover)
	if (expiration.refreshExpires) {
		const refreshExpired = new Date(expiration.refreshExpires).getTime() < Date.now();
		if (refreshExpired) {
			vscode.window.showErrorMessage(
				'ACE session expired. Please login again.',
				'Login'
			).then(action => {
				if (action === 'Login') {
					vscode.commands.executeCommand('ace.login');
				}
			});
			return;
		}
	}

	// Check 7-day hard cap approaching (absolute_expires_at)
	// This is the absolute maximum session duration regardless of activity
	if (expiration.absoluteExpires) {
		const absoluteExpiresAt = new Date(expiration.absoluteExpires).getTime();
		const hoursUntilHardCap = (absoluteExpiresAt - Date.now()) / (1000 * 60 * 60);

		if (hoursUntilHardCap < 0) {
			// Already expired
			vscode.window.showErrorMessage(
				'ACE session hard limit reached. Please login again.',
				'Login'
			).then(action => {
				if (action === 'Login') {
					vscode.commands.executeCommand('ace.login');
				}
			});
			return;
		} else if (hoursUntilHardCap < 24) {
			// Approaching hard cap (within 24 hours)
			vscode.window.showWarningMessage(
				`ACE session hard limit in ${Math.round(hoursUntilHardCap)} hours. Must re-login after 7 days of continuous use.`,
				'Login Now'
			).then(action => {
				if (action === 'Login Now') {
					vscode.commands.executeCommand('ace.login');
				}
			});
		}
	}

	// DO NOT warn about access token expiration for active users!
	// Sliding window extends it on every use (48h extension per API call).
	// The SDK's ensureValidToken() handles auto-refresh transparently.
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('[ACE] Extension activating...');
	extensionContext = context;

	// Ensure SDK auth/config are stored in ephemeral temp location (/tmp by default).
	const aceConfigPath = getAceGlobalConfigPath();
	process.env.ACE_CONFIG_PATH = aceConfigPath;
	try {
		fs.mkdirSync(path.dirname(aceConfigPath), { recursive: true });
	} catch (error) {
		console.warn('[ACE] Failed to ensure ACE config directory:', error instanceof Error ? error.message : String(error));
	}

	// Suppress punycode deprecation warnings from dependencies
	const originalEmitWarning = process.emitWarning;
	process.emitWarning = function(warning: any, ...args: any[]) {
		if (typeof warning === 'object' && warning?.name === 'DeprecationWarning' &&
		    typeof warning?.message === 'string' && warning.message.includes('punycode')) {
			return;
		}
		return originalEmitWarning.call(process, warning, ...args);
	};

	// 1. Create output channel for ACE activity visibility
	aceOutput = vscode.window.createOutputChannel('ACE Activity');
	context.subscriptions.push(aceOutput);
	aceOutput.appendLine(`[${new Date().toLocaleTimeString()}] ACE extension starting...`);

	// 2. Create status bar item so it always shows
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = '$(sync~spin) ACE';  // Initial text while loading
	statusBarItem.command = 'ace.status';
	statusBarItem.tooltip = 'Click to view ACE playbook status';
	context.subscriptions.push(statusBarItem);
	statusBarItem.show();
	console.log('[ACE] Status bar created and shown');

	try {
		// 2. Check if ACE should activate for this workspace (opt-in per workspace)
		const wsConfig = vscode.workspace.getConfiguration('ace');
		const aceEnabledSetting = wsConfig.inspect<boolean>('enabled');
		const aceExplicitlySet = aceEnabledSetting?.workspaceValue !== undefined
			|| aceEnabledSetting?.workspaceFolderValue !== undefined;
		const aceEnabled = wsConfig.get<boolean>('enabled');

		// Check if workspace was previously initialized (has settings.json with version)
		const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const hasAceSettings = wsRoot && fs.existsSync(path.join(wsRoot, '.cursor', 'ace', 'settings.json'));

		// Split opt-in: if .cursor/ exists in any workspace folder, write hooks+rules
		// silently regardless of MCP-registration opt-in. The pre_tool_use gate
		// (commit 1b98ba0) needs hooks present even in /tmp tasks dismissed by user.
		const wsFolders = vscode.workspace.workspaceFolders ?? [];
		for (const f of wsFolders) {
			if (shouldWriteHooksAndRulesWithoutOptin(f.uri.fsPath, fs.existsSync)) {
				try {
					await createCursorHooks(f, false);
					await createCursorRules(f, false);
				} catch (err) {
					console.error(`[ACE] split-optin hooks/rules write failed for ${f.uri.fsPath}:`, err);
				}
			}
		}

		// Multi-root: when user adds a folder mid-session, init it if it has .cursor/
		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
				const eligible = pickFoldersToInitializeOnAdd(event.added, fs.existsSync);
				for (const f of eligible) {
					try {
						await createCursorHooks(f, false);
						await createCursorRules(f, false);
						console.log(`[ACE] Initialized newly added folder ${f.uri.fsPath}`);
					} catch (err) {
						console.error(`[ACE] Failed to init added folder ${f.uri.fsPath}:`, err);
					}
				}
			})
		);

		if (aceExplicitlySet && aceEnabled === false) {
			// User explicitly disabled ACE for this workspace
			console.log('[ACE] Disabled for this workspace (ace.enabled=false)');
			if (statusBarItem) {
				statusBarItem.text = '$(circle-slash) ACE: Disabled';
				statusBarItem.tooltip = 'ACE is disabled for this workspace. Click to configure.';
				statusBarItem.command = 'ace.configure';
			}
			return;
		}

		if (!hasAceSettings && !aceExplicitlySet) {
			// Workspace never had ACE and user hasn't explicitly set ace.enabled
			if (!wsRoot) {
				// No workspace folder (e.g., CI, untitled window) — skip silently
				console.log('[ACE] No workspace folder — skipping initialization');
				return;
			}
			// Show opt-in prompt — don't auto-activate
			console.log('[ACE] New workspace, no ACE settings — showing opt-in prompt');
			const choice = await vscode.window.showInformationMessage(
				'Enable ACE pattern learning for this workspace?',
				'Yes, enable',
				'Not now',
				'Never for this workspace'
			);

			if (choice === 'Never for this workspace') {
				await wsConfig.update('enabled', false, vscode.ConfigurationTarget.Workspace);
				console.log('[ACE] User chose "Never" — disabled for this workspace');
				if (statusBarItem) {
					statusBarItem.text = '$(circle-slash) ACE: Disabled';
					statusBarItem.tooltip = 'ACE disabled for this workspace. Click to configure.';
					statusBarItem.command = 'ace.configure';
				}
				return;
			}

			if (choice !== 'Yes, enable') {
				// "Not now" or dismissed — skip silently, ask again next time
				console.log('[ACE] User chose "Not now" — skipping initialization');
				if (statusBarItem) {
					statusBarItem.text = '$(book) ACE: Not initialized';
					statusBarItem.tooltip = 'Click to initialize ACE for this workspace';
					statusBarItem.command = 'ace.initializeWorkspace';
				}
				return;
			}

			// User chose "Yes, enable" — mark workspace as enabled and continue
			await wsConfig.update('enabled', true, vscode.ConfigurationTarget.Workspace);
			console.log('[ACE] User opted in — initializing workspace');
		}

		// 3. Register MCP server with Cursor
		await registerMcpServer(context);

		// 4. Create Cursor hooks for learning backup
		await createCursorHooks();

		// 5. Create Cursor Rules file for AI instructions
		await createCursorRules();

		// 5b. v0.5.0-dev.19 Task G — write workspace-root AGENTS.md if missing.
		// Cursor 3.0.16+ silently downgrades alwaysApply rules; AGENTS.md is
		// auto-loaded per Cursor docs and unaffected by that bug. Belt+suspenders
		// alongside the globs-based rule.
		try {
			const wsRootForAgents = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (wsRootForAgents) {
				const agentsMdPath = path.join(wsRootForAgents, 'AGENTS.md');
				if (!fs.existsSync(agentsMdPath)) {
					fs.writeFileSync(agentsMdPath, getAgentsMdContent(), 'utf-8');
					aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Created AGENTS.md at workspace root`);
					console.log('[ACE] Created AGENTS.md at workspace root');
				} else {
					console.log('[ACE] AGENTS.md already exists — leaving user customization intact');
				}
			}
		} catch (agentsErr) {
			console.warn('[ACE] AGENTS.md write skipped:', agentsErr instanceof Error ? agentsErr.message : String(agentsErr));
		}

		// 6. Initialize workspace monitor for real-time folder tracking
		console.log('[ACE] Initializing workspace monitor with getAceConfig');
		initWorkspaceMonitor(context, statusBarItem, getAceConfig);

		// 7. Check auth status and prompt for login if needed
		await checkAuthOnActivation();

		// 7. Preload patterns in background (non-blocking)
		// Uses ace_search with generic query to get pattern count + domains for status bar
		preloadPatterns().catch(err => {
			console.log('[ACE] Background preload failed (non-fatal):', err);
		});

		// 8. Watch trajectory files for hook activity indication
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			const trajectoryPattern = new vscode.RelativePattern(workspaceRoot, '.cursor/ace/*.jsonl');
			const trajectoryWatcher = vscode.workspace.createFileSystemWatcher(trajectoryPattern);

			let activityTimeout: NodeJS.Timeout | undefined;
			const showActivity = () => {
				if (!statusBarItem) { return; }
				const currentText = statusBarItem.text;
				// Only flash if not already showing a transient state
				if (!currentText.includes('spin') && !currentText.includes('check')) {
					statusBarItem.text = currentText.replace('$(book)', '$(zap)');
					aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Hook activity detected`);
					clearTimeout(activityTimeout);
					activityTimeout = setTimeout(() => {
						if (statusBarItem && statusBarItem.text.includes('$(zap)')) {
							statusBarItem.text = statusBarItem.text.replace('$(zap)', '$(book)');
						}
					}, 1500);
				}
			};

			trajectoryWatcher.onDidChange(showActivity);
			trajectoryWatcher.onDidCreate(showActivity);
			context.subscriptions.push(trajectoryWatcher);

			// v0.5.0-dev.18 — RICH watcher: parse mcp_trajectory.jsonl tail and
			// surface ace_search/ace_learn lifecycle in status bar + output channel.
			// v0.5.0-dev.19 Task A — trajectories rotated to per-conv subdir:
			// .cursor/ace/tasks/<conv_id>/mcp_trajectory.jsonl. Watch the glob
			// and track lastSize per-file (Map keyed by fsPath) since multiple
			// conv tabs each maintain their own file.
			// v0.5.0-dev.24 — folder renamed sessions/ → tasks/ (one conv_id = one task).
			const mcpTrajPattern = new vscode.RelativePattern(workspaceRoot, '.cursor/ace/tasks/*/mcp_trajectory.jsonl');
			const mcpWatcher = vscode.workspace.createFileSystemWatcher(mcpTrajPattern);
			const lastMcpSizeByFile = new Map<string, number>();
			let idleTimer: NodeJS.Timeout | undefined;
			const scheduleIdleRevert = () => {
				if (idleTimer) { clearTimeout(idleTimer); }
				idleTimer = setTimeout(() => {
					if (statusBarItem) {
						// Revert to idle. workspaceMonitor / preload owns the
						// "real" idle text; we drop back to a generic search icon.
						statusBarItem.text = '$(search) ACE';
						refreshStatusBar();
					}
				}, 5000);
			};
			const onMcpChange = async (uri: vscode.Uri) => {
				try {
					const buf = await vscode.workspace.fs.readFile(uri);
					const key = uri.fsPath;
					const prevSize = lastMcpSizeByFile.get(key) ?? 0;
					const newSlice = buf.length > prevSize ? buf.slice(prevSize) : buf;
					lastMcpSizeByFile.set(key, buf.length);
					const text = Buffer.from(newSlice).toString('utf-8');
					for (const line of text.split('\n')) {
						const trimmed = line.trim();
						if (!trimmed) { continue; }
						const update = trajectoryLineToUiUpdate(trimmed);
						if (!update) { continue; }
						if (statusBarItem) {
							statusBarItem.text = update.statusBarText;
							statusBarItem.show();
						}
						aceOutput?.appendLine(update.outputLine);
						// Only revert to idle on terminal updates (check/error icons),
						// not on spinner ones — those are followed by a result line.
						if (update.statusBarText.includes('$(check)') || update.statusBarText.includes('$(error)')) {
							scheduleIdleRevert();
						}
					}
				} catch {
					// Ignore read errors (file may be transiently locked / removed).
				}
			};
			mcpWatcher.onDidChange(onMcpChange);
			mcpWatcher.onDidCreate(onMcpChange);
			context.subscriptions.push(mcpWatcher);

			// Watch ace-review-result.json for task helpfulness display
			const reviewPattern = new vscode.RelativePattern(workspaceRoot, '.cursor/ace/ace-review-result.json');
			const reviewWatcher = vscode.workspace.createFileSystemWatcher(reviewPattern);

			let reviewTimeout: NodeJS.Timeout | undefined;
			const showTimeSaved = () => {
				if (!statusBarItem) { return; }
				try {
					const reviewPath = path.join(workspaceRoot, '.cursor', 'ace', 'ace-review-result.json');
					if (!fs.existsSync(reviewPath)) { return; }
					const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
					const timeSaved = review.time_saved || '';
					const reason = review.reason || '';
					if (timeSaved) {
						const savedText = `$(clock) ~${timeSaved} saved by ACE`;
						statusBarItem.text = savedText;
						statusBarItem.tooltip = reason ? `ACE: ${reason}` : 'ACE task helpfulness';
						aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Task helpfulness: ~${timeSaved} saved — ${reason}`);
						clearTimeout(reviewTimeout);
						reviewTimeout = setTimeout(() => {
							if (statusBarItem) {
								refreshStatusBar();
							}
						}, 8000);
					}
				} catch {
					// Ignore parse errors
				}
			};

			reviewWatcher.onDidChange(showTimeSaved);
			reviewWatcher.onDidCreate(showTimeSaved);
			context.subscriptions.push(reviewWatcher);
		}

		console.log('[ACE] Extension activated successfully');

		// 9. Check jq availability (needed for hook scripts on Unix/macOS)
		if (process.platform !== 'win32') {
			const { execSync } = require('child_process');
			try {
				execSync('command -v jq', { stdio: 'ignore' });
			} catch {
				console.warn('[ACE] jq not found — some hook features (task helpfulness) will be limited. Install: brew install jq (macOS) or apt install jq (Linux)');
				aceOutput?.appendLine('[ACE] Warning: jq not found. Install jq for full hook functionality (brew install jq / apt install jq)');
			}
		}

		// Clean up older same-publisher extension install dirs (Cursor leaves them behind).
		// Deferred so it doesn't slow activation.
		setTimeout(() => {
			void cleanupOldExtensionDirs(context.extensionPath, context.extension.packageJSON.version)
				.then(({ removed, errors }) => {
					if (removed.length > 0) {
						console.log(`[ACE] Cleaned ${removed.length} old extension dir(s):`, removed);
					}
					if (errors.length > 0) {
						console.warn('[ACE] Old extension dir cleanup partial failures:', errors);
					}
				});

			// v0.5.0-dev.20 Task F — purge any hidden MCP tool cache entries
			// Cursor leaked into ~/.cursor/projects/<proj>/mcps/<srv>/tools/.
			// Best-effort: missing dirs / permission errors are swallowed.
			try {
				const removedTools = cleanupHiddenToolCache(os.homedir());
				if (removedTools.length > 0) {
					console.log(`[ACE] Removed ${removedTools.length} hidden MCP tool cache entry/entries`);
				}
			} catch (err) {
				console.warn('[ACE] cleanupHiddenToolCache failed:', err instanceof Error ? err.message : String(err));
			}
		}, 5000);

		// 10. Check workspace version and prompt for update if needed
		await checkWorkspaceVersionAndPrompt(context);

		// 11. Periodic auth health check — detect token expiry + MCP server errors
		const authHealthInterval = setInterval(() => {
			// Check hard cap expiry
			const hardCap = getHardCapInfo();
			if (hardCap) {
				if (hardCap.isExpired) {
					if (statusBarItem) {
						statusBarItem.text = '$(warning) ACE: Session expired';
						statusBarItem.tooltip = 'ACE session expired. Click to re-login.';
					}
					vscode.window.showErrorMessage(
						'ACE: Session expired (7-day hard cap). Please login again.',
						'Login'
					).then(s => { if (s === 'Login') vscode.commands.executeCommand('ace.login'); });
					clearInterval(authHealthInterval);
					return;
				}
				if (hardCap.isApproaching && hardCap.hoursRemaining <= 12) {
					aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Auth: hard cap in ${hardCap.hoursRemaining}h`);
				}
			}

			// Check refresh token expiry
			const expiration = getTokenExpiration();
			if (expiration?.refreshExpires) {
				const refreshExpired = new Date(expiration.refreshExpires).getTime() < Date.now();
				if (refreshExpired) {
					if (statusBarItem) {
						statusBarItem.text = '$(warning) ACE: Login required';
						statusBarItem.tooltip = 'ACE refresh token expired. Click to re-login.';
					}
					vscode.window.showErrorMessage(
						'ACE: Session expired. Please login again.',
						'Login'
					).then(s => { if (s === 'Login') vscode.commands.executeCommand('ace.login'); });
					clearInterval(authHealthInterval);
					return;
				}
			}

			// Check MCP server status file
			const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (wsRoot) {
				try {
					const projectHash = wsRoot.replace(/\//g, '-').replace(/^-/, '');
					const statusPath = path.join(
						os.homedir(), '.cursor', 'projects', projectHash,
						'mcps', 'user-ce-dot-net.cursor-ace-extension-extension-ace-pattern-learning', 'STATUS.md'
					);
					if (fs.existsSync(statusPath)) {
						const status = fs.readFileSync(statusPath, 'utf8');
						if (status.includes('errored') || status.includes('error')) {
							aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] MCP server in error state — may need reload`);
							if (statusBarItem && !statusBarItem.text.includes('warning')) {
								statusBarItem.text = '$(warning) ACE: MCP error';
								statusBarItem.tooltip = 'ACE MCP server errored. Try: Cmd+Shift+P → Developer: Reload Window';
							}
						}
					}
				} catch {
					// Ignore status check errors
				}
			}
		}, 30 * 60 * 1000); // Every 30 minutes

		context.subscriptions.push({ dispose: () => clearInterval(authHealthInterval) });
	} catch (error) {
		console.error('[ACE] Activation error:', error);
		vscode.window.showErrorMessage(`ACE extension activation failed: ${error instanceof Error ? error.message : String(error)}`);
		// Show error state in status bar
		if (statusBarItem) {
			statusBarItem.text = '$(error) ACE: Error';
			statusBarItem.tooltip = `ACE activation failed: ${error instanceof Error ? error.message : String(error)}`;
			statusBarItem.show();
		}
	}

	// Register UI commands (manual fallbacks)
	context.subscriptions.push(
		vscode.commands.registerCommand('ace.login', runLoginCommand),
		vscode.commands.registerCommand('ace.logout', logout),
		vscode.commands.registerCommand('ace.initializeWorkspace', initializeWorkspace),
		vscode.commands.registerCommand('ace.configure', () => ConfigurePanel.createOrShow(context.extensionUri)),
		vscode.commands.registerCommand('ace.status', () => StatusPanel.createOrShow(context.extensionUri)),
		vscode.commands.registerCommand('ace.search', runSearchCommand),
		vscode.commands.registerCommand('ace.bootstrap', runBootstrapCommand),
		vscode.commands.registerCommand('ace.learn', runLearnCommand),
		vscode.commands.registerCommand('ace.diagnose', runDiagnosticCommand),
		vscode.commands.registerCommand('ace.taskStart', () => {
			vscode.window.showInformationMessage('ACE task tracking is now automatic via MCP. Just start working!');
		}),
		vscode.commands.registerCommand('ace.taskStop', () => {
			vscode.window.showInformationMessage('ACE learning is now automatic via MCP. The AI will capture lessons learned.');
		}),
		vscode.commands.registerCommand('ace.autoSearch', () => {
			vscode.window.showInformationMessage('ACE search is now automatic via MCP. The AI calls ace_search before every task.');
		}),
		vscode.commands.registerCommand('ace.devices', showDevicesQuickPick),
		vscode.commands.registerCommand('ace.uninstallCleanup', runUninstallCleanup)
	);

	// v0.4.0: privacy opt-in marker. Bash hook only injects patterns when this
	// marker exists. We sync from the VS Code setting on activation + on change.
	syncShareRawPromptsOptInMarker();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('ace.shareRawPromptsForRetrievalAnalysis')) {
				syncShareRawPromptsOptInMarker();
			}
		})
	);

	// v0.4.0: auth-status watcher. Bash hook writes "auth_expired" to
	// .cursor/ace/auth-status.txt when ace-cli rejects with token-expired.
	// Surface ONE warning per status change (not per write — file may rewrite).
	registerAuthStatusWatcher(context);
}

/**
 * v0.5.0 TASK 6 — write `runtime-settings.json` per workspace folder with the
 * full runtime toggle set (extensible). Replaces v0.4.0 marker-file-existence
 * scheme. Hooks read this JSON via jq.
 *
 * Schema:
 *   {
 *     "shareRawPromptsForRetrievalAnalysis": true|false,
 *     "lastUpdated": "ISO 8601 timestamp"
 *   }
 *
 * Atomic: writeFileAtomic uses tmp+rename. Old marker file is removed on first
 * sync to keep the workspace clean.
 */
function syncShareRawPromptsOptInMarker(): void {
	const folders = vscode.workspace.workspaceFolders ?? [];
	for (const f of folders) {
		const cfg = vscode.workspace.getConfiguration('ace', f.uri);
		const optedIn = cfg.get<boolean>('shareRawPromptsForRetrievalAnalysis', false);
		const aceDir = path.join(f.uri.fsPath, '.cursor', 'ace');
		const settingsFile = path.join(aceDir, 'runtime-settings.json');
		const legacyMarker = path.join(aceDir, 'share-raw-prompts.optin');
		try {
			fs.mkdirSync(aceDir, { recursive: true });
			// Caveman: write JSON config atomically (tmp+rename via writeFileAtomic).
			const settings = {
				shareRawPromptsForRetrievalAnalysis: !!optedIn,
				lastUpdated: new Date().toISOString(),
			};
			writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + '\n');
			// Remove legacy marker file if it still exists (clean transition).
			if (fs.existsSync(legacyMarker)) {
				try { fs.unlinkSync(legacyMarker); } catch {}
			}
		} catch (e) {
			console.warn(`[ACE] runtime-settings.json sync failed for ${f.uri.fsPath}:`, (e as Error).message);
		}
	}
}

/**
 * v0.4.0 — watch .cursor/ace/auth-status.txt across workspaces. The bash hook
 * writes "auth_expired" when ace-cli reports a token-expired error; we surface
 * ONE warning, then clear the file so the next failure can re-warn.
 */
function registerAuthStatusWatcher(context: vscode.ExtensionContext): void {
	const watcher = vscode.workspace.createFileSystemWatcher('**/.cursor/ace/auth-status.txt');
	const handle = async (uri: vscode.Uri) => {
		try {
			const content = fs.readFileSync(uri.fsPath, 'utf-8').trim();
			if (content === 'auth_expired') {
				const choice = await vscode.window.showWarningMessage(
					'ACE: your session has expired. Auto pattern injection is paused until you re-authenticate.',
					'Login',
					'Dismiss'
				);
				if (choice === 'Login') {
					await vscode.commands.executeCommand('ace.login');
				}
				// Caveman: clear so next failure re-warns. Best-effort, ignore unlink races.
				try { fs.unlinkSync(uri.fsPath); } catch {}
			}
		} catch (e) {
			console.warn('[ACE] auth-status watcher read failed:', (e as Error).message);
		}
	};
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(handle),
		watcher.onDidChange(handle)
	);
}

export function getExtensionContext(): vscode.ExtensionContext | undefined {
	return extensionContext;
}

/**
 * Get the current extension version from package.json
 */
function getExtensionVersion(context: vscode.ExtensionContext): string {
	try {
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf-8')
		);
		return packageJson.version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * v0.5.0-dev.22 Task C — summary returned by initializeWorkspaceForFolder so
 * the caller (checkWorkspaceVersionAndPrompt + ConfigurePanel save) can log
 * what actually changed.
 */
export type InitSummary = {
	migrated: string[];
	removedOrphans: string[];
	archivedLegacy: string[];
	versionFrom: string | undefined;
	versionTo: string;
	// v0.5.0-dev.24 — true when `.cursor/ace/sessions/` was renamed/merged into
	// `.cursor/ace/tasks/` on this activation.
	sessionsFolderMigrated?: boolean;
};

/**
 * Initialize workspace files for a specific folder
 * Used by both auto-init and manual initialization
 * @param folder - Target workspace folder
 * @param version - Extension version to write
 * @param forceUpdate - If true, overwrite existing files
 */
async function initializeWorkspaceForFolder(
	folder: vscode.WorkspaceFolder,
	version: string,
	forceUpdate: boolean = false
): Promise<InitSummary> {
	// v0.5.0-dev.22 — capture pre-init version so we can report from→to.
	const versionFrom = readWorkspaceVersion(folder);

	const summary: InitSummary = {
		migrated: [],
		removedOrphans: [],
		archivedLegacy: [],
		versionFrom,
		versionTo: version,
		sessionsFolderMigrated: false,
	};

	// v0.5.0-dev.24 — rename `.cursor/ace/sessions/` → `.cursor/ace/tasks/` BEFORE
	// ensureWorkspaceFolders/archiveLegacyTrajectoryFiles run, so:
	//   1. ensureWorkspaceFolders doesn't recreate empty `sessions/` next to
	//      the renamed `tasks/`.
	//   2. archiveLegacyTrajectoryFiles writes to `tasks/_legacy/` (the new
	//      canonical location).
	const wsRoot = folder.uri.fsPath;
	try {
		const aceDir = path.join(wsRoot, '.cursor', 'ace');
		if (fs.existsSync(aceDir)) {
			const result = migrateLegacySessionsFolder(aceDir);
			if (result.migrated) {
				summary.sessionsFolderMigrated = true;
				const note = result.mergedFromBoth
					? 'sessions/ → tasks/ folder merged (both existed, non-conflicting subdirs preserved)'
					: 'sessions/ → tasks/ folder migrated';
				console.log(`[ACE] ${note}`);
				aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] [ACE] ${note}`);
			}
		}
	} catch (err) {
		console.warn('[ACE] migrateLegacySessionsFolder failed:', err instanceof Error ? err.message : String(err));
	}

	// v0.5.0-dev.20 Task C — guarantee every required folder exists in one
	// pass (tasks, searches, scripts, rules/*, commands). Idempotent.
	try {
		const created = ensureWorkspaceFolders(wsRoot);
		if (created.length > 0) {
			console.log(`[ACE] Created ${created.length} workspace folder(s):`, created.map(p => path.relative(wsRoot, p)));
		}
	} catch (err) {
		console.warn('[ACE] ensureWorkspaceFolders failed:', err instanceof Error ? err.message : String(err));
	}

	await createCursorHooks(folder, forceUpdate);

	// v0.5.0-dev.21 — Migrate legacy RULE.md files to RULE.mdc BEFORE
	// createCursorRules runs. Per Cursor docs (cursor.com/docs/rules):
	//   - .mdc with frontmatter (description / globs) → auto-attach
	//   - .md → @-mention only (frontmatter ignored)
	// createCursorRules then writes the canonical RULE.mdc content.
	try {
		const rulesDir = path.join(wsRoot, '.cursor', 'rules');
		const result = migrateLegacyMdRules(rulesDir);
		if (result.migrated.length > 0 || result.removed.length > 0) {
			console.log(`[ACE] Migrated ${result.migrated.length} rule file(s) .md → .mdc; removed ${result.removed.length} stale .md sibling(s)`);
			if (result.migrated.length > 0) {
				aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Migrated rule files to .mdc: ${result.migrated.join(', ')}`);
			}
			if (result.removed.length > 0) {
				aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Removed stale .md (sibling .mdc exists): ${result.removed.join(', ')}`);
			}
		}
		summary.migrated = [...result.migrated, ...result.removed];
	} catch (err) {
		console.warn('[ACE] migrateLegacyMdRules failed:', err instanceof Error ? err.message : String(err));
	}

	await createCursorRules(folder, forceUpdate);
	await createCursorCommands(folder, forceUpdate);

	// v0.5.0-dev.20 Tasks D + E + H — workspace cleanup. Run AFTER hooks are
	// regenerated so future writes go to per-conv paths (Task A); archiving
	// the now-stale top-level files is safe because the new scripts won't
	// re-create them when conv_id is present.
	try {
		const scriptsDir = path.join(wsRoot, '.cursor', 'scripts');
		const removed = cleanupOrphanScripts(scriptsDir);
		if (removed.length > 0) {
			console.log('[ACE] Removed orphan scripts:', removed);
			aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Cleaned ${removed.length} orphan script(s): ${removed.join(', ')}`);
		}
		summary.removedOrphans = removed;
	} catch (err) {
		console.warn('[ACE] cleanupOrphanScripts failed:', err instanceof Error ? err.message : String(err));
	}

	try {
		const aceDir = path.join(wsRoot, '.cursor', 'ace');
		const archived = archiveLegacyTrajectoryFiles(aceDir);
		if (archived.length > 0) {
			console.log('[ACE] Archived legacy top-level trajectory files:', archived);
			aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Archived legacy trajectory files: ${archived.join(', ')}`);
		}
		summary.archivedLegacy = archived;
	} catch (err) {
		console.warn('[ACE] archiveLegacyTrajectoryFiles failed:', err instanceof Error ? err.message : String(err));
	}

	try {
		// v0.5.0-dev.24 — `.cursor/ace/tasks/` (renamed from sessions/).
		const tasksDir = path.join(wsRoot, '.cursor', 'ace', 'tasks');
		const pruned = pruneStaleSessions(tasksDir, 30);
		if (pruned.length > 0) {
			console.log(`[ACE] Pruned ${pruned.length} stale task subdir(s) (>30d)`);
		}
	} catch (err) {
		console.warn('[ACE] pruneStaleSessions failed:', err instanceof Error ? err.message : String(err));
	}

	writeWorkspaceVersion(version, folder);

	// v0.4.3: auto-prompt opt-in once per workspace (also fires on version upgrade
	// since this function is the auto-init/update entry point).
	await maybePromptOptIn(folder);

	return summary;
}

// Export for ConfigurePanel save handler (v0.5.0-dev.22 Task A).
export { initializeWorkspaceForFolder, getExtensionVersion };

/**
 * v0.4.4: opt-in is now ON by default. No prompt — just sync the marker.
 * User can disable via Settings → ACE → shareRawPromptsForRetrievalAnalysis.
 */
async function maybePromptOptIn(folder: vscode.WorkspaceFolder): Promise<void> {
	void folder; // marker writing is global, handled by syncShareRawPromptsOptInMarker
	syncShareRawPromptsOptInMarker();
}

/**
 * Check workspace version and auto-initialize or auto-update as needed
 *
 * UX Improvements (v0.2.48):
 * - FIRST INSTALL (no workspace version): Auto-initialize silently
 * - UPDATE (version mismatch): Auto-update and show non-blocking notification
 * - MATCH (versions equal): Do nothing
 *
 * For multi-root workspaces, handles each folder independently
 */
async function checkWorkspaceVersionAndPrompt(context: vscode.ExtensionContext): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		return;
	}

	const extensionVersion = getExtensionVersion(context);

	// Check each folder for ACE initialization
	for (const folder of workspaceFolders) {
		const workspaceVersion = readWorkspaceVersion(folder);
		const folderName = workspaceFolders.length > 1 ? ` for ${folder.name}` : '';

		if (!workspaceVersion) {
			// FIRST INSTALL: Auto-initialize silently
			console.log(`[ACE] First install detected${folderName}, auto-initializing...`);
			await initializeWorkspaceForFolder(folder, extensionVersion, false);
			aceOutput?.appendLine(`[${new Date().toLocaleTimeString()}] Workspace initialized${folderName}`);
			vscode.window.showInformationMessage(
				`ACE: Workspace initialized with ${preloadedPatternCount} patterns. Activity visible in Output > "ACE Activity"`,
				'Show Activity Log'
			).then(selection => {
				if (selection === 'Show Activity Log') {
					aceOutput?.show();
				}
			});
			continue;
		}

		if (workspaceVersion !== extensionVersion) {
			// UPDATE: Auto-update and show non-blocking notification
			console.log(`[ACE] Updating workspace${folderName} from v${workspaceVersion} to v${extensionVersion}`);
			const summary = await initializeWorkspaceForFolder(folder, extensionVersion, true); // forceUpdate=true

			// v0.5.0-dev.22 Task B — explicit user-facing notification + activity log
			vscode.window.showInformationMessage(
				`ACE workspace upgraded to ${extensionVersion}${folderName}. Rules/hooks/scripts updated.`,
				{ modal: false }
			);
			aceOutput?.appendLine(`[ACE] Workspace upgraded from ${summary.versionFrom || 'fresh'} to ${summary.versionTo}`);
			aceOutput?.appendLine(`[ACE]   migrated rules: ${summary.migrated.length}`);
			aceOutput?.appendLine(`[ACE]   cleaned orphans: ${summary.removedOrphans.length}`);
			aceOutput?.appendLine(`[ACE]   archived legacy trajectory: ${summary.archivedLegacy.length}`);
		}
		// MATCH: Do nothing - workspace is up to date
	}
}

/**
 * Register the @ace-sdk/mcp server with Cursor's native MCP API
 */
async function registerMcpServer(context: vscode.ExtensionContext): Promise<void> {
	// Check if Cursor MCP API is available
	const cursorApi = getCursorApi();
	if (!cursorApi?.mcp?.registerServer) {
		console.log('[ACE] Cursor MCP API not available - running in VS Code or older Cursor version');
		vscode.window.showWarningMessage(
			'ACE: Cursor MCP API not available. Automatic pattern retrieval and learning disabled. ' +
			'Use manual commands (ACE: Search, ACE: Learn) instead.'
		);
		return;
	}

	// Get ACE configuration
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		console.log('[ACE] No ACE configuration found - MCP server will use defaults');
	}

	// Get auth token from device login
	const userAuth = loadUserAuth();
	if (!userAuth?.token) {
		console.log('[ACE] No auth token - prompting login');
		vscode.window.showWarningMessage(
			'ACE: Not logged in. Pattern retrieval and learning require authentication.',
			'Login'
		).then(selection => {
			if (selection === 'Login') {
				vscode.commands.executeCommand('ace.login');
			}
		});
		// Still register MCP server — it will fail but Cursor shows error state
		// User can re-login and reload to fix
	}

	// Build environment variables for MCP server
	const env: Record<string, string> = {
		ACE_CLIENT_ID: 'cursor'  // Per-extension analytics tracking (ace-sdk 2.12.0+)
	};
	if (aceConfig?.serverUrl) env.ACE_SERVER_URL = aceConfig.serverUrl;
	if (aceConfig?.projectId) env.ACE_PROJECT_ID = aceConfig.projectId;
	if (aceConfig?.orgId) env.ACE_ORG_ID = aceConfig.orgId;
	if (userAuth?.token) env.ACE_API_TOKEN = userAuth.token;

	// v0.5.0-dev.4 TASK 1 — bake the MCP proxy script into the TRUSTED extension
	// dir, then register the MCP server pointed at `node <proxyPath>` instead of
	// `npx @ace-sdk/mcp`. Proxy filters tools/list to hide ace_get_playbook +
	// ace_learn from the AI's tool list. AI no see, AI no call.
	let mcpCommand = 'npx';
	let mcpArgs: string[] = ['-y', '@ace-sdk/mcp'];
	try {
		const helperDir = path.join(context.extensionPath, 'scripts');
		fs.mkdirSync(helperDir, { recursive: true });
		const proxyPath = path.join(helperDir, 'ace_mcp_proxy.js');
		writeFileAtomic(proxyPath, getAceMcpProxyContent(), { mode: 0o755 });
		mcpCommand = 'node';
		mcpArgs = [proxyPath];
		console.log('[ACE] MCP proxy written:', proxyPath);
	} catch (e) {
		// Caveman: proxy write failed → fall back to direct npx. AI still sees
		// hidden tools, but preToolUse updated_input rewrite (TASK 2) catches.
		console.warn('[ACE] MCP proxy write failed, falling back to direct npx:', (e as Error).message);
	}

	try {
		// Register the MCP server using Cursor's API.
		const disposable = cursorApi.mcp.registerServer({
			name: 'ace-pattern-learning',
			server: {
				command: mcpCommand,
				args: mcpArgs,
				env
			}
		});

		context.subscriptions.push(disposable);
		console.log('[ACE] MCP server registered successfully (command:', mcpCommand, ')');

		// Show success message
		vscode.window.showInformationMessage(
			'ACE MCP server registered! AI will automatically retrieve patterns and capture learning.'
		);
	} catch (error) {
		console.error('[ACE] Failed to register MCP server:', error);
		vscode.window.showErrorMessage(
			`ACE: Failed to register MCP server: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Create Cursor hooks for AI-Trail trajectory tracking
 * Full trajectory capture: MCP tools, shell commands, agent responses, file edits
 * Creates bash scripts on Unix, PowerShell scripts on Windows
 * @param folder - Target workspace folder
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
async function createCursorHooks(folder?: vscode.WorkspaceFolder, forceUpdate: boolean = false): Promise<void> {
	const targetFolder = folder || await getTargetFolder('Select folder for ACE hooks');
	if (!targetFolder) {
		return;
	}

	const workspaceRoot = targetFolder.uri.fsPath;
	const cursorDir = path.join(workspaceRoot, '.cursor');
	const scriptsDir = path.join(cursorDir, 'scripts');
	const isWindows = process.platform === 'win32';

	// Ensure directories exist
	if (!fs.existsSync(cursorDir)) {
		fs.mkdirSync(cursorDir, { recursive: true });
	}
	if (!fs.existsSync(scriptsDir)) {
		fs.mkdirSync(scriptsDir, { recursive: true });
	}

	// Helper to get script command prefix for platform
	const scriptPrefix = isWindows ? 'powershell -ExecutionPolicy Bypass -File ' : '';
	const scriptExt = isWindows ? '.ps1' : '.sh';

	// v0.4.1: Resolve TRUSTED extension install dir for helper.js path baking.
	// Both PS and bash hook templates interpolate this value at write time.
	// Caveman: extensionContext provided by Cursor — workspace cannot influence.
	const aceExtDir = extensionContext ? extensionContext.extensionPath : '';
	if (extensionContext) {
		const helperDir = path.join(extensionContext.extensionPath, 'scripts');
		try {
			fs.mkdirSync(helperDir, { recursive: true });
			const helperPath = path.join(helperDir, 'ace_search_helper.js');
			writeFileAtomic(helperPath, getSearchHelperContent(), { mode: 0o755 });
			// v0.5.0 TASK 1 — write learn helper alongside search helper.
			const learnHelperPath = path.join(helperDir, 'ace_learn_helper.js');
			writeFileAtomic(learnHelperPath, getLearnHelperContent(), { mode: 0o755 });
			// Caveman: kill the v0.4.0 wrapper if it's still around.
			const orphanWrapper = path.join(helperDir, 'ace-search-wrapper.sh');
			if (fs.existsSync(orphanWrapper)) {
				try { fs.unlinkSync(orphanWrapper); console.log('[ACE] Removed obsolete ace-search-wrapper.sh (v0.4.1)'); } catch {}
			}
		} catch (e) {
			console.warn('[ACE] Could not write ace search/learn helpers:', (e as Error).message);
		}
	}

	// Create hooks.json with FULL AI-Trail support
	const hooksPath = path.join(cursorDir, 'hooks.json');
	const hooksConfig = {
		version: 1,
		hooks: {
			// Session lifecycle - inject patterns at start, log at end
			sessionStart: [{
				command: `${scriptPrefix}.cursor/scripts/ace_session_start${scriptExt}`
			}],
			sessionEnd: [{
				command: `${scriptPrefix}.cursor/scripts/ace_session_end${scriptExt}`
			}],
			// MCP tool execution tracking (PostToolUse equivalent).
			// v0.5.0-dev.14: this is the ONLY post-* tracker we keep. Cursor's
			// transcript JSONL already has Shell tool_use, ApplyPatch tool_use,
			// and role:assistant text — but it does NOT include MCP tool RESULTS
			// (only the tool_use call). The mcp_trajectory.jsonl produced by
			// this hook is the only place ace_search response data exists,
			// which the learn helper needs to extract server-assigned
			// session_id and pattern IDs. KEEP.
			afterMCPExecution: [{
				command: `${scriptPrefix}.cursor/scripts/ace_track_mcp${scriptExt}`
			}],
			// v0.5.0-dev.14: REMOVED redundant hooks.
			//   afterShellExecution → ace_track_shell  (transcript has Shell tool_use)
			//   afterAgentResponse  → ace_track_response (transcript has assistant text)
			//   afterFileEdit       → ace_track_edit  (transcript has ApplyPatch tool_use)
			// Keeping ONLY the domain-shift handler on afterFileEdit because it
			// needs to react to file-edit events server-fetch-style (it isn't
			// reading the transcript).
			afterFileEdit: [
				// v0.5.0 TASK 3 — fire domain-shift inject on every Read/Edit. Bash
				// version only on unix; PS counterpart is a no-op stub for Windows.
				{ command: `${scriptPrefix}.cursor/scripts/ace_domain_shift${scriptExt}` },
			],
			// Stop hook with git context aggregation + transcript_path
			stop: [{
				command: `${scriptPrefix}.cursor/scripts/ace_stop_hook${scriptExt}`,
				loop_limit: null
			}],
			// Pre-compaction trajectory preservation
			preCompact: [{
				command: `${scriptPrefix}.cursor/scripts/ace_pre_compact${scriptExt}`
			}],
			// Subagent lifecycle tracking
			subagentStart: [{
				command: `${scriptPrefix}.cursor/scripts/ace_subagent_start${scriptExt}`,
				matcher: ".*"
			}],
			subagentStop: [{
				command: `${scriptPrefix}.cursor/scripts/ace_subagent_stop${scriptExt}`
			}],
			// v0.5.0: preToolUse restored — wraps patterns as <ace-patterns> XML JSON
			// via deny+agent_message. Plus ROI feedback from prior task.
			preToolUse: [{
				command: `${scriptPrefix}.cursor/scripts/ace_pre_tool_use${scriptExt}`
			}],
			// postToolUse path stays for additional_context inject (legacy + helpful).
			postToolUse: [{
				command: `${scriptPrefix}.cursor/scripts/ace_post_tool_use${scriptExt}`
			}],
			postToolUseFailure: [{
				command: `${scriptPrefix}.cursor/scripts/ace_post_tool_use_failure${scriptExt}`
			}],
			// Pre-execution gates
			beforeShellExecution: [{
				command: `${scriptPrefix}.cursor/scripts/ace_before_shell${scriptExt}`,
				matcher: ".*"
			}],
			beforeMCPExecution: [{
				command: `${scriptPrefix}.cursor/scripts/ace_before_mcp${scriptExt}`
			}],
			beforeReadFile: [{
				command: `${scriptPrefix}.cursor/scripts/ace_before_read_file${scriptExt}`
			}],
			// Prompt interception
			beforeSubmitPrompt: [{
				command: `${scriptPrefix}.cursor/scripts/ace_before_submit_prompt${scriptExt}`,
				timeout: 5000
			}],
			// Agent thought capture
			afterAgentThought: [{
				command: `${scriptPrefix}.cursor/scripts/ace_after_agent_thought${scriptExt}`
			}],
			// Tab file hooks
			beforeTabFileRead: [{
				command: `${scriptPrefix}.cursor/scripts/ace_before_tab_file_read${scriptExt}`
			}],
			afterTabFileEdit: [{
				command: `${scriptPrefix}.cursor/scripts/ace_after_tab_file_edit${scriptExt}`
			}]
		}
	};

	// Always update hooks.json to ensure all AI-Trail hooks are present
	let shouldWriteHooks = forceUpdate;  // Force update if version upgrade
	if (forceUpdate) {
		console.log('[ACE] Force updating hooks.json (version upgrade)');
	} else if (!fs.existsSync(hooksPath)) {
		shouldWriteHooks = true;
		console.log('[ACE] Creating hooks.json with AI-Trail support');
	} else {
		try {
			const existingHooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
			// Check if AI-Trail hooks are missing.
			// v0.5.0-dev.14: do NOT check for afterShellExecution/afterAgentResponse
			// any more (those are intentionally REMOVED; transcript covers them).
			const hasAllHooks = existingHooks?.hooks?.afterMCPExecution &&
			                    existingHooks?.hooks?.sessionStart &&
			                    existingHooks?.hooks?.sessionEnd &&
			                    existingHooks?.hooks?.preCompact &&
			                    existingHooks?.hooks?.subagentStart &&
			                    existingHooks?.hooks?.subagentStop &&
			                    existingHooks?.hooks?.preToolUse &&
			                    existingHooks?.hooks?.postToolUse &&
			                    existingHooks?.hooks?.postToolUseFailure &&
			                    existingHooks?.hooks?.beforeShellExecution &&
			                    existingHooks?.hooks?.beforeMCPExecution &&
			                    existingHooks?.hooks?.beforeReadFile &&
			                    existingHooks?.hooks?.beforeSubmitPrompt &&
			                    existingHooks?.hooks?.afterAgentThought &&
			                    existingHooks?.hooks?.beforeTabFileRead &&
			                    existingHooks?.hooks?.afterTabFileEdit;
			if (!hasAllHooks) {
				shouldWriteHooks = true;
				console.log('[ACE] Updating hooks.json with AI-Trail hooks');
			}
			// v0.5.0-dev.14: prune removed hooks from existing installs.
			// If user upgrades from <=0.5.0-dev.13 they still have the redundant
			// afterShellExecution / afterAgentResponse / ace_track_edit handlers
			// firing — those waste process spawns and produce duplicate data.
			const hasRemovedHooks =
				existingHooks?.hooks?.afterShellExecution ||
				existingHooks?.hooks?.afterAgentResponse ||
				(Array.isArray(existingHooks?.hooks?.afterFileEdit) &&
				 existingHooks.hooks.afterFileEdit.some((h: any) => /ace_track_edit/.test(String(h?.command || ''))));
			if (hasRemovedHooks) {
				shouldWriteHooks = true;
				console.log('[ACE] Pruning redundant tracker hooks from hooks.json');
			}
			// Also check platform compatibility
			const stopCmd = existingHooks?.hooks?.stop?.[0]?.command || '';
			if (isWindows && stopCmd.endsWith('.sh')) {
				shouldWriteHooks = true;
				console.log('[ACE] Updating hooks.json for Windows platform');
			}
			if (!isWindows && stopCmd.includes('.ps1')) {
				shouldWriteHooks = true;
				console.log('[ACE] Updating hooks.json for Unix platform');
			}
		} catch {
			shouldWriteHooks = true;
			console.log('[ACE] Recreating invalid hooks.json');
		}
	}

	if (shouldWriteHooks) {
		writeFileAtomic(hooksPath, JSON.stringify(hooksConfig, null, 2));
		console.log('[ACE] hooks.json ready with AI-Trail support');
	}

	// Create all hook scripts for the current platform (pass forceUpdate)
	if (isWindows) {
		createWindowsHookScripts(scriptsDir, forceUpdate);
	} else {
		createUnixHookScripts(scriptsDir, forceUpdate);
	}
}

/**
 * Create Windows PowerShell hook scripts for AI-Trail
 * @param scriptsDir - Directory to write scripts to
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
function createWindowsHookScripts(scriptsDir: string, forceUpdate: boolean = false): void {
	// v0.4.1: TRUSTED extension install dir for helper.js path baking.
	const aceExtDir = extensionContext ? extensionContext.extensionPath : '';
	// MCP Execution Tracking (PostToolUse equivalent)
	const mcpTrackPath = path.join(scriptsDir, 'ace_track_mcp.ps1');
	const mcpTrackScript = `# ACE MCP Tracking Hook - Captures tool executions for AI-Trail
# Also detects ace_learn calls and extracts task helpfulness (TIME_SAVED)
# Input: tool_name, tool_input, result_json, duration

$inputJson = [Console]::In.ReadToEnd()

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

# Always log to trajectory
$inputJson | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8

# Detect ace_learn call — extract helpfulness from tool_input.output
try {
    $data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
    $toolName = if ($data.tool_name) { $data.tool_name } else { "" }
} catch {
    $toolName = ""
}

if ($toolName -match "ace_learn") {
    try {
        # tool_input may be string or object
        $toolInput = $data.tool_input
        if ($toolInput -is [string]) {
            $toolInput = $toolInput | ConvertFrom-Json -ErrorAction SilentlyContinue
        }
        $outputField = if ($toolInput.output) { $toolInput.output } else { "" }
    } catch {
        $outputField = ""
    }

    # Look for TIME_SAVED: Xm | reason on the first line
    $firstLine = ($outputField -split "\\n")[0]
    if ($firstLine -match "^TIME_SAVED:\\s*([^|]+?)\\s*(?:\\|\\s*(.+))?$") {
        $timeSaved = $Matches[1].Trim()
        $reason = if ($Matches[2]) { $Matches[2].Trim().Substring(0, [Math]::Min(200, $Matches[2].Trim().Length)) } else { "" }

        # Extract numeric minutes for helpful_pct
        if ($timeSaved -match "(\\d+)") {
            $minutes = [int]$Matches[1]
        } else {
            $minutes = 0
        }
        # Map time to helpful %: 0m=0%, 1-4m=15%, 5-14m=30%, 15-29m=60%, 30m+=80%
        if ($minutes -ge 30) { $helpfulPct = 80 }
        elseif ($minutes -ge 15) { $helpfulPct = 60 }
        elseif ($minutes -ge 5) { $helpfulPct = 30 }
        elseif ($minutes -gt 0) { $helpfulPct = 15 }
        else { $helpfulPct = 0 }

        # Write review result (overwrites previous)
        $reviewResult = @{
            helpful_pct = $helpfulPct
            time_saved = $timeSaved
            reason = $reason
            timestamp = (Get-Date -Format "o")
        } | ConvertTo-Json -Compress
        $reviewResult | Out-File -FilePath "$aceDir\\ace-review-result.json" -Encoding utf8
    }
}
`;
	// Always update to get ace_learn helpfulness detection
	writeFileAtomic(mcpTrackPath, mcpTrackScript);
	console.log(`[ACE] Updated ace_track_mcp.ps1 with ace_learn helpfulness detection`);

	// Shell Execution Tracking
	const shellTrackPath = path.join(scriptsDir, 'ace_track_shell.ps1');
	const shellTrackScript = `# ACE Shell Tracking Hook - Captures terminal commands for AI-Trail
# Input: command, output, duration

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$input | Out-File -Append -FilePath "$aceDir\\shell_trajectory.jsonl" -Encoding utf8
`;
	if (forceUpdate || !fs.existsSync(shellTrackPath)) {
		writeFileAtomic(shellTrackPath, shellTrackScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_track_shell.ps1`);
	}

	// Agent Response Tracking
	const responseTrackPath = path.join(scriptsDir, 'ace_track_response.ps1');
	const responseTrackScript = `# ACE Response Tracking Hook - Captures agent responses for AI-Trail
# Input: text (assistant final text)

$inputJson = [Console]::In.ReadToEnd()

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

# Log response to trajectory
$inputJson | Out-File -Append -FilePath "$aceDir\\response_trajectory.jsonl" -Encoding utf8
`;
	// Always update response tracking
	writeFileAtomic(responseTrackPath, responseTrackScript);
	console.log('[ACE] Updated ace_track_response.ps1');

	// Session Start Hook - Injects pattern context into new conversations
	const sessionStartPath = path.join(scriptsDir, 'ace_session_start.ps1');
	const sessionStartScript = `# ACE Session Start Hook - Injects pattern context into new conversations
# Input: session_id, is_background_agent, composer_mode
# Output: additional_context, env

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
$sessionId = if ($data.session_id) { $data.session_id } else { "" }
$isBg = if ($data.is_background_agent) { "true" } else { "false" }

# Clear trajectory files from previous session
@("mcp_trajectory.jsonl", "shell_trajectory.jsonl", "edit_trajectory.jsonl", "response_trajectory.jsonl", "ace-relevance.jsonl") | ForEach-Object {
    $trajFile = "$aceDir\\$_"
    if (Test-Path $trajFile) { Clear-Content $trajFile }
}
if (Test-Path "$aceDir\\ace-review-result.json") { Remove-Item "$aceDir\\ace-review-result.json" -Force }

# Save session info
@{session_id=$sessionId; started_at=(Get-Date -Format "o"); is_background=$isBg} | ConvertTo-Json -Compress | Out-File -FilePath "$aceDir\\current_session.json" -Encoding utf8

# Read cached pattern info
$patternCount = 0
$domains = ""
$cacheFile = "$aceDir\\pattern_cache.json"
if (Test-Path $cacheFile) {
    try {
        $cache = Get-Content $cacheFile | ConvertFrom-Json
        $patternCount = $cache.patternCount
        $domains = ($cache.domains -join ", ")
    } catch {}
}

# Build context
if ($patternCount -gt 0) {
    $context = "[ACE Pattern Learning] This project has $patternCount patterns across domains: $domains. Use ace_search MCP tool to retrieve relevant patterns before starting work."
} else {
    $context = "[ACE Pattern Learning] ACE is configured. Use ace_search MCP tool to find patterns relevant to your task."
}

# Return env + additional_context
Write-Output "{\`"env\`": {\`"ACE_SESSION_ID\`": \`"$sessionId\`"}, \`"additional_context\`": \`"$context\`"}"
`;
	if (forceUpdate || !fs.existsSync(sessionStartPath)) {
		writeFileAtomic(sessionStartPath, sessionStartScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_session_start.ps1`);
	}

	// Session End Hook - Logs session analytics
	const sessionEndPath = path.join(scriptsDir, 'ace_session_end.ps1');
	const sessionEndScript = `# ACE Session End Hook - Logs session analytics
# Input: session_id, reason, duration_ms, is_background_agent
# Output: none (fire-and-forget)

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$mcpCount = 0; $shellCount = 0; $editCount = 0; $responseCount = 0
if (Test-Path "$aceDir\\mcp_trajectory.jsonl") { $mcpCount = (Get-Content "$aceDir\\mcp_trajectory.jsonl" | Measure-Object -Line).Lines }
if (Test-Path "$aceDir\\shell_trajectory.jsonl") { $shellCount = (Get-Content "$aceDir\\shell_trajectory.jsonl" | Measure-Object -Line).Lines }
if (Test-Path "$aceDir\\edit_trajectory.jsonl") { $editCount = (Get-Content "$aceDir\\edit_trajectory.jsonl" | Measure-Object -Line).Lines }
if (Test-Path "$aceDir\\response_trajectory.jsonl") { $responseCount = (Get-Content "$aceDir\\response_trajectory.jsonl" | Measure-Object -Line).Lines }

$sessionId = $data.session_id
$reason = if ($data.reason) { $data.reason } else { "unknown" }
$durationMs = if ($data.duration_ms) { $data.duration_ms } else { 0 }

$logEntry = @{
    session_id=$sessionId; reason=$reason; duration_ms=$durationMs
    trajectory=@{mcp=$mcpCount; shell=$shellCount; edits=$editCount; responses=$responseCount}
    ended_at=(Get-Date -Format "o")
} | ConvertTo-Json -Compress

$logEntry | Out-File -Append -FilePath "$aceDir\\session_log.jsonl" -Encoding utf8
`;
	if (forceUpdate || !fs.existsSync(sessionEndPath)) {
		writeFileAtomic(sessionEndPath, sessionEndScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_session_end.ps1`);
	}

	// Pre-Compaction Trajectory Preservation
	const preCompactPath = path.join(scriptsDir, 'ace_pre_compact.ps1');
	const preCompactScript = `# ACE Pre-Compact Hook - Preserves trajectory before context compaction
# Input: trigger, context_usage_percent, context_tokens, message_count, messages_to_compact

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$trigger = if ($data.trigger) { $data.trigger } else { "auto" }
$usagePct = if ($data.context_usage_percent) { $data.context_usage_percent } else { 0 }
$tokens = if ($data.context_tokens) { $data.context_tokens } else { 0 }
$msgCount = if ($data.message_count) { $data.message_count } else { 0 }
$toCompact = if ($data.messages_to_compact) { $data.messages_to_compact } else { 0 }

$mcpCount = if (Test-Path "$aceDir\\mcp_trajectory.jsonl") { (Get-Content "$aceDir\\mcp_trajectory.jsonl" | Measure-Object -Line).Lines } else { 0 }
$shellCount = if (Test-Path "$aceDir\\shell_trajectory.jsonl") { (Get-Content "$aceDir\\shell_trajectory.jsonl" | Measure-Object -Line).Lines } else { 0 }
$editCount = if (Test-Path "$aceDir\\edit_trajectory.jsonl") { (Get-Content "$aceDir\\edit_trajectory.jsonl" | Measure-Object -Line).Lines } else { 0 }
$responseCount = if (Test-Path "$aceDir\\response_trajectory.jsonl") { (Get-Content "$aceDir\\response_trajectory.jsonl" | Measure-Object -Line).Lines } else { 0 }

$snapshot = @{
    trigger=$trigger; context_usage_percent=$usagePct; context_tokens=$tokens
    message_count=$msgCount; messages_to_compact=$toCompact
    trajectory=@{mcp=$mcpCount; shell=$shellCount; edits=$editCount; responses=$responseCount}
    timestamp=(Get-Date -Format "o")
} | ConvertTo-Json -Compress
$snapshot | Out-File -Append -FilePath "$aceDir\\compaction_log.jsonl" -Encoding utf8

$msg = "Context compacting (\${usagePct}% used). AI-Trail preserved: MCP:\${mcpCount} Shell:\${shellCount} Edits:\${editCount} Responses:\${responseCount}"
Write-Output "{\`"user_message\`": \`"$msg\`"}"
`;
	if (forceUpdate || !fs.existsSync(preCompactPath)) {
		writeFileAtomic(preCompactPath, preCompactScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_pre_compact.ps1`);
	}

	// Subagent Start Tracking
	const subagentStartPath = path.join(scriptsDir, 'ace_subagent_start.ps1');
	const subagentStartScript = `# ACE Subagent Start Hook - Tracks subagent spawning for AI-Trail
# Input: subagent_type, prompt, model

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$subagentType = if ($data.subagent_type) { $data.subagent_type } else { "unknown" }
$model = if ($data.model) { $data.model } else { "unknown" }
$promptPreview = if ($data.prompt) { $data.prompt.Substring(0, [Math]::Min(200, $data.prompt.Length)) } else { "" }

$entry = @{event="subagent_start"; type=$subagentType; model=$model; prompt_preview=$promptPreview; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8

Write-Output '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(subagentStartPath)) {
		writeFileAtomic(subagentStartPath, subagentStartScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_subagent_start.ps1`);
	}

	// Subagent Stop Tracking
	const subagentStopPath = path.join(scriptsDir, 'ace_subagent_stop.ps1');
	const subagentStopScript = `# ACE Subagent Stop Hook - Tracks subagent completion for AI-Trail
# Input: subagent_type, status, result, duration, agent_transcript_path

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$subagentType = if ($data.subagent_type) { $data.subagent_type } else { "unknown" }
$status = if ($data.status) { $data.status } else { "unknown" }
$duration = if ($data.duration) { $data.duration } else { 0 }
$transcript = $data.agent_transcript_path
$hasTranscript = if ($transcript) { "true" } else { "false" }

$entry = @{event="subagent_stop"; type=$subagentType; status=$status; duration_ms=$duration; has_transcript=$hasTranscript; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8

if ($transcript) {
    $transcriptEntry = @{subagent_type=$subagentType; transcript_path=$transcript; status=$status; duration_ms=$duration; saved_at=(Get-Date -Format "o")} | ConvertTo-Json -Compress
    $transcriptEntry | Out-File -Append -FilePath "$aceDir\\subagent_transcripts.jsonl" -Encoding utf8
}

exit 0
`;
	if (forceUpdate || !fs.existsSync(subagentStopPath)) {
		writeFileAtomic(subagentStopPath, subagentStopScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_subagent_stop.ps1`);
	}

	// File Edit Tracking with Domain Detection
	const editTrackPath = path.join(scriptsDir, 'ace_track_edit.ps1');
	const editTrackScript = `# ACE Edit Tracking Hook - Captures file edits with domain detection
# Input: file_path, edits[]
# Writes domain state to temp file for MCP Resources (Issue #3 fix)

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$inputJson = [Console]::In.ReadToEnd()
$inputJson | Out-File -Append -FilePath "$aceDir\\edit_trajectory.jsonl" -Encoding utf8

# Domain detection function
function Detect-Domain {
    param([string]$FilePath)
    switch -Regex ($FilePath) {
        '(auth|login|session|jwt)' { return 'auth' }
        '(api|routes|endpoint|controller)' { return 'api' }
        '(cache|redis|memo)' { return 'cache' }
        '(db|migration|model|schema)' { return 'database' }
        '(component|ui|view|\\.tsx|\\.jsx)' { return 'ui' }
        '(test|spec|mock)' { return 'test' }
        default { return 'general' }
    }
}

# Extract file path and detect domain
try {
    $data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
    $filePath = $data.file_path
    if (-not $filePath) { $filePath = $data.path }

    if ($filePath) {
        $currentDomain = Detect-Domain -FilePath $filePath
        $lastDomainFile = "$aceDir\\last_domain.txt"
        $lastDomain = if (Test-Path $lastDomainFile) { Get-Content $lastDomainFile } else { "" }

        if ($currentDomain -ne $lastDomain -and $lastDomain) {
            $shift = @{
                from = $lastDomain
                to = $currentDomain
                file = $filePath
                timestamp = (Get-Date -Format "o")
            } | ConvertTo-Json -Compress
            $shift | Out-File -Append -FilePath "$aceDir\\domain_shifts.log" -Encoding utf8
        }

        $currentDomain | Out-File -FilePath $lastDomainFile -Encoding utf8

        # Write domain state to temp file for MCP Resources
        # MCP server reads this to expose ace://domain/current resource
        $settingsPath = "$aceDir\\settings.json"
        $projectId = "default"
        if (Test-Path $settingsPath) {
            try {
                $settings = Get-Content $settingsPath | ConvertFrom-Json
                if ($settings.projectId) { $projectId = $settings.projectId }
            } catch {}
        }
        $md5 = [System.Security.Cryptography.MD5]::Create()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($projectId)
        $hash = [BitConverter]::ToString($md5.ComputeHash($bytes)).Replace("-","").Substring(0,8).ToLower()
        $tempFile = "$env:TEMP\\ace-domain-$hash.json"
        @{
            domain = $currentDomain
            file = $filePath
            timestamp = (Get-Date -Format "o")
        } | ConvertTo-Json | Out-File -FilePath $tempFile -Encoding utf8
    }
} catch {
    # Silently continue on parse errors
}
`;
	// Always update to get domain detection
	writeFileAtomic(editTrackPath, editTrackScript);
	console.log('[ACE] Updated ace_track_edit.ps1 with MCP temp file');

	// Stop Hook with Git Context Aggregation
	const stopHookPath = path.join(scriptsDir, 'ace_stop_hook.ps1');
	const stopHookScript = `# ACE Stop Hook - Hybrid: trajectory summary + ace_learn fallback nudge
# Primary: afterMCPExecution detects ace_learn (via rules instruction)
# Fallback: if ace_learn wasn't called, nudge the AI via followup_message
# Input: status, loop_count, transcript_path, conversation_id

$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
$status = $data.status
$loopCount = if ($data.loop_count) { $data.loop_count } else { 0 }
$transcriptPath = $data.transcript_path
$convId = $data.conversation_id

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }

# Only process completed tasks
if ($status -ne "completed") {
    Write-Output '{}'
    exit 0
}

# Aggregate trajectory — v0.2.91: count ONLY entries from current conversation.
# See bash counterpart for rationale (cross-session contamination fix).
$gitBranch = git rev-parse --abbrev-ref HEAD 2>$null
if (-not $gitBranch) { $gitBranch = "unknown" }
$gitHash = git rev-parse --short HEAD 2>$null
if (-not $gitHash) { $gitHash = "unknown" }

$mcpCount = 0; $shellCount = 0; $editCount = 0; $responseCount = 0
if ($convId) {
    $q = [char]34
    $convPattern = $q + 'conversation_id' + $q + ':' + $q + $convId + $q
    if (Test-Path "$aceDir\\mcp_trajectory.jsonl") {
        $mcpCount = (Select-String -Path "$aceDir\\mcp_trajectory.jsonl" -Pattern $convPattern -SimpleMatch).Count
    }
    if (Test-Path "$aceDir\\shell_trajectory.jsonl") {
        $shellCount = (Select-String -Path "$aceDir\\shell_trajectory.jsonl" -Pattern $convPattern -SimpleMatch).Count
    }
    if (Test-Path "$aceDir\\edit_trajectory.jsonl") {
        $editCount = (Select-String -Path "$aceDir\\edit_trajectory.jsonl" -Pattern $convPattern -SimpleMatch).Count
    }
    if (Test-Path "$aceDir\\response_trajectory.jsonl") {
        $responseCount = (Select-String -Path "$aceDir\\response_trajectory.jsonl" -Pattern $convPattern -SimpleMatch).Count
    }
}

if ($transcriptPath) {
    @{transcript_path=$transcriptPath; saved_at=(Get-Date -Format "o")} | ConvertTo-Json -Compress | Out-File -FilePath "$aceDir\\last_transcript.json" -Encoding utf8
}

$summary = "MCP:$mcpCount Shell:$shellCount Edits:$editCount Responses:$responseCount"
$entry = @{event="stop"; summary=$summary; git_branch=$gitBranch; git_hash=$gitHash; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -Append -FilePath "$aceDir\\ace-relevance.jsonl" -Encoding utf8

# v0.2.89: edits-only gate. Shell alone (ls /path) is exploration, not
# implementation. AI ran shell to check path missing then asked user, hook
# nudged ace_learn prematurely with success=false. See bash counterpart.
$didRealWork = $editCount -gt 0

if ($loopCount -eq 0 -and -not (Test-Path "$aceDir\\ace-review-result.json") -and $didRealWork) {
    # ace_learn was NOT called and AI did productive work — nudge.
    $msg = "Now call ace_learn to capture what you learned. Start the output field with TIME_SAVED: Xm | reason (estimate minutes saved by ACE patterns, 0 if none helped)."
    Write-Output "{\`"followup_message\`": \`"$msg\`"}"
} else {
    # Either ace_learn already ran, retry loop, OR AI did nothing — stay quiet.
    Write-Output '{}'
}
`;
	// Always update stop hook
	writeFileAtomic(stopHookPath, stopHookScript);
	console.log('[ACE] Updated ace_stop_hook.ps1');

	// v0.5.0: pre-tool-use gate restored on Windows as well. PS variant is a fail-open
	// stub for now (see hookScripts.getPreToolUsePsScriptContent); bash variant does
	// the real <ace-patterns> wrapper + ROI inject work.
	const preToolUsePsPath = path.join(scriptsDir, 'ace_pre_tool_use.ps1');
	writeFileAtomic(preToolUsePsPath, getPreToolUsePsScriptContent());
	console.log('[ACE] Updated ace_pre_tool_use.ps1 (v0.5.0 fail-open stub)');

	// Post-Tool Use Tracking + helper.js pattern injection (v0.4.1, PowerShell).
	// Mirrors the bash hook. $helper is BAKED at write time from
	// extensionContext.extensionPath — workspace cannot influence it.
	const postToolUsePath = path.join(scriptsDir, 'ace_post_tool_use.ps1');
	// Caveman: $helper baked here as a literal. PS forward-slash works fine for node.
	const postToolUseScript = `# ACE Post-Tool Use Hook (v0.4.1) - tracking + helper.js pattern injection
# Input: tool_type, tool_name, tool_input, tool_output, duration, transcript_path, conversation_id, generation_id

$helper = "${aceExtDir}/scripts/ace_search_helper.js"

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$toolType = if ($input.tool_type) { $input.tool_type } else { "unknown" }
$toolName = if ($input.tool_name) { $input.tool_name } else { "unknown" }
$toolOutput = if ($input.tool_output) { $input.tool_output.Substring(0, [Math]::Min(500, $input.tool_output.Length)) } else { "" }
$duration = if ($input.duration) { $input.duration } else { 0 }
$convId = if ($input.conversation_id) { $input.conversation_id } else { "" }
$genId = if ($input.generation_id) { $input.generation_id } else { "" }
$transcript = if ($input.transcript_path) { $input.transcript_path } else { "" }

$entry = @{event="post_tool_use"; tool_type=$toolType; tool_name=$toolName; tool_output=$toolOutput; duration=$duration; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8 -Append

# v0.3.1 injection: only on first non-search tool of generation
if ([string]::IsNullOrEmpty($convId) -or [string]::IsNullOrEmpty($genId)) { Write-Output '{}'; exit 0 }
$flagDir = "$aceDir\\sessions\\$convId"
if (-not (Test-Path $flagDir)) { New-Item -ItemType Directory -Path $flagDir -Force | Out-Null }
$flagFile = "$flagDir\\$genId.patterns-injected"
if (Test-Path $flagFile) { Write-Output '{}'; exit 0 }

# v0.5.0-dev.4 TASK 6 — privacy opt-in via runtime-settings.json. Legacy
# marker file removed in v0.5.0-dev.4 cleanup.
$optIn = $false
$settingsFile = "$aceDir\\runtime-settings.json"
if (Test-Path $settingsFile) {
    try {
        $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json
        if ($settings.shareRawPromptsForRetrievalAnalysis -eq $true) { $optIn = $true }
    } catch {}
}
if (-not $optIn) { Write-Output '{}'; exit 0 }

# If AI already called search-style tool, mark flag and skip
if ($toolName -eq "MCP:ace_search" -or $toolName -eq "ace_search") {
    New-Item -ItemType File -Path $flagFile -Force | Out-Null
    Write-Output '{}'; exit 0
}

# Read user prompt from transcript (last user message, char-truncated to 500).
$prompt = ""
if ((-not [string]::IsNullOrEmpty($transcript)) -and (Test-Path $transcript)) {
    try {
        $userLines = Get-Content -Path $transcript -ErrorAction SilentlyContinue | Where-Object { $_ -match '"role":"user"' }
        if ($userLines -and $userLines.Count -gt 0) {
            $last = $userLines[-1]
            $obj = $last | ConvertFrom-Json -ErrorAction SilentlyContinue
            if ($obj.message -and $obj.message.content) {
                $textParts = @()
                foreach ($c in $obj.message.content) {
                    if ($c.type -eq "text" -and $c.text) { $textParts += $c.text }
                }
                $prompt = ($textParts -join " ")
            } elseif ($obj.content) {
                $prompt = [string]$obj.content
            }
            if ($prompt.Length -gt 500) { $prompt = $prompt.Substring(0, 500) }
        }
    } catch {}
}
if ([string]::IsNullOrEmpty($prompt)) { Write-Output '{}'; exit 0 }

# Helper file must exist; node must be on PATH. Otherwise fail-open.
if (-not (Test-Path $helper)) { Write-Output '{}'; exit 0 }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Output '{}'; exit 0 }

# Spawn node with timeout. PS lacks alarm; use Wait-Process with TimeoutSec.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "node"
$psi.ArgumentList.Add($helper)
$psi.ArgumentList.Add($prompt)
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$patternsJson = ""
$rc = 5
if ($proc.WaitForExit(8000)) {
    $patternsJson = $proc.StandardOutput.ReadToEnd()
    $rc = $proc.ExitCode
} else {
    try { $proc.Kill() } catch {}
    $rc = 4
}

# v0.4.1 — helper exit code taxonomy (SDK team contract).
if ($rc -eq 2) {
    "auth_expired" | Out-File -FilePath "$aceDir\\auth-status.txt" -Encoding utf8
    $warn = "ACE: session expired. Run /ace-login. Pattern injection paused until you re-authenticate."
    $payload = @{additional_context=$warn} | ConvertTo-Json -Compress
    Write-Output $payload
    # Caveman: do NOT touch flag — let next tool call retry once user re-logs in.
    exit 0
}

# Network/server/unknown — silently fail-open, no flag.
if ($rc -ne 0 -or [string]::IsNullOrEmpty($patternsJson) -or $patternsJson.Trim() -eq "{}") {
    Write-Output '{}'; exit 0
}

# Parse similar_patterns array.
try {
    $parsed = $patternsJson | ConvertFrom-Json -ErrorAction SilentlyContinue
} catch {
    Write-Output '{}'; exit 0
}
if (-not $parsed -or -not $parsed.similar_patterns) { Write-Output '{}'; exit 0 }

$lines = @()
foreach ($p in $parsed.similar_patterns) {
    $section = if ($p.section) { $p.section } else { "?" }
    $domain = if ($p.domain) { $p.domain } else { "?" }
    $content = if ($p.content) { $p.content } else { "?" }
    if ($content.Length -gt 200) { $content = $content.Substring(0, 200) }
    $lines += "- [$section/$domain] $content"
}
if ($lines.Count -eq 0) { Write-Output '{}'; exit 0 }

$ctxMsg = "📚 ACE patterns retrieved for: $prompt\`n\`n" + ($lines -join "\`n") + "\`n\`n(Patterns auto-fetched by ACE extension. Do NOT call ace_search unless you need fresh patterns mid-task.)"
$payload = @{additional_context=$ctxMsg} | ConvertTo-Json -Compress
Write-Output $payload

# v0.4.0 plan §5.3 — flag-after-success.
New-Item -ItemType File -Path $flagFile -Force | Out-Null
`;
	if (forceUpdate || !fs.existsSync(postToolUsePath)) {
		writeFileAtomic(postToolUsePath, postToolUseScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_post_tool_use.ps1`);
	}

	// Post-Tool Use Failure Tracking
	const postToolUseFailurePath = path.join(scriptsDir, 'ace_post_tool_use_failure.ps1');
	const postToolUseFailureScript = `# ACE Post-Tool Use Failure Hook - Tracks tool failures
# Input: tool_type, tool_name, error_type, error_message

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$toolType = if ($input.tool_type) { $input.tool_type } else { "unknown" }
$toolName = if ($input.tool_name) { $input.tool_name } else { "unknown" }
$errorType = if ($input.error_type) { $input.error_type } else { "unknown" }
$errorMessage = if ($input.error_message) { $input.error_message.Substring(0, [Math]::Min(500, $input.error_message.Length)) } else { "" }

$entry = @{event="tool_failure"; tool_type=$toolType; tool_name=$toolName; error_type=$errorType; error_message=$errorMessage; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8 -Append

Write-Output '{}'
`;
	if (forceUpdate || !fs.existsSync(postToolUseFailurePath)) {
		writeFileAtomic(postToolUseFailurePath, postToolUseFailureScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_post_tool_use_failure.ps1`);
	}

	// Before Shell Execution Gate
	const beforeShellPath = path.join(scriptsDir, 'ace_before_shell.ps1');
	const beforeShellScript = `# ACE Before Shell Hook - Gates shell command execution
# Input: command

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$command = if ($input.command) { $input.command } else { "" }

$entry = @{event="before_shell"; command=$command; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -FilePath "$aceDir\\shell_trajectory.jsonl" -Encoding utf8 -Append

Write-Output '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeShellPath)) {
		writeFileAtomic(beforeShellPath, beforeShellScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_shell.ps1`);
	}

	// Before MCP Execution Gate
	const beforeMcpPath = path.join(scriptsDir, 'ace_before_mcp.ps1');
	const beforeMcpScript = `# ACE Before MCP Hook - Gates MCP tool execution
# Input: tool_name, tool_input

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$toolName = if ($input.tool_name) { $input.tool_name } else { "unknown" }
$toolInput = if ($input.tool_input) { ($input.tool_input | ConvertTo-Json -Compress).Substring(0, [Math]::Min(500, ($input.tool_input | ConvertTo-Json -Compress).Length)) } else { "{}" }

$entry = @{event="before_mcp"; tool_name=$toolName; tool_input=$toolInput; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8 -Append

Write-Output '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeMcpPath)) {
		writeFileAtomic(beforeMcpPath, beforeMcpScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_mcp.ps1`);
	}

	// Before Read File Gate (minimal - fires frequently)
	const beforeReadFilePath = path.join(scriptsDir, 'ace_before_read_file.ps1');
	const beforeReadFileScript = `# ACE Before Read File Hook - Minimal gate (fires frequently)
Write-Output '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeReadFilePath)) {
		writeFileAtomic(beforeReadFilePath, beforeReadFileScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_read_file.ps1`);
	}

	// Before Submit Prompt - Pattern context injection
	const beforeSubmitPromptPath = path.join(scriptsDir, 'ace_before_submit_prompt.ps1');
	const beforeSubmitPromptScript = `# ACE Before Submit Prompt Hook - Injects pattern context + logs injection for task helpfulness
# Input: prompt_text

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$cacheFile = "$aceDir\\pattern_cache.json"

if (Test-Path $cacheFile) {
    try {
        $cache = Get-Content $cacheFile | ConvertFrom-Json
        $patternCount = $cache.patternCount
        if ($patternCount -gt 0) {
            $domains = if ($cache.domains) { ($cache.domains -join ", ") } else { "" }
            $avgConf = if ($cache.avgConfidence) { $cache.avgConfidence } else { 0 }
            $domainsJson = if ($cache.domains) { ($cache.domains | ForEach-Object { "\`"$_\`"" }) -join ", " } else { "" }
            # Log injection event for task helpfulness tracking
            $logEntry = "{\`"event\`": \`"search\`", \`"patterns_injected\`": $patternCount, \`"domains\`": [$domainsJson], \`"avg_confidence\`": $avgConf, \`"timestamp\`": \`"$(Get-Date -Format 'o')\`"}"
            $logEntry | Out-File -FilePath "$aceDir\\ace-relevance.jsonl" -Encoding utf8 -Append
            Write-Output '{"continue": true}'
        } else {
            Write-Output '{"continue": true}'
        }
    } catch {
        Write-Output '{"continue": true}'
    }
} else {
    Write-Output '{"continue": true}'
}
`;
	// Always update to get relevance logging
	writeFileAtomic(beforeSubmitPromptPath, beforeSubmitPromptScript);
	console.log('[ACE] Updated ace_before_submit_prompt.ps1 with relevance logging');

	// After Agent Thought - Thinking capture
	const afterAgentThoughtPath = path.join(scriptsDir, 'ace_after_agent_thought.ps1');
	const afterAgentThoughtScript = `# ACE After Agent Thought Hook - Captures agent thinking
# Input: text, duration_ms

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$text = if ($input.text) { $input.text.Substring(0, [Math]::Min(300, $input.text.Length)) } else { "" }
$durationMs = if ($input.duration_ms) { $input.duration_ms } else { 0 }

$entry = @{event="agent_thought"; text=$text; duration_ms=$durationMs; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -FilePath "$aceDir\\response_trajectory.jsonl" -Encoding utf8 -Append

Write-Output '{}'
`;
	if (forceUpdate || !fs.existsSync(afterAgentThoughtPath)) {
		writeFileAtomic(afterAgentThoughtPath, afterAgentThoughtScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_after_agent_thought.ps1`);
	}

	// Before Tab File Read (minimal - fires very frequently)
	const beforeTabFileReadPath = path.join(scriptsDir, 'ace_before_tab_file_read.ps1');
	const beforeTabFileReadScript = `# ACE Before Tab File Read Hook - Minimal gate (fires very frequently)
Write-Output '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeTabFileReadPath)) {
		writeFileAtomic(beforeTabFileReadPath, beforeTabFileReadScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_tab_file_read.ps1`);
	}

	// After Tab File Edit - Edit tracking
	const afterTabFileEditPath = path.join(scriptsDir, 'ace_after_tab_file_edit.ps1');
	const afterTabFileEditScript = `# ACE After Tab File Edit Hook - Tracks tab edits
# Input: file_path

$inputJson = [Console]::In.ReadToEnd()
$input = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) {
    New-Item -ItemType Directory -Path $aceDir -Force | Out-Null
}

$filePath = if ($input.file_path) { $input.file_path } else { "" }

$entry = @{event="tab_edit"; file_path=$filePath; timestamp=(Get-Date -Format "o")} | ConvertTo-Json -Compress
$entry | Out-File -FilePath "$aceDir\\edit_trajectory.jsonl" -Encoding utf8 -Append
`;
	if (forceUpdate || !fs.existsSync(afterTabFileEditPath)) {
		writeFileAtomic(afterTabFileEditPath, afterTabFileEditScript);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_after_tab_file_edit.ps1`);
	}

	// v0.5.0 TASK 3 — domain-shift inject (PowerShell stub: no-op).
	// Bash variant does the real work; Windows users skip until ported.
	const domainShiftPsPath = path.join(scriptsDir, 'ace_domain_shift.ps1');
	const domainShiftPsScript = `# ACE Domain-Shift Inject (PowerShell stub) — v0.5.0
# Bash counterpart implements the real logic. PS variant is a no-op until ported.
Write-Output '{}'
exit 0
`;
	writeFileAtomic(domainShiftPsPath, domainShiftPsScript);
}

/**
 * Create Unix bash hook scripts for AI-Trail
 * @param scriptsDir - Directory to write scripts to
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
function createUnixHookScripts(scriptsDir: string, forceUpdate: boolean = false): void {
	// v0.4.1: TRUSTED extension install dir for helper.js path baking.
	const aceExtDir = extensionContext ? extensionContext.extensionPath : '';
	// MCP Execution Tracking (PostToolUse equivalent)
	const mcpTrackPath = path.join(scriptsDir, 'ace_track_mcp.sh');
	const mcpTrackScript = getMcpTrackScriptContent();
	// Always update to get ace_learn helpfulness detection
	writeFileAtomic(mcpTrackPath, mcpTrackScript, { mode: 0o755 });
	console.log(`[ACE] Updated ace_track_mcp.sh with ace_learn helpfulness detection`);

	// v0.5.0-dev.20 Task B — orphan track-script generation removed.
	// dev.14 unhooked afterShellExecution / afterAgentResponse / ace_track_edit
	// from hooks.json (transcript already carries that data). Continuing to
	// write the now-orphan scripts confused users + wasted disk. The scripts
	// (and their .bak buddies) are deleted on activation by
	// cleanupOrphanScripts() — see workspaceCleanup.ts.

	// Session Start Hook - Injects pattern context into new conversations
	const sessionStartPath = path.join(scriptsDir, 'ace_session_start.sh');
	const sessionStartScript = `#!/bin/bash
# ACE Session Start Hook - Injects pattern context into new conversations
# Input: session_id, is_background_agent, composer_mode
# Output: additional_context, env

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // empty')
is_bg=$(echo "$input" | jq -r '.is_background_agent // false')
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

# Clear trajectory files from previous session
> "$ace_dir/mcp_trajectory.jsonl" 2>/dev/null
> "$ace_dir/shell_trajectory.jsonl" 2>/dev/null
> "$ace_dir/edit_trajectory.jsonl" 2>/dev/null
> "$ace_dir/response_trajectory.jsonl" 2>/dev/null
> "$ace_dir/ace-relevance.jsonl" 2>/dev/null
rm -f "$ace_dir/ace-review-result.json" 2>/dev/null

# Save session info
echo "{\\"session_id\\": \\"$session_id\\", \\"started_at\\": \\"$(date -Iseconds)\\", \\"is_background\\": $is_bg}" > "$ace_dir/current_session.json"

# Read cached pattern info (written by extension preloadPatterns)
pattern_count=0
domains=""
if [ -f "$ace_dir/pattern_cache.json" ]; then
  pattern_count=$(jq -r '.patternCount // 0' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "0")
  domains=$(jq -r '.domains // [] | join(", ")' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "")
fi

# Build additional context for the conversation
context=""
if [ "$pattern_count" -gt 0 ] 2>/dev/null; then
  context="[ACE Pattern Learning] This project has $pattern_count patterns across domains: $domains. Use ace_search MCP tool to retrieve relevant patterns before starting work."
else
  context="[ACE Pattern Learning] ACE is configured. Use ace_search MCP tool to find patterns relevant to your task."
fi

# Return env vars + additional_context
echo "{\\"env\\": {\\"ACE_SESSION_ID\\": \\"$session_id\\"}, \\"additional_context\\": \\"$context\\"}"
`;
	if (forceUpdate || !fs.existsSync(sessionStartPath)) {
		writeFileAtomic(sessionStartPath, sessionStartScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_session_start.sh`);
	}

	// Session End Hook - Logs session analytics
	const sessionEndPath = path.join(scriptsDir, 'ace_session_end.sh');
	const sessionEndScript = `#!/bin/bash
# ACE Session End Hook - Logs session analytics
# Input: session_id, reason, duration_ms, is_background_agent, final_status
# Output: none (fire-and-forget)

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

# Count trajectory entries for this session
mcp_count=$(wc -l < "$ace_dir/mcp_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
shell_count=$(wc -l < "$ace_dir/shell_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
edit_count=$(wc -l < "$ace_dir/edit_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
response_count=$(wc -l < "$ace_dir/response_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")

# Append session info + trajectory counts to session log
session_id=$(echo "$input" | jq -r '.session_id // empty')
reason=$(echo "$input" | jq -r '.reason // "unknown"')
duration_ms=$(echo "$input" | jq -r '.duration_ms // 0')

echo "{\\"session_id\\": \\"$session_id\\", \\"reason\\": \\"$reason\\", \\"duration_ms\\": $duration_ms, \\"trajectory\\": {\\"mcp\\": $mcp_count, \\"shell\\": $shell_count, \\"edits\\": $edit_count, \\"responses\\": $response_count}, \\"ended_at\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/session_log.jsonl"

exit 0
`;
	if (forceUpdate || !fs.existsSync(sessionEndPath)) {
		writeFileAtomic(sessionEndPath, sessionEndScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_session_end.sh`);
	}

	// Pre-Compaction Trajectory Preservation
	const preCompactPath = path.join(scriptsDir, 'ace_pre_compact.sh');
	const preCompactScript = `#!/bin/bash
# ACE Pre-Compact Hook - Preserves trajectory before context compaction
# Input: trigger, context_usage_percent, context_tokens, message_count, messages_to_compact

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

trigger=$(echo "$input" | jq -r '.trigger // "auto"')
usage_pct=$(echo "$input" | jq -r '.context_usage_percent // 0')
tokens=$(echo "$input" | jq -r '.context_tokens // 0')
msg_count=$(echo "$input" | jq -r '.message_count // 0')
to_compact=$(echo "$input" | jq -r '.messages_to_compact // 0')

# Count current trajectory entries
mcp_count=$(wc -l < "$ace_dir/mcp_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
shell_count=$(wc -l < "$ace_dir/shell_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
edit_count=$(wc -l < "$ace_dir/edit_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")
response_count=$(wc -l < "$ace_dir/response_trajectory.jsonl" 2>/dev/null | tr -d ' ' || echo "0")

# Save compaction snapshot
echo "{\\"trigger\\": \\"$trigger\\", \\"context_usage_percent\\": $usage_pct, \\"context_tokens\\": $tokens, \\"message_count\\": $msg_count, \\"messages_to_compact\\": $to_compact, \\"trajectory\\": {\\"mcp\\": $mcp_count, \\"shell\\": $shell_count, \\"edits\\": $edit_count, \\"responses\\": $response_count}, \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/compaction_log.jsonl"

# Notify user about compaction with trajectory counts
msg="Context compacting (\${usage_pct}% used). AI-Trail preserved: MCP:$mcp_count Shell:$shell_count Edits:$edit_count Responses:$response_count"
echo "{\\"user_message\\": \\"$msg\\"}"
`;
	if (forceUpdate || !fs.existsSync(preCompactPath)) {
		writeFileAtomic(preCompactPath, preCompactScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_pre_compact.sh`);
	}

	// Subagent Start Tracking
	const subagentStartPath = path.join(scriptsDir, 'ace_subagent_start.sh');
	const subagentStartScript = `#!/bin/bash
# ACE Subagent Start Hook - Tracks subagent spawning for AI-Trail
# Input: subagent_type, prompt, model

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

subagent_type=$(echo "$input" | jq -r '.subagent_type // "unknown"')
model=$(echo "$input" | jq -r '.model // "unknown"')
prompt_preview=$(echo "$input" | jq -r '.prompt // ""' | head -c 200)

echo "{\\"event\\": \\"subagent_start\\", \\"type\\": \\"$subagent_type\\", \\"model\\": \\"$model\\", \\"prompt_preview\\": \\"$prompt_preview\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/mcp_trajectory.jsonl"

# Allow all subagents (no blocking)
echo '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(subagentStartPath)) {
		writeFileAtomic(subagentStartPath, subagentStartScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_subagent_start.sh`);
	}

	// Subagent Stop Tracking
	const subagentStopPath = path.join(scriptsDir, 'ace_subagent_stop.sh');
	const subagentStopScript = `#!/bin/bash
# ACE Subagent Stop Hook - Tracks subagent completion for AI-Trail
# Input: subagent_type, status, result, duration, agent_transcript_path

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

subagent_type=$(echo "$input" | jq -r '.subagent_type // "unknown"')
status=$(echo "$input" | jq -r '.status // "unknown"')
duration=$(echo "$input" | jq -r '.duration // 0')
transcript=$(echo "$input" | jq -r '.agent_transcript_path // empty')

echo "{\\"event\\": \\"subagent_stop\\", \\"type\\": \\"$subagent_type\\", \\"status\\": \\"$status\\", \\"duration_ms\\": $duration, \\"has_transcript\\": $([ -n \\"$transcript\\" ] && echo true || echo false), \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/mcp_trajectory.jsonl"

# Save subagent transcript path if available
if [ -n "$transcript" ]; then
  echo "{\\"subagent_type\\": \\"$subagent_type\\", \\"transcript_path\\": \\"$transcript\\", \\"status\\": \\"$status\\", \\"duration_ms\\": $duration, \\"saved_at\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/subagent_transcripts.jsonl"
fi

exit 0
`;
	if (forceUpdate || !fs.existsSync(subagentStopPath)) {
		writeFileAtomic(subagentStopPath, subagentStopScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_subagent_stop.sh`);
	}

	// v0.5.0-dev.20 Task B — ace_track_edit.sh generation removed (orphan since
	// dev.14, the afterFileEdit hook is now ace_domain_shift.sh). Old file is
	// deleted on activation by cleanupOrphanScripts().

	// v0.5.0 TASK 1 — Stop hook delegates ace_learn to a node helper instead of
	// nudging the AI via followup_message. Helper writes ace-review-result.json
	// for next-prompt ROI inject.
	const stopHookPath = path.join(scriptsDir, 'ace_stop_hook.sh');
	const learnHelperAbs = aceExtDir
		? path.join(aceExtDir, 'scripts', 'ace_learn_helper.js')
		: '';
	const stopHookScript = getStopHookScriptContent(learnHelperAbs);
	writeFileAtomic(stopHookPath, stopHookScript, { mode: 0o755 });
	console.log('[ACE] Updated ace_stop_hook.sh (v0.5.0 — delegates to learn helper)');

	// v0.5.0 TASK 3 — domain-shift inject hook on Read/Edit.
	const domainShiftPath = path.join(scriptsDir, 'ace_domain_shift.sh');
	const searchHelperAbs = aceExtDir
		? path.join(aceExtDir, 'scripts', 'ace_search_helper.js')
		: '';
	writeFileAtomic(domainShiftPath, getDomainShiftScriptContent(searchHelperAbs), { mode: 0o755 });
	console.log('[ACE] Updated ace_domain_shift.sh (v0.5.0 — domain-shift pattern inject)');

	// v0.5.0: pre-tool-use gate restored — wraps patterns as <ace-patterns> XML JSON
	// + injects <ace-roi/> from prior task's ace-review-result.json (TASK 4).
	const preToolUsePath = path.join(scriptsDir, 'ace_pre_tool_use.sh');
	writeFileAtomic(preToolUsePath, getPreToolUseScriptContent(), { mode: 0o755 });
	console.log('[ACE] Updated ace_pre_tool_use.sh (v0.5.0 — wrapped pattern injection + ROI)');

	// v0.4.1: legacy workspace-resident helper.js + extension-path.txt cleanup.
	// Old approach (pre-v0.4.0) wrote helper.js INTO the workspace .cursor/scripts
	// dir and read a workspace-controlled extension-path.txt — workspace-trust
	// escape RCE. v0.4.1 writes helper.js to <extensionPath>/scripts (TRUSTED),
	// so any helper.js still sitting in the workspace scriptsDir is an orphan.
	const orphanHelperJs = path.join(scriptsDir, 'ace_search_helper.js');
	if (fs.existsSync(orphanHelperJs)) {
		try { fs.unlinkSync(orphanHelperJs); console.log('[ACE] Removed obsolete workspace-resident ace_search_helper.js (v0.4.1)'); } catch {}
	}
	const orphanExtPathTxt = path.join(scriptsDir, '..', 'ace', 'extension-path.txt');
	if (fs.existsSync(orphanExtPathTxt)) {
		try { fs.unlinkSync(orphanExtPathTxt); console.log('[ACE] Removed obsolete extension-path.txt (v0.4.0 RCE fix)'); } catch {}
	}

	// Post-Tool Use Tracking + helper.js pattern injection (v0.4.1).
	// SDK team correction: drop ace-cli subprocess; use node + helper.js with
	// @ace-sdk/core in-process. HELPER path is BAKED at write time using
	// extensionContext.extensionPath — workspace cannot influence it.
	// §3: helper exit code 2 → auth-status.txt + warning; §4: opt-in marker
	// gates injection; §5: jq char-truncation, sync timeout, flag-after-success.
	const postToolUsePath = path.join(scriptsDir, 'ace_post_tool_use.sh');
	const postToolUseScript = `#!/bin/bash
# ACE Post-Tool Use Hook - Tracking + v0.4.1 helper.js pattern injection.
# Spawns node "$HELPER" "<prompt>" with HELPER baked at extension-activation
# time from context.extensionPath (TRUSTED — not workspace-controlled).

# Caveman: helper path baked here as a literal. No workspace input on this line.
HELPER="${aceExtDir}/scripts/ace_search_helper.js"

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

tool_type=$(echo "$input" | jq -r '.tool_type // "unknown"')
tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
# v0.4.0: jq char-based slice (UTF-8 safe). Old \`head -c 500\` chopped multibyte chars.
tool_input=$(echo "$input" | jq -r '.tool_input // "{}" | tostring | .[0:500]')
tool_output=$(echo "$input" | jq -r '.tool_output // "" | tostring | .[0:500]')
duration=$(echo "$input" | jq -r '.duration // 0')
conv_id=$(echo "$input" | jq -r '.conversation_id // ""')
gen_id=$(echo "$input" | jq -r '.generation_id // ""')
transcript=$(echo "$input" | jq -r '.transcript_path // ""')

# v0.5.0-dev.20 Task A — per-conv trajectory rotation. Mirror ace_track_mcp.sh.
post_event_line="{\\"event\\": \\"post_tool_use\\", \\"tool_type\\": \\"$tool_type\\", \\"tool_name\\": \\"$tool_name\\", \\"tool_input\\": \\"$tool_input\\", \\"tool_output\\": \\"$tool_output\\", \\"duration\\": $duration, \\"timestamp\\": \\"$(date -Iseconds)\\"}"
if [ -n "$conv_id" ] && [ "$conv_id" != "null" ]; then
  per_conv_dir="$ace_dir/tasks/$conv_id"
  mkdir -p "$per_conv_dir"
  echo "$post_event_line" >> "$per_conv_dir/mcp_trajectory.jsonl"
else
  echo "$post_event_line" >> "$ace_dir/mcp_trajectory.jsonl"
fi

# v0.3.1 injection: only on first non-search tool of generation
[ -z "$conv_id" ] || [ -z "$gen_id" ] && echo '{}' && exit 0
flag_file="$ace_dir/tasks/$conv_id/$gen_id.patterns-injected"
mkdir -p "$ace_dir/tasks/$conv_id"
[ -f "$flag_file" ] && echo '{}' && exit 0

# v0.5.0-dev.4 TASK 6 — privacy opt-in via runtime-settings.json. Legacy
# marker file (share-raw-prompts.optin) was removed in v0.5.0-dev.4 cleanup.
opt_in=0
settings_file="$ace_dir/runtime-settings.json"
if [ -f "$settings_file" ]; then
  raw=$(jq -r '.shareRawPromptsForRetrievalAnalysis // false' "$settings_file" 2>/dev/null || echo "false")
  if [ "$raw" = "true" ]; then opt_in=1; fi
fi
if [ "$opt_in" = "0" ]; then
  echo '{}'
  exit 0
fi

# If AI already called ace_search, mark flag and skip (don't double-inject).
# ace_get_playbook is hidden by the MCP proxy (v0.5.0-dev.4) so we no longer
# need to handle it here.
case "$tool_name" in
  MCP:ace_search|ace_search)
    touch "$flag_file"; echo '{}'; exit 0;;
esac

# Read user prompt from transcript. v0.4.0: jq char-based truncation (UTF-8 safe).
prompt=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  prompt=$(grep '"role":"user"' "$transcript" 2>/dev/null | tail -1 | jq -r '
    (if .message.content and (.message.content | type == "array") then
      [.message.content[] | select(.type=="text") | .text] | join(" ")
    elif .content then .content
    else empty end) | .[0:500]
  ' 2>/dev/null)
fi
[ -z "$prompt" ] && echo '{}' && exit 0

# Helper file must exist (extension writes it at activation). Otherwise fail-open.
[ ! -f "$HELPER" ] && echo '{}' && exit 0
command -v node >/dev/null 2>&1 || { echo '{}'; exit 0; }

# v0.4.0 plan §5 — synchronous timeout. macOS lacks GNU timeout; use perl alarm.
# Capture stdout (JSON), stderr separately (debug only — exit code drives logic).
stderr_file=$(mktemp -t ace-helper-stderr.XXXXXX 2>/dev/null || echo "/tmp/ace-helper-stderr.$$")
patterns_json=""
rc=0
if command -v gtimeout >/dev/null 2>&1; then
  patterns_json=$(gtimeout 8 node "$HELPER" "$prompt" 2>"$stderr_file"); rc=$?
elif command -v timeout >/dev/null 2>&1; then
  patterns_json=$(timeout 8 node "$HELPER" "$prompt" 2>"$stderr_file"); rc=$?
else
  patterns_json=$(perl -e 'alarm 8; exec @ARGV' -- node "$HELPER" "$prompt" 2>"$stderr_file"); rc=$?
fi
rm -f "$stderr_file" 2>/dev/null

# v0.4.1 — helper exit code taxonomy (SDK team contract).
#   2 = TokenExpiredError, 3 = AceApiError 5xx, 4 = network/timeout, 5 = unknown.
if [ "$rc" = "2" ]; then
  # Caveman: write marker for the extension's watcher → showWarningMessage.
  echo "auth_expired" > "$ace_dir/auth-status.txt"
  warn_msg=$(echo "ACE: session expired. Run /ace-login. Pattern injection paused until you re-authenticate." | jq -Rs .)
  cat <<EOF
{"additional_context":$warn_msg}
EOF
  # Caveman: do NOT touch flag — let next tool call retry once user re-logs in.
  exit 0
fi

# Network/server/unknown (rc 3/4/5 or any non-0): silently fail-open, no flag.
if [ "$rc" != "0" ] || [ -z "$patterns_json" ] || [ "$patterns_json" = "{}" ]; then
  echo '{}'
  exit 0
fi

# Parse similar_patterns array. Helper emits SearchResponseWithMetadata JSON.
patterns_text=$(echo "$patterns_json" | jq -r '
  (.similar_patterns // []) |
  map("- [" + (.section // "?") + "/" + (.domain // "?") + "] " + ((.content // "?") | .[0:200])) |
  .[]
' 2>/dev/null)
[ -z "$patterns_text" ] && echo '{}' && exit 0

context_msg="📚 ACE patterns retrieved for: $prompt

$patterns_text

(Patterns auto-fetched by ACE extension. Do NOT call ace_search unless you need fresh patterns mid-task.)"
context_json=$(echo "$context_msg" | jq -Rs .)

cat <<EOF
{"additional_context":$context_json}
EOF

# v0.4.0 plan §5.3 — flag-after-success. Old code touched the flag before the
# helper ran, so a transient failure would suppress retries. Only mark when the
# additional_context payload was actually emitted.
touch "$flag_file"
`;
	if (forceUpdate || !fs.existsSync(postToolUsePath)) {
		writeFileAtomic(postToolUsePath, postToolUseScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_post_tool_use.sh`);
	}

	// Post-Tool Use Failure Tracking
	const postToolUseFailurePath = path.join(scriptsDir, 'ace_post_tool_use_failure.sh');
	const postToolUseFailureScript = `#!/bin/bash
# ACE Post-Tool Use Failure Hook - Tracks tool failures
# Input: tool_type, tool_name, error_type, error_message

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

tool_type=$(echo "$input" | jq -r '.tool_type // "unknown"')
tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
error_type=$(echo "$input" | jq -r '.error_type // "unknown"')
error_message=$(echo "$input" | jq -r '.error_message // ""' | head -c 500)

echo "{\\"event\\": \\"tool_failure\\", \\"tool_type\\": \\"$tool_type\\", \\"tool_name\\": \\"$tool_name\\", \\"error_type\\": \\"$error_type\\", \\"error_message\\": \\"$error_message\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/mcp_trajectory.jsonl"

echo '{}'
`;
	if (forceUpdate || !fs.existsSync(postToolUseFailurePath)) {
		writeFileAtomic(postToolUseFailurePath, postToolUseFailureScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_post_tool_use_failure.sh`);
	}

	// Before Shell Execution Gate
	const beforeShellPath = path.join(scriptsDir, 'ace_before_shell.sh');
	const beforeShellScript = `#!/bin/bash
# ACE Before Shell Hook - Gates shell command execution
# Input: command

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

command=$(echo "$input" | jq -r '.command // ""')

echo "{\\"event\\": \\"before_shell\\", \\"command\\": \\"$command\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/shell_trajectory.jsonl"

echo '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeShellPath)) {
		writeFileAtomic(beforeShellPath, beforeShellScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_shell.sh`);
	}

	// Before MCP Execution Gate
	const beforeMcpPath = path.join(scriptsDir, 'ace_before_mcp.sh');
	const beforeMcpScript = `#!/bin/bash
# ACE Before MCP Hook - Gates MCP tool execution
# Input: tool_name, tool_input

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
tool_input=$(echo "$input" | jq -r '.tool_input // "{}"' | head -c 500)

echo "{\\"event\\": \\"before_mcp\\", \\"tool_name\\": \\"$tool_name\\", \\"tool_input\\": \\"$tool_input\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/mcp_trajectory.jsonl"

echo '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeMcpPath)) {
		writeFileAtomic(beforeMcpPath, beforeMcpScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_mcp.sh`);
	}

	// Before Read File Gate (minimal - fires frequently)
	const beforeReadFilePath = path.join(scriptsDir, 'ace_before_read_file.sh');
	const beforeReadFileScript = `#!/bin/bash
# ACE Before Read File Hook - Minimal gate (fires frequently)
echo '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeReadFilePath)) {
		writeFileAtomic(beforeReadFilePath, beforeReadFileScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_read_file.sh`);
	}

	// Before Submit Prompt - Pattern context injection
	const beforeSubmitPromptPath = path.join(scriptsDir, 'ace_before_submit_prompt.sh');
	const beforeSubmitPromptScript = `#!/bin/bash
# ACE Before Submit Prompt Hook - Injects pattern context + logs injection for task helpfulness
# Input: prompt_text

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

if [ -f "$ace_dir/pattern_cache.json" ]; then
  pattern_count=$(jq -r '.patternCount // 0' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "0")
  if [ "$pattern_count" -gt 0 ] 2>/dev/null; then
    domains=$(jq -r '.domains // [] | join(", ")' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "")
    avg_conf=$(jq -r '.avgConfidence // 0' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "0")
    # Log injection event for task helpfulness tracking
    echo "{\\"event\\": \\"search\\", \\"patterns_injected\\": $pattern_count, \\"domains\\": [\\"$(echo "$domains" | sed 's/, /\\", \\"/g')\\"], \\"avg_confidence\\": $avg_conf, \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/ace-relevance.jsonl"
    echo '{"continue": true}'
  else
    echo '{"continue": true}'
  fi
else
  echo '{"continue": true}'
fi
`;
	// Always update to get relevance logging
	writeFileAtomic(beforeSubmitPromptPath, beforeSubmitPromptScript, { mode: 0o755 });
	console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_submit_prompt.sh`);

	// After Agent Thought - Thinking capture
	const afterAgentThoughtPath = path.join(scriptsDir, 'ace_after_agent_thought.sh');
	const afterAgentThoughtScript = `#!/bin/bash
# ACE After Agent Thought Hook - Captures agent thinking
# Input: text, duration_ms

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

text=$(echo "$input" | jq -r '.text // ""' | head -c 300)
duration_ms=$(echo "$input" | jq -r '.duration_ms // 0')

echo "{\\"event\\": \\"agent_thought\\", \\"text\\": \\"$text\\", \\"duration_ms\\": $duration_ms, \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/response_trajectory.jsonl"

echo '{}'
`;
	if (forceUpdate || !fs.existsSync(afterAgentThoughtPath)) {
		writeFileAtomic(afterAgentThoughtPath, afterAgentThoughtScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_after_agent_thought.sh`);
	}

	// Before Tab File Read (minimal - fires very frequently)
	const beforeTabFileReadPath = path.join(scriptsDir, 'ace_before_tab_file_read.sh');
	const beforeTabFileReadScript = `#!/bin/bash
# ACE Before Tab File Read Hook - Minimal gate (fires very frequently)
echo '{"permission":"allow"}'
`;
	if (forceUpdate || !fs.existsSync(beforeTabFileReadPath)) {
		writeFileAtomic(beforeTabFileReadPath, beforeTabFileReadScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_before_tab_file_read.sh`);
	}

	// After Tab File Edit - Edit tracking
	const afterTabFileEditPath = path.join(scriptsDir, 'ace_after_tab_file_edit.sh');
	const afterTabFileEditScript = `#!/bin/bash
# ACE After Tab File Edit Hook - Tracks tab edits
# Input: file_path

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"

file_path=$(echo "$input" | jq -r '.file_path // ""')

echo "{\\"event\\": \\"tab_edit\\", \\"file_path\\": \\"$file_path\\", \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/edit_trajectory.jsonl"
`;
	if (forceUpdate || !fs.existsSync(afterTabFileEditPath)) {
		writeFileAtomic(afterTabFileEditPath, afterTabFileEditScript, { mode: 0o755 });
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace_after_tab_file_edit.sh`);
	}
}

/**
 * Create Cursor slash commands for ACE
 * These are .md files in .cursor/commands/ that become /ace-* commands in chat
 * @param folder - Target workspace folder
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 */
async function createCursorCommands(folder?: vscode.WorkspaceFolder, forceUpdate: boolean = false): Promise<void> {
	const targetFolder = folder || await getTargetFolder('Select folder for ACE commands');
	if (!targetFolder) {
		return;
	}

	const workspaceRoot = targetFolder.uri.fsPath;
	const commandsDir = path.join(workspaceRoot, '.cursor', 'commands');

	// Ensure commands directory exists
	if (!fs.existsSync(commandsDir)) {
		fs.mkdirSync(commandsDir, { recursive: true });
	}

	// Define all ACE slash commands
	const commands: Record<string, string> = {
		'ace-configure.md': `# ACE Configure

Configure your ACE server connection and project settings.

## Action Required

Tell the user to open the ACE configuration panel:

1. Press \`Cmd/Ctrl+Shift+P\` to open Command Palette
2. Type "ACE: Configure Connection"
3. Press Enter

This opens a panel where users can:
- Set server URL (Production or Localhost)
- Login with browser-based authentication
- View organization and project settings

**Note**: This requires a UI panel that you cannot open directly. Guide the user to use the Command Palette.`,

		'ace-status.md': `# ACE Status

Show ACE playbook statistics and pattern counts.

## Action Required

You have two options:

### Option 1: Use MCP Tool (Recommended)
Call the \`ace_status\` MCP tool to get status information:
\`\`\`
ace_status()
\`\`\`

### Option 2: Guide User to UI
Tell the user:
1. Click the ACE status bar item in the bottom-right corner, OR
2. Press \`Cmd/Ctrl+Shift+P\`, type "ACE: Show Status", press Enter

The status shows:
- Total patterns in playbook
- Average confidence score
- Patterns by section (strategies, snippets, pitfalls, APIs)
- Organization and project information`,

		'ace-search.md': `# ACE Search

Search for relevant patterns in your ACE playbook.

## Action Required

Use the \`ace_search\` MCP tool with the user's query:

\`\`\`
ace_search(query: "<user's search terms>")
\`\`\`

## Examples

If user types \`/ace-search authentication\`:
\`\`\`
ace_search(query: "authentication")
\`\`\`

If user types \`/ace-search error handling\`:
\`\`\`
ace_search(query: "error handling")
\`\`\`

The MCP tool will return matching patterns from the playbook that you can share with the user.`,

		'ace-bootstrap.md': `# ACE Bootstrap

Initialize your ACE playbook by extracting patterns from your existing codebase.

## Action Required

Use the \`ace_bootstrap\` MCP tool:

\`\`\`
ace_bootstrap(mode: "hybrid", thoroughness: "medium")
\`\`\`

## Parameters

- **mode**: "hybrid" (recommended), "local-files", "git-history", or "docs-only"
- **thoroughness**: "light", "medium" (recommended), or "deep"

## What This Does

1. Analyzes your codebase (docs, source files, git history)
2. Extracts patterns and best practices
3. Sends them to ACE server for processing
4. Initializes your playbook with learned patterns

The tool will stream progress updates as it analyzes your code.`,

		'ace-learn.md': `# ACE Learn

Capture learning from a completed task to improve future AI assistance.

## Action Required

Use the \`ace_learn\` MCP tool to capture what was learned.

**IMPORTANT: All 4 parameters (task, trajectory, success, output) are required. The trajectory MUST be an array of strings.**

**IMPORTANT: Start the output field with \`TIME_SAVED: Xm | reason\` to report helpfulness.**

**IMPORTANT: Include \`summary\` — your last response to the user about the completed work.**

\`\`\`
ace_learn(
  task: "Brief description of what was done",
  trajectory: ["Step 1: what you did first", "Step 2: what you did next"],
  success: true,
  output: "TIME_SAVED: Xm | one-line reason\\nImportant lessons, patterns, or insights discovered",
  summary: "What you built, why you made key decisions, and what you learned"
)
\`\`\`

## Example

After implementing a feature:
\`\`\`
ace_learn(
  task: "Implemented JWT authentication",
  trajectory: ["Added auth middleware to Express app", "Created login endpoint with bcrypt", "Added token refresh with httpOnly cookies"],
  success: true,
  output: "TIME_SAVED: 15m | Auth patterns avoided OAuth docs research\\nAlways use httpOnly cookies for refresh tokens. Access tokens should be short-lived (15min).",
  summary: "Implemented JWT auth with HS256 signing. Switched from RS256 because no key rotation infra. Used httpOnly cookies after playbook warned against localStorage. Server on port 3007 with /login, /protected, /health."
)
\`\`\`

## When to Use

- After completing a significant task
- When you discovered something important
- After fixing a tricky bug
- When a pattern worked well (or didn't)`,

		'ace-help.md': `# ACE Help

Available ACE commands and MCP tools.

## Slash Commands

- \`/ace-status\` - Show playbook statistics
- \`/ace-search <query>\` - Search for patterns
- \`/ace-configure\` - Configure ACE connection (opens UI)
- \`/ace-bootstrap\` - Initialize playbook from codebase
- \`/ace-learn\` - Capture learning from completed task
- \`/ace-help\` - Show this help

## MCP Tools (Use These Directly)

- \`ace_get_playbook()\` - Get ALL patterns (only for export/backup, prefer ace_search)
- \`ace_search(query)\` - Search for specific patterns
- \`ace_learn(task, trajectory, output, success)\` - Capture learning (call AFTER tasks)
- \`ace_bootstrap(mode, thoroughness)\` - Initialize playbook
- \`ace_status()\` - Get playbook statistics

## Automatic Features

The MCP tools are designed for automatic invocation:
- **ace_search**: Called automatically before every task (5-10 relevant patterns)
- **ace_learn**: Called automatically after substantial work

## UI Commands (Command Palette)

Press \`Cmd/Ctrl+Shift+P\` and type "ACE" to see:
- ACE: Login / Logout
- ACE: Configure Connection
- ACE: Show Status
- ACE: Manage Devices`
	};

	// Write each command file (create if doesn't exist OR if force update)
	for (const [filename, content] of Object.entries(commands)) {
		const filePath = path.join(commandsDir, filename);
		if (forceUpdate || !fs.existsSync(filePath)) {
			writeFileAtomic(filePath, content);
			console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} slash command: ${filename}`);
		}
	}
}

/**
 * Create Cursor Rules file to instruct AI to use ACE tools
 * This is the "belt + suspenders" approach - rules ensure AI calls ACE tools
 * @param folder - Target workspace folder
 * @param forceUpdate - If true, overwrite existing files (used during version upgrade)
 *
 * Cursor rule injection: .mdc with `globs: ["**\/*"]` is one of three
 * orthogonal paths we use:
 *   1. .mdc rule (this file)
 *   2. AGENTS.md at workspace root (written by createAgentsMdIfMissing)
 *   3. MCP server `instructions` field (proxy injects in initialize response)
 * Rules with .md extension are @-mention-only per Cursor docs — must be .mdc.
 */
async function createCursorRules(folder?: vscode.WorkspaceFolder, forceUpdate: boolean = false): Promise<void> {
	const targetFolder = folder || await getTargetFolder('Select folder for ACE rules');
	if (!targetFolder) {
		return;
	}

	const workspaceRoot = targetFolder.uri.fsPath;
	const rulesDir = path.join(workspaceRoot, '.cursor', 'rules');

	// Ensure rules directory exists
	if (!fs.existsSync(rulesDir)) {
		fs.mkdirSync(rulesDir, { recursive: true });
	}

	// Migrate from legacy .mdc files to folder-based RULE.mdc format (Cursor 2.2+)
	const legacyFiles = ['ace-patterns.mdc', 'ace-domain-search.md', 'ace-continuous-search.md'];
	for (const legacy of legacyFiles) {
		const legacyPath = path.join(rulesDir, legacy);
		if (fs.existsSync(legacyPath)) {
			fs.unlinkSync(legacyPath);
			console.log(`[ACE] Removed legacy rule file: ${legacy}`);
		}
	}

	// v0.5.0-dev.21 — RULE.md → RULE.mdc migration (per Cursor docs:
	// .md files are @-mention-only; .mdc with frontmatter triggers auto-attach
	// via globs). migrateLegacyMdRules runs in initializeWorkspaceForFolder
	// before this function so legacy RULE.md files are renamed to .mdc.
	// createCursorRules then overwrites .mdc with current content.

	// Create folder-based rules: .cursor/rules/<name>/RULE.mdc
	const patternsRuleDir = path.join(rulesDir, 'ace-patterns');
	if (!fs.existsSync(patternsRuleDir)) {
		fs.mkdirSync(patternsRuleDir, { recursive: true });
	}
	const rulesPath = path.join(patternsRuleDir, 'RULE.mdc');
	const rulesContent = getAcePatternsRuleContent();

	// Create if doesn't exist OR if force update requested (during version upgrade)
	if (forceUpdate || !fs.existsSync(rulesPath)) {
		writeFileAtomic(rulesPath, rulesContent);
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace-patterns/RULE.mdc`);
	}

	// v0.3.3: domain-search + continuous-search rules restored. They enable
	// AI to RE-SEARCH (targeted) on domain shifts mid-task — NOT a 700-pattern
	// dump. Initial patterns come from the postToolUse hook on first tool call;
	// these rules cover the "domain shift → fresh targeted search" case.
	const domainRuleDir = path.join(rulesDir, 'ace-domain-search');
	if (!fs.existsSync(domainRuleDir)) {
		fs.mkdirSync(domainRuleDir, { recursive: true });
	}
	const domainRulePath = path.join(domainRuleDir, 'RULE.mdc');
	if (forceUpdate || !fs.existsSync(domainRulePath)) {
		writeFileAtomic(domainRulePath, getDomainSearchRuleContent());
		console.log(`[ACE] ${forceUpdate ? 'Updated' : 'Created'} ace-domain-search/RULE.mdc`);
	}

	// v0.5.0-dev.4 — ace-continuous-search rule retired. Auto-injection +
	// domain-shift hook + Stop-hook learn replace it. Remove obsolete folder
	// from existing workspaces.
	const obsoleteContSearchDir = path.join(rulesDir, 'ace-continuous-search');
	if (fs.existsSync(obsoleteContSearchDir)) {
		try {
			fs.rmSync(obsoleteContSearchDir, { recursive: true, force: true });
			console.log('[ACE] Removed obsolete ace-continuous-search/ rule folder (v0.5.0-dev.4)');
		} catch {}
	}
}

/**
 * Get ACE configuration from settings and config files
 * For multi-root workspaces, uses getCurrentFolder() if no folder specified
 * Note: Authentication is handled via @ace-sdk/core device login, not API tokens
 */
function getAceConfig(folder?: vscode.WorkspaceFolder): { serverUrl?: string; projectId?: string; orgId?: string } | null {
	console.log('[ACE] getAceConfig called', { folder: folder?.name });
	// Use provided folder, or get from workspace monitor (tracks active editor)
	const targetFolder = folder || getCurrentFolder();
	console.log('[ACE] getAceConfig targetFolder:', targetFolder?.name);

	// Try to read from VS Code settings first
	const config = vscode.workspace.getConfiguration('ace');
	const serverUrl = config.get<string>('serverUrl');
	const orgId = config.get<string>('orgId');
	const projectId = config.get<string>('projectId');

	// Try to read from context (workspace settings for the specific folder)
	const ctx = readContext(targetFolder);

	// Try to read from global config
	let globalConfig: any = null;
	const globalConfigPath = getAceGlobalConfigPath();
	if (fs.existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf-8'));
		} catch {
			// Ignore parse errors
		}
	}

	// Merge configs with priority: VS Code settings > workspace context > global config
	// User auth (device code flow) with auth.default_org_id and auth.organizations
	const finalOrgId = orgId || ctx?.orgId || Object.keys(globalConfig?.orgs || {})[0]
		|| globalConfig?.default_org_id
		|| globalConfig?.auth?.default_org_id
		|| globalConfig?.auth?.organizations?.[0]?.org_id;
	const finalProjectId = projectId || ctx?.projectId || globalConfig?.projectId;
	const finalServerUrl = serverUrl || globalConfig?.serverUrl || 'https://ace-api.code-engine.app';

	if (!finalProjectId) {
		console.log('[ACE] getAceConfig: no projectId, returning null');
		return null; // Not configured
	}

	const result = {
		serverUrl: finalServerUrl,
		projectId: finalProjectId,
		orgId: finalOrgId
	};
	console.log('[ACE] getAceConfig result:', {
		hasServerUrl: !!result.serverUrl,
		hasProjectId: !!result.projectId,
		serverUrl: result.serverUrl
	});
	return result;
}

/**
 * Update status bar - delegates to workspace monitor
 * @deprecated Use refreshStatusBar() from workspaceMonitor instead
 */
function updateStatusBar(): void {
	refreshStatusBar();
}

/**
 * Uninstall cleanup - user-triggered command to remove ACE-installed
 * workspace files BEFORE uninstalling the extension. VS Code/Cursor have
 * no native uninstall hook, so this must be invoked manually.
 *
 * Removes: ace-* rule folders, ace_*.{sh,ps1} scripts, gate sessions dir,
 * and ACE entries in hooks.json (surgical: preserves user's other hooks).
 * Logs under .cursor/ace/* are preserved (may have value).
 */
async function runUninstallCleanup(): Promise<void> {
	const folder = await pickWorkspaceFolder('Select folder to remove ACE files from');
	if (!folder) { return; }
	const root = folder.uri.fsPath;
	let removedCount = 0;

	// Remove ace-* rule folders
	for (const ruleName of ['ace-patterns', 'ace-domain-search', 'ace-continuous-search']) {
		const ruleDir = path.join(root, '.cursor', 'rules', ruleName);
		if (fs.existsSync(ruleDir)) {
			fs.rmSync(ruleDir, { recursive: true, force: true });
			removedCount++;
		}
	}

	// Remove ace_*.sh and ace_*.ps1 in .cursor/scripts/
	const scriptsDir = path.join(root, '.cursor', 'scripts');
	if (fs.existsSync(scriptsDir)) {
		for (const f of fs.readdirSync(scriptsDir)) {
			if (f.startsWith('ace_') && (f.endsWith('.sh') || f.endsWith('.ps1'))) {
				fs.unlinkSync(path.join(scriptsDir, f));
				removedCount++;
			}
		}
	}

	// Remove gate-flag sessions directory
	const sessionsDir = path.join(root, '.cursor', 'ace', 'sessions');
	if (fs.existsSync(sessionsDir)) {
		fs.rmSync(sessionsDir, { recursive: true, force: true });
		removedCount++;
	}

	// Surgical hooks.json cleanup — preserve user hooks
	const hooksPath = path.join(root, '.cursor', 'hooks.json');
	if (fs.existsSync(hooksPath)) {
		try {
			const original = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
			const cleaned = removeAceHooksFromHooksJson(original);
			fs.writeFileSync(hooksPath, JSON.stringify(cleaned, null, 2));
			removedCount++;
		} catch (err) {
			console.error('[ACE] hooks.json parse failed during cleanup, leaving untouched:', err);
		}
	}

	vscode.window.showInformationMessage(
		`ACE cleanup complete. Removed ${removedCount} files/directories from "${folder.name}".`
	);
}

/**
 * Initialize workspace - creates .cursor/ace directory, hooks, and rules
 * For multi-root workspaces, prompts user to select a folder
 */
async function initializeWorkspace(): Promise<void> {
	const folder = await pickWorkspaceFolder('Select folder to initialize ACE');
	if (!folder) {
		vscode.window.showWarningMessage('No workspace folder selected.');
		return;
	}

	const aceDir = vscode.Uri.joinPath(folder.uri, '.cursor', 'ace');
	try {
		await vscode.workspace.fs.createDirectory(aceDir);
	} catch {
		// Directory may already exist
	}

	// Create hooks, rules, and slash commands for selected folder
	await createCursorHooks(folder);
	await createCursorRules(folder);
	await createCursorCommands(folder);

	// Re-register MCP server in case config changed
	await registerMcpServer(extensionContext);

	// Save workspace version to track future updates
	const extensionVersion = getExtensionVersion(extensionContext);
	writeWorkspaceVersion(extensionVersion, folder);

	const folderInfo = isMultiRootWorkspace() ? ` in "${folder.name}"` : '';
	vscode.window.showInformationMessage(
		`ACE workspace initialized${folderInfo} (v${extensionVersion})! Created: hooks, rules, slash commands (/ace-help, /ace-status, etc.)`
	);

	// v0.4.3: opt-in dialog (auto-skip if already asked / opted in)
	await maybePromptOptIn(folder);
}

// Export for use from configure panel
export { initializeWorkspace };
// Note: initializeWorkspaceForFolder + getExtensionVersion already exported
// alongside the function definition (v0.5.0-dev.22 Task A).

/**
 * Manual search command - redirects to MCP tool
 */
async function runSearchCommand(): Promise<void> {
	vscode.window.showInformationMessage(
		'ACE search is handled automatically via MCP. ' +
		'In Cursor chat, the AI calls ace_search before tasks to retrieve relevant patterns.'
	);
}

/**
 * Manual bootstrap command
 */
async function runBootstrapCommand(): Promise<void> {
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		vscode.window.showWarningMessage('ACE not configured. Run ACE: Configure Connection first.');
		return;
	}

	const mode = await vscode.window.showQuickPick(
		['hybrid (recommended)', 'docs-only', 'git-history', 'local-files'],
		{ placeHolder: 'Select bootstrap mode' }
	);

	if (!mode) return;

	vscode.window.showInformationMessage(`ACE bootstrap started in ${mode} mode. This may take a minute...`);

	// The actual bootstrap is handled by the MCP server
	// This is just a UI trigger - user should use MCP tool directly in chat
	vscode.window.showInformationMessage(
		'For best results, use the ace_bootstrap MCP tool directly in Cursor chat: ' +
		'"Please call ace_bootstrap to initialize patterns from this codebase"'
	);
}

/**
 * Manual learn command
 */
async function runLearnCommand(): Promise<void> {
	const aceConfig = getAceConfig();
	if (!aceConfig) {
		vscode.window.showWarningMessage('ACE not configured. Run ACE: Configure Connection first.');
		return;
	}

	const task = await vscode.window.showInputBox({
		prompt: 'What task did you complete?',
		ignoreFocusOut: true
	});

	if (!task) return;

	const outcome = await vscode.window.showQuickPick(['Success', 'Failure'], {
		placeHolder: 'Was the task successful?'
	});

	if (!outcome) return;

	const lessons = await vscode.window.showInputBox({
		prompt: 'What were the key lessons learned?',
		ignoreFocusOut: true
	});

	// The actual learning is handled by the MCP server
	// This is just a UI trigger - user should use MCP tool directly in chat
	vscode.window.showInformationMessage(
		'For best results, use the ace_learn MCP tool directly in Cursor chat. ' +
		'The AI automatically captures learning after substantial tasks.'
	);
}

/**
 * Diagnostic command - checks why ACE search might not be triggering
 * For multi-root workspaces, checks the selected folder
 */
async function runDiagnosticCommand(): Promise<void> {
	const diagnostics: string[] = [];
	const issues: string[] = [];
	const fixes: string[] = [];

	// Get target folder for diagnostics
	const targetFolder = await getTargetFolder('Select folder to diagnose');

	// 1. Check Cursor MCP API availability
	const cursorApi = getCursorApi();
	if (!cursorApi?.mcp?.registerServer) {
		issues.push('❌ Cursor MCP API not available');
		diagnostics.push('• Cursor MCP API: NOT AVAILABLE');
		diagnostics.push('  → This extension requires Cursor (not VS Code)');
		diagnostics.push('  → Make sure you\'re running Cursor, not VS Code');
		fixes.push('Switch to Cursor IDE (this extension requires Cursor\'s native MCP API)');
	} else {
		diagnostics.push('✅ Cursor MCP API: Available');
	}

	// 2. Check configuration
	const aceConfig = getAceConfig(targetFolder);
	if (!aceConfig) {
		issues.push('❌ ACE not configured');
		diagnostics.push('• Configuration: MISSING');
		diagnostics.push('  → No server URL, API token, or project ID found');
		fixes.push('Run "ACE: Configure Connection" to set up your ACE credentials');
	} else {
		diagnostics.push('✅ Configuration: Found');
		if (!aceConfig.serverUrl) {
			issues.push('⚠️ Server URL missing');
			diagnostics.push('  → Server URL: Missing');
		} else {
			diagnostics.push(`  → Server URL: ${aceConfig.serverUrl}`);
		}
		if (!aceConfig.projectId) {
			issues.push('⚠️ Project ID missing');
			diagnostics.push('  → Project ID: Missing');
			fixes.push('Set your project ID in ACE configuration');
		} else {
			diagnostics.push(`  → Project ID: ${aceConfig.projectId}`);
		}
	}

	// 3. Check rules file
	if (targetFolder) {
		const rulesPath = getDiagnosticRulesPath(targetFolder.uri.fsPath);
		if (fs.existsSync(rulesPath)) {
			diagnostics.push('✅ Cursor Rules: Found');
			const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
			if (rulesContent.includes('ace_search')) {
				diagnostics.push('  → Rules mention ace_search');
			} else {
				issues.push('⚠️ Rules file missing ace_search reference');
			}
		} else {
			issues.push('⚠️ Cursor rules file not found');
			diagnostics.push('• Cursor Rules: NOT FOUND');
			fixes.push('Run "ACE: Initialize Workspace" to create rules file');
		}
	}

	// 4. Check hooks
	if (targetFolder) {
		const hooksPath = path.join(targetFolder.uri.fsPath, '.cursor', 'hooks.json');
		if (fs.existsSync(hooksPath)) {
			diagnostics.push('✅ Cursor Hooks: Found');
		} else {
			diagnostics.push('⚠️ Cursor hooks not found (optional)');
		}
	}

	// 5. Check @ace-sdk/mcp package (note: npx will download if needed)
	diagnostics.push('ℹ️ @ace-sdk/mcp: Will be downloaded by npx if needed');
	diagnostics.push('  → MCP server uses: npx @ace-sdk/mcp');

	// Display results
	const message = [
		'=== ACE Diagnostic Report ===',
		'',
		...diagnostics,
		'',
		issues.length > 0 ? 'ISSUES FOUND:' : '✅ No critical issues found',
		...issues,
		'',
		fixes.length > 0 ? 'RECOMMENDED FIXES:' : '',
		...fixes,
		'',
		'NOTE: Even if everything is configured, the AI decides when to call MCP tools.',
		'Try explicitly asking: "Please call ace_search to retrieve patterns for my task"',
		'',
		'For automatic triggering, ensure:',
		'1. MCP server is registered (requires Cursor, not VS Code)',
		'2. Configuration is complete (API token, project ID)',
		'3. Rules file exists (.cursor/rules/ace-patterns.mdc)',
		'4. The AI recognizes the task as requiring patterns'
	].join('\n');

	const outputChannel = vscode.window.createOutputChannel('ACE Diagnostic');
	outputChannel.appendLine(message);
	outputChannel.show();

	// Also show a summary
	if (issues.length > 0) {
		vscode.window.showWarningMessage(
			`ACE Diagnostic: Found ${issues.length} issue(s). Check output panel for details.`,
			'View Details'
		).then(selection => {
			if (selection === 'View Details') {
				outputChannel.show();
			}
		});
	} else {
		vscode.window.showInformationMessage(
			'ACE Diagnostic: No critical issues found. Check output panel for full report.'
		);
	}
}

export function deactivate() {
	// Clear quota warning tracking on deactivation
	clearQuotaWarningTracking();
	// Invalidate all cached clients
	invalidateClient();
	// Cleanup is handled by disposables
}
