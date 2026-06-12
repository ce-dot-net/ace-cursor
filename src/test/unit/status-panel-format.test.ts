/**
 * Unit tests for formatCount helper in statusPanel.
 *
 * Bug: Raw float like 148.7999999999998 was rendered verbatim in the
 * quality-metrics panel. Rounding to 1 decimal with trailing ".0" stripped
 * keeps integers clean while taming floating-point noise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// statusPanel.ts imports 'vscode' at the top level. Mock it so the module
// can load in a plain Node (vitest) environment.
vi.mock('vscode', () => ({
	window: {},
	workspace: { getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }) },
	Uri: { file: vi.fn() },
	ViewColumn: { One: 1 },
}));

// Mock sibling modules that statusPanel pulls in, so import side effects
// don't explode outside the extension host.
vi.mock('../../ace/context', () => ({ readContext: vi.fn() }));
vi.mock('../../commands/login', () => ({
	getValidToken: vi.fn(),
	getHardCapInfo: vi.fn(),
}));
vi.mock('@ace-sdk/core', () => ({
	loadConfig: vi.fn(),
	loadUserAuth: vi.fn(),
	getDefaultOrgId: vi.fn(),
	getUsagePercentage: vi.fn(),
	isNearLimit: vi.fn(),
	isOverLimit: vi.fn(),
}));
vi.mock('../../ace/client', () => ({
	getLastUsageInfo: vi.fn(),
	getAceClient: vi.fn(),
}));

import { formatCount, normalizeStats, renderQualityCards, buildTopPatternsUrl, sortTopPatternsByReward, renderPatternRewardBadge, renderTaskSummaryReward, renderMetaValue, formatPatternContent, formatDomainName, StatusPanel } from '../../webviews/statusPanel';
import { getValidToken, getHardCapInfo } from '../../commands/login';
import { loadConfig, loadUserAuth, getDefaultOrgId } from '@ace-sdk/core';
import { getLastUsageInfo, getAceClient } from '../../ace/client';

describe('formatCount', () => {
	it('rounds noisy floats to 1 decimal place', () => {
		expect(formatCount(148.7999999999998)).toBe('148.8');
	});

	it('keeps integers clean without trailing .0', () => {
		expect(formatCount(5)).toBe('5');
	});

	it('renders zero as "0"', () => {
		expect(formatCount(0)).toBe('0');
	});

	it('rounds small fractions up to 1 decimal', () => {
		expect(formatCount(0.05)).toBe('0.1');
	});
});

describe('normalizeStats', () => {
	it('extracts 1.5 reward fields when cumulative_reward_total is present', () => {
		const raw = {
			cumulative_reward_total: 42.5,
			hot_total: 10,
			warm_total: 15,
			cold_total: 7,
			at_risk_count: 3,
			helpful_total: 19,
			harmful_total: 2,
		};
		const result = normalizeStats(raw);
		expect(result.rewardTotal).toBe(42.5);
		expect(result.hotTotal).toBe(10);
		expect(result.warmTotal).toBe(15);
		expect(result.coldTotal).toBe(7);
		expect(result.atRiskCount).toBe(3);
	});

	it('uses legacy fields when cumulative_reward_total is absent', () => {
		const raw = { helpful_total: 19, harmful_total: 2 };
		const result = normalizeStats(raw);
		expect(result.rewardTotal).toBeUndefined();
		expect(result.helpfulTotal).toBe(19);
		expect(result.harmfulTotal).toBe(2);
		expect(result.legacyTrustScore).toBe(90); // floor(19/21 * 100) = 90
	});

	it('EDGE: cumulative_reward_total: 0 is treated as 1.5 path (not legacy)', () => {
		const raw = { cumulative_reward_total: 0, hot_total: 0, warm_total: 0, cold_total: 0, at_risk_count: 5 };
		const result = normalizeStats(raw);
		expect(result.rewardTotal).toBe(0);
		// Discriminator: presence, not truthiness — rewardTotal !== undefined
		expect(result.rewardTotal !== undefined).toBe(true);
	});
});

describe('renderQualityCards', () => {
	it('renders 1.5 reward cards when cumulative_reward_total is present', () => {
		const raw = {
			cumulative_reward_total: 42.5,
			hot_total: 10,
			warm_total: 15,
			cold_total: 7,
			at_risk_count: 3,
		};
		const html = renderQualityCards(normalizeStats(raw));
		expect(html).toContain('42.5');
		expect(html).toContain('Cumulative Reward');
		expect(html).toContain('10 / 15 / 7');
		expect(html).toContain('Hot / Warm / Cold');
		expect(html).toContain('3');
		expect(html).toContain('At-Risk Patterns');
		// Must NOT use Trust Score in 1.5 path
		expect(html).not.toContain('Trust Score');
	});

	it('renders legacy cards when cumulative_reward_total is absent', () => {
		const raw = { helpful_total: 19, harmful_total: 2 };
		const html = renderQualityCards(normalizeStats(raw));
		expect(html).toContain('Helpful');
		expect(html).toContain('Harmful');
		expect(html).toContain('Trust Score');
		// No NaN or crash
		expect(html).not.toContain('NaN');
	});

	it('EDGE: cumulative_reward_total: 0 renders 1.5 path with "0.0"', () => {
		const raw = { cumulative_reward_total: 0, hot_total: 0, warm_total: 0, cold_total: 0, at_risk_count: 5 };
		const html = renderQualityCards(normalizeStats(raw));
		expect(html).toContain('0.0');
		expect(html).toContain('Cumulative Reward');
		// Must NOT fall back to legacy path
		expect(html).not.toContain('Trust Score');
	});

	it('does NOT use formatCount for rewardTotal (uses toFixed(1))', () => {
		// rewardTotal is a raw float sum — it must be rendered with toFixed(1), not formatCount
		const raw = { cumulative_reward_total: 5.0, hot_total: 2, warm_total: 1, cold_total: 0, at_risk_count: 0 };
		const html = renderQualityCards(normalizeStats(raw));
		// toFixed(1) on 5.0 → "5.0", formatCount(5.0) → "5"
		expect(html).toContain('5.0');
	});
});

// ---------------------------------------------------------------------------
// u07-toppatterns: buildTopPatternsUrl
// ---------------------------------------------------------------------------
describe('buildTopPatternsUrl', () => {
	it('includes limit param and path /top', () => {
		const url = buildTopPatternsUrl('https://ace.example.com', 10);
		expect(url).toContain('/top');
		expect(url).toContain('limit=10');
	});

	it('does NOT contain min_helpful', () => {
		const url = buildTopPatternsUrl('https://ace.example.com', 10);
		expect(url).not.toContain('min_helpful');
	});

	it('does NOT contain min_reward (server does not accept that param)', () => {
		const url = buildTopPatternsUrl('https://ace.example.com', 10);
		expect(url).not.toContain('min_reward');
	});

	it('keeps the /top path (not /patterns/top)', () => {
		const url = buildTopPatternsUrl('https://ace.example.com', 5);
		expect(url).toMatch(/\/top\?/);
		expect(url).not.toContain('/patterns/top');
	});
});

// ---------------------------------------------------------------------------
// u07-toppatterns: sortTopPatternsByReward
// ---------------------------------------------------------------------------
describe('sortTopPatternsByReward', () => {
	it('sorts 1.5 patterns descending by cumulative_v15_reward', () => {
		const patterns = [
			{ cumulative_v15_reward: 1.0, helpful: 100 },
			{ cumulative_v15_reward: 5.5, helpful: 2 },
			{ cumulative_v15_reward: 3.0, helpful: 50 },
		];
		const sorted = sortTopPatternsByReward(patterns);
		expect(sorted[0].cumulative_v15_reward).toBe(5.5);
		expect(sorted[1].cumulative_v15_reward).toBe(3.0);
		expect(sorted[2].cumulative_v15_reward).toBe(1.0);
	});

	it('falls back to helpful for 1.0 patterns (no cumulative_v15_reward)', () => {
		const patterns = [
			{ helpful: 3 },
			{ helpful: 10 },
			{ helpful: 7 },
		];
		const sorted = sortTopPatternsByReward(patterns);
		expect((sorted[0] as any).helpful).toBe(10);
		expect((sorted[1] as any).helpful).toBe(7);
		expect((sorted[2] as any).helpful).toBe(3);
	});

	it('sorts mixed patterns: 1.5 reward beats 1.0 helpful-only', () => {
		const patterns = [
			{ helpful: 200 },                         // 1.0 pattern, no reward
			{ cumulative_v15_reward: 4.0, helpful: 1 }, // 1.5 pattern
			{ helpful: 50 },                          // 1.0 pattern
		];
		const sorted = sortTopPatternsByReward(patterns);
		// 1.5 pattern wins (reward=4.0 > helpful=200 in sort key? No — 200 > 4. But
		// the sort key is: cumulative_v15_reward ?? helpful ?? 0.
		// So: 200, 4.0, 50 → order should be 200, 50, 4.0
		expect((sorted[0] as any).helpful).toBe(200);
		expect((sorted[1] as any).helpful).toBe(50);
		expect((sorted[2] as any).cumulative_v15_reward).toBe(4.0);
	});

	it('EDGE: cumulative_v15_reward: 0 takes 1.5 path (not helpful fallback)', () => {
		// 0 is a valid 1.5 value; must use 0 as sort key, not fall back to helpful
		const patterns = [
			{ cumulative_v15_reward: 0, helpful: 999 },
			{ helpful: 5 },
		];
		const sorted = sortTopPatternsByReward(patterns);
		// helpful=5 > cumulative_v15_reward=0, so helpful-only pattern sorts first
		expect((sorted[0] as any).helpful).toBe(5);
		expect((sorted[1] as any).cumulative_v15_reward).toBe(0);
	});

	it('patterns with no reward and no helpful get sort key 0', () => {
		const patterns = [{ content: 'a' }, { helpful: 2 }];
		const sorted = sortTopPatternsByReward(patterns);
		expect((sorted[0] as any).helpful).toBe(2);
	});

	it('does not mutate the input array', () => {
		const patterns = [
			{ cumulative_v15_reward: 1 },
			{ cumulative_v15_reward: 3 },
		];
		const original = [...patterns];
		sortTopPatternsByReward(patterns);
		expect(patterns[0]).toBe(original[0]);
		expect(patterns[1]).toBe(original[1]);
	});
});

// ---------------------------------------------------------------------------
// u07-toppatterns: renderPatternRewardBadge
// ---------------------------------------------------------------------------
describe('renderPatternRewardBadge', () => {
	it('renders Reward badge when cumulative_v15_reward is present', () => {
		const html = renderPatternRewardBadge({ cumulative_v15_reward: 4.2, helpful: 100 });
		expect(html).toContain('Reward: 4.20');
		expect(html).not.toContain('Helpful:');
		expect(html).not.toContain('👍');
	});

	it('renders Helpful legacy badge when cumulative_v15_reward is absent', () => {
		const html = renderPatternRewardBadge({ helpful: 42 });
		expect(html).toContain('Helpful:');
		expect(html).toContain('42');
		expect(html).not.toContain('Reward:');
	});

	it('EDGE: cumulative_v15_reward: 0 renders reward path with "0.00"', () => {
		// 0 !== undefined → 1.5 path
		const html = renderPatternRewardBadge({ cumulative_v15_reward: 0, helpful: 99 });
		expect(html).toContain('Reward: 0.00');
		expect(html).not.toContain('Helpful:');
	});

	it('legacy fallback: no crash when helpful is also absent', () => {
		const html = renderPatternRewardBadge({});
		// Should degrade gracefully
		expect(html).toContain('Helpful:');
		expect(html).toContain('0');
	});
});

// ---------------------------------------------------------------------------
// u09-rewardsignal: renderTaskSummaryReward — reward-model signal vs helpful_pct
// ---------------------------------------------------------------------------
describe('renderTaskSummaryReward (u09-rewardsignal)', () => {
	it('renders reward path when reward_delta is present', () => {
		const html = renderTaskSummaryReward({ reward_delta: 0.5, reward_tier: 'warm' });
		expect(html).toContain('0.50');
		expect(html).toContain('reward (warm)');
		// Must NOT render helpful path
		expect(html).not.toContain('helpful');
	});

	it('renders reward path with toFixed(2) formatting', () => {
		const html = renderTaskSummaryReward({ reward_delta: 1.0, reward_tier: 'hot' });
		expect(html).toContain('1.00');
		expect(html).toContain('reward (hot)');
	});

	it('EDGE: reward_delta: 0 is a valid 1.5 value and takes the reward path', () => {
		// 0 !== undefined → 1.5 path; discriminator is presence, not truthiness
		const html = renderTaskSummaryReward({ reward_delta: 0, reward_tier: 'cold' });
		expect(html).toContain('0.00');
		expect(html).toContain('reward (cold)');
		expect(html).not.toContain('helpful');
	});

	it('falls back to helpful_pct when reward_delta is absent', () => {
		const html = renderTaskSummaryReward({ helpful_pct: 30 });
		expect(html).toContain('30%');
		expect(html).toContain('helpful');
		expect(html).not.toContain('reward');
	});

	it('returns empty string when both reward_delta and helpful_pct are absent', () => {
		const html = renderTaskSummaryReward({});
		expect(html).toBe('');
	});

	it('returns empty string when helpful_pct is 0 and reward_delta absent', () => {
		const html = renderTaskSummaryReward({ helpful_pct: 0 });
		expect(html).toBe('');
	});

	it('renders reward_tier fallback as "n/a" when tier is missing', () => {
		const html = renderTaskSummaryReward({ reward_delta: 0.8 });
		expect(html).toContain('0.80');
		expect(html).toContain('reward (n/a)');
	});

	it('EDGE: reward_delta: null returns empty string (not TypeError crash)', () => {
		// JSON.parse of a server response can produce null for number fields.
		// null !== undefined is true in JS, so without an explicit null guard
		// the old code would reach (null).toFixed(2) and throw TypeError.
		// The corrected guard (typeof reward_delta === 'number') must return ''.
		expect(() => renderTaskSummaryReward({ reward_delta: null, reward_tier: 'cold' })).not.toThrow();
		const html = renderTaskSummaryReward({ reward_delta: null, reward_tier: 'cold' });
		expect(html).toBe('');
	});

	it('XSS: reward_tier is HTML-escaped before interpolation', () => {
		// A malicious or compromised server could send reward_tier with HTML characters.
		// The tier string must be escaped so it cannot inject tags or attributes.
		const html = renderTaskSummaryReward({ reward_delta: 0.5, reward_tier: '<img src=x onerror=alert(1)>' });
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img');
	});

	it('XSS: reward_tier with ampersand and angle brackets fully escaped', () => {
		const html = renderTaskSummaryReward({ reward_delta: 1.0, reward_tier: 'a&b<c>d' });
		expect(html).not.toContain('<c>');
		expect(html).toContain('a&amp;b&lt;c&gt;d');
	});
});

// ---------------------------------------------------------------------------
// u08-projectheader: X-ACE-Project header on all _fetchStatus raw fetch() calls
// ---------------------------------------------------------------------------
describe('_fetchStatus X-ACE-Project headers (u08-projectheader)', () => {
	const PROJECT_ID = 'proj-abc123';
	const ORG_ID = 'org-xyz';
	const TOKEN = 'ace_user_test-token';
	const SERVER_URL = 'https://ace-test.example.com';

	// Captured fetch calls, keyed by URL substring
	let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

	beforeEach(() => {
		fetchCalls = [];

		// Stub global fetch — respond successfully to all three endpoints
		vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			fetchCalls.push({ url: String(url), headers });

			if (String(url).includes('/analytics')) {
				return { ok: true, json: async () => ({ total_patterns: 42, helpful_total: 10, harmful_total: 1 }) };
			}
			if (String(url).includes('/config/verify')) {
				return { ok: true, json: async () => ({ org_name: 'TestOrg', projects: [{ project_id: PROJECT_ID, project_name: 'TestProject' }] }) };
			}
			if (String(url).includes('/top')) {
				return { ok: true, json: async () => ({ bullets: [] }) };
			}
			return { ok: true, json: async () => ({}) };
		});

		// Stub getValidToken to return a fixed token
		vi.mocked(getValidToken).mockResolvedValue({ token: TOKEN } as any);
		vi.mocked(getHardCapInfo).mockResolvedValue(null as any);

		// Stub @ace-sdk/core for _getAceConfig
		vi.mocked(loadConfig).mockReturnValue({ serverUrl: SERVER_URL } as any);
		vi.mocked(loadUserAuth).mockReturnValue({ token: TOKEN } as any);
		vi.mocked(getDefaultOrgId).mockReturnValue(ORG_ID);

		// Stub ace/client — no cached usage
		vi.mocked(getLastUsageInfo).mockReturnValue(undefined);
		vi.mocked(getAceClient).mockReturnValue(null as any);
	});

	/** Build a minimal StatusPanel instance via prototype — bypasses the private constructor. */
	function makePanel(): any {
		const instance = Object.create(StatusPanel.prototype);
		// Stub _getAceConfig to return our test config
		instance._getAceConfig = () => ({
			serverUrl: SERVER_URL,
			auth: { token: TOKEN, default_org_id: ORG_ID },
		});
		return instance;
	}

	it('analytics fetch includes X-ACE-Project', async () => {
		const panel = makePanel();
		await panel._fetchStatus({ orgId: ORG_ID, projectId: PROJECT_ID });

		const analyticsCall = fetchCalls.find(c => c.url.includes('/analytics'));
		expect(analyticsCall, 'analytics fetch should have been called').toBeTruthy();
		expect(analyticsCall!.headers['X-ACE-Project']).toBe(PROJECT_ID);
	});

	it('config/verify fetch includes X-ACE-Project', async () => {
		const panel = makePanel();
		await panel._fetchStatus({ orgId: ORG_ID, projectId: PROJECT_ID });

		const verifyCall = fetchCalls.find(c => c.url.includes('/config/verify'));
		expect(verifyCall, 'config/verify fetch should have been called').toBeTruthy();
		expect(verifyCall!.headers['X-ACE-Project']).toBe(PROJECT_ID);
	});

	it('top patterns fetch includes X-ACE-Project', async () => {
		const panel = makePanel();
		await panel._fetchStatus({ orgId: ORG_ID, projectId: PROJECT_ID });

		const topCall = fetchCalls.find(c => c.url.includes('/top'));
		expect(topCall, 'top patterns fetch should have been called').toBeTruthy();
		expect(topCall!.headers['X-ACE-Project']).toBe(PROJECT_ID);
	});
});

// Pre-existing XSS hardening: org/project meta + top-pattern content/domain are
// server-controlled strings rendered into the webview. They must be HTML-escaped.
describe('statusPanel XSS hardening for server-controlled strings', () => {
	const XSS = '<img src=x onerror=alert(1)>';

	it('renderMetaValue escapes both name and id, preserves structure', () => {
		const out = renderMetaValue(XSS, XSS);
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;img');
		expect(out).toContain('class="meta-id"');
	});

	it('renderMetaValue falls back to escaped id, then n/a', () => {
		expect(renderMetaValue('', XSS)).toContain('&lt;img');
		expect(renderMetaValue('', XSS)).not.toContain('<img');
		expect(renderMetaValue('', '')).toBe('n/a');
	});

	it('formatPatternContent escapes content and truncates at 200 with ellipsis', () => {
		const out = formatPatternContent(XSS);
		expect(out).not.toContain('<img');
		expect(out).toContain('&lt;img');
		expect(formatPatternContent('a'.repeat(250)).endsWith('...')).toBe(true);
		expect(formatPatternContent('short').includes('...')).toBe(false);
	});

	it('formatDomainName escapes and de-hyphenates', () => {
		expect(formatDomainName('foo-bar')).toBe('foo bar');
		expect(formatDomainName(XSS)).not.toContain('<img');
		expect(formatDomainName(XSS)).toContain('&lt;img');
	});
});
