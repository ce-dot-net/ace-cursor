import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/test/unit/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		// ESM support for @ace-sdk/core
		globals: true,
	},
});
