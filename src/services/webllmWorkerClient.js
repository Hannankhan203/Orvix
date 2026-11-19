/**
 * Lightweight Main-Thread Client & Cache Helpers for @mlc-ai/web-llm@0.2.86 Web Worker Protocol.
 *
 * Eliminates duplicating the 6.14 MB @mlc-ai/web-llm runtime + embedded TVM/tokenizer WASMs
 * on the main UI thread. Only the dedicated Web Worker (src/workers/webllmWorker.js) loads
 * @mlc-ai/web-llm when Browser AI is actually started.
 *
 * Protocol and ModelRecord metadata verified directly against @mlc-ai/web-llm@0.2.86:
 * - Message envelopes: { kind, uuid, content }
 * - Incoming kinds: "initProgressCallback", "return", "throw"
 * - Outgoing kinds: "reload", "unload", "resetChat", "interruptGenerate",
 *   "forwardTokensAndSample", "setAppConfig", "setLogLevel", "getMaxStorageBufferBindingSize",
 *   "getGPUVendor", "getMessage", "runtimeStatsText", "chatCompletionNonStreaming",
 *   "chatCompletionStreamInit", "completionStreamNextChunk", "completionStreamReturn",
 *   "completionNonStreaming", "completionStreamInit", "embedding"
 */

export const PREBUILT_WEBLLM_MODEL_RECORDS = Object.freeze([
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f16-MLC',
    model_id: 'SmolLM2-135M-Instruct-q0f16-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/SmolLM2-135M-Instruct-q0f16_cs1k-webgpu.wasm',
    vram_required_MB: 359.69,
    low_resource_required: true,
    required_features: ['shader-f16'],
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/SmolLM2-135M-Instruct-q0f32-MLC',
    model_id: 'SmolLM2-135M-Instruct-q0f32-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/SmolLM2-135M-Instruct-q0f32_cs1k-webgpu.wasm',
    vram_required_MB: 719.38,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f16_1-MLC',
    model_id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm',
    vram_required_MB: 376.06,
    low_resource_required: true,
    required_features: ['shader-f16'],
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f32_1-MLC',
    model_id: 'SmolLM2-360M-Instruct-q4f32_1-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/SmolLM2-360M-Instruct-q4f32_1_cs1k-webgpu.wasm',
    vram_required_MB: 579.61,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC',
    model_id: 'Qwen3-0.6B-q4f16_1-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/Qwen3-0.6B-q4f16_1_cs1k-webgpu.wasm',
    vram_required_MB: 1403.34,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f32_1-MLC',
    model_id: 'Qwen3-0.6B-q4f32_1-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/Qwen3-0.6B-q4f32_1_cs1k-webgpu.wasm',
    vram_required_MB: 1924.98,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    model_id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    vram_required_MB: 1629.75,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  }),
  Object.freeze({
    model: 'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    model_id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    model_lib:
      'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm',
    vram_required_MB: 1888.97,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  })
]);

/** @type {Map<string, any>} */
const PREBUILT_MODEL_MAP = new Map(PREBUILT_WEBLLM_MODEL_RECORDS.map((r) => [r.model_id, r]));

/**
 * @param {any} modelId
 */
export function findPrebuiltWebLLMRecord(modelId) {
  if (!modelId) return null;
  return PREBUILT_MODEL_MAP.get(String(modelId).trim()) || null;
}

/**
 * @param {any} rawModelUrl
 */
function defaultNormalizeModelUrl(rawModelUrl) {
  let url = String(rawModelUrl || '');
  if (!url.endsWith('/')) {
    url += '/';
  }
  if (!/.+\/resolve\/.+\//.test(url)) {
    url += 'resolve/main/';
  }
  return new URL(url).href;
}

/**
 * Checks whether all tensor shards indexed in tensor-cache.json exist in 'webllm/model'
 * using direct Cache Storage lookup (avoiding loading @mlc-ai/web-llm's 6.14 MB JS/WASM bundle
 * and working cleanly with mock caches that only implement match/put/delete).
 * @param {any} modelId
 * @param {any} [normalizeBaseUrl]
 */
export async function hasPrebuiltModelInCache(modelId, normalizeBaseUrl = defaultNormalizeModelUrl) {
  if (typeof caches === 'undefined') {
    return false;
  }
  const record = findPrebuiltWebLLMRecord(modelId);
  if (!record) {
    return false;
  }

  const modelBaseUrl = normalizeBaseUrl(record.model);
  const tensorCacheUrl = new URL('tensor-cache.json', modelBaseUrl).href;
  const modelCache = await caches.open('webllm/model');
  const tensorIndexMatch = await modelCache.match(new Request(tensorCacheUrl));
  if (!tensorIndexMatch) {
    return false;
  }

  let tensorIndex;
  try {
    tensorIndex = typeof tensorIndexMatch.clone === 'function'
      ? await tensorIndexMatch.clone().json()
      : await tensorIndexMatch.json();
  } catch (_) {
    return false;
  }

  const records = tensorIndex?.records;
  if (!Array.isArray(records) || records.length === 0) {
    return false;
  }

  const shardUrls = records
    .map((/** @type {any} */ entry) => entry?.dataPath)
    .filter(Boolean)
    .map((/** @type {any} */ dataPath) => new URL(dataPath, modelBaseUrl).href);

  if (shardUrls.length === 0) {
    return false;
  }

  const shardMatches = await Promise.all(
    shardUrls.map((shardUrl) => modelCache.match(new Request(shardUrl)))
  );
  return shardMatches.every(Boolean);
}

/**
 * Removes cached tensor shards, tokenizers, chat config, and compiled WASM library for a model
 * directly from WebLLM's Cache Storage scopes ('webllm/model', 'webllm/config', 'webllm/wasm').
 * @param {any} modelId
 * @param {any} [normalizeBaseUrl]
 */
export async function deletePrebuiltModelFromCache(modelId, normalizeBaseUrl = defaultNormalizeModelUrl) {
  if (typeof caches === 'undefined') {
    return;
  }
  const record = findPrebuiltWebLLMRecord(modelId);
  if (!record) {
    return;
  }

  const modelBaseUrl = normalizeBaseUrl(record.model);
  const [modelCache, configCache, wasmCache] = await Promise.all([
    caches.open('webllm/model'),
    caches.open('webllm/config'),
    caches.open('webllm/wasm')
  ]);

  const tensorCacheUrl = new URL('tensor-cache.json', modelBaseUrl).href;
  try {
    const tensorIndexMatch = await modelCache.match(new Request(tensorCacheUrl));
    if (tensorIndexMatch) {
      const tensorIndex = typeof tensorIndexMatch.clone === 'function'
        ? await tensorIndexMatch.clone().json()
        : await tensorIndexMatch.json();
      const records = Array.isArray(tensorIndex?.records) ? tensorIndex.records : [];
      await Promise.all(
        records
          .map((/** @type {any} */ entry) => entry?.dataPath)
          .filter(Boolean)
          .map((/** @type {any} */ dataPath) => modelCache.delete(new URL(dataPath, modelBaseUrl).href))
      );
    }
  } catch (_) {
    // Best-effort shard cleanup even if tensor-cache.json was corrupted
  }

  await Promise.all([
    modelCache.delete(tensorCacheUrl),
    modelCache.delete(new URL('tokenizer.model', modelBaseUrl).href),
    modelCache.delete(new URL('tokenizer.json', modelBaseUrl).href),
    configCache.delete(new URL('mlc-chat-config.json', modelBaseUrl).href),
    ...(record.model_lib ? [wasmCache.delete(record.model_lib)] : [])
  ]);
}

function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {any} loadedModelIds
 * @param {any} requestModel
 * @param {any} requestName
 */
function resolveModelIdForRequest(loadedModelIds, requestModel, requestName) {
  if (!Array.isArray(loadedModelIds) || loadedModelIds.length === 0) {
    const err = new Error(`Model not loaded before calling ${requestName}.`);
    err.name = 'ModelNotLoadedError';
    throw err;
  }
  if (requestModel) {
    if (loadedModelIds.indexOf(requestModel) === -1) {
      const err = new Error(
        `Specified model "${requestModel}" for ${requestName} is not among loaded models: ${loadedModelIds.join(', ')}.`
      );
      err.name = 'SpecifiedModelNotFoundError';
      throw err;
    }
    return requestModel;
  }
  if (loadedModelIds.length > 1) {
    const err = new Error(
      `Multiple models are loaded (${loadedModelIds.join(', ')}); please specify model in ${requestName}.`
    );
    err.name = 'UnclearModelToUseError';
    throw err;
  }
  return loadedModelIds[0];
}

/**
 * Main-thread RPC proxy implementing WebWorkerMLCEngine's exact postMessage contract
 * against WebWorkerMLCEngineHandler in src/workers/webllmWorker.js.
 */
export class WebWorkerMLCEngine {
  /**
   * @param {any} worker
   * @param {any} [engineConfig]
   */
  constructor(worker, engineConfig) {
    this.pendingPromise = new Map();
    this.worker = worker;
    /** @type {any} */
    this.modelId = undefined;
    /** @type {any} */
    this.chatOpts = undefined;

    worker.onmessage = (/** @type {any} */ event) => {
      this.onmessage(event);
    };

    if (engineConfig?.appConfig) {
      this.setAppConfig(engineConfig.appConfig);
    }
    if (engineConfig?.logLevel) {
      this.setLogLevel(engineConfig.logLevel);
    }
    this.setInitProgressCallback(engineConfig?.initProgressCallback);

    this.chat = {
      completions: {
        create: (/** @type {any} */ request) => this.chatCompletion(request)
      }
    };
    this.completions = {
      create: (/** @type {any} */ request) => this.completion(request)
    };
    this.embeddings = {
      create: (/** @type {any} */ request) => this.embedding(request)
    };
  }

  /**
   * @param {any} initProgressCallback
   */
  setInitProgressCallback(initProgressCallback) {
    this.initProgressCallback = initProgressCallback;
  }

  getInitProgressCallback() {
    return this.initProgressCallback;
  }

  /**
   * @param {any} appConfig
   */
  setAppConfig(appConfig) {
    this.worker.postMessage({
      kind: 'setAppConfig',
      uuid: generateUuid(),
      content: appConfig
    });
  }

  /**
   * @param {any} logLevel
   */
  setLogLevel(logLevel) {
    this.worker.postMessage({
      kind: 'setLogLevel',
      uuid: generateUuid(),
      content: logLevel
    });
  }

  /**
   * @param {any} msg
   */
  getPromise(msg) {
    const uuid = msg.uuid;
    const promise = new Promise((resolve, reject) => {
      this.pendingPromise.set(uuid, (/** @type {any} */ reply) => {
        if (reply.kind === 'return') {
          resolve(reply.content);
        } else if (reply.kind === 'throw') {
          reject(reply.content);
        } else {
          reject(`Unknown msg kind ${reply.kind}`);
        }
      });
    });
    this.worker.postMessage(msg);
    return promise;
  }

  /**
   * @param {any} modelId
   * @param {any} [chatOpts]
   */
  async reload(modelId, chatOpts) {
    const modelIds = Array.isArray(modelId) ? modelId : [modelId];
    const normalizedChatOpts =
      chatOpts !== undefined && !Array.isArray(chatOpts) ? [chatOpts] : chatOpts;

    await this.getPromise({
      kind: 'reload',
      uuid: generateUuid(),
      content: {
        modelId: modelIds,
        chatOpts: normalizedChatOpts
      }
    });
    this.modelId = modelIds;
    this.chatOpts = normalizedChatOpts;
  }

  async getMaxStorageBufferBindingSize() {
    return await this.getPromise({
      kind: 'getMaxStorageBufferBindingSize',
      uuid: generateUuid(),
      content: null
    });
  }

  async getGPUVendor() {
    return await this.getPromise({
      kind: 'getGPUVendor',
      uuid: generateUuid(),
      content: null
    });
  }

  /**
   * @param {any} [modelId]
   */
  async getMessage(modelId) {
    return await this.getPromise({
      kind: 'getMessage',
      uuid: generateUuid(),
      content: { modelId }
    });
  }

  /**
   * @param {any} [modelId]
   */
  async runtimeStatsText(modelId) {
    return await this.getPromise({
      kind: 'runtimeStatsText',
      uuid: generateUuid(),
      content: { modelId }
    });
  }

  interruptGenerate() {
    void this.getPromise({
      kind: 'interruptGenerate',
      uuid: generateUuid(),
      content: null
    }).catch(() => {});
  }

  async unload() {
    await this.getPromise({
      kind: 'unload',
      uuid: generateUuid(),
      content: null
    });
    this.modelId = undefined;
    this.chatOpts = undefined;
  }

  /**
   * @param {boolean} [keepStats=false]
   * @param {any} [modelId]
   */
  async resetChat(keepStats = false, modelId) {
    await this.getPromise({
      kind: 'resetChat',
      uuid: generateUuid(),
      content: {
        keepStats,
        modelId
      }
    });
  }

  /**
   * @param {any} inputIds
   * @param {any} isPrefill
   * @param {any} [modelId]
   */
  async forwardTokensAndSample(inputIds, isPrefill, modelId) {
    return await this.getPromise({
      kind: 'forwardTokensAndSample',
      uuid: generateUuid(),
      content: {
        inputIds,
        isPrefill,
        modelId
      }
    });
  }

  /**
   * @param {any} streamId
   */
  asyncGenerate(streamId) {
    let completed = false;
    /** @type {any} */
    let closePromise;
    const getPromise = this.getPromise.bind(this);

    const close = () => {
      if (!closePromise) {
        closePromise = (async () => {
          if (completed) return;
          completed = true;
          await getPromise({
            kind: 'completionStreamReturn',
            uuid: generateUuid(),
            content: { streamId }
          });
        })();
      }
      return closePromise;
    };

    const iterator = (async function* () {
      try {
        while (true) {
          const ret = await getPromise({
            kind: 'completionStreamNextChunk',
            uuid: generateUuid(),
            content: { streamId }
          });
          if (typeof ret !== 'object' || ret === null) {
            completed = true;
            return;
          }
          yield ret;
        }
      } finally {
        await close();
      }
    })();

    const returnSource = iterator.return.bind(iterator);
    const throwSource = iterator.throw.bind(iterator);
    iterator.return = (value) => returnSource(value).finally(close);
    iterator.throw = (err) => throwSource(err).finally(close);
    return iterator;
  }

  /**
   * @param {any} request
   */
  async chatCompletion(request) {
    if (this.modelId === undefined) {
      const err = new Error(`${this.constructor.name}: model not loaded.`);
      err.name = 'WorkerEngineModelNotLoadedError';
      throw err;
    }
    const selectedModelId = resolveModelIdForRequest(
      this.modelId || [],
      request.model,
      'ChatCompletionRequest'
    );
    if (request.stream) {
      const streamId = generateUuid();
      await this.getPromise({
        kind: 'chatCompletionStreamInit',
        uuid: generateUuid(),
        content: {
          request,
          selectedModelId,
          streamId,
          modelId: this.modelId,
          chatOpts: this.chatOpts
        }
      });
      return this.asyncGenerate(streamId);
    }
    return await this.getPromise({
      kind: 'chatCompletionNonStreaming',
      uuid: generateUuid(),
      content: {
        request,
        modelId: this.modelId,
        chatOpts: this.chatOpts
      }
    });
  }

  /**
   * @param {any} request
   */
  async completion(request) {
    if (this.modelId === undefined) {
      const err = new Error(`${this.constructor.name}: model not loaded.`);
      err.name = 'WorkerEngineModelNotLoadedError';
      throw err;
    }
    const selectedModelId = resolveModelIdForRequest(
      this.modelId || [],
      request.model,
      'CompletionCreateParams'
    );
    if (request.stream) {
      const streamId = generateUuid();
      await this.getPromise({
        kind: 'completionStreamInit',
        uuid: generateUuid(),
        content: {
          request,
          selectedModelId,
          streamId,
          modelId: this.modelId,
          chatOpts: this.chatOpts
        }
      });
      return this.asyncGenerate(streamId);
    }
    return await this.getPromise({
      kind: 'completionNonStreaming',
      uuid: generateUuid(),
      content: {
        request,
        modelId: this.modelId,
        chatOpts: this.chatOpts
      }
    });
  }

  /**
   * @param {any} request
   */
  async embedding(request) {
    if (this.modelId === undefined) {
      const err = new Error(`${this.constructor.name}: model not loaded.`);
      err.name = 'WorkerEngineModelNotLoadedError';
      throw err;
    }
    return await this.getPromise({
      kind: 'embedding',
      uuid: generateUuid(),
      content: {
        request,
        modelId: this.modelId,
        chatOpts: this.chatOpts
      }
    });
  }

  async listResumableSessions() {
    return await this.getPromise({
      kind: 'listResumableSessions',
      uuid: generateUuid(),
      content: null
    });
  }

  /**
   * @param {any} sessionId
   * @param {any} [options]
   */
  async resumeChatCompletion(sessionId, options) {
    if (options?.continueGeneration === true && options?.stream === true) {
      const streamId = generateUuid();
      const result = await this.getPromise({
        kind: 'resumeChatCompletionStreamInit',
        uuid: generateUuid(),
        content: { sessionId, options, streamId }
      });
      if (result !== null) {
        return result;
      }
      return this.asyncGenerate(streamId);
    }
    return await this.getPromise({
      kind: 'resumeChatCompletion',
      uuid: generateUuid(),
      content: { sessionId, options }
    });
  }

  /**
   * @param {any} sessionId
   */
  async deleteResumableSession(sessionId) {
    await this.getPromise({
      kind: 'deleteResumableSession',
      uuid: generateUuid(),
      content: { sessionId }
    });
  }

  /**
   * @param {any} event
   */
  onmessage(event) {
    const msg =
      (typeof MessageEvent !== 'undefined' && event instanceof MessageEvent) ||
      (event && typeof event === 'object' && typeof event.kind !== 'string' && 'data' in event)
        ? event.data
        : event;
    if (!msg || typeof msg.kind !== 'string') {
      return;
    }
    switch (msg.kind) {
      case 'initProgressCallback': {
        if (typeof this.initProgressCallback === 'function') {
          this.initProgressCallback(msg.content);
        }
        return;
      }
      case 'return':
      case 'throw': {
        const cb = this.pendingPromise.get(msg.uuid);
        if (cb === undefined) {
          throw new Error(`return/throw from an unknown uuid msg=${msg.uuid}`);
        }
        this.pendingPromise.delete(msg.uuid);
        cb(msg);
        return;
      }
      default: {
        const err = new Error(`Unknown message kind "${msg.kind}"`);
        err.name = 'UnknownMessageKindError';
        throw err;
      }
    }
  }
}

/**
 * @param {any} worker
 * @param {any} modelId
 * @param {any} [engineConfig]
 * @param {any} [chatOpts]
 */
export async function CreateWebWorkerMLCEngine(worker, modelId, engineConfig, chatOpts) {
  const engine = new WebWorkerMLCEngine(worker, engineConfig);
  await engine.reload(modelId, chatOpts);
  return engine;
}
