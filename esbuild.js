const esbuild = require('esbuild');

const production = process.argv.includes('--production');

// Common build options
const commonOptions = {
  bundle: true,
  external: [
    'vscode', // vscode is provided by the runtime
    // Mark SDK dependencies with native/dynamic requires as external
    'better-sqlite3',
    'linguist-js',
    'skott',
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  // Handle ESM modules (needed for @ace-sdk/core which is ESM-only)
  mainFields: ['module', 'main'],
  conditions: ['import', 'require', 'node'],
};

async function build() {
  // Build main extension
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
  });
  console.log('Extension build complete');

  // Build test runner and tests (bundles @ace-sdk/core inline to avoid ESM/CJS issues)
  // Always build tests - CI needs them
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/runTest.ts'],
    outfile: 'dist/test/runTest.js',
    external: [...commonOptions.external, '@vscode/test-electron'],
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/suite/index.ts'],
    outfile: 'dist/test/suite/index.js',
    external: [...commonOptions.external, 'mocha', 'glob'],
  });

  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/suite/extension.test.ts'],
    outfile: 'dist/test/suite/extension.test.js',
    external: [...commonOptions.external, 'mocha', 'glob'],
  });
  console.log('Test build complete');

  console.log('Build complete');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
