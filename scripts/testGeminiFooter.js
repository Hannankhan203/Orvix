/**
 * Test Suite: Gemini Chat Footer Model Name Verification
 *
 * Verifies:
 * 1. Authoritative Gemini configuration resolves to `gemini-3.8-flash` (`Gemini 3.8 Flash`).
 * 2. `getProviderFootnote('gemini')` displays `Gemini 3.8 Flash` derived from centralized config
 *    and never displays stale `Gemini 2.5 Flash`.
 * 3. Default/unrecognized provider fallback in `getProviderFootnote` also displays `Gemini 3.8 Flash`.
 * 4. Switching to Groq, OpenRouter, Cloudflare, or Browser AI (WebLLM) displays each provider's
 *    own footer and never leaks Gemini's model name.
 * 5. Active UI code under `src/` contains zero stale `Gemini 2.5 Flash` references.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

import { PROVIDER_OPTIONS, AI_PROVIDERS } from '../src/services/aiRouter.js';
import { PROVIDER_DEFAULT_MODELS } from '../src/services/providerModelSanitizer.js';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  SMOLLM2_135M_WEBLLM_MODEL_ID,
  SMOLLM2_360M_WEBLLM_MODEL_ID,
  QWEN3_06B_WEBLLM_MODEL_ID
} from '../src/services/webllmService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

async function loadGetProviderFootnote() {
  const buildResult = await esbuild.build({
    stdin: {
      contents: "export { getProviderFootnote } from './src/components/chat/ChatArea.jsx';",
      resolveDir: ROOT_DIR,
      loader: 'js'
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    treeShaking: true,
    plugins: [
      {
        name: 'stub-child-jsx-imports',
        setup(build) {
          build.onResolve({ filter: /\.jsx$/ }, (args) => {
            if (args.path.endsWith('ChatArea.jsx')) return null;
            return { path: args.path, namespace: 'jsx-stub' };
          });
          build.onLoad({ filter: /.*/, namespace: 'jsx-stub' }, () => ({
            contents: 'export default () => null;',
            loader: 'js'
          }));
        }
      }
    ]
  });

  const bundledCode = buildResult.outputFiles[0].text;
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(bundledCode, 'utf8').toString('base64')}`
  );
  return mod.getProviderFootnote;
}

function collectFilesRecursively(dirPath, extensions) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

const getProviderFootnote = await loadGetProviderFootnote();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

console.log('================================================================');
console.log('🧪 Gemini Chat Footer Verification Suite');
console.log('================================================================\n');

test('1. Centralized Gemini configuration specifies gemini-3.8-flash / Gemini 3.8 Flash', () => {
  assert.strictEqual(PROVIDER_DEFAULT_MODELS.gemini, 'gemini-3.8-flash');
  const geminiOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.GEMINI);
  assert.ok(geminiOption, 'Gemini entry must exist in PROVIDER_OPTIONS');
  assert.strictEqual(geminiOption.defaultModel, PROVIDER_DEFAULT_MODELS.gemini);
  assert.strictEqual(geminiOption.modelTag, 'Gemini 3.8 Flash');
});

test('2. Gemini footer displays configured Gemini 3.8 Flash model name', () => {
  const geminiOption = PROVIDER_OPTIONS.find((p) => p.id === AI_PROVIDERS.GEMINI);
  const footnote = getProviderFootnote('gemini');

  assert.strictEqual(
    footnote,
    `Orvix is powered by Google Gemini (${geminiOption.modelTag}). Client integration — verify important facts independently.`
  );
  assert.ok(footnote.includes('Gemini 3.8 Flash'), 'Footer must display Gemini 3.8 Flash');
  assert.ok(!footnote.includes('Gemini 2.5 Flash'), 'Footer must not display Gemini 2.5 Flash');
});

test('3. Default/unrecognized provider fallback displays configured Gemini 3.8 Flash model name', () => {
  for (const fallbackArg of [undefined, null, '', 'unknown-provider']) {
    const footnote = getProviderFootnote(fallbackArg);
    assert.ok(
      footnote.includes('Google Gemini (Gemini 3.8 Flash)'),
      `Fallback for ${String(fallbackArg)} must display Google Gemini (Gemini 3.8 Flash)`
    );
    assert.ok(
      !footnote.includes('Gemini 2.5 Flash'),
      `Fallback for ${String(fallbackArg)} must not display Gemini 2.5 Flash`
    );
  }
});

test('4. Switching to Groq, OpenRouter, Cloudflare, or Browser AI does not display Gemini model name', () => {
  const groqFootnote = getProviderFootnote('groq');
  assert.strictEqual(
    groqFootnote,
    'Orvix is powered by Groq (GPT OSS 120B). Ultra-fast inference — verify important facts independently.'
  );
  assert.ok(!groqFootnote.includes('Gemini'));

  const openrouterFootnote = getProviderFootnote('openrouter');
  assert.strictEqual(
    openrouterFootnote,
    'Orvix is powered by OpenRouter (Free Models Router), dynamically selecting from available free community models.'
  );
  assert.ok(!openrouterFootnote.includes('Gemini'));

  const cloudflareFootnote = getProviderFootnote('cloudflare');
  assert.strictEqual(
    cloudflareFootnote,
    'Orvix is powered by Cloudflare Workers AI (Llama 3.1 8B). Serverless inference — verify important facts independently.'
  );
  assert.ok(!cloudflareFootnote.includes('Gemini'));

  for (const [modelId, expectedLabel] of [
    [DEFAULT_WEBLLM_MODEL_ID, 'Qwen 2.5 1.5B'],
    [SMOLLM2_135M_WEBLLM_MODEL_ID, 'SmolLM2 135M'],
    [SMOLLM2_360M_WEBLLM_MODEL_ID, 'SmolLM2 360M'],
    [QWEN3_06B_WEBLLM_MODEL_ID, 'Qwen3 0.6B']
  ]) {
    const webllmFootnote = getProviderFootnote('webllm', modelId);
    assert.strictEqual(
      webllmFootnote,
      `Orvix is powered by Browser AI (WebLLM) (${expectedLabel}). On-device WebGPU inference — verify important facts independently.`
    );
    assert.ok(!webllmFootnote.includes('Gemini'));
  }
});

test('5. ChatArea.jsx derives Gemini footer label from centralized config rather than hardcoded version text', () => {
  const chatAreaSrc = fs.readFileSync(
    path.join(ROOT_DIR, 'src/components/chat/ChatArea.jsx'),
    'utf8'
  );
  assert.ok(!chatAreaSrc.includes('Gemini 2.5 Flash'), 'ChatArea.jsx must not contain Gemini 2.5 Flash');
  assert.ok(!chatAreaSrc.includes('Gemini 3.8 Flash'), 'ChatArea.jsx must not duplicate hardcoded Gemini 3.8 Flash text');
  assert.ok(chatAreaSrc.includes('PROVIDER_DEFAULT_MODELS'), 'ChatArea.jsx must reference PROVIDER_DEFAULT_MODELS');
  assert.ok(chatAreaSrc.includes('PROVIDER_OPTIONS'), 'ChatArea.jsx must reference PROVIDER_OPTIONS');
});

test('6. Active UI source files under src/ contain zero stale Gemini 2.5 Flash references', () => {
  const srcFiles = collectFilesRecursively(path.join(ROOT_DIR, 'src'), ['.js', '.jsx', '.ts', '.tsx']);
  const staleMatches = [];
  for (const filePath of srcFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (/Gemini\s+2\.5\s+Flash/i.test(content)) {
      staleMatches.push(path.relative(ROOT_DIR, filePath));
    }
  }
  assert.deepStrictEqual(staleMatches, [], `Found stale Gemini 2.5 Flash references in: ${staleMatches.join(', ')}`);
});

console.log('\n================================================================');
console.log(`📊 Suite Results: ${passed} passed, ${failed} failed`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
