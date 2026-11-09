/**
 * Multilingual OCR Pack Management Test Suite (Phase 6 Prompt 29)
 *
 * Verifies:
 * 1. Language pack registry & metadata (English default, Spanish, French, German, Arabic, Urdu RTL)
 * 2. Language support detection (whitelist checking and case insensitivity)
 * 3. Pack cache keys and URL normalization
 * 4. Language pack buffer integrity verification (minimum size, HTML error detection)
 * 5. English pack built-in availability (always cached)
 * 6. On-demand downloading with real-time progress callbacks
 * 7. In-flight download deduplication (avoiding duplicate concurrent network fetches)
 * 8. Offline cache storage and offline reuse (Cache API / in-memory fallback)
 * 9. Corrupt/truncated cache detection and automatic eviction
 * 10. Unsupported language error handling ('UNSUPPORTED_LANGUAGE')
 * 11. Cache eviction and listing lifecycle (delete, list, clear)
 * 12. Server-side uploadSubsystem multilingual extraction and pack proxy route validation
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  SUPPORTED_OCR_LANGUAGES,
  isLanguageSupported,
  getLanguageDetails,
  getPackCacheKey,
  validateLanguagePackBuffer,
  isLanguagePackCached,
  getCachedLanguagePack,
  downloadLanguagePack,
  deleteCachedLanguagePack,
  listCachedLanguagePacks,
  clearLanguagePackCache,
  resetOcrCacheForTesting,
  MIN_VALID_PACK_SIZE
} from '../src/services/ocrLanguagePackService.js';

console.log('=== Starting Multilingual OCR Pack Management Verification Suite ===\n');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

async function runSuite() {
  // Reset test cache before running
  resetOcrCacheForTesting();

  // Test 1: Language Pack Registry & Metadata
  await test('SUPPORTED_OCR_LANGUAGES defines all required languages with accurate RTL flags', () => {
    assert(Array.isArray(SUPPORTED_OCR_LANGUAGES), 'SUPPORTED_OCR_LANGUAGES must be an array');
    assert.strictEqual(SUPPORTED_OCR_LANGUAGES.length, 6, 'Must define exactly 6 supported languages');

    const codes = SUPPORTED_OCR_LANGUAGES.map((l) => l.code);
    assert(codes.includes('eng'), 'Must include English (eng)');
    assert(codes.includes('spa'), 'Must include Spanish (spa)');
    assert(codes.includes('fra'), 'Must include French (fra)');
    assert(codes.includes('deu'), 'Must include German (deu)');
    assert(codes.includes('ara'), 'Must include Arabic (ara)');
    assert(codes.includes('urd'), 'Must include Urdu (urd)');

    const eng = SUPPORTED_OCR_LANGUAGES.find((l) => l.code === 'eng');
    assert.strictEqual(eng.isDefault, true, 'English must be default');
    assert.strictEqual(eng.isBuiltIn, true, 'English must be built-in');
    assert.strictEqual(eng.isRtl, false, 'English is not RTL');

    const ara = SUPPORTED_OCR_LANGUAGES.find((l) => l.code === 'ara');
    assert.strictEqual(ara.isRtl, true, 'Arabic must have isRtl: true');
    assert.strictEqual(ara.isBuiltIn, false, 'Arabic is downloaded on-demand');

    const urd = SUPPORTED_OCR_LANGUAGES.find((l) => l.code === 'urd');
    assert.strictEqual(urd.isRtl, true, 'Urdu must have isRtl: true');
    assert.strictEqual(urd.isBuiltIn, false, 'Urdu is downloaded on-demand');

    const spa = SUPPORTED_OCR_LANGUAGES.find((l) => l.code === 'spa');
    assert.strictEqual(spa.isRtl, false, 'Spanish is not RTL');
    assert.strictEqual(spa.isBuiltIn, false, 'Spanish is downloaded on-demand');
  });

  // Test 2: Language Support Checker
  await test('isLanguageSupported accurately validates supported codes with whitespace/case insensitivity', () => {
    assert.strictEqual(isLanguageSupported('eng'), true);
    assert.strictEqual(isLanguageSupported('SPA'), true);
    assert.strictEqual(isLanguageSupported(' fra '), true);
    assert.strictEqual(isLanguageSupported('Deu'), true);
    assert.strictEqual(isLanguageSupported('ara'), true);
    assert.strictEqual(isLanguageSupported('urd'), true);

    assert.strictEqual(isLanguageSupported('rus'), false, 'Russian not supported in prompt');
    assert.strictEqual(isLanguageSupported('chi_sim'), false, 'Chinese not supported in prompt');
    assert.strictEqual(isLanguageSupported(''), false);
    assert.strictEqual(isLanguageSupported(null), false);
    assert.strictEqual(isLanguageSupported(undefined), false);
  });

  // Test 3: Language Details Lookup
  await test('getLanguageDetails retrieves metadata for valid languages and returns null for invalid', () => {
    const spaDetails = getLanguageDetails('spa');
    assert(spaDetails !== null);
    assert.strictEqual(spaDetails.name, 'Spanish');
    assert.strictEqual(spaDetails.nativeName, 'Español');

    const urdDetails = getLanguageDetails('urd');
    assert(urdDetails !== null);
    assert.strictEqual(urdDetails.name, 'Urdu');
    assert.strictEqual(urdDetails.nativeName, 'اردو');
    assert.strictEqual(urdDetails.isRtl, true);

    assert.strictEqual(getLanguageDetails('nonexistent'), null);
    assert.strictEqual(getLanguageDetails(null), null);
  });

  // Test 4: Cache Key Normalization
  await test('getPackCacheKey returns deterministic URL key for cache indexing', () => {
    const keySpa = getPackCacheKey('spa');
    assert.strictEqual(keySpa, 'https://orvix.local/ocr-packs/spa.traineddata.gz');

    const keyFra = getPackCacheKey(' FRA ');
    assert.strictEqual(keyFra, 'https://orvix.local/ocr-packs/fra.traineddata.gz');
  });

  // Test 5: Buffer Integrity Verification
  await test('validateLanguagePackBuffer rejects null, truncated buffers, and HTML error pages', () => {
    assert.strictEqual(validateLanguagePackBuffer(null), false);
    assert.strictEqual(validateLanguagePackBuffer(undefined), false);

    // Buffer below MIN_VALID_PACK_SIZE (50 KB)
    const tinyBuffer = new Uint8Array(1024);
    assert.strictEqual(validateLanguagePackBuffer(tinyBuffer), false);

    // Buffer that is large enough but contains HTML error response
    const htmlBytes = new Uint8Array(MIN_VALID_PACK_SIZE + 100);
    const htmlHeader = Buffer.from('<!DOCTYPE html><html><head><title>404 Not Found</title></head></html>');
    htmlBytes.set(htmlHeader, 0);
    assert.strictEqual(validateLanguagePackBuffer(htmlBytes), false);

    // Valid binary buffer
    const validBinaryBytes = new Uint8Array(MIN_VALID_PACK_SIZE + 5000);
    validBinaryBytes[0] = 0x1f; // gzip header
    validBinaryBytes[1] = 0x8b;
    assert.strictEqual(validateLanguagePackBuffer(validBinaryBytes), true);
  });

  // Test 6: Built-in English is Always Cached
  await test('English pack is built-in and always reports as cached', async () => {
    const isCached = await isLanguagePackCached('eng');
    assert.strictEqual(isCached, true, 'English must always be considered cached locally');
  });

  // Test 7: Non-English packs start as un-cached
  await test('Non-English packs start as un-cached before user download', async () => {
    resetOcrCacheForTesting();
    assert.strictEqual(await isLanguagePackCached('spa'), false);
    assert.strictEqual(await isLanguagePackCached('fra'), false);
    assert.strictEqual(await isLanguagePackCached('deu'), false);
    assert.strictEqual(await isLanguagePackCached('ara'), false);
    assert.strictEqual(await isLanguagePackCached('urd'), false);
  });

  // Test 8: On-demand download with progress tracking and caching
  await test('downloadLanguagePack downloads pack, invokes progress callbacks, and caches locally', async () => {
    resetOcrCacheForTesting();

    // Mock fetch for deterministic testing
    const originalFetch = globalThis.fetch;
    const mockTrainedDataSize = MIN_VALID_PACK_SIZE + 20000;
    const fakePack = new Uint8Array(mockTrainedDataSize);
    fakePack[0] = 0x1f;
    fakePack[1] = 0x8b;

    let fetchCalled = 0;
    globalThis.fetch = async (url) => {
      fetchCalled++;
      return {
        ok: true,
        status: 200,
        headers: new Map([['Content-Length', String(mockTrainedDataSize)]]),
        arrayBuffer: async () => fakePack.buffer
      };
    };

    try {
      const progressEvents = [];
      const result = await downloadLanguagePack('spa', {
        onProgress: (p) => progressEvents.push(p)
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.code, 'spa');
      assert.strictEqual(result.cached, true);
      assert.strictEqual(result.size, mockTrainedDataSize);
      assert.strictEqual(fetchCalled, 1, 'Should make 1 fetch call');
      assert(progressEvents.length > 0, 'Must invoke onProgress callback');

      const lastProgress = progressEvents[progressEvents.length - 1];
      assert.strictEqual(lastProgress.percent, 100);

      // Verify now cached
      const isNowCached = await isLanguagePackCached('spa');
      assert.strictEqual(isNowCached, true, 'Spanish pack must now be cached');

      const cachedBuffer = await getCachedLanguagePack('spa');
      assert(cachedBuffer !== null);
      assert.strictEqual(cachedBuffer.byteLength, mockTrainedDataSize);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 9: In-Flight Download Deduplication
  await test('Concurrent calls to downloadLanguagePack share the same in-flight promise', async () => {
    resetOcrCacheForTesting();

    const originalFetch = globalThis.fetch;
    const mockSize = MIN_VALID_PACK_SIZE + 10000;
    const fakePack = new Uint8Array(mockSize);
    fakePack[0] = 0x1f;
    fakePack[1] = 0x8b;

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      // Simulate network delay
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        headers: new Map([['Content-Length', String(mockSize)]]),
        arrayBuffer: async () => fakePack.buffer
      };
    };

    try {
      // Trigger 3 concurrent requests simultaneously for 'fra'
      const [res1, res2, res3] = await Promise.all([
        downloadLanguagePack('fra'),
        downloadLanguagePack('fra'),
        downloadLanguagePack('fra')
      ]);

      assert.strictEqual(res1.code, 'fra');
      assert.strictEqual(res2.code, 'fra');
      assert.strictEqual(res3.code, 'fra');
      assert.strictEqual(fetchCount, 1, 'Deduplication must result in strictly 1 fetch call');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 10: Offline Reuse
  await test('Subsequent downloadLanguagePack calls for cached pack return immediately without network fetch', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('Network should not be called when cached!');
    };

    try {
      // 'fra' was cached in previous test
      const result = await downloadLanguagePack('fra');
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.cached, true);
      assert.strictEqual(fetchCalled, false, 'Offline reuse must not hit the network');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 11: Corrupt Pack Eviction
  await test('Corrupt/truncated cached pack is detected, evicted, and returns false from isLanguagePackCached', async () => {
    resetOcrCacheForTesting();

    const originalFetch = globalThis.fetch;
    const corruptSmallBuffer = new Uint8Array(1024); // Too small!

    globalThis.fetch = async () => {
      return {
        ok: true,
        status: 200,
        headers: new Map([['Content-Length', '1024']]),
        arrayBuffer: async () => corruptSmallBuffer.buffer
      };
    };

    try {
      let threw = false;
      try {
        await downloadLanguagePack('deu');
      } catch (err) {
        threw = true;
        assert(err.message.includes('integrity verification') || err.message.includes('failed'));
      }
      assert.strictEqual(threw, true, 'Must reject corrupt/small download');
      assert.strictEqual(await isLanguagePackCached('deu'), false, 'Must not mark corrupt pack as cached');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 12: Unsupported Language Error Handling
  await test('downloadLanguagePack rejects unsupported language codes with UNSUPPORTED_LANGUAGE error', async () => {
    let err = null;
    try {
      await downloadLanguagePack('jpn');
    } catch (e) {
      err = e;
    }
    assert(err !== null);
    assert.strictEqual(err.code, 'UNSUPPORTED_LANGUAGE');
    assert(err.message.includes('not supported'));
  });

  // Test 13: Cache Eviction and Listing
  await test('deleteCachedLanguagePack and clearLanguagePackCache correctly manage pack lifecycle', async () => {
    resetOcrCacheForTesting();

    // Cache spa and ara
    const mockSize = MIN_VALID_PACK_SIZE + 10000;
    const fakePack = new Uint8Array(mockSize);
    fakePack[0] = 0x1f;
    fakePack[1] = 0x8b;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['Content-Length', String(mockSize)]]),
      arrayBuffer: async () => fakePack.buffer
    });

    try {
      await downloadLanguagePack('spa');
      await downloadLanguagePack('ara');

      let cachedList = await listCachedLanguagePacks();
      let cachedCodes = cachedList.map((l) => l.code);
      assert(cachedCodes.includes('eng'), 'English must be in list');
      assert(cachedCodes.includes('spa'), 'Spanish must be in list');
      assert(cachedCodes.includes('ara'), 'Arabic must be in list');

      // Delete Spanish
      const deletedSpa = await deleteCachedLanguagePack('spa');
      assert.strictEqual(deletedSpa, true);
      assert.strictEqual(await isLanguagePackCached('spa'), false);
      assert.strictEqual(await isLanguagePackCached('ara'), true);

      // Clear all
      const clearedCount = await clearLanguagePackCache();
      assert.strictEqual(clearedCount, 1, 'Should clear the 1 remaining non-English pack (ara)');
      assert.strictEqual(await isLanguagePackCached('ara'), false);
      assert.strictEqual(await isLanguagePackCached('eng'), true, 'English is built-in and never cleared');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 14: Server-Side uploadSubsystem Multilingual OCR Routing Inspection
  await test('server/uploadSubsystem.ts defines /api/ocr/packs/:file route and ?lang= query extraction', () => {
    const uploadSubsystemCode = fs.readFileSync(path.resolve('server/uploadSubsystem.ts'), 'utf-8');

    assert(uploadSubsystemCode.includes('/api/ocr/packs/:file'), 'Must register /api/ocr/packs/:file route');
    assert(uploadSubsystemCode.includes('INVALID_PACK_NAME'), 'Must validate pack filename');
    assert(uploadSubsystemCode.includes('UNSUPPORTED_LANGUAGE'), 'Must check supported language codes');
    assert(uploadSubsystemCode.includes('extractionsByLang'), 'Must support per-language extraction cache in records');
    assert(uploadSubsystemCode.includes('req.query.lang'), 'Must parse ?lang query parameter');
  });

  // Test 15: DocumentPreviewModal Multilingual OCR UI Inspection
  await test('DocumentPreviewModal.jsx incorporates language selector, download card, progress, and RTL', () => {
    const modalCode = fs.readFileSync(path.resolve('src/components/chat/DocumentPreviewModal.jsx'), 'utf-8');

    assert(modalCode.includes('selectedOcrLang'), 'Must maintain selectedOcrLang state');
    assert(modalCode.includes('cachedLangs'), 'Must track cachedLangs');
    assert(modalCode.includes('preview-ocr-toolbar'), 'Must render preview-ocr-toolbar');
    assert(modalCode.includes('preview-ocr-lang-select'), 'Must render language select dropdown');
    assert(modalCode.includes('preview-ocr-pack-card'), 'Must render on-demand pack download card');
    assert(modalCode.includes('preview-ocr-progress-bar'), 'Must render download progress bar');
    assert(modalCode.includes('preview-text-rtl'), 'Must include RTL text styling class for Arabic and Urdu');
    assert(modalCode.includes('dir={currentLangDetails.isRtl'), 'Must set dir="rtl" for Arabic and Urdu');
    assert(modalCode.includes('handleCancelDownload'), 'Must support download cancellation');
  });

  // Test 16: detectReadableText Multilingual Script Support
  await test('detectReadableText in imageOcrService accurately recognizes Arabic and Urdu text', async () => {
    const { detectReadableText } = await import('../src/services/imageOcrService.js');

    // Arabic greeting: مرحبا بالعالم
    const arabicText = 'مرحبا بالعالم';
    assert.strictEqual(detectReadableText(arabicText), true, 'Must detect readable Arabic text');

    // Urdu greeting: خوش آمدید
    const urduText = 'خوش آمدید';
    assert.strictEqual(detectReadableText(urduText), true, 'Must detect readable Urdu text');

    // Spanish with accents: ¡Hola! ¿Cómo estás?
    const spanishText = '¡Hola! ¿Cómo estás?';
    assert.strictEqual(detectReadableText(spanishText), true, 'Must detect readable Spanish text');

    // German with umlauts: Schöne Grüße aus München
    const germanText = 'Schöne Grüße aus München';
    assert.strictEqual(detectReadableText(germanText), true, 'Must detect readable German text');

    // Blank or non-text noise
    assert.strictEqual(detectReadableText('   '), false);
    assert.strictEqual(detectReadableText('...---...'), false);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal suite failure:', err);
  process.exit(1);
});
