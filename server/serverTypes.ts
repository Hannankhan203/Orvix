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

export interface VerifiedUserIdentity {
  type: 'authenticated' | 'guest';
  uid: string;
  isGuest: boolean;
  email?: string;
  projectId?: string;
  ip?: string;
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
  buffer?: Buffer;
  userId?: string;
  userType?: 'authenticated' | 'guest';
}

export interface QuotaReservation {
  allowed: boolean;
  quotaTracked: boolean;
  reservationId?: string | null;
  userKey?: string;
  utcDate?: string;
  currentCount?: number;
  remaining?: number;
  error?: string;
  code?: string;
  status?: number;
  _status?: 'reserved' | 'committed' | 'released';
}

export interface QuotaStatus {
  userKey: string;
  utcDate: string;
  committedCount: number;
  reservedCount: number;
  activeCount: number;
  remaining: number;
  limit: number;
}

export interface QuotaStorageDriver {
  getDriverName(): string;
  isDistributed(): boolean;
  reserve(identity: VerifiedUserIdentity, file: any, utcDate: string): Promise<QuotaReservation>;
  commit(reservation: QuotaReservation): Promise<{
    success: boolean;
    committed: boolean;
    alreadyFinalized?: boolean;
    committedCount?: number;
  }>;
  release(reservation: QuotaReservation): Promise<{
    success: boolean;
    released: boolean;
    alreadyFinalized?: boolean;
  }>;
  getStatus(identity: VerifiedUserIdentity, utcDate: string): Promise<QuotaStatus>;
  reset(identity: VerifiedUserIdentity, utcDate: string): Promise<void>;
}

export interface QuotaInfrastructureStatus {
  distributedReady: boolean;
  activeDriver: string;
  isDistributed: boolean;
  blocker: string | null;
  blockerDetails?: string;
  availableDrivers: string[];
  supportedBackends: {
    firestoreAdmin: { available: boolean; reason: string };
    redis: { available: boolean; reason: string };
    localFilesystem: { available: boolean; reason: string };
  };
}


