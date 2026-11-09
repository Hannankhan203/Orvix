export interface DocumentData {
  fileId?: string;
  id?: string;
  filename?: string;
  originalName: string;
  name?: string;
  format: string;
  mimeType?: string;
  sizeBytes?: number;
  status: string;
  success?: boolean;
  text: string;
  summaryText?: string;
  totalCharacters: number;
  totalWords: number;
  pageCount?: number;
  pages?: Array<{ pageNumber: number; text: string; charCount: number }>;
  slideCount?: number;
  slides?: Array<{ slideNumber: number; title?: string; text: string; notes?: string; charCount: number }>;
  sectionCount?: number;
  sections?: Array<{ heading: string; level: number; content: string; charCount: number }>;
  table?: {
    headers: string[];
    rowCount: number;
    columnCount: number;
    previewRows: string[][];
    markdownTable: string;
  };
  isScanned?: boolean;
  isTruncated?: boolean;
  isImage?: boolean;
  hasText?: boolean;
  lineCount?: number;
  confidence?: number;
  message?: string;
  warning?: string;
  error?: string;
  base64?: string;
  data?: string;
  dataUrl?: string;
  type?: string;
}

export interface PreparedDocumentContext {
  formattedContext: string;
  hasErrorsOrWarnings: boolean;
  unreadableDocNotes: string[];
  targetedDocs: DocumentData[];
  scope: string;
  isBoundedOrChunked: boolean;
  truncationNote?: string;
  directAnswer?: string;
  isVision?: boolean;
}

export interface DocumentExtractionResult {
  fileId: string;
  filename: string;
  originalName: string;
  format: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  success: boolean;
  text: string;
  summaryText?: string;
  totalCharacters: number;
  totalWords: number;
  pageCount?: number;
  pages?: Array<{ pageNumber: number; text: string; charCount: number }>;
  slideCount?: number;
  slides?: Array<{ slideNumber: number; title?: string; text: string; notes?: string; charCount: number }>;
  sectionCount?: number;
  sections?: Array<{ heading: string; level: number; content: string; charCount: number }>;
  table?: {
    headers: string[];
    rowCount: number;
    columnCount: number;
    previewRows: string[][];
    markdownTable: string;
  };
  isScanned?: boolean;
  isTruncated?: boolean;
  warning?: string;
  error?: string;
  extractedAt: string;
}

export type AIDiagnosticCategory =
  | 'request validation error'
  | 'provider configuration error'
  | 'provider API error'
  | 'provider timeout'
  | 'provider network failure'
  | 'streaming failure'
  | 'attachment/context processing failure'
  | 'internal server error';

export interface DiagnosticLogData {
  category: AIDiagnosticCategory;
  provider: string;
  model?: string;
  phase?: 'validation' | 'configuration' | 'attachment' | 'pre-stream' | 'mid-stream' | 'non-streaming' | 'dispatch';
  attempt?: number;
  maxAttempts?: number;
  upstreamStatus?: number;
  upstreamErrorCode?: string;
  sanitizedMessage: string;
  retryAfterSeconds?: number;
  willRetry?: boolean;
}

export type GeminiLifecycleEventName =
  | 'request_start'
  | 'upstream_fetch_start'
  | 'upstream_headers_received'
  | 'first_chunk_received'
  | 'chunk_received'
  | 'upstream_complete'
  | 'upstream_error'
  | 'timeout'
  | 'client_disconnect';

export type GeminiTimeoutStage =
  | 'header_timeout'
  | 'first_byte_timeout'
  | 'stream_inactivity_timeout'
  | 'total_request_timeout'
  | 'unary_timeout';

export interface GeminiLifecycleLogEntry {
  event: GeminiLifecycleEventName;
  elapsedMs: number;
  httpStatus?: number | null;
  model?: string | null;
  chunkCount?: number;
  streamState: string;
  attempt?: number;
  maxAttempts?: number;
  timeoutStage?: GeminiTimeoutStage;
  timeoutMs?: number;
  errorCode?: string;
  willRetry?: boolean;
  finishReason?: string | null;
}

export interface ConsumeGeminiStreamOptions {
  invokeStream: (signal: AbortSignal) => Promise<AsyncIterable<any>>;
  model: string;
  attemptNum?: number;
  maxAttempts?: number;
  requestStartTime?: number;
  headerTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  totalRequestTimeoutMs?: number;
  isClientClosed?: () => boolean;
  registerController?: (ctrl: AbortController) => void;
  unregisterController?: (ctrl: AbortController) => void;
  onFirstChunk?: (info: { model: string; elapsedMs: number }) => void;
  onChunk?: (chunkText: string, rawChunk: any, meta: { chunkCount: number; elapsedMs: number }) => void;
  onLifecycleLog?: (event: GeminiLifecycleEventName, payload: GeminiLifecycleLogEntry) => void;
}

export interface ConsumeGeminiStreamResult {
  fullText: string;
  chunkCount: number;
  streamedAnyChunk: boolean;
  lastFinishReason: string | null;
  model: string;
}

export interface UserPreferences {
  responseLength?: 'concise' | 'balanced' | 'detailed';
  beginnerFriendly?: boolean;
  [key: string]: any;
}

export interface UploadedFileRecord {
  id: string;
  originalName: string;
  diskFilename: string;
  mimeType: string;
  extension: string;
  size: number;
  formattedSize: string;
  status: 'uploaded' | 'ready' | 'error';
  uploadedAt: string;
  expiresAt: number;
  conversationId?: string;
  isImage?: boolean;
  dimensions?: { width: number; height: number };
  extraction?: any;
  extractionsByLang?: Record<string, any>;
  buffer?: Buffer;
  storageProvider?: 'local' | 'supabase';
  storagePath?: string;
  storageBucket?: string;
  userId?: string;
}


