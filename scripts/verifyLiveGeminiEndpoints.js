import dns from 'dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(JSON.stringify({ error: 'GEMINI_API_KEY not found in environment' }));
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

// Minimal valid 1x1 PNG base64
const sampleImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal valid 44-byte silent WAV base64
const sampleAudioWavBase64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

const results = {};

// Helper to sanitize messages
function sanitizeMsg(msg) {
  return String(msg || '')
    .replace(/AIza[0-9A-Za-z_\-]{35}/g, '[REDACTED_API_KEY]')
    .replace(/AQ\.[A-Za-z0-9_\-]{40,}/g, '[REDACTED_KEY]');
}

async function testEndpoint(name, fn) {
  const start = Date.now();
  try {
    const data = await fn();
    const duration = Date.now() - start;
    results[name] = { success: true, durationMs: duration, details: data };
    console.log(`[PASS] ${name} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const status = err?.status || err?.statusCode || (err?.message?.includes('404') ? 404 : 500);
    const sanitized = sanitizeMsg(err?.message || err);
    results[name] = { success: false, durationMs: duration, status, error: sanitized };
    console.log(`[FAIL] ${name} (${duration}ms) - Status: ${status} - ${sanitized}`);
  }
}

console.log('--- Testing Live Gemini API Calls ---');

// 1. gemini-3.8-flash Text Unary
await testEndpoint('gemini-3.8-flash (Text Unary)', async () => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: 'Respond with the single word: "READY"'
  });
  return { text: res.text?.trim() };
});

// 2. gemini-3.8-flash Text Streaming
await testEndpoint('gemini-3.8-flash (Text Streaming)', async () => {
  const stream = await ai.models.generateContentStream({
    model: 'gemini-3.8-flash',
    contents: 'Count from 1 to 3.'
  });
  let collected = '';
  for await (const chunk of stream) {
    if (chunk.text) collected += chunk.text;
  }
  return { text: collected.trim() };
});

// 3. gemini-3.8-flash Multimodal Image
await testEndpoint('gemini-3.8-flash (Multimodal Image)', async () => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: [
      {
        parts: [
          { inlineData: { mimeType: 'image/png', data: sampleImageBase64 } },
          { text: 'Describe what you see in this 1x1 pixel image in 3 words.' }
        ]
      }
    ]
  });
  return { text: res.text?.trim() };
});

// 4. gemini-3.8-flash Audio
await testEndpoint('gemini-3.8-flash (Audio Input)', async () => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: [
      {
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: sampleAudioWavBase64 } },
          { text: 'Transcribe this audio or describe if silent.' }
        ]
      }
    ]
  });
  return { text: res.text?.trim() };
});

// 5. gemini-3.5-transcribe Audio
await testEndpoint('gemini-3.5-transcribe (Audio Input)', async () => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.5-transcribe',
    contents: [
      {
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: sampleAudioWavBase64 } },
          { text: 'Transcribe this audio.' }
        ]
      }
    ]
  });
  return { text: res.text?.trim() };
});

// 6. gemini-3.1-flash-lite Text Unary
await testEndpoint('gemini-3.1-flash-lite (Text Unary)', async () => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: 'Respond with the single word: "READY"'
  });
  return { text: res.text?.trim() };
});

// 7. gemini-3.1-flash-lite Text Streaming
await testEndpoint('gemini-3.1-flash-lite (Text Streaming)', async () => {
  const stream = await ai.models.generateContentStream({
    model: 'gemini-3.1-flash-lite',
    contents: 'Count from 1 to 3.'
  });
  let collected = '';
  for await (const chunk of stream) {
    if (chunk.text) collected += chunk.text;
  }
  return { text: collected.trim() };
});

// 8. gemini-3.1-flash-lite Multimodal Image
await testEndpoint('gemini-3.1-flash-lite (Multimodal Image)', async () => {
  const res = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: [
      {
        parts: [
          { inlineData: { mimeType: 'image/png', data: sampleImageBase64 } },
          { text: 'Describe what you see in this 1x1 pixel image in 3 words.' }
        ]
      }
    ]
  });
  return { text: res.text?.trim() };
});

console.log('\n--- Final JSON Results ---');
console.log(JSON.stringify(results, null, 2));
