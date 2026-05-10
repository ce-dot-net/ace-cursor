/**
 * v0.4.1 — Security + helper.js (in-process @ace-sdk/core) tests.
 *
 * Replaces v0.4.0 ace-cli subprocess approach. SDK team correction: the use
 * case (in-process control, MCP bypass, custom logic around search call) is
 * better served by helper.js + @ace-sdk/core directly. ace-cli dropped.
 *
 * Tests:
 *  1. Security: extension does not write workspace-controlled extension-path.txt.
 *  2. helper.js exists and is restored from hookScripts.ts.
 *  3. Bash hook spawns node with HELPER baked in at write time.
 *  4. PowerShell hook spawns node with $helper baked in.
 *  5. Cross-platform parity: bash + PowerShell behave the same on no-opt-in.
 *  6. Privacy: opt-in marker still gates injection.
 *  7. ace-cli is fully removed from package.json deps.
 *  8. Bash hardening preserved (jq char-truncation, sync timeout, flag-after-success).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	getMcpTrackScriptContent,
	getAcePatternsRuleContent,
	getDomainSearchRuleContent,
} from '../../ace/hookScripts';

/** Read the bash postToolUse hook script content out of extension.ts.
 *
 * Two `const postToolUseScript = ...` exist (PowerShell branch + bash branch);
 * we want the bash branch — it starts with `#!/bin/bash`.
 */
function readPostToolUseScriptFromExtension(): string {
	const src = fs.readFileSync(path.resolve(__dirname, '../../extension.ts'), 'utf-8');
	const m = src.match(/const postToolUseScript = `(#!\/bin\/bash[\s\S]*?)`;\s*\n\s*if \(forceUpdate \|\| !fs\.existsSync\(postToolUsePath\)\)/);
	if (!m) throw new Error('bash postToolUseScript block not found in extension.ts');
	// Unescape JS template literal escape sequences. Order matters:
	//  1. ${expr} interpolations → swap to runtime-equivalent placeholder
	//  2. \\ → \   3. \` → `   4. \$ → $
	let s = m[1].replace(/\$\{[^}]*\}/g, '__INTERP__');
	s = s.replace(/\\\\/g, '\\');
	s = s.replace(/\\`/g, '`');
	s = s.replace(/\\\$/g, '$');
	return s;
}

function readExtensionTs(): string {
	return fs.readFileSync(path.resolve(__dirname, '../../extension.ts'), 'utf-8');
}

/**
 * Read the PowerShell postToolUse hook script content out of extension.ts.
 * PS branch is the FIRST `const postToolUseScript = \`...\`` block (before bash).
 * It does NOT start with `#!/bin/bash`.
 */
function readPowerShellPostToolUseScriptFromExtension(): string {
	const src = fs.readFileSync(path.resolve(__dirname, '../../extension.ts'), 'utf-8');
	// Tolerate a `// comment` line between postToolUsePath and postToolUseScript.
	const m = src.match(/const postToolUsePath = path\.join\(scriptsDir, 'ace_post_tool_use\.ps1'\);[\s\S]*?const postToolUseScript = `([\s\S]*?)`;\s*\n\s*if \(forceUpdate \|\| !fs\.existsSync\(postToolUsePath\)\)/);
	if (!m) throw new Error('PowerShell postToolUseScript block not found in extension.ts');
	let s = m[1].replace(/\$\{[^}]*\}/g, '__INTERP__');
	s = s.replace(/\\\\/g, '\\');
	s = s.replace(/\\`/g, '`');
	s = s.replace(/\\\$/g, '$');
	return s;
}

// ============================================================================
// PHASE 1: SECURITY — no workspace-controlled require()
// ============================================================================

describe('v0.4.1 security: workspace-controlled extension-path.txt removed', () => {
	it('extension.ts does NOT call writeFileSync/writeFileAtomic with extension-path.txt', () => {
		const src = readExtensionTs();
		// Caveman: only writes forbidden. unlink for orphan cleanup is fine.
		const writeCalls = src.match(/(?:writeFileSync|writeFileAtomic)\s*\([^)]*extension-path\.txt[^)]*\)/g);
		expect(writeCalls, 'must not write extension-path.txt anymore').toBeNull();
	});

	it('hookScripts.ts source has no helper.js that READS extension-path.txt', () => {
		const src = fs.readFileSync(path.resolve(__dirname, '../../ace/hookScripts.ts'), 'utf-8');
		// Caveman: helper must not read workspace-controlled paths.
		const reads = src.match(/readFileSync\s*\([^)]*extension-path\.txt/g);
		expect(reads, 'helper script must not read workspace-controlled file').toBeNull();
	});

	it('postToolUse bash hook does NOT read .cursor/ace/extension-path.txt', () => {
		const script = readPostToolUseScriptFromExtension();
		expect(script).not.toMatch(/extension-path\.txt/);
	});

	it('postToolUse PowerShell hook does NOT read extension-path.txt', () => {
		const script = readPowerShellPostToolUseScriptFromExtension();
		expect(script).not.toMatch(/extension-path\.txt/);
	});
});

// ============================================================================
// PHASE 2: helper.js restored, ace-cli wrapper deleted
// ============================================================================

describe('v0.4.1 helper.js (in-process @ace-sdk/core) approach', () => {
	it('hookScripts.ts exports getSearchHelperContent (helper.js restored)', async () => {
		const mod = await import('../../ace/hookScripts');
		expect(typeof (mod as any).getSearchHelperContent).toBe('function');
	});

	it('hookScripts.ts does NOT export getAceSearchWrapperContent (wrapper dropped)', async () => {
		const mod = await import('../../ace/hookScripts');
		expect((mod as any).getAceSearchWrapperContent).toBeUndefined();
	});

	it('getSearchHelperContent imports from @ace-sdk/core', async () => {
		const mod = await import('../../ace/hookScripts');
		const helper = (mod as any).getSearchHelperContent() as string;
		// Caveman: helper must use SDK directly, not require ace-cli.
		expect(helper).toMatch(/@ace-sdk\/core/);
		expect(helper).not.toMatch(/@ace-sdk\/cli/);
	});

	it('getSearchHelperContent uses loadConfig + AceClient + searchPatterns', async () => {
		const mod = await import('../../ace/hookScripts');
		const helper = (mod as any).getSearchHelperContent() as string;
		expect(helper).toMatch(/loadConfig/);
		expect(helper).toMatch(/AceClient/);
		expect(helper).toMatch(/searchPatterns/);
	});

	it('getSearchHelperContent calls ensureValidToken pre-flight (per SDK contract)', async () => {
		const mod = await import('../../ace/hookScripts');
		const helper = (mod as any).getSearchHelperContent() as string;
		expect(helper).toMatch(/ensureValidToken/);
	});

	it('getSearchHelperContent maps errors to stable exit codes (2/3/4 or 5)', async () => {
		const mod = await import('../../ace/hookScripts');
		const helper = (mod as any).getSearchHelperContent() as string;
		// SDK contract — see plan target architecture.
		expect(helper).toMatch(/process\.exit\(2\)/);
		expect(helper).toMatch(/process\.exit\(3\)/);
		// Either 4 or 5 (or both) for unknown/other.
		expect(helper).toMatch(/process\.exit\([45]\)/);
	});

	it('getSearchHelperContent passes agent_type:"cursor" to searchPatterns', async () => {
		const mod = await import('../../ace/hookScripts');
		const helper = (mod as any).getSearchHelperContent() as string;
		expect(helper).toMatch(/agent_type[^"']*["']cursor["']/);
	});

	it('extension.ts writes ace_search_helper.js to extensionPath/scripts', () => {
		const src = readExtensionTs();
		// Caveman: helper lives at <extensionPath>/scripts — TRUSTED location.
		expect(src).toMatch(/getSearchHelperContent/);
		expect(src).toMatch(/ace_search_helper\.js/);
		// Helper path must be derived from extensionContext.extensionPath, not workspace.
		expect(src).toMatch(/extensionContext\.extensionPath[\s\S]{0,200}['"]ace_search_helper\.js['"]/);
		// And the helper must be written through writeFileAtomic with the SDK helper content.
		expect(src).toMatch(/writeFileAtomic\s*\([\s\S]{0,200}getSearchHelperContent/);
	});

	it('extension.ts no longer writes ace-search-wrapper.sh (cleanup-unlink ok)', () => {
		const src = readExtensionTs();
		// Wrapper write call must be gone. unlinkSync of orphan is permitted.
		const writeCalls = src.match(/(?:writeFileSync|writeFileAtomic)\s*\([^)]*ace-search-wrapper\.sh[^)]*\)/g);
		expect(writeCalls, 'must not write ace-search-wrapper.sh anymore').toBeNull();
		// Wrapper getter import must be removed.
		expect(src).not.toMatch(/getAceSearchWrapperContent/);
	});

	it('@ace-sdk/cli is REMOVED from package.json dependencies', () => {
		const pkgPath = path.resolve(__dirname, '../../../package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		expect(pkg.dependencies['@ace-sdk/cli']).toBeUndefined();
	});

	it('@ace-sdk/core remains a runtime dependency in package.json', () => {
		const pkgPath = path.resolve(__dirname, '../../../package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		expect(pkg.dependencies['@ace-sdk/core']).toBeDefined();
	});

	it('package.json version is at least 0.4.1 (v0.4.1+ contract)', () => {
		// Caveman: original test pinned to 0.4.1 exactly. We bump versions but keep
		// the contract — this version-floor guard prevents accidental downgrade.
		const pkgPath = path.resolve(__dirname, '../../../package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		// strip any `-dev.N` / `-rc.N` suffix for compare
		const base = String(pkg.version).split('-')[0];
		const [maj, min, patch] = base.split('.').map((n: string) => parseInt(n, 10));
		// >= 0.4.1
		const ok = maj > 0 || (maj === 0 && (min > 4 || (min === 4 && patch >= 1)));
		expect(ok, `package.json version ${pkg.version} must be >= 0.4.1`).toBe(true);
	});
});

// ============================================================================
// PHASE 2b: bash hook spawns node helper with TRUSTED baked HELPER path
// ============================================================================

describe('v0.4.1 postToolUse bash hook spawns node + helper.js (baked path)', () => {
	it('script spawns node + helper.js (NOT ace-cli wrapper)', () => {
		const script = readPostToolUseScriptFromExtension();
		expect(script).toMatch(/\bnode\b\s*["']?\$HELPER["']?/);
		// ace-cli wrapper must be gone.
		expect(script).not.toMatch(/ace-search-wrapper\.sh/);
		expect(script).not.toMatch(/--json\s+search/);
	});

	it('script has HELPER baked in at write time (extension.ts interpolates aceExtDir)', () => {
		// Read RAW source to verify the JS template literal interpolates HELPER from extensionPath.
		const src = readExtensionTs();
		// The extension.ts must define HELPER in the bash hook with extensionPath baked in.
		expect(src).toMatch(/HELPER=["'`]\$\{aceExtDir\}\/scripts\/ace_search_helper\.js/);
	});

	it('script reads similar_patterns from helper.js JSON output', () => {
		const script = readPostToolUseScriptFromExtension();
		// Helper outputs the SDK SearchResponseWithMetadata; bash parses similar_patterns array.
		expect(script).toMatch(/similar_patterns/);
	});

	it('script does NOT spawn ace-cli', () => {
		const script = readPostToolUseScriptFromExtension();
		expect(script).not.toMatch(/ace-cli/);
		expect(script).not.toMatch(/@ace-sdk\/cli/);
	});
});

// ============================================================================
// PHASE 2c: PowerShell hook parity
// ============================================================================

describe('v0.4.1 postToolUse PowerShell hook spawns node + helper.js', () => {
	it('PS hook contains $helper variable with extensionPath baked in', () => {
		const src = readExtensionTs();
		// Allow forward or back slashes — node accepts both.
		expect(src).toMatch(/\$helper\s*=\s*["'`]\$\{aceExtDir\}[\\/]scripts[\\/]ace_search_helper\.js/);
	});

	it('PS hook spawns node with $helper variable', () => {
		const ps = readPowerShellPostToolUseScriptFromExtension();
		// PS may use `& node $helper $prompt` (inline) OR
		// ProcessStartInfo with FileName="node" + ArgumentList.Add($helper).
		// Either way, both `node` and `$helper` must appear together near each other.
		const inline = /node\s+\$helper/.test(ps);
		const psi = /FileName\s*=\s*["']node["'][\s\S]{0,400}\$helper/.test(ps);
		expect(inline || psi, 'PS hook must spawn node with $helper').toBe(true);
	});

	it('PS hook respects share-raw-prompts opt-in (now via runtime-settings.json)', () => {
		const ps = readPowerShellPostToolUseScriptFromExtension();
		// v0.5.0-dev.4: legacy share-raw-prompts.optin marker file removed.
		// Replaced by runtime-settings.json with shareRawPromptsForRetrievalAnalysis bool.
		expect(ps).toMatch(/runtime-settings\.json|shareRawPromptsForRetrievalAnalysis/);
	});

	it('PS hook does NOT spawn ace-cli or wrapper', () => {
		const ps = readPowerShellPostToolUseScriptFromExtension();
		expect(ps).not.toMatch(/ace-cli/);
		expect(ps).not.toMatch(/ace-search-wrapper/);
	});
});

// ============================================================================
// PHASE 2d: cross-platform parity — bash + PS no-injection output
// ============================================================================

describe('v0.4.1 cross-platform parity: bash + PS no-opt-in behavior', () => {
	it('bash returns {} when no opt-in, PS does the same', () => {
		const bash = readPostToolUseScriptFromExtension();
		const ps = readPowerShellPostToolUseScriptFromExtension();

		// v0.5.0-dev.4: legacy marker replaced by runtime-settings.json.
		expect(ps).toMatch(/runtime-settings\.json|shareRawPromptsForRetrievalAnalysis/);
		// PS must emit literal '{}' on the no-opt-in branch.
		expect(ps).toMatch(/Write-Output\s+["']\{\}["']/);
		// Sanity: bash also has the no-opt-in echo branch.
		expect(bash).toMatch(/echo\s+["']\{\}["']/);
	});
});

// ============================================================================
// PHASE 3: auth-status.txt on auth-expiry path
// ============================================================================

describe('v0.4.1 auth expiry → auth-status.txt + warning context', () => {
	it('postToolUse hook writes auth-status.txt on token-expired path', () => {
		const script = readPostToolUseScriptFromExtension();
		// Must see auth-status.txt write somewhere on the auth-expiry branch.
		expect(script).toMatch(/auth-status\.txt/);
	});

	it('postToolUse hook surfaces an auth warning via additional_context on auth expiry', () => {
		const script = readPostToolUseScriptFromExtension();
		// User-facing message about session expiry / login.
		expect(script).toMatch(/expired|session|login|ace-login/i);
	});
});

// ============================================================================
// PHASE 4: privacy opt-in for raw prompts
// ============================================================================

describe('v0.4.1 privacy: pattern injection requires explicit opt-in', () => {
	it('package.json declares ace.shareRawPromptsForRetrievalAnalysis as a boolean toggle', () => {
		// Caveman: v0.4.1 test pinned default=false. v0.4.4+ flipped to default=true
		// (privacy-preserving on by default per user feedback). Just guard that the
		// field exists and is boolean — the default value is a separate UX decision.
		const pkgPath = path.resolve(__dirname, '../../../package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const props = pkg.contributes.configuration.properties;
		expect(props['ace.shareRawPromptsForRetrievalAnalysis']).toBeDefined();
		expect(props['ace.shareRawPromptsForRetrievalAnalysis'].type).toBe('boolean');
		expect(typeof props['ace.shareRawPromptsForRetrievalAnalysis'].default).toBe('boolean');
	});

	it('postToolUse hook respects an opt-in flag file when injecting patterns', () => {
		const script = readPostToolUseScriptFromExtension();
		// Hook bails out / no injection unless opt-in marker file exists. The
		// extension writes the marker when the user enables the setting.
		expect(script).toMatch(/share-raw-prompts|opt-in|share_raw_prompts/i);
	});
});

// ============================================================================
// PHASE 5: bash hardening — synchronous timeout, jq char-truncation, flag-after-success
// ============================================================================

describe('v0.4.1 bash hardening (preserved from v0.4.0)', () => {
	it('postToolUse uses jq char-based truncation for prompt (not byte head -c)', () => {
		const script = readPostToolUseScriptFromExtension();
		// We removed `head -c 500` for the prompt slice. char-based truncation via jq is OK.
		// Tolerate `head -c` only on the OUTPUT of jq (not on the raw prompt).
		// The prompt-extraction line should NOT use head -c.
		const promptExtractMatch = script.match(/prompt=\$\([\s\S]*?\)/);
		expect(promptExtractMatch).toBeTruthy();
		expect(promptExtractMatch![0]).not.toMatch(/head -c/);
	});

	it('postToolUse uses synchronous timeout (perl alarm or gtimeout fallback) when calling helper', () => {
		const script = readPostToolUseScriptFromExtension();
		// Either `perl -e 'alarm` style OR `gtimeout`/`timeout` style. NO background-watchdog `&` PID dance.
		expect(script).toMatch(/perl -e ['"]?alarm|\btimeout\b|\bgtimeout\b/);
	});

	it('postToolUse drops the unsafe `& kill $PID` watchdog pattern', () => {
		const script = readPostToolUseScriptFromExtension();
		// Old pattern wrote `( sleep 8 && kill -0 $PID 2>/dev/null && kill $PID 2>/dev/null ) &`.
		expect(script).not.toMatch(/sleep \d+ && kill -0 \$PID/);
	});

	it('postToolUse only writes the per-generation flag AFTER successful injection', () => {
		const script = readPostToolUseScriptFromExtension();
		const additionalCtxIdx = script.lastIndexOf('additional_context');
		expect(additionalCtxIdx, 'additional_context not found in script').toBeGreaterThan(0);
		// Walk all `touch $flag_file` sites; the LAST one must be AFTER additional_context.
		const re = /touch\s+["']?\$flag_file["']?/g;
		let lastTouchIdx = -1;
		let m: RegExpExecArray | null;
		while ((m = re.exec(script)) !== null) lastTouchIdx = m.index;
		expect(lastTouchIdx, 'no `touch $flag_file` found').toBeGreaterThan(0);
		expect(lastTouchIdx, 'flag must be touched AFTER the success additional_context').toBeGreaterThan(additionalCtxIdx);
	});
});

// ============================================================================
// Bash syntax + smoke tests for the new postToolUse hook script
// ============================================================================

describe('v0.4.1 postToolUse hook script — syntax + smoke', () => {
	const writeTmp = (content: string, ext = '.sh') => {
		const tmp = path.join(os.tmpdir(), `ace-pth-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
		fs.writeFileSync(tmp, content, { mode: 0o755 });
		return tmp;
	};

	it('bash -n parses the postToolUse script with no syntax errors', () => {
		const script = readPostToolUseScriptFromExtension();
		const tmp = writeTmp(script);
		try {
			execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it('emits {} (no injection) when share-raw-prompts opt-in marker is missing', () => {
		const script = readPostToolUseScriptFromExtension();
		const tmp = writeTmp(script);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-pth-cwd-'));
		try {
			const res = spawnSync('bash', [tmp], {
				input: JSON.stringify({
					tool_name: 'Read',
					tool_type: 'native',
					tool_input: '{}',
					tool_output: '',
					duration: 1,
					conversation_id: 'c1',
					generation_id: 'g1',
					transcript_path: '',
				}),
				encoding: 'utf-8',
				cwd,
				timeout: 5000,
			});
			const out = (res.stdout || '').trim();
			// Must be valid JSON. Without opt-in we expect bare {} — no injection.
			const parsed = JSON.parse(out);
			expect(parsed.additional_context).toBeUndefined();
		} finally {
			fs.unlinkSync(tmp);
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it('PowerShell postToolUse script parses (pwsh AST parser if available, else size-check)', () => {
		const ps = readPowerShellPostToolUseScriptFromExtension();
		const which = spawnSync('which', ['pwsh'], { encoding: 'utf-8' });
		if (which.status !== 0) {
			// Caveman: no pwsh on this Mac → at least confirm script is non-empty.
			expect(ps.length).toBeGreaterThan(50);
			return;
		}
		const tmp = writeTmp(ps, '.ps1');
		try {
			const r = spawnSync('pwsh', [
				'-NoProfile', '-NonInteractive', '-Command',
				`$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${tmp.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if($errors){ $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`
			], { stdio: 'pipe', encoding: 'utf-8' });
			if (r.status !== 0) {
				throw new Error(`pwsh AST parse errors: ${r.stderr}`);
			}
		} finally {
			fs.unlinkSync(tmp);
		}
	});
});

// ============================================================================
// Bonus: stale-test sanity (caveman-comment intent, see test plan §5.4)
// ============================================================================

describe('v0.4.1 rule getters still produce non-empty content (no regression)', () => {
	it('all three getters return non-empty markdown', () => {
		expect(getAcePatternsRuleContent().length).toBeGreaterThan(100);
		expect(getDomainSearchRuleContent().length).toBeGreaterThan(100);
		// v0.5.0-dev.4: continuous-search rule retired (Stop hook + domain-shift inject replace it).
	});

	it('ace_track_mcp.sh still writes search-done flag for ace_search', () => {
		const script = getMcpTrackScriptContent();
		expect(script).toContain('search-done');
	});
});
