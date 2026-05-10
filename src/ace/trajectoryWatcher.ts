/**
 * v0.5.0-dev.18 — UX visibility helper.
 *
 * Pure function that converts a single mcp_trajectory.jsonl line into an
 * AceUiUpdate (status bar text + output channel log line). Kept side-effect
 * free so it's testable in isolation; the watcher in extension.ts applies
 * the update + handles idle revert via setTimeout.
 *
 * Mapping rules (only ace_search / ace_learn events produce updates):
 *   before_mcp + ace_search                          → "ACE: searching…"
 *   before_mcp + ace_learn                           → "ACE: learning…"
 *   afterMCPExecution + ace_search + result_json     → "ACE: N patterns"
 *   afterMCPExecution + ace_learn + isError:false    → "ACE: trace stored"
 *   afterMCPExecution + isError:true                 → "ACE: <short err>"
 *   anything else                                    → null
 */

export type AceUiUpdate = {
	statusBarText: string;
	outputLine: string;
};

function ts(): string {
	const d = new Date();
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
}

/**
 * Parse a trajectory JSONL line and return an AceUiUpdate.
 * Returns null when the entry is malformed, irrelevant (non-ace tools), or
 * doesn't carry enough data to render a useful UI update.
 */
export function trajectoryLineToUiUpdate(line: string): AceUiUpdate | null {
	if (!line || typeof line !== 'string') { return null; }
	let entry: any;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	if (!entry || typeof entry !== 'object') { return null; }

	const tool = String(entry.tool_name || '').toLowerCase();
	const isAceSearch = tool === 'ace_search' || tool.endsWith('/ace_search');
	const isAceLearn = tool === 'ace_learn' || tool.endsWith('/ace_learn');
	if (!isAceSearch && !isAceLearn) { return null; }

	const event = String(entry.event || '');

	// before_mcp → spinner state, no result yet.
	if (event === 'before_mcp') {
		if (isAceSearch) {
			return {
				statusBarText: '$(sync~spin) ACE: searching…',
				outputLine: `[${ts()}] ace_search → starting`,
			};
		}
		if (isAceLearn) {
			return {
				statusBarText: '$(sync~spin) ACE: learning…',
				outputLine: `[${ts()}] ace_learn → starting`,
			};
		}
		return null;
	}

	// afterMCPExecution-shaped result. Cursor doesn't always set entry.event so
	// we fall back to "has result_json" + tool match — same shape, no event tag.
	const hasResult = entry.result_json !== undefined && entry.result_json !== null;
	if (!hasResult && event !== 'afterMCPExecution') { return null; }

	// Parse result_json (string or object).
	let outer: any = null;
	try {
		outer = typeof entry.result_json === 'string'
			? JSON.parse(entry.result_json)
			: entry.result_json;
	} catch {
		return null;
	}
	if (!outer || typeof outer !== 'object') { return null; }

	// Error path — surface short err message in status bar.
	if (outer.isError === true) {
		let errMsg = '';
		try {
			const c = Array.isArray(outer.content) ? outer.content[0] : null;
			if (c && typeof c.text === 'string') {
				errMsg = c.text;
			}
		} catch { /* swallow */ }
		errMsg = String(errMsg || 'unknown').replace(/\s+/g, ' ').slice(0, 60);
		const toolLabel = isAceSearch ? 'ace_search' : 'ace_learn';
		return {
			statusBarText: `$(error) ACE: ${errMsg}`,
			outputLine: `[${ts()}] ${toolLabel} → ERROR ${errMsg}`,
		};
	}

	if (isAceSearch) {
		// Extract count from MCP-wrapped inner JSON. Two layers:
		//   outer = { content:[{ text:'<inner-json>' }], isError:false }
		//   inner = { results:[…], original_count, count, … }
		let count = 0;
		let originalCount: number | undefined;
		try {
			const c = Array.isArray(outer.content) ? outer.content[0] : null;
			if (c && typeof c.text === 'string') {
				const inner = JSON.parse(c.text);
				if (inner && typeof inner === 'object') {
					if (typeof inner.count === 'number') { count = inner.count; }
					else if (Array.isArray(inner.results)) { count = inner.results.length; }
					else if (Array.isArray(inner.similar_patterns)) { count = inner.similar_patterns.length; }
					if (typeof inner.original_count === 'number') { originalCount = inner.original_count; }
				}
			}
		} catch { /* fall through with zero */ }
		const origPart = typeof originalCount === 'number' ? ` (orig ${originalCount})` : '';
		return {
			statusBarText: `$(check) ACE: ${count} pattern${count === 1 ? '' : 's'}`,
			outputLine: `[${ts()}] ace_search → ${count} patterns${origPart}`,
		};
	}

	// ace_learn success path.
	return {
		statusBarText: '$(check) ACE: trace stored',
		outputLine: `[${ts()}] ace_learn → stored`,
	};
}
