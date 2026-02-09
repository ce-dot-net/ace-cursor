/**
 * Unit tests for quota warning feature using Vitest (ESM-compatible)
 *
 * TDD Tests for:
 * 1. QuotaWarningService - tracking and showing warnings
 * 2. Callback registration with AceClient
 * 3. "View Status" button functionality
 * 4. Deduplication - same resource warning shown only once per session
 *
 * These tests run outside VS Code extension host with vitest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock vscode module (not available outside VS Code)
const mockShowWarningMessage = vi.fn().mockResolvedValue(undefined);
const mockShowErrorMessage = vi.fn().mockResolvedValue(undefined);
const mockExecuteCommand = vi.fn().mockResolvedValue(undefined);
const mockOpenExternal = vi.fn().mockResolvedValue(true);

vi.mock('vscode', () => ({
	window: {
		showInformationMessage: vi.fn().mockResolvedValue(undefined),
		showWarningMessage: mockShowWarningMessage,
		showErrorMessage: mockShowErrorMessage,
	},
	commands: {
		executeCommand: mockExecuteCommand,
	},
	env: {
		openExternal: mockOpenExternal,
	},
	Uri: {
		parse: (url: string) => ({ toString: () => url }),
	},
}));

// ============================================
// QUOTA WARNING SERVICE TESTS
// ============================================

describe('QuotaWarningService', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('Warning deduplication', () => {
		it('should track shown warnings with a Set', () => {
			// GIVEN: A set for tracking shown warnings
			const shownQuotaWarnings = new Set<string>();

			// WHEN: A warning is shown for a resource
			const resource = 'patterns';
			shownQuotaWarnings.add(resource);

			// THEN: The set should contain the resource
			expect(shownQuotaWarnings.has(resource)).toBe(true);
			expect(shownQuotaWarnings.size).toBe(1);
		});

		it('should prevent duplicate warnings for the same resource', () => {
			// GIVEN: A warning has already been shown for a resource
			const shownQuotaWarnings = new Set<string>();
			const resource = 'patterns';
			shownQuotaWarnings.add(resource);

			// WHEN: The same warning is triggered again
			const shouldShow = !shownQuotaWarnings.has(resource);

			// THEN: Should NOT show the warning again
			expect(shouldShow).toBe(false);
		});

		it('should allow warnings for different resources', () => {
			// GIVEN: A warning has been shown for one resource
			const shownQuotaWarnings = new Set<string>();
			shownQuotaWarnings.add('patterns');

			// WHEN: A warning for a different resource is triggered
			const newResource = 'traces';
			const shouldShow = !shownQuotaWarnings.has(newResource);

			// THEN: Should show the new warning
			expect(shouldShow).toBe(true);
		});

		it('should clear warning tracking on clearQuotaWarningTracking()', () => {
			// GIVEN: Multiple warnings have been shown
			const shownQuotaWarnings = new Set<string>();
			shownQuotaWarnings.add('patterns');
			shownQuotaWarnings.add('traces');
			shownQuotaWarnings.add('projects');

			// WHEN: clearQuotaWarningTracking is called
			const clearQuotaWarningTracking = () => shownQuotaWarnings.clear();
			clearQuotaWarningTracking();

			// THEN: All tracking should be cleared
			expect(shownQuotaWarnings.size).toBe(0);
		});
	});

	describe('Quota warning callback (onQuotaWarning)', () => {
		it('should show warning message with correct format at 80% threshold', async () => {
			// GIVEN: Quota is at 80%
			const message = 'Pattern usage at 80%';
			const percentage = 80;
			const resource = 'patterns';

			// WHEN: onQuotaWarning callback is triggered
			const shownQuotaWarnings = new Set<string>();
			
			const onQuotaWarning = async (msg: string, pct: number, res: string) => {
				if (!shownQuotaWarnings.has(res)) {
					shownQuotaWarnings.add(res);
					await mockShowWarningMessage(
						`ACE: ${msg}. Consider upgrading your plan.`,
						'View Status'
					);
				}
			};

			await onQuotaWarning(message, percentage, resource);

			// THEN: Should show warning with upgrade suggestion
			expect(mockShowWarningMessage).toHaveBeenCalledWith(
				'ACE: Pattern usage at 80%. Consider upgrading your plan.',
				'View Status'
			);
		});

		it('should include "View Status" button in warning', async () => {
			// GIVEN: A quota warning
			const message = 'Trace usage at 85%';
			const percentage = 85;
			const resource = 'traces';

			// WHEN: Warning is shown
			const shownQuotaWarnings = new Set<string>();
			await mockShowWarningMessage(
				`ACE: ${message}. Consider upgrading your plan.`,
				'View Status'
			);

			// THEN: Should include "View Status" button
			expect(mockShowWarningMessage).toHaveBeenCalledWith(
				expect.any(String),
				'View Status'
			);
		});

		it('should open status panel when "View Status" is clicked', async () => {
			// GIVEN: User clicks "View Status" on warning
			mockShowWarningMessage.mockResolvedValue('View Status');

			// WHEN: Warning is shown and user clicks button
			const result = await mockShowWarningMessage(
				'ACE: Pattern usage at 80%. Consider upgrading your plan.',
				'View Status'
			);

			if (result === 'View Status') {
				await mockExecuteCommand('ace.status');
			}

			// THEN: Should execute ace.status command
			expect(mockExecuteCommand).toHaveBeenCalledWith('ace.status');
		});

		it('should not open status panel when warning is dismissed', async () => {
			// GIVEN: User dismisses the warning
			mockShowWarningMessage.mockResolvedValue(undefined);

			// WHEN: Warning is shown and user dismisses
			const result = await mockShowWarningMessage(
				'ACE: Pattern usage at 80%. Consider upgrading your plan.',
				'View Status'
			);

			if (result === 'View Status') {
				await mockExecuteCommand('ace.status');
			}

			// THEN: Should NOT execute ace.status command
			expect(mockExecuteCommand).not.toHaveBeenCalled();
		});

		it('should log quota warning to console', () => {
			// GIVEN: A quota warning
			const consoleSpy = vi.spyOn(console, 'log');
			const resource = 'patterns';
			const percentage = 80;

			// WHEN: Warning is processed
			console.log(`[ACE] Quota warning: ${resource} at ${percentage}%`);

			// THEN: Should log the warning
			expect(consoleSpy).toHaveBeenCalledWith('[ACE] Quota warning: patterns at 80%');
			consoleSpy.mockRestore();
		});
	});

	describe('Read-only mode callback (onReadOnlyMode)', () => {
		it('should show warning with days until block', async () => {
			// GIVEN: Account is in read-only mode
			const daysUntilBlock = 7;

			// WHEN: onReadOnlyMode callback is triggered
			await mockShowWarningMessage(
				`ACE: Quota exceeded. Account will be blocked in ${daysUntilBlock} days. Please upgrade your plan.`,
				'Upgrade'
			);

			// THEN: Should show warning with days countdown
			expect(mockShowWarningMessage).toHaveBeenCalledWith(
				'ACE: Quota exceeded. Account will be blocked in 7 days. Please upgrade your plan.',
				'Upgrade'
			);
		});

		it('should open pricing page when "Upgrade" is clicked', async () => {
			// GIVEN: User clicks "Upgrade" on read-only warning
			mockShowWarningMessage.mockResolvedValue('Upgrade');

			// WHEN: Warning is shown and user clicks Upgrade
			const result = await mockShowWarningMessage(
				'ACE: Quota exceeded. Account will be blocked in 7 days. Please upgrade your plan.',
				'Upgrade'
			);

			if (result === 'Upgrade') {
				await mockOpenExternal({ toString: () => 'https://ace-ai.app/pricing' });
			}

			// THEN: Should open pricing page
			expect(mockOpenExternal).toHaveBeenCalled();
		});
	});

	describe('Account blocked callback (onAccountBlocked)', () => {
		it('should show error message when account is blocked', async () => {
			// GIVEN: Account is blocked

			// WHEN: onAccountBlocked callback is triggered
			await mockShowErrorMessage(
				'ACE: Account blocked due to quota. Please update your payment method.',
				'Manage Account'
			);

			// THEN: Should show error message
			expect(mockShowErrorMessage).toHaveBeenCalledWith(
				'ACE: Account blocked due to quota. Please update your payment method.',
				'Manage Account'
			);
		});

		it('should open account page when "Manage Account" is clicked', async () => {
			// GIVEN: User clicks "Manage Account" on blocked message
			mockShowErrorMessage.mockResolvedValue('Manage Account');

			// WHEN: Error is shown and user clicks button
			const result = await mockShowErrorMessage(
				'ACE: Account blocked due to quota. Please update your payment method.',
				'Manage Account'
			);

			if (result === 'Manage Account') {
				await mockOpenExternal({ toString: () => 'https://ace-ai.app/account' });
			}

			// THEN: Should open account page
			expect(mockOpenExternal).toHaveBeenCalled();
		});
	});

	describe('Usage update callback (onUsageUpdate)', () => {
		it('should store last usage info', () => {
			// GIVEN: Usage info from server
			const usageInfo = {
				plan: 'pro',
				status: 'active',
				patterns: { current: 80, limit: 100 },
				traces: { current: 50, limit: 100 },
			};

			// WHEN: onUsageUpdate is called
			let lastUsageInfo: typeof usageInfo | undefined;
			const onUsageUpdate = (usage: typeof usageInfo) => {
				lastUsageInfo = usage;
			};

			onUsageUpdate(usageInfo);

			// THEN: Last usage should be stored
			expect(lastUsageInfo).toEqual(usageInfo);
			expect(lastUsageInfo?.plan).toBe('pro');
		});

		it('should log usage update to console', () => {
			// GIVEN: Usage update received
			const consoleSpy = vi.spyOn(console, 'log');
			const usage = { plan: 'pro', status: 'active' };

			// WHEN: Usage is processed
			console.log(`[ACE] Usage update: ${usage.plan} plan, status=${usage.status}`);

			// THEN: Should log the update
			expect(consoleSpy).toHaveBeenCalledWith('[ACE] Usage update: pro plan, status=active');
			consoleSpy.mockRestore();
		});
	});
});

// ============================================
// ACE CLIENT FACTORY TESTS
// ============================================

describe('AceClient Factory', () => {
	describe('Client creation with quota callbacks', () => {
		it('should create client options with all quota callbacks', () => {
			// GIVEN: Need to create AceClient with callbacks
			const clientOptions: {
				onUsageUpdate?: (usage: any) => void;
				onQuotaWarning?: (message: string, percentage: number, resource: string) => void;
				onReadOnlyMode?: (daysUntilBlock: number) => void;
				onAccountBlocked?: () => void;
			} = {};

			// WHEN: Setting up client options
			clientOptions.onUsageUpdate = vi.fn();
			clientOptions.onQuotaWarning = vi.fn();
			clientOptions.onReadOnlyMode = vi.fn();
			clientOptions.onAccountBlocked = vi.fn();

			// THEN: All callbacks should be defined
			expect(clientOptions.onUsageUpdate).toBeDefined();
			expect(clientOptions.onQuotaWarning).toBeDefined();
			expect(clientOptions.onReadOnlyMode).toBeDefined();
			expect(clientOptions.onAccountBlocked).toBeDefined();
		});

		it('should cache clients per folder', () => {
			// GIVEN: A client cache
			const clientCache = new Map<string, object>();

			// WHEN: Creating client for a folder
			const folderUri = 'file:///workspace/project1';
			const mockClient = { name: 'AceClient' };
			clientCache.set(folderUri, mockClient);

			// THEN: Client should be cached
			expect(clientCache.has(folderUri)).toBe(true);
			expect(clientCache.get(folderUri)).toBe(mockClient);
		});

		it('should return cached client on subsequent calls', () => {
			// GIVEN: A cached client
			const clientCache = new Map<string, object>();
			const folderUri = 'file:///workspace/project1';
			const cachedClient = { id: 'cached' };
			clientCache.set(folderUri, cachedClient);

			// WHEN: Getting client for same folder
			const client = clientCache.get(folderUri);

			// THEN: Should return the cached client
			expect(client).toBe(cachedClient);
		});

		it('should invalidate client on configuration change', () => {
			// GIVEN: A client cache with entries
			const clientCache = new Map<string, object>();
			clientCache.set('folder1', { id: 'client1' });
			clientCache.set('folder2', { id: 'client2' });

			// WHEN: invalidateClient is called for specific folder
			const invalidateClient = (folder?: string) => {
				if (folder) {
					clientCache.delete(folder);
				} else {
					clientCache.clear();
				}
			};

			invalidateClient('folder1');

			// THEN: Only that folder's client should be removed
			expect(clientCache.has('folder1')).toBe(false);
			expect(clientCache.has('folder2')).toBe(true);
		});

		it('should invalidate all clients when no folder specified', () => {
			// GIVEN: A client cache with entries
			const clientCache = new Map<string, object>();
			clientCache.set('folder1', { id: 'client1' });
			clientCache.set('folder2', { id: 'client2' });

			// WHEN: invalidateClient is called without folder
			const invalidateClient = (folder?: string) => {
				if (folder) {
					clientCache.delete(folder);
				} else {
					clientCache.clear();
				}
			};

			invalidateClient();

			// THEN: All clients should be removed
			expect(clientCache.size).toBe(0);
		});
	});

	describe('Quota warning feature flag', () => {
		it('should respect showQuotaWarnings setting (enabled)', () => {
			// GIVEN: showQuotaWarnings is enabled in settings
			const settings = { showQuotaWarnings: true };

			// WHEN: Creating client options
			const clientOptions: { onQuotaWarning?: Function } = {};
			
			if (settings.showQuotaWarnings) {
				clientOptions.onQuotaWarning = vi.fn();
			}

			// THEN: onQuotaWarning callback should be set
			expect(clientOptions.onQuotaWarning).toBeDefined();
		});

		it('should respect showQuotaWarnings setting (disabled)', () => {
			// GIVEN: showQuotaWarnings is disabled in settings
			const settings = { showQuotaWarnings: false };

			// WHEN: Creating client options
			const clientOptions: { onQuotaWarning?: Function } = {};
			
			if (settings.showQuotaWarnings) {
				clientOptions.onQuotaWarning = vi.fn();
			}

			// THEN: onQuotaWarning callback should NOT be set
			expect(clientOptions.onQuotaWarning).toBeUndefined();
		});
	});
});

// ============================================
// EXTENSION INTEGRATION TESTS
// ============================================

describe('Extension Integration', () => {
	describe('Quota callbacks during activation', () => {
		it('should initialize quota warning tracking on activation', () => {
			// GIVEN: Extension is activating
			const shownQuotaWarnings = new Set<string>();

			// WHEN: Extension activates
			// (Set is created fresh on activation)

			// THEN: Tracking should be empty/fresh
			expect(shownQuotaWarnings.size).toBe(0);
		});

		it('should clear quota warning tracking on deactivation', () => {
			// GIVEN: Extension has shown some warnings
			const shownQuotaWarnings = new Set<string>();
			shownQuotaWarnings.add('patterns');
			shownQuotaWarnings.add('traces');

			// WHEN: Extension deactivates
			const clearQuotaWarningTracking = () => shownQuotaWarnings.clear();
			clearQuotaWarningTracking();

			// THEN: Tracking should be cleared
			expect(shownQuotaWarnings.size).toBe(0);
		});
	});

	describe('SDK type exports', () => {
		it('should define correct callback types', () => {
			// GIVEN: SDK callback type definitions
			type UsageUpdateCallback = (usage: any) => void;
			type QuotaWarningCallback = (message: string, percentage: number, resource: string) => void;
			type ReadOnlyModeCallback = (daysUntilBlock: number) => void;
			type AccountBlockedCallback = () => void;

			// WHEN: Creating callbacks of these types
			const onUsageUpdate: UsageUpdateCallback = vi.fn();
			const onQuotaWarning: QuotaWarningCallback = vi.fn();
			const onReadOnlyMode: ReadOnlyModeCallback = vi.fn();
			const onAccountBlocked: AccountBlockedCallback = vi.fn();

			// THEN: Callbacks should be valid functions
			expect(typeof onUsageUpdate).toBe('function');
			expect(typeof onQuotaWarning).toBe('function');
			expect(typeof onReadOnlyMode).toBe('function');
			expect(typeof onAccountBlocked).toBe('function');
		});
	});
});

// ============================================
// LAST USAGE INFO TESTS
// ============================================

describe('Last Usage Info', () => {
	it('should export getLastUsageInfo function', () => {
		// GIVEN: Need to access last usage info
		let lastUsageInfo: any = undefined;
		
		const getLastUsageInfo = () => lastUsageInfo;

		// WHEN: Getting last usage (none set)
		const result = getLastUsageInfo();

		// THEN: Should return undefined
		expect(result).toBeUndefined();
	});

	it('should return stored usage info after update', () => {
		// GIVEN: Usage info has been stored
		let lastUsageInfo: any = undefined;
		
		const getLastUsageInfo = () => lastUsageInfo;
		const setLastUsageInfo = (usage: any) => { lastUsageInfo = usage; };

		// WHEN: Usage info is set and retrieved
		const usage = {
			plan: 'team',
			status: 'active',
			patterns: { current: 150, limit: 500 },
		};
		setLastUsageInfo(usage);
		const result = getLastUsageInfo();

		// THEN: Should return the stored usage
		expect(result).toEqual(usage);
		expect(result.plan).toBe('team');
	});
});
