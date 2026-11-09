/**
 * Orvix PCM AudioWorklet Processor (Phase 6 Prompt 30)
 *
 * Runs on the Web Audio rendering thread to capture raw microphone audio,
 * converts Float32 samples (-1.0 to +1.0) into 16-bit linear signed PCM chunks,
 * and posts them to the main thread for WebSocket streaming.
 */

class PcmAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 2048 samples = ~128ms at 16000Hz or ~42ms at 48000Hz
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    this.isPaused = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;

      if (data.command === 'pause') {
        this.isPaused = true;
        this.bufferIndex = 0;
      } else if (data.command === 'resume') {
        this.isPaused = false;
        this.bufferIndex = 0;
      } else if (data.command === 'reset') {
        this.bufferIndex = 0;
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (this.isPaused) {
      return true;
    }

    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channelData = input[0];
    const len = channelData.length;

    for (let i = 0; i < len; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];

      if (this.bufferIndex >= this.bufferSize) {
        // Convert Float32 buffer to 16-bit signed integer PCM
        const pcm16 = new Int16Array(this.bufferSize);
        for (let j = 0; j < this.bufferSize; j++) {
          const sample = Math.max(-1, Math.min(1, this.buffer[j]));
          pcm16[j] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }

        // Transfer PCM ArrayBuffer to the main thread
        this.port.postMessage(
          {
            type: 'pcm',
            buffer: pcm16.buffer
          },
          [pcm16.buffer]
        );

        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-audio-processor', PcmAudioProcessor);
