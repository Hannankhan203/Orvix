import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import express from 'express';

import {
  resolveLocalTrainedDataInfo,
  resolveLocalTesseractAssets,
  rawImageDataToBmp,
  extractImageText,
  discardOcrWorker
} from '../src/services/imageOcrService.js';
import { registerUploadRoutes } from '../server/uploadSubsystem.ts';
import {
  EMBEDDING_DIMENSION,
  generateSemanticEmbedding,
  computeCosineSimilarity
} from '../src/services/semanticEmbeddingService.js';
import {
  indexDocument,
  searchSemanticChunks
} from '../src/services/semanticRetrievalService.js';
import { resetVectorDBForTesting } from '../src/services/semanticVectorStorage.js';

const REPO_ROOT = process.cwd();

test('ORVIX-INFO-01: Bun-compatible dependency audit is configured without introducing package-lock.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const ciContent = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'bun.lock')), true, 'bun.lock must be preserved');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'package-lock.json')), false, 'package-lock.json must never be introduced');

  assert.equal(pkg.scripts?.audit, 'bun audit');
  assert.equal(pkg.scripts?.['audit:json'], 'bun audit --json');
  assert.match(ciContent, /bun run audit/, 'CI workflow must invoke bun run audit');
  assert.match(ciContent, /bun install --frozen-lockfile/, 'CI workflow must preserve frozen lockfile installs');
});

test('ORVIX-INFO-01: bun audit --json executes cleanly and outputs valid JSON advisory report', () => {
  let stdout = '';
  try {
    stdout = execSync('bun audit --json', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    // bun audit exits non-zero when advisories exist while still writing valid JSON to stdout
    stdout = String(err?.stdout || '');
  }

  assert.ok(stdout.trim().startsWith('{'), 'bun audit --json must emit JSON');
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed !== null);
});

test('ORVIX-INFO-02: incremental JS/JSX static checking configuration exists and passes with zero errors', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const ciContent = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const checkJsConfigPath = path.join(REPO_ROOT, 'tsconfig.checkjs.json');

  assert.equal(fs.existsSync(checkJsConfigPath), true, 'tsconfig.checkjs.json must exist');
  const checkJsConfig = JSON.parse(fs.readFileSync(checkJsConfigPath, 'utf8'));

  assert.equal(checkJsConfig.compilerOptions?.checkJs, true);
  assert.equal(checkJsConfig.compilerOptions?.noImplicitAny, true);
  assert.equal(checkJsConfig.compilerOptions?.strictFunctionTypes, true);
  assert.equal(checkJsConfig.compilerOptions?.noImplicitThis, true);
  assert.equal(checkJsConfig.compilerOptions?.noEmit, true);
  assert.ok(Array.isArray(checkJsConfig.include) && checkJsConfig.include.length >= 20);

  // Verify frontend files retain .js/.jsx extensions without unnecessary migration renames
  assert.ok(checkJsConfig.include.some((f: string) => f.endsWith('.js')));
  assert.ok(checkJsConfig.include.some((f: string) => f.endsWith('.jsx')));

  assert.equal(pkg.scripts?.['lint:js'], 'tsc -p tsconfig.checkjs.json --noEmit');
  assert.match(ciContent, /bun run lint:js/, 'CI workflow must run incremental JS/JSX static check');

  // Execute tsc against tsconfig.checkjs.json directly to ensure 0 diagnostics
  const tscBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  execSync(`"${tscBin}" -p tsconfig.checkjs.json --noEmit`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
});

test('ORVIX-INFO-03: eng.traineddata is losslessly gzipped on disk, scoped to OCR serverless endpoints, and works offline', async () => {
  const rawRootPath = path.join(REPO_ROOT, 'eng.traineddata');
  const gzRootPath = path.join(REPO_ROOT, 'eng.traineddata.gz');
  const publicDir = path.join(REPO_ROOT, 'public');

  assert.equal(fs.existsSync(rawRootPath), false, 'Uncompressed eng.traineddata should be replaced by lossless eng.traineddata.gz');
  assert.equal(fs.existsSync(gzRootPath), true, 'eng.traineddata.gz must exist for offline server OCR');

  const gzStats = fs.statSync(gzRootPath);
  assert.ok(gzStats.size > 100 * 1024 && gzStats.size < 3.5 * 1024 * 1024, 'Gzipped eng.traineddata.gz must reduce storage footprint under 3.5 MB');

  // Ensure neither public/ nor dist/ (if built) embeds traineddata into client static assets
  const publicFiles = fs.readdirSync(publicDir);
  assert.equal(publicFiles.some((f) => f.includes('traineddata')), false, 'public/ must not ship traineddata into client shell');

  // Verify vercel.json scopes OCR bundle files only to OCR-capable functions
  const vercelCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8'));
  assert.equal(vercelCfg.functions?.['api/*.ts']?.includeFiles, undefined, 'Non-OCR api/*.ts endpoints must not bundle Tesseract & traineddata');
  assert.ok(vercelCfg.functions?.['api/chat.ts']?.includeFiles?.includes('eng.traineddata*'));

  // Verify offline asset resolver picks up eng.traineddata.gz cleanly and Tesseract OCR executes offline
  const info = resolveLocalTrainedDataInfo();
  assert.ok(info);
  assert.equal(info.gzip, true);

  const assets = resolveLocalTesseractAssets();
  assert.equal(assets.gzip, true);

  const bmp = rawImageDataToBmp(48, 24, 3, Buffer.alloc(48 * 24 * 3, 255));
  assert.ok(bmp, 'rawImageDataToBmp must produce a valid BMP Buffer');
  const ocrResult: any = await extractImageText(bmp, 'blank.bmp', '.bmp', 'image/bmp', 'test-ocr-gz', { width: 48, height: 24 }, null, {
    offline: true
  });
  await discardOcrWorker();
  assert.equal(ocrResult.success, true);
  assert.equal(ocrResult.ocrEngine, 'tesseract-local');
});

test('ORVIX-INFO-03: /api/ocr/packs/:file serves gzipped and uncompressed English packs accurately from local asset', async () => {
  const app = express();
  registerUploadRoutes(app);

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const gzRes = await fetch(`${baseUrl}/api/ocr/packs/eng.traineddata.gz`);
    assert.equal(gzRes.status, 200);
    assert.equal(gzRes.headers.get('content-type'), 'application/gzip');
    const gzBuf = Buffer.from(await gzRes.arrayBuffer());
    assert.equal(gzBuf[0], 0x1f);
    assert.equal(gzBuf[1], 0x8b);

    const rawRes = await fetch(`${baseUrl}/api/ocr/packs/eng.traineddata`);
    assert.equal(rawRes.status, 200);
    assert.equal(rawRes.headers.get('content-type'), 'application/octet-stream');
    const rawBuf = Buffer.from(await rawRes.arrayBuffer());
    assert.equal(rawBuf.equals(zlib.gunzipSync(gzBuf)), true, 'Uncompressed endpoint must match gunzipped eng.traineddata.gz byte-for-byte');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('ORVIX-INFO-04: lightweight 256-dim semantic embeddings preserve synonym alignment, bounded memory, and corpus-IDF rare-term ranking', async () => {
  assert.equal(EMBEDDING_DIMENSION, 256);

  // 1. Compact memory footprint (Float32Array length 256 = 1024 bytes) & synonym similarity
  const qVec = generateSemanticEmbedding('How much profit did the company earn?');
  const matchVec = generateSemanticEmbedding('Annual net revenue reached 12 million dollars for the enterprise.');
  const unrelatedVec = generateSemanticEmbedding('Garden soil nutrients and watering schedules for roses.');

  assert.equal(qVec instanceof Float32Array, true);
  assert.equal(qVec.byteLength, 256 * 4);

  const matchSim = computeCosineSimilarity(qVec, matchVec);
  const unrelatedSim = computeCosineSimilarity(qVec, unrelatedVec);
  assert.ok(matchSim > 0.45, `Expected strong synonym cosine match (>0.45), got ${matchSim}`);
  assert.ok(matchSim - unrelatedSim > 0.35, 'Synonym match must clearly separate from unrelated distractor');

  // 2. Corpus-IDF specificity reranking distinguishes rare identifiers/terms inside same-domain chunks
  resetVectorDBForTesting();
  const conversationId = 'conv-info-04-idf';

  const doc = {
    id: 'doc-contracts-idf',
    originalName: 'master-agreement.txt',
    format: 'TXT',
    status: 'ready',
    success: true,
    text: [
      'Section 1.1 General Contract Terms and Conditions: Payment terms and invoice compliance guidelines for standard enterprise software agreements and subscriptions.',
      '',
      'Section 4.2 Indemnification Cap: Software vendor liability and indemnification cap under clause XQ-9042 for enterprise contract disputes.',
      '',
      'Section 7.0 General Contract Terms and Conditions: Customer support escalation rules and standard enterprise subscription agreement compliance.'
    ].join('\n\n')
  };

  await indexDocument(doc, conversationId);
  const results = await searchSemanticChunks({
    query: 'What is the indemnification cap in clause XQ-9042 for enterprise contract?',
    conversationId,
    inMemoryDocs: [doc],
    topK: 3
  });

  assert.ok(results.length >= 1);
  assert.ok(results[0].text.includes('XQ-9042'), 'Top chunk should match rare clause identifier XQ-9042 via vector + IDF specificity');
  assert.ok(results[0].score <= 1 && results[0].score >= 0.15, 'Combined score must remain bounded within [minScore, 1.0]');
});
