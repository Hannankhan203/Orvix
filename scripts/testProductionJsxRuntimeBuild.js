/**
 * Targeted Regression Test: Production JSX Runtime Build Consistency
 *
 * Ensures production Vite builds never emit `jsxDEV(...)` calls while bundling
 * `process.env.NODE_ENV = "production"` (where React 19's `jsx-dev-runtime`
 * exports `jsxDEV = undefined`, causing `TypeError: (0 , R.jsxDEV) is not a function`).
 *
 * Verifies:
 * 1. Vite resolveConfig() resolves `oxc.jsx.development === false` and
 *    `define['process.env.NODE_ENV'] === '"production"'` for `command: 'build'`
 *    even when the shell/CI environment has `NODE_ENV=development`.
 * 2. Vite resolveConfig() keeps `oxc.jsx.development` symmetric with
 *    `define['process.env.NODE_ENV']` in `serve` mode.
 * 3. Direct `vite build` invocation (without `npm_lifecycle_event=build`) with
 *    `NODE_ENV=development` produces chunks that use `jsx`/`jsxs` and contain
 *    zero `jsxDEV(...)` calls or production `jsxDEV = void 0` runtime stubs.
 *
 * Run with: node scripts/testProductionJsxRuntimeBuild.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from 'vite';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err?.stack || err}`);
    failed++;
  }
}

console.log('=== Production JSX Runtime Build Regression Suite ===\n');

await runTest('resolveConfig enforces production Oxc JSX + NODE_ENV even when shell NODE_ENV=development', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const resolved = await resolveConfig({}, 'build', 'production', 'production');
    assert.equal(resolved.isProduction, true, 'resolved.isProduction must be true during production build');
    assert.notEqual(resolved.oxc, false, 'oxc must be enabled');
    assert.equal(typeof resolved.oxc.jsx, 'object', 'oxc.jsx must be an options object');
    assert.equal(resolved.oxc.jsx.runtime, 'automatic', 'oxc.jsx.runtime must be automatic');
    assert.equal(resolved.oxc.jsx.development, false, 'oxc.jsx.development must be false in production build');
    assert.equal(
      resolved.define?.['process.env.NODE_ENV'],
      '"production"',
      'define["process.env.NODE_ENV"] must match production'
    );
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  }
});

await runTest('resolveConfig keeps oxc.jsx.development and NODE_ENV symmetric in serve mode', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const resolved = await resolveConfig({}, 'serve', 'development', 'development');
    assert.equal(resolved.isProduction, false, 'resolved.isProduction must be false in dev serve');
    assert.notEqual(resolved.oxc, false);
    assert.equal(resolved.oxc.jsx.development, true, 'oxc.jsx.development must be true in dev serve');
    assert.equal(
      resolved.define?.['process.env.NODE_ENV'],
      '"development"',
      'define["process.env.NODE_ENV"] must be development in dev serve'
    );
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  }
});

await runTest('Direct vite build under NODE_ENV=development emits zero jsxDEV calls or dev-runtime stubs', async () => {
  const tmpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orvix-jsx-prod-'));
  try {
    const viteBin = path.resolve('node_modules', 'vite', 'bin', 'vite.js');
    const cleanEnv = { ...process.env, NODE_ENV: 'development' };
    delete cleanEnv.npm_lifecycle_event;

    const result = spawnSync(
      process.execPath,
      [viteBin, 'build', '--outDir', tmpOutDir],
      {
        cwd: process.cwd(),
        env: cleanEnv,
        encoding: 'utf8',
        timeout: 120000
      }
    );

    assert.equal(result.status, 0, `vite build failed:\n${result.stdout}\n${result.stderr}`);

    const assetsDir = path.join(tmpOutDir, 'assets');
    assert.ok(fs.existsSync(assetsDir), 'assets directory must exist in build output');

    const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    assert.ok(jsFiles.length > 0, 'JS chunks must be generated');

    const indexChunk = jsFiles.find((f) => f.startsWith('index-') && f.endsWith('.js'));
    assert.ok(indexChunk, 'entry chunk index-*.js must exist');

    const vendorReactChunk = jsFiles.find((f) => f.startsWith('vendor-react-') && f.endsWith('.js'));
    assert.ok(vendorReactChunk, 'vendor-react-*.js chunk must exist');

    for (const file of jsFiles) {
      const content = fs.readFileSync(path.join(assetsDir, file), 'utf8');
      assert.equal(
        /(?:\.|_|\b)jsxDEV\s*\(/.test(content),
        false,
        `${file} must not contain any jsxDEV(...) calls`
      );
      assert.equal(
        /react-jsx-dev-runtime/.test(content),
        false,
        `${file} must not bundle react-jsx-dev-runtime`
      );
    }

    const vendorReactContent = fs.readFileSync(path.join(assetsDir, vendorReactChunk), 'utf8');
    assert.equal(
      /\.jsxDEV\s*=\s*void 0/.test(vendorReactContent),
      false,
      'vendor-react must not bundle the production jsxDEV = void 0 stub'
    );

    const indexContent = fs.readFileSync(path.join(assetsDir, indexChunk), 'utf8');
    assert.ok(
      indexContent.includes(vendorReactChunk.replace(/\.js$/, '')) || /vendor-react/.test(indexContent),
      'entry chunk should import vendor-react production runtime'
    );
  } finally {
    fs.rmSync(tmpOutDir, { recursive: true, force: true });
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
