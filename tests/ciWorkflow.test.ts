import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

test('ORVIX-H01 CI workflow: uses Bun with bun.lock caching, --frozen-lockfile, and preserves lint/test/build checks', () => {
  const ciPath = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
  const bunLockPath = path.join(REPO_ROOT, 'bun.lock');
  const npmLockPath = path.join(REPO_ROOT, 'package-lock.json');
  const packageJsonPath = path.join(REPO_ROOT, 'package.json');

  assert.equal(fs.existsSync(ciPath), true, '.github/workflows/ci.yml must exist');
  assert.equal(fs.existsSync(bunLockPath), true, 'bun.lock must exist');
  assert.equal(fs.existsSync(npmLockPath), false, 'package-lock.json must not be introduced');

  const ciContent = fs.readFileSync(ciPath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // Must not retain broken npm CI / npm cache steps
  assert.equal(/\bnpm\s+ci\b/.test(ciContent), false, 'CI must not use npm ci');
  assert.equal(/cache:\s*['"]npm['"]/.test(ciContent), false, 'CI must not use npm cache');
  assert.equal(/\bnpm\s+(test|run)\b/.test(ciContent), false, 'CI must invoke scripts via bun run');

  // Must set up Bun and Node (for node --import tsx --test)
  assert.match(ciContent, /uses:\s*oven-sh\/setup-bun@v\d+/, 'CI must use oven-sh/setup-bun');
  assert.match(ciContent, /uses:\s*actions\/setup-node@v\d+/, 'CI must retain Node.js setup for test runner');
  assert.match(ciContent, /node-version:\s*\[22\.12\.0\]/, 'CI must keep Node.js 22.12.0');

  // Must cache Bun dependencies keyed off bun.lock
  assert.match(ciContent, /uses:\s*actions\/cache@v\d+/, 'CI must cache Bun dependencies');
  assert.match(ciContent, /hashFiles\(['"]bun\.lock['"]\)/, 'CI cache key must hash bun.lock');

  // Must install strictly from frozen bun.lock and preserve all verification steps
  assert.match(ciContent, /run:\s*bun install --frozen-lockfile/, 'CI must run bun install --frozen-lockfile');
  assert.match(ciContent, /run:\s*bun run lint/, 'CI must run bun run lint');
  assert.match(ciContent, /run:\s*bun run test/, 'CI must run bun run test');
  assert.match(ciContent, /run:\s*bun run build/, 'CI must run bun run build');

  assert.ok(pkg.scripts?.lint, 'package.json must define lint script');
  assert.ok(pkg.scripts?.test, 'package.json must define test script');
  assert.ok(pkg.scripts?.build, 'package.json must define build script');
});
