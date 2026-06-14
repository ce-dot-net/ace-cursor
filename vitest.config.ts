import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/test/unit/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		// ESM support for @ace-sdk/core
		globals: true,
		// Many unit tests spawn bash/pwsh/node subprocesses (hook scripts, the baked
		// MCP proxy, the search/learn helpers). Under parallel load these legitimately
		// exceed the 5s default and flake; 20s gives headroom without masking real hangs.
		// 30s vitest budget sits above the 20s subprocess (spawnSync) cap in the
		// bash/pwsh test harnesses, so a slow-but-completing subprocess never trips
		// the vitest timeout first.
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
