/**
 * Source-level test: verify that all three rule writes in extension.ts
 * are guarded by `forceUpdate || !fs.existsSync(...)` so user customizations
 * are not clobbered on every extension activation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTENSION_TS = resolve(__dirname, '../../extension.ts');

describe('rule writes guard', () => {
	it('ace-patterns rule write is guarded by forceUpdate || !fs.existsSync', () => {
		const src = readFileSync(EXTENSION_TS, 'utf8');
		// Anchor at the const declaration so the window covers the whole block
		// from path declaration through the writeFileAtomic call.
		const patternBlock = src.match(/const rulesPath\s*=[\s\S]{0,8000}?writeFileAtomic\(rulesPath/);
		expect(patternBlock, 'ace-patterns rules write block not found').toBeTruthy();
		expect(patternBlock![0]).toMatch(/forceUpdate\s*\|\|\s*!fs\.existsSync\(rulesPath\)/);
	});

	it('ace-domain-search rule write is guarded by forceUpdate || !fs.existsSync', () => {
		const src = readFileSync(EXTENSION_TS, 'utf8');
		const block = src.match(/const domainRulePath\s*=[\s\S]{0,8000}?writeFileAtomic\(domainRulePath/);
		expect(block, 'ace-domain-search rules write block not found').toBeTruthy();
		expect(block![0]).toMatch(/forceUpdate\s*\|\|\s*!fs\.existsSync\(domainRulePath\)/);
	});

	it('ace-continuous-search rule write is guarded by forceUpdate || !fs.existsSync', () => {
		const src = readFileSync(EXTENSION_TS, 'utf8');
		const block = src.match(/const continuousSearchRulePath\s*=[\s\S]{0,8000}?writeFileAtomic\(continuousSearchRulePath/);
		expect(block, 'ace-continuous-search rules write block not found').toBeTruthy();
		expect(block![0]).toMatch(/forceUpdate\s*\|\|\s*!fs\.existsSync\(continuousSearchRulePath\)/);
	});
});
