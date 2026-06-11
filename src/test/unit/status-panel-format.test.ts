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

import { formatCount, normalizeStats, renderQualityCards } from '../../webviews/statusPanel';

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
