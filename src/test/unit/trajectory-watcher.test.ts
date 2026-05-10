/**
 * v0.5.0-dev.18 — Tests for trajectoryLineToUiUpdate pure function.
 *
 * The watcher in extension.ts wires this function to mcp_trajectory.jsonl
 * file-system change events. We keep the function side-effect free so the
 * status-bar/output-channel mapping can be tested without a vscode runtime.
 */

import { describe, it, expect } from 'vitest';
import { trajectoryLineToUiUpdate } from '../../ace/trajectoryWatcher';

// Helper: build an MCP-wrapped result_json (outer.content[0].text = inner).
function wrapResult(inner: any, isError = false): string {
	return JSON.stringify({
		content: [{ type: 'text', text: JSON.stringify(inner) }],
		isError,
	});
}

describe('trajectoryLineToUiUpdate — before_mcp events', () => {
	it('before_mcp + ace_search → spinner status + starting log', () => {
		const line = JSON.stringify({ event: 'before_mcp', tool_name: 'ace_search' });
		const u = trajectoryLineToUiUpdate(line);
		expect(u).not.toBeNull();
		expect(u!.statusBarText).toBe('$(sync~spin) ACE: searching…');
		expect(u!.outputLine).toMatch(/ace_search → starting/);
		expect(u!.outputLine).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
	});

	it('before_mcp + ace_learn → spinner status + starting log', () => {
		const line = JSON.stringify({ event: 'before_mcp', tool_name: 'ace_learn' });
		const u = trajectoryLineToUiUpdate(line);
		expect(u).not.toBeNull();
		expect(u!.statusBarText).toBe('$(sync~spin) ACE: learning…');
		expect(u!.outputLine).toMatch(/ace_learn → starting/);
	});

	it('before_mcp + non-ace tool → null', () => {
		const line = JSON.stringify({ event: 'before_mcp', tool_name: 'filesystem/read' });
		expect(trajectoryLineToUiUpdate(line)).toBeNull();
	});
});

describe('trajectoryLineToUiUpdate — afterMCPExecution / result-bearing events', () => {
	it('ace_search result with count → "ACE: N patterns" + log line', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: wrapResult({ count: 5, original_count: 12, results: [] }),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u).not.toBeNull();
		expect(u!.statusBarText).toBe('$(check) ACE: 5 patterns');
		expect(u!.outputLine).toMatch(/ace_search → 5 patterns \(orig 12\)/);
	});

	it('ace_search result with results array (no count field) falls back to length', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: wrapResult({ results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u!.statusBarText).toBe('$(check) ACE: 3 patterns');
		expect(u!.outputLine).toMatch(/ace_search → 3 patterns/);
	});

	it('ace_search result with similar_patterns array (legacy)', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: wrapResult({ similar_patterns: [{ id: 'x' }] }),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u!.statusBarText).toBe('$(check) ACE: 1 pattern');
	});

	it('ace_search with zero patterns → "0 patterns"', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: wrapResult({ count: 0, results: [] }),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u!.statusBarText).toBe('$(check) ACE: 0 patterns');
	});

	it('ace_learn success result → "ACE: trace stored"', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_learn',
			result_json: wrapResult({ stored: true }),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u!.statusBarText).toBe('$(check) ACE: trace stored');
		expect(u!.outputLine).toMatch(/ace_learn → stored/);
	});

	it('ace_search isError:true → error icon + short message + ERROR log', () => {
		const errInner = 'Server returned 503: upstream unavailable';
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: JSON.stringify({
				content: [{ type: 'text', text: errInner }],
				isError: true,
			}),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u).not.toBeNull();
		expect(u!.statusBarText).toMatch(/^\$\(error\) ACE: /);
		expect(u!.statusBarText.length).toBeLessThanOrEqual(80);
		expect(u!.outputLine).toMatch(/ace_search → ERROR /);
	});

	it('ace_learn isError:true → error mapping with ace_learn label in log', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_learn',
			result_json: JSON.stringify({
				content: [{ type: 'text', text: 'token expired' }],
				isError: true,
			}),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u!.outputLine).toMatch(/ace_learn → ERROR token expired/);
	});

	it('non-ace tool with result_json → null (not relevant for UI)', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'filesystem/read',
			result_json: wrapResult({ count: 99 }),
		});
		expect(trajectoryLineToUiUpdate(line)).toBeNull();
	});

	it('result_json without event field still produces an update (Cursor sometimes omits event tag)', () => {
		const line = JSON.stringify({
			tool_name: 'ace_search',
			result_json: wrapResult({ count: 2, results: [] }),
		});
		const u = trajectoryLineToUiUpdate(line);
		expect(u).not.toBeNull();
		expect(u!.statusBarText).toBe('$(check) ACE: 2 patterns');
	});
});

describe('trajectoryLineToUiUpdate — defensive parsing', () => {
	it('returns null for empty string', () => {
		expect(trajectoryLineToUiUpdate('')).toBeNull();
	});

	it('returns null for malformed JSON', () => {
		expect(trajectoryLineToUiUpdate('not-json')).toBeNull();
		expect(trajectoryLineToUiUpdate('{"unbalanced":')).toBeNull();
	});

	it('returns null for JSON that is not an object', () => {
		expect(trajectoryLineToUiUpdate('null')).toBeNull();
		expect(trajectoryLineToUiUpdate('"a string"')).toBeNull();
		expect(trajectoryLineToUiUpdate('42')).toBeNull();
	});

	it('returns null when tool_name is missing entirely', () => {
		expect(trajectoryLineToUiUpdate(JSON.stringify({ event: 'before_mcp' }))).toBeNull();
	});

	it('handles malformed inner result_json without throwing', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: JSON.stringify({
				content: [{ type: 'text', text: 'not json' }],
				isError: false,
			}),
		});
		// Should not throw — falls through with count=0.
		const u = trajectoryLineToUiUpdate(line);
		expect(u).not.toBeNull();
		expect(u!.statusBarText).toBe('$(check) ACE: 0 patterns');
	});

	it('handles result_json that is not parseable as JSON without throwing', () => {
		const line = JSON.stringify({
			event: 'afterMCPExecution',
			tool_name: 'ace_search',
			result_json: '{{not-json',
		});
		expect(trajectoryLineToUiUpdate(line)).toBeNull();
	});

	it('returns null for irrelevant non-ace tools (e.g. Bash, Read, Edit)', () => {
		for (const tool of ['Bash', 'Read', 'Edit', 'Glob', 'CallMcpTool']) {
			const line = JSON.stringify({ event: 'before_mcp', tool_name: tool });
			expect(trajectoryLineToUiUpdate(line), `tool=${tool}`).toBeNull();
		}
	});
});
