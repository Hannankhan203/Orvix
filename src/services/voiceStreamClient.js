/**
 * Orvix Voice Streaming Client (Phase 6 Prompt 30)
 *
 * Manages bi-directional WebSocket connection and browser-side real-time audio capture
 * using AudioWorklet to stream PCM chunks to the backend and receive incremental transcription.
 */

// Embedded fallback processor script in case network fetch of /audioWorkletProcessor.js is blocked
const INLINE_PROCESSOR_CODE = `
class PcmAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    this.isPaused = false;
    this.port.onmessage = (e) => {
      if (e.data?.command === 'pause') { this.isPaused = true; this.bufferIndex = 0; }
      else if (e.data?.command === 'resume') { this.isPaused = false; this.bufferIndex = 0; }
      else if (e.data?.command === 'reset') { this.bufferIndex = 0; }
    };
  }
  process(inputs) {
    if (this.isPaused) return true;
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];
      if (this.bufferIndex >= this.bufferSize) {
        const pcm16 = new Int16Array(this.bufferSize);
        for (let j = 0; j < this.bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage({ type: 'pcm', buffer: pcm16.buffer }, [pcm16.buffer]);
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-audio-processor', PcmAudioProcessor);
`;

export class VoiceStreamClient {
  constructor(options = {}) {
    this.options = options;
    this.ws = null;
    this.audioContext = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.scriptProcessor = null; // Legacy fallback if AudioWorklet unavailable
    this.state = 'idle'; // 'idle' | 'connecting' | 'ready' | 'listening' | 'paused' | 'stopping' | 'closed'
    this.sessionId = null;
    this.userId = null;
    this.isGuest = false;
    this.authToken = '';
    this.language = options.language || 'en-US';
    this.pendingLanguage = null;
    this.accumulatedTranscript = '';
    this.stopResolve = null;
    this.stopReject = null;
    this.stopTimer = null;
    this.connectTimer = null;

    // Callbacks
    this.onInterim = options.onInterim || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onDone = options.onDone || (() => {});
    this.onError = options.onError || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onConfig = options.onConfig || (() => {});
  }

  setState(newState) {
    this.state = newState;
    this.onStateChange(newState);
  }

  /**
   * Resolves the WebSocket endpoint URL based on window location and options.
   */
  resolveWebSocketUrl(token = '') {
    let url = this.options.url;
    if (!url) {
      const loc = window.location;
      const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      url = `${protocol}//${loc.host}/api/voice-stream`;
    }
    if (token && !/[?&]token=/.test(url)) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}token=${encodeURIComponent(token)}`;
    }
    return url;
  }

  /**
   * Connects to the authenticated WebSocket server.
   *
   * @param {string} [token=''] - Firebase Auth ID token
   * @returns {Promise<VoiceStreamClient>}
   */
  async connect(token = '') {
    const resolvedToken = token || this.authToken || '';
    this.authToken = resolvedToken;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this;
    }

    this.setState('connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      const url = this.resolveWebSocketUrl(resolvedToken);

      // Connection timeout (4s): if server doesn't respond or is on Vercel without WS support, fail fast
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (!settled) {
          settled = true;
          this.setState('closed');
          try {
            if (this.ws) this.ws.close();
          } catch (_) {}
          const timeoutErr = new Error('WebSocket connection timed out.');
          timeoutErr.code = 'WS_TIMEOUT';
          timeoutErr.canFallback = true;
          reject(timeoutErr);
        }
      }, 4000);

      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          if (settled) return;
          if (resolvedToken) {
            ws.send(JSON.stringify({ type: 'auth', token: resolvedToken }));
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'authenticated') {
              this.sessionId = data.sessionId;
              this.userId = data.userId;
              this.isGuest = Boolean(data.isGuest);
              if (typeof data.language === 'string' && data.language) {
                this.language = data.language;
              }
              if (!settled) {
                settled = true;
                clearTimeout(this.connectTimer);
                this.setState('ready');
                resolve(this);
              }
            } else if (data.type === 'ready') {
              if (typeof data.language === 'string' && data.language) {
                this.language = data.language;
              }
              this.setState('listening');
              if (this.startResolve) {
                const resolveFn = this.startResolve;
                this.startResolve = null;
                this.startReject = null;
                resolveFn();
              }
            } else if (data.type === 'config') {
              if (typeof data.language === 'string' && data.language) {
                this.language = data.language;
                if (!this.pendingLanguage || this.pendingLanguage === data.language) {
                  this.pendingLanguage = null;
                }
              }
              this.onConfig(data);
            } else if (data.type === 'status') {
              if (data.status === 'provider_unavailable' || data.code === 'PROVIDER_UNAVAILABLE') {
                const err = new Error(data.error || 'Voice transcription provider is unavailable.');
                err.code = 'PROVIDER_UNAVAILABLE';
                err.canFallback = true;
                err.recoverable = true;
                this.onError(err);
                if (this.startReject) {
                  const rejectFn = this.startReject;
                  this.startResolve = null;
                  this.startReject = null;
                  rejectFn(err);
                }
              }
            } else if (data.type === 'transcription') {
              const text = (data.text || '').trim();
              if (text) {
                this.accumulatedTranscript = text;
                if (data.isFinal) {
                  this.onFinal(text, data.segmentIndex, data.language);
                } else {
                  this.onInterim(text, data.segmentIndex, data.language);
                }
              }
            } else if (data.type === 'done') {
              const fullText = (data.text || this.accumulatedTranscript || '').trim();
              this.setState('ready');
              this.onDone(fullText, data.duration || 0);

              if (this.stopResolve) {
                if (this.stopTimer) clearTimeout(this.stopTimer);
                const resolveFn = this.stopResolve;
                this.stopResolve = null;
                this.stopReject = null;
                resolveFn(fullText);
              }
            } else if (data.type === 'state') {
              if (data.state === 'paused') this.setState('paused');
              else if (data.state === 'listening') this.setState('listening');
            } else if (data.type === 'error') {
              const err = new Error(data.error || 'Voice streaming error');
              err.code = data.code || 'WS_STREAM_ERROR';
              err.recoverable = Boolean(data.recoverable);
              err.canFallback = Boolean(data.canFallback ?? true);
              if (typeof data.language === 'string' && data.language) {
                err.language = data.language;
              }
              if (err.code === 'INVALID_LANGUAGE' || err.code === 'INVALID_CONFIG' || err.code === 'INVALID_SESSION_STATE') {
                this.pendingLanguage = null;
                if (typeof data.language === 'string' && data.language) {
                  this.language = data.language;
                }
              }
              this.onError(err);
              if (this.startReject && (err.code === 'PROVIDER_UNAVAILABLE' || err.code === 'INVALID_LANGUAGE' || err.canFallback)) {
                const rejectFn = this.startReject;
                this.startResolve = null;
                this.startReject = null;
                rejectFn(err);
              }
            } else if (data.type === 'ping') {
              try {
                ws.send(JSON.stringify({ type: 'pong' }));
              } catch (_) {}
            }
          } catch (_) {}
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            if (this.connectTimer) {
              clearTimeout(this.connectTimer);
              this.connectTimer = null;
            }
            this.setState('closed');
            const err = new Error('WebSocket connection failed.');
            err.code = 'WS_CONNECTION_FAILED';
            err.canFallback = true;
            reject(err);
          } else {
            const err = new Error('WebSocket error.');
            err.code = 'WS_ERROR';
            this.onError(err);
          }
        };

        ws.onclose = (event) => {
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
          this.pendingLanguage = null;
          this.setState('closed');
          this.teardownAudio();

          if (!settled) {
            settled = true;
            const err = new Error(
              event?.reason
                ? `WebSocket closed before authentication (${event.reason}).`
                : 'WebSocket connection closed before authentication.'
            );
            err.code = 'WS_CONNECTION_CLOSED';
            err.canFallback = true;
            reject(err);
            return;
          }

          if (this.startReject) {
            const rejectFn = this.startReject;
            this.startResolve = null;
            this.startReject = null;
            const err = new Error('WebSocket closed before recording started.');
            err.code = 'WS_CONNECTION_CLOSED';
            err.canFallback = true;
            rejectFn(err);
          }

          if (this.stopResolve) {
            if (this.stopTimer) {
              clearTimeout(this.stopTimer);
              this.stopTimer = null;
            }
            const resolveFn = this.stopResolve;
            this.stopResolve = null;
            this.stopReject = null;
            resolveFn(this.accumulatedTranscript);
          }
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
          this.setState('closed');
          reject(err);
        }
      }
    });
  }

  /**
   * Initializes browser-side AudioWorklet audio pipeline.
   * Converts microphone input into 16-bit linear PCM and streams chunks to WebSocket.
   *
   * @param {MediaStream} stream - Active microphone MediaStream
   */
  async setupAudioCapture(stream) {
    if (!stream) {
      throw new Error('Valid microphone MediaStream is required for audio capture.');
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('Web Audio API is not supported in this browser.');
    }

    // Attempt 16kHz standard sample rate; browser fallback to default rate is handled gracefully
    let audioCtx;
    try {
      audioCtx = new AudioCtx({ sampleRate: 16000 });
    } catch (_) {
      audioCtx = new AudioCtx();
    }
    this.audioContext = audioCtx;

    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const source = audioCtx.createMediaStreamSource(stream);
    this.sourceNode = source;

    // Check AudioWorklet support
    if (audioCtx.audioWorklet && typeof audioCtx.audioWorklet.addModule === 'function') {
      try {
        try {
          await audioCtx.audioWorklet.addModule('/audioWorkletProcessor.js');
        } catch (fetchErr) {
          // If fetching /audioWorkletProcessor.js fails (e.g. offline, sandbox), use inline Blob URL
          const blob = new Blob([INLINE_PROCESSOR_CODE], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          try {
            await audioCtx.audioWorklet.addModule(blobUrl);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        }

        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-audio-processor');
        this.workletNode = workletNode;

        workletNode.port.onmessage = (event) => {
          if (event.data?.type === 'pcm' && event.data.buffer) {
            this.sendPcmChunk(event.data.buffer);
          }
        };

        source.connect(workletNode);
        return;
      } catch (workletErr) {
        console.warn('[VoiceStreamClient] AudioWorklet init failed, falling back to ScriptProcessor:', workletErr);
      }
    }

    // Fallback: ScriptProcessorNode (for browsers or sandboxed WebViews without worklet support)
    const bufferSize = 2048;
    const scriptProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    this.scriptProcessor = scriptProcessor;

    scriptProcessor.onaudioprocess = (e) => {
      if (this.state !== 'listening') return;
      const channelData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.sendPcmChunk(pcm16.buffer);
    };

    source.connect(scriptProcessor);
    scriptProcessor.connect(audioCtx.destination);
  }

  /**
   * Transmits a binary PCM buffer to the backend over WebSocket.
   */
  sendPcmChunk(arrayBuffer) {
    if (this.state !== 'listening') return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(arrayBuffer);
    } catch (_) {}
  }

  /**
   * Starts a voice recording and streaming session.
   */
  async start({ stream, language = 'en-US', prompt = '', token = '' }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect(token);
    }

    await this.setupAudioCapture(stream);

    this.accumulatedTranscript = '';
    const sampleRate = this.audioContext?.sampleRate || 16000;

    return new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;

      const timeoutTimer = setTimeout(() => {
        if (this.startResolve) {
          this.startResolve = null;
          this.startReject = null;
          this.setState('listening');
          resolve();
        }
      }, 4000);

      const origResolve = this.startResolve;
      const origReject = this.startReject;

      this.startResolve = () => {
        clearTimeout(timeoutTimer);
        origResolve();
      };
      this.startReject = (err) => {
        clearTimeout(timeoutTimer);
        origReject(err);
      };

      try {
        this.pendingLanguage = null;
        this.ws.send(
          JSON.stringify({
            type: 'start',
            format: {
              sampleRate,
              channels: 1,
              bitDepth: 16
            },
            language,
            prompt
          })
        );
      } catch (err) {
        clearTimeout(timeoutTimer);
        this.startResolve = null;
        this.startReject = null;
        reject(err);
      }
    });
  }

  /**
   * Returns whether the underlying WebSocket connection is currently open.
   */
  isConnected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /**
   * Sends a live configuration update (such as dictation language) to the active backend session.
   * Skips redundant sends when the requested language is already active or pending confirmation,
   * and returns false cleanly if the WebSocket is disconnected or inactive.
   *
   * @param {Object} config
   * @param {string} [config.language]
   * @param {string} [config.prompt]
   * @returns {boolean}
   */
  updateConfig({ language, prompt } = {}) {
    if (!this.isConnected()) {
      return false;
    }
    if (this.state === 'closed' || this.state === 'stopping' || this.state === 'idle') {
      return false;
    }

    const payload = { type: 'config' };

    if (language !== undefined) {
      if (typeof language !== 'string' || !language.trim()) {
        return false;
      }
      const cleanLang = language.trim();
      const effectiveCurrent = this.pendingLanguage || this.language;
      if (cleanLang === effectiveCurrent && prompt === undefined) {
        return false;
      }
      payload.language = cleanLang;
    }

    if (prompt !== undefined) {
      payload.prompt = String(prompt);
    }

    if (!('language' in payload) && !('prompt' in payload)) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(payload));
      if ('language' in payload) {
        this.pendingLanguage = payload.language;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Pauses audio transmission and streaming.
   */
  pause() {
    if (this.state !== 'listening') return;
    this.setState('paused');

    if (this.workletNode) {
      this.workletNode.port.postMessage({ command: 'pause' });
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'pause' }));
      } catch (_) {}
    }
  }

  /**
   * Resumes paused audio transmission and streaming.
   */
  resume() {
    if (this.state !== 'paused') return;
    this.setState('listening');

    if (this.workletNode) {
      this.workletNode.port.postMessage({ command: 'resume' });
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'resume' }));
      } catch (_) {}
    }
  }

  /**
   * Stops recording, flushes audio, awaits final transcription from server, and returns full text.
   *
   * @returns {Promise<string>} Final transcript
   */
  async stop() {
    if (this.state !== 'listening' && this.state !== 'paused') {
      return this.accumulatedTranscript;
    }

    this.setState('stopping');

    // Mute/disconnect audio processor immediately
    if (this.workletNode) {
      this.workletNode.port.postMessage({ command: 'pause' });
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.teardownAudio();
      return this.accumulatedTranscript;
    }

    return new Promise((resolve) => {
      this.stopResolve = resolve;

      // 4.5s bounded safety timeout in case network drops before 'done' arrives
      this.stopTimer = setTimeout(() => {
        if (this.stopResolve) {
          const resolveFn = this.stopResolve;
          this.stopResolve = null;
          this.teardownAudio();
          resolveFn(this.accumulatedTranscript);
        }
      }, 4500);

      try {
        this.ws.send(JSON.stringify({ type: 'stop' }));
      } catch (_) {
        if (this.stopResolve) {
          clearTimeout(this.stopTimer);
          const resolveFn = this.stopResolve;
          this.stopResolve = null;
          this.teardownAudio();
          resolveFn(this.accumulatedTranscript);
        }
      }
    });
  }

  /**
   * Cancels recording, discards audio buffers, and resets state.
   */
  cancel() {
    this.setState('closed');
    this.accumulatedTranscript = '';

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'cancel' }));
      } catch (_) {}
    }

    this.teardownAudio();
    this.disconnect();
  }

  /**
   * Cleans up Web Audio nodes and context.
   */
  teardownAudio() {
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch (_) {}
      this.workletNode = null;
    }
    if (this.scriptProcessor) {
      try {
        this.scriptProcessor.disconnect();
      } catch (_) {}
      this.scriptProcessor = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch (_) {}
      this.sourceNode = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        const closePromise = this.audioContext.close();
        if (closePromise && typeof closePromise.catch === 'function') {
          closePromise.catch(() => {});
        }
      } catch (_) {}
      this.audioContext = null;
    }
  }

  /**
   * Closes WebSocket connection and releases all resources.
   */
  disconnect() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.teardownAudio();
    this.pendingLanguage = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.setState('closed');
  }
}
