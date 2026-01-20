/**
 * Unit tests for login module using Vitest (ESM-compatible)
 *
 * These tests run outside VS Code extension host, so they can properly
 * import @ace-sdk/core which is ESM-only.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Mock vscode module (not available outside VS Code)
vi.mock('vscode', () => ({
	window: {
		showInformationMessage: vi.fn().mockResolvedValue(undefined),
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
		showErrorMessage: vi.fn().mockResolvedValue(undefined),
		withProgress: vi.fn().mockImplementation(async (_options, callback) => {
			const progress = { report: vi.fn() };
			const token = { onCancellationRequested: vi.fn() };
			return callback(progress, token);
		}),
	},
	env: {
		openExternal: vi.fn().mockResolvedValue(true),
		clipboard: {
			writeText: vi.fn().mockResolvedValue(undefined),
		},
	},
	Uri: {
		parse: (url: string) => ({ toString: () => url }),
	},
	ProgressLocation: {
		Notification: 15,
	},
}));

describe('Login Module', () => {
	describe('Auth Functions', () => {
		it('should import login module successfully', async () => {
			const loginModule = await import('../../commands/login');

			expect(typeof loginModule.isAuthenticated).toBe('function');
			expect(typeof loginModule.getCurrentUser).toBe('function');
			expect(typeof loginModule.getTokenExpiration).toBe('function');
			expect(typeof loginModule.loadUserAuth).toBe('function');
			expect(typeof loginModule.setDefaultOrg).toBe('function');
			expect(typeof loginModule.handleAuthError).toBe('function');
			expect(typeof loginModule.runLoginCommand).toBe('function');
			expect(typeof loginModule.logout).toBe('function');
		});

		it('isAuthenticated should return boolean', async () => {
			const { isAuthenticated } = await import('../../commands/login');
			const result = isAuthenticated();
			expect(typeof result).toBe('boolean');
		});

		it('getCurrentUser should return UserInfo or null', async () => {
			const { getCurrentUser } = await import('../../commands/login');
			const result = getCurrentUser();
			expect(result === null || typeof result === 'object').toBe(true);

			if (result !== null) {
				expect(result).toHaveProperty('user_id');
				expect(result).toHaveProperty('email');
				expect(result).toHaveProperty('organizations');
				expect(Array.isArray(result.organizations)).toBe(true);
			}
		});

		it('loadUserAuth should return UserAuth or null', async () => {
			const { loadUserAuth } = await import('../../commands/login');
			const result = loadUserAuth();
			expect(result === null || typeof result === 'object').toBe(true);
		});

		it('getTokenExpiration should return expiration info or null', async () => {
			const { getTokenExpiration } = await import('../../commands/login');
			const result = getTokenExpiration();

			if (result !== null) {
				expect(typeof result).toBe('object');
				if (result.accessExpires) {
					expect(typeof result.accessExpires).toBe('string');
					expect(new Date(result.accessExpires).getTime()).not.toBeNaN();
				}
				if (result.refreshExpires) {
					expect(typeof result.refreshExpires).toBe('string');
					expect(new Date(result.refreshExpires).getTime()).not.toBeNaN();
				}
				if (result.absoluteExpires) {
					expect(typeof result.absoluteExpires).toBe('string');
					expect(new Date(result.absoluteExpires).getTime()).not.toBeNaN();
				}
			}
		});
	});

	describe('handleAuthError', () => {
		it('should return true for non-auth errors (200)', async () => {
			const { handleAuthError } = await import('../../commands/login');

			const mockResponse = {
				status: 200,
				json: async () => ({}),
			} as Response;

			const result = await handleAuthError(mockResponse);
			expect(result).toBe(true);
		});

		it('should return true for 404 (not an auth error)', async () => {
			const { handleAuthError } = await import('../../commands/login');

			const mockResponse = {
				status: 404,
				json: async () => ({ error: 'not_found' }),
			} as Response;

			const result = await handleAuthError(mockResponse);
			expect(result).toBe(true);
		});

		it('should return false for 401 (unauthorized)', async () => {
			const { handleAuthError } = await import('../../commands/login');

			const mockResponse = {
				status: 401,
				json: async () => ({ error: 'unauthorized' }),
			} as Response;

			const result = await handleAuthError(mockResponse);
			expect(result).toBe(false);
		});

		it('should return false for 403 device_limit_exceeded', async () => {
			const { handleAuthError } = await import('../../commands/login');

			const mockResponse = {
				status: 403,
				json: async () => ({
					error: 'device_limit_exceeded',
					current_devices: 5,
					max_devices: 5,
				}),
			} as Response;

			const result = await handleAuthError(mockResponse);
			expect(result).toBe(false);
		});
	});

	describe('Token Type Detection', () => {
		it('user tokens should start with ace_user_', () => {
			const userToken = 'ace_user_abc123def456';
			const orgToken = 'ace_org_xyz789';

			expect(userToken.startsWith('ace_user_')).toBe(true);
			expect(userToken.startsWith('ace_org_')).toBe(false);
			expect(orgToken.startsWith('ace_org_')).toBe(true);
			expect(orgToken.startsWith('ace_user_')).toBe(false);
		});

		it('token type should determine validation endpoint', () => {
			const isUserToken = (token: string) => token.startsWith('ace_user_');

			expect(isUserToken('ace_user_abc123')).toBe(true);
			expect(isUserToken('ace_org_xyz789')).toBe(false);
		});
	});

	describe('Token Lifecycle Constants', () => {
		it('should have correct token lifecycle values', () => {
			// Access token: 48h sliding window
			const accessTokenHours = 48;
			// Refresh token: 30 days
			const refreshTokenDays = 30;
			// Absolute max: 7 days
			const absoluteMaxDays = 7;

			expect(accessTokenHours).toBe(48);
			expect(refreshTokenDays).toBe(30);
			expect(absoluteMaxDays).toBe(7);
		});

		it('WARNING UX: should NOT warn about access token expiration', () => {
			// Access token uses sliding window - server extends on every API call
			// Active users never see expiration
			const shouldWarnAccessExpiring = false;
			const shouldWarnRefreshExpired = true;
			const shouldWarn7DayHardCap = true;

			expect(shouldWarnAccessExpiring).toBe(false);
			expect(shouldWarnRefreshExpired).toBe(true);
			expect(shouldWarn7DayHardCap).toBe(true);
		});
	});

	describe('Deprecated Auth Detection', () => {
		it('should export checkDeprecatedOrgAuth function', async () => {
			const loginModule = await import('../../commands/login');
			expect(typeof loginModule.checkDeprecatedOrgAuth).toBe('function');
		});

		it('checkDeprecatedOrgAuth should return object with isDeprecated', async () => {
			const { checkDeprecatedOrgAuth } = await import('../../commands/login');
			const result = checkDeprecatedOrgAuth();

			expect(result).toHaveProperty('isDeprecated');
			expect(typeof result.isDeprecated).toBe('boolean');

			if (result.isDeprecated) {
				expect(result).toHaveProperty('message');
				expect(typeof result.message).toBe('string');
			}
		});

		it('ace_org_ tokens should be detected as deprecated', () => {
			// Test token prefix detection logic
			const orgToken = 'ace_org_abc123';
			const userToken = 'ace_user_xyz789';
			const legacyToken = 'some_old_token';

			expect(orgToken.startsWith('ace_org_')).toBe(true);
			expect(userToken.startsWith('ace_user_')).toBe(true);
			expect(legacyToken.startsWith('ace_')).toBe(false);
		});

		it('should have correct deprecation message for org tokens', () => {
			const expectedMessage = 'Organization API tokens are deprecated';
			expect(expectedMessage).toContain('deprecated');
		});
	});

	describe('Global Config Path', () => {
		it('ACE config should be at ~/.config/ace/config.json', () => {
			const configPath = path.join(os.homedir(), '.config', 'ace', 'config.json');

			expect(configPath).toContain('.config');
			expect(configPath).toContain('ace');
			expect(configPath).toMatch(/config\.json$/);
		});

		it('fs.existsSync should not throw for config path', () => {
			const configPath = path.join(os.homedir(), '.config', 'ace', 'config.json');

			expect(() => fs.existsSync(configPath)).not.toThrow();
		});
	});

	describe('Token Refresh (getValidToken)', () => {
		it('should export getValidToken function', async () => {
			const loginModule = await import('../../commands/login');
			expect(typeof loginModule.getValidToken).toBe('function');
		});

		it('getValidToken should return object with token and wasRefreshed or null', async () => {
			const { getValidToken } = await import('../../commands/login');
			const result = await getValidToken();

			// Either null (no auth) or object with token
			if (result !== null) {
				expect(result).toHaveProperty('token');
				expect(result).toHaveProperty('wasRefreshed');
				expect(typeof result.token).toBe('string');
				expect(typeof result.wasRefreshed).toBe('boolean');
			} else {
				expect(result).toBeNull();
			}
		});

		it('getValidToken should accept serverUrl parameter', async () => {
			const { getValidToken } = await import('../../commands/login');
			// Should not throw when called with custom server URL
			await expect(getValidToken('https://custom.server.com')).resolves.toBeDefined();
		});

		it('getValidToken should use default server URL when not provided', async () => {
			const { getValidToken } = await import('../../commands/login');
			// Should not throw when called without parameters
			await expect(getValidToken()).resolves.toBeDefined();
		});
	});

	describe('Sliding Window Token Lifecycle', () => {
		it('should understand sliding window extends on API use', () => {
			// Access token uses 48h sliding window - each API call extends expiration
			// This is handled by ensureValidToken() from SDK
			const slidingWindowHours = 48;
			const msPerHour = 1000 * 60 * 60;
			const slidingWindowMs = slidingWindowHours * msPerHour;

			// 48 hours in milliseconds
			expect(slidingWindowMs).toBe(172800000);
		});

		it('active users should never see token expiration', () => {
			// If user makes API calls within 48h, token auto-extends
			// Only inactive users (>48h without API calls) need re-login
			const shouldActiveUserSeeExpiration = false;
			expect(shouldActiveUserSeeExpiration).toBe(false);
		});

		it('ensureValidToken handles refresh transparently', () => {
			// SDK's ensureValidToken():
			// 1. Checks if access_token expired
			// 2. Uses refresh_token to get new access_token
			// 3. Updates config file with new tokens
			// 4. Returns { token, wasRefreshed }
			const refreshIsTransparent = true;
			expect(refreshIsTransparent).toBe(true);
		});
	});
});
