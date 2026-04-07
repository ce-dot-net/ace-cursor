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

// @ace-sdk/core@2.13.1 uses import.meta.url in version.js — breaks in CJS bundles.
// This plugin replaces import.meta.url with a CJS-compatible expression inline.
// @ace-sdk/core@2.13.1 uses import.meta.url + readFileSync(../package.json) in version.js.
// When bundled by esbuild, both break: import.meta.url is undefined, and the relative
// path to package.json no longer resolves. This plugin inlines the version string directly.
const importMetaPlugin = {
  name: 'inline-sdk-version',
  setup(build) {
    build.onLoad({ filter: /node_modules\/@ace-sdk\/core\/dist\/version\.js$/ }, async (args) => {
      // Read the actual version from the SDK's package.json at build time
      const fs = require('fs');
      const path = require('path');
      const pkgPath = path.join(path.dirname(args.path), '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      // Replace the entire module with a hardcoded version export
      return {
        contents: `export const CORE_VERSION = ${JSON.stringify(pkg.version)};`,
        loader: 'js',
      };
    });
  },
};

async function build() {
  // Build main extension
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    plugins: [importMetaPlugin],
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

  // Build test file — bundle @ace-sdk/core inline (ESM-only, can't be external)
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/test/suite/extension.test.ts'],
    outfile: 'dist/test/suite/extension.test.js',
    external: [...commonOptions.external, 'mocha', 'glob'],
    plugins: [importMetaPlugin],
  });
  console.log('Test build complete');

  console.log('Build complete');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
