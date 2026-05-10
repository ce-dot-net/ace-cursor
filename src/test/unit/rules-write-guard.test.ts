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

	// v0.5.0-dev.4: ace-continuous-search rule retired. Activation now removes
	// the obsolete folder instead of writing a RULE.md.
	it('ace-continuous-search rule folder is removed on activation if present', () => {
		const src = readFileSync(EXTENSION_TS, 'utf8');
		expect(src).toMatch(/ace-continuous-search/);
		expect(src).toMatch(/obsoleteContSearchDir|Removed obsolete ace-continuous-search/);
	});
});
