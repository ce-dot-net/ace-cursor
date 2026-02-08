/**
 * Trajectory reading and summarization for Cursor AI-Trail
 *
 * Reads trajectory data from Cursor's JSONL files:
 * - mcp_trajectory.jsonl: MCP tool calls
 * - shell_trajectory.jsonl: Shell commands
 * - edit_trajectory.jsonl: File edits
 * - response_trajectory.jsonl: AI responses
 *
 * Used by ace_learn to capture execution patterns.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export enum TrajectoryType {
	MCP = 'mcp',
	SHELL = 'shell',
	EDIT = 'edit',
	RESPONSE = 'response',
}

export interface BaseTrajectoryEntry {
	conversation_id: string;
	generation_id: string;
	model?: string;
	hook_event_name: string;
	cursor_version?: string;
	workspace_roots?: string[];
	user_email?: string;
}

export interface McpTrajectoryEntry extends BaseTrajectoryEntry {
	tool_name: string;
	tool_input: string;
	result_json?: string;
}

export interface ShellTrajectoryEntry extends BaseTrajectoryEntry {
	command: string;
	output: string;
	duration: number;
	sandbox?: boolean;
}

export interface EditTrajectoryEntry extends BaseTrajectoryEntry {
	file_path: string;
	edits: Array<{ old_string: string; new_string: string }>;
}

export interface ResponseTrajectoryEntry extends BaseTrajectoryEntry {
	text: string;
}

export type TrajectoryEntry =
	| McpTrajectoryEntry
	| ShellTrajectoryEntry
	| EditTrajectoryEntry
	| ResponseTrajectoryEntry;

export interface AllTrajectories {
	mcp: TrajectoryEntry[];
	shell: TrajectoryEntry[];
	edit: TrajectoryEntry[];
	response: TrajectoryEntry[];
}

export interface GitContext {
	branch: string;
	hash: string;
	isRepo: boolean;
	sessionCommits?: string[];
}

export interface TrajectorySummary {
	mcpCount: number;
	shellCount: number;
	editCount: number;
	responseCount: number;
	aiTrailString: string;
	toolCalls?: Record<string, number>;
	editedFiles?: string[];
	shellCommands?: string[];
	trajectorySteps: string[];
	git?: GitContext;
	playbook_used?: string[];
}

export interface TrajectorySummaryContext {
	git?: GitContext;
	playbook_used?: string[];
}

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse a single JSONL line into a trajectory entry
 * Returns null for invalid or empty lines
 */
export function parseTrajectoryLine(line: string): TrajectoryEntry | null {
	// Handle empty or whitespace-only lines
	if (!line || line.trim() === '') {
		return null;
	}

	try {
		const parsed = JSON.parse(line.trim());

		// Validate minimum required fields
		if (!parsed.conversation_id || !parsed.generation_id) {
			return null;
		}

		return parsed as TrajectoryEntry;
	} catch {
		// Invalid JSON - return null
		return null;
	}
}

/**
 * Read and parse all lines from a JSONL trajectory file
 * Skips invalid lines and continues parsing
 * Returns empty array for non-existent files
 */
export function readTrajectoryFile(filePath: string): TrajectoryEntry[] {
	if (!fs.existsSync(filePath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.split('\n');
		const entries: TrajectoryEntry[] = [];

		for (const line of lines) {
			const entry = parseTrajectoryLine(line);
			if (entry) {
				entries.push(entry);
			}
		}

		return entries;
	} catch {
		return [];
	}
}

/**
 * Read all four trajectory files from an ace directory
 * Returns empty arrays for missing files
 */
export function readAllTrajectories(aceDir: string): AllTrajectories {
	const trajectoryFiles = {
		mcp: 'mcp_trajectory.jsonl',
		shell: 'shell_trajectory.jsonl',
		edit: 'edit_trajectory.jsonl',
		response: 'response_trajectory.jsonl',
	};

	return {
		mcp: readTrajectoryFile(path.join(aceDir, trajectoryFiles.mcp)),
		shell: readTrajectoryFile(path.join(aceDir, trajectoryFiles.shell)),
		edit: readTrajectoryFile(path.join(aceDir, trajectoryFiles.edit)),
		response: readTrajectoryFile(path.join(aceDir, trajectoryFiles.response)),
	};
}

// ============================================================================
// Filtering Functions
// ============================================================================

/**
 * Filter trajectory entries by conversation_id
 */
export function filterByConversationId(
	entries: TrajectoryEntry[],
	conversationId: string
): TrajectoryEntry[] {
	return entries.filter((entry) => entry.conversation_id === conversationId);
}

// ============================================================================
// Summary Building Functions
// ============================================================================

/**
 * Type guard for MCP trajectory entries
 */
function isMcpEntry(entry: TrajectoryEntry): entry is McpTrajectoryEntry {
	return 'tool_name' in entry;
}

/**
 * Type guard for Shell trajectory entries
 */
function isShellEntry(entry: TrajectoryEntry): entry is ShellTrajectoryEntry {
	return 'command' in entry && 'duration' in entry;
}

/**
 * Type guard for Edit trajectory entries
 */
function isEditEntry(entry: TrajectoryEntry): entry is EditTrajectoryEntry {
	return 'file_path' in entry && 'edits' in entry;
}

/**
 * Type guard for Response trajectory entries
 */
function isResponseEntry(entry: TrajectoryEntry): entry is ResponseTrajectoryEntry {
	return 'text' in entry && !('command' in entry);
}

/**
 * Build a trajectory summary from all trajectory types
 * Generates counts, tool usage, file lists, and ace_learn compatible steps
 */
export function buildTrajectorySummary(trajectories: AllTrajectories): TrajectorySummary {
	const { mcp, shell, edit, response } = trajectories;

	// Count entries
	const mcpCount = mcp.length;
	const shellCount = shell.length;
	const editCount = edit.length;
	const responseCount = response.length;

	// Build AI-Trail format string
	const aiTrailString = `MCP:${mcpCount} Shell:${shellCount} Edits:${editCount} Responses:${responseCount}`;

	// Count tool calls by name
	const toolCalls: Record<string, number> = {};
	for (const entry of mcp) {
		if (isMcpEntry(entry)) {
			const toolName = entry.tool_name;
			toolCalls[toolName] = (toolCalls[toolName] || 0) + 1;
		}
	}

	// Collect unique edited files
	const editedFilesSet = new Set<string>();
	for (const entry of edit) {
		if (isEditEntry(entry)) {
			editedFilesSet.add(entry.file_path);
		}
	}
	const editedFiles = Array.from(editedFilesSet);

	// Collect unique shell commands
	const shellCommandsSet = new Set<string>();
	for (const entry of shell) {
		if (isShellEntry(entry)) {
			shellCommandsSet.add(entry.command);
		}
	}
	const shellCommands = Array.from(shellCommandsSet);

	// Build trajectory steps for ace_learn
	const trajectorySteps: string[] = [];

	// Add MCP tool steps
	for (const entry of mcp) {
		if (isMcpEntry(entry)) {
			let step = `Called tool: ${entry.tool_name}`;
			try {
				const input = JSON.parse(entry.tool_input);
				if (input.query) {
					step += ` with query: "${input.query}"`;
				} else if (input.path) {
					step += ` on path: ${input.path}`;
				}
			} catch {
				// Input is not valid JSON, skip details
			}
			trajectorySteps.push(step);
		}
	}

	// Add shell command steps
	for (const entry of shell) {
		if (isShellEntry(entry)) {
			const cmd = entry.command;
			const success = !entry.output.toLowerCase().includes('error');
			trajectorySteps.push(`Ran command: ${cmd}${success ? '' : ' (with errors)'}`);
		}
	}

	// Add edit steps
	for (const entry of edit) {
		if (isEditEntry(entry)) {
			const editCount = entry.edits.length;
			trajectorySteps.push(`Edited file: ${entry.file_path} (${editCount} change${editCount !== 1 ? 's' : ''})`);
		}
	}

	return {
		mcpCount,
		shellCount,
		editCount,
		responseCount,
		aiTrailString,
		toolCalls: Object.keys(toolCalls).length > 0 ? toolCalls : undefined,
		editedFiles: editedFiles.length > 0 ? editedFiles : undefined,
		shellCommands: shellCommands.length > 0 ? shellCommands : undefined,
		trajectorySteps,
	};
}

// ============================================================================
// Git Context Functions
// ============================================================================

import { execSync } from 'child_process';

/**
 * Get git context for a workspace directory.
 * Returns branch, hash, and whether the directory is a git repository.
 * Handles non-git directories gracefully.
 *
 * @param workspacePath - Path to the workspace directory (defaults to cwd)
 * @returns GitContext with branch, hash, and isRepo flag
 */
export async function getGitContext(workspacePath?: string): Promise<GitContext> {
	const cwd = workspacePath || process.cwd();

	try {
		// Check if this is a git repository
		execSync('git rev-parse --is-inside-work-tree', {
			cwd,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// Get current branch
		let branch = 'unknown';
		try {
			branch = execSync('git rev-parse --abbrev-ref HEAD', {
				cwd,
				encoding: 'utf-8',
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
		} catch {
			// Fallback to unknown
		}

		// Get current commit hash (short)
		let hash = 'unknown';
		try {
			hash = execSync('git rev-parse --short HEAD', {
				cwd,
				encoding: 'utf-8',
				stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
		} catch {
			// Fallback to unknown
		}

		return {
			branch,
			hash,
			isRepo: true,
		};
	} catch {
		// Not a git repository or git not available
		return {
			branch: 'unknown',
			hash: 'unknown',
			isRepo: false,
		};
	}
}

/**
 * Detect git commits made during a session by scanning shell trajectory entries.
 * Extracts commit SHAs from git commit command outputs.
 *
 * @param shellEntries - Array of shell trajectory entries
 * @returns Array of commit SHAs detected from git commit commands
 */
export function detectCommitsInSession(shellEntries: ShellTrajectoryEntry[]): string[] {
	const commits: string[] = [];

	for (const entry of shellEntries) {
		// Check if this is a git commit command
		if (!entry.command.includes('git commit')) {
			continue;
		}

		// Parse the output for commit SHA
		// Git commit output format: "[branch SHA] message"
		// Example: "[main abc1234] Fix bug"
		const shaMatch = entry.output.match(/\[[\w\-/]+\s+([a-f0-9]{7,40})\]/);
		if (shaMatch) {
			commits.push(shaMatch[1]);
		}
	}

	return commits;
}

// ============================================================================
// Playbook IDs (Pattern Attribution) Functions
// ============================================================================

/**
 * Load playbook IDs (pattern IDs) used during a session.
 * These are pattern IDs from ace_search that were applied to the current task.
 *
 * @param sessionId - The session ID
 * @param aceDir - Optional ace directory path (defaults to .cursor/ace)
 * @returns Array of pattern IDs used in the session
 */
export function loadPlaybookUsed(sessionId: string, aceDir?: string): string[] {
	const dir = aceDir || path.join(process.cwd(), '.cursor', 'ace');
	const stateFile = path.join(dir, `patterns-used-${sessionId}.json`);

	try {
		if (!fs.existsSync(stateFile)) {
			return [];
		}

		const content = fs.readFileSync(stateFile, 'utf-8');
		const parsed = JSON.parse(content);

		if (Array.isArray(parsed)) {
			return parsed;
		}

		return [];
	} catch {
		return [];
	}
}

/**
 * Save playbook IDs (pattern IDs) for a session.
 * Used to record which patterns from ace_search were used during execution.
 *
 * @param sessionId - The session ID
 * @param patternIds - Array of pattern IDs to save
 * @param aceDir - Optional ace directory path (defaults to .cursor/ace)
 */
export function savePlaybookUsed(sessionId: string, patternIds: string[], aceDir?: string): void {
	const dir = aceDir || path.join(process.cwd(), '.cursor', 'ace');

	// Ensure directory exists
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const stateFile = path.join(dir, `patterns-used-${sessionId}.json`);
	fs.writeFileSync(stateFile, JSON.stringify(patternIds), 'utf-8');
}

/**
 * Append a pattern ID to the session's playbook list.
 * Avoids duplicates - only adds if not already present.
 *
 * @param sessionId - The session ID
 * @param patternId - Pattern ID to append
 * @param aceDir - Optional ace directory path (defaults to .cursor/ace)
 */
export function appendPlaybookUsed(sessionId: string, patternId: string, aceDir?: string): void {
	const existing = loadPlaybookUsed(sessionId, aceDir);

	// Avoid duplicates
	if (!existing.includes(patternId)) {
		existing.push(patternId);
		savePlaybookUsed(sessionId, existing, aceDir);
	}
}

// ============================================================================
// Enhanced Summary with Git and Playbook Context
// ============================================================================

/**
 * Build a trajectory summary with additional git and playbook context.
 * This is an enhanced version of buildTrajectorySummary that includes
 * git information and pattern attribution.
 *
 * @param trajectories - All trajectory entries
 * @param context - Optional context with git and playbook_used
 * @returns Enhanced TrajectorySummary with git and playbook_used fields
 */
export function buildTrajectorySummaryWithContext(
	trajectories: AllTrajectories,
	context: TrajectorySummaryContext = {}
): TrajectorySummary {
	// Start with base summary
	const baseSummary = buildTrajectorySummary(trajectories);

	// Add git context if provided
	if (context.git) {
		baseSummary.git = context.git;
	}

	// Add playbook_used if provided
	if (context.playbook_used && context.playbook_used.length > 0) {
		baseSummary.playbook_used = context.playbook_used;
	}

	return baseSummary;
}
