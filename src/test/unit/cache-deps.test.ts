/**
 * u02-cache (#12) — CACHE: better-sqlite3 bump + alignment test
 *
 * Asserts:
 *  1. package.json pins better-sqlite3 to ^12.8.0
 *
 * Note: the @ace-sdk/core ^3.x assertion belongs to unit #5 (a53c54d) and
 * the esbuild.js external[] assertion belongs to the packaging fix commit —
 * both were tautological here (already true before this commit).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('u02-cache: better-sqlite3 alignment', () => {
  it('package.json better-sqlite3 dep is ^12.8.0', () => {
    expect(pkg.dependencies['better-sqlite3']).toBe('^12.8.0');
  });
});
