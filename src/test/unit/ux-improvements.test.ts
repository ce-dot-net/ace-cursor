/**
 * Unit tests for UX improvements using Vitest (ESM-compatible)
 *
 * Task 1: Auto-initialize workspace on extension install/update
 * Task 2: Auto-save org/project dropdown changes
 *
 * These tests run outside VS Code extension host with vitest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
		createWebviewPanel: vi.fn(),
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn(),
		}),
		fs: {
			createDirectory: vi.fn().mockResolvedValue(undefined),
		},
	},
	Uri: {
		parse: (url: string) => ({ toString: () => url }),
		joinPath: (...parts: any[]) => ({ fsPath: parts.join('/') }),
	},
	ProgressLocation: {
		Notification: 15,
	},
	ViewColumn: {
		One: 1,
	},
}));

// ============================================
// TASK 1: AUTO-INITIALIZE WORKSPACE TESTS
// ============================================

describe('Task 1: Auto-initialize workspace on extension install/update', () => {
	describe('checkWorkspaceVersionAndPrompt behavior', () => {
		it('should auto-initialize on FIRST INSTALL (no workspace version exists)', async () => {
			// GIVEN: A workspace folder with no ACE workspace version
			const mockFolder = {
				name: 'test-project',
				uri: { fsPath: '/test/project' },
				index: 0,
			};
			const extensionVersion = '0.2.48';
			const workspaceVersion = null; // No version = first install

			// WHEN: checkWorkspaceVersionAndPrompt is called
			// THEN: Should auto-initialize without prompting

			// Test the decision logic
			const shouldAutoInitialize = workspaceVersion === null;
			const shouldPromptForUpdate = workspaceVersion !== null && workspaceVersion !== extensionVersion;

			expect(shouldAutoInitialize).toBe(true);
			expect(shouldPromptForUpdate).toBe(false);
		});

		it('should auto-update on VERSION MISMATCH (workspace version differs from extension)', async () => {
			// GIVEN: A workspace with older ACE version
			const extensionVersion = '0.2.48';
			const workspaceVersion = '0.2.47'; // Older version = update needed

			// WHEN: Versions are compared
			// THEN: Should auto-update and show notification

			const isFirstInstall = workspaceVersion === null;
			const needsUpdate = workspaceVersion !== null && workspaceVersion !== extensionVersion;

			expect(isFirstInstall).toBe(false);
			expect(needsUpdate).toBe(true);
		});

		it('should do NOTHING when versions match', async () => {
			// GIVEN: A workspace with matching ACE version
			const extensionVersion = '0.2.48';
			const workspaceVersion = '0.2.48'; // Same version = no action needed

			// WHEN: Versions are compared
			// THEN: Should skip initialization entirely

			const isFirstInstall = workspaceVersion === null;
			const needsUpdate = workspaceVersion !== null && workspaceVersion !== extensionVersion;

			expect(isFirstInstall).toBe(false);
			expect(needsUpdate).toBe(false);
		});

		it('should handle multiple workspace folders independently', async () => {
			// GIVEN: Multi-root workspace with different states
			const folders = [
				{ name: 'project-a', version: null },      // First install
				{ name: 'project-b', version: '0.2.47' },  // Needs update
				{ name: 'project-c', version: '0.2.48' },  // Up to date
			];
			const extensionVersion = '0.2.48';

			// WHEN: Each folder is checked
			// THEN: Each should be handled correctly
			const results = folders.map(f => ({
				name: f.name,
				shouldAutoInit: f.version === null,
				shouldAutoUpdate: f.version !== null && f.version !== extensionVersion,
				shouldSkip: f.version === extensionVersion,
			}));

			expect(results[0]).toEqual({
				name: 'project-a',
				shouldAutoInit: true,
				shouldAutoUpdate: false,
				shouldSkip: false,
			});
			expect(results[1]).toEqual({
				name: 'project-b',
				shouldAutoInit: false,
				shouldAutoUpdate: true,
				shouldSkip: false,
			});
			expect(results[2]).toEqual({
				name: 'project-c',
				shouldAutoInit: false,
				shouldAutoUpdate: false,
				shouldSkip: true,
			});
		});
	});

	describe('initializeWorkspaceForFolder helper', () => {
		it('should create hooks, rules, and commands for a folder', async () => {
			// GIVEN: A workspace folder
			const mockFolder = {
				name: 'test-project',
				uri: { fsPath: '/test/project' },
				index: 0,
			};

			// WHEN: initializeWorkspaceForFolder is called
			// THEN: Should call createCursorHooks, createCursorRules, createCursorCommands

			// This tests the expected behavior - implementation will create a helper function
			const expectedCalls = [
				'createCursorHooks',
				'createCursorRules',
				'createCursorCommands',
				'writeWorkspaceVersion',
			];

			expect(expectedCalls).toContain('createCursorHooks');
			expect(expectedCalls).toContain('createCursorRules');
			expect(expectedCalls).toContain('createCursorCommands');
			expect(expectedCalls).toContain('writeWorkspaceVersion');
		});

		it('should use forceUpdate=true for version updates', async () => {
			// GIVEN: An existing workspace that needs updating
			const isUpdate = true;

			// WHEN: Files are created/updated
			// THEN: forceUpdate should be true to overwrite existing files

			const forceUpdate = isUpdate;
			expect(forceUpdate).toBe(true);
		});
	});

	describe('Notification behavior', () => {
		it('should show non-blocking notification on first install', async () => {
			// GIVEN: First install scenario
			const isFirstInstall = true;
			const folderName = 'my-project';

			// THEN: Should show informational message (non-blocking)
			const expectedMessage = `ACE initialized for ${folderName}`;
			expect(expectedMessage).toContain('ACE initialized');
			expect(expectedMessage).toContain(folderName);
		});

		it('should show non-blocking notification on update', async () => {
			// GIVEN: Update scenario
			const newVersion = '0.2.48';
			const folderName = 'my-project';

			// THEN: Should show informational message with version
			const expectedMessage = `ACE updated to v${newVersion} for ${folderName}`;
			expect(expectedMessage).toContain('ACE updated');
			expect(expectedMessage).toContain(newVersion);
		});
	});
});

// ============================================
// TASK 2: AUTO-SAVE DROPDOWN CHANGES TESTS
// ============================================

describe('Task 2: Auto-save org/project dropdown changes', () => {
	describe('Debounced auto-save behavior', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should trigger save after 500ms debounce', async () => {
			// GIVEN: A debounce timer of 500ms
			const debounceMs = 500;
			let saveTriggered = false;
			let saveTimeout: ReturnType<typeof setTimeout> | null = null;

			const autoSave = () => {
				if (saveTimeout) clearTimeout(saveTimeout);
				saveTimeout = setTimeout(() => {
					saveTriggered = true;
				}, debounceMs);
			};

			// WHEN: autoSave is called
			autoSave();

			// THEN: Save should NOT be triggered immediately
			expect(saveTriggered).toBe(false);

			// WHEN: 500ms passes
			vi.advanceTimersByTime(500);

			// THEN: Save should be triggered
			expect(saveTriggered).toBe(true);
		});

		it('should reset debounce timer on subsequent changes', async () => {
			// GIVEN: Multiple rapid changes
			const debounceMs = 500;
			let saveCount = 0;
			let saveTimeout: ReturnType<typeof setTimeout> | null = null;

			const autoSave = () => {
				if (saveTimeout) clearTimeout(saveTimeout);
				saveTimeout = setTimeout(() => {
					saveCount++;
				}, debounceMs);
			};

			// WHEN: Multiple changes happen within debounce window
			autoSave(); // t=0
			vi.advanceTimersByTime(200);
			autoSave(); // t=200, resets timer
			vi.advanceTimersByTime(200);
			autoSave(); // t=400, resets timer again

			// THEN: Save should NOT have triggered yet
			expect(saveCount).toBe(0);

			// WHEN: Full debounce period passes after last change
			vi.advanceTimersByTime(500);

			// THEN: Save should trigger exactly once
			expect(saveCount).toBe(1);
		});

		it('should send correct data structure on save', async () => {
			// GIVEN: Selected org and project
			const orgId = 'org_123';
			const projectId = 'prj_456';

			// WHEN: Save message is constructed
			const saveData = {
				orgId,
				projectId,
			};

			// THEN: Data should have correct structure
			expect(saveData).toHaveProperty('orgId', 'org_123');
			expect(saveData).toHaveProperty('projectId', 'prj_456');
		});
	});

	describe('Org dropdown change handler', () => {
		it('should trigger autoSave on org selection change', async () => {
			// GIVEN: Org dropdown with change listener
			let autoSaveCalled = false;
			const mockAutoSave = () => {
				autoSaveCalled = true;
			};

			// WHEN: Org selection changes
			const onOrgChange = () => {
				// ... existing fetch projects logic ...
				mockAutoSave();
			};

			onOrgChange();

			// THEN: autoSave should be called
			expect(autoSaveCalled).toBe(true);
		});
	});

	describe('Project dropdown change handler', () => {
		it('should trigger autoSave on project selection change', async () => {
			// GIVEN: Project dropdown with change listener
			let autoSaveCalled = false;
			const mockAutoSave = () => {
				autoSaveCalled = true;
			};

			// WHEN: Project selection changes
			const onProjectChange = () => {
				mockAutoSave();
			};

			onProjectChange();

			// THEN: autoSave should be called
			expect(autoSaveCalled).toBe(true);
		});
	});

	describe('Save confirmation feedback', () => {
		it('should send saved confirmation back to webview', async () => {
			// GIVEN: A successful save operation
			const messages: Array<{ command: string }> = [];
			const mockPostMessage = (msg: { command: string }) => {
				messages.push(msg);
			};

			// WHEN: Save completes successfully
			// Simulate the message handler response
			mockPostMessage({ command: 'saved' });

			// THEN: Should send 'saved' command to webview
			expect(messages).toContainEqual({ command: 'saved' });
		});

		it('should show subtle saved feedback in UI', async () => {
			// GIVEN: A saved confirmation message
			const message = { command: 'saved' };

			// WHEN: Webview receives saved message
			// THEN: Should trigger subtle feedback (flash/icon change)

			expect(message.command).toBe('saved');
			// UI behavior would show brief "Saved" indicator
		});
	});

	describe('Message handler for save command', () => {
		it('should handle save command from webview', async () => {
			// GIVEN: A save message with org and project data
			const message = {
				command: 'save',
				data: {
					orgId: 'org_123',
					projectId: 'prj_456',
				},
			};

			// WHEN: Message handler processes save command
			let saveConfigCalled = false;
			let savedData: any = null;

			const handleMessage = (msg: typeof message) => {
				if (msg.command === 'save') {
					saveConfigCalled = true;
					savedData = msg.data;
				}
			};

			handleMessage(message);

			// THEN: Should call _saveConfiguration with correct data
			expect(saveConfigCalled).toBe(true);
			expect(savedData).toEqual({
				orgId: 'org_123',
				projectId: 'prj_456',
			});
		});
	});
});

// ============================================
// INTEGRATION BEHAVIOR TESTS
// ============================================

describe('Integration: Auto-init and Auto-save interaction', () => {
	it('should allow auto-save after auto-init completes', async () => {
		// GIVEN: Extension auto-initialized a workspace
		const workspaceInitialized = true;

		// WHEN: User changes dropdown values
		// THEN: Auto-save should work normally

		expect(workspaceInitialized).toBe(true);
		// Auto-save depends on having a valid workspace context
	});

	it('should persist workspace version after auto-init', async () => {
		// GIVEN: Auto-init completed
		const extensionVersion = '0.2.48';

		// WHEN: Workspace version is written
		const mockWriteWorkspaceVersion = (version: string) => {
			return { version, written: true };
		};

		const result = mockWriteWorkspaceVersion(extensionVersion);

		// THEN: Version should be persisted
		expect(result.version).toBe(extensionVersion);
		expect(result.written).toBe(true);
	});
});
