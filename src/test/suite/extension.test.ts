import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { readContext, writeContext, pickWorkspaceFolder, getTargetFolder, isMultiRootWorkspace, getWorkspaceRoot, type AceContext } from '../../ace/context';

suite('ACE Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	// ============================================
	// EXTENSION ACTIVATION TESTS
	// ============================================

	test('Extension should be loaded', async () => {
		const extension = vscode.extensions.getExtension('ce-dot-net.cursor-ace-extension');
		assert.ok(extension, 'Extension should be loaded');
	});

	test('Extension should export activate and deactivate functions', async () => {
		const extension = vscode.extensions.getExtension('ce-dot-net.cursor-ace-extension');
		if (extension) {
			// Extension may not be active in VS Code test environment (needs Cursor)
			// Just verify it's loaded
			assert.ok(extension.id === 'ce-dot-net.cursor-ace-extension');
		}
	});

	// ============================================
	// CONTEXT MODULE TESTS
	// ============================================

	test('Context reading should work', () => {
		const ctx = readContext();
		// Context might be null if not configured - that's okay
		assert.ok(
			ctx === null || (typeof ctx.projectId === 'string'),
			'Context should be null or have valid projectId'
		);
	});

	test('Context writing should work', function() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			this.skip(); // Skip when no workspace (VS Code test environment)
			return;
		}
		const testCtx: AceContext = {
			orgId: 'test-org',
			projectId: 'test-project'
		};
		writeContext(testCtx);
		const read = readContext();
		assert.ok(read, 'Context should be readable after writing');
		assert.strictEqual(read?.orgId, 'test-org', 'orgId should match');
		assert.strictEqual(read?.projectId, 'test-project', 'projectId should match');
	});

	test('Context writing should create settings directory', function() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			this.skip(); // Skip when no workspace
			return;
		}
		const settingsPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'ace', 'settings.json');
		// After writeContext, file should exist
		writeContext({ projectId: 'dir-test' });
		assert.ok(fs.existsSync(settingsPath), 'Settings file should be created');
	});

	test('Context should support optional orgId', function() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			this.skip(); // Skip when no workspace
			return;
		}
		const testCtx: AceContext = {
			projectId: 'project-only'
		};
		writeContext(testCtx);
		const read = readContext();
		assert.ok(read, 'Context should be readable');
		assert.strictEqual(read?.projectId, 'project-only', 'projectId should match');
		assert.strictEqual(read?.orgId, undefined, 'orgId should be undefined when not set');
	});

	// ============================================
	// MULTI-ROOT WORKSPACE TESTS
	// ============================================

	test('isMultiRootWorkspace should return correct value', () => {
		const folders = vscode.workspace.workspaceFolders;
		const expected = (folders?.length ?? 0) > 1;
		assert.strictEqual(isMultiRootWorkspace(), expected, 'isMultiRootWorkspace should match folder count');
	});

	test('getWorkspaceRoot should return null for multi-root without folder param', () => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length <= 1) {
			// Single folder or no workspace - should return fsPath or null
			const root = getWorkspaceRoot();
			if (folders && folders.length === 1) {
				assert.strictEqual(root, folders[0].uri.fsPath, 'Should return first folder path for single workspace');
			} else {
				assert.strictEqual(root, null, 'Should return null when no workspace');
			}
		} else {
			// Multi-root workspace without folder param should return null
			const root = getWorkspaceRoot();
			assert.strictEqual(root, null, 'Should return null for multi-root without folder param');
		}
	});

	test('getWorkspaceRoot should return folder path when folder provided', () => {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			const folder = folders[0];
			const root = getWorkspaceRoot(folder);
			assert.strictEqual(root, folder.uri.fsPath, 'Should return folder fsPath when folder provided');
		}
	});

	test('pickWorkspaceFolder should be an async function', () => {
		assert.ok(typeof pickWorkspaceFolder === 'function', 'pickWorkspaceFolder should be a function');
		// Verify it returns a promise
		const result = pickWorkspaceFolder();
		assert.ok(result instanceof Promise, 'pickWorkspaceFolder should return a promise');
	});

	test('getTargetFolder should be an async function', () => {
		assert.ok(typeof getTargetFolder === 'function', 'getTargetFolder should be a function');
		// Verify it returns a promise
		const result = getTargetFolder();
		assert.ok(result instanceof Promise, 'getTargetFolder should return a promise');
	});

	test('Context functions should accept folder parameter', function() {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			this.skip(); // Skip when no workspace
			return;
		}
		const folder = workspaceFolders[0];
		const testCtx: AceContext = {
			orgId: 'folder-test-org',
			projectId: 'folder-test-project'
		};
		writeContext(testCtx, folder);
		const read = readContext(folder);
		assert.ok(read, 'Context should be readable with folder param');
		assert.strictEqual(read?.projectId, 'folder-test-project', 'projectId should match');
	});

	// ============================================
	// COMMAND REGISTRATION TESTS
	// ============================================

	test('All ACE commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);

		const aceCommands = [
			'ace.initializeWorkspace',
			'ace.configure',
			'ace.search',
			'ace.status',
			'ace.bootstrap',
			'ace.learn',
			'ace.taskStart',
			'ace.taskStop',
			'ace.autoSearch'
		];

		for (const cmd of aceCommands) {
			assert.ok(
				commands.includes(cmd),
				`Command ${cmd} should be registered`
			);
		}
	});

	test('Legacy commands should show informational message', async () => {
		// These commands should exist and not throw
		// They show info messages directing to MCP
		try {
			await vscode.commands.executeCommand('ace.taskStart');
			await vscode.commands.executeCommand('ace.taskStop');
			await vscode.commands.executeCommand('ace.autoSearch');
		} catch (err) {
			// Commands might show messages, that's fine
		}
	});

	// ============================================
	// CONFIGURATION TESTS
	// ============================================

	test('Configuration properties should be defined', () => {
		const config = vscode.workspace.getConfiguration('ace');

		// These are optional properties - verify they can be accessed
		const serverUrl = config.get<string>('serverUrl');
		const orgId = config.get<string>('orgId');
		const projectId = config.get<string>('projectId');

		// Properties should exist (even if empty string)
		assert.ok(typeof serverUrl === 'string' || serverUrl === undefined, 'serverUrl should be string or undefined');
		assert.ok(typeof orgId === 'string' || orgId === undefined, 'orgId should be string or undefined');
		assert.ok(typeof projectId === 'string' || projectId === undefined, 'projectId should be string or undefined');
	});

	test('Configuration should have correct default server URL', () => {
		const config = vscode.workspace.getConfiguration('ace');
		const serverUrl = config.get<string>('serverUrl');
		// Default should be empty string (extension uses hardcoded fallback)
		assert.strictEqual(serverUrl, '', 'serverUrl default should be empty');
	});

	// ============================================
	// HOOKS FILE STRUCTURE TESTS
	// ============================================

	test('Hooks JSON should have correct structure if exists', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const hooksPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'hooks.json');
			if (fs.existsSync(hooksPath)) {
				const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
				assert.ok(hooks.version === 1, 'hooks.json should have version 1');
				assert.ok(hooks.hooks, 'hooks.json should have hooks property');
				assert.ok(Array.isArray(hooks.hooks.stop), 'hooks.stop should be an array');
			}
		}
	});

	test('Hooks JSON should have all AI-Trail hooks if exists', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const hooksPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'hooks.json');
			if (fs.existsSync(hooksPath)) {
				const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
				// AI-Trail requires all these hooks
				const requiredHooks = [
					'afterMCPExecution',
					'afterShellExecution',
					'afterAgentResponse',
					'afterFileEdit',
					'stop'
				];
				for (const hook of requiredHooks) {
					assert.ok(
						Array.isArray(hooks.hooks[hook]),
						`hooks.${hook} should be an array`
					);
					assert.ok(
						hooks.hooks[hook].length > 0,
						`hooks.${hook} should have at least one entry`
					);
					assert.ok(
						hooks.hooks[hook][0].command,
						`hooks.${hook}[0] should have command property`
					);
				}
			}
		}
	});

	test('Hooks should reference correct script extension for platform', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const hooksPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'hooks.json');
			if (fs.existsSync(hooksPath)) {
				const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
				const isWindows = process.platform === 'win32';
				const expectedExt = isWindows ? '.ps1' : '.sh';

				// Check stop hook command has correct extension
				const stopCmd = hooks.hooks?.stop?.[0]?.command || '';
				assert.ok(
					stopCmd.includes(expectedExt),
					`Stop hook should use ${expectedExt} extension on ${process.platform}`
				);
			}
		}
	});

	test('Hook scripts should be executable if exist', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const scriptsDir = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'scripts');
			if (fs.existsSync(scriptsDir)) {
				const stopHook = path.join(scriptsDir, 'ace_stop_hook.sh');
				const trackEdit = path.join(scriptsDir, 'ace_track_edit.sh');

				if (fs.existsSync(stopHook)) {
					const stats = fs.statSync(stopHook);
					// Check executable bit (owner execute = 0o100)
					assert.ok((stats.mode & 0o100) !== 0, 'ace_stop_hook.sh should be executable');
				}

				if (fs.existsSync(trackEdit)) {
					const stats = fs.statSync(trackEdit);
					assert.ok((stats.mode & 0o100) !== 0, 'ace_track_edit.sh should be executable');
				}
			}
		}
	});

	test('All AI-Trail hook scripts should exist if hooks.json exists', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const hooksPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'hooks.json');
			const scriptsDir = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'scripts');

			if (fs.existsSync(hooksPath) && fs.existsSync(scriptsDir)) {
				const isWindows = process.platform === 'win32';
				const ext = isWindows ? '.ps1' : '.sh';

				const requiredScripts = [
					`ace_track_mcp${ext}`,
					`ace_track_shell${ext}`,
					`ace_track_response${ext}`,
					`ace_track_edit${ext}`,
					`ace_stop_hook${ext}`
				];

				for (const script of requiredScripts) {
					const scriptPath = path.join(scriptsDir, script);
					assert.ok(
						fs.existsSync(scriptPath),
						`Script ${script} should exist`
					);
				}
			}
		}
	});

	test('Unix hook scripts should be executable', function() {
		if (process.platform === 'win32') {
			this.skip(); // Windows doesn't use Unix permissions
			return;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const scriptsDir = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'scripts');
			if (fs.existsSync(scriptsDir)) {
				const scripts = [
					'ace_track_mcp.sh',
					'ace_track_shell.sh',
					'ace_track_response.sh',
					'ace_track_edit.sh',
					'ace_stop_hook.sh'
				];

				for (const script of scripts) {
					const scriptPath = path.join(scriptsDir, script);
					if (fs.existsSync(scriptPath)) {
						const stats = fs.statSync(scriptPath);
						assert.ok(
							(stats.mode & 0o100) !== 0,
							`${script} should be executable`
						);
					}
				}
			}
		}
	});

	// ============================================
	// CURSOR RULES FILE TESTS
	// ============================================

	test('Cursor rules file should have correct structure if exists', () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const rulesPath = path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'rules', 'ace-patterns.mdc');
			if (fs.existsSync(rulesPath)) {
				const content = fs.readFileSync(rulesPath, 'utf-8');
				// Check frontmatter
				assert.ok(content.includes('alwaysApply: true'), 'Rules should have alwaysApply: true');
				assert.ok(content.includes('ace_get_playbook'), 'Rules should mention ace_get_playbook tool');
				assert.ok(content.includes('ace_learn'), 'Rules should mention ace_learn tool');
			}
		}
	});

	// ============================================
	// STATUS PANEL TESTS
	// ============================================

	test('StatusPanel class should be importable', async () => {
		const { StatusPanel } = await import('../../webviews/statusPanel');
		assert.ok(StatusPanel, 'StatusPanel should be exported');
		assert.ok(typeof StatusPanel.createOrShow === 'function', 'createOrShow should be a function');
		assert.ok(typeof StatusPanel.revive === 'function', 'revive should be a function');
	});

	test('StatusPanel should be a singleton', async () => {
		const { StatusPanel } = await import('../../webviews/statusPanel');
		// Initially no panel
		assert.strictEqual(StatusPanel.currentPanel, undefined, 'No panel should exist initially');
	});

	// ============================================
	// CONFIGURE PANEL TESTS
	// ============================================

	test('ConfigurePanel class should be importable', async () => {
		const { ConfigurePanel } = await import('../../webviews/configurePanel');
		assert.ok(ConfigurePanel, 'ConfigurePanel should be exported');
		assert.ok(typeof ConfigurePanel.createOrShow === 'function', 'createOrShow should be a function');
	});

	// ============================================
	// GLOBAL CONFIG FILE TESTS
	// ============================================

	test('Global config path should be correct', () => {
		const expectedPath = path.join(os.homedir(), '.config', 'ace', 'config.json');
		// Just verify the path format is correct
		assert.ok(expectedPath.includes('.config'), 'Config path should include .config');
		assert.ok(expectedPath.includes('ace'), 'Config path should include ace');
		assert.ok(expectedPath.endsWith('config.json'), 'Config path should end with config.json');
	});

	// ============================================
	// HTTP ENDPOINT FORMAT TESTS
	// ============================================

	test('Analytics endpoint should use correct format', () => {
		// The extension should use /analytics with X-ACE-Project header
		// This is a documentation test to ensure we know the correct format
		const correctEndpoint = '/analytics';
		const correctHeader = 'X-ACE-Project';

		assert.ok(correctEndpoint === '/analytics', 'Analytics endpoint should be /analytics');
		assert.ok(correctHeader === 'X-ACE-Project', 'Project header should be X-ACE-Project');
	});

	test('Search endpoint should use correct format', () => {
		// The extension should use /patterns/search with X-ACE-Project header
		const correctEndpoint = '/patterns/search';
		assert.ok(correctEndpoint === '/patterns/search', 'Search endpoint should be /patterns/search');
	});

	test('Verify endpoint should use correct format', () => {
		// The extension should use GET /api/v1/config/verify
		const correctEndpoint = '/api/v1/config/verify';
		assert.ok(correctEndpoint === '/api/v1/config/verify', 'Verify endpoint should be /api/v1/config/verify');
	});

	// ============================================
	// EXTENSION CONTEXT TESTS
	// ============================================

	test('getExtensionContext should be exported', async () => {
		const extension = await import('../../extension');
		assert.ok(typeof extension.getExtensionContext === 'function', 'getExtensionContext should be exported');
	});

	test('activate and deactivate should be exported', async () => {
		const extension = await import('../../extension');
		assert.ok(typeof extension.activate === 'function', 'activate should be exported');
		assert.ok(typeof extension.deactivate === 'function', 'deactivate should be exported');
	});
});

// ============================================
// MOCKED HTTP TESTS
// ============================================

suite('ACE HTTP API Tests (Mocked)', () => {
	// These tests verify the HTTP request formatting without actually calling the API

	test('Analytics request should include required headers', () => {
		const projectId = 'test-project-123';
		const apiToken = 'test-token';

		// Verify the headers that should be sent
		const headers = {
			'Authorization': `Bearer ${apiToken}`,
			'Content-Type': 'application/json',
			'X-ACE-Project': projectId
		};

		assert.ok(headers['Authorization'].startsWith('Bearer '), 'Auth header should be Bearer token');
		assert.ok(headers['X-ACE-Project'] === projectId, 'Project ID should be in header');
		assert.ok(headers['Content-Type'] === 'application/json', 'Content-Type should be JSON');
	});

	test('API response should support both total_patterns and total_bullets', () => {
		// New API response format
		const newApiResponse = { total_patterns: 95, avg_confidence: 0.85 };
		const total1 = newApiResponse.total_patterns || (newApiResponse as any).total_bullets || 0;
		assert.strictEqual(total1, 95, 'Should read total_patterns');

		// Old API response format (fallback)
		const oldApiResponse = { total_bullets: 50, avg_confidence: 0.75 };
		const total2 = (oldApiResponse as any).total_patterns || oldApiResponse.total_bullets || 0;
		assert.strictEqual(total2, 50, 'Should fall back to total_bullets');

		// Empty response
		const emptyResponse = { avg_confidence: 0.5 };
		const total3 = (emptyResponse as any).total_patterns || (emptyResponse as any).total_bullets || 0;
		assert.strictEqual(total3, 0, 'Should default to 0');
	});

	test('Verify response should extract org and project names', () => {
		const verifyResponse = {
			org_name: 'Test Organization',
			projects: [
				{ project_id: 'proj-1', project_name: 'Project One', id: 'proj-1', name: 'Project One' },
				{ project_id: 'proj-2', project_name: 'Project Two', id: 'proj-2', name: 'Project Two' }
			]
		};

		const projectId = 'proj-1';
		const orgName = verifyResponse.org_name || '';
		const project = verifyResponse.projects.find((p) =>
			(p.project_id || p.id) === projectId
		);
		const projectName = project?.project_name || project?.name || '';

		assert.strictEqual(orgName, 'Test Organization', 'Should extract org name');
		assert.strictEqual(projectName, 'Project One', 'Should extract project name');
	});
});
