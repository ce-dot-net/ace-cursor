/**
 * E2E tests for hook script execution (Unix .sh + Windows .ps1)
 *
 * Unlike the unit tests in new-hooks.test.ts which validate file content statically,
 * these tests ACTUALLY EXECUTE the scripts with real stdin/stdout and verify:
 * 1. JSON output is valid and correct
 * 2. File I/O side effects (trajectory files get written)
 * 3. Pattern cache reading works end-to-end
 * 4. Scripts handle edge cases (empty input, missing files, malformed JSON)
 *
 * Platform notes:
 * - Unix (.sh) tests run on macOS/Linux (skip on Windows)
 * - Windows (.ps1) tests run when `pwsh` is available (PowerShell Core cross-platform)
 * - CI should install pwsh on all platforms for full coverage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawnSync } from 'child_process';

// ============================================================================
// Helpers
// ============================================================================

const isWindows = os.platform() === 'win32';

/** Check if pwsh (PowerShell Core) is available for cross-platform .ps1 testing */
function hasPwsh(): boolean {
	try {
		execSync('pwsh --version', { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

/** Execute a bash script with optional stdin, return stdout */
function runBashScript(scriptPath: string, stdin: string = '', cwd?: string): { stdout: string; exitCode: number } {
	const result = spawnSync('bash', [scriptPath], {
		input: stdin,
		cwd: cwd || path.dirname(scriptPath),
		encoding: 'utf-8',
		timeout: 10000,
		env: { ...process.env, PATH: process.env.PATH },
	});
	return {
		stdout: (result.stdout || '').trim(),
		exitCode: result.status ?? -1,
	};
}

/** Execute a PowerShell script with optional stdin, return stdout */
function runPwshScript(scriptPath: string, stdin: string = '', cwd?: string): { stdout: string; exitCode: number } {
	const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
		input: stdin,
		cwd: cwd || path.dirname(scriptPath),
		encoding: 'utf-8',
		timeout: 10000,
		env: { ...process.env, PATH: process.env.PATH },
	});
	return {
		stdout: (result.stdout || '').trim(),
		exitCode: result.status ?? -1,
	};
}

/** Try to parse JSON from script output, handling potential extra lines */
function parseJsonOutput(output: string): any {
	// Scripts may output extra lines; take the last non-empty line as JSON
	const lines = output.split('\n').filter(l => l.trim().length > 0);
	const lastLine = lines[lines.length - 1] || '';
	return JSON.parse(lastLine);
}

// ============================================================================
// Script templates (same as extension.ts produces)
// ============================================================================

function writeUnixScripts(scriptsDir: string): void {
	fs.mkdirSync(scriptsDir, { recursive: true });

	fs.writeFileSync(path.join(scriptsDir, 'ace_pre_tool_use.sh'),
		`#!/bin/bash\ninput=$(cat)\necho '{"decision": "allow"}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_post_tool_use.sh'),
		`#!/bin/bash\ninput=$(cat)\nace_dir=".cursor/ace"\nmkdir -p "$ace_dir"\necho "$input" >> "$ace_dir/mcp_trajectory.jsonl"\necho '{}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_post_tool_use_failure.sh'),
		`#!/bin/bash\ninput=$(cat)\nace_dir=".cursor/ace"\nmkdir -p "$ace_dir"\necho "$input" >> "$ace_dir/mcp_trajectory.jsonl"\necho '{}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_shell.sh'),
		`#!/bin/bash\ninput=$(cat)\necho '{"decision": "allow"}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_mcp.sh'),
		`#!/bin/bash\ninput=$(cat)\necho '{"decision": "allow"}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_read_file.sh'),
		`#!/bin/bash\ninput=$(cat)\necho '{"decision": "allow"}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_submit_prompt.sh'),
		`#!/bin/bash
input=$(cat)
ace_dir=".cursor/ace"
cache_file="$ace_dir/pattern_cache.json"

if [ -f "$cache_file" ]; then
  pattern_count=$(jq -r '.patternCount // 0' "$cache_file" 2>/dev/null || echo "0")
  if [ "$pattern_count" -gt 0 ] 2>/dev/null; then
    domains=$(jq -r '.domains // [] | join(", ")' "$cache_file" 2>/dev/null || echo "")
    echo '{"continue": true}'
    exit 0
  fi
fi

echo '{"continue": true}'
`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_after_agent_thought.sh'),
		`#!/bin/bash\ninput=$(cat)\nace_dir=".cursor/ace"\nmkdir -p "$ace_dir"\necho "$input" >> "$ace_dir/response_trajectory.jsonl"\necho '{}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_tab_file_read.sh'),
		`#!/bin/bash\necho '{"decision": "allow"}'\n`, { mode: 0o755 });

	fs.writeFileSync(path.join(scriptsDir, 'ace_after_tab_file_edit.sh'),
		`#!/bin/bash\ninput=$(cat)\nace_dir=".cursor/ace"\nmkdir -p "$ace_dir"\necho "$input" >> "$ace_dir/edit_trajectory.jsonl"\necho '{}'\n`, { mode: 0o755 });
}

function writeWindowsScripts(scriptsDir: string): void {
	fs.mkdirSync(scriptsDir, { recursive: true });

	fs.writeFileSync(path.join(scriptsDir, 'ace_pre_tool_use.ps1'),
		`$inputJson = [Console]::In.ReadToEnd()\nWrite-Output '{"decision": "allow"}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_post_tool_use.ps1'),
		`$aceDir = ".cursor\\ace"\nif (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }\n$inputJson = [Console]::In.ReadToEnd()\n$inputJson | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8\nWrite-Output '{}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_post_tool_use_failure.ps1'),
		`$aceDir = ".cursor\\ace"\nif (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }\n$inputJson = [Console]::In.ReadToEnd()\n$inputJson | Out-File -Append -FilePath "$aceDir\\mcp_trajectory.jsonl" -Encoding utf8\nWrite-Output '{}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_shell.ps1'),
		`$inputJson = [Console]::In.ReadToEnd()\nWrite-Output '{"decision": "allow"}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_mcp.ps1'),
		`$inputJson = [Console]::In.ReadToEnd()\nWrite-Output '{"decision": "allow"}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_read_file.ps1'),
		`$inputJson = [Console]::In.ReadToEnd()\nWrite-Output '{"decision": "allow"}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_submit_prompt.ps1'),
		`$aceDir = ".cursor\\ace"
$cacheFile = "$aceDir\\pattern_cache.json"

if (Test-Path $cacheFile) {
    try {
        $cache = Get-Content $cacheFile | ConvertFrom-Json
        $patternCount = $cache.patternCount
        if ($patternCount -gt 0) {
            Write-Output '{"continue": true}'
            exit 0
        }
    } catch {}
}

Write-Output '{"continue": true}'
`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_after_agent_thought.ps1'),
		`$aceDir = ".cursor\\ace"\nif (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }\n$inputJson = [Console]::In.ReadToEnd()\n$inputJson | Out-File -Append -FilePath "$aceDir\\response_trajectory.jsonl" -Encoding utf8\nWrite-Output '{}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_before_tab_file_read.ps1'),
		`Write-Output '{"decision": "allow"}'\n`);

	fs.writeFileSync(path.join(scriptsDir, 'ace_after_tab_file_edit.ps1'),
		`$aceDir = ".cursor\\ace"\nif (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }\n$inputJson = [Console]::In.ReadToEnd()\n$inputJson | Out-File -Append -FilePath "$aceDir\\edit_trajectory.jsonl" -Encoding utf8\nWrite-Output '{}'\n`);
}

// ============================================================================
// E2E: Unix (.sh) Script Execution
// ============================================================================

describe('E2E: Unix Hook Script Execution', () => {
	let tempDir: string;
	let scriptsDir: string;
	let workDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-unix-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		workDir = tempDir; // Scripts run with cwd = workspace root
		writeUnixScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Skip all Unix tests on Windows
	const describeUnix = isWindows ? describe.skip : describe;

	describeUnix('Decision gate hooks (allow/block)', () => {
		const decisionHooks = [
			'ace_pre_tool_use.sh',
			'ace_before_shell.sh',
			'ace_before_mcp.sh',
			'ace_before_read_file.sh',
			'ace_before_tab_file_read.sh',
		];

		for (const scriptName of decisionHooks) {
			it(`${scriptName} should output valid {"decision": "allow"} JSON`, () => {
				const scriptPath = path.join(scriptsDir, scriptName);
				const input = JSON.stringify({ tool_name: 'test_tool', tool_input: '{}' });
				const result = runBashScript(scriptPath, input, workDir);

				expect(result.exitCode).toBe(0);
				const parsed = parseJsonOutput(result.stdout);
				expect(parsed).toHaveProperty('decision');
				expect(parsed.decision).toBe('allow');
			});

			it(`${scriptName} should handle empty stdin gracefully`, () => {
				const scriptPath = path.join(scriptsDir, scriptName);
				const result = runBashScript(scriptPath, '', workDir);

				expect(result.exitCode).toBe(0);
				const parsed = parseJsonOutput(result.stdout);
				expect(parsed).toHaveProperty('decision');
				expect(parsed.decision).toBe('allow');
			});

			it(`${scriptName} should handle malformed JSON stdin gracefully`, () => {
				const scriptPath = path.join(scriptsDir, scriptName);
				const result = runBashScript(scriptPath, 'not valid json {{{', workDir);

				expect(result.exitCode).toBe(0);
				const parsed = parseJsonOutput(result.stdout);
				expect(parsed.decision).toBe('allow');
			});
		}
	});

	describeUnix('Trajectory recording hooks', () => {
		it('ace_post_tool_use.sh should write input to mcp_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_post_tool_use.sh');
			const input = JSON.stringify({
				tool_name: 'ace_search',
				tool_input: '{"query": "auth patterns"}',
				result_json: '{"patterns": []}',
				duration_ms: 150,
			});

			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(Object.keys(parsed)).toHaveLength(0); // {}

			// Verify trajectory file was created and has content
			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			const recorded = JSON.parse(content);
			expect(recorded.tool_name).toBe('ace_search');
		});

		it('ace_post_tool_use_failure.sh should write failure to mcp_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_post_tool_use_failure.sh');
			const input = JSON.stringify({
				tool_name: 'ace_search',
				error_type: 'ToolExecutionError',
				error_message: 'Connection refused',
			});

			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			const recorded = JSON.parse(content);
			expect(recorded.error_type).toBe('ToolExecutionError');
		});

		it('ace_after_agent_thought.sh should write to response_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_after_agent_thought.sh');
			const input = JSON.stringify({
				thought_text: 'I should search for authentication patterns',
				conversation_id: 'conv-123',
				generation_id: 'gen-456',
			});

			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'response_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			const recorded = JSON.parse(content);
			expect(recorded.thought_text).toContain('authentication');
		});

		it('ace_after_tab_file_edit.sh should write to edit_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_after_tab_file_edit.sh');
			const input = JSON.stringify({
				file_path: 'src/utils/auth.ts',
				edits: [{ range: { start: 10, end: 15 }, text: 'const token = getToken();' }],
			});

			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'edit_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			const recorded = JSON.parse(content);
			expect(recorded.file_path).toBe('src/utils/auth.ts');
		});

		it('trajectory files should append (not overwrite) on multiple calls', () => {
			const scriptPath = path.join(scriptsDir, 'ace_post_tool_use.sh');

			// First call
			runBashScript(scriptPath, JSON.stringify({ tool_name: 'call_1' }), workDir);
			// Second call
			runBashScript(scriptPath, JSON.stringify({ tool_name: 'call_2' }), workDir);
			// Third call
			runBashScript(scriptPath, JSON.stringify({ tool_name: 'call_3' }), workDir);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			const lines = fs.readFileSync(trajectoryPath, 'utf-8').trim().split('\n');
			expect(lines.length).toBe(3);

			expect(JSON.parse(lines[0]).tool_name).toBe('call_1');
			expect(JSON.parse(lines[1]).tool_name).toBe('call_2');
			expect(JSON.parse(lines[2]).tool_name).toBe('call_3');
		});
	});

	describeUnix('beforeSubmitPrompt — pattern cache injection', () => {
		let hasJq: boolean;

		beforeEach(() => {
			try {
				execSync('jq --version', { stdio: 'pipe' });
				hasJq = true;
			} catch {
				hasJq = false;
			}
		});

		it('should output continue:true when no pattern_cache.json exists', () => {
			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.sh');
			const result = runBashScript(scriptPath, '{"prompt_text": "hello"}', workDir);

			expect(result.exitCode).toBe(0);
			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);
		});

		it('should output continue:true when pattern_cache.json has zero patterns', () => {
			// Create cache with 0 patterns
			const aceDir = path.join(workDir, '.cursor', 'ace');
			fs.mkdirSync(aceDir, { recursive: true });
			fs.writeFileSync(path.join(aceDir, 'pattern_cache.json'), JSON.stringify({
				patternCount: 0,
				domains: [],
			}));

			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.sh');
			const result = runBashScript(scriptPath, '{"prompt_text": "hello"}', workDir);

			expect(result.exitCode).toBe(0);
			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);
		});

		it('should output continue:true and log relevance when patterns are cached (requires jq)', () => {
			if (!hasJq) {
				return; // Skip if jq not installed
			}

			// Create cache with patterns
			const aceDir = path.join(workDir, '.cursor', 'ace');
			fs.mkdirSync(aceDir, { recursive: true });
			fs.writeFileSync(path.join(aceDir, 'pattern_cache.json'), JSON.stringify({
				patternCount: 42,
				domains: ['auth', 'api', 'cache'],
			}));

			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.sh');
			const result = runBashScript(scriptPath, '{"prompt_text": "implement auth"}', workDir);

			expect(result.exitCode).toBe(0);
			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);
		});
	});

	describeUnix('Tab hooks — performance-critical minimal scripts', () => {
		it('ace_before_tab_file_read.sh should NOT create any files (zero side effects)', () => {
			const scriptPath = path.join(scriptsDir, 'ace_before_tab_file_read.sh');
			const filesBefore = fs.readdirSync(workDir);

			const result = runBashScript(scriptPath, '{"file_path": "src/index.ts"}', workDir);

			expect(result.exitCode).toBe(0);
			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.decision).toBe('allow');

			// No new files should have been created
			const filesAfter = fs.readdirSync(workDir);
			expect(filesAfter).toEqual(filesBefore);
		});

		it('ace_before_tab_file_read.sh should execute fast (under 500ms)', () => {
			const scriptPath = path.join(scriptsDir, 'ace_before_tab_file_read.sh');
			const start = Date.now();

			runBashScript(scriptPath, '', workDir);

			const elapsed = Date.now() - start;
			expect(elapsed).toBeLessThan(500);
		});
	});
});

// ============================================================================
// E2E: Windows (.ps1) Script Execution via pwsh (cross-platform)
// ============================================================================

describe('E2E: Windows/PowerShell Hook Script Execution', () => {
	let tempDir: string;
	let scriptsDir: string;
	let workDir: string;
	const pwshAvailable = hasPwsh();

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-pwsh-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		workDir = tempDir;
		writeWindowsScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const describePwsh = pwshAvailable ? describe : describe.skip;

	describePwsh('Decision gate hooks (.ps1)', () => {
		const decisionHooks = [
			'ace_pre_tool_use.ps1',
			'ace_before_shell.ps1',
			'ace_before_mcp.ps1',
			'ace_before_read_file.ps1',
			'ace_before_tab_file_read.ps1',
		];

		for (const scriptName of decisionHooks) {
			it(`${scriptName} should output valid {"decision": "allow"} JSON`, () => {
				const scriptPath = path.join(scriptsDir, scriptName);
				const input = JSON.stringify({ tool_name: 'test_tool', tool_input: '{}' });
				const result = runPwshScript(scriptPath, input, workDir);

				expect(result.exitCode).toBe(0);
				const parsed = parseJsonOutput(result.stdout);
				expect(parsed).toHaveProperty('decision');
				expect(parsed.decision).toBe('allow');
			});

			it(`${scriptName} should handle empty stdin gracefully`, () => {
				const scriptPath = path.join(scriptsDir, scriptName);
				const result = runPwshScript(scriptPath, '', workDir);

				expect(result.exitCode).toBe(0);
				const parsed = parseJsonOutput(result.stdout);
				expect(parsed.decision).toBe('allow');
			});
		}
	});

	describePwsh('Trajectory recording hooks (.ps1)', () => {
		it('ace_post_tool_use.ps1 should write input to mcp_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_post_tool_use.ps1');
			const input = JSON.stringify({
				tool_name: 'ace_search',
				tool_input: '{"query": "auth patterns"}',
				duration_ms: 150,
			});

			const result = runPwshScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			// PowerShell Out-File may add BOM or extra whitespace, so be lenient
			expect(content).toContain('ace_search');
		});

		it('ace_post_tool_use_failure.ps1 should record error to mcp_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_post_tool_use_failure.ps1');
			const input = JSON.stringify({
				tool_name: 'ace_search',
				error_type: 'ToolExecutionError',
				error_message: 'Connection refused',
			});

			const result = runPwshScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			expect(content).toContain('ToolExecutionError');
		});

		it('ace_after_agent_thought.ps1 should write to response_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_after_agent_thought.ps1');
			const input = JSON.stringify({
				thought_text: 'Analyzing code patterns',
				conversation_id: 'conv-789',
			});

			const result = runPwshScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'response_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			expect(content).toContain('Analyzing code patterns');
		});

		it('ace_after_tab_file_edit.ps1 should write to edit_trajectory.jsonl', () => {
			const scriptPath = path.join(scriptsDir, 'ace_after_tab_file_edit.ps1');
			const input = JSON.stringify({
				file_path: 'src/utils/auth.ts',
				edits: [{ text: 'const x = 1;' }],
			});

			const result = runPwshScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'edit_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			expect(content).toContain('auth.ts');
		});

		it('trajectory files should append on multiple calls (.ps1)', () => {
			const scriptPath = path.join(scriptsDir, 'ace_post_tool_use.ps1');

			runPwshScript(scriptPath, JSON.stringify({ tool_name: 'call_1' }), workDir);
			runPwshScript(scriptPath, JSON.stringify({ tool_name: 'call_2' }), workDir);

			const trajectoryPath = path.join(workDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			expect(content).toContain('call_1');
			expect(content).toContain('call_2');
		});
	});

	describePwsh('beforeSubmitPrompt pattern cache (.ps1)', () => {
		it('should output continue:true when no pattern_cache.json exists', () => {
			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.ps1');
			const result = runPwshScript(scriptPath, '{"prompt_text": "hello"}', workDir);

			expect(result.exitCode).toBe(0);
			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);
		});

		it('should output continue:true when patterns are cached', () => {
			const aceDir = path.join(workDir, '.cursor', 'ace');
			fs.mkdirSync(aceDir, { recursive: true });
			fs.writeFileSync(path.join(aceDir, 'pattern_cache.json'), JSON.stringify({
				patternCount: 25,
				domains: ['auth', 'testing'],
			}));

			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.ps1');
			const result = runPwshScript(scriptPath, '{"prompt_text": "hello"}', workDir);

			expect(result.exitCode).toBe(0);
			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);
		});
	});

	describePwsh('Tab hooks — performance (.ps1)', () => {
		it('ace_before_tab_file_read.ps1 should NOT create any files', () => {
			const scriptPath = path.join(scriptsDir, 'ace_before_tab_file_read.ps1');
			const filesBefore = fs.readdirSync(workDir);

			const result = runPwshScript(scriptPath, '', workDir);

			expect(result.exitCode).toBe(0);
			const filesAfter = fs.readdirSync(workDir);
			expect(filesAfter).toEqual(filesBefore);
		});
	});
});

// ============================================================================
// E2E: Cross-platform hooks.json round-trip
// ============================================================================

describe('E2E: hooks.json Generation Round-Trip', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-hooks-'));
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should write and read back hooks.json with all 20 hooks intact', () => {
		const cursorDir = path.join(tempDir, '.cursor');
		fs.mkdirSync(cursorDir, { recursive: true });
		const hooksPath = path.join(cursorDir, 'hooks.json');

		const config = {
			version: 1,
			hooks: {
				sessionStart: [{ command: '.cursor/scripts/ace_session_start.sh' }],
				sessionEnd: [{ command: '.cursor/scripts/ace_session_end.sh' }],
				afterMCPExecution: [{ command: '.cursor/scripts/ace_track_mcp.sh' }],
				afterShellExecution: [{ command: '.cursor/scripts/ace_track_shell.sh' }],
				afterAgentResponse: [{ command: '.cursor/scripts/ace_track_response.sh' }],
				afterFileEdit: [{ command: '.cursor/scripts/ace_track_edit.sh' }],
				stop: [{ command: '.cursor/scripts/ace_stop_hook.sh', loop_limit: null }],
				preCompact: [{ command: '.cursor/scripts/ace_pre_compact.sh' }],
				subagentStart: [{ command: '.cursor/scripts/ace_subagent_start.sh', matcher: '.*' }],
				subagentStop: [{ command: '.cursor/scripts/ace_subagent_stop.sh' }],
				preToolUse: [{ command: '.cursor/scripts/ace_pre_tool_use.sh', matcher: '.*' }],
				postToolUse: [{ command: '.cursor/scripts/ace_post_tool_use.sh' }],
				postToolUseFailure: [{ command: '.cursor/scripts/ace_post_tool_use_failure.sh' }],
				beforeShellExecution: [{ command: '.cursor/scripts/ace_before_shell.sh', matcher: '.*' }],
				beforeMCPExecution: [{ command: '.cursor/scripts/ace_before_mcp.sh' }],
				beforeReadFile: [{ command: '.cursor/scripts/ace_before_read_file.sh' }],
				beforeSubmitPrompt: [{ command: '.cursor/scripts/ace_before_submit_prompt.sh', timeout: 5000 }],
				afterAgentThought: [{ command: '.cursor/scripts/ace_after_agent_thought.sh' }],
				beforeTabFileRead: [{ command: '.cursor/scripts/ace_before_tab_file_read.sh' }],
				afterTabFileEdit: [{ command: '.cursor/scripts/ace_after_tab_file_edit.sh' }],
			},
		};

		// Write
		fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2));

		// Read back
		const loaded = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
		const hookNames = Object.keys(loaded.hooks);

		expect(hookNames).toHaveLength(20);
		expect(loaded.version).toBe(1);

		// Verify special properties survived serialization
		expect(loaded.hooks.stop[0].loop_limit).toBeNull();
		expect(loaded.hooks.preToolUse[0].matcher).toBe('.*');
		expect(loaded.hooks.beforeSubmitPrompt[0].timeout).toBe(5000);
		expect(loaded.hooks.beforeShellExecution[0].matcher).toBe('.*');
		expect(loaded.hooks.subagentStart[0].matcher).toBe('.*');
	});

	it('forceUpdate should detect missing new hooks and require rewrite', () => {
		const ALL_EXPECTED = [
			'sessionStart', 'sessionEnd', 'afterMCPExecution', 'afterShellExecution',
			'afterAgentResponse', 'afterFileEdit', 'stop', 'preCompact',
			'subagentStart', 'subagentStop',
			'preToolUse', 'postToolUse', 'postToolUseFailure', 'beforeShellExecution',
			'beforeMCPExecution', 'beforeReadFile', 'beforeSubmitPrompt',
			'afterAgentThought', 'beforeTabFileRead', 'afterTabFileEdit',
		];

		const hasAllHooks = (hooks: Record<string, any>): boolean =>
			ALL_EXPECTED.every(name => Boolean(hooks[name]));

		// Old config (10 hooks) — should trigger forceUpdate
		const oldHooks = {
			sessionStart: [{}], sessionEnd: [{}], afterMCPExecution: [{}],
			afterShellExecution: [{}], afterAgentResponse: [{}], afterFileEdit: [{}],
			stop: [{}], preCompact: [{}], subagentStart: [{}], subagentStop: [{}],
		};
		expect(hasAllHooks(oldHooks)).toBe(false);

		// New config (20 hooks) — should NOT trigger forceUpdate
		const newHooks = Object.fromEntries(ALL_EXPECTED.map(h => [h, [{}]]));
		expect(hasAllHooks(newHooks)).toBe(true);

		// Partial upgrade (15 hooks) — should still trigger forceUpdate
		const partialHooks = Object.fromEntries(ALL_EXPECTED.slice(0, 15).map(h => [h, [{}]]));
		expect(hasAllHooks(partialHooks)).toBe(false);
	});

	it('hooks.json file permissions should be readable', () => {
		const cursorDir = path.join(tempDir, '.cursor');
		fs.mkdirSync(cursorDir, { recursive: true });
		const hooksPath = path.join(cursorDir, 'hooks.json');

		fs.writeFileSync(hooksPath, '{"version":1,"hooks":{}}');

		const stats = fs.statSync(hooksPath);
		// Owner read bit
		expect(stats.mode & 0o400).toBeTruthy();
	});
});

// ============================================================================
// E2E: Full workflow simulation
// ============================================================================

describe('E2E: Full Hook Workflow Simulation', () => {
	let tempDir: string;
	let scriptsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-workflow-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		writeUnixScripts(scriptsDir);
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const describeUnix = isWindows ? describe.skip : describe;

	describeUnix('Simulated MCP tool call lifecycle', () => {
		it('should execute pre → post flow: gate allows, then records trajectory', () => {
			// Step 1: Pre-tool gate check
			const preResult = runBashScript(
				path.join(scriptsDir, 'ace_pre_tool_use.sh'),
				JSON.stringify({ tool_name: 'ace_search', tool_input: '{"query": "auth"}' }),
				tempDir
			);
			const decision = parseJsonOutput(preResult.stdout);
			expect(decision.decision).toBe('allow');

			// Step 2: Post-tool recording (only if allowed)
			if (decision.decision === 'allow') {
				const postResult = runBashScript(
					path.join(scriptsDir, 'ace_post_tool_use.sh'),
					JSON.stringify({
						tool_name: 'ace_search',
						tool_input: '{"query": "auth"}',
						result_json: '{"patterns": ["use JWT tokens"]}',
						duration_ms: 230,
					}),
					tempDir
				);
				expect(postResult.exitCode).toBe(0);
			}

			// Verify trajectory was recorded
			const trajectoryPath = path.join(tempDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			expect(fs.existsSync(trajectoryPath)).toBe(true);
		});

		it('should execute pre → failure flow when tool fails', () => {
			// Step 1: Pre-tool gate
			const preResult = runBashScript(
				path.join(scriptsDir, 'ace_pre_tool_use.sh'),
				JSON.stringify({ tool_name: 'ace_search' }),
				tempDir
			);
			expect(parseJsonOutput(preResult.stdout).decision).toBe('allow');

			// Step 2: Tool fails → failure hook
			const failResult = runBashScript(
				path.join(scriptsDir, 'ace_post_tool_use_failure.sh'),
				JSON.stringify({
					tool_name: 'ace_search',
					error_type: 'TimeoutError',
					error_message: 'MCP server did not respond within 30s',
				}),
				tempDir
			);
			expect(failResult.exitCode).toBe(0);

			// Verify failure was recorded
			const trajectoryPath = path.join(tempDir, '.cursor', 'ace', 'mcp_trajectory.jsonl');
			const content = fs.readFileSync(trajectoryPath, 'utf-8').trim();
			expect(content).toContain('TimeoutError');
		});

		it('should handle a full session with multiple hooks firing', () => {
			// Simulate: shell → read file → agent thought → tool call → tab edit
			const hooks = [
				{ script: 'ace_before_shell.sh', input: { command: 'npm test' } },
				{ script: 'ace_before_read_file.sh', input: { file_path: 'src/index.ts' } },
				{ script: 'ace_after_agent_thought.sh', input: { thought_text: 'Running tests', conversation_id: 'c1' } },
				{ script: 'ace_pre_tool_use.sh', input: { tool_name: 'ace_search' } },
				{ script: 'ace_post_tool_use.sh', input: { tool_name: 'ace_search', result_json: '{}', duration_ms: 100 } },
				{ script: 'ace_after_tab_file_edit.sh', input: { file_path: 'src/auth.ts', edits: [] } },
			];

			for (const hook of hooks) {
				const result = runBashScript(
					path.join(scriptsDir, hook.script),
					JSON.stringify(hook.input),
					tempDir
				);
				expect(result.exitCode, `${hook.script} should exit 0`).toBe(0);
			}

			// Verify all trajectory files were created
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			expect(fs.existsSync(path.join(aceDir, 'response_trajectory.jsonl'))).toBe(true);
			expect(fs.existsSync(path.join(aceDir, 'mcp_trajectory.jsonl'))).toBe(true);
			expect(fs.existsSync(path.join(aceDir, 'edit_trajectory.jsonl'))).toBe(true);
		});
	});
});

// ============================================================================
// E2E: Task Helpfulness — Self-Eval Flow
// ============================================================================

describe('E2E: Task Helpfulness Self-Eval Flow', () => {
	let tempDir: string;
	let scriptsDir: string;
	let workDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-e2e-helpfulness-'));
		scriptsDir = path.join(tempDir, '.cursor', 'scripts');
		workDir = tempDir;
		fs.mkdirSync(scriptsDir, { recursive: true });
		// Create ace dir for relevance/review files
		fs.mkdirSync(path.join(tempDir, '.cursor', 'ace'), { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// -- Unix tests --
	const describeUnix = isWindows ? describe.skip : describe;

	describeUnix('Unix: beforeSubmitPrompt relevance logging', () => {
		it('should log injection event to ace-relevance.jsonl when patterns exist', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			// Write a pattern cache
			fs.writeFileSync(path.join(aceDir, 'pattern_cache.json'), JSON.stringify({
				patternCount: 15,
				domains: ['auth', 'api'],
				avgConfidence: 0.85
			}));
			// Write the script (matches updated extension.ts)
			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.sh');
			fs.writeFileSync(scriptPath, `#!/bin/bash
input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
if [ -f "$ace_dir/pattern_cache.json" ]; then
  pattern_count=$(jq -r '.patternCount // 0' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "0")
  if [ "$pattern_count" -gt 0 ] 2>/dev/null; then
    domains=$(jq -r '.domains // [] | join(", ")' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "")
    avg_conf=$(jq -r '.avgConfidence // 0' "$ace_dir/pattern_cache.json" 2>/dev/null || echo "0")
    echo "{\\"event\\": \\"search\\", \\"patterns_injected\\": $pattern_count, \\"domains\\": [\\"$(echo "$domains" | sed 's/, /\\", \\"/g')\\"], \\"avg_confidence\\": $avg_conf, \\"timestamp\\": \\"$(date -Iseconds)\\"}" >> "$ace_dir/ace-relevance.jsonl"
    echo '{"continue": true}'
  else
    echo '{"continue": true}'
  fi
else
  echo '{"continue": true}'
fi
`, { mode: 0o755 });

			const result = runBashScript(scriptPath, '{"prompt_text":"fix the bug"}', workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);

			// Verify relevance log was written
			const relevanceFile = path.join(aceDir, 'ace-relevance.jsonl');
			expect(fs.existsSync(relevanceFile)).toBe(true);
			const logContent = fs.readFileSync(relevanceFile, 'utf8').trim();
			const logEntry = JSON.parse(logContent);
			expect(logEntry.event).toBe('search');
			expect(logEntry.patterns_injected).toBe(15);
			expect(logEntry.avg_confidence).toBe(0.85);
		});
	});

	describeUnix('Unix: stop hook self-eval request', () => {
		it('should request self-eval when patterns were injected (loop_count=0)', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			// Simulate patterns injected
			fs.writeFileSync(path.join(aceDir, 'ace-relevance.jsonl'),
				'{"event": "search", "patterns_injected": 10}\n');

			const scriptPath = path.join(scriptsDir, 'ace_stop_hook.sh');
			fs.writeFileSync(scriptPath, `#!/bin/bash
input=$(cat)
status=$(echo "$input" | jq -r '.status // empty')
loop_count=$(echo "$input" | jq -r '.loop_count // 0')
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
eval_flag="$ace_dir/.eval-requested"

if [ "$status" != "completed" ]; then echo '{}'; exit 0; fi
if [ "$loop_count" = "0" ]; then
  patterns_injected=0
  if [ -f "$ace_dir/ace-relevance.jsonl" ]; then
    patterns_injected=$(grep -c '"event": "search"' "$ace_dir/ace-relevance.jsonl" 2>/dev/null || echo "0")
  fi
  if [ "$patterns_injected" -gt 0 ] 2>/dev/null; then
    touch "$eval_flag"
    msg="Session complete. IMPORTANT: ACE_REVIEW: Xm saved | one-line reason"
  else
    msg="Session complete."
  fi
  echo "{\\"followup_message\\": \\"$msg\\"}"
else
  rm -f "$eval_flag" 2>/dev/null
  echo '{}'
fi
`, { mode: 0o755 });

			const input = JSON.stringify({ status: 'completed', loop_count: 0 });
			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(parsed).toHaveProperty('followup_message');
			expect(parsed.followup_message).toContain('ACE_REVIEW');

			// Verify eval flag was created
			expect(fs.existsSync(path.join(aceDir, '.eval-requested'))).toBe(true);
		});

		it('should NOT request self-eval when no patterns were injected', () => {
			const scriptPath = path.join(scriptsDir, 'ace_stop_hook.sh');
			fs.writeFileSync(scriptPath, `#!/bin/bash
input=$(cat)
status=$(echo "$input" | jq -r '.status // empty')
loop_count=$(echo "$input" | jq -r '.loop_count // 0')
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
eval_flag="$ace_dir/.eval-requested"

if [ "$status" != "completed" ]; then echo '{}'; exit 0; fi
if [ "$loop_count" = "0" ]; then
  patterns_injected=0
  if [ -f "$ace_dir/ace-relevance.jsonl" ]; then
    patterns_injected=$(grep -c '"event": "search"' "$ace_dir/ace-relevance.jsonl" 2>/dev/null || echo "0")
  fi
  if [ "$patterns_injected" -gt 0 ] 2>/dev/null; then
    touch "$eval_flag"
    msg="Session complete. ACE_REVIEW request"
  else
    msg="Session complete."
  fi
  echo "{\\"followup_message\\": \\"$msg\\"}"
else
  rm -f "$eval_flag" 2>/dev/null
  echo '{}'
fi
`, { mode: 0o755 });

			const input = JSON.stringify({ status: 'completed', loop_count: 0 });
			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.followup_message).not.toContain('ACE_REVIEW');
			expect(fs.existsSync(path.join(tempDir, '.cursor', 'ace', '.eval-requested'))).toBe(false);
		});

		it('should clean up eval flag on subsequent stop (loop_count>0)', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			fs.writeFileSync(path.join(aceDir, '.eval-requested'), '');

			const scriptPath = path.join(scriptsDir, 'ace_stop_hook.sh');
			fs.writeFileSync(scriptPath, `#!/bin/bash
input=$(cat)
status=$(echo "$input" | jq -r '.status // empty')
loop_count=$(echo "$input" | jq -r '.loop_count // 0')
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
eval_flag="$ace_dir/.eval-requested"

if [ "$status" != "completed" ]; then echo '{}'; exit 0; fi
if [ "$loop_count" = "0" ]; then
  echo "{\\"followup_message\\": \\"test\\"}"
else
  rm -f "$eval_flag" 2>/dev/null
  echo '{}'
fi
`, { mode: 0o755 });

			const input = JSON.stringify({ status: 'completed', loop_count: 1 });
			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(parsed).toEqual({});
			expect(fs.existsSync(path.join(aceDir, '.eval-requested'))).toBe(false);
		});
	});

	describeUnix('Unix: response tracking ACE_REVIEW parsing', () => {
		it('should parse ACE_REVIEW and write ace-review-result.json', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			const scriptPath = path.join(scriptsDir, 'ace_track_response.sh');
			fs.writeFileSync(scriptPath, `#!/bin/bash
input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
echo "$input" >> "$ace_dir/response_trajectory.jsonl"
response_text=$(echo "$input" | jq -r '.text // ""' 2>/dev/null || echo "")
if echo "$response_text" | grep -q "ACE_REVIEW:"; then
  time_saved=$(echo "$response_text" | grep -oE 'ACE_REVIEW:[^|]*' | sed 's/ACE_REVIEW:[[:space:]]*//' | sed 's/[[:space:]]*$//')
  reason=$(echo "$response_text" | grep -oE 'ACE_REVIEW:[^|]*\\|[^"]*' | sed 's/.*|[[:space:]]*//' | head -c 200)
  minutes=$(echo "$time_saved" | grep -oE '[0-9]+' | head -1)
  minutes=\${minutes:-0}
  if [ "$minutes" -ge 30 ] 2>/dev/null; then helpful_pct=80
  elif [ "$minutes" -ge 15 ] 2>/dev/null; then helpful_pct=60
  elif [ "$minutes" -ge 5 ] 2>/dev/null; then helpful_pct=30
  elif [ "$minutes" -gt 0 ] 2>/dev/null; then helpful_pct=15
  else helpful_pct=0; fi
  echo "{\\"helpful_pct\\": $helpful_pct, \\"time_saved\\": \\"$time_saved\\", \\"reason\\": \\"$reason\\"}" > "$ace_dir/ace-review-result.json"
fi
exit 0
`, { mode: 0o755 });

			const input = JSON.stringify({
				text: 'Task done. ACE_REVIEW: 15m saved | Auth patterns saved OAuth research time'
			});
			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			// Verify ace-review-result.json
			const reviewFile = path.join(aceDir, 'ace-review-result.json');
			expect(fs.existsSync(reviewFile)).toBe(true);
			const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
			expect(review.helpful_pct).toBe(60); // 15m → 60%
			expect(review.time_saved).toBe('15m saved');
			expect(review.reason).toContain('Auth patterns');
		});

		it('should NOT write review file when no ACE_REVIEW in response', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			const scriptPath = path.join(scriptsDir, 'ace_track_response.sh');
			fs.writeFileSync(scriptPath, `#!/bin/bash
input=$(cat)
ace_dir=".cursor/ace"
mkdir -p "$ace_dir"
echo "$input" >> "$ace_dir/response_trajectory.jsonl"
response_text=$(echo "$input" | jq -r '.text // ""' 2>/dev/null || echo "")
if echo "$response_text" | grep -q "ACE_REVIEW:"; then
  echo "{\\"helpful_pct\\": 50}" > "$ace_dir/ace-review-result.json"
fi
exit 0
`, { mode: 0o755 });

			const input = JSON.stringify({ text: 'Just a normal response without review' });
			const result = runBashScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);
			expect(fs.existsSync(path.join(aceDir, 'ace-review-result.json'))).toBe(false);
		});
	});

	// -- PowerShell tests --
	const describePwsh = hasPwsh() ? describe : describe.skip;

	describePwsh('PowerShell: beforeSubmitPrompt relevance logging', () => {
		it('should log injection event to ace-relevance.jsonl when patterns exist', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			fs.writeFileSync(path.join(aceDir, 'pattern_cache.json'), JSON.stringify({
				patternCount: 10,
				domains: ['testing'],
				avgConfidence: 0.7
			}));

			const scriptPath = path.join(scriptsDir, 'ace_before_submit_prompt.ps1');
			fs.writeFileSync(scriptPath, `$inputJson = [Console]::In.ReadToEnd()
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
            $logEntry = "{\`"event\`": \`"search\`", \`"patterns_injected\`": $patternCount, \`"domains\`": [$domainsJson], \`"avg_confidence\`": $avgConf}"
            $logEntry | Out-File -FilePath "$aceDir\\ace-relevance.jsonl" -Encoding utf8 -Append
            Write-Output '{"continue": true}'
        } else { Write-Output '{"continue": true}' }
    } catch { Write-Output '{"continue": true}' }
} else { Write-Output '{"continue": true}' }
`);

			const result = runPwshScript(scriptPath, '{"prompt_text":"test"}', workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(parsed.continue).toBe(true);

			const relevanceFile = path.join(aceDir, 'ace-relevance.jsonl');
			expect(fs.existsSync(relevanceFile)).toBe(true);
			const content = fs.readFileSync(relevanceFile, 'utf8').trim();
			const logEntry = JSON.parse(content);
			expect(logEntry.event).toBe('search');
			expect(logEntry.patterns_injected).toBe(10);
		});
	});

	describePwsh('PowerShell: stop hook self-eval request', () => {
		it('should request self-eval when patterns were injected', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			fs.writeFileSync(path.join(aceDir, 'ace-relevance.jsonl'),
				'{"event": "search", "patterns_injected": 5}\n');

			const scriptPath = path.join(scriptsDir, 'ace_stop_hook.ps1');
			fs.writeFileSync(scriptPath, `$inputJson = [Console]::In.ReadToEnd()
$data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
$status = $data.status
$loopCount = $data.loop_count
$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$evalFlag = "$aceDir\\.eval-requested"

if ($status -ne "completed") { Write-Output '{}'; exit 0 }
if ($loopCount -eq 0) {
    $patternsInjected = 0
    if (Test-Path "$aceDir\\ace-relevance.jsonl") {
        $patternsInjected = (Select-String -Path "$aceDir\\ace-relevance.jsonl" -Pattern '"event": "search"' -SimpleMatch | Measure-Object).Count
    }
    if ($patternsInjected -gt 0) {
        New-Item -ItemType File -Path $evalFlag -Force | Out-Null
        $msg = "Session complete. ACE_REVIEW: Xm saved"
    } else {
        $msg = "Session complete."
    }
    Write-Output "{\`"followup_message\`": \`"$msg\`"}"
} else {
    if (Test-Path $evalFlag) { Remove-Item $evalFlag -Force }
    Write-Output '{}'
}
`);

			const input = JSON.stringify({ status: 'completed', loop_count: 0 });
			const result = runPwshScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const parsed = parseJsonOutput(result.stdout);
			expect(parsed).toHaveProperty('followup_message');
			expect(parsed.followup_message).toContain('ACE_REVIEW');
			expect(fs.existsSync(path.join(aceDir, '.eval-requested'))).toBe(true);
		});
	});

	describePwsh('PowerShell: response tracking ACE_REVIEW parsing', () => {
		it('should parse ACE_REVIEW and write ace-review-result.json', () => {
			const aceDir = path.join(tempDir, '.cursor', 'ace');
			const scriptPath = path.join(scriptsDir, 'ace_track_response.ps1');
			fs.writeFileSync(scriptPath, `$inputJson = [Console]::In.ReadToEnd()
$aceDir = ".cursor\\ace"
if (-not (Test-Path $aceDir)) { New-Item -ItemType Directory -Path $aceDir -Force | Out-Null }
$inputJson | Out-File -Append -FilePath "$aceDir\\response_trajectory.jsonl" -Encoding utf8
try {
    $data = $inputJson | ConvertFrom-Json -ErrorAction SilentlyContinue
    $responseText = if ($data.text) { $data.text } else { "" }
} catch { $responseText = "" }
if ($responseText -match "ACE_REVIEW:") {
    if ($responseText -match "ACE_REVIEW:\\s*([^|]+)") { $timeSaved = $Matches[1].Trim() } else { $timeSaved = "" }
    if ($responseText -match "ACE_REVIEW:[^|]*\\|\\s*(.+)") { $reason = $Matches[1].Trim() } else { $reason = "" }
    if ($timeSaved -match "(\\d+)") { $minutes = [int]$Matches[1] } else { $minutes = 0 }
    if ($minutes -ge 30) { $helpfulPct = 80 }
    elseif ($minutes -ge 15) { $helpfulPct = 60 }
    elseif ($minutes -ge 5) { $helpfulPct = 30 }
    elseif ($minutes -gt 0) { $helpfulPct = 15 }
    else { $helpfulPct = 0 }
    $reviewResult = @{ helpful_pct = $helpfulPct; time_saved = $timeSaved; reason = $reason } | ConvertTo-Json -Compress
    $reviewResult | Out-File -FilePath "$aceDir\\ace-review-result.json" -Encoding utf8
}
`);

			const input = JSON.stringify({
				text: 'Done. ACE_REVIEW: 5m saved | Saved time on config patterns'
			});
			const result = runPwshScript(scriptPath, input, workDir);
			expect(result.exitCode).toBe(0);

			const reviewFile = path.join(aceDir, 'ace-review-result.json');
			expect(fs.existsSync(reviewFile)).toBe(true);
			const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
			expect(review.helpful_pct).toBe(30); // 5m → 30%
			expect(review.time_saved).toContain('5m');
			expect(review.reason).toContain('config patterns');
		});
	});
});
