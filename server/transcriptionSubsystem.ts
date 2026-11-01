import type express from 'express';
import path from 'path';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

import { getGroqApiBaseUrl } from './serverConfig.ts';
import { logAIDiagnostic } from './diagnosticLogger.ts';
import { parseGeminiError } from './geminiStreamHandler.ts';
// @ts-ignore - Context-aware spoken transcript polisher
import { polishSpokenTranscript } from '../src/utils/speechTextCleaner.js';
// @ts-ignore - Shared provider configuration and model identifier validator
import { validateGroqTranscriptionModel } from '../src/services/providerModelSanitizer.js';

export const audioUploadFilter = (
  _req: express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const mime = (file.mimetype || '').toLowerCase();
  const originalName = file.originalname || '';
  const ext = path.extname(originalName).toLowerCase();

  const allowedAudioMimes = [
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/ogg',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mp4a-latm',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/wave',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'audio/flac',
    'audio/x-flac',
    'application/octet-stream',
    'video/webm',
    'video/mp4'
  ];

  const allowedExts = ['.webm', '.ogg', '.mp4', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.oga'];

  const isMimeOk = allowedAudioMimes.some((m) => mime.startsWith(m) || m.startsWith(mime));
  const isExtOk = allowedExts.includes(ext);

  if (!isMimeOk && !isExtOk && mime !== 'application/octet-stream') {
    return cb(
      new Error(
        `Unsupported audio format: '${mime || ext}'. Supported formats include WebM, OGG, MP4, MP3, WAV, and M4A.`
      )
    );
  }

  cb(null, true);
};

export const transcribeUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB max
    files: 1
  },
  fileFilter: audioUploadFilter as any
});

// Map BCP-47 language tag (e.g., 'en-US', 'ur-PK') to ISO-639-1 code ('en', 'ur')
export function mapBcp47ToIso639(bcp47Tag?: string | null): string | undefined {
  if (!bcp47Tag || typeof bcp47Tag !== 'string') return undefined;
  const clean = bcp47Tag.trim().toLowerCase();
  const primary = clean.split('-')[0].split('_')[0];
  const supported = ['en', 'ur', 'es', 'fr', 'de', 'ar', 'hi', 'zh', 'ja', 'ko', 'ru', 'it', 'pt'];
  return supported.includes(primary) ? primary : undefined;
}

export const DEFAULT_WHISPER_CONTEXT_PROMPT = '';

export function registerTranscriptionRoutes(app: express.Express) {
  app.post(['/api/transcribe', '/transcribe'], (req, res) => {
    transcribeUploadMiddleware.any()(req as any, res as any, async (err: any) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              success: false,
              error: 'Audio file exceeds the maximum allowed size of 25MB.',
              code: 'AUDIO_TOO_LARGE',
              fallbackAvailable: true
            });
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
              success: false,
              error: 'Only one audio recording can be transcribed at a time.',
              code: 'TOO_MANY_FILES',
              fallbackAvailable: true
            });
          }
        }
        return res.status(400).json({
          success: false,
          error: err.message || 'Audio upload failed.',
          code: 'AUDIO_UPLOAD_ERROR',
          fallbackAvailable: true
        });
      }

      const files = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
      const audioFile = files[0];
      const incomingTranscript = req.body?.transcript ? String(req.body.transcript).trim() : '';

      if (!audioFile && !incomingTranscript) {
        return res.status(400).json({
          success: false,
          error: 'No audio data or transcript was received in the request.',
          code: 'NO_AUDIO_DATA',
          fallbackAvailable: true
        });
      }

      // Transcription model validation (separate audio transcription models from chat-completion models)
      const modelValidation = validateGroqTranscriptionModel(req.body?.model);
      if (!modelValidation.valid) {
        return res.status(400).json({
          success: false,
          error: modelValidation.error,
          code: modelValidation.code || 'INVALID_TRANSCRIPTION_MODEL',
          status: 'INVALID_ARGUMENT',
          provider: 'groq',
          retryable: false,
          fallbackAvailable: false
        });
      }
      const selectedTranscriptionModel = modelValidation.model;

      // Minimum audio payload size check if no transcript is provided
      const isTranscriptOnlyRequest = String(req.body?.transcriptOnly || '').toLowerCase() === 'true';
      const hasAudioPayload = Boolean(
        !isTranscriptOnlyRequest && audioFile && audioFile.buffer && audioFile.buffer.length >= 100
      );
      if (!incomingTranscript && !hasAudioPayload) {
        return res.status(400).json({
          success: false,
          error: 'The recorded audio is empty or too short to transcribe.',
          code: 'AUDIO_TOO_SHORT',
          fallbackAvailable: true
        });
      }

      const rawLang = req.body?.language ? String(req.body.language).trim() : null;
      const isoLang = mapBcp47ToIso639(rawLang);
      const customPrompt = req.body?.prompt ? String(req.body.prompt).trim() : '';
      const effectivePrompt = customPrompt ? customPrompt.slice(0, 200) : DEFAULT_WHISPER_CONTEXT_PROMPT;

      const groqKey = process.env.GROQ_API_KEY || '';
      const hasGroq = Boolean(groqKey && groqKey !== 'YOUR_GROQ_API_KEY');
      const geminiKey = process.env.GEMINI_API_KEY || '';
      const hasGemini = Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY');

      // Primary Audio Transcription Path: When audio payload is present, execute genuine Groq Whisper transcription
      if (hasAudioPayload && hasGroq) {
        try {
          const mime = (audioFile.mimetype || 'audio/webm').toLowerCase();
          let fileExt = '.webm';
          if (mime.includes('mp4') || mime.includes('m4a')) fileExt = '.m4a';
          else if (mime.includes('ogg')) fileExt = '.ogg';
          else if (mime.includes('wav')) fileExt = '.wav';
          else if (mime.includes('mpeg') || mime.includes('mp3')) fileExt = '.mp3';
          else if (mime.includes('aac')) fileExt = '.aac';
          else if (mime.includes('flac')) fileExt = '.flac';

          const safeFilename = audioFile.originalname && audioFile.originalname.includes('.')
            ? audioFile.originalname
            : `dictation-${Date.now()}${fileExt}`;

          const formData = new FormData();
          const audioBlob = new Blob([new Uint8Array(audioFile.buffer)], { type: mime });
          formData.append('file', audioBlob, safeFilename);
          formData.append('model', selectedTranscriptionModel);
          formData.append('temperature', '0');
          formData.append('response_format', 'verbose_json');
          if (isoLang) {
            formData.append('language', isoLang);
          }
          if (effectivePrompt) {
            formData.append('prompt', effectivePrompt);
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s max timeout

          const groqRes = await fetch(`${getGroqApiBaseUrl()}/audio/transcriptions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${groqKey}`
            },
            body: formData,
            signal: controller.signal
          }).finally(() => clearTimeout(timeoutId));

          if (groqRes.ok) {
            const result: any = await groqRes.json();
            const transcriptText = (result.text || '').trim();

            return res.status(200).json({
              success: true,
              text: transcriptText,
              language: result.language || isoLang || 'en',
              duration: result.duration || 0,
              model: selectedTranscriptionModel,
              provider: 'groq',
              highAccuracy: true
            });
          }

          const errStatus = groqRes.status;
          const errText = await groqRes.text().catch(() => '');
          let upstreamErrMsg = '';
          try {
            const parsedErr = JSON.parse(errText);
            if (typeof parsedErr?.error === 'string') {
              upstreamErrMsg = parsedErr.error;
            } else if (typeof parsedErr?.error?.message === 'string') {
              upstreamErrMsg = parsedErr.error.message;
            }
          } catch (_) {
            upstreamErrMsg = errText.slice(0, 200).trim();
          }

          logAIDiagnostic({
            category: 'provider API error',
            provider: 'groq',
            model: selectedTranscriptionModel,
            phase: 'dispatch',
            upstreamStatus: errStatus,
            sanitizedMessage: `Groq Whisper failed: ${(upstreamErrMsg || errText).slice(0, 200)}`
          });

          // Non-retryable authentication / permission / invalid-request / invalid-model failures
          if (errStatus === 401 || errStatus === 403) {
            return res.status(errStatus).json({
              success: false,
              error:
                upstreamErrMsg ||
                (errStatus === 401
                  ? 'Groq API key is invalid or unauthorized for audio transcription.'
                  : 'Groq API key does not have permission for audio transcription.'),
              code: errStatus === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
              status: errStatus === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
              provider: 'groq',
              model: selectedTranscriptionModel,
              statusCode: errStatus,
              retryable: false,
              fallbackAvailable: false
            });
          }

          if (errStatus === 400 || errStatus === 404 || errStatus === 413 || errStatus === 415 || errStatus === 422) {
            const isModelErr = errStatus === 404 || /model/i.test(upstreamErrMsg);
            return res.status(errStatus === 404 ? 404 : 400).json({
              success: false,
              error:
                upstreamErrMsg ||
                (isModelErr
                  ? `Groq transcription model '${selectedTranscriptionModel}' was not found or is unsupported.`
                  : 'Groq Whisper rejected the audio transcription request.'),
              code: isModelErr ? 'INVALID_TRANSCRIPTION_MODEL' : 'INVALID_AUDIO_REQUEST',
              status: errStatus === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
              provider: 'groq',
              model: selectedTranscriptionModel,
              statusCode: errStatus,
              retryable: false,
              fallbackAvailable: false
            });
          }

          // If Groq rate-limited (429) or unavailable (5xx), attempt Gemini audio fallback only if available
          if (!hasGemini) {
            const isRateLimit = errStatus === 429;
            return res.status(isRateLimit ? 429 : 503).json({
              success: false,
              error: isRateLimit
                ? 'Groq Whisper rate limit exceeded. Native speech transcript retained.'
                : upstreamErrMsg || 'Groq Whisper service encountered an error. Native speech transcript retained.',
              code: isRateLimit ? 'RATE_LIMIT_EXCEEDED' : 'PROVIDER_ERROR',
              status: isRateLimit ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
              provider: 'groq',
              model: selectedTranscriptionModel,
              statusCode: errStatus,
              retryable: true,
              fallbackAvailable: true
            });
          }
        } catch (groqErr: any) {
          logAIDiagnostic({
            category: 'provider API error',
            provider: 'groq',
            model: selectedTranscriptionModel,
            phase: 'dispatch',
            sanitizedMessage: groqErr?.message || 'Groq Whisper network error'
          });

          if (!hasGemini) {
            return res.status(504).json({
              success: false,
              error: groqErr?.name === 'AbortError'
                ? 'Whisper transcription timed out. Native speech transcript retained.'
                : 'Network error connecting to Whisper service. Native speech transcript retained.',
              code: groqErr?.name === 'AbortError' ? 'TRANSCRIPTION_TIMEOUT' : 'NETWORK_ERROR',
              status: groqErr?.name === 'AbortError' ? 'DEADLINE_EXCEEDED' : 'UNAVAILABLE',
              provider: 'groq',
              model: selectedTranscriptionModel,
              statusCode: 504,
              retryable: true,
              fallbackAvailable: true
            });
          }
        }
      }

      // Secondary Audio Path: Gemini Audio Recognition Fallback when audio payload exists
      if (hasAudioPayload && hasGemini) {
        try {
          const ai = new GoogleGenAI({
            apiKey: geminiKey,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build'
              }
            }
          });
          let cleanMime = (audioFile.mimetype || 'audio/webm').split(';')[0].trim().toLowerCase();
          if (cleanMime === 'audio/m4a' || cleanMime === 'audio/x-m4a' || cleanMime === 'audio/mp4') {
            cleanMime = 'audio/aac';
          }
          const base64Data = audioFile.buffer.toString('base64');

          const geminiPrompt = `You are a high-accuracy speech transcription engine.
Transcribe the speech in this audio recording verbatim.
Preserve exact words, natural phrasing, and punctuation.
${isoLang ? `The spoken language is: ${isoLang}.` : ''}
Output ONLY the transcription text. Do not summarize, do not translate, do not add introductory commentary or timestamps.`;

          const transcriptionCandidates = ['gemini-3.5-transcribe', 'gemini-3.8-flash'];
          let geminiRes: any = null;
          let modelUsed = 'gemini-3.5-transcribe';
          let lastGeminiErr: any = null;

          for (const candidateModel of transcriptionCandidates) {
            try {
              geminiRes = await ai.models.generateContent({
                model: candidateModel,
                contents: [
                  {
                    role: 'user',
                    parts: [
                      {
                        inlineData: {
                          mimeType: cleanMime,
                          data: base64Data
                        }
                      },
                      { text: geminiPrompt }
                    ]
                  }
                ]
              });
              modelUsed = candidateModel;
              break;
            } catch (tErr: any) {
              lastGeminiErr = tErr;
              const parsed = parseGeminiError(tErr, 'gemini');
              if (parsed.statusCode !== 404 && !parsed.isRetryable) {
                break;
              }
            }
          }

          if (!geminiRes) {
            throw lastGeminiErr || new Error('Gemini audio transcription failed');
          }

          const text = (geminiRes?.text || '').trim();
          return res.status(200).json({
            success: true,
            text,
            language: isoLang || 'en',
            duration: 0,
            model: modelUsed,
            provider: 'gemini',
            highAccuracy: true
          });
        } catch (geminiErr: any) {
          logAIDiagnostic({
            category: 'provider API error',
            provider: 'gemini',
            model: 'gemini-3.8-flash',
            phase: 'dispatch',
            sanitizedMessage: geminiErr?.message || 'Gemini audio transcription failed'
          });

          return res.status(503).json({
            success: false,
            error: 'Transcription service is temporarily unavailable. Native speech transcript retained.',
            code: 'TRANSCRIPTION_UNAVAILABLE',
            statusCode: 503,
            fallbackAvailable: true
          });
        }
      }

      // Deterministic local transcript polisher when only a live browser speech transcript was supplied.
      if (incomingTranscript) {
        const cleanRefined = polishSpokenTranscript(incomingTranscript);
        return res.status(200).json({
          success: true,
          text: cleanRefined || incomingTranscript,
          language: isoLang || 'en',
          duration: 0,
          model: 'local-polisher',
          provider: 'local',
          highAccuracy: false
        });
      }

      // If neither provider key is configured
      return res.status(503).json({
        success: false,
        error: 'High-accuracy Whisper transcription requires GROQ_API_KEY. Native speech transcript retained.',
        code: 'PROVIDER_NOT_CONFIGURED',
        statusCode: 503,
        fallbackAvailable: true
      });
    });
  });
}
