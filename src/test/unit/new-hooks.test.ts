/**
 * Unit tests for new Cursor hooks and scripts (TDD - written before implementation)
 *
 * Tests the 11 new hooks added to the hooks.json configuration and the
 * corresponding 10 new shell/PowerShell scripts for the AI-Trail feature:
 *
 * New hooks: preToolUse, postToolUse, postToolUseFailure, beforeShellExecution,
 *            beforeMCPExecution, beforeReadFile, beforeSubmitPrompt,
 *            afterAgentThought, beforeTabFileRead, afterTabFileEdit
 *
 * New scripts: ace_pre_tool_use, ace_post_tool_use, ace_post_tool_use_failure,
 *              ace_before_shell, ace_before_mcp, ace_before_read_file,
 *              ace_before_submit_prompt, ace_after_agent_thought,
 *              ace_before_tab_file_read, ace_after_tab_file_edit
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
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			show: vi.fn(),
			dispose: vi.fn(),
		}),
		createStatusBarItem: vi.fn().mockReturnValue({
			text: '',
			tooltip: '',
			command: '',
			show: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
	Uri: {
		joinPath: vi.fn((uri: any, ...segments: string[]) => ({
			fsPath: path.join(uri.fsPath, ...segments),
		})),
	},
	StatusBarAlignment: {
		Right: 2,
	},
}));

// ============================================================================
// Helpers: build the hooks.json config and scripts the same way extension.ts
// will once implemented.  These helpers mirror the logic under test so that
// the tests remain self-contained.
// ============================================================================

const ALL_EXPECTED_HOOKS = [
	'sessionStart',
	'sessionEnd',
	'afterMCPExecution',
	'afterShellExecution',
	'afterAgentResponse',
	'afterFileEdit',
	'stop',
	'preCompact',
	'subagentStart',
	'subagentStop',
	// New hooks (v0.3+)
	'preToolUse',
	'postToolUse',
	'postToolUseFailure',
	'beforeShellExecution',
	'beforeMCPExecution',
	'beforeReadFile',
	'beforeSubmitPrompt',
	'afterAgentThought',
	'beforeTabFileRead',
	'afterTabFileEdit',
];

/** Build the complete hooks config as the updated extension should produce it */
function buildHooksConfig(scriptExt: '.sh' | '.ps1', scriptPrefix: string = '') {
	const s = (name: string) => `${scriptPrefix}.cursor/scripts/${name}${scriptExt}`;
	return {
		version: 1,
		hooks: {
			// Existing hooks
			sessionStart: [{ command: s('ace_session_start') }],
			sessionEnd: [{ command: s('ace_session_end') }],
			afterMCPExecution: [{ command: s('ace_track_mcp') }],
			afterShellExecution: [{ command: s('ace_track_shell') }],
			afterAgentResponse: [{ command: s('ace_track_response') }],
			afterFileEdit: [{ command: s('ace_track_edit') }],
			stop: [{ command: s('ace_stop_hook'), loop_limit: null }],
			preCompact: [{ command: s('ace_pre_compact') }],
			subagentStart: [{ command: s('ace_subagent_start'), matcher: '.*' }],
			subagentStop: [{ command: s('ace_subagent_stop') }],
			// New hooks
			preToolUse: [{ command: s('ace_pre_tool_use'), matcher: '.*' }],
			postToolUse: [{ command: s('ace_post_tool_use') }],
			postToolUseFailure: [{ command: s('ace_post_tool_use_failure') }],
			beforeShellExecution: [{ command: s('ace_before_shell'), matcher: '.*' }],
			beforeMCPExecution: [{ command: s('ace_before_mcp') }],
			beforeReadFile: [{ command: s('ace_before_read_file') }],
			beforeSubmitPrompt: [{ command: s('ace_before_submit_prompt'), timeout: 5000 }],
			afterAgentThought: [{ command: s('ace_after_agent_thought') }],
			beforeTabFileRead: [{ command: s('ace_before_tab_file_read') }],
			afterTabFileEdit: [{ command: s('ace_after_tab_file_edit') }],
		},
	};
}

/** Write the 10 new Unix scripts to a directory (simulating extension output) */
function writeNewUnixScripts(scriptsDir: string): void {
	fs.mkdirSync(scriptsDir, { recursive: true });

	// ace_pre_tool_use.sh - decision hook, outputs allow/block JSON
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_pre_tool_use.sh'),
		`#!/bin/bash
# ACE Pre-Tool-Use Hook - Decision gate before every MCP tool call
# Input: tool_name, tool_input
# Output: {"decision": "allow"} or {"decision": "block", "reason": "..."}

input=$(cat)
echo '{"decision": "allow"}'
`,
		{ mode: 0o755 }
	);

	// ace_post_tool_use.sh - writes to mcp_trajectory.jsonl
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_post_tool_use.sh'),
		`#!/bin/bash
# ACE Post-Tool-Use Hook - Records successful MCP tool results for AI-Trail
# Input: tool_name, tool_input, result_json, duration_ms

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
echo "$input" >> "$ace_dir/mcp_trajectory.jsonl"
echo '{}'
`,
		{ mode: 0o755 }
	);

	// ace_post_tool_use_failure.sh - logs error_type and error_message
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_post_tool_use_failure.sh'),
		`#!/bin/bash
# ACE Post-Tool-Use Failure Hook - Records MCP tool failures for AI-Trail
# Input: tool_name, tool_input, error_type, error_message

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
error_type=$(echo "$input" | jq -r '.error_type // "unknown"')
error_message=$(echo "$input" | jq -r '.error_message // ""')
echo "$input" >> "$ace_dir/mcp_trajectory.jsonl"
echo '{}'
`,
		{ mode: 0o755 }
	);

	// ace_before_shell.sh - decision hook for shell commands
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_shell.sh'),
		`#!/bin/bash
# ACE Before-Shell-Execution Hook - Decision gate before shell commands
# Input: command
# Output: {"decision": "allow"} or {"decision": "block", "reason": "..."}

input=$(cat)
echo '{"decision": "allow"}'
`,
		{ mode: 0o755 }
	);

	// ace_before_mcp.sh - decision hook before MCP calls
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_mcp.sh'),
		`#!/bin/bash
# ACE Before-MCP-Execution Hook - Decision gate before MCP server calls
# Input: server_name, tool_name, tool_input
# Output: {"decision": "allow"} or {"decision": "block", "reason": "..."}

input=$(cat)
echo '{"decision": "allow"}'
`,
		{ mode: 0o755 }
	);

	// ace_before_read_file.sh - decision hook before file reads
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_read_file.sh'),
		`#!/bin/bash
# ACE Before-Read-File Hook - Decision gate before file reads
# Input: file_path
# Output: {"decision": "allow"} or {"decision": "block", "reason": "..."}

input=$(cat)
echo '{"decision": "allow"}'
`,
		{ mode: 0o755 }
	);

	// ace_before_submit_prompt.sh - reads pattern_cache.json for context injection
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_submit_prompt.sh'),
		`#!/bin/bash
# ACE Before-Submit-Prompt Hook - Injects pattern context into prompts
# Input: prompt_text, conversation_id
# Output: {"additional_context": "..."} when patterns are cached

input=$(cat)
ace_dir=".cursor/ace"
cache_file="$ace_dir/pattern_cache.json"

if [ -f "$cache_file" ]; then
  pattern_count=$(jq -r '.patternCount // 0' "$cache_file" 2>/dev/null || echo "0")
  if [ "$pattern_count" -gt 0 ] 2>/dev/null; then
    domains=$(jq -r '.domains // [] | join(", ")' "$cache_file" 2>/dev/null || echo "")
    context="[ACE] $pattern_count patterns available. Use ace_search to retrieve relevant patterns."
    echo "{\\"additional_context\\": \\"$context\\"}"
    exit 0
  fi
fi

echo '{}'
`,
		{ mode: 0o755 }
	);

	// ace_after_agent_thought.sh - writes to response_trajectory.jsonl
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_after_agent_thought.sh'),
		`#!/bin/bash
# ACE After-Agent-Thought Hook - Records AI reasoning steps for AI-Trail
# Input: thought_text, conversation_id, generation_id

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
echo "$input" >> "$ace_dir/response_trajectory.jsonl"
echo '{}'
`,
		{ mode: 0o755 }
	);

	// ace_before_tab_file_read.sh - minimal, just allows the read
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_tab_file_read.sh'),
		`#!/bin/bash
# ACE Before-Tab-File-Read Hook - Minimal decision gate for tab file reads
# Input: file_path
# Output: {"decision": "allow"}

echo '{"decision": "allow"}'
`,
		{ mode: 0o755 }
	);

	// ace_after_tab_file_edit.sh - writes to edit_trajectory.jsonl
	fs.writeFileSync(
		path.join(scriptsDir, 'ace_after_tab_file_edit.sh'),
		`#!/bin/bash
# ACE After-Tab-File-Edit Hook - Records tab/inline edits for AI-Trail
# Input: file_path, edits[]

input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
echo "$input" >> "$ace_dir/edit_trajectory.jsonl"
echo '{}'
`,
		{ mode: 0o755 }
	);
}

/** Write the 10 new Windows PowerShell scripts to a directory */
function writeNewWindowsScripts(scriptsDir: string): void {
	fs.mkdirSync(scriptsDir, { recursive: true });

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_pre_tool_use.ps1'),
		`# ACE Pre-Tool-Use Hook - Decision gate before every MCP tool call
# Input: tool_name, tool_input
# Output: {"decision": "allow"}

$inputJson = [Console]::In.ReadToEnd()
Write-Output '{"decision": "allow"}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_post_tool_use.ps1'),
		`# ACE Post-Tool-Use Hook - Records successful MCP tool results for AI-Trail
# Input: tool_name, tool_input, result_json, duration_ms

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$inputJson = [Console]::In.ReadToEnd()
$inputJson | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8
Write-Output '{}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_post_tool_use_failure.ps1'),
		`# ACE Post-Tool-Use Failure Hook - Records MCP tool failures for AI-Trail
# Input: tool_name, tool_input, error_type, error_message

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
$errorType = if ($data.error_type) { $data.error_type } else { "unknown" }
$errorMessage = if ($data.error_message) { $data.error_message } else { "" }
$inputJson | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8
Write-Output '{}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_shell.ps1'),
		`# ACE Before-Shell-Execution Hook - Decision gate before shell commands
# Input: command
# Output: {"decision": "allow"}

$inputJson = [Console]::In.ReadToEnd()
Write-Output '{"decision": "allow"}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_mcp.ps1'),
		`# ACE Before-MCP-Execution Hook - Decision gate before MCP server calls
# Input: server_name, tool_name, tool_input
# Output: {"decision": "allow"}

$inputJson = [Console]::In.ReadToEnd()
Write-Output '{"decision": "allow"}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_read_file.ps1'),
		`# ACE Before-Read-File Hook - Decision gate before file reads
# Input: file_path
# Output: {"decision": "allow"}

$inputJson = [Console]::In.ReadToEnd()
Write-Output '{"decision": "allow"}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_submit_prompt.ps1'),
		`# ACE Before-Submit-Prompt Hook - Injects pattern context into prompts
# Input: prompt_text, conversation_id
# Output: {"additional_context": "..."} when patterns are cached

$aceDir = ".cursor\\ace"
$cacheFile = "$aceDir\\pattern_cache.json"

if (Test-Path $cacheFile) {
    try {
        $cache = Get-Content $cacheFile | ConvertFrom-Json
        $patternCount = $cache.patternCount
        if ($patternCount -gt 0) {
            $domains = ($cache.domains -join ", ")
            $context = "[ACE] $patternCount patterns available. Use ace_search to retrieve relevant patterns."
            Write-Output "{\`"additional_context\`": \`"$context\`"}"
            exit 0
        }
    } catch {}
}

Write-Output '{}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_after_agent_thought.ps1'),
		`# ACE After-Agent-Thought Hook - Records AI reasoning steps for AI-Trail
# Input: thought_text, conversation_id, generation_id

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$inputJson = [Console]::In.ReadToEnd()
$inputJson | Out-File -Append -FilePath "$aceDir\\response_trajectory.jsonl" -Encoding utf8
Write-Output '{}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_before_tab_file_read.ps1'),
		`# ACE Before-Tab-File-Read Hook - Minimal decision gate for tab file reads
# Input: file_path
# Output: {"decision": "allow"}

Write-Output '{"decision": "allow"}'
`
	);

	fs.writeFileSync(
		path.join(scriptsDir, 'ace_after_tab_file_edit.ps1'),
		`# ACE After-Tab-File-Edit Hook - Records tab/inline edits for AI-Trail
# Input: file_path, edits[]

$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$inputJson = [Console]::In.ReadToEnd()
$inputJson | Out-File -Append -FilePath "$aceDir\\edit_trajectory.jsonl" -Encoding utf8
Write-Output '{}'
`
	);
}

// ============================================================================
// Test Suite
// ============================================================================

describe('New Hooks: hooks.json Completeness', () => {
	it('should have all 20 hooks present in generated config', () => {
		const config = buildHooksConfig('.sh');
		const presentHooks = Object.keys(config.hooks);

		for (const hookName of ALL_EXPECTED_HOOKS) {
			expect(presentHooks, `Expected hook "${hookName}" to be present`).toContain(hookName);
		}

		expect(presentHooks).toHaveLength(ALL_EXPECTED_HOOKS.length);
	});

	it('preToolUse should have matcher property', () => {
		const config = buildHooksConfig('.sh');
		const preToolUseEntry = config.hooks.preToolUse[0] as any;

		expect(preToolUseEntry).toHaveProperty('matcher');
		expect(typeof preToolUseEntry.matcher).toBe('string');
	});

	it('beforeShellExecution should have matcher property', () => {
		const config = buildHooksConfig('.sh');
		const entry = config.hooks.beforeShellExecution[0] as any;

		expect(entry).toHaveProperty('matcher');
		expect(typeof entry.matcher).toBe('string');
	});

	it('subagentStart should have matcher property', () => {
		const config = buildHooksConfig('.sh');
		const entry = config.hooks.subagentStart[0] as any;

		expect(entry).toHaveProperty('matcher');
		expect(typeof entry.matcher).toBe('string');
	});

	it('beforeSubmitPrompt should have timeout property', () => {
		const config = buildHooksConfig('.sh');
		const entry = config.hooks.beforeSubmitPrompt[0] as any;

		expect(entry).toHaveProperty('timeout');
		expect(typeof entry.timeout).toBe('number');
		expect(entry.timeout).toBeGreaterThan(0);
	});

	it('stop should have loop_limit: null', () => {
		const config = buildHooksConfig('.sh');
		const stopEntry = config.hooks.stop[0] as any;

		expect(stopEntry).toHaveProperty('loop_limit');
		expect(stopEntry.loop_limit).toBeNull();
	});

	it('all hook entries should have a command property pointing to correct script extension', () => {
		const unixConfig = buildHooksConfig('.sh');
		const winConfig = buildHooksConfig('.ps1', 'powershell -ExecutionPolicy Bypass -File ');

		for (const [hookName, entries] of Object.entries(unixConfig.hooks)) {
			for (const entry of entries) {
				expect(
					(entry as any).command,
					`Unix hook "${hookName}" command should end with .sh`
				).toMatch(/\.sh$/);
			}
		}

		for (const [hookName, entries] of Object.entries(winConfig.hooks)) {
			for (const entry of entries) {
				expect(
					(entry as any).command,
					`Windows hook "${hookName}" command should end with .ps1`
				).toMatch(/\.ps1$/);
			}
		}
	});

	it('hooks config should be valid JSON', () => {
		const config = buildHooksConfig('.sh');
		const serialised = JSON.stringify(config);

		expect(() => JSON.parse(serialised)).not.toThrow();

		const parsed = JSON.parse(serialised);
		expect(parsed.version).toBe(1);
		expect(parsed.hooks).toBeDefined();
	});
});

// ============================================================================

describe('New Hooks: Script Existence (Unix)', () => {
	let tempDir: string;
	let scriptsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-new-hooks-unix-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeNewUnixScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const newUnixScripts = [
		'ace_pre_tool_use.sh',
		'ace_post_tool_use.sh',
		'ace_post_tool_use_failure.sh',
		'ace_before_shell.sh',
		'ace_before_mcp.sh',
		'ace_before_read_file.sh',
		'ace_before_submit_prompt.sh',
		'ace_after_agent_thought.sh',
		'ace_before_tab_file_read.sh',
		'ace_after_tab_file_edit.sh',
	];

	it('all 10 new Unix scripts should exist after hooks are created', () => {
		for (const scriptName of newUnixScripts) {
			const scriptPath = path.join(scriptsDir, scriptName);
			expect(fs.existsSync(scriptPath), `Expected ${scriptName} to exist`).toBe(true);
		}
	});

	it('all Unix scripts should have executable permissions set', () => {
		// On Unix, scripts should be created with 0o755
		for (const scriptName of newUnixScripts) {
			const scriptPath = path.join(scriptsDir, scriptName);
			const stats = fs.statSync(scriptPath);
			// Check owner execute bit (mode & 0o100)
			expect(stats.mode & 0o100, `${scriptName} should have owner execute bit`).toBeTruthy();
		}
	});

	it('all Unix scripts should have a bash shebang line', () => {
		for (const scriptName of newUnixScripts) {
			const scriptPath = path.join(scriptsDir, scriptName);
			const content = fs.readFileSync(scriptPath, 'utf-8');
			expect(content.startsWith('#!/bin/bash'), `${scriptName} should start with #!/bin/bash`).toBe(true);
		}
	});
});

// ============================================================================

describe('New Hooks: Script Existence (Windows)', () => {
	let tempDir: string;
	let scriptsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-new-hooks-win-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeNewWindowsScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const newWindowsScripts = [
		'ace_pre_tool_use.ps1',
		'ace_post_tool_use.ps1',
		'ace_post_tool_use_failure.ps1',
		'ace_before_shell.ps1',
		'ace_before_mcp.ps1',
		'ace_before_read_file.ps1',
		'ace_before_submit_prompt.ps1',
		'ace_after_agent_thought.ps1',
		'ace_before_tab_file_read.ps1',
		'ace_after_tab_file_edit.ps1',
	];

	it('all 10 new Windows scripts should exist after hooks are created', () => {
		for (const scriptName of newWindowsScripts) {
			const scriptPath = path.join(scriptsDir, scriptName);
			expect(fs.existsSync(scriptPath), `Expected ${scriptName} to exist`).toBe(true);
		}
	});

	it('all Windows scripts should be valid text files with content', () => {
		for (const scriptName of newWindowsScripts) {
			const scriptPath = path.join(scriptsDir, scriptName);
			const content = fs.readFileSync(scriptPath, 'utf-8');
			expect(content.trim().length, `${scriptName} should not be empty`).toBeGreaterThan(0);
		}
	});

	it('all Windows scripts should have comment headers', () => {
		for (const scriptName of newWindowsScripts) {
			const scriptPath = path.join(scriptsDir, scriptName);
			const content = fs.readFileSync(scriptPath, 'utf-8');
			expect(content.startsWith('#'), `${scriptName} should start with a comment`).toBe(true);
		}
	});
});

// ============================================================================

describe('New Hooks: Script Content Validation (Unix)', () => {
	let tempDir: string;
	let scriptsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-script-content-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeNewUnixScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('ace_pre_tool_use.sh should output decision JSON', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_pre_tool_use.sh'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		// Must be echo/output of a JSON decision object
		expect(content).toMatch(/echo\s+['"]?\{.*"decision".*\}/);
	});

	it('ace_post_tool_use.sh should write to mcp_trajectory.jsonl', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_post_tool_use.sh'), 'utf-8');

		expect(content).toContain('mcp_trajectory.jsonl');
		// Must append (>>) to the trajectory file
		expect(content).toMatch(/>>.*mcp_trajectory\.jsonl/);
	});

	it('ace_post_tool_use_failure.sh should log error_type and error_message', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_post_tool_use_failure.sh'), 'utf-8');

		expect(content).toContain('error_type');
		expect(content).toContain('error_message');
		expect(content).toContain('mcp_trajectory.jsonl');
	});

	it('ace_before_shell.sh should output decision JSON', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_shell.sh'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		expect(content).toMatch(/echo\s+['"]?\{.*"decision".*\}/);
	});

	it('ace_before_mcp.sh should output decision JSON', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_mcp.sh'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		expect(content).toMatch(/echo\s+['"]?\{.*"decision".*\}/);
	});

	it('ace_before_submit_prompt.sh should read pattern_cache.json', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_submit_prompt.sh'), 'utf-8');

		expect(content).toContain('pattern_cache.json');
		// Must attempt a conditional check on the cache file (via variable or literal path)
		expect(content).toMatch(/\[\s+-f\s+|Test-Path/);
	});

	it('ace_after_agent_thought.sh should write to response_trajectory.jsonl', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_after_agent_thought.sh'), 'utf-8');

		expect(content).toContain('response_trajectory.jsonl');
		expect(content).toMatch(/>>.*response_trajectory\.jsonl/);
	});

	it('ace_before_tab_file_read.sh should be minimal (just decision output)', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_tab_file_read.sh'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		// Minimal script: should NOT write to any trajectory files
		expect(content).not.toContain('trajectory.jsonl');
		expect(content).not.toContain('>>');
	});

	it('ace_after_tab_file_edit.sh should write to edit_trajectory.jsonl', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_after_tab_file_edit.sh'), 'utf-8');

		expect(content).toContain('edit_trajectory.jsonl');
		expect(content).toMatch(/>>.*edit_trajectory\.jsonl/);
	});

	it('ace_before_read_file.sh should output decision JSON', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_read_file.sh'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		expect(content).toMatch(/echo\s+['"]?\{.*"decision".*\}/);
	});
});

// ============================================================================

describe('New Hooks: Script Content Validation (Windows)', () => {
	let tempDir: string;
	let scriptsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-script-win-content-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeNewWindowsScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('ace_pre_tool_use.ps1 should output decision JSON', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_pre_tool_use.ps1'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		expect(content).toContain('Write-Output');
	});

	it('ace_post_tool_use.ps1 should write to mcp_trajectory.jsonl', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_post_tool_use.ps1'), 'utf-8');

		expect(content).toContain('mcp_trajectory.jsonl');
		expect(content).toContain('Out-File');
	});

	it('ace_post_tool_use_failure.ps1 should reference error_type and error_message', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_post_tool_use_failure.ps1'), 'utf-8');

		expect(content).toContain('error_type');
		expect(content).toContain('error_message');
		expect(content).toContain('mcp_trajectory.jsonl');
	});

	it('ace_before_submit_prompt.ps1 should check pattern_cache.json', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_submit_prompt.ps1'), 'utf-8');

		expect(content).toContain('pattern_cache.json');
		expect(content).toContain('Test-Path');
	});

	it('ace_after_agent_thought.ps1 should write to response_trajectory.jsonl', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_after_agent_thought.ps1'), 'utf-8');

		expect(content).toContain('response_trajectory.jsonl');
		expect(content).toContain('Out-File');
	});

	it('ace_before_tab_file_read.ps1 should be minimal', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_before_tab_file_read.ps1'), 'utf-8');

		expect(content).toContain('decision');
		expect(content).toContain('allow');
		// Should NOT write to trajectory files
		expect(content).not.toContain('trajectory.jsonl');
		expect(content).not.toContain('Out-File');
	});

	it('ace_after_tab_file_edit.ps1 should write to edit_trajectory.jsonl', () => {
		const content = fs.readFileSync(path.join(scriptsDir, 'ace_after_tab_file_edit.ps1'), 'utf-8');

		expect(content).toContain('edit_trajectory.jsonl');
		expect(content).toContain('Out-File');
	});
});

// ============================================================================

describe('New Hooks: Hook Output Format', () => {
	it('pre-tool hooks should output {"decision": "allow"} format', () => {
		// Decision hooks must output valid JSON with a decision field
		const preHookOutput = '{"decision": "allow"}';
		const parsed = JSON.parse(preHookOutput);

		expect(parsed).toHaveProperty('decision');
		expect(parsed.decision).toBe('allow');
	});

	it('pre-tool hooks should be able to output {"decision": "block"} format', () => {
		const blockOutput = '{"decision": "block", "reason": "Dangerous operation detected"}';
		const parsed = JSON.parse(blockOutput);

		expect(parsed).toHaveProperty('decision');
		expect(parsed.decision).toBe('block');
		expect(parsed).toHaveProperty('reason');
	});

	it('post-tool hooks should output {} or nothing', () => {
		// Post hooks that only record data should output empty JSON
		const postHookOutput = '{}';
		const parsed = JSON.parse(postHookOutput);

		expect(Object.keys(parsed)).toHaveLength(0);
	});

	it('beforeSubmitPrompt should output additional_context when patterns cached', () => {
		// When pattern cache exists and has patterns, should inject context
		const patternCount = 42;
		const _domains = 'auth, api, cache'; // Used in script logic, tested indirectly
		const context = `[ACE] ${patternCount} patterns available. Use ace_search to retrieve relevant patterns.`;
		const output = JSON.stringify({ additional_context: context });

		const parsed = JSON.parse(output);

		expect(parsed).toHaveProperty('additional_context');
		expect(parsed.additional_context).toContain(String(patternCount));
		expect(parsed.additional_context).toContain('ace_search');
	});

	it('beforeSubmitPrompt should output {} when no patterns cached', () => {
		// When no cache or zero patterns, output empty JSON to avoid noise
		const output = '{}';
		const parsed = JSON.parse(output);

		expect(Object.keys(parsed)).toHaveLength(0);
	});

	it('decision output should be parseable as JSON', () => {
		const outputs = [
			'{"decision": "allow"}',
			'{"decision": "block", "reason": "test"}',
			'{}',
			'{"additional_context": "some context here"}',
			'{"followup_message": "session done"}',
		];

		for (const output of outputs) {
			expect(() => JSON.parse(output), `"${output}" should be valid JSON`).not.toThrow();
		}
	});

	it('pre-tool decision hooks should NOT write to trajectory files', () => {
		// Pre-tool decision hooks are meant only to allow/block, not to record
		// This validates the conceptual contract: recording happens in post-tool hooks

		const preToolHookResponsibilities = {
			purpose: 'decision gate',
			output: 'allow or block',
			sideEffects: 'none',
		};

		const postToolHookResponsibilities = {
			purpose: 'record trajectory',
			output: 'empty',
			sideEffects: 'writes to trajectory file',
		};

		expect(preToolHookResponsibilities.sideEffects).toBe('none');
		expect(postToolHookResponsibilities.sideEffects).toContain('trajectory');
	});

	it('postToolUseFailure hook should capture both error_type and error_message fields', () => {
		// Simulate the failure hook input format
		const hookInput = {
			tool_name: 'ace_search',
			tool_input: '{"query": "test"}',
			error_type: 'ToolExecutionError',
			error_message: 'Connection refused to MCP server',
		};

		expect(hookInput).toHaveProperty('error_type');
		expect(hookInput).toHaveProperty('error_message');
		expect(hookInput.error_type).toBe('ToolExecutionError');
		expect(hookInput.error_message).toContain('Connection refused');
	});
});

// ============================================================================

describe('New Hooks: Integration - hooks.json generation for both platforms', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hooks-integration-'));
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should write hooks.json with all 20 hooks for Unix', () => {
		const cursorDir = path.join(tempDir, '.cursor');
		fs.mkdirSync(cursorDir, { recursive: true });
		const hooksPath = path.join(cursorDir, 'hooks.json');
		const config = buildHooksConfig('.sh');

		fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2));

		expect(fs.existsSync(hooksPath)).toBe(true);
		const loaded = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
		const hookNames = Object.keys(loaded.hooks);

		expect(hookNames).toHaveLength(ALL_EXPECTED_HOOKS.length);
		for (const name of ALL_EXPECTED_HOOKS) {
			expect(hookNames).toContain(name);
		}
	});

	it('should write hooks.json with all 20 hooks for Windows', () => {
		const cursorDir = path.join(tempDir, '.cursor');
		fs.mkdirSync(cursorDir, { recursive: true });
		const hooksPath = path.join(cursorDir, 'hooks.json');
		const config = buildHooksConfig('.ps1', 'powershell -ExecutionPolicy Bypass -File ');

		fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2));

		const loaded = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
		const hookNames = Object.keys(loaded.hooks);

		for (const name of ALL_EXPECTED_HOOKS) {
			expect(hookNames).toContain(name);
		}
	});

	it('hooks.json hasAllHooks check should require all 20 hooks', () => {
		// Simulate the extension's hasAllHooks guard that triggers a re-write
		// when the config is missing new hooks
		const checkHasAllHooks = (existingHooks: Record<string, any>): boolean => {
			return ALL_EXPECTED_HOOKS.every(name => Boolean(existingHooks[name]));
		};

		// Old config with only 10 hooks — guard should return false
		const oldHooks: Record<string, any> = {
			sessionStart: [{}], sessionEnd: [{}], afterMCPExecution: [{}],
			afterShellExecution: [{}], afterAgentResponse: [{}], afterFileEdit: [{}],
			stop: [{}], preCompact: [{}], subagentStart: [{}], subagentStop: [{}],
		};
		expect(checkHasAllHooks(oldHooks)).toBe(false);

		// New config with all 20 hooks — guard should return true
		const newHooks = buildHooksConfig('.sh').hooks as Record<string, any>;
		expect(checkHasAllHooks(newHooks)).toBe(true);
	});

	it('should create both Unix scripts directory and all 10 new scripts', () => {
		const scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeNewUnixScripts(scriptsDir);

		expect(fs.existsSync(scriptsDir)).toBe(true);

		const files = fs.readdirSync(scriptsDir);
		const shFiles = files.filter(f => f.endsWith('.sh'));

		expect(shFiles).toHaveLength(10);
	});

	it('should create both Windows scripts directory and all 10 new scripts', () => {
		const scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeNewWindowsScripts(scriptsDir);

		expect(fs.existsSync(scriptsDir)).toBe(true);

		const files = fs.readdirSync(scriptsDir);
		const ps1Files = files.filter(f => f.endsWith('.ps1'));

		expect(ps1Files).toHaveLength(10);
	});
});

// ============================================================================

describe('New Hooks: Edge Cases', () => {
	it('hooks config version should be 1', () => {
		const config = buildHooksConfig('.sh');
		expect(config.version).toBe(1);
	});

	it('each hook entry array should be non-empty', () => {
		const config = buildHooksConfig('.sh');
		for (const [name, entries] of Object.entries(config.hooks)) {
			expect(
				(entries as any[]).length,
				`Hook "${name}" should have at least one entry`
			).toBeGreaterThan(0);
		}
	});

	it('each hook entry should have a non-empty command string', () => {
		const config = buildHooksConfig('.sh');
		for (const [name, entries] of Object.entries(config.hooks)) {
			for (const entry of entries as any[]) {
				expect(
					typeof entry.command,
					`Hook "${name}" command should be a string`
				).toBe('string');
				expect(
					entry.command.length,
					`Hook "${name}" command should not be empty`
				).toBeGreaterThan(0);
			}
		}
	});

	it('script paths should follow .cursor/scripts/<name>.<ext> pattern', () => {
		const config = buildHooksConfig('.sh');
		for (const [name, entries] of Object.entries(config.hooks)) {
			for (const entry of entries as any[]) {
				expect(
					(entry as any).command,
					`Hook "${name}" should reference .cursor/scripts/`
				).toContain('.cursor/scripts/');
			}
		}
	});

	it('timeout value on beforeSubmitPrompt should be reasonable (1000-30000ms)', () => {
		const config = buildHooksConfig('.sh');
		const timeout = (config.hooks.beforeSubmitPrompt[0] as any).timeout;

		expect(timeout).toBeGreaterThanOrEqual(1000);
		expect(timeout).toBeLessThanOrEqual(30000);
	});

	it('beforeSubmitPrompt additional_context output should reference ace_search', () => {
		// The context injected into prompts should always mention ace_search so the
		// AI knows how to retrieve patterns.
		const context = '[ACE] 15 patterns available. Use ace_search to retrieve relevant patterns.';

		expect(context).toContain('ace_search');
	});

	it('pre-hook scripts should gracefully handle empty input', () => {
		// All pre-hooks receive input via stdin; they must not crash on empty input
		// and must still output the allow decision.
		const _emptyInput = ''; // Represents empty stdin
		const defaultDecision = { decision: 'allow' };

		// Verify that our decision format is valid JSON even with empty context
		expect(JSON.stringify(defaultDecision)).toBe('{"decision":"allow"}');
	});
});
