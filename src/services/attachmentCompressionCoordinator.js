/**
 * Attachment Compression Coordinator
 *
 * Bridges `smartCompressionService.js` with `ChatPage.jsx` attachment upload workflows:
 * - Optimizes eligible files once prior to upload / local extraction.
 * - Guarantees the same File instance or already-compressed File is never compressed repeatedly.
 * - Preserves original filename, MIME type, attachment identity, and preview metadata.
 * - Enforces AbortSignal cancellation and safe original-file fallback on any skip/failure.
 */

import {
  compressFile,
  COMPRESSION_STAGES,
  COMPRESSION_REASONS
} from './smartCompressionService.js';
import {
  compressFileForTransparentStorage,
  isTransparentStorageCompressionSupported
} from './storageEnvelopeService.js';
import { formatFileSize } from '../components/chat/chatAreaUtils.js';
import { createAbortError, isAbortLikeError } from './requestIsolationService.js';

const evaluatedFileCache = new WeakMap();
const compressedOutputFiles = new WeakSet();
const evaluatedStorageCache = new WeakMap();

const OPTIMIZATION_STAGE_LABELS = {
  [COMPRESSION_STAGES.ANALYZING]: 'Analyzing',
  [COMPRESSION_STAGES.OPTIMIZING]: 'Optimizing',
  [COMPRESSION_STAGES.VALIDATING]: 'Validating'
};

/**
 * Formats a concise human-readable status message for a compression stage.
 * @param {string} stage
 * @param {string} fileName
 * @returns {string}
 */
export function formatCompressionStageLabel(stage, fileName) {
  const prefix = OPTIMIZATION_STAGE_LABELS[stage] || 'Optimizing';
  return fileName ? `${prefix} ${fileName}...` : `${prefix} attachment...`;
}

const GENERIC_ATTACHMENT_MIMES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/unknown',
  'unknown/unknown'
]);

function isGenericAttachmentMime(mime) {
  if (typeof mime !== 'string') return true;
  const clean = mime.split(';')[0].trim().toLowerCase();
  return !clean || GENERIC_ATTACHMENT_MIMES.has(clean);
}

/**
 * Ensures any resulting File matches the attachment's canonical filename and MIME type.
 * @param {File} resultingFile
 * @param {Object} att
 * @returns {File}
 */
function ensureCanonicalFileMetadata(resultingFile, att) {
  if (!resultingFile) return att.file;
  const expectedName = att.name || att.originalName || resultingFile.name;
  const hasSpecificAttType = !isGenericAttachmentMime(att.type);
  const expectedType =
    (hasSpecificAttType ? att.type : resultingFile.type) || att.type || resultingFile.type || '';

  const nameMatches = !expectedName || resultingFile.name === expectedName;
  const typeMatches = !expectedType || resultingFile.type === expectedType;
  if (nameMatches && typeMatches) {
    return resultingFile;
  }

  try {
    const normalized = new File([resultingFile], expectedName || resultingFile.name, {
      type: expectedType || resultingFile.type,
      lastModified: resultingFile.lastModified || Date.now()
    });
    if (compressedOutputFiles.has(resultingFile)) {
      compressedOutputFiles.add(normalized);
    }
    return normalized;
  } catch (_) {
    return resultingFile;
  }
}

/**
 * Builds an updated attachment descriptor using `resultingFile` while preserving
 * identity, filename, MIME type, extension, preview URL, and existing fields.
 * @param {Object} att
 * @param {File} resultingFile
 * @param {Object} result
 * @param {Object} [storageResult]
 * @returns {Object}
 */
function buildPreparedAttachment(att, resultingFile, result, storageResult = null) {
  const finalFile = ensureCanonicalFileMetadata(resultingFile || att.file, att);
  const finalSize = typeof finalFile?.size === 'number' ? finalFile.size : att.size;
  const resolvedType =
    (!isGenericAttachmentMime(att.type) ? att.type : finalFile.type) || att.type || finalFile.type;

  const prepared = {
    ...att,
    id: att.id,
    name: att.name || finalFile.name,
    originalName: att.originalName || att.name || finalFile.name,
    type: resolvedType,
    extension: att.extension,
    isImage: Boolean(att.isImage),
    previewUrl: att.previewUrl,
    file: finalFile,
    size: finalSize,
    formattedSize: formatFileSize(finalSize),
    compression: {
      compressed: Boolean(result?.compressed),
      originalSize: result?.originalSize ?? att.file.size,
      finalSize,
      reason: result?.reason || COMPRESSION_REASONS.SKIPPED
    }
  };

  if (storageResult) {
    prepared.storageCompression = {
      compressed: Boolean(storageResult.compressed),
      encoding: storageResult.compressed ? storageResult.encoding : null,
      encodedFile: storageResult.compressed ? storageResult.encodedFile : null,
      originalSize: storageResult.originalSize ?? finalSize,
      encodedSize: storageResult.encodedSize ?? finalSize,
      originalMimeType: storageResult.originalMimeType || resolvedType,
      extension: storageResult.extension || att.extension,
      crc32: storageResult.crc32,
      sha256: storageResult.sha256,
      savingsBytes: storageResult.savingsBytes || 0,
      savingsRatio: storageResult.savingsRatio || 0,
      reason: storageResult.reason || COMPRESSION_REASONS.SKIPPED
    };
  } else if (att.storageCompression) {
    prepared.storageCompression = att.storageCompression;
  }

  return prepared;
}

/**
 * Evaluates transparent Orvix envelope compression for TXT/MD/DOC/PPT/XLS attachments.
 * Keeps original `att.file` untouched and places envelope on `storageResult.encodedFile`.
 */
async function evaluateTransparentStorageCompression(
  att,
  inputFile,
  { signal, isActive, onStage, displayName, transparentCompressFn }
) {
  const isCandidate = isTransparentStorageCompressionSupported({
    name: displayName,
    type: att.type || inputFile.type,
    extension: att.extension
  });
  if (!isCandidate) {
    return null;
  }

  if (att.storageCompression?.compressed && att.storageCompression?.encodedFile) {
    return att.storageCompression;
  }

  const cached = evaluatedStorageCache.get(inputFile);
  if (cached) {
    return cached;
  }

  if (typeof onStage === 'function' && !signal?.aborted && (typeof isActive !== 'function' || isActive())) {
    onStage({
      phase: 'optimizing',
      stage: COMPRESSION_STAGES.OPTIMIZING,
      fileName: displayName,
      label: formatCompressionStageLabel(COMPRESSION_STAGES.OPTIMIZING, displayName),
      originalSize: inputFile.size,
      candidateSize: null,
      finalSize: null,
      progressPercent: null
    });
  }

  let storageRes;
  try {
    storageRes = await transparentCompressFn(inputFile, {
      signal,
      extension: att.extension
    });
  } catch (err) {
    if (isAbortLikeError(err, signal) || (typeof isActive === 'function' && !isActive())) {
      throw createAbortError('Attachment optimization cancelled.');
    }
    console.warn(`Transparent storage compression failed for '${displayName}', using original file:`, err);
    storageRes = {
      compressed: false,
      encoding: null,
      encodedFile: null,
      originalFile: inputFile,
      originalSize: inputFile.size,
      encodedSize: inputFile.size,
      originalMimeType: att.type || inputFile.type,
      reason: COMPRESSION_REASONS.ERROR
    };
  }

  if (signal?.aborted || (typeof isActive === 'function' && !isActive())) {
    throw createAbortError('Attachment optimization cancelled.');
  }

  evaluatedStorageCache.set(inputFile, storageRes);
  return storageRes;
}

/**
 * Prepares attachment descriptors prior to all upload/extraction branches.
 * Never compresses the same file repeatedly, preserves original file fallback,
 * and stops immediately when `signal` aborts or `isActive()` returns false.
 *
 * @param {Array<Object>} filesToUpload
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {() => boolean} [options.isActive]
 * @param {(status: Object) => void} [options.onStage]
 * @param {typeof compressFile} [options.compressFn]
 * @param {typeof compressFileForTransparentStorage} [options.transparentCompressFn]
 * @returns {Promise<Array<Object>>}
 */
export async function prepareAttachmentsForUpload(filesToUpload = [], options = {}) {
  const {
    signal,
    isActive,
    onStage,
    compressFn = compressFile,
    transparentCompressFn = compressFileForTransparentStorage
  } = options;

  const assertActive = () => {
    if (signal?.aborted || (typeof isActive === 'function' && !isActive())) {
      throw createAbortError('Attachment optimization cancelled.');
    }
  };

  assertActive();

  if (!Array.isArray(filesToUpload) || filesToUpload.length === 0) {
    return [];
  }

  const prepared = [];

  for (const att of filesToUpload) {
    assertActive();

    if (!att || !att.file) {
      prepared.push(att);
      continue;
    }

    const inputFile = att.file;
    const displayName = att.name || att.originalName || inputFile.name || 'attachment';

    // Never re-compress an already-compressed output file or an already-evaluated file
    if (compressedOutputFiles.has(inputFile) || att.compression?.compressed === true) {
      const existingResult = evaluatedFileCache.get(inputFile) || {
        file: inputFile,
        compressed: true,
        originalSize: att.compression?.originalSize ?? inputFile.size,
        finalSize: inputFile.size,
        reason: 'already_compressed'
      };
      prepared.push(buildPreparedAttachment(att, inputFile, existingResult));
      continue;
    }

    const cachedResult = evaluatedFileCache.get(inputFile);
    if (cachedResult) {
      let storageRes = null;
      if (!cachedResult.compressed) {
        storageRes = await evaluateTransparentStorageCompression(att, cachedResult.file || inputFile, {
          signal,
          isActive,
          onStage,
          displayName,
          transparentCompressFn
        });
      }
      prepared.push(buildPreparedAttachment(att, cachedResult.file || inputFile, cachedResult, storageRes));
      continue;
    }

    let compressionResult = null;
    try {
      compressionResult = await compressFn(inputFile, {
        signal,
        onStage: (stageInfo = {}) => {
          if (signal?.aborted || (typeof isActive === 'function' && !isActive())) {
            return;
          }
          if (typeof onStage !== 'function') return;

          const stage = stageInfo.stage;
          if (
            stage === COMPRESSION_STAGES.ANALYZING ||
            stage === COMPRESSION_STAGES.OPTIMIZING ||
            stage === COMPRESSION_STAGES.VALIDATING
          ) {
            onStage({
              phase: 'optimizing',
              stage,
              fileName: displayName,
              label: formatCompressionStageLabel(stage, displayName),
              originalSize: inputFile.size,
              candidateSize: stageInfo.candidateSize ?? null,
              finalSize: stageInfo.finalSize ?? null,
              progressPercent: null
            });
          }
        }
      });
    } catch (err) {
      if (isAbortLikeError(err, signal) || (typeof isActive === 'function' && !isActive())) {
        throw createAbortError('Attachment optimization cancelled.');
      }
      console.warn(`Smart compression failed for '${displayName}', using original file:`, err);
      compressionResult = {
        file: inputFile,
        compressed: false,
        originalSize: inputFile.size,
        finalSize: inputFile.size,
        reason: COMPRESSION_REASONS.ERROR
      };
    }

    assertActive();

    if (compressionResult?.reason === COMPRESSION_REASONS.ABORTED) {
      throw createAbortError('Attachment optimization cancelled.');
    }

    const normalizedResult = compressionResult && compressionResult.file
      ? compressionResult
      : {
          file: inputFile,
          compressed: false,
          originalSize: inputFile.size,
          finalSize: inputFile.size,
          reason: compressionResult?.reason || COMPRESSION_REASONS.ERROR
        };

    // Cache non-aborted evaluation outcomes so retries or re-submissions never repeat work
    evaluatedFileCache.set(inputFile, normalizedResult);
    if (normalizedResult.compressed && normalizedResult.file) {
      compressedOutputFiles.add(normalizedResult.file);
      evaluatedFileCache.set(normalizedResult.file, {
        ...normalizedResult,
        reason: 'already_compressed'
      });
    }

    let storageRes = null;
    if (!normalizedResult.compressed) {
      storageRes = await evaluateTransparentStorageCompression(att, normalizedResult.file, {
        signal,
        isActive,
        onStage,
        displayName,
        transparentCompressFn
      });
    }

    assertActive();
    prepared.push(buildPreparedAttachment(att, normalizedResult.file, normalizedResult, storageRes));
  }

  assertActive();
  return prepared;
}

/**
 * Diagnostic helper (primarily for automated tests) to inspect whether a File
 * is recognized as an already-compressed output.
 * @param {File} file
 * @returns {boolean}
 */
export function isAlreadyCompressedOutputFile(file) {
  return Boolean(file && compressedOutputFiles.has(file));
}

/**
 * Clears cached compression tracking for a specific File (testing only).
 * @param {File} file
 */
export function clearFileCompressionCacheEntryForTesting(file) {
  if (!file) return;
  const cached = evaluatedFileCache.get(file);
  if (cached?.file) {
    evaluatedFileCache.delete(cached.file);
    compressedOutputFiles.delete(cached.file);
    evaluatedStorageCache.delete(cached.file);
  }
  evaluatedFileCache.delete(file);
  compressedOutputFiles.delete(file);
  evaluatedStorageCache.delete(file);
}
