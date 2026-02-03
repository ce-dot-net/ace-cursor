/**
 * ACE Login Command - Device code authentication flow
 * Uses @ace-sdk/core for all auth operations (RFC 8628 Device Authorization Grant)
 *
 * Flow:
 * 1. SDK requests device code: POST /api/v1/auth/device
 * 2. User visits URL and enters code
 * 3. SDK polls for token: POST /api/v1/auth/device/token
 * 4. SDK saves credentials to ~/.config/ace/config.json
 */

import * as vscode from 'vscode';
import {
	// Device code flow
	login,
	logout as sdkLogout,
	// Auth utilities
	isAuthenticated as sdkIsAuthenticated,
	getCurrentUser as sdkGetCurrentUser,
	// Config auth management
	loadUserAuth as sdkLoadUserAuth,
	setDefaultOrg as sdkSetDefaultOrg,
	// Token refresh (v4.5.0)
	ensureValidToken
} from '@ace-sdk/core';
import type { CurrentUser, UserAuth, OrgMembership } from '@ace-sdk/core';

// ==================== Re-export Types ====================

export interface UserInfo {
	user_id: string;
	email: string;
	name?: string;
	image_url?: string;
	organizations: OrgMembership[];
	default_org_id?: string;
}

// ==================== Auth Functions (Delegates to SDK) ====================

/**
 * Load user auth from config
 */
export function loadUserAuth(): UserAuth | null {
	return sdkLoadUserAuth();
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
	return sdkIsAuthenticated();
}

/**
 * Get current user info
 */
export function getCurrentUser(): UserInfo | null {
	const user = sdkGetCurrentUser();
	if (!user) return null;
	return {
		user_id: user.user_id,
		email: user.email,
		name: user.name,
		image_url: user.image_url,
		organizations: user.organizations,
		default_org_id: user.default_org_id
	};
}

/**
 * Get token expiration info
 */
export function getTokenExpiration(): { accessExpires?: string; refreshExpires?: string; absoluteExpires?: string } | null {
	const auth = sdkLoadUserAuth();
	if (!auth) return null;
	return {
		accessExpires: auth.expires_at,
		refreshExpires: auth.refresh_expires_at,
		absoluteExpires: auth.absolute_expires_at
	};
}

/**
 * Get 7-day hard cap info for session expiration
 * The hard cap is the absolute maximum session duration (7 days) regardless of activity.
 * Unlike the sliding window (48h access, 30d refresh), the hard cap cannot be extended.
 *
 * @returns Object with daysRemaining and isApproaching flag, or null if no auth
 */
export function getHardCapInfo(): { daysRemaining: number; hoursRemaining: number; isApproaching: boolean; isExpired: boolean } | null {
	const auth = sdkLoadUserAuth();
	if (!auth?.absolute_expires_at) return null;

	const absoluteExpires = new Date(auth.absolute_expires_at).getTime();
	const now = Date.now();
	const msRemaining = absoluteExpires - now;
	const hoursRemaining = Math.floor(msRemaining / (1000 * 60 * 60));
	const daysRemaining = Math.floor(hoursRemaining / 24);

	return {
		daysRemaining,
		hoursRemaining,
		isApproaching: daysRemaining <= 2 && daysRemaining > 0,
		isExpired: msRemaining <= 0
	};
}

/**
 * Set default organization
 */
export function setDefaultOrg(orgId: string): void {
	sdkSetDefaultOrg(orgId);
}

/**
 * Get a valid token, refreshing if needed (sliding window TTL)
 *
 * The SDK's ensureValidToken() handles:
 * - Checking if token is expired
 * - Auto-refreshing using refresh_token
 * - Updating config with new tokens
 * - Extending the sliding window (48h on each use)
 *
 * @param serverUrl - ACE server URL (defaults to https://ace-api.code-engine.app)
 * @returns Valid token string, or null if refresh failed
 */
export async function getValidToken(serverUrl: string = 'https://ace-api.code-engine.app'): Promise<{ token: string; wasRefreshed: boolean } | null> {
	try {
		const result = await ensureValidToken(serverUrl);
		if (result.wasRefreshed) {
			console.log('[ACE] Token refreshed (sliding window extended)');
		}
		return result;
	} catch (error) {
		console.error('[ACE] Token refresh failed:', error instanceof Error ? error.message : String(error));
		return null;
	}
}

// ==================== Main Login Command ====================

/**
 * Run the ACE login command using device code flow
 * Uses @ace-sdk/core for auth, VS Code APIs for UI
 * @returns UserInfo on success, null on failure/cancellation
 */
export async function runLoginCommand(): Promise<UserInfo | null> {
	try {
		const result = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'ACE Login',
			cancellable: true
		}, async (progress, token) => {
			// Create abort controller from VS Code cancellation token
			const abortController = new AbortController();
			token.onCancellationRequested(() => {
				abortController.abort();
			});

			// Use SDK's login function with VS Code UI callbacks
			const currentUser: CurrentUser = await login({
				clientType: 'cursor',
				noBrowser: false,  // SDK will try to open browser, but we also do it in onUserCode
				timeout: 300000,   // 5 minutes
				signal: abortController.signal,

				// Called when device code is received - show in VS Code UI
				onUserCode: (userCode: string, verificationUrl: string) => {
					// Show notification with code
					vscode.window.showInformationMessage(
						`ACE Login Code: ${userCode}`,
						'Open Browser',
						'Copy Code'
					).then(action => {
						if (action === 'Open Browser') {
							vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
						} else if (action === 'Copy Code') {
							vscode.env.clipboard.writeText(userCode);
							vscode.window.showInformationMessage('Code copied to clipboard');
						}
					});

					// Auto-open browser (SDK may also try, but VS Code APIs work better)
					vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
				},

				// Called for progress updates
				onProgress: (message: string) => {
					progress.report({ message });
				},

				// Called on success
				onSuccess: (user: CurrentUser) => {
					vscode.window.showInformationMessage(`ACE login successful! Welcome ${user.email}`);
				}
			});

			// Convert CurrentUser to UserInfo
			const userInfo: UserInfo = {
				user_id: currentUser.user_id,
				email: currentUser.email,
				name: currentUser.name,
				image_url: currentUser.image_url,
				organizations: currentUser.organizations
			};

			return userInfo;
		});

		return result;
	} catch (error: any) {
		if (error.message === 'Login cancelled') {
			vscode.window.showWarningMessage('ACE login cancelled');
		} else {
			vscode.window.showErrorMessage(`ACE login failed: ${error.message}`);
		}
		return null;
	}
}

// ==================== Auth Error Handling ====================

/**
 * Handle 401/403 errors by triggering re-login
 * v4.5.6: NEVER call clearAuth() client-side - server is authoritative
 * Only explicit logout() should clear auth credentials
 *
 * @param response - HTTP response to check
 * @returns true if no auth error or re-login succeeded, false otherwise
 */
export async function handleAuthError(response: Response): Promise<boolean> {
	if (response.status === 401) {
		// v4.5.6: Server says token is invalid
		// DON'T call clearAuth() - let user explicitly logout if needed
		// Just prompt for re-login, which will overwrite old credentials

		const action = await vscode.window.showWarningMessage(
			'ACE session expired. Login required.',
			'Login Now'
		);

		if (action === 'Login Now') {
			const user = await runLoginCommand();
			return user !== null;
		}
		return false;
	}

	if (response.status === 403) {
		try {
			const body = await response.json() as { error?: string; current_devices?: number; max_devices?: number };
			if (body.error === 'device_limit_exceeded') {
				const action = await vscode.window.showErrorMessage(
					`Device limit reached (${body.current_devices}/${body.max_devices}).`,
					'Manage Devices'
				);
				if (action) {
					vscode.env.openExternal(
						vscode.Uri.parse('https://ace-ai.app/dashboard/devices')
					);
				}
			}
		} catch {
			// Ignore JSON parse errors
		}
		return false;
	}

	return true; // No auth error
}

/**
 * Logout and clear credentials
 */
export async function logout(): Promise<void> {
	sdkLogout();
	vscode.window.showInformationMessage('Logged out of ACE');
}
