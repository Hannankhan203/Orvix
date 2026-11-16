import test from 'node:test';
import assert from 'node:assert/strict';
import { prebuiltAppConfig, WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
import { WEBLLM_MODEL_CATALOG } from '../src/services/webllmService.js';
import {
  PREBUILT_WEBLLM_MODEL_RECORDS,
  findPrebuiltWebLLMRecord,
  hasPrebuiltModelInCache,
  deletePrebuiltModelFromCache,
  CreateWebWorkerMLCEngine
} from '../src/services/webllmWorkerClient.js';
import { extractBrowserDocument } from '../src/services/browserDocumentExtractor.js';

function setGlobalProp(name: string, value: any) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, name);
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true
  });
  return () => {
    if (hadOwn && prevDesc) {
      Object.defineProperty(globalThis, name, prevDesc);
    } else {
      delete (globalThis as any)[name];
    }
  };
}

test('WebLLM catalog parity: PREBUILT_WEBLLM_MODEL_RECORDS matches @mlc-ai/web-llm@0.2.86 prebuiltAppConfig', () => {
  const catalogIds = Object.keys(WEBLLM_MODEL_CATALOG);
  assert.ok(catalogIds.length >= 8);
  assert.equal(PREBUILT_WEBLLM_MODEL_RECORDS.length, catalogIds.length);

  for (const modelId of catalogIds) {
    const localRec = findPrebuiltWebLLMRecord(modelId);
    const pkgRec = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
    assert.ok(localRec, `Missing local prebuilt record for ${modelId}`);
    assert.ok(pkgRec, `Missing package prebuilt record for ${modelId}`);
    assert.equal(localRec.model, pkgRec.model);
    assert.equal(localRec.model_lib, pkgRec.model_lib);
  }
});

test('WebLLM worker RPC bridge matches WebWorkerMLCEngineHandler protocol for reload, streaming, interrupt, resetChat, and unload', async () => {
  const handler = new WebWorkerMLCEngineHandler();
  const progressEvents: any[] = [];
  const calls: string[] = [];

  // Patch handler.engine with deterministic stub while preserving genuine WebWorkerMLCEngineHandler message serialization/dispatch
  let initCb: any = null;
  handler.engine = {
    setInitProgressCallback: (cb: any) => {
      initCb = cb;
    },
    setLogLevel: () => {
      calls.push('setLogLevel');
    },
    reload: async (modelId: any, chatOpts: any) => {
      calls.push(`reload:${JSON.stringify(modelId)}:${JSON.stringify(chatOpts)}`);
      initCb?.({ progress: 0.5, text: 'Loading shards', timeElapsed: 1 });
      initCb?.({ progress: 1, text: 'Finish loading', timeElapsed: 2 });
    },
    chatCompletion: async (request: any) => {
      calls.push(`chatCompletion:${Boolean(request.stream)}`);
      if (!request.stream) {
        return {
          id: 'cmpl-nonstream',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Non-streaming reply' } }]
        };
      }
      async function* streamGen() {
        yield { choices: [{ delta: { content: 'Chunk 1 ' } }] };
        yield { choices: [{ delta: { content: 'Chunk 2' } }] };
      }
      return streamGen();
    },
    forwardTokensAndSample: async (inputIds: number[], isPrefill: boolean) => {
      calls.push(`forward:${inputIds.length}:${isPrefill}`);
      return 42;
    },
    resetChat: async (keepStats: boolean) => {
      calls.push(`resetChat:${keepStats}`);
    },
    interruptGenerate: () => {
      calls.push('interruptGenerate');
    },
    unload: async () => {
      calls.push('unload');
    }
  } as any;

  // Wire WebWorkerMLCEngineHandler's init callback just like its constructor did
  (handler.engine as any).setInitProgressCallback((report: any) => {
    handler.postMessage({ kind: 'initProgressCallback', uuid: '', content: report });
  });

  const mockWorker: any = {
    onmessage: null,
    postMessage: (msg: any) => {
      queueMicrotask(() => {
        handler.onmessage(msg);
      });
    }
  };
  handler.postMessage = (reply: any) => {
    queueMicrotask(() => {
      mockWorker.onmessage?.({ data: reply });
    });
  };

  const engine = await CreateWebWorkerMLCEngine(
    mockWorker,
    'SmolLM2-135M-Instruct-q0f16-MLC',
    {
      logLevel: 'WARN',
      initProgressCallback: (report: any) => progressEvents.push(report)
    },
    { context_window_size: 4096 }
  );

  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[1].progress, 1);

  const nonStream = await engine.chat.completions.create({
    messages: [{ role: 'user', content: 'hi' }],
    stream: false
  });
  assert.equal(nonStream.choices[0].message.content, 'Non-streaming reply');

  const stream = await engine.chat.completions.create({
    messages: [{ role: 'user', content: 'hi stream' }],
    stream: true
  });
  let accumulated = '';
  for await (const chunk of stream) {
    accumulated += chunk?.choices?.[0]?.delta?.content || '';
  }
  assert.equal(accumulated, 'Chunk 1 Chunk 2');

  const nextToken = await engine.forwardTokensAndSample([1, 2], true);
  assert.equal(nextToken, 42);
  await engine.resetChat(false);
  engine.interruptGenerate();
  await engine.unload();

  assert.ok(calls.includes('setLogLevel'));
  assert.ok(calls.some((c) => c.startsWith('reload:')));
  assert.ok(calls.includes('resetChat:false'));
  assert.ok(calls.includes('interruptGenerate'));
  assert.ok(calls.includes('unload'));
});

test('WebLLM direct Cache Storage inspection and cleanup work accurately without main-thread runtime', async () => {
  const scopes = new Map<string, Map<string, any>>();
  const getScope = (name: string) => {
    if (!scopes.has(name)) scopes.set(name, new Map());
    return scopes.get(name)!;
  };

  const restoreCaches = setGlobalProp('caches', {
    open: async (name: string) => {
      const store = getScope(name);
      return {
        match: async (req: Request | string) => {
          const url = typeof req === 'string' ? req : req.url;
          return store.get(url);
        },
        put: async (req: Request | string, res: any) => {
          const url = typeof req === 'string' ? req : req.url;
          store.set(url, res);
        },
        delete: async (req: Request | string) => {
          const url = typeof req === 'string' ? req : req.url;
          return store.delete(url);
        }
      };
    }
  });

  try {
    const modelId = 'SmolLM2-135M-Instruct-q0f16-MLC';
    const rec = findPrebuiltWebLLMRecord(modelId)!;
    const baseUrl = `${rec.model}/resolve/main/`;
    const modelStore = getScope('webllm/model');
    const configStore = getScope('webllm/config');
    const wasmStore = getScope('webllm/wasm');

    // Empty cache -> false
    assert.equal(await hasPrebuiltModelInCache(modelId), false);

    // Partial shard cache (shard_0 present, shard_1 missing) -> false
    modelStore.set(`${baseUrl}tensor-cache.json`, {
      json: async () => ({
        records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }]
      })
    });
    modelStore.set(`${baseUrl}params_shard_0.bin`, { ok: true });
    assert.equal(await hasPrebuiltModelInCache(modelId), false);

    // All shards + tokenizer + config + wasm present -> true
    modelStore.set(`${baseUrl}params_shard_1.bin`, { ok: true });
    modelStore.set(`${baseUrl}tokenizer.json`, { ok: true });
    configStore.set(`${baseUrl}mlc-chat-config.json`, { ok: true });
    wasmStore.set(rec.model_lib, { ok: true });
    assert.equal(await hasPrebuiltModelInCache(modelId), true);

    // Deletion clears all scopes
    await deletePrebuiltModelFromCache(modelId);
    assert.equal(await hasPrebuiltModelInCache(modelId), false);
    assert.equal(modelStore.has(`${baseUrl}params_shard_0.bin`), false);
    assert.equal(modelStore.has(`${baseUrl}tokenizer.json`), false);
    assert.equal(configStore.has(`${baseUrl}mlc-chat-config.json`), false);
    assert.equal(wasmStore.has(rec.model_lib), false);
  } finally {
    restoreCaches();
  }
});

test('Browser PDF extraction preserves extracted text and worker-fallback behavior cleanly', async () => {
  const pdfStr = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 49 >> stream
BT /F1 12 Tf 10 100 Td (Orvix PDF Worker Test) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000339 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
407
%%EOF`;

  const bytes = new TextEncoder().encode(pdfStr);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const result = (await extractBrowserDocument(blob, {
    id: 'pdf-opt-test',
    name: 'sample.pdf',
    originalName: 'sample.pdf',
    mimeType: 'application/pdf'
  })) as any;

  assert.equal(result.success, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.pageCount, 1);
  assert.ok(result.text.includes('Orvix PDF Worker Test'));
});
