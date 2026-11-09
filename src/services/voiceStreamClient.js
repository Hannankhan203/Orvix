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
    this.isGuest = true;
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
  }

  setState(newState) {
    this.state = newState;
    this.onStateChange(newState);
  }

  /**
   * Resolves the WebSocket endpoint URL based on window location and options.
   */
  resolveWebSocketUrl(token = '') {
    if (this.options.url) {
      return this.options.url;
    }
    const loc = window.location;
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = loc.host;
    let url = `${protocol}//${host}/api/voice-stream`;
    if (token) {
      url += `?token=${encodeURIComponent(token)}`;
    }
    return url;
  }

  /**
   * Connects to the authenticated WebSocket server.
   *
   * @param {string} [token=''] - Optional Firebase Auth ID token
   * @returns {Promise<VoiceStreamClient>}
   */
  async connect(token = '') {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this;
    }

    this.setState('connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      const url = this.resolveWebSocketUrl(token);

      // Connection timeout (4s): if server doesn't respond or is on Vercel without WS support, fail fast
      this.connectTimer = setTimeout(() => {
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
          // Send explicit auth packet if token was not in query string
          if (token) {
            ws.send(JSON.stringify({ type: 'auth', token }));
          } else {
            ws.send(JSON.stringify({ type: 'auth', guest: true }));
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.type === 'authenticated') {
              this.sessionId = data.sessionId;
              this.userId = data.userId;
              this.isGuest = Boolean(data.isGuest);
              if (!settled) {
                settled = true;
                clearTimeout(this.connectTimer);
                this.setState('ready');
                resolve(this);
              }
            } else if (data.type === 'ready') {
              this.setState('listening');
            } else if (data.type === 'transcription') {
              const text = (data.text || '').trim();
              if (text) {
                this.accumulatedTranscript = text;
                if (data.isFinal) {
                  this.onFinal(text, data.segmentIndex);
                } else {
                  this.onInterim(text, data.segmentIndex);
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
              this.onError(err);
            } else if (data.type === 'ping') {
              try {
                ws.send(JSON.stringify({ type: 'pong' }));
              } catch (_) {}
            }
          } catch (_) {}
        };

        ws.onerror = (event) => {
          if (!settled) {
            settled = true;
            clearTimeout(this.connectTimer);
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
          this.setState('closed');
          if (this.stopResolve) {
            if (this.stopTimer) clearTimeout(this.stopTimer);
            const resolveFn = this.stopResolve;
            this.stopResolve = null;
            this.stopReject = null;
            resolveFn(this.accumulatedTranscript);
          }
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(this.connectTimer);
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
          await audioCtx.audioWorklet.addModule(blobUrl);
          URL.revokeObjectURL(blobUrl);
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
  async start({ stream, language = 'en-US', prompt = '' }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    await this.setupAudioCapture(stream);

    this.accumulatedTranscript = '';
    const sampleRate = this.audioContext?.sampleRate || 16000;

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

    this.setState('listening');
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
      this.ws.send(JSON.stringify({ type: 'pause' }));
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
      this.ws.send(JSON.stringify({ type: 'resume' }));
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
        this.audioContext.close();
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

    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.setState('closed');
  }
}
