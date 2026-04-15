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

import { formatCount } from '../../webviews/statusPanel';

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
