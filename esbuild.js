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

// @ace-sdk/core@2.13.1 uses import.meta.url in version.js — provide a CJS shim
// Only for bundles that import @ace-sdk/core (NOT the test runner which may load as ESM)
const importMetaBanner = {
  js: 'try{if(typeof import.meta==="undefined"&&typeof require!=="undefined"){Object.defineProperty(globalThis,"import",{value:{meta:{url:require("url").pathToFileURL(__filename).href}}})}}catch(e){}',
};

async function build() {
  // Build main extension (needs import.meta shim for @ace-sdk/core)
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    banner: importMetaBanner,
  });
  console.log('Extension build complete');

  // Build test runner — NO banner (loads as ESM in some CI environments)
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/runTest.ts'],
    outfile: 'dist/test/runTest.js',
    external: [...commonOptions.external, '@vscode/test-electron'],
  });

  // Build test suite index — NO banner (doesn't import @ace-sdk/core)
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/suite/index.ts'],
    outfile: 'dist/test/suite/index.js',
    external: [...commonOptions.external, 'mocha', 'glob'],
  });

  // Build test file (needs import.meta shim for @ace-sdk/core via StatusPanel import)
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/suite/extension.test.ts'],
    outfile: 'dist/test/suite/extension.test.js',
    external: [...commonOptions.external, 'mocha', 'glob'],
    banner: importMetaBanner,
  });
  console.log('Test build complete');

  console.log('Build complete');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
