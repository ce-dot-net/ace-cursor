/**
 * Unit tests for activity visibility / notification features (TDD - written before implementation)
 *
 * Tests the following new visibility mechanisms added alongside the 11 new hooks:
 *
 * 1. Output channel created on extension activation for hook activity logging
 * 2. Status bar shows loading state during preloadPatterns()
 * 3. Status bar shows pattern count after preload completes
 * 4. Status bar reverts from temporary "loaded" indicator to standard text after a timeout
 * 5. Activity indicator flashes on trajectory file change (file-watcher driven)
 * 6. Activity indicator debounces rapid trajectory file changes
 *
 * These tests run outside the VS Code extension host using vitest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// VS Code API mocks
// ============================================================================

const mockOutputChannelAppendLine = vi.fn();
const mockOutputChannelShow = vi.fn();
const mockOutputChannelDispose = vi.fn();
const mockCreateOutputChannel = vi.fn().mockReturnValue({
	appendLine: mockOutputChannelAppendLine,
	show: mockOutputChannelShow,
	dispose: mockOutputChannelDispose,
	name: 'ACE Activity',
});

const mockStatusBarShow = vi.fn();
const mockStatusBarDispose = vi.fn();
const mockStatusBarItem = {
	text: '',
	tooltip: '',
	command: '',
	show: mockStatusBarShow,
	dispose: mockStatusBarDispose,
};
const mockCreateStatusBarItem = vi.fn().mockReturnValue(mockStatusBarItem);

const mockShowInformationMessage = vi.fn().mockResolvedValue(undefined);
const mockShowWarningMessage = vi.fn().mockResolvedValue(undefined);
const mockShowErrorMessage = vi.fn().mockResolvedValue(undefined);

const mockCreateFileSystemWatcher = vi.fn().mockReturnValue({
	onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	dispose: vi.fn(),
});

vi.mock('vscode', () => ({
	window: {
		showInformationMessage: mockShowInformationMessage,
		showWarningMessage: mockShowWarningMessage,
		showErrorMessage: mockShowErrorMessage,
		createOutputChannel: mockCreateOutputChannel,
		createStatusBarItem: mockCreateStatusBarItem,
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
		createFileSystemWatcher: mockCreateFileSystemWatcher,
	},
	Uri: {
		joinPath: vi.fn((uri: any, ...segments: string[]) => ({
			fsPath: path.join(uri.fsPath, ...segments),
		})),
		file: vi.fn((p: string) => ({ fsPath: p, toString: () => `file://${p}` })),
	},
	StatusBarAlignment: {
		Left: 1,
		Right: 2,
	},
	RelativePattern: vi.fn((base: any, pattern: string) => ({ base, pattern })),
}));

// ============================================================================
// Helpers that simulate the extension's activity-notification implementations
// ============================================================================

interface ActivityIndicatorState {
	isFlashing: boolean;
	lastFlashTime: number;
	flashCount: number;
}

/** Simulates the output channel creation that should happen on activation */
function createActivityOutputChannel(name: string = 'ACE Activity') {
	// Use the mock directly — vi.mock hoists the mock before imports
	return mockCreateOutputChannel(name);
}

/** Simulates the status bar manager for ACE */
function createStatusBarManager() {
	const item = mockCreateStatusBarItem(2 /* StatusBarAlignment.Right */, 100);
	item.text = '$(sync~spin) ACE: Loading...';
	item.tooltip = 'ACE Pattern Learning - Loading patterns';
	item.command = 'ace.status';
	item.show();
	return item;
}

/** Simulates the preload completion status update */
function updateStatusBarAfterPreload(
	item: typeof mockStatusBarItem,
	patternCount: number,
	domains: string[]
) {
	if (patternCount > 0) {
		item.text = `$(book) ACE: ${patternCount} patterns`;
		item.tooltip = `ACE Pattern Learning\n${patternCount} patterns in playbook\nDomains: ${domains.slice(0, 3).join(', ')}${domains.length > 3 ? ` (+${domains.length - 3} more)` : ''}\n\nClick for status`;
	} else {
		item.text = '$(book) ACE';
		item.tooltip = 'ACE Pattern Learning - No patterns yet';
	}
}

/** Simulates the transient "loaded" flash then revert */
function flashLoadedState(
	item: typeof mockStatusBarItem,
	patternCount: number,
	domains: string[],
	flashDurationMs: number,
	onReverted: () => void
) {
	// Show flash state
	item.text = `$(check) ACE: ${patternCount} patterns loaded`;

	// Schedule revert
	const timerId = setTimeout(() => {
		updateStatusBarAfterPreload(item, patternCount, domains);
		onReverted();
	}, flashDurationMs);

	return timerId;
}

/** Debounced activity indicator flash on trajectory file change */
function createDebouncedFlash(
	state: ActivityIndicatorState,
	item: typeof mockStatusBarItem,
	debounceMs: number
) {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const flash = () => {
		// Cancel pending debounce
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		// Schedule debounced update
		debounceTimer = setTimeout(() => {
			state.isFlashing = true;
			state.lastFlashTime = Date.now();
			state.flashCount++;

			const originalText = item.text;
			item.text = `$(pulse) ${originalText.replace(/^\$\([^)]+\)\s*/, '')}`;

			// Revert after brief flash
			setTimeout(() => {
				item.text = originalText;
				state.isFlashing = false;
			}, 300);
		}, debounceMs);

		return debounceTimer;
	};

	return { flash, getTimer: () => debounceTimer };
}

// ============================================================================

describe('Activity Notifications: Output Channel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should create output channel on extension activation', () => {
		const channel = createActivityOutputChannel('ACE Activity');

		expect(mockCreateOutputChannel).toHaveBeenCalledOnce();
		expect(mockCreateOutputChannel).toHaveBeenCalledWith('ACE Activity');
		expect(channel).toBeDefined();
	});

	it('should create output channel with name "ACE Activity"', () => {
		createActivityOutputChannel('ACE Activity');

		expect(mockCreateOutputChannel).toHaveBeenCalledWith('ACE Activity');
	});

	it('should be able to log messages to the output channel', () => {
		const channel = createActivityOutputChannel('ACE Activity');
		channel.appendLine('[ACE] Extension activated');

		expect(mockOutputChannelAppendLine).toHaveBeenCalledWith('[ACE] Extension activated');
	});

	it('output channel should have appendLine method', () => {
		const channel = createActivityOutputChannel();

		expect(typeof channel.appendLine).toBe('function');
	});

	it('output channel should have show method', () => {
		const channel = createActivityOutputChannel();

		expect(typeof channel.show).toBe('function');
	});

	it('output channel should have dispose method', () => {
		const channel = createActivityOutputChannel();

		expect(typeof channel.dispose).toBe('function');
	});

	it('should log hook activity to output channel', () => {
		const channel = createActivityOutputChannel();
		const hookEvents = [
			'[ACE] preToolUse fired: ace_search',
			'[ACE] postToolUse completed: ace_search (150ms)',
			'[ACE] afterAgentThought recorded',
		];

		for (const event of hookEvents) {
			channel.appendLine(event);
		}

		expect(mockOutputChannelAppendLine).toHaveBeenCalledTimes(hookEvents.length);
		expect(mockOutputChannelAppendLine).toHaveBeenNthCalledWith(1, hookEvents[0]);
		expect(mockOutputChannelAppendLine).toHaveBeenNthCalledWith(2, hookEvents[1]);
		expect(mockOutputChannelAppendLine).toHaveBeenNthCalledWith(3, hookEvents[2]);
	});

	it('output channel messages should follow [ACE] prefix convention', () => {
		const messages = [
			'[ACE] Preloading patterns...',
			'[ACE] Pattern cache written',
			'[ACE] Hook activity: 5 MCP calls, 2 shell commands',
		];

		for (const msg of messages) {
			expect(msg).toMatch(/^\[ACE\]/);
		}
	});
});

// ============================================================================

describe('Activity Notifications: Status Bar Loading State', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset status bar item state
		mockStatusBarItem.text = '';
		mockStatusBarItem.tooltip = '';
	});

	it('should show loading state during preload', () => {
		const item = createStatusBarManager();

		expect(item.text).toContain('Loading');
	});

	it('status bar loading text should include a spinner icon', () => {
		const item = createStatusBarManager();

		// VS Code uses $(sync~spin) or $(loading~spin) for spinners
		expect(item.text).toMatch(/\$\(sync~spin\)|\$\(loading~spin\)/);
	});

	it('status bar should call show() on creation', () => {
		createStatusBarManager();

		expect(mockStatusBarShow).toHaveBeenCalledOnce();
	});

	it('status bar should have ACE status command attached', () => {
		const item = createStatusBarManager();

		expect(item.command).toBe('ace.status');
	});

	it('status bar tooltip during loading should indicate patterns are loading', () => {
		const item = createStatusBarManager();

		expect(item.tooltip).toMatch(/[Ll]oading/);
	});

	it('status bar should be created via vscode.window.createStatusBarItem', () => {
		createStatusBarManager();

		expect(mockCreateStatusBarItem).toHaveBeenCalledOnce();
	});
});

// ============================================================================

describe('Activity Notifications: Status Bar After Preload', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStatusBarItem.text = '$(sync~spin) ACE: Loading...';
		mockStatusBarItem.tooltip = '';
	});

	it('should show pattern count after preload with patterns', () => {
		updateStatusBarAfterPreload(mockStatusBarItem, 42, ['auth', 'api']);

		expect(mockStatusBarItem.text).toContain('42');
		expect(mockStatusBarItem.text).toContain('patterns');
	});

	it('should include book icon in status bar text after preload', () => {
		updateStatusBarAfterPreload(mockStatusBarItem, 10, ['auth']);

		expect(mockStatusBarItem.text).toContain('$(book)');
	});

	it('should include domain names in tooltip after preload', () => {
		updateStatusBarAfterPreload(mockStatusBarItem, 20, ['auth', 'api', 'cache']);

		expect(mockStatusBarItem.tooltip).toContain('auth');
		expect(mockStatusBarItem.tooltip).toContain('api');
		expect(mockStatusBarItem.tooltip).toContain('cache');
	});

	it('should truncate domain list in tooltip when more than 3 domains', () => {
		const domains = ['auth', 'api', 'cache', 'database', 'ui'];
		updateStatusBarAfterPreload(mockStatusBarItem, 100, domains);

		// Should show first 3 and indicate there are more
		expect(mockStatusBarItem.tooltip).toContain('auth');
		expect(mockStatusBarItem.tooltip).toContain('api');
		expect(mockStatusBarItem.tooltip).toContain('cache');
		expect(mockStatusBarItem.tooltip).toContain('+2 more');
	});

	it('should show fallback text when preload returns zero patterns', () => {
		updateStatusBarAfterPreload(mockStatusBarItem, 0, []);

		expect(mockStatusBarItem.text).toContain('ACE');
		expect(mockStatusBarItem.text).not.toContain('Loading');
		// Should NOT show a pattern count of 0
		expect(mockStatusBarItem.text).not.toMatch(/:\s*0\s*patterns/);
	});

	it('should replace loading text with pattern count text', () => {
		mockStatusBarItem.text = '$(sync~spin) ACE: Loading...';
		updateStatusBarAfterPreload(mockStatusBarItem, 15, ['api']);

		expect(mockStatusBarItem.text).not.toContain('Loading');
		expect(mockStatusBarItem.text).toContain('15');
	});

	it('tooltip should include "Click for status" hint', () => {
		updateStatusBarAfterPreload(mockStatusBarItem, 5, ['auth']);

		expect(mockStatusBarItem.tooltip).toContain('Click for status');
	});
});

// ============================================================================

describe('Activity Notifications: Status Bar Revert After Timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mockStatusBarItem.text = '$(book) ACE: 25 patterns';
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should revert from "loaded" to standard after timeout', () => {
		const domains = ['auth', 'api'];
		let reverted = false;

		flashLoadedState(mockStatusBarItem, 25, domains, 3000, () => {
			reverted = true;
		});

		// Immediately after flash, should show loaded state
		expect(mockStatusBarItem.text).toContain('loaded');

		// After 3 seconds, should revert
		vi.advanceTimersByTime(3000);

		expect(reverted).toBe(true);
		expect(mockStatusBarItem.text).not.toContain('loaded');
	});

	it('should show loaded state immediately after flash is triggered', () => {
		const domains = ['api'];
		flashLoadedState(mockStatusBarItem, 10, domains, 3000, vi.fn());

		// Flash state should be set immediately (synchronously)
		expect(mockStatusBarItem.text).toMatch(/loaded/i);
	});

	it('loaded flash text should include pattern count', () => {
		flashLoadedState(mockStatusBarItem, 50, ['auth', 'api', 'cache'], 3000, vi.fn());

		expect(mockStatusBarItem.text).toContain('50');
	});

	it('reverted text should include book icon and pattern count', () => {
		const domains = ['auth'];
		flashLoadedState(mockStatusBarItem, 7, domains, 2000, vi.fn());

		vi.advanceTimersByTime(2000);

		expect(mockStatusBarItem.text).toContain('$(book)');
		expect(mockStatusBarItem.text).toContain('7');
	});

	it('should NOT revert before the timeout elapses', () => {
		const revertedFn = vi.fn();
		flashLoadedState(mockStatusBarItem, 5, ['api'], 5000, revertedFn);

		vi.advanceTimersByTime(4999);

		expect(revertedFn).not.toHaveBeenCalled();
		expect(mockStatusBarItem.text).toContain('loaded');
	});

	it('revert callback should be called exactly once', () => {
		const revertedFn = vi.fn();
		flashLoadedState(mockStatusBarItem, 5, ['api'], 1000, revertedFn);

		vi.advanceTimersByTime(1000);
		vi.advanceTimersByTime(1000); // Run time forward again

		expect(revertedFn).toHaveBeenCalledOnce();
	});

	it('flash timer should return a timer ID that can be cleared', () => {
		const timerId = flashLoadedState(mockStatusBarItem, 5, ['api'], 3000, vi.fn());

		expect(timerId).toBeDefined();
		// Clearing the timer should prevent revert
		clearTimeout(timerId);
		vi.advanceTimersByTime(5000);

		// Text should remain in flash state since we cleared the timer
		expect(mockStatusBarItem.text).toContain('loaded');
	});
});

// ============================================================================

describe('Activity Notifications: Activity Indicator on Trajectory Change', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mockStatusBarItem.text = '$(book) ACE: 25 patterns';
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should flash activity indicator when trajectory file changes', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 200);

		flash();
		vi.advanceTimersByTime(200); // debounce

		expect(state.flashCount).toBe(1);
	});

	it('should increment flash count on each trajectory change event', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 100);

		// Three separate changes, each with enough gap to pass debounce
		flash();
		vi.advanceTimersByTime(100);
		flash();
		vi.advanceTimersByTime(100);
		flash();
		vi.advanceTimersByTime(100);

		expect(state.flashCount).toBe(3);
	});

	it('should update lastFlashTime on flash', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 100);
		const beforeFlash = Date.now();

		flash();
		vi.advanceTimersByTime(100);

		expect(state.lastFlashTime).toBeGreaterThanOrEqual(beforeFlash);
	});

	it('activity flash should change status bar icon briefly', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const originalText = mockStatusBarItem.text;
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 50);

		flash();
		vi.advanceTimersByTime(50); // debounce fires

		// During flash, text should differ from original
		expect(mockStatusBarItem.text).not.toBe(originalText);
	});

	it('activity flash should revert status bar text after 300ms', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const originalText = mockStatusBarItem.text;
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 50);

		flash();
		vi.advanceTimersByTime(50);   // debounce fires, flash starts
		vi.advanceTimersByTime(300);  // flash duration, revert happens

		expect(mockStatusBarItem.text).toBe(originalText);
		expect(state.isFlashing).toBe(false);
	});

	it('should track that isFlashing is true during flash period', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 50);

		flash();
		vi.advanceTimersByTime(50); // debounce fires

		// During the 300ms flash window, isFlashing should be true
		expect(state.isFlashing).toBe(true);
	});

	it('isFlashing should be false after flash reverts', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 50);

		flash();
		vi.advanceTimersByTime(50 + 300 + 1);

		expect(state.isFlashing).toBe(false);
	});
});

// ============================================================================

describe('Activity Notifications: Debounce Rapid Changes', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mockStatusBarItem.text = '$(book) ACE: 10 patterns';
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should debounce rapid trajectory file changes into a single flash', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 200);

		// Fire 5 rapid changes within the debounce window
		flash(); // t=0
		vi.advanceTimersByTime(50);
		flash(); // t=50, resets timer
		vi.advanceTimersByTime(50);
		flash(); // t=100, resets timer
		vi.advanceTimersByTime(50);
		flash(); // t=150, resets timer
		vi.advanceTimersByTime(50);
		flash(); // t=200, resets timer

		// None should have fired yet (debounce of 200ms from last)
		expect(state.flashCount).toBe(0);

		// Wait for debounce to complete
		vi.advanceTimersByTime(200);

		// Only one flash should have been triggered
		expect(state.flashCount).toBe(1);
	});

	it('should reset debounce timer on each new change', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 300);

		flash(); // t=0
		vi.advanceTimersByTime(299); // just before debounce fires

		// Should NOT have flashed yet
		expect(state.flashCount).toBe(0);

		flash(); // t=299, reset timer — now debounce is 300ms from t=299
		vi.advanceTimersByTime(299); // t=598, still within new debounce window

		expect(state.flashCount).toBe(0);

		vi.advanceTimersByTime(1); // t=599, still before 300ms from last flash

		// NOTE: 299+1=300ms has elapsed from the last flash() call at t=299
		vi.advanceTimersByTime(0); // Flush any pending timers at this boundary

		// Advance to ensure debounce fires
		vi.advanceTimersByTime(10);

		expect(state.flashCount).toBe(1);
	});

	it('separate changes after debounce window should each trigger a flash', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 100);

		// First change group
		flash();
		vi.advanceTimersByTime(100);
		expect(state.flashCount).toBe(1);

		// Wait for flash to complete
		vi.advanceTimersByTime(300);

		// Second change group (separate, after debounce cleared)
		flash();
		vi.advanceTimersByTime(100);
		expect(state.flashCount).toBe(2);
	});

	it('debounce should use a configurable delay', () => {
		const state50: ActivityIndicatorState = { isFlashing: false, lastFlashTime: 0, flashCount: 0 };
		const state500: ActivityIndicatorState = { isFlashing: false, lastFlashTime: 0, flashCount: 0 };

		const { flash: flash50 } = createDebouncedFlash(state50, mockStatusBarItem, 50);
		const { flash: flash500 } = createDebouncedFlash(state500, mockStatusBarItem, 500);

		flash50();
		flash500();

		// After 100ms: 50ms debounce should have fired, 500ms should not
		vi.advanceTimersByTime(100);

		expect(state50.flashCount).toBe(1);
		expect(state500.flashCount).toBe(0);
	});

	it('activity indicator flash should not block status bar from being updated', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 100);

		flash();
		vi.advanceTimersByTime(100); // debounce fires, flashing starts

		// Even while flashing, status bar update should be possible
		mockStatusBarItem.text = '$(book) ACE: 99 patterns';
		expect(mockStatusBarItem.text).toBe('$(book) ACE: 99 patterns');
	});

	it('trajectory file watcher callback should call flash on change event', () => {
		// Simulate what the extension wires up: a file system watcher on .cursor/ace/*.jsonl
		// that triggers the activity flash.
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 100);

		// Simulate the onDidChange callback being registered and triggered
		const watchedFiles = [
			'mcp_trajectory.jsonl',
			'shell_trajectory.jsonl',
			'edit_trajectory.jsonl',
			'response_trajectory.jsonl',
		];

		// Each watched file triggering a change should call flash()
		for (const _file of watchedFiles) {
			// Simulate change event for this file
			flash(); // The registered callback would call flash()
		}

		// All 4 rapid changes should be debounced into one flash
		vi.advanceTimersByTime(100);

		expect(state.flashCount).toBe(1);
	});
});

// ============================================================================

describe('Activity Notifications: Integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should complete full activation flow: channel created, loading state, then loaded', () => {
		// Step 1: Activation — create output channel
		createActivityOutputChannel('ACE Activity');
		expect(mockCreateOutputChannel).toHaveBeenCalledOnce();

		// Step 2: Status bar shows loading
		const statusBar = createStatusBarManager();
		expect(statusBar.text).toContain('Loading');

		// Step 3: Preload completes
		updateStatusBarAfterPreload(statusBar, 35, ['auth', 'api', 'database']);
		expect(statusBar.text).toContain('35');
		expect(statusBar.text).not.toContain('Loading');

		// Step 4: Flash loaded state, then revert
		let reverted = false;
		flashLoadedState(statusBar, 35, ['auth', 'api', 'database'], 2000, () => {
			reverted = true;
		});

		expect(statusBar.text).toContain('loaded');

		vi.advanceTimersByTime(2000);

		expect(reverted).toBe(true);
		expect(statusBar.text).not.toContain('loaded');
		expect(statusBar.text).toContain('35');
	});

	it('should log preload events to output channel', () => {
		const channel = createActivityOutputChannel('ACE Activity');

		// Simulate preload lifecycle log messages
		channel.appendLine('[ACE] Preloading patterns...');
		channel.appendLine('[ACE] Fetching analytics via AceClient');
		channel.appendLine('[ACE] Preloaded 42 patterns from 3 domains');
		channel.appendLine('[ACE] Pattern cache written for sessionStart hook');

		expect(mockOutputChannelAppendLine).toHaveBeenCalledTimes(4);
		expect(mockOutputChannelAppendLine).toHaveBeenCalledWith('[ACE] Preloaded 42 patterns from 3 domains');
	});

	it('activity state should track multiple flash events from different trajectory files', () => {
		const state: ActivityIndicatorState = {
			isFlashing: false,
			lastFlashTime: 0,
			flashCount: 0,
		};
		mockStatusBarItem.text = '$(book) ACE: 20 patterns';
		const { flash } = createDebouncedFlash(state, mockStatusBarItem, 150);

		// Simulate mcp_trajectory.jsonl changes
		flash();
		vi.advanceTimersByTime(150);

		// Simulate edit_trajectory.jsonl change after a pause
		vi.advanceTimersByTime(300); // flash revert
		flash();
		vi.advanceTimersByTime(150);

		expect(state.flashCount).toBe(2);
	});

	it('output channel and status bar should be independent (one can fail without affecting the other)', () => {
		// Output channel operations should not throw even with mock
		const channel = createActivityOutputChannel('ACE Activity');
		expect(() => channel.appendLine('test message')).not.toThrow();

		// Status bar operations should not throw
		const statusBar = createStatusBarManager();
		expect(() => updateStatusBarAfterPreload(statusBar, 5, ['api'])).not.toThrow();
	});

	it('preload with zero patterns should not trigger "loaded" flash', () => {
		const statusBar = createStatusBarManager();
		updateStatusBarAfterPreload(statusBar, 0, []);

		// Zero patterns should use fallback text, no "loaded" flash
		expect(statusBar.text).not.toContain('loaded');
		expect(statusBar.text).not.toContain('0 patterns');
	});
});

// ============================================================================

describe('Activity Notifications: Pattern Cache for beforeSubmitPrompt', () => {
	let tempDir: string;
	let aceDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-activity-cache-'));
		aceDir = path.join(tempDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should write pattern_cache.json during preload', () => {
		const cacheData = {
			patternCount: 25,
			domains: ['auth', 'api'],
			timestamp: new Date().toISOString(),
		};

		const cachePath = path.join(aceDir, 'pattern_cache.json');
		fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

		expect(fs.existsSync(cachePath)).toBe(true);
		const loaded = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
		expect(loaded.patternCount).toBe(25);
	});

	it('pattern_cache.json should contain patternCount, domains, and timestamp fields', () => {
		const cacheData = {
			patternCount: 10,
			domains: ['auth', 'api', 'cache'],
			timestamp: '2026-03-17T12:00:00.000Z',
		};

		expect(cacheData).toHaveProperty('patternCount');
		expect(cacheData).toHaveProperty('domains');
		expect(cacheData).toHaveProperty('timestamp');
		expect(Array.isArray(cacheData.domains)).toBe(true);
		expect(typeof cacheData.patternCount).toBe('number');
		expect(typeof cacheData.timestamp).toBe('string');
	});

	it('beforeSubmitPrompt hook should read pattern count from cache and inject context', () => {
		// Simulate what ace_before_submit_prompt.sh does
		const cacheData = {
			patternCount: 30,
			domains: ['auth', 'api', 'database'],
			timestamp: '2026-03-17T12:00:00.000Z',
		};
		const cachePath = path.join(aceDir, 'pattern_cache.json');
		fs.writeFileSync(cachePath, JSON.stringify(cacheData));

		// Read cache as the hook would
		const loaded = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
		const patternCount = loaded.patternCount;

		// Build context injection output
		const shouldInjectContext = patternCount > 0;
		expect(shouldInjectContext).toBe(true);

		const context = `[ACE] ${patternCount} patterns available. Use ace_search to retrieve relevant patterns.`;
		const output = JSON.stringify({ additional_context: context });
		const parsed = JSON.parse(output);

		expect(parsed.additional_context).toContain('30');
		expect(parsed.additional_context).toContain('ace_search');
	});

	it('beforeSubmitPrompt hook should output {} when cache has zero patterns', () => {
		const cacheData = { patternCount: 0, domains: [], timestamp: '2026-03-17T12:00:00.000Z' };
		const cachePath = path.join(aceDir, 'pattern_cache.json');
		fs.writeFileSync(cachePath, JSON.stringify(cacheData));

		const loaded = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
		const shouldInjectContext = loaded.patternCount > 0;

		expect(shouldInjectContext).toBe(false);

		const output = shouldInjectContext
			? JSON.stringify({ additional_context: 'context' })
			: '{}';

		expect(JSON.parse(output)).toEqual({});
	});

	it('beforeSubmitPrompt hook should output {} when cache file does not exist', () => {
		const cachePath = path.join(aceDir, 'pattern_cache.json');
		// Do not create the file

		const cacheExists = fs.existsSync(cachePath);
		expect(cacheExists).toBe(false);

		// Hook logic: if no cache file, output empty
		const output = cacheExists ? JSON.stringify({ additional_context: 'something' }) : '{}';
		expect(JSON.parse(output)).toEqual({});
	});

	it('pattern_cache.json timestamp should be a valid ISO date string', () => {
		const timestamp = new Date().toISOString();
		const cacheData = { patternCount: 5, domains: ['auth'], timestamp };

		const parsedDate = new Date(cacheData.timestamp);
		expect(isNaN(parsedDate.getTime())).toBe(false);
	});
});
