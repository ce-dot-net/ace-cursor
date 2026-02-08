/**
 * Unit tests for trajectory reading functionality
 *
 * Tests the reading and summarization of Cursor AI-Trail trajectory data:
 * - mcp_trajectory.jsonl: MCP tool calls (tool_name, tool_input, result_json)
 * - shell_trajectory.jsonl: Shell commands (command, output, duration)
 * - edit_trajectory.jsonl: File edits (file_path, edits array)
 * - response_trajectory.jsonl: AI responses (text)
 *
 * These tests follow TDD - written before implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode module (not available outside VS Code)
vi.mock('vscode', () => ({
	window: {
		showInformationMessage: vi.fn().mockResolvedValue(undefined),
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
		showErrorMessage: vi.fn().mockResolvedValue(undefined),
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
	Uri: {
		joinPath: vi.fn((uri, ...segments) => ({
			fsPath: path.join(uri.fsPath, ...segments),
		})),
	},
}));

// Types for trajectory entries
interface BaseTrajectoryEntry {
	conversation_id: string;
	generation_id: string;
	model?: string;
	hook_event_name: string;
	cursor_version?: string;
	workspace_roots?: string[];
	user_email?: string;
}

interface McpTrajectoryEntry extends BaseTrajectoryEntry {
	tool_name: string;
	tool_input: string;
	result_json?: string;
}

interface ShellTrajectoryEntry extends BaseTrajectoryEntry {
	command: string;
	output: string;
	duration: number;
	sandbox?: boolean;
}

interface EditTrajectoryEntry extends BaseTrajectoryEntry {
	file_path: string;
	edits: Array<{ old_string: string; new_string: string }>;
}

interface ResponseTrajectoryEntry extends BaseTrajectoryEntry {
	text: string;
}

type TrajectoryEntry = McpTrajectoryEntry | ShellTrajectoryEntry | EditTrajectoryEntry | ResponseTrajectoryEntry;

// Import the module under test (will be implemented)
// These imports will fail initially (TDD red phase)
import {
	parseTrajectoryLine,
	readTrajectoryFile,
	readAllTrajectories,
	filterByConversationId,
	buildTrajectorySummary,
	buildTrajectorySummaryWithContext,
	TrajectoryType,
	getGitContext,
	detectCommitsInSession,
	loadPlaybookUsed,
	savePlaybookUsed,
	appendPlaybookUsed,
} from '../../ace/trajectory';

describe('Trajectory Reading', () => {
	let tempDir: string;
	let aceDir: string;

	beforeEach(() => {
		// Create temp directory for test artifacts
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-trajectory-test-'));
		aceDir = path.join(tempDir, '.cursor', 'ace');
		fs.mkdirSync(aceDir, { recursive: true });
	});

	afterEach(() => {
		// Cleanup temp directory
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('parseTrajectoryLine', () => {
		it('should parse a valid MCP trajectory line', () => {
			const line = JSON.stringify({
				conversation_id: 'conv-123',
				generation_id: 'gen-456',
				tool_name: 'ace_search',
				tool_input: '{"query": "test"}',
				result_json: '{"results": []}',
				hook_event_name: 'afterMcpToolCall',
			});

			const result = parseTrajectoryLine(line);

			expect(result).not.toBeNull();
			expect(result?.conversation_id).toBe('conv-123');
			expect((result as McpTrajectoryEntry).tool_name).toBe('ace_search');
		});

		it('should parse a valid shell trajectory line', () => {
			const line = JSON.stringify({
				conversation_id: 'conv-123',
				generation_id: 'gen-456',
				command: 'npm run build',
				output: 'Build successful',
				duration: 2500.5,
				sandbox: false,
				hook_event_name: 'afterShellExecution',
			});

			const result = parseTrajectoryLine(line);

			expect(result).not.toBeNull();
			expect((result as ShellTrajectoryEntry).command).toBe('npm run build');
			expect((result as ShellTrajectoryEntry).duration).toBe(2500.5);
		});

		it('should parse a valid edit trajectory line', () => {
			const line = JSON.stringify({
				conversation_id: 'conv-123',
				generation_id: 'gen-456',
				file_path: '/path/to/file.ts',
				edits: [{ old_string: 'old', new_string: 'new' }],
				hook_event_name: 'afterFileEdit',
			});

			const result = parseTrajectoryLine(line);

			expect(result).not.toBeNull();
			expect((result as EditTrajectoryEntry).file_path).toBe('/path/to/file.ts');
			expect((result as EditTrajectoryEntry).edits).toHaveLength(1);
		});

		it('should parse a valid response trajectory line', () => {
			const line = JSON.stringify({
				conversation_id: 'conv-123',
				generation_id: 'gen-456',
				text: 'This is the AI response text',
				hook_event_name: 'afterAgentResponse',
			});

			const result = parseTrajectoryLine(line);

			expect(result).not.toBeNull();
			expect((result as ResponseTrajectoryEntry).text).toBe('This is the AI response text');
		});

		it('should return null for invalid JSON', () => {
			const result = parseTrajectoryLine('not valid json');
			expect(result).toBeNull();
		});

		it('should return null for empty line', () => {
			const result = parseTrajectoryLine('');
			expect(result).toBeNull();
		});

		it('should return null for whitespace-only line', () => {
			const result = parseTrajectoryLine('   \t\n  ');
			expect(result).toBeNull();
		});
	});

	describe('readTrajectoryFile', () => {
		it('should read and parse all lines from a JSONL file', () => {
			const filePath = path.join(aceDir, 'test_trajectory.jsonl');
			const entries = [
				{ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'ls', output: 'file1', duration: 100, hook_event_name: 'afterShellExecution' },
				{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'pwd', output: '/home', duration: 50, hook_event_name: 'afterShellExecution' },
			];
			fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n'));

			const result = readTrajectoryFile(filePath);

			expect(result).toHaveLength(2);
			expect((result[0] as ShellTrajectoryEntry).command).toBe('ls');
			expect((result[1] as ShellTrajectoryEntry).command).toBe('pwd');
		});

		it('should skip invalid lines and continue parsing', () => {
			const filePath = path.join(aceDir, 'mixed_trajectory.jsonl');
			const content = [
				JSON.stringify({ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'valid', output: 'ok', duration: 100, hook_event_name: 'afterShellExecution' }),
				'invalid json line',
				JSON.stringify({ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'also-valid', output: 'ok', duration: 200, hook_event_name: 'afterShellExecution' }),
			].join('\n');
			fs.writeFileSync(filePath, content);

			const result = readTrajectoryFile(filePath);

			expect(result).toHaveLength(2);
		});

		it('should return empty array for non-existent file', () => {
			const result = readTrajectoryFile('/non/existent/file.jsonl');
			expect(result).toEqual([]);
		});

		it('should return empty array for empty file', () => {
			const filePath = path.join(aceDir, 'empty.jsonl');
			fs.writeFileSync(filePath, '');

			const result = readTrajectoryFile(filePath);

			expect(result).toEqual([]);
		});

		it('should handle file with only whitespace lines', () => {
			const filePath = path.join(aceDir, 'whitespace.jsonl');
			fs.writeFileSync(filePath, '\n\n   \n\t\n');

			const result = readTrajectoryFile(filePath);

			expect(result).toEqual([]);
		});
	});

	describe('readAllTrajectories', () => {
		it('should read all four trajectory files from ace directory', () => {
			// Create all four trajectory files
			const mcpEntry = { conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' };
			const shellEntry = { conversation_id: 'conv-1', generation_id: 'gen-2', command: 'npm test', output: 'ok', duration: 1000, hook_event_name: 'afterShellExecution' };
			const editEntry = { conversation_id: 'conv-1', generation_id: 'gen-3', file_path: '/test.ts', edits: [], hook_event_name: 'afterFileEdit' };
			const responseEntry = { conversation_id: 'conv-1', generation_id: 'gen-4', text: 'Done', hook_event_name: 'afterAgentResponse' };

			fs.writeFileSync(path.join(aceDir, 'mcp_trajectory.jsonl'), JSON.stringify(mcpEntry));
			fs.writeFileSync(path.join(aceDir, 'shell_trajectory.jsonl'), JSON.stringify(shellEntry));
			fs.writeFileSync(path.join(aceDir, 'edit_trajectory.jsonl'), JSON.stringify(editEntry));
			fs.writeFileSync(path.join(aceDir, 'response_trajectory.jsonl'), JSON.stringify(responseEntry));

			const result = readAllTrajectories(aceDir);

			expect(result.mcp).toHaveLength(1);
			expect(result.shell).toHaveLength(1);
			expect(result.edit).toHaveLength(1);
			expect(result.response).toHaveLength(1);
		});

		it('should handle missing trajectory files gracefully', () => {
			// Only create mcp trajectory
			const mcpEntry = { conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' };
			fs.writeFileSync(path.join(aceDir, 'mcp_trajectory.jsonl'), JSON.stringify(mcpEntry));

			const result = readAllTrajectories(aceDir);

			expect(result.mcp).toHaveLength(1);
			expect(result.shell).toEqual([]);
			expect(result.edit).toEqual([]);
			expect(result.response).toEqual([]);
		});

		it('should return empty arrays for non-existent directory', () => {
			const result = readAllTrajectories('/non/existent/dir');

			expect(result.mcp).toEqual([]);
			expect(result.shell).toEqual([]);
			expect(result.edit).toEqual([]);
			expect(result.response).toEqual([]);
		});
	});

	describe('filterByConversationId', () => {
		it('should filter entries by conversation_id', () => {
			const entries: TrajectoryEntry[] = [
				{ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'cmd1', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				{ conversation_id: 'conv-2', generation_id: 'gen-2', command: 'cmd2', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				{ conversation_id: 'conv-1', generation_id: 'gen-3', command: 'cmd3', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
			];

			const result = filterByConversationId(entries, 'conv-1');

			expect(result).toHaveLength(2);
			expect((result[0] as ShellTrajectoryEntry).command).toBe('cmd1');
			expect((result[1] as ShellTrajectoryEntry).command).toBe('cmd3');
		});

		it('should return empty array when no entries match', () => {
			const entries: TrajectoryEntry[] = [
				{ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'cmd1', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
			];

			const result = filterByConversationId(entries, 'conv-999');

			expect(result).toEqual([]);
		});

		it('should return empty array for empty input', () => {
			const result = filterByConversationId([], 'conv-1');
			expect(result).toEqual([]);
		});
	});

	describe('buildTrajectorySummary', () => {
		it('should build summary with counts for each trajectory type', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', tool_name: 'ace_learn', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-3', command: 'npm test', output: 'ok', duration: 1000, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [
					{ conversation_id: 'conv-1', generation_id: 'gen-4', file_path: '/a.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-5', file_path: '/b.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-6', file_path: '/c.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
				],
				response: [
					{ conversation_id: 'conv-1', generation_id: 'gen-7', text: 'Response 1', hook_event_name: 'afterAgentResponse' } as ResponseTrajectoryEntry,
				],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.mcpCount).toBe(2);
			expect(summary.shellCount).toBe(1);
			expect(summary.editCount).toBe(3);
			expect(summary.responseCount).toBe(1);
		});

		it('should include tool names in MCP summary', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', tool_name: 'ace_learn', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-3', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.toolCalls).toBeDefined();
			expect(summary.toolCalls?.['ace_search']).toBe(2);
			expect(summary.toolCalls?.['ace_learn']).toBe(1);
		});

		it('should include edited file paths in summary', () => {
			const trajectories = {
				mcp: [],
				shell: [],
				edit: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', file_path: '/src/a.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', file_path: '/src/b.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
				],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.editedFiles).toBeDefined();
			expect(summary.editedFiles).toContain('/src/a.ts');
			expect(summary.editedFiles).toContain('/src/b.ts');
		});

		it('should include shell commands in summary', () => {
			const trajectories = {
				mcp: [],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'npm run build', output: 'ok', duration: 1000, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'npm test', output: 'passed', duration: 2000, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.shellCommands).toBeDefined();
			expect(summary.shellCommands).toContain('npm run build');
			expect(summary.shellCommands).toContain('npm test');
		});

		it('should return zero counts for empty trajectories', () => {
			const trajectories = {
				mcp: [],
				shell: [],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.mcpCount).toBe(0);
			expect(summary.shellCount).toBe(0);
			expect(summary.editCount).toBe(0);
			expect(summary.responseCount).toBe(0);
		});

		it('should generate AI-Trail format string', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'npm test', output: 'ok', duration: 1000, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [
					{ conversation_id: 'conv-1', generation_id: 'gen-3', file_path: '/a.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
				],
				response: [
					{ conversation_id: 'conv-1', generation_id: 'gen-4', text: 'Done', hook_event_name: 'afterAgentResponse' } as ResponseTrajectoryEntry,
				],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.aiTrailString).toBe('MCP:1 Shell:1 Edits:1 Responses:1');
		});

		it('should generate trajectory array for ace_learn', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{"query":"test"}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'npm run build', output: 'success', duration: 1000, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [
					{ conversation_id: 'conv-1', generation_id: 'gen-3', file_path: '/src/app.ts', edits: [{ old_string: 'old', new_string: 'new' }], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
				],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			expect(summary.trajectorySteps).toBeDefined();
			expect(Array.isArray(summary.trajectorySteps)).toBe(true);
			expect(summary.trajectorySteps.length).toBeGreaterThan(0);
			// Steps should be strings describing the action
			expect(summary.trajectorySteps.some((s: string) => s.includes('ace_search'))).toBe(true);
			expect(summary.trajectorySteps.some((s: string) => s.includes('npm run build'))).toBe(true);
			expect(summary.trajectorySteps.some((s: string) => s.includes('/src/app.ts'))).toBe(true);
		});
	});

	describe('TrajectoryType enum', () => {
		it('should have all trajectory types defined', () => {
			expect(TrajectoryType.MCP).toBe('mcp');
			expect(TrajectoryType.SHELL).toBe('shell');
			expect(TrajectoryType.EDIT).toBe('edit');
			expect(TrajectoryType.RESPONSE).toBe('response');
		});
	});

	describe('Integration: Full Trajectory Flow', () => {
		it('should read, filter, and summarize a complete trajectory', () => {
			// Create realistic trajectory data
			const conversationId = 'test-conv-12345';

			const mcpEntries = [
				{ conversation_id: conversationId, generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{"query":"JWT auth"}', result_json: '{"results":[]}', hook_event_name: 'afterMcpToolCall' },
				{ conversation_id: conversationId, generation_id: 'gen-2', tool_name: 'read_file', tool_input: '{"path":"/src/auth.ts"}', result_json: '{"content":"..."}', hook_event_name: 'afterMcpToolCall' },
				{ conversation_id: 'other-conv', generation_id: 'gen-x', tool_name: 'other_tool', tool_input: '{}', hook_event_name: 'afterMcpToolCall' },
			];

			const shellEntries = [
				{ conversation_id: conversationId, generation_id: 'gen-3', command: 'npm run build', output: 'Build successful', duration: 3000, hook_event_name: 'afterShellExecution' },
				{ conversation_id: conversationId, generation_id: 'gen-4', command: 'npm test', output: 'All tests passed', duration: 5000, hook_event_name: 'afterShellExecution' },
			];

			const editEntries = [
				{ conversation_id: conversationId, generation_id: 'gen-5', file_path: '/src/auth.ts', edits: [{ old_string: 'old', new_string: 'new' }], hook_event_name: 'afterFileEdit' },
			];

			const responseEntries = [
				{ conversation_id: conversationId, generation_id: 'gen-6', text: 'I have implemented JWT authentication.', hook_event_name: 'afterAgentResponse' },
			];

			// Write files
			fs.writeFileSync(path.join(aceDir, 'mcp_trajectory.jsonl'), mcpEntries.map(e => JSON.stringify(e)).join('\n'));
			fs.writeFileSync(path.join(aceDir, 'shell_trajectory.jsonl'), shellEntries.map(e => JSON.stringify(e)).join('\n'));
			fs.writeFileSync(path.join(aceDir, 'edit_trajectory.jsonl'), editEntries.map(e => JSON.stringify(e)).join('\n'));
			fs.writeFileSync(path.join(aceDir, 'response_trajectory.jsonl'), responseEntries.map(e => JSON.stringify(e)).join('\n'));

			// Read all trajectories
			const allTrajectories = readAllTrajectories(aceDir);

			// Filter by conversation_id
			const filteredMcp = filterByConversationId(allTrajectories.mcp, conversationId);
			const filteredShell = filterByConversationId(allTrajectories.shell, conversationId);
			const filteredEdit = filterByConversationId(allTrajectories.edit, conversationId);
			const filteredResponse = filterByConversationId(allTrajectories.response, conversationId);

			// Should have filtered out the other conversation
			expect(filteredMcp).toHaveLength(2);
			expect(allTrajectories.mcp).toHaveLength(3);

			// Build summary
			const summary = buildTrajectorySummary({
				mcp: filteredMcp,
				shell: filteredShell,
				edit: filteredEdit,
				response: filteredResponse,
			});

			// Verify summary
			expect(summary.mcpCount).toBe(2);
			expect(summary.shellCount).toBe(2);
			expect(summary.editCount).toBe(1);
			expect(summary.responseCount).toBe(1);
			expect(summary.aiTrailString).toBe('MCP:2 Shell:2 Edits:1 Responses:1');
			expect(summary.toolCalls?.['ace_search']).toBe(1);
			expect(summary.toolCalls?.['read_file']).toBe(1);
			expect(summary.editedFiles).toContain('/src/auth.ts');
		});
	});

	describe('Edge Cases', () => {
		it('should handle very long command outputs', () => {
			const longOutput = 'x'.repeat(100000);
			const entry = {
				conversation_id: 'conv-1',
				generation_id: 'gen-1',
				command: 'cat large-file.txt',
				output: longOutput,
				duration: 100,
				hook_event_name: 'afterShellExecution',
			};
			const filePath = path.join(aceDir, 'shell_trajectory.jsonl');
			fs.writeFileSync(filePath, JSON.stringify(entry));

			const result = readTrajectoryFile(filePath);

			expect(result).toHaveLength(1);
			expect((result[0] as ShellTrajectoryEntry).output.length).toBe(100000);
		});

		it('should handle unicode characters in trajectory data', () => {
			const entry = {
				conversation_id: 'conv-1',
				generation_id: 'gen-1',
				text: 'Hello world! Chinese text here.',
				hook_event_name: 'afterAgentResponse',
			};
			const filePath = path.join(aceDir, 'response_trajectory.jsonl');
			fs.writeFileSync(filePath, JSON.stringify(entry), 'utf-8');

			const result = readTrajectoryFile(filePath);

			expect(result).toHaveLength(1);
			expect((result[0] as ResponseTrajectoryEntry).text).toContain('Chinese text');
		});

		it('should handle special characters in file paths', () => {
			const entry = {
				conversation_id: 'conv-1',
				generation_id: 'gen-1',
				file_path: '/path/with spaces/and-dashes/file (1).ts',
				edits: [],
				hook_event_name: 'afterFileEdit',
			};
			const filePath = path.join(aceDir, 'edit_trajectory.jsonl');
			fs.writeFileSync(filePath, JSON.stringify(entry));

			const result = readTrajectoryFile(filePath);

			expect(result).toHaveLength(1);
			expect((result[0] as EditTrajectoryEntry).file_path).toBe('/path/with spaces/and-dashes/file (1).ts');
		});

		it('should handle malformed JSON mixed with valid entries', () => {
			const content = [
				JSON.stringify({ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'valid1', output: '', duration: 100, hook_event_name: 'afterShellExecution' }),
				'{"incomplete json',
				'not json at all',
				JSON.stringify({ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'valid2', output: '', duration: 200, hook_event_name: 'afterShellExecution' }),
				'',
				JSON.stringify({ conversation_id: 'conv-1', generation_id: 'gen-3', command: 'valid3', output: '', duration: 300, hook_event_name: 'afterShellExecution' }),
			].join('\n');

			const filePath = path.join(aceDir, 'shell_trajectory.jsonl');
			fs.writeFileSync(filePath, content);

			const result = readTrajectoryFile(filePath);

			expect(result).toHaveLength(3);
		});

		it('should deduplicate edited files in summary', () => {
			const trajectories = {
				mcp: [],
				shell: [],
				edit: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', file_path: '/src/app.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', file_path: '/src/app.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-3', file_path: '/src/other.ts', edits: [], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
				],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			// Should have 3 edit operations but only 2 unique files
			expect(summary.editCount).toBe(3);
			expect(summary.editedFiles).toHaveLength(2);
		});

		it('should deduplicate shell commands in summary', () => {
			const trajectories = {
				mcp: [],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'npm run build', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'npm run build', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-3', command: 'npm test', output: '', duration: 100, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummary(trajectories);

			// Should have 3 shell operations but only 2 unique commands
			expect(summary.shellCount).toBe(3);
			expect(summary.shellCommands).toHaveLength(2);
		});
	});

	// =========================================================================
	// Git Context Tests (TDD - written before implementation)
	// =========================================================================

	describe('getGitContext', () => {
		it('should return git context for the current working directory (a real git repo)', async () => {
			// The test is running inside the actual project which is a git repo
			// Use the project root directory
			const projectRoot = path.resolve(__dirname, '../../..');
			const result = await getGitContext(projectRoot);

			expect(result.isRepo).toBe(true);
			expect(result.branch).toBeDefined();
			expect(result.branch).not.toBe('unknown');
			expect(result.hash).toMatch(/^[a-f0-9]+$/);
		});

		it('should return isRepo: false for non-git directory', async () => {
			const nonGitDir = path.join(tempDir, 'not-a-repo');
			fs.mkdirSync(nonGitDir, { recursive: true });

			const result = await getGitContext(nonGitDir);

			expect(result.isRepo).toBe(false);
			expect(result.branch).toBe('unknown');
			expect(result.hash).toBe('unknown');
		});

		it('should handle missing workspace path gracefully', async () => {
			const result = await getGitContext(undefined);

			// Should use current working directory or return safe defaults
			expect(result).toBeDefined();
			expect(typeof result.isRepo).toBe('boolean');
			expect(typeof result.branch).toBe('string');
			expect(typeof result.hash).toBe('string');
		});
	});

	describe('detectCommitsInSession', () => {
		it('should detect git commit commands in shell trajectory', () => {
			const shellEntries: ShellTrajectoryEntry[] = [
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-1',
					command: 'git add .',
					output: '',
					duration: 100,
					hook_event_name: 'afterShellExecution',
				},
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-2',
					command: 'git commit -m "Fix bug"',
					output: '[main abc1234] Fix bug\n 1 file changed, 5 insertions(+)',
					duration: 500,
					hook_event_name: 'afterShellExecution',
				},
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-3',
					command: 'npm test',
					output: 'All tests passed',
					duration: 3000,
					hook_event_name: 'afterShellExecution',
				},
			];

			const commits = detectCommitsInSession(shellEntries);

			expect(commits).toHaveLength(1);
			expect(commits[0]).toBe('abc1234');
		});

		it('should detect multiple commits in session', () => {
			const shellEntries: ShellTrajectoryEntry[] = [
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-1',
					command: 'git commit -m "First commit"',
					output: '[main abc1234] First commit\n 2 files changed',
					duration: 500,
					hook_event_name: 'afterShellExecution',
				},
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-2',
					command: 'git commit -m "Second commit"',
					output: '[main def5678] Second commit\n 1 file changed',
					duration: 500,
					hook_event_name: 'afterShellExecution',
				},
			];

			const commits = detectCommitsInSession(shellEntries);

			expect(commits).toHaveLength(2);
			expect(commits).toContain('abc1234');
			expect(commits).toContain('def5678');
		});

		it('should return empty array when no commits found', () => {
			const shellEntries: ShellTrajectoryEntry[] = [
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-1',
					command: 'npm run build',
					output: 'Build successful',
					duration: 3000,
					hook_event_name: 'afterShellExecution',
				},
			];

			const commits = detectCommitsInSession(shellEntries);

			expect(commits).toEqual([]);
		});

		it('should handle git commit with --amend flag', () => {
			const shellEntries: ShellTrajectoryEntry[] = [
				{
					conversation_id: 'conv-1',
					generation_id: 'gen-1',
					command: 'git commit --amend -m "Updated commit"',
					output: '[feature/test fade999] Updated commit\n 1 file changed',
					duration: 500,
					hook_event_name: 'afterShellExecution',
				},
			];

			const commits = detectCommitsInSession(shellEntries);

			expect(commits).toHaveLength(1);
			expect(commits[0]).toBe('fade999');
		});

		it('should handle empty shell entries', () => {
			const commits = detectCommitsInSession([]);

			expect(commits).toEqual([]);
		});
	});

	// =========================================================================
	// Playbook IDs Tests (Pattern Attribution - TDD)
	// =========================================================================

	describe('loadPlaybookUsed', () => {
		it('should load playbook IDs from session state file', () => {
			const sessionId = 'test-session-123';
			const patternIds = ['pattern-uuid-1', 'pattern-uuid-2', 'pattern-uuid-3'];

			// Create the patterns-used state file
			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);
			fs.writeFileSync(stateFile, JSON.stringify(patternIds));

			const result = loadPlaybookUsed(sessionId, aceDir);

			expect(result).toEqual(patternIds);
		});

		it('should return empty array if state file does not exist', () => {
			const result = loadPlaybookUsed('non-existent-session', aceDir);

			expect(result).toEqual([]);
		});

		it('should return empty array for invalid JSON in state file', () => {
			const sessionId = 'bad-json-session';
			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);
			fs.writeFileSync(stateFile, 'not valid json');

			const result = loadPlaybookUsed(sessionId, aceDir);

			expect(result).toEqual([]);
		});

		it('should handle empty array in state file', () => {
			const sessionId = 'empty-patterns-session';
			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);
			fs.writeFileSync(stateFile, JSON.stringify([]));

			const result = loadPlaybookUsed(sessionId, aceDir);

			expect(result).toEqual([]);
		});
	});

	describe('savePlaybookUsed', () => {
		it('should save playbook IDs to session state file', () => {
			const sessionId = 'save-test-session';
			const patternIds = ['pattern-a', 'pattern-b'];

			savePlaybookUsed(sessionId, patternIds, aceDir);

			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);
			expect(fs.existsSync(stateFile)).toBe(true);

			const savedData = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
			expect(savedData).toEqual(patternIds);
		});

		it('should overwrite existing state file', () => {
			const sessionId = 'overwrite-test-session';
			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);

			// Write initial data
			fs.writeFileSync(stateFile, JSON.stringify(['old-pattern']));

			// Overwrite with new data
			const newPatternIds = ['new-pattern-1', 'new-pattern-2'];
			savePlaybookUsed(sessionId, newPatternIds, aceDir);

			const savedData = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
			expect(savedData).toEqual(newPatternIds);
		});

		it('should create ace directory if it does not exist', () => {
			const newAceDir = path.join(tempDir, 'new-cursor', 'ace');
			const sessionId = 'new-dir-test';
			const patternIds = ['pattern-x'];

			savePlaybookUsed(sessionId, patternIds, newAceDir);

			expect(fs.existsSync(newAceDir)).toBe(true);
			const stateFile = path.join(newAceDir, `patterns-used-${sessionId}.json`);
			expect(fs.existsSync(stateFile)).toBe(true);
		});
	});

	describe('appendPlaybookUsed', () => {
		it('should append a pattern ID to existing list', () => {
			const sessionId = 'append-test-session';
			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);

			// Start with one pattern
			fs.writeFileSync(stateFile, JSON.stringify(['existing-pattern']));

			appendPlaybookUsed(sessionId, 'new-pattern', aceDir);

			const result = loadPlaybookUsed(sessionId, aceDir);
			expect(result).toEqual(['existing-pattern', 'new-pattern']);
		});

		it('should create new list if state file does not exist', () => {
			const sessionId = 'new-append-session';

			appendPlaybookUsed(sessionId, 'first-pattern', aceDir);

			const result = loadPlaybookUsed(sessionId, aceDir);
			expect(result).toEqual(['first-pattern']);
		});

		it('should not add duplicate pattern IDs', () => {
			const sessionId = 'no-dupes-session';
			const stateFile = path.join(aceDir, `patterns-used-${sessionId}.json`);

			fs.writeFileSync(stateFile, JSON.stringify(['pattern-1']));

			appendPlaybookUsed(sessionId, 'pattern-1', aceDir);
			appendPlaybookUsed(sessionId, 'pattern-1', aceDir);

			const result = loadPlaybookUsed(sessionId, aceDir);
			expect(result).toEqual(['pattern-1']);
		});
	});

	// =========================================================================
	// Enhanced TrajectorySummary Tests (with git and playbook_used)
	// =========================================================================

	describe('buildTrajectorySummary with git and playbook_used', () => {
		it('should include git context in summary when provided', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'git commit -m "test"', output: '[main abc1234] test', duration: 500, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [],
				response: [],
			};

			const gitContext = {
				branch: 'feature/test',
				hash: 'abc1234',
				isRepo: true,
			};

			const summary = buildTrajectorySummaryWithContext(trajectories, { git: gitContext });

			expect(summary.git).toBeDefined();
			expect(summary.git?.branch).toBe('feature/test');
			expect(summary.git?.hash).toBe('abc1234');
		});

		it('should include session commits detected from shell trajectory', () => {
			const trajectories = {
				mcp: [],
				shell: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', command: 'git commit -m "First"', output: '[main abc1234] First', duration: 500, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
					{ conversation_id: 'conv-1', generation_id: 'gen-2', command: 'git commit -m "Second"', output: '[main def5678] Second', duration: 500, hook_event_name: 'afterShellExecution' } as ShellTrajectoryEntry,
				],
				edit: [],
				response: [],
			};

			const gitContext = {
				branch: 'main',
				hash: 'def5678',
				isRepo: true,
			};

			const sessionCommits = detectCommitsInSession(trajectories.shell);
			const summary = buildTrajectorySummaryWithContext(trajectories, {
				git: { ...gitContext, sessionCommits },
			});

			expect(summary.git?.sessionCommits).toBeDefined();
			expect(summary.git?.sessionCommits).toContain('abc1234');
			expect(summary.git?.sessionCommits).toContain('def5678');
		});

		it('should include playbook_used in summary when provided', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{"query":"auth"}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [],
				edit: [],
				response: [],
			};

			const playbookUsed = ['pattern-uuid-1', 'pattern-uuid-2'];

			const summary = buildTrajectorySummaryWithContext(trajectories, { playbook_used: playbookUsed });

			expect(summary.playbook_used).toBeDefined();
			expect(summary.playbook_used).toEqual(playbookUsed);
		});

		it('should include both git and playbook_used in summary', () => {
			const trajectories = {
				mcp: [
					{ conversation_id: 'conv-1', generation_id: 'gen-1', tool_name: 'ace_search', tool_input: '{}', hook_event_name: 'afterMcpToolCall' } as McpTrajectoryEntry,
				],
				shell: [],
				edit: [
					{ conversation_id: 'conv-1', generation_id: 'gen-2', file_path: '/src/auth.ts', edits: [{ old_string: 'old', new_string: 'new' }], hook_event_name: 'afterFileEdit' } as EditTrajectoryEntry,
				],
				response: [],
			};

			const context = {
				git: { branch: 'main', hash: 'abc7890', isRepo: true },
				playbook_used: ['pattern-1', 'pattern-2'],
			};

			const summary = buildTrajectorySummaryWithContext(trajectories, context);

			expect(summary.mcpCount).toBe(1);
			expect(summary.editCount).toBe(1);
			expect(summary.git?.branch).toBe('main');
			expect(summary.git?.hash).toBe('abc7890');
			expect(summary.playbook_used).toEqual(['pattern-1', 'pattern-2']);
		});

		it('should handle missing git and playbook_used gracefully', () => {
			const trajectories = {
				mcp: [],
				shell: [],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummaryWithContext(trajectories, {});

			expect(summary.git).toBeUndefined();
			expect(summary.playbook_used).toBeUndefined();
		});
	});

	// =========================================================================
	// Enhanced TrajectorySummary Type Tests
	// =========================================================================

	describe('TrajectorySummary type with git and playbook_used fields', () => {
		it('should have optional git field with correct structure', () => {
			const trajectories = {
				mcp: [],
				shell: [],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummaryWithContext(trajectories, {
				git: {
					branch: 'develop',
					hash: 'abcdef1',
					isRepo: true,
					sessionCommits: ['abc1234', 'def5678'],
				},
			});

			// Verify structure
			expect(summary.git).toMatchObject({
				branch: 'develop',
				hash: 'abcdef1',
				sessionCommits: ['abc1234', 'def5678'],
			});
		});

		it('should have optional playbook_used field as string array', () => {
			const trajectories = {
				mcp: [],
				shell: [],
				edit: [],
				response: [],
			};

			const summary = buildTrajectorySummaryWithContext(trajectories, {
				playbook_used: ['uuid-1', 'uuid-2', 'uuid-3'],
			});

			expect(Array.isArray(summary.playbook_used)).toBe(true);
			expect(summary.playbook_used).toHaveLength(3);
		});
	});
});
