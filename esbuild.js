const esbuild = require('esbuild');

const production = process.argv.includes('--production');

// Common build options
const commonOptions = {
  bundle: true,
  external: [
    'vscode',         // provided by the VS Code runtime — must stay external
    'better-sqlite3', // native Node addon (.node binary) — cannot be bundled
    // linguist-js + skott previously externalized due to dynamic requires;
    // now bundled to keep node_modules in the VSIX minimal (better-sqlite3 only).
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  // @ace-sdk/core@2.14.0+ ships CJS build — no more ESM workarounds needed
  mainFields: ['main', 'module'],
  conditions: ['require', 'node', 'import'],
};

async function build() {
  // Build main extension
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
  });
  console.log('Extension build complete');

  // Build uninstall cleanup script (vscode:uninstall hook)
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/lifecycle/uninstall.ts'],
    outfile: 'dist/lifecycle/uninstall.js',
    external: [], // Self-contained, no externals needed (only uses node builtins)
  });

  // Build test runner
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/runTest.ts'],
    outfile: 'dist/test/runTest.js',
    external: [...commonOptions.external, '@vscode/test-electron'],
  });

  // Build test suite index
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/suite/index.ts'],
    outfile: 'dist/test/suite/index.js',
    external: [...commonOptions.external, 'mocha', 'glob'],
  });

  // Build test file
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
