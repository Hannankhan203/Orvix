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

test('ORVIX-HIGH-03 production start script: uses tsx server.ts, includes tsx in runtime dependencies, declares engines.node >=18.0.0, and starts server cleanly', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');

  const packageJsonPath = path.join(REPO_ROOT, 'package.json');
  const readmePath = path.join(REPO_ROOT, 'README.md');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const readme = fs.readFileSync(readmePath, 'utf8');

  // 1. Verify start script uses tsx rather than bare 'node server.ts'
  assert.equal(
    pkg.scripts?.start,
    'tsx server.ts',
    'package.json start script must use tsx server.ts for Node.js <22.6 compatibility'
  );

  // 2. Verify tsx is in production dependencies so --omit=dev deployments have the runner
  assert.ok(
    pkg.dependencies?.tsx,
    'tsx must be declared in package.json dependencies for production runtime execution'
  );

  // 3. Verify engines.node preserves >=18.0.0 compatibility and aligns with README
  assert.equal(pkg.engines?.node, '>=18.0.0', 'package.json engines.node must be >=18.0.0');
  assert.match(readme, />=18\.0\.0/, 'README.md must document >=18.0.0 Node.js support');
  assert.match(readme, /tsx server\.ts/, 'README.md must document tsx server.ts production startup');

  // 4. Find an available ephemeral port and boot server.ts using the production start runner
  const probeServer = net.createServer();
  await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = probeServer.address() as import('node:net').AddressInfo;
  const testPort = addr.port;
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));

  const tsxBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, ['server.ts', '--port', String(testPort)], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(testPort),
      ORVIX_SIGNED_URL_SECRET: 'test-production-signed-url-secret-32chars-minimum-ok'
    },
    stdio: 'ignore'
  });
  child.unref();

  try {
    let healthy = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/api/health`);
        if (res.status === 200) {
          const data = (await res.json()) as any;
          if (data.status === 'ok') {
            healthy = true;
            break;
          }
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(healthy, true, 'Production server started via tsx server.ts must respond 200 OK on /api/health');
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_) {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
      }
    }
  }
});
