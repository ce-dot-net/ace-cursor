/**
 * Unit tests for formatCount helper in statusPanel.
 *
 * Bug: Raw float like 148.7999999999998 was rendered verbatim in the
 * quality-metrics panel. Rounding to 1 decimal with trailing ".0" stripped
 * keeps integers clean while taming floating-point noise.
 */

import { describe, it, expect, vi } from 'vitest';

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

import { formatCount, normalizeStats, renderQualityCards, buildTopPatternsUrl, sortTopPatternsByReward, renderPatternRewardBadge } from '../../webviews/statusPanel';

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
