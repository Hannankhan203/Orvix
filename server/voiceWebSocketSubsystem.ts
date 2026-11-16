import type { Server as HttpServer, IncomingMessage } from 'http';
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
import { checkWebSocketUpgradeRateLimit, extractClientIp } from './rateLimiter.ts';

/**
 * Returns whether at least one real transcription provider (Groq Whisper or Gemini) is configured.
 */
export function isTranscriptionProviderConfigured(): boolean {
  const groqKey = getGroqApiKey();
  const geminiKey = getGeminiApiKey();
  return isConfiguredCredential(groqKey) || isConfiguredCredential(geminiKey);
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
export const MAX_CONNECTIONS_PER_IP = 10;
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const MIN_CHUNK_INTERVAL_FOR_INCREMENTAL_MS = 600; // ~600ms between progressive passes
export const MIN_INITIAL_AUDIO_BYTES = 12_800; // ~400ms at 16kHz 16-bit mono before first pass
export const MIN_NEW_BYTES_FOR_INCREMENTAL = 9_600; // ~300ms of new audio to trigger subsequent passes

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
}

// Active sessions by socket and IP tracking
const activeSessions = new Map<WebSocket, VoiceStreamSession>();
const ipConnectionCount = new Map<string, number>();

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

      const candidateModels = ['gemini-3.5-transcribe', 'gemini-3.8-flash'];
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
  if (fullPcm.length < 3200 && !isFinalPass) {
    // Under ~100ms of audio, not enough to transcribe
    return;
  }

  // If a prior pass already transcribed all bytes and produced a transcript, skip redundant final work
  if (
    isFinalPass &&
    session.lastTranscribedBytes >= fullPcm.length &&
    session.accumulatedTranscript.trim().length > 0
  ) {
    return;
  }

  let runPromise!: Promise<void>;
  runPromise = (async () => {
    session.isTranscribing = true;
    session.lastIncrementalTime = Date.now();
    session.lastTranscribedBytes = fullPcm.length;

    try {
      // Progressive sliding/committed window:
      // Transcribe active uncommitted PCM slice to avoid re-transcribing minutes of old audio
      const activePcm = fullPcm.subarray(session.committedOffset);
      const audioToTranscribe = activePcm.length >= 3200 ? activePcm : fullPcm;

      const wav = pcmToWavBuffer(
        audioToTranscribe,
        session.format.sampleRate,
        session.format.channels,
        session.format.bitDepth
      );

      const effectivePrompt = [
        session.committedTranscript,
        session.prompt,
        DEFAULT_WHISPER_CONTEXT_PROMPT
      ]
        .filter(Boolean)
        .join('. ')
        .slice(0, 200);

      const result = await transcribeAudioBuffer(
        wav,
        session.language,
        effectivePrompt,
        session.committedTranscript || session.accumulatedTranscript
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
          // No speech recognized in this audio chunk - do not fabricate or emit empty interim
          return;
        }

        let combined = '';

        if (audioToTranscribe === fullPcm) {
          combined = activeText;
        } else if (session.committedTranscript) {
          combined = activeText ? `${session.committedTranscript} ${activeText}` : session.committedTranscript;
        } else {
          combined = activeText;
        }

        combined = polishSpokenTranscript(combined) || combined;

        if (combined) {
          session.accumulatedTranscript = combined;
          session.segmentIndex += 1;

          // If a sentence completed with punctuation and active segment has sufficient length, commit it
          const endsWithPunctuation = /[.!?]$/.test(activeText);
          if (endsWithPunctuation && activePcm.length >= 32000 && !isFinalPass) {
            session.committedTranscript = combined;
            session.committedOffset = fullPcm.length;
          }

          safeSendJson(session.ws, {
            type: 'transcription',
            sessionId: session.sessionId,
            text: combined,
            isFinal: isFinalPass,
            segmentIndex: session.segmentIndex,
            provider: result.provider
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
    const currentCount = ipConnectionCount.get(session.ip) || 0;
    if (currentCount <= 1) {
      ipConnectionCount.delete(session.ip);
    } else {
      ipConnectionCount.set(session.ip, currentCount - 1);
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
  const wss = new WebSocketServer({ noServer: true });

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

    // Atomically extract normalized IP and reserve concurrent slot BEFORE any async awaits
    const ip = extractClientIp(req);
    const currentCount = ipConnectionCount.get(ip) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      try {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      } catch (_) {}
      socket.destroy();
      return;
    }

    ipConnectionCount.set(ip, currentCount + 1);
    let slotSettled = false;
    const releaseReservedIpSlot = () => {
      if (slotSettled) return;
      slotSettled = true;
      const cur = ipConnectionCount.get(ip) || 0;
      if (cur <= 1) {
        ipConnectionCount.delete(ip);
      } else {
        ipConnectionCount.set(ip, cur - 1);
      }
    };

    socket.once('close', releaseReservedIpSlot);

    try {
      // Authenticate handshake strictly via Bearer token in Authorization header or ?token= query param
      const rawAuthHeader = req.headers.authorization;
      let token = '';
      if (typeof rawAuthHeader === 'string' && rawAuthHeader.trim()) {
        const match = rawAuthHeader.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
        if (!match || !match[1]) {
          releaseReservedIpSlot();
          if (!socket.destroyed) {
            try {
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            } catch (_) {}
            socket.destroy();
          }
          return;
        }
        token = match[1].trim();
      } else if (parsed.query?.token && typeof parsed.query.token === 'string') {
        token = parsed.query.token.trim();
      }

      if (!token) {
        releaseReservedIpSlot();
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
        releaseReservedIpSlot();
        if (!socket.destroyed) {
          try {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          } catch (_) {}
          socket.destroy();
        }
        return;
      }

      const verifiedUserId: string = authResult.user.uid;

      const wsRateDecision = await checkWebSocketUpgradeRateLimit(req, verifiedUserId);
      if (!wsRateDecision.allowed) {
        releaseReservedIpSlot();
        if (!socket.destroyed) {
          try {
            socket.write(
              `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${wsRateDecision.retryAfterSeconds}\r\nX-RateLimit-Limit: ${wsRateDecision.limit}\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset-UTC: ${wsRateDecision.resetAtIso}\r\n\r\n`
            );
          } catch (_) {}
          socket.destroy();
        }
        return;
      }

      if (socket.destroyed) {
        releaseReservedIpSlot();
        return;
      }

      // Transfer slot ownership to the WebSocket session before handleUpgrade
      slotSettled = true;
      socket.removeListener('close', releaseReservedIpSlot);

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, {
          ip,
          userId: verifiedUserId,
          isGuest: false,
          authenticated: true
        });
      });
    } catch (upgradeErr: any) {
      console.warn('[VoiceStream] WebSocket upgrade error:', upgradeErr?.message || upgradeErr);
      releaseReservedIpSlot();
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, authContext: any) => {
    if (!authContext?.authenticated || !authContext?.userId) {
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
      isAlive: true
    };

    activeSessions.set(ws, session);

    // Initial auth & readiness confirmation message
    const providerConfigured = isTranscriptionProviderConfigured();
    safeSendJson(ws, {
      type: 'authenticated',
      sessionId,
      userId: session.userId,
      isGuest: session.isGuest,
      providerAvailable: providerConfigured
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
            if (message.language) {
              session.language = String(message.language);
            }
            if (message.prompt) {
              session.prompt = String(message.prompt);
            }

            safeSendJson(ws, {
              type: 'ready',
              sessionId: session.sessionId,
              format: session.format
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
              words
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
 * Resets internal voice session and IP connection tracking state for isolated tests.
 */
export function resetVoiceWebSocketStateForTesting(): void {
  for (const session of activeSessions.values()) {
    cleanupSession(session, 1000, 'Test reset');
  }
  activeSessions.clear();
  ipConnectionCount.clear();
}
