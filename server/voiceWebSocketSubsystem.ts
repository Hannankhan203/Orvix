import type { Server as HttpServer, IncomingMessage } from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import dns from 'dns';

// Ensure IPv4 is prioritized for outbound external API connections (Gemini, Groq)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import { verifyFirebaseIdToken } from './firebaseAuthHelper.ts';
import {
  getGroqApiBaseUrl,
  getGroqApiKey,
  getGeminiApiKey,
  isConfiguredCredential,
  isAllowedOrigin
} from './serverConfig.ts';
import { GoogleGenAI } from '@google/genai';
// @ts-ignore - Spoken transcript cleaner
import { polishSpokenTranscript } from '../src/utils/speechTextCleaner.js';
import { mapBcp47ToIso639, DEFAULT_WHISPER_CONTEXT_PROMPT } from './transcriptionSubsystem.ts';
import {
  checkWebSocketHandshakeFloodLimit,
  checkWebSocketUpgradeRateLimit,
  extractClientIp,
  getRateLimitKeyPrefix,
  hashRateLimitIdentifier,
  resolveRateLimitFailureMode
} from './rateLimiter.ts';
import {
  ensureRedisReady,
  getRedisClient,
  getRedisCommandTimeoutMs,
  isRedisConfigured
} from './redisClient.ts';

/**
 * Returns whether at least one real transcription provider (Groq Whisper or Gemini) is configured.
 */
export function isTranscriptionProviderConfigured(): boolean {
  const groqKey = getGroqApiKey();
  const geminiKey = getGeminiApiKey();
  return isConfiguredCredential(groqKey) || isConfiguredCredential(geminiKey);
}

const BCP47_LANGUAGE_TAG_REGEX = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/;

/**
 * Validates and normalizes an incoming BCP-47 voice dictation language tag.
 * Ensures well-formed syntax and support in the backend transcription pipeline.
 */
export function normalizeAndValidateVoiceLanguage(
  rawLanguage: unknown
): { valid: true; language: string; iso639: string } | { valid: false; error: string } {
  if (typeof rawLanguage !== 'string') {
    return { valid: false, error: 'Dictation language must be a non-empty string.' };
  }
  const trimmed = rawLanguage.trim();
  if (!trimmed || trimmed.length > 35 || !BCP47_LANGUAGE_TAG_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Invalid language code format. Expected a valid BCP-47 tag (e.g., en-US, es-ES).'
    };
  }
  const normalized = trimmed
    .split('-')
    .map((part, idx) => {
      if (idx === 0) return part.toLowerCase();
      if (part.length === 2 && /^[a-zA-Z]{2}$/.test(part)) return part.toUpperCase();
      if (part.length === 4 && /^[a-zA-Z]{4}$/.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      return part.toLowerCase();
    })
    .join('-');

  const iso639 = mapBcp47ToIso639(normalized);
  if (!iso639) {
    return {
      valid: false,
      error: `Unsupported dictation language: '${trimmed}'.`
    };
  }
  return { valid: true, language: normalized, iso639 };
}

/**
 * Extracts transcription text from Gemini generateContent response.
 * Supports both standard text parts and dedicated audioTranscription parts from gemini-3.5-transcribe.
 */
export function extractGeminiTranscript(result: any): string {
  if (!result) return '';
  let text = '';
  const parts = result.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.audioTranscription?.text) {
      text += (text ? ' ' : '') + part.audioTranscription.text;
    } else if (part.text) {
      text += (text ? ' ' : '') + part.text;
    }
  }
  if (!text && typeof result.text === 'string') {
    text = result.text;
  }
  return text.trim();
}

/**
 * Voice Streaming WebSocket Subsystem (Phase 6 Prompt 30)
 *
 * Implements bi-directional authenticated WebSocket voice input streaming:
 * - Real-time PCM audio streaming from client AudioWorklet.
 * - Incremental transcription delivery (interim + finalized results).
 * - Start, Pause, Resume, Stop, Cancel lifecycle controls.
 * - Strict authentication (verified Firebase Auth token required; unauthenticated/guest access rejected).
 * - Strict resource limits: buffer size, session lifetime, rate limits, heartbeat watchdog.
 * - Graceful cleanup and teardown.
 */

export const MAX_STREAM_SESSION_DURATION_MS = 15 * 60 * 1000; // 15 minutes max
export const MAX_STREAM_PCM_BYTES = 25 * 1024 * 1024; // 25 MB max memory buffer
export const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB max single WebSocket frame payload
export const MAX_CONNECTIONS_PER_IP = 10;
export const MAX_CONNECTIONS_PER_USER = 10;
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const MIN_CHUNK_INTERVAL_FOR_INCREMENTAL_MS = 600; // ~600ms between progressive passes
export const MIN_INITIAL_AUDIO_BYTES = 12_800; // ~400ms at 16kHz 16-bit mono before first pass
export const MIN_NEW_BYTES_FOR_INCREMENTAL = 9_600; // ~300ms of new audio to trigger subsequent passes
const WS_SLOT_TTL_MS = MAX_STREAM_SESSION_DURATION_MS + 60_000;

export const ATOMIC_WS_SLOT_ACQUIRE_LUA = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])
local max_slots = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms)
local current = redis.call('ZCARD', key)
if current >= max_slots then
  return { 0, current }
end

redis.call('ZADD', key, now_ms + ttl_ms, member)
redis.call('PEXPIRE', key, ttl_ms)
return { 1, current + 1 }
`;

export const ATOMIC_WS_SLOT_RELEASE_LUA = `
local key = KEYS[1]
local member = ARGV[1]
redis.call('ZREM', key, member)
return redis.call('ZCARD', key)
`;

export const ATOMIC_WS_SLOT_REFRESH_LUA = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])
local member = ARGV[3]
if redis.call('ZSCORE', key, member) then
  redis.call('ZADD', key, now_ms + ttl_ms, member)
  redis.call('PEXPIRE', key, ttl_ms)
  return 1
end
return 0
`;

export interface AudioStreamFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface VoiceStreamSession {
  sessionId: string;
  ws: WebSocket;
  ip: string;
  userId: string | null;
  isGuest: boolean;
  authenticated: boolean;
  state: 'created' | 'listening' | 'paused' | 'stopped' | 'cancelled';
  format: AudioStreamFormat;
  language: string;
  prompt: string;
  pcmChunks: Buffer[];
  totalBytes: number;
  startTime: number;
  lastIncrementalTime: number;
  segmentIndex: number;
  lastTranscribedBytes: number;
  committedOffset: number;
  committedTranscript: string;
  accumulatedTranscript: string;
  isTranscribing: boolean;
  hasPendingIncremental: boolean;
  activeTranscriptionPromise?: Promise<void> | null;
  cleanedUp?: boolean;
  isAlive: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  durationTimer?: NodeJS.Timeout;
  releaseSlots?: () => void;
  refreshDistributedSlots?: () => void;
}

// Active sessions by socket plus local IP and UID connection tracking
const activeSessions = new Map<WebSocket, VoiceStreamSession>();
const ipConnectionCount = new Map<string, number>();
const userConnectionCount = new Map<string, number>();

function incrementLocalCount(map: Map<string, number>, key: string): number {
  const next = (map.get(key) || 0) + 1;
  map.set(key, next);
  return next;
}

function decrementLocalCount(map: Map<string, number>, key: string): void {
  const cur = map.get(key) || 0;
  if (cur <= 1) {
    map.delete(key);
  } else {
    map.set(key, cur - 1);
  }
}

async function runRedisSlotEvalWithTimeout(
  fn: () => Promise<unknown>,
  timeoutMs: number
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const p = Promise.resolve(fn());
    p.catch(() => {});
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Redis WS slot command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function tryAcquireDistributedWsSlot(
  scope: 'ip' | 'uid',
  rawIdentifier: string,
  maxSlots: number,
  member: string
): Promise<{ status: 'acquired' | 'limit-exceeded' | 'unavailable'; redisKey: string | null }> {
  const redisClient = getRedisClient();
  const hasConfiguredRedis = Boolean(redisClient) || isRedisConfigured();

  if (!redisClient) {
    if (resolveRateLimitFailureMode('voiceWs', undefined, hasConfiguredRedis) === 'fail-closed') {
      return { status: 'unavailable', redisKey: null };
    }
    return { status: 'acquired', redisKey: null };
  }

  const timeoutMs = getRedisCommandTimeoutMs();
  const ready = await ensureRedisReady(redisClient, Math.min(timeoutMs, 1000));
  if (!ready) {
    if (resolveRateLimitFailureMode('voiceWs', undefined, hasConfiguredRedis) === 'fail-closed') {
      return { status: 'unavailable', redisKey: null };
    }
    return { status: 'acquired', redisKey: null };
  }

  const redisKey = `${getRateLimitKeyPrefix()}:wsslots:${scope}:${hashRateLimitIdentifier(`${scope}:${rawIdentifier}`)}`;
  try {
    const res = await runRedisSlotEvalWithTimeout(
      () =>
        redisClient.eval(
          ATOMIC_WS_SLOT_ACQUIRE_LUA,
          1,
          redisKey,
          String(Date.now()),
          String(WS_SLOT_TTL_MS),
          String(maxSlots),
          member
        ),
      timeoutMs
    );
    if (!Array.isArray(res) || res.length < 1) {
      throw new Error('Unexpected Redis WS slot Lua response');
    }
    const allowed = Number(res[0]) === 1;
    return {
      status: allowed ? 'acquired' : 'limit-exceeded',
      redisKey: allowed ? redisKey : null
    };
  } catch (err: unknown) {
    if (resolveRateLimitFailureMode('voiceWs', undefined, hasConfiguredRedis) === 'fail-closed') {
      return { status: 'unavailable', redisKey: null };
    }
    return { status: 'acquired', redisKey: null };
  }
}

function releaseDistributedWsSlot(redisKey: string | null, member: string): void {
  if (!redisKey) return;
  const redisClient = getRedisClient();
  if (!redisClient || redisClient.status !== 'ready') return;
  try {
    Promise.resolve(redisClient.eval(ATOMIC_WS_SLOT_RELEASE_LUA, 1, redisKey, member)).catch(() => {});
  } catch (_) {}
}

function refreshDistributedWsSlot(redisKey: string | null, member: string): void {
  if (!redisKey) return;
  const redisClient = getRedisClient();
  if (!redisClient || redisClient.status !== 'ready') return;
  try {
    Promise.resolve(
      redisClient.eval(
        ATOMIC_WS_SLOT_REFRESH_LUA,
        1,
        redisKey,
        String(Date.now()),
        String(WS_SLOT_TTL_MS),
        member
      )
    ).catch(() => {});
  } catch (_) {}
}

function safeSendJson(ws: WebSocket, payload: Record<string, unknown>): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Builds a valid 44-byte RIFF/WAVE header around raw PCM byte buffer.
 */
export function pcmToWavBuffer(
  pcmBuffer: Buffer,
  sampleRate = 16000,
  channels = 1,
  bitDepth = 16
): Buffer {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  // "RIFF"
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // "fmt " chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // subchunk1 size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);

  // "data" chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Transcribes audio buffer using available configured upstream providers (Groq Whisper or Gemini).
 * Never generates fabricated transcript text based on recording duration.
 */
export async function transcribeAudioBuffer(
  wavBuffer: Buffer,
  language = 'en-US',
  prompt = '',
  incomingHint = ''
): Promise<{ text: string; provider: string; model: string }> {
  const groqKey = getGroqApiKey();
  const geminiKey = getGeminiApiKey();
  const isoLang = mapBcp47ToIso639(language);

  // 1. Primary fast provider: Groq Whisper
  if (isConfiguredCredential(groqKey)) {
    try {
      const groqBase = getGroqApiBaseUrl();
      const endpoint = `${groqBase}/audio/transcriptions`;

      const formData = new FormData();
      const audioBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
      formData.append('file', audioBlob, 'voice-stream.wav');
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('temperature', '0');
      formData.append('response_format', 'verbose_json');
      if (isoLang) {
        formData.append('language', isoLang);
      }

      const effectivePrompt = [incomingHint, prompt, DEFAULT_WHISPER_CONTEXT_PROMPT]
        .filter(Boolean)
        .join('. ')
        .slice(0, 200);

      if (effectivePrompt) {
        formData.append('prompt', effectivePrompt);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`
        },
        body: formData,
        signal: controller.signal
      }).finally(() => clearTimeout(timeoutId));

      if (resp.ok) {
        const data: any = await resp.json();
        const rawText = String(data?.text || '').trim();
        if (rawText) {
          const polished = polishSpokenTranscript(rawText, incomingHint || '');
          return {
            text: polished || rawText,
            provider: 'groq',
            model: 'whisper-large-v3-turbo'
          };
        }
      }
    } catch (groqErr) {
      console.warn('[VoiceStream] Groq transcription error:', groqErr);
    }
  }

  // 2. Secondary fallback provider: Gemini Audio
  if (isConfiguredCredential(geminiKey)) {
    try {
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' }
        }
      });
      const base64Data = wavBuffer.toString('base64');
      const geminiPrompt = `You are a high-accuracy speech transcription engine.
Transcribe the speech in this audio recording verbatim.
Preserve exact words and punctuation.
${isoLang ? `Language: ${isoLang}.` : ''}
${incomingHint ? `Prior context: ${incomingHint}` : ''}
Output ONLY the transcription text. Do not summarize, do not translate, do not add commentary.`;

      const candidateModels = ['gemini-3.5-transcribe', 'gemini-4-hydrogen'];
      for (const model of candidateModels) {
        try {
          const result = await ai.models.generateContent({
            model,
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType: 'audio/wav', data: base64Data } },
                  { text: geminiPrompt }
                ]
              }
            ]
          });

          const rawText = extractGeminiTranscript(result);
          if (rawText) {
            const polished = polishSpokenTranscript(rawText, incomingHint || '');
            return {
              text: polished || rawText,
              provider: 'gemini',
              model
            };
          }
        } catch (_) {
          // Fall through to next candidate model
        }
      }
    } catch (geminiErr) {
      console.warn('[VoiceStream] Gemini transcription error:', geminiErr);
    }
  }

  // If neither provider recognized speech or no provider is configured, return empty text
  return {
    text: '',
    provider: '',
    model: ''
  };
}

/**
 * Triggers an incremental progressive transcription pass for an active session.
 * When `isFinalPass` is true, awaits any in-flight incremental pass and transcribes
 * any remaining buffered PCM audio before resolving so `'stop'` never drops trailing audio.
 */
async function processIncrementalTranscription(session: VoiceStreamSession, isFinalPass = false) {
  if (session.state === 'stopped' && !isFinalPass) return;
  if (session.state === 'cancelled') return;

  if (!isTranscriptionProviderConfigured()) {
    safeSendJson(session.ws, {
      type: 'status',
      status: 'provider_unavailable',
      code: 'PROVIDER_UNAVAILABLE',
      error: 'No voice transcription provider is configured on the server. Falling back to HTTP / Web Speech.',
      recoverable: true,
      canFallback: true
    });
    return;
  }

  if (session.isTranscribing) {
    if (!isFinalPass) {
      session.hasPendingIncremental = true;
      return;
    }

    // For a final pass ('stop' / max buffer / max duration), wait for active incremental work
    // to settle so we don't drop trailing PCM frames that arrived after the previous pass started.
    session.hasPendingIncremental = false;
    while (session.isTranscribing && session.activeTranscriptionPromise) {
      try {
        await session.activeTranscriptionPromise;
      } catch (_) {
        break;
      }
      if ((session.state as string) === 'cancelled') {
        return;
      }
    }
  }

  if ((session.state as string) === 'cancelled') return;
  if (session.state === 'stopped' && !isFinalPass) return;

  const chunks = session.pcmChunks;
  if (!chunks || chunks.length === 0) return;

  const fullPcm = Buffer.concat(chunks);
  const initialActivePcm = fullPcm.subarray(session.committedOffset);
  const initialAudioToTranscribe = session.committedOffset > 0 ? initialActivePcm : fullPcm;

  if (initialAudioToTranscribe.length === 0) {
    return;
  }
  if (initialAudioToTranscribe.length < 3200 && !isFinalPass) {
    // Under ~100ms of audio, not enough to transcribe
    return;
  }

  // If a prior pass already transcribed all bytes and produced a transcript (or committed at config change), skip redundant final work
  if (
    isFinalPass &&
    session.lastTranscribedBytes >= fullPcm.length &&
    (session.accumulatedTranscript.trim().length > 0 || session.committedOffset >= fullPcm.length)
  ) {
    return;
  }

  let runPromise!: Promise<void>;
  runPromise = (async () => {
    session.isTranscribing = true;
    session.lastIncrementalTime = Date.now();
    session.lastTranscribedBytes = fullPcm.length;

    const passLanguage = session.language;
    const passCommittedOffset = session.committedOffset;
    const passCommittedTranscript = session.committedTranscript;
    const passTotalBytes = fullPcm.length;

    try {
      // Progressive sliding/committed window:
      // Transcribe active uncommitted PCM slice to avoid re-transcribing minutes of old audio
      const activePcm = fullPcm.subarray(passCommittedOffset);
      const audioToTranscribe = passCommittedOffset > 0 ? activePcm : fullPcm;
      if (audioToTranscribe.length === 0 || (audioToTranscribe.length < 3200 && !isFinalPass)) {
        return;
      }

      const wav = pcmToWavBuffer(
        audioToTranscribe,
        session.format.sampleRate,
        session.format.channels,
        session.format.bitDepth
      );

      const effectivePrompt = [
        passCommittedTranscript,
        session.prompt,
        DEFAULT_WHISPER_CONTEXT_PROMPT
      ]
        .filter(Boolean)
        .join('. ')
        .slice(0, 200);

      const result = await transcribeAudioBuffer(
        wav,
        passLanguage,
        effectivePrompt,
        passCommittedTranscript || session.accumulatedTranscript
      );

      if ((session.state as string) === 'cancelled') {
        return;
      }
      if (session.state === 'stopped' && !isFinalPass) {
        return;
      }

      if (session.ws.readyState === WebSocket.OPEN) {
        const activeText = (result.text || '').trim();
        if (!activeText) {
          // If language switched while this pass was running, advance committedOffset past old-language bytes
          if (session.language !== passLanguage && passTotalBytes > session.committedOffset) {
            session.committedOffset = passTotalBytes;
          }
          // No speech recognized in this audio chunk - do not fabricate or emit empty interim
          return;
        }

        let combined = '';

        if (passCommittedOffset === 0) {
          combined = activeText;
        } else if (passCommittedTranscript) {
          combined = activeText ? `${passCommittedTranscript} ${activeText}` : passCommittedTranscript;
        } else {
          combined = activeText;
        }

        combined = polishSpokenTranscript(combined) || combined;

        if (combined) {
          session.accumulatedTranscript = combined;
          session.segmentIndex += 1;

          // Commit boundary if language switched mid-pass or a long punctuated sentence completed
          const endsWithPunctuation = /[.!?]$/.test(activeText);
          if (session.language !== passLanguage) {
            session.committedTranscript = combined;
            session.committedOffset = passTotalBytes;
          } else if (endsWithPunctuation && activePcm.length >= 32000 && !isFinalPass) {
            session.committedTranscript = combined;
            session.committedOffset = passTotalBytes;
          }

          safeSendJson(session.ws, {
            type: 'transcription',
            sessionId: session.sessionId,
            text: combined,
            isFinal: isFinalPass,
            segmentIndex: session.segmentIndex,
            provider: result.provider,
            language: passLanguage
          });
        }
      }
    } catch (err: any) {
      console.warn('[VoiceStream] Incremental transcription notice:', err?.message || err);
    } finally {
      session.isTranscribing = false;
      if (session.activeTranscriptionPromise === runPromise) {
        session.activeTranscriptionPromise = null;
      }

      // If another incremental chunk arrived while this was processing, run it
      if (session.hasPendingIncremental && session.state === 'listening' && !isFinalPass) {
        session.hasPendingIncremental = false;
        setTimeout(() => {
          if (session.state === 'listening' && !session.cleanedUp) {
            processIncrementalTranscription(session, false).catch(() => {});
          }
        }, 100);
      }
    }
  })();

  session.activeTranscriptionPromise = runPromise;
  await runPromise;
}

/**
 * Safely closes and cleans up a voice streaming session (idempotent across overlapping error/close/cancel events).
 */
export function cleanupSession(session: VoiceStreamSession, code = 1000, reason = 'Normal Closure') {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = undefined;
  }
  if (session.durationTimer) {
    clearTimeout(session.durationTimer);
    session.durationTimer = undefined;
  }

  activeSessions.delete(session.ws);

  if (!session.cleanedUp) {
    session.cleanedUp = true;
    if (session.releaseSlots) {
      session.releaseSlots();
    } else {
      decrementLocalCount(ipConnectionCount, session.ip);
      if (session.userId) {
        decrementLocalCount(userConnectionCount, session.userId);
      }
    }
  }

  if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
    try {
      session.ws.close(code, reason);
    } catch (_) {}
  }

  session.pcmChunks = [];
}

/**
 * Set up the WebSocket Server attached to the existing HTTP Server.
 */
export function setupVoiceWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    handleProtocols: (protocols) => {
      const arr = Array.isArray(protocols) ? protocols : Array.from(protocols || []);
      if (arr.includes('orvix-auth')) {
        return 'orvix-auth';
      }
      return false;
    }
  });

  httpServer.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const parsed = parseUrl(req.url || '', true);
    const pathname = parsed.pathname || '';

    // Route only voice stream endpoints
    if (pathname !== '/api/voice-stream' && pathname !== '/voice-stream') {
      return; // Allow other upgrade handlers (e.g. Vite HMR if any) to process
    }

    // Origin check to prevent unauthorized cross-site WebSocket connections
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (originHeader && !isAllowedOrigin(originHeader, req as any)) {
      try {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      } catch (_) {}
      socket.destroy();
      return;
    }

    // 1. Pre-auth IP handshake flood limit BEFORE slot allocation or expensive JWT RSA verification
    const handshakeDecision = await checkWebSocketHandshakeFloodLimit(req);
    if (!handshakeDecision.allowed) {
      if (!socket.destroyed) {
        try {
          if (handshakeDecision.backend === 'fail-closed') {
            socket.write(
              `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${handshakeDecision.retryAfterSeconds}\r\n\r\n`
            );
          } else {
            socket.write(
              `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${handshakeDecision.retryAfterSeconds}\r\nX-RateLimit-Limit: ${handshakeDecision.limit}\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset-UTC: ${handshakeDecision.resetAtIso}\r\n\r\n`
            );
          }
        } catch (_) {}
        socket.destroy();
      }
      return;
    }

    // 2. Synchronously reserve local IP concurrent slot BEFORE further async awaits
    const ip = extractClientIp(req);
    const currentIpCount = ipConnectionCount.get(ip) || 0;
    if (currentIpCount >= MAX_CONNECTIONS_PER_IP) {
      try {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      } catch (_) {}
      socket.destroy();
      return;
    }

    incrementLocalCount(ipConnectionCount, ip);
    const slotMember = `${process.pid}:${crypto.randomUUID()}`;
    let ipRedisKey: string | null = null;
    let userRedisKey: string | null = null;
    let trackedUserId: string | null = null;
    let slotsReleased = false;
    let ownershipTransferred = false;

    const releaseAllSlots = () => {
      if (slotsReleased) return;
      slotsReleased = true;
      decrementLocalCount(ipConnectionCount, ip);
      if (trackedUserId) {
        decrementLocalCount(userConnectionCount, trackedUserId);
      }
      releaseDistributedWsSlot(ipRedisKey, slotMember);
      releaseDistributedWsSlot(userRedisKey, slotMember);
    };

    const onUpgradeSocketCloseOrError = () => {
      if (!ownershipTransferred) {
        releaseAllSlots();
      }
    };

    socket.once('close', onUpgradeSocketCloseOrError);
    socket.once('error', onUpgradeSocketCloseOrError);

    try {
      // 3. Enforce distributed concurrent IP connection limit when Redis is active/required
      const ipSlotResult = await tryAcquireDistributedWsSlot(
        'ip',
        ip,
        MAX_CONNECTIONS_PER_IP,
        slotMember
      );
      if (ipSlotResult.status === 'unavailable') {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }
      if (ipSlotResult.status === 'limit-exceeded') {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }
      ipRedisKey = ipSlotResult.redisKey;

      // 4. Authenticate handshake strictly via Bearer token in Authorization header or Sec-WebSocket-Protocol.
      // URL query parameters (?token=) are explicitly forbidden to prevent credential exposure in logs and history.
      req.url = (req.url || '').split('?')[0];
      const rawAuthHeader = req.headers.authorization;
      let token = '';
      if (typeof rawAuthHeader === 'string' && rawAuthHeader.trim()) {
        const match = rawAuthHeader.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
        if (!match || !match[1]) {
          releaseAllSlots();
          if (!socket.destroyed) {
            try {
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            } catch (_) {}
            socket.destroy();
          }
          return;
        }
        token = match[1].trim();
      } else if (req.headers['sec-websocket-protocol']) {
        const rawProto = String(req.headers['sec-websocket-protocol']);
        const parts = rawProto.split(',').map((p) => p.trim());
        const authIndex = parts.indexOf('orvix-auth');
        if (authIndex !== -1 && parts[authIndex + 1]) {
          try {
            token = decodeURIComponent(parts[authIndex + 1]);
          } catch (_) {
            token = parts[authIndex + 1];
          }
        }
      }

      if (!token) {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }

      const authResult = await verifyFirebaseIdToken(token);
      if (!authResult.success) {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }

      const verifiedUserId: string = authResult.user.uid;

      // 5. Enforce per-user concurrent connection cap (local + distributed Redis)
      const currentUserCount = userConnectionCount.get(verifiedUserId) || 0;
      if (currentUserCount >= MAX_CONNECTIONS_PER_USER) {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }
      incrementLocalCount(userConnectionCount, verifiedUserId);
      trackedUserId = verifiedUserId;

      const userSlotResult = await tryAcquireDistributedWsSlot(
        'uid',
        verifiedUserId,
        MAX_CONNECTIONS_PER_USER,
        slotMember
      );
      if (userSlotResult.status === 'unavailable') {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }
      if (userSlotResult.status === 'limit-exceeded') {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }
      userRedisKey = userSlotResult.redisKey;

      // 6. Enforce per-user upgrade rate limit
      const wsRateDecision = await checkWebSocketUpgradeRateLimit(req, verifiedUserId);
      if (!wsRateDecision.allowed) {
        releaseAllSlots();
        if (!socket.destroyed) {
          try {
            if (wsRateDecision.backend === 'fail-closed') {
              socket.write(
                `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${wsRateDecision.retryAfterSeconds}\r\n\r\n`
              );
            } else {
              socket.write(
                `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${wsRateDecision.retryAfterSeconds}\r\nX-RateLimit-Limit: ${wsRateDecision.limit}\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset-UTC: ${wsRateDecision.resetAtIso}\r\n\r\n`
              );
            }
          } catch (_) {}
          socket.destroy();
        }
        return;
      }

      if (socket.destroyed) {
        releaseAllSlots();
        return;
      }

      // Transfer slot ownership to the WebSocket session before handleUpgrade
      ownershipTransferred = true;
      socket.removeListener('close', onUpgradeSocketCloseOrError);
      socket.removeListener('error', onUpgradeSocketCloseOrError);

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, {
          ip,
          userId: verifiedUserId,
          isGuest: false,
          authenticated: true,
          releaseSlots: releaseAllSlots,
          refreshDistributedSlots: () => {
            refreshDistributedWsSlot(ipRedisKey, slotMember);
            refreshDistributedWsSlot(userRedisKey, slotMember);
          }
        });
      });
    } catch (upgradeErr: any) {
      console.warn('[VoiceStream] WebSocket upgrade error:', upgradeErr?.message || upgradeErr);
      releaseAllSlots();
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, authContext: any) => {
    if (!authContext?.authenticated || !authContext?.userId) {
      try {
        authContext?.releaseSlots?.();
      } catch (_) {}
      try {
        ws.close(4401, 'Authentication required');
      } catch (_) {}
      return;
    }

    const sessionId = `vstream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: VoiceStreamSession = {
      sessionId,
      ws,
      ip: authContext?.ip || '127.0.0.1',
      userId: authContext.userId,
      isGuest: false,
      authenticated: true,
      state: 'created',
      format: { sampleRate: 16000, channels: 1, bitDepth: 16 },
      language: 'en-US',
      prompt: '',
      pcmChunks: [],
      totalBytes: 0,
      startTime: Date.now(),
      lastIncrementalTime: Date.now(),
      segmentIndex: 0,
      lastTranscribedBytes: 0,
      committedOffset: 0,
      committedTranscript: '',
      accumulatedTranscript: '',
      isTranscribing: false,
      hasPendingIncremental: false,
      activeTranscriptionPromise: null,
      cleanedUp: false,
      isAlive: true,
      releaseSlots: authContext?.releaseSlots,
      refreshDistributedSlots: authContext?.refreshDistributedSlots
    };

    activeSessions.set(ws, session);

    // Initial auth & readiness confirmation message
    const providerConfigured = isTranscriptionProviderConfigured();
    safeSendJson(ws, {
      type: 'authenticated',
      sessionId,
      userId: session.userId,
      isGuest: session.isGuest,
      providerAvailable: providerConfigured,
      language: session.language
    });

    // Heartbeat watchdog: ping client periodically
    session.heartbeatTimer = setInterval(() => {
      if (!session.isAlive) {
        cleanupSession(session, 4008, 'Heartbeat timeout');
        return;
      }
      session.isAlive = false;
      try {
        ws.ping();
      } catch (_) {}
    }, HEARTBEAT_INTERVAL_MS);

    // Hard ceiling for stream duration (e.g. 15 minutes)
    session.durationTimer = setTimeout(() => {
      if (session.state === 'listening' || session.state === 'paused') {
        safeSendJson(ws, {
          type: 'error',
          error: 'Maximum voice recording duration (15 minutes) reached.',
          code: 'MAX_DURATION_EXCEEDED',
          recoverable: false
        });
        processIncrementalTranscription(session, true)
          .catch(() => {})
          .finally(() => {
            cleanupSession(session, 1000, 'Max duration reached');
          });
      }
    }, MAX_STREAM_SESSION_DURATION_MS);

    ws.on('pong', () => {
      session.isAlive = true;
      session.refreshDistributedSlots?.();
    });

    ws.on('message', async (data, isBinary) => {
      session.isAlive = true;

      // 1. Binary PCM audio frame
      if (isBinary) {
        if (!session.authenticated || !session.userId) {
          safeSendJson(ws, {
            type: 'error',
            error: 'Authentication required for voice streaming.',
            code: 'AUTH_REQUIRED',
            recoverable: false
          });
          cleanupSession(session, 4401, 'Authentication required');
          return;
        }
        if (session.state !== 'listening') {
          return;
        }

        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as any);

        // Memory limit safeguard
        if (session.totalBytes + chunk.length > MAX_STREAM_PCM_BYTES) {
          safeSendJson(ws, {
            type: 'error',
            error: 'Audio buffer limit (25 MB) exceeded.',
            code: 'MAX_BUFFER_EXCEEDED',
            recoverable: false
          });
          await processIncrementalTranscription(session, true).catch(() => {});
          cleanupSession(session, 1009, 'Max buffer exceeded');
          return;
        }

        session.pcmChunks.push(chunk);
        session.totalBytes += chunk.length;

        // Progressive interim transcription trigger:
        // Triggers as soon as initial audio reaches threshold (~400ms = 12,800 bytes)
        // and subsequently when enough new audio arrives (~300ms = 9,600 bytes)
        // and minimum chunk interval has elapsed (600ms).
        const now = Date.now();
        const bytesSinceLast = session.totalBytes - session.lastTranscribedBytes;
        const timeSinceLast = now - session.lastIncrementalTime;

        const shouldTriggerInitial =
          session.lastTranscribedBytes === 0 && session.totalBytes >= MIN_INITIAL_AUDIO_BYTES;
        const shouldTriggerSubsequent =
          bytesSinceLast >= MIN_NEW_BYTES_FOR_INCREMENTAL &&
          timeSinceLast >= MIN_CHUNK_INTERVAL_FOR_INCREMENTAL_MS;

        if (shouldTriggerInitial || shouldTriggerSubsequent) {
          processIncrementalTranscription(session, false).catch(() => {});
        }
        return;
      }

      // 2. Text JSON control messages
      try {
        const message = JSON.parse(data.toString());
        const msgType = message.type;

        switch (msgType) {
          case 'auth': {
            if (message.token && typeof message.token === 'string') {
              const res = await verifyFirebaseIdToken(message.token);
              if (res.success && (!session.userId || res.user.uid === session.userId)) {
                session.userId = res.user.uid;
                session.isGuest = false;
                session.authenticated = true;
                safeSendJson(ws, {
                  type: 'authenticated',
                  sessionId: session.sessionId,
                  userId: session.userId,
                  isGuest: false
                });
              } else {
                safeSendJson(ws, {
                  type: 'error',
                  error: res.success ? 'Token identity mismatch.' : res.error || 'Authentication failed.',
                  code: res.success ? 'AUTH_IDENTITY_MISMATCH' : res.code || 'AUTH_FAILED',
                  recoverable: false
                });
                cleanupSession(session, 4401, 'Auth failed');
              }
            } else {
              safeSendJson(ws, {
                type: 'error',
                error: 'Authentication required: valid Firebase ID token is required.',
                code: 'AUTH_REQUIRED',
                recoverable: false
              });
              cleanupSession(session, 4401, 'Authentication required');
            }
            break;
          }

          case 'start': {
            if (!session.authenticated || !session.userId) {
              safeSendJson(ws, {
                type: 'error',
                error: 'Authentication required for voice streaming.',
                code: 'AUTH_REQUIRED',
                recoverable: false
              });
              cleanupSession(session, 4401, 'Authentication required');
              return;
            }
            if (!isTranscriptionProviderConfigured()) {
              safeSendJson(ws, {
                type: 'status',
                status: 'provider_unavailable',
                code: 'PROVIDER_UNAVAILABLE',
                error: 'No voice transcription provider is configured on the server. Falling back to HTTP / Web Speech.',
                recoverable: true,
                canFallback: true
              });
              return;
            }

            if (message.language !== undefined && message.language !== null && message.language !== '') {
              const langValidation = normalizeAndValidateVoiceLanguage(message.language);
              if (!langValidation.valid) {
                safeSendJson(ws, {
                  type: 'error',
                  sessionId: session.sessionId,
                  error: langValidation.error,
                  code: 'INVALID_LANGUAGE',
                  recoverable: true,
                  canFallback: false,
                  language: session.language
                });
                return;
              }
              session.language = langValidation.language;
            }

            session.state = 'listening';
            session.startTime = Date.now();
            session.lastIncrementalTime = Date.now();
            session.pcmChunks = [];
            session.totalBytes = 0;
            session.lastTranscribedBytes = 0;
            session.committedOffset = 0;
            session.committedTranscript = '';
            session.accumulatedTranscript = '';
            session.segmentIndex = 0;
            session.hasPendingIncremental = false;

            if (message.format) {
              session.format = {
                sampleRate: Number(message.format.sampleRate) || 16000,
                channels: Number(message.format.channels) || 1,
                bitDepth: Number(message.format.bitDepth) || 16
              };
            }
            if (message.prompt) {
              session.prompt = String(message.prompt);
            }

            safeSendJson(ws, {
              type: 'ready',
              sessionId: session.sessionId,
              format: session.format,
              language: session.language
            });
            break;
          }

          case 'config': {
            if (!session.authenticated || !session.userId) {
              safeSendJson(ws, {
                type: 'error',
                error: 'Authentication required for voice streaming.',
                code: 'AUTH_REQUIRED',
                recoverable: false
              });
              cleanupSession(session, 4401, 'Authentication required');
              return;
            }
            if (session.state === 'stopped' || session.state === 'cancelled') {
              safeSendJson(ws, {
                type: 'error',
                sessionId: session.sessionId,
                error: `Cannot update dictation configuration when session is ${session.state}.`,
                code: 'INVALID_SESSION_STATE',
                recoverable: true,
                canFallback: false,
                language: session.language
              });
              break;
            }

            const hasLanguageUpdate = Object.prototype.hasOwnProperty.call(message, 'language');
            const hasPromptUpdate = typeof message.prompt === 'string';

            if (!hasLanguageUpdate && !hasPromptUpdate) {
              safeSendJson(ws, {
                type: 'error',
                sessionId: session.sessionId,
                error: 'Configuration update must specify a valid language or prompt.',
                code: 'INVALID_CONFIG',
                recoverable: true,
                canFallback: false,
                language: session.language
              });
              break;
            }

            const previousLanguage = session.language;
            let nextLanguage = previousLanguage;

            if (hasLanguageUpdate) {
              const langValidation = normalizeAndValidateVoiceLanguage(message.language);
              if (!langValidation.valid) {
                safeSendJson(ws, {
                  type: 'error',
                  sessionId: session.sessionId,
                  error: langValidation.error,
                  code: 'INVALID_LANGUAGE',
                  recoverable: true,
                  canFallback: false,
                  language: session.language
                });
                break;
              }
              nextLanguage = langValidation.language;
            }

            if (nextLanguage !== previousLanguage) {
              session.language = nextLanguage;
              if (
                !session.isTranscribing &&
                (session.accumulatedTranscript.trim().length > 0 || session.lastTranscribedBytes > 0)
              ) {
                if (session.accumulatedTranscript.trim().length > 0) {
                  session.committedTranscript = session.accumulatedTranscript;
                }
                session.committedOffset = session.totalBytes;
                session.lastTranscribedBytes = session.totalBytes;
              }
            }

            if (hasPromptUpdate) {
              session.prompt = message.prompt;
            }

            safeSendJson(ws, {
              type: 'config',
              sessionId: session.sessionId,
              language: session.language,
              previousLanguage,
              updated: nextLanguage !== previousLanguage
            });
            break;
          }

          case 'pause': {
            session.state = 'paused';
            safeSendJson(ws, {
              type: 'state',
              state: 'paused',
              sessionId: session.sessionId
            });
            break;
          }

          case 'resume': {
            session.state = 'listening';
            session.lastIncrementalTime = Date.now();
            safeSendJson(ws, {
              type: 'state',
              state: 'listening',
              sessionId: session.sessionId
            });
            break;
          }

          case 'stop': {
            session.state = 'stopped';
            await processIncrementalTranscription(session, true);

            const durationSec = Math.max(0, Math.round((Date.now() - session.startTime) / 1000));
            const words = session.accumulatedTranscript
              ? session.accumulatedTranscript.split(/\s+/).filter(Boolean).length
              : 0;

            safeSendJson(ws, {
              type: 'done',
              sessionId: session.sessionId,
              text: session.accumulatedTranscript,
              duration: durationSec,
              words,
              language: session.language
            });
            break;
          }

          case 'cancel': {
            session.state = 'cancelled';
            session.pcmChunks = [];
            session.totalBytes = 0;
            session.lastTranscribedBytes = 0;
            session.committedOffset = 0;
            session.committedTranscript = '';
            session.accumulatedTranscript = '';
            session.hasPendingIncremental = false;
            safeSendJson(ws, {
              type: 'cancelled',
              sessionId: session.sessionId
            });
            cleanupSession(session, 1000, 'Client cancelled');
            break;
          }

          case 'ping': {
            safeSendJson(ws, { type: 'pong' });
            break;
          }

          default:
            break;
        }
      } catch (parseErr) {
        safeSendJson(ws, {
          type: 'error',
          error: 'Invalid JSON message payload',
          code: 'INVALID_PAYLOAD',
          recoverable: true
        });
      }
    });

    ws.on('close', () => {
      cleanupSession(session, 1000, 'Socket closed');
    });

    ws.on('error', (err) => {
      console.warn('[VoiceStream] WebSocket client error:', err?.message || err);
      cleanupSession(session, 1011, 'Socket error');
    });
  });

  return wss;
}

/**
 * Access active sessions for tests and diagnostics.
 */
export function getActiveVoiceSessions(): VoiceStreamSession[] {
  return Array.from(activeSessions.values());
}

/**
 * Reads tracked concurrent WebSocket connection count for a normalized IP (for tests and diagnostics).
 */
export function getVoiceIpConnectionCount(ip: string): number {
  return ipConnectionCount.get(ip) || 0;
}

/**
 * Resets internal voice session and connection tracking state for isolated tests.
 */
export function resetVoiceWebSocketStateForTesting(): void {
  for (const session of activeSessions.values()) {
    cleanupSession(session, 1000, 'Test reset');
  }
  activeSessions.clear();
  ipConnectionCount.clear();
  userConnectionCount.clear();
}
