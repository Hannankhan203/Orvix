import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import fs from 'fs';
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.log(JSON.stringify({ error: 'GEMINI_API_KEY is not defined in environment' }));
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build'
    }
  }
});

function sanitizeError(msg) {
  return String(msg || '')
    .replace(/AIza[0-9A-Za-z_\-]{35}/g, '[REDACTED_API_KEY]')
    .replace(/AQ\.[A-Za-z0-9_\-]{40,}/g, '[REDACTED_KEY]');
}

// Minimal valid 1-second 16kHz sine wave audio
const sampleRate = 16000;
const numSamples = sampleRate;
const dataSize = numSamples * 2;
const wavBuffer = Buffer.alloc(44 + dataSize);
wavBuffer.write('RIFF', 0);
wavBuffer.writeUInt32LE(36 + dataSize, 4);
wavBuffer.write('WAVE', 8);
wavBuffer.write('fmt ', 12);
wavBuffer.writeUInt32LE(16, 16);
wavBuffer.writeUInt16LE(1, 20);
wavBuffer.writeUInt16LE(1, 22);
wavBuffer.writeUInt32LE(sampleRate, 24);
wavBuffer.writeUInt32LE(sampleRate * 2, 28);
wavBuffer.writeUInt16LE(2, 32);
wavBuffer.writeUInt16LE(16, 34);
wavBuffer.write('data', 36);
wavBuffer.writeUInt32LE(dataSize, 40);
for (let i = 0; i < numSamples; i++) {
  const s = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 10000;
  wavBuffer.writeInt16LE(Math.floor(s), 44 + i * 2);
}
const wavBase64 = wavBuffer.toString('base64');

// Minimal valid 1x1 PNG
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function testWithTimeout(name, timeoutMs, fn) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

  try {
    const res = await fn(ctrl.signal);
    clearTimeout(timer);
    const duration = Date.now() - start;
    console.log(`[PASS] ${name} (${duration}ms)`);
    return { ok: true, duration, data: res };
  } catch (err) {
    clearTimeout(timer);
    const duration = Date.now() - start;
    const isTimeout = ctrl.signal.aborted || err.name === 'AbortError' || err.message?.includes('Timeout');
    const status = isTimeout ? 504 : (err.status || err.statusCode || 500);
    const sanitized = sanitizeError(err.message || err);
    console.log(`[FAIL] ${name} (${duration}ms) -> Status: ${status} | Error: ${sanitized}`);
    return { ok: false, duration, status, error: sanitized };
  }
}

console.log('=== Executing Real Live Gemini API Verifications ===\n');

// 1. Primary Model: gemini-3.8-flash (Text generation)
const res38 = await testWithTimeout('1. Primary model: gemini-3.8-flash (Text generateContent)', 8000, async (signal) => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: 'Say hello in 3 words',
    config: { abortSignal: signal }
  });
  return res.text?.trim();
});

// 2. Fallback Model: gemini-3.1-flash-lite (Text generation)
const res31 = await testWithTimeout('2. Fallback model: gemini-3.1-flash-lite (Text generateContent)', 8000, async (signal) => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: 'Say hello in 3 words',
    config: { abortSignal: signal }
  });
  return res.text?.trim();
});

// 3. Fallback Model: gemini-3.1-flash-lite (Streaming generateContentStream)
const res31Stream = await testWithTimeout('3. Fallback model: gemini-3.1-flash-lite (Streaming generateContentStream)', 8000, async (signal) => {
  const stream = await ai.models.generateContentStream({
    model: 'gemini-3.1-flash-lite',
    contents: 'Say 1, 2, 3',
    config: { abortSignal: signal }
  });
  let text = '';
  for await (const chunk of stream) {
    if (chunk.text) text += chunk.text;
  }
  return text.trim();
});

// 4. Fallback Model: gemini-3.1-flash-lite (Multimodal Vision)
const res31Vision = await testWithTimeout('4. Fallback model: gemini-3.1-flash-lite (Multimodal Vision PNG)', 8000, async (signal) => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: [
      {
        parts: [
          { inlineData: { mimeType: 'image/png', data: pngBase64 } },
          { text: 'Describe image color.' }
        ]
      }
    ],
    config: { abortSignal: signal }
  });
  return res.text?.trim();
});

// 5. Dedicated Audio Transcription Model: gemini-3.5-transcribe
const resAudio = await testWithTimeout('5. Dedicated model: gemini-3.5-transcribe (Audio WAV transcription)', 8000, async (signal) => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
          { text: 'Transcribe this audio.' }
        ]
      }
    ],
    config: { abortSignal: signal }
  });
  return res.text?.trim() || '(audio acknowledged/transcribed)';
});

console.log('\n=== Live Verification Complete ===');
