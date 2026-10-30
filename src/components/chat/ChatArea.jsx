import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Mic,
  Square,
  AlertCircle,
  X,
  Check,
  Pause,
  Play,
  ChevronDown,
  Sparkles,
  Loader2,
  Globe,
  Paperclip,
  FileImage,
  Eye
} from 'lucide-react';
import WelcomeScreen from './WelcomeScreen.jsx';
import MessageList from './MessageList.jsx';
import BrowserAIStatusBar from './BrowserAIStatusBar.jsx';
const DocumentPreviewModal = React.lazy(() => import('./DocumentPreviewModal.jsx'));
import Button from '../ui/Button.jsx';
import { useVoiceDictation, combineComposerText } from '../../hooks/useVoiceDictation.js';
import { sendAIMessage, PROVIDER_OPTIONS } from '../../services/aiRouter.js';
import { WEBLLM_MODEL_CATALOG, DEFAULT_WEBLLM_MODEL_ID } from '../../services/webllmService.js';
import { responseHasContinuationNotice } from '../../services/multiPartResponseService.js';
import { polishSpokenTranscript } from '../../utils/speechTextCleaner.js';

export function getProviderFootnote(providerId, webllmModelId = DEFAULT_WEBLLM_MODEL_ID) {
  if (providerId === 'webllm') {
    const modelLabel =
      WEBLLM_MODEL_CATALOG[webllmModelId]?.shortLabel || 'Qwen 2.5 1.5B';
    return `Orvix is powered by Browser AI (WebLLM) (${modelLabel}). On-device WebGPU inference — verify important facts independently.`;
  }
  if (providerId === 'groq') {
    return 'Orvix is powered by Groq (GPT OSS 120B). Ultra-fast inference — verify important facts independently.';
  }
  if (providerId === 'openrouter') {
    const openrouterOption = Array.isArray(PROVIDER_OPTIONS)
      ? PROVIDER_OPTIONS.find((p) => p.id === 'openrouter')
      : null;
    const modelLabel = openrouterOption?.modelTag || 'Free Models Router';
    return `Orvix is powered by OpenRouter (${modelLabel}), dynamically selecting from available free community models.`;
  }
  if (providerId === 'cloudflare') {
    return 'Orvix is powered by Cloudflare Workers AI (Llama 3.1 8B). Serverless inference — verify important facts independently.';
  }
  if (providerId === 'gemini') {
    return 'Orvix is powered by Google Gemini (Gemini 2.5 Flash). Client integration — verify important facts independently.';
  }
  const config = Array.isArray(PROVIDER_OPTIONS) ? PROVIDER_OPTIONS.find((p) => p.id === providerId) : null;
  if (config) {
    const model = config.defaultModel || config.modelTag || 'AI Model';
    return `Orvix is powered by ${config.name} (${model}). ${config.description || 'Inference'} — verify important facts independently.`;
  }
  return 'Orvix is powered by Google Gemini (Gemini 2.5 Flash). Client integration — verify important facts independently.';
}

// Whitelist of supported image extensions
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'JPG',
  'JPEG',
  'PNG',
  'WEBP',
  'GIF',
  'BMP',
  'HEIC',
  'HEIF'
]);

// Whitelist of all supported file extensions (consistent with server upload whitelists)
const SUPPORTED_EXTENSIONS = new Set([
  'PDF',
  'DOCX',
  'DOC',
  'PPTX',
  'PPT',
  'XLSX',
  'XLS',
  'TXT',
  'MD',
  'MARKDOWN',
  'CSV',
  'TSV',
  'JSON',
  'XML',
  'JPG',
  'JPEG',
  'PNG',
  'WEBP',
  'GIF',
  'BMP',
  'HEIC',
  'HEIF'
]);

// Helper to determine the standard extension from MIME type
function getExtensionFromMime(mimeType) {
  if (!mimeType) return null;
  const mime = mimeType.toLowerCase();
  if (mime.includes('png')) return 'PNG';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'JPG';
  if (mime.includes('webp')) return 'WEBP';
  if (mime.includes('gif')) return 'GIF';
  if (mime.includes('bmp')) return 'BMP';
  if (mime.includes('heic')) return 'HEIC';
  if (mime.includes('heif')) return 'HEIF';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('wordprocessingml') || mime.includes('docx')) return 'DOCX';
  if (mime.includes('msword')) return 'DOC';
  if (mime.includes('presentationml') || mime.includes('pptx')) return 'PPTX';
  if (mime.includes('ms-powerpoint')) return 'PPT';
  if (mime.includes('spreadsheetml') || mime.includes('xlsx')) return 'XLSX';
  if (mime.includes('ms-excel')) return 'XLS';
  if (mime.includes('json')) return 'JSON';
  if (mime.includes('csv')) return 'CSV';
  if (mime.includes('markdown')) return 'MD';
  if (mime.includes('plain')) return 'TXT';
  if (mime.includes('xml')) return 'XML';
  return null;
}

// Helper to resolve a sensible filename for clipboard pasted files where browser doesn't provide one
function resolvePastedFileName(rawFile) {
  const mimeType = (rawFile.type || '').toLowerCase();
  const rawName = (rawFile.name || '').trim();

  // If the browser provided a specific, non-generic filename with an extension, preserve it
  const hasSpecificName =
    rawName &&
    rawName !== 'image.png' &&
    rawName !== 'blob' &&
    rawName !== 'file' &&
    rawName.includes('.');

  if (hasSpecificName) {
    return rawName;
  }

  // Derive extension from mime type
  const mimeExt = getExtensionFromMime(mimeType);
  let ext = (mimeExt || 'png').toLowerCase();

  const isImage = mimeType.startsWith('image/') || SUPPORTED_IMAGE_EXTENSIONS.has(ext.toUpperCase());
  const prefix = isImage ? 'pasted-image' : 'pasted-file';
  return `${prefix}.${ext}`;
}

// Helper to detect if a drag event involves external files (and not dragged text/elements)
function isFileDragEvent(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) return false;
  const types = e.dataTransfer.types;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') {
      return true;
    }
  }
  return false;
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}

/**
 * ChatArea Component
 * Coordinates the scrollable message stream / welcome state,
 * error retries, and the fixed bottom message composer with professional voice dictation.
 *
 * @param {Object} props
 * @param {string|null} [props.activeChatId=null]
 * @param {Array} props.messages
 * @param {boolean} [props.isLoading=false]
 * @param {string} props.inputValue
 * @param {(val: string) => void} props.onInputChange
 * @param {() => void} props.onSubmit
 * @param {string|null} [props.activeTitle=null]
 * @param {(failedMessage: Object) => void} [props.onRetry]
 * @param {(promptText: string) => void} [props.onRestorePrompt]
 * @param {string} [props.selectedProvider='gemini']
 * @param {string} [props.activeMode='general']
 * @param {(mode: string) => void} [props.onSelectMode]
 * @param {string|null} [props.modeChangeNotice=null]
 * @param {() => void} [props.onDismissModeNotice]
 */
export default function ChatArea({
  activeChatId = null,
  messages = [],
  isLoading = false,
  messagesLoading = false,
  isNewChat = true,
  username = null,
  inputValue = '',
  onInputChange,
  onSubmit,
  activeTitle = null,
  onRetry,
  onSwitchProvider,
  onRestorePrompt,
  onRegenerate,
  onGenerateAlternative,
  onSwitchAlternative,
  onStopGenerating,
  onEditResend,
  editingMessageId = null,
  onStartEdit,
  onCancelEdit,
  selectedProvider = 'gemini',
  enterToSend = true,
  showTimestamps = true,
  activeMode = 'general',
  onSelectMode,
  modeChangeNotice = null,
  onDismissModeNotice,
  isOffline = false,
  webllmState = null,
  webllmGpuCheck = null,
  webllmModelId = DEFAULT_WEBLLM_MODEL_ID,
  onSelectWebLLMModel,
  onLoadWebLLMModel,
  onCancelWebLLMLoad,
  onUnloadWebLLMModel,
  providerConfig = null
}) {
  const textareaRef = useRef(null);
  const langMenuRef = useRef(null);
  const scrollViewportRef = useRef(null);
  const fileInputRef = useRef(null);

  // Selected file attachments state (strictly capped at 1 attachment per user message)
  const [attachments, setAttachments] = useState([]);
  const [attachmentNotice, setAttachmentNotice] = useState(null);
  const [previewingComposerAttachment, setPreviewingComposerAttachment] = useState(null);

  // Mobile/compact viewport & multiline expansion tracking
  const [isCompactViewport, setIsCompactViewport] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  );
  const [isExpandedInput, setIsExpandedInput] = useState(false);

  // Drag-and-drop file attachment state
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragDepthRef = useRef(0);

  // Auto-dismiss attachment notice after 5 seconds
  useEffect(() => {
    if (!attachmentNotice) return;
    const timer = setTimeout(() => {
      setAttachmentNotice(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [attachmentNotice]);

  // Track unsubmitted attachments in a ref so object URLs are revoked only on component unmount
  // (individual removal is handled in handleRemoveAttachment; revoking on every attachments array change
  // would prematurely revoke previewUrl when attachments are cleared upon message submission)
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((att) => {
        if (att.previewUrl) {
          try {
            URL.revokeObjectURL(att.previewUrl);
          } catch (_) {}
        }
      });
    };
  }, []);

  const handleAttachClick = () => {
    if (attachments.length > 0) {
      setAttachmentNotice('Only one attachment can be added per message. Remove the current attachment first to select a different one.');
      return;
    }
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  /**
   * Unified attachment processor shared by upload button, clipboard paste, and drag & drop.
   * Enforces 1-attachment limit, 25MB size restriction, format whitelist, and image preview generation.
   */
  const processAttachment = (rawFile, { isPaste = false, isDrop = false } = {}) => {
    if (!rawFile) return;

    // Strict Rule 1: One-attachment limit check
    if (attachments.length > 0) {
      const notice = isDrop
        ? 'Only one attachment can be added per message. Remove the current attachment before adding another file.'
        : isPaste
        ? 'Only one attachment can be added per message. Remove the current attachment before pasting another file.'
        : 'Only one attachment can be added per message. Remove the current attachment first to select a different one.';
      setAttachmentNotice(notice);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    // Determine final filename (preserving original where available, generating sensible name for pasted data)
    const resolvedName = (isPaste || isDrop) ? resolvePastedFileName(rawFile) : rawFile.name;

    // Enforce 25MB maximum size limit
    const MAX_FILE_SIZE = 25 * 1024 * 1024;
    if (rawFile.size > MAX_FILE_SIZE) {
      setAttachmentNotice(`File '${resolvedName}' exceeds the maximum allowed size of 25MB.`);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    // Determine extension
    let ext = resolvedName.includes('.')
      ? resolvedName.split('.').pop().toUpperCase()
      : (getExtensionFromMime(rawFile.type) || 'FILE');

    const isImage =
      SUPPORTED_IMAGE_EXTENSIONS.has(ext) ||
      Boolean(rawFile.type && rawFile.type.startsWith('image/'));

    // Validate against supported formats
    const isSupported =
      SUPPORTED_EXTENSIONS.has(ext) ||
      (isImage && SUPPORTED_IMAGE_EXTENSIONS.has(ext)) ||
      Boolean(getExtensionFromMime(rawFile.type));

    if (!isSupported) {
      setAttachmentNotice(
        `File '${resolvedName}' has an unsupported file format. Supported formats include PNG, JPG, WEBP, GIF, PDF, DOCX, TXT, PPTX, XLSX, CSV, JSON, and MD.`
      );
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    // Reconstruct File object if filename or type needs normalization (e.g. pasted screenshots)
    let file = rawFile;
    if ((isPaste || isDrop) && rawFile.name !== resolvedName) {
      try {
        file = new File([rawFile], resolvedName, {
          type: rawFile.type || (isImage ? `image/${ext.toLowerCase()}` : 'application/octet-stream'),
          lastModified: rawFile.lastModified || Date.now()
        });
      } catch (_) {
        file = rawFile;
      }
    }

    let previewUrl = null;
    if (isImage) {
      try {
        previewUrl = URL.createObjectURL(file);
      } catch (err) {
        console.warn('Could not generate image thumbnail preview URL:', err);
      }
    }

    const singleAttachment = {
      id: `att-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      name: resolvedName,
      size: file.size,
      formattedSize: formatFileSize(file.size),
      type: file.type || (isImage ? `image/${ext.toLowerCase()}` : 'application/octet-stream'),
      extension: ext,
      isImage,
      previewUrl,
      file
    };

    if (isOffline && isImage && selectedProvider === 'webllm') {
      setAttachmentNotice(
        `Notice: Image text extraction (OCR) requires an internet connection. To chat offline with Browser AI, please attach a text-based document (PDF, DOCX, PPTX, TXT, MD, CSV, JSON, XML).`
      );
    } else {
      setAttachmentNotice(null);
    }
    setAttachments([singleAttachment]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    // Keep textarea focused so user can type prompt immediately after attaching
    if ((isPaste || isDrop) && textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleFileChange = (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (attachments.length > 0) {
      setAttachmentNotice('Only one attachment can be added per message. Remove the current attachment first to select a different one.');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    if (files.length > 1) {
      setAttachmentNotice('Only one attachment can be added per message. Please select a single file or image.');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    processAttachment(files[0], { isPaste: false, isDrop: false });
  };

  /**
   * Clipboard paste handler for the chat composer.
   * Detects copied images or supported files pasted via Ctrl + V and converts them
   * into attachments, while allowing normal text paste to proceed unhindered.
   */
  const handlePaste = (e) => {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    const files = clipboardData.files;

    // Detect if clipboard has any file/image items
    const candidateFiles = [];

    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        candidateFiles.push(files[i]);
      }
    } else if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            candidateFiles.push(file);
          }
        }
      }
    }

    // CRITICAL: If no file/image data is in clipboard (plain text, URL, code, etc.),
    // DO NOT prevent default! Allow normal text paste into textarea.
    if (candidateFiles.length === 0) {
      return;
    }

    // An image or file was pasted: intercept the paste event so raw paths/data aren't typed
    e.preventDefault();

    // Enforce one-attachment limit
    if (attachments.length > 0) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Remove the current attachment before pasting another file.'
      );
      return;
    }

    // Reject multiple files pasted at once
    if (candidateFiles.length > 1) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Please paste a single file or image.'
      );
      return;
    }

    processAttachment(candidateFiles[0], { isPaste: true, isDrop: false });
  };

  /**
   * Drag & Drop event handlers.
   * Allows dragging and dropping an image or supported file directly into the chatbot.
   */
  const handleDragEnter = (e) => {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDraggingOver(true);
  };

  const handleDragOver = (e) => {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    if (!isDraggingOver) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e) => {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDraggingOver(false);
    }
  };

  const handleDrop = (e) => {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingOver(false);

    const dt = e.dataTransfer;
    if (!dt) return;

    const candidateFiles = [];
    if (dt.files && dt.files.length > 0) {
      for (let i = 0; i < dt.files.length; i++) {
        candidateFiles.push(dt.files[i]);
      }
    } else if (dt.items && dt.items.length > 0) {
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            candidateFiles.push(file);
          }
        }
      }
    }

    if (candidateFiles.length === 0) {
      return;
    }

    // Strict Rule 1: One-attachment limit check for drop
    if (attachments.length > 0) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Remove the current attachment before adding another file.'
      );
      return;
    }

    // Strict Rule 2: Multi-file drop rejection
    if (candidateFiles.length > 1) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Please drop one file at a time.'
      );
      return;
    }

    processAttachment(candidateFiles[0], { isPaste: false, isDrop: true });
  };

  // Prevent browser default file open behavior when dragged or dropped anywhere on window
  useEffect(() => {
    const handleWindowDragOver = (e) => {
      if (isFileDragEvent(e)) {
        e.preventDefault();
      }
    };
    const handleWindowDrop = (e) => {
      if (isFileDragEvent(e)) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, []);

  const handleRemoveAttachment = (idToRemove) => {
    setAttachmentNotice(null);
    setPreviewingComposerAttachment((prev) => (prev?.id === idToRemove ? null : prev));
    setAttachments((prev) => {
      const removed = prev.find((att) => att.id === idToRemove);
      if (removed?.previewUrl) {
        try {
          URL.revokeObjectURL(removed.previewUrl);
        } catch (_) {}
      }
      return [];
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    });
  };

  // Floating scroll-to-bottom button visibility
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // References to track scroll position and conversation switching lifecycle
  const pendingTopScrollChatIdRef = useRef(activeChatId || null);
  const prevActiveChatIdRef = useRef(activeChatId || null);
  const prevMessagesCountRef = useRef(messages.length);
  const isUserFollowingBottomRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const isAutoScrollingRef = useRef(false);
  const isTouchScrollingRef = useRef(false);

  // Language dropdown toggle state
  const [langMenuOpen, setLangMenuOpen] = useState(false);

  // AI Transcript Refinement (Phase 4) state
  const [isCleaningTranscript, setIsCleaningTranscript] = useState(false);
  const [suggestedRefinement, setSuggestedRefinement] = useState(null);

  // Dismiss transcript refinement review dialog on Escape
  useEffect(() => {
    if (!suggestedRefinement) return;
    const handleRefinementEsc = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggestedRefinement(null);
      }
    };
    window.addEventListener('keydown', handleRefinementEsc);
    return () => window.removeEventListener('keydown', handleRefinementEsc);
  }, [suggestedRefinement]);

  // Stabilize message action callbacks passed to MessageList and ChatMessage so typing in
  // the composer or streaming tokens does not force full-thread re-renders
  const messageCallbacksRef = useRef({
    onRetry,
    onSwitchProvider,
    onRestorePrompt,
    onRegenerate,
    onGenerateAlternative,
    onSwitchAlternative,
    onStopGenerating,
    onStartEdit,
    onCancelEdit,
    onEditResend
  });
  messageCallbacksRef.current = {
    onRetry,
    onSwitchProvider,
    onRestorePrompt,
    onRegenerate,
    onGenerateAlternative,
    onSwitchAlternative,
    onStopGenerating,
    onStartEdit,
    onCancelEdit,
    onEditResend
  };

  const stableOnRetry = useCallback((...args) => messageCallbacksRef.current.onRetry?.(...args), []);
  const stableOnSwitchProvider = useCallback((...args) => messageCallbacksRef.current.onSwitchProvider?.(...args), []);
  const stableOnRestorePrompt = useCallback((...args) => messageCallbacksRef.current.onRestorePrompt?.(...args), []);
  const stableOnRegenerate = useCallback((...args) => messageCallbacksRef.current.onRegenerate?.(...args), []);
  const stableOnGenerateAlternative = useCallback((...args) => messageCallbacksRef.current.onGenerateAlternative?.(...args), []);
  const stableOnSwitchAlternative = useCallback((...args) => messageCallbacksRef.current.onSwitchAlternative?.(...args), []);
  const stableOnStopGenerating = useCallback((...args) => messageCallbacksRef.current.onStopGenerating?.(...args), []);
  const stableOnStartEdit = useCallback((...args) => messageCallbacksRef.current.onStartEdit?.(...args), []);
  const stableOnCancelEdit = useCallback((...args) => messageCallbacksRef.current.onCancelEdit?.(...args), []);
  const stableOnEditResend = useCallback((...args) => messageCallbacksRef.current.onEditResend?.(...args), []);

  const messagesLengthRef = useRef(messages.length);
  messagesLengthRef.current = messages.length;

  // Check if the most recent message ended with an invitation to continue a partitioned response
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const canContinueLastMessage =
    !isLoading &&
    lastMessage &&
    lastMessage.sender === 'assistant' &&
    !lastMessage.isError &&
    !lastMessage.isStopped &&
    responseHasContinuationNotice(lastMessage.content);

  // Computes distance from bottom and updates floating button visibility
  const updateScrollButtonVisibility = useCallback(() => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;

    // Show button only if there are messages and user is sufficiently far (> 110px) from bottom
    const shouldShow = messagesLengthRef.current > 0 && distanceFromBottom > 110;
    setShowScrollBottom((prev) => (prev === shouldShow ? prev : shouldShow));
  }, []);

  // Smoothly scrolls viewport to bottom
  const handleScrollToBottom = () => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    isUserFollowingBottomRef.current = true;
    isAutoScrollingRef.current = true;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth'
    });
    setTimeout(() => {
      isAutoScrollingRef.current = false;
      if (scrollViewportRef.current) {
        lastScrollTopRef.current = scrollViewportRef.current.scrollTop;
      }
      updateScrollButtonVisibility();
    }, 320);
  };

  // Passive scroll event handler that respects user upward scroll intent during streaming
  const handleScroll = () => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    const currentScrollTop = scrollContainer.scrollTop;
    const distanceFromBottom =
      scrollContainer.scrollHeight - currentScrollTop - scrollContainer.clientHeight;

    if (!isAutoScrollingRef.current) {
      // If user scrolled upward by more than 5px, immediately stop forcing auto-scroll
      if (currentScrollTop < lastScrollTopRef.current - 5) {
        isUserFollowingBottomRef.current = false;
      } else if (distanceFromBottom <= 56) {
        // User scrolled back to the bottom
        isUserFollowingBottomRef.current = true;
      }
    }

    lastScrollTopRef.current = currentScrollTop;
    updateScrollButtonVisibility();
  };

  const handleViewportTouchStart = () => {
    isTouchScrollingRef.current = true;
  };

  const handleViewportTouchEnd = () => {
    isTouchScrollingRef.current = false;
  };

  // Window & visualViewport resize listener to keep button visibility updated and anchor bottom when mobile keyboard opens
  useEffect(() => {
    const handleResize = () => {
      setIsCompactViewport(window.innerWidth < 768);
      if (
        isUserFollowingBottomRef.current &&
        scrollViewportRef.current &&
        messagesLengthRef.current > 0 &&
        document.documentElement.classList.contains('is-keyboard-open')
      ) {
        isAutoScrollingRef.current = true;
        scrollViewportRef.current.scrollTop = scrollViewportRef.current.scrollHeight;
        lastScrollTopRef.current = scrollViewportRef.current.scrollTop;
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = false;
        });
      }
      updateScrollButtonVisibility();
    };
    window.addEventListener('resize', handleResize);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', handleResize);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      if (vv) {
        vv.removeEventListener('resize', handleResize);
      }
    };
  }, [updateScrollButtonVisibility]);

  // Handle conversation switching / opening:
  // Starts each opened conversation at the top (scrollTop = 0)
  useEffect(() => {
    if (activeChatId !== prevActiveChatIdRef.current) {
      prevActiveChatIdRef.current = activeChatId;
      isUserFollowingBottomRef.current = false;
      lastScrollTopRef.current = 0;

      if (activeChatId) {
        // An existing conversation was opened or switched to
        pendingTopScrollChatIdRef.current = activeChatId;
        if (scrollViewportRef.current) {
          scrollViewportRef.current.scrollTop = 0;
        }
      } else {
        // Switched to empty New Chat
        pendingTopScrollChatIdRef.current = null;
        if (scrollViewportRef.current) {
          scrollViewportRef.current.scrollTop = 0;
        }
        setShowScrollBottom(false);
      }
    }
  }, [activeChatId]);

  // Handle scroll positioning on message rendering and response streaming
  useEffect(() => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    // 1. Initial positioning for opened conversation:
    // When messages finish loading and are rendered, ensure scroll starts at the top
    if (pendingTopScrollChatIdRef.current && activeChatId === pendingTopScrollChatIdRef.current) {
      if (!messagesLoading && messages.length > 0) {
        requestAnimationFrame(() => {
          if (scrollContainer && pendingTopScrollChatIdRef.current === activeChatId) {
            scrollContainer.scrollTop = 0;
            lastScrollTopRef.current = 0;
          }
          requestAnimationFrame(() => {
            if (scrollContainer && pendingTopScrollChatIdRef.current === activeChatId) {
              scrollContainer.scrollTop = 0;
              lastScrollTopRef.current = 0;
              pendingTopScrollChatIdRef.current = null;
              updateScrollButtonVisibility();
            }
          });
        });
        prevMessagesCountRef.current = messages.length;
        return;
      }
    }

    // 2. Newly submitted user message or started assistant response
    const isNewMessage = messages.length > prevMessagesCountRef.current;
    const lastMessage = messages[messages.length - 1];
    prevMessagesCountRef.current = messages.length;

    if (isNewMessage) {
      if (lastMessage?.sender === 'user' || lastMessage?.isStreaming) {
        isUserFollowingBottomRef.current = true;
        isAutoScrollingRef.current = true;
        requestAnimationFrame(() => {
          if (scrollContainer) {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: 'smooth'
            });
            lastScrollTopRef.current = scrollContainer.scrollTop;
            updateScrollButtonVisibility();
          }
          setTimeout(() => {
            isAutoScrollingRef.current = false;
          }, 260);
        });
        return;
      }
    }

    // 3. AI response streaming: follow bottom ONLY if user is actively following bottom
    // and not currently dragging upward on a touch screen
    if (lastMessage?.isStreaming) {
      if (isUserFollowingBottomRef.current && !isTouchScrollingRef.current) {
        isAutoScrollingRef.current = true;
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        lastScrollTopRef.current = scrollContainer.scrollTop;
        requestAnimationFrame(() => {
          isAutoScrollingRef.current = false;
        });
      }
      updateScrollButtonVisibility();
      return;
    }

    // Normal re-renders: update button state without changing scroll position
    updateScrollButtonVisibility();
  }, [messages, messagesLoading, activeChatId, updateScrollButtonVisibility]);

  // Hook into upgraded speech recognition engine (Phase 5.2 audio capture, Phase 5.3 Whisper transcription, Phase 5.4 cross-browser & mobile reliability)
  const {
    recordingState,
    engineMode,
    isListening,
    isPaused,
    isRequesting,
    isFinalizing,
    isTranscribing,
    isSupported,
    isFirefox,
    isIOS,
    isSafari,
    dictationError,
    interimTranscript,
    lastSessionTranscript,
    selectedLanguage,
    setSelectedLanguage,
    supportedLanguages,
    audioLevel,
    audioFrequencies,
    waveformBars,
    recordingDuration,
    formattedDuration,
    startListening,
    pauseListening,
    resumeListening,
    stopListening,
    cancelListening,
    keepLiveTranscript,
    toggleListening,
    clearDictationError,
    clearLastSessionTranscript,
    hasRecordedAudio,
    transcriptionMeta,
    transcriptionNotice,
    clearTranscriptionNotice,
    retryTranscription
  } = useVoiceDictation({
    inputValue,
    onInputChange
  });

  const activeLang =
    supportedLanguages.find((l) => l.code === selectedLanguage) || supportedLanguages[0];

  // Screen reader announcements for dictation state changes
  const [srAnnouncement, setSrAnnouncement] = useState('');

  useEffect(() => {
    if (dictationError) {
      setSrAnnouncement(`Dictation error: ${dictationError}`);
      return;
    }
    switch (recordingState) {
      case 'requesting':
        setSrAnnouncement('Requesting microphone permission');
        break;
      case 'listening':
        setSrAnnouncement('Microphone recording active. Speak naturally.');
        break;
      case 'paused':
        setSrAnnouncement('Dictation paused.');
        break;
      case 'stopping':
        setSrAnnouncement('Stopping recording.');
        break;
      case 'transcribing':
        setSrAnnouncement('Transcribing audio transcript.');
        break;
      case 'success':
        setSrAnnouncement('Dictation transcript inserted into message composer. Text is ready to edit or send.');
        break;
      case 'cancelled':
        setSrAnnouncement('Dictation cancelled. Audio discarded and previous text restored.');
        break;
      default:
        break;
    }
  }, [recordingState, dictationError]);

  // Cleanly abort any active microphone dictation session when switching conversations
  useEffect(() => {
    if (
      recordingState === 'listening' ||
      recordingState === 'paused' ||
      recordingState === 'requesting' ||
      recordingState === 'stopping' ||
      recordingState === 'transcribing'
    ) {
      cancelListening();
    }
  }, [activeChatId, cancelListening]);

  const handleStopListening = async () => {
    await stopListening();
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const len = textareaRef.current.value.length;
        try {
          textareaRef.current.setSelectionRange(len, len);
        } catch (_) {}
      }
    });
  };

  const handleCancelListening = () => {
    cancelListening();
    setSuggestedRefinement(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    });
  };

  const handleToggleListening = () => {
    if (recordingState === 'listening') {
      void handleStopListening();
    } else if (recordingState === 'paused') {
      resumeListening();
    } else if (recordingState === 'requesting') {
      handleCancelListening();
    } else if (
      recordingState === 'stopping' ||
      recordingState === 'finalizing' ||
      recordingState === 'transcribing' ||
      recordingState === 'success'
    ) {
      // Safe guard: ignore multi-tap while actively stopping, transcribing, or finalizing
      return;
    } else {
      startListening();
    }
  };

  // Close language menu when clicking/tapping outside or pressing Escape
  useEffect(() => {
    if (!langMenuOpen) return;
    const handleClickOutside = (e) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target)) {
        setLangMenuOpen(false);
      }
    };
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setLangMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside, { passive: true });
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [langMenuOpen]);

  // Deterministic multiline expansion hysteresis on mobile viewports so typing doesn't oscillate layout
  useEffect(() => {
    if (!inputValue) {
      setIsExpandedInput(false);
      return;
    }
    const hasNewline = inputValue.includes('\n');
    const len = inputValue.length;
    setIsExpandedInput((prev) => {
      if (hasNewline || len >= 42) return true;
      if (!hasNewline && len < 24) return false;
      return prev;
    });
  }, [inputValue]);

  // Auto-resize textarea according to text length and follow speech stream
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const baseHeight = isCompactViewport ? 38 : 36;
    if (!inputValue) {
      el.style.height = `${baseHeight}px`;
      return;
    }
    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    const isKbOpen =
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('is-keyboard-open');
    const maxHeight = isCompactViewport ? (isKbOpen ? 120 : 144) : 180;
    const newHeight = Math.min(Math.max(scrollHeight, baseHeight), maxHeight);
    el.style.height = `${newHeight}px`;
    if (recordingState === 'listening' || recordingState === 'paused') {
      el.scrollTop = el.scrollHeight;
    }
  }, [inputValue, recordingState, isExpandedInput, isCompactViewport]);
  // Keep refs to avoid stale closures in global keydown listener
  const inputValueRef = useRef(inputValue);
  useEffect(() => {
    inputValueRef.current = inputValue;
  }, [inputValue]);

  const onInputChangeRef = useRef(onInputChange);
  useEffect(() => {
    onInputChangeRef.current = onInputChange;
  }, [onInputChange]);

  // Automatic input focus when the user starts typing on the keyboard
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleGlobalKeyDown = (e) => {
      // 1. If textarea does not exist or is already focused, do nothing
      if (!textareaRef.current || document.activeElement === textareaRef.current) {
        return;
      }

      // 2. Ignore modifier shortcuts (Ctrl, Cmd, Alt) to preserve browser shortcuts & OS commands (Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, Ctrl+F, etc.)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      // 3. Ignore non-printable keys (Enter, Tab, Escape, Backspace, Delete, Arrows, F1-F12, etc.) and Space
      if (!e.key || e.key.length !== 1 || e.key === ' ') {
        return;
      }

      // 4. Ignore if user is composing with an IME (Chinese, Japanese, etc.)
      if (e.isComposing || e.keyCode === 229) {
        return;
      }

      // 5. Check if another editable element or input currently has focus
      const activeEl = document.activeElement;
      if (activeEl) {
        const tagName = activeEl.tagName?.toLowerCase();
        if (
          tagName === 'input' ||
          tagName === 'textarea' ||
          tagName === 'select' ||
          activeEl.isContentEditable ||
          activeEl.getAttribute?.('contenteditable') === 'true'
        ) {
          return;
        }

        // If a button or link is focused, let it retain focus for standard accessibility navigation
        // unless it's an ordinary character key (letters, numbers, symbols)
        const role = activeEl.getAttribute?.('role');
        const isInteractive =
          tagName === 'button' ||
          tagName === 'a' ||
          role === 'button' ||
          role === 'menuitem' ||
          role === 'option' ||
          role === 'radio' ||
          role === 'tab' ||
          role === 'switch' ||
          role === 'checkbox';

        if (isInteractive && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab' || e.key === 'Escape')) {
          return;
        }
      }

      // 6. Check if any modal or dialog is currently open
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], .modal-backdrop, .settings-modal-backdrop, .document-preview-overlay, .auth-modal-backdrop'
        )
      ) {
        return;
      }

      // 7. Legitimate typing detected while chat textarea was not focused!
      // Prevent browser default action for this key to prevent scroll or conflict
      e.preventDefault();

      const currentVal = inputValueRef.current || '';
      const start = textareaRef.current.selectionStart ?? currentVal.length;
      const end = textareaRef.current.selectionEnd ?? start;
      const before = currentVal.slice(0, start);
      const after = currentVal.slice(end);
      const newVal = before + e.key + after;
      const newCursorPos = before.length + e.key.length;

      // Update state and textarea value synchronously
      if (onInputChangeRef.current) {
        onInputChangeRef.current(newVal);
      }
      textareaRef.current.value = newVal;

      // Auto-adjust textarea height immediately
      try {
        textareaRef.current.style.height = 'auto';
        const newHeight = Math.min(textareaRef.current.scrollHeight, 180);
        textareaRef.current.style.height = `${Math.max(newHeight, 36)}px`;
      } catch (_) {}

      // Focus the textarea and set cursor directly after the inserted character
      textareaRef.current.focus();
      try {
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      } catch (_) {}
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);
  const submitComposerMessage = async (textToSend) => {
    if (!onSubmit || (!textToSend.trim() && attachments.length === 0) || isLoading) {
      return;
    }
    const currentAttachments = [...attachments];
    setPreviewingComposerAttachment(null);
    setAttachments([]);
    try {
      const result = await onSubmit(currentAttachments, textToSend !== inputValue ? textToSend : null);
      if (result === false && currentAttachments.length > 0) {
        setAttachments((prev) => (prev.length === 0 ? currentAttachments : prev));
      }
    } catch (_) {
      if (currentAttachments.length > 0) {
        setAttachments((prev) => (prev.length === 0 ? currentAttachments : prev));
      }
    }
  };

  const handleKeyDown = async (e) => {
    if (e.key === 'Escape' && langMenuOpen) {
      e.preventDefault();
      setLangMenuOpen(false);
      return;
    }

    if (e.key === 'Escape' && isRecordingActive) {
      e.preventDefault();
      handleCancelListening();
      return;
    }

    if (e.key === 'Escape' && isLoading && onStopGenerating) {
      e.preventDefault();
      onStopGenerating();
      return;
    }

    // Ignore Enter if user is actively composing with an IME (Chinese, Japanese, etc.)
    if (e.nativeEvent?.isComposing) {
      return;
    }

    const isModifierEnter = (e.ctrlKey || e.metaKey) && e.key === 'Enter';
    const isPlainEnter = e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey;

    const shouldSend = enterToSend
      ? isPlainEnter || isModifierEnter
      : isModifierEnter;

    if (shouldSend) {
      e.preventDefault();
      let textToSend = inputValue;
      if (isListening || isPaused || isRequesting) {
        const completed = await stopListening();
        if (typeof completed === 'string' && completed.trim()) {
          textToSend = completed;
        }
      }
      clearLastSessionTranscript();
      setSuggestedRefinement(null);
      void submitComposerMessage(textToSend);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    let textToSend = inputValue;
    if (isListening || isPaused || isRequesting) {
      const completed = await stopListening();
      if (typeof completed === 'string' && completed.trim()) {
        textToSend = completed;
      }
    }
    clearLastSessionTranscript();
    setSuggestedRefinement(null);
    void submitComposerMessage(textToSend);
  };

  // Optional AI Transcript Refinement Handler (Phase 4 & Phase 6.2)
  const handleImproveTranscript = async () => {
    if (!lastSessionTranscript || isCleaningTranscript) return;
    setIsCleaningTranscript(true);

    try {
      let polished = '';

      try {
        const cleanPrompt = `You are a specialized, context-aware speech-to-text transcript polisher for AI conversation and programming.

TASK:
Improve punctuation, capitalization, and phonetic speech recognition glitches in the provided spoken transcript while strictly preserving the speaker's original intent, task, and meaning.

CONTEXT-AWARE TECHNICAL DISAMBIGUATION RULES:
1. Sentence Context Governs Technical Corrections:
   - Analyze surrounding sentence grammar, phrasing, and the programming domain to distinguish intended concepts.
   - Example: In "code for pedrandom" or "palindrome checker", the speaker requests a classic programming problem ("palindrome"). Do NOT substitute "Math.random" or an unrelated API when the context clearly requests an algorithmic task.
   - Example: In "using Math.random" or "generate random numbers with Math.random", the user genuinely wants the random API. Preserve "Math.random" as-is.
   - Example: In "difference between a palindrome and Math.random", keep both terms distinct and accurately spelled.
   - Example: In an asynchronous programming context alongside "promises" or "callbacks", "sync await" is an obvious phonetic glitch for "async await" (or "async/await").
   - Example: In a list of declaration keywords like "var, constant, let", "constant" contextually refers to "const".

2. Preserve Legitimate Technical Vocabulary:
   - Valid technical terms, programming identifiers, and APIs (such as JavaScript, ECMAScript, palindrome, Math.random, var, const, let, functions, arrow functions, objects, arrays, callbacks, promises, async/await, hoisting, React, useState, useEffect, Node.js, Express, Firebase, TypeScript, etc.) must NEVER be replaced with an unrelated term simply because of surface phonetic similarities.

3. Minimal & Conservative Edits:
   - Fix punctuation (commas, periods, question marks, capitalization).
   - Only correct obvious phonetic recognition slips that are strongly supported by the surrounding context.
   - If a word's meaning cannot be confidently determined from the surrounding context, PRESERVE the original wording rather than making a speculative technical substitution.
   - NEVER invent requirements, add unrequested libraries or APIs, or omit topics mentioned by the user.
   - DO NOT summarize, rephrase, or restructure the sentence.
   - DO NOT translate (preserve the speaker's language, e.g. English, Urdu, etc.).

OUTPUT FORMAT:
Return ONLY the polished transcript text with no explanations, no introductory phrases, no markdown fences, and no surrounding quotes.

Transcript:
"${lastSessionTranscript}"`;

        const shouldUseActiveProviderForPolish =
          selectedProvider !== 'webllm' || webllmState?.status === 'ready';

        const res = shouldUseActiveProviderForPolish
          ? await sendAIMessage({
              provider: selectedProvider || 'gemini',
              model: selectedProvider === 'webllm' ? webllmModelId : null,
              prompt: cleanPrompt,
              history: [],
              username: null
            })
          : null;

        if (res && res.text) {
          let text = res.text.trim();
          // Strip markdown code fences if present
          if (text.startsWith('```')) {
            text = text.replace(/^```[a-zA-Z0-9_-]*\n?/i, '').replace(/\n?```$/i, '').trim();
          }
          // Strip common AI conversational prefixes if any leaked
          text = text.replace(/^(?:here(?:'s| is) (?:the )?(?:polished|refined|corrected) transcript:?\s*)/i, '').trim();
          // Strip wrapping quotes
          text = text.replace(/^["'«»“](.*)["'«»”]$/s, '$1').trim();

          // Reject if the response is an unintended code block or simulated chatbot response
          if (
            text &&
            !text.includes('function handleUserMessage') &&
            !text.includes('**[Simulated Response') &&
            !text.includes('export function solveProblem') &&
            !text.includes('Clean implementation')
          ) {
            polished = text;
          }
        }
      } catch (networkErr) {
        console.warn('Network transcript refinement failed, falling back to local polisher:', networkErr);
      }

      // If remote AI returned empty, failed, or was rejected, apply deterministic contextual polisher
      if (!polished) {
        polished = polishSpokenTranscript(lastSessionTranscript, inputValue);
      }

      if (polished) {
        setSuggestedRefinement(polished);
      }
    } catch (err) {
      console.warn('Transcript refinement failed:', err);
    } finally {
      setIsCleaningTranscript(false);
    }
  };

  const handleApplyRefinement = () => {
    if (!suggestedRefinement) return;

    if (inputValue.includes(lastSessionTranscript)) {
      onInputChange(inputValue.replace(lastSessionTranscript, suggestedRefinement));
    } else {
      onInputChange(suggestedRefinement);
    }

    setSuggestedRefinement(null);
    clearLastSessionTranscript();
  };

  const hasContent = inputValue.trim().length > 0 || attachments.length > 0;
  const hasMessages = messages.length > 0;
  // Dictation dock is active when actively requesting, listening, paused, stopping, finalizing, transcribing, success, or cancelled
  const isRecordingActive =
    recordingState === 'listening' ||
    recordingState === 'paused' ||
    recordingState === 'requesting' ||
    recordingState === 'stopping' ||
    recordingState === 'finalizing' ||
    recordingState === 'transcribing' ||
    recordingState === 'success' ||
    recordingState === 'cancelled';

  const normalComposerPlaceholder = isCompactViewport
    ? activeMode === 'coding'
      ? 'Ask a coding question...'
      : activeMode === 'writing'
      ? 'Draft or polish text...'
      : activeMode === 'learning'
      ? 'Ask to explain a topic...'
      : 'Message Orvix...'
    : activeMode === 'coding'
    ? 'Ask a coding question, debug an error, or request code...'
    : activeMode === 'writing'
    ? 'Draft an email, polish prose, or rewrite content...'
    : activeMode === 'learning'
    ? 'Ask to explain a concept, break down a topic, or quiz you...'
    : 'Message Orvix...';

  // Single source of truth for composer placeholder:
  // On mobile when the expanded Recording panel is active, keep the composer displaying the normal prompt
  // so the composer does NOT render a competing "Listening — speak or..." state underneath the Recording panel.
  const composerPlaceholder = isLoading
    ? isCompactViewport
      ? 'Generating response...'
      : 'Generating response — press Esc to stop...'
    : isCompactViewport && isRecordingActive
    ? normalComposerPlaceholder
    : isListening
    ? isCompactViewport
      ? 'Listening — speak or type...'
      : 'Listening — speak naturally or type...'
    : isPaused
    ? isCompactViewport
      ? 'Paused — resume or type...'
      : 'Dictation paused — resume or type...'
    : isRequesting
    ? 'Connecting microphone...'
    : normalComposerPlaceholder;

  return (
    <main
      className={`chat-area-container ${isDraggingOver ? 'is-drag-over' : ''}`}
      role="main"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Scrollable Viewport */}
      <div
        ref={scrollViewportRef}
        className="chat-scroll-viewport"
        onScroll={handleScroll}
        onTouchStart={handleViewportTouchStart}
        onTouchEnd={handleViewportTouchEnd}
        onTouchCancel={handleViewportTouchEnd}
      >
        <div className="chat-content-constrained">
          {isNewChat && !hasMessages ? (
            <WelcomeScreen
              username={username}
            />
          ) : messagesLoading && !hasMessages ? (
            <div className="messages-loading-state" role="status" aria-label="Loading conversation">
              <Loader2 size={24} className="spin-icon" />
              <span>Loading conversation...</span>
            </div>
          ) : (
            <MessageList
              messages={messages}
              isLoading={isLoading}
              onRetry={onRetry ? stableOnRetry : undefined}
              onSwitchProvider={onSwitchProvider ? stableOnSwitchProvider : undefined}
              onRestorePrompt={onRestorePrompt ? stableOnRestorePrompt : undefined}
              onRegenerate={onRegenerate ? stableOnRegenerate : undefined}
              onGenerateAlternative={onGenerateAlternative ? stableOnGenerateAlternative : undefined}
              onSwitchAlternative={onSwitchAlternative ? stableOnSwitchAlternative : undefined}
              onStopGenerating={onStopGenerating ? stableOnStopGenerating : undefined}
              onEditResend={onEditResend ? stableOnEditResend : undefined}
              editingMessageId={editingMessageId}
              onStartEdit={onStartEdit ? stableOnStartEdit : undefined}
              onCancelEdit={onCancelEdit ? stableOnCancelEdit : undefined}
              showTimestamps={showTimestamps}
              selectedProvider={selectedProvider}
              activeMode={activeMode}
              providerConfig={providerConfig}
            />
          )}
        </div>
      </div>

      {/* Message Composer Dock */}
      <div className={`chat-composer-dock ${isRecordingActive ? 'is-recording-active' : ''}`}>
        <div className="chat-composer-inner">
          {/* ChatGPT-style Floating Scroll-to-Bottom Button */}
          {showScrollBottom && (
            <div className="scroll-to-bottom-dock">
              <button
                type="button"
                className={`scroll-to-bottom-btn ${lastMessage?.isStreaming ? 'has-streaming-activity' : ''}`}
                onClick={handleScrollToBottom}
                aria-label={lastMessage?.isStreaming ? 'Scroll to streaming response' : 'Scroll to newest message'}
                title={lastMessage?.isStreaming ? 'Scroll to streaming response' : 'Scroll to newest message'}
              >
                <ArrowDown size={18} aria-hidden="true" />
                {lastMessage?.isStreaming && (
                  <span className="scroll-btn-activity-dot" aria-hidden="true" />
                )}
              </button>
            </div>
          )}

          {/* Quick Continue Prompt Chip if previous response was partitioned */}
          {canContinueLastMessage && (
            <div className="continuation-prompt-chip-container">
              <button
                type="button"
                className="continuation-prompt-chip"
                onClick={() => {
                  if (onSubmit && !isLoading) {
                    onSubmit([], 'Continue');
                  }
                }}
                title="Continue from where the previous response left off"
                aria-label="Continue response"
              >
                <ArrowRight size={13} className="continuation-chip-icon" />
                <span>Continue response</span>
              </button>
            </div>
          )}

          {/* Voice Dictation Error Notification */}
          {dictationError && (
            <div className="composer-dictation-error" role="alert">
              <div className="dictation-error-content">
                <AlertCircle size={14} className="dictation-error-icon" aria-hidden="true" />
                <span>{dictationError}</span>
              </div>
              <button
                type="button"
                className="dictation-error-dismiss"
                onClick={clearDictationError}
                aria-label="Dismiss error notification"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* One Attachment Maximum Validation / Error Notification */}
          {attachmentNotice && (
            <div className="composer-dictation-error composer-attachment-alert" role="alert">
              <div className="dictation-error-content">
                <AlertCircle size={14} className="dictation-error-icon" aria-hidden="true" />
                <span>{attachmentNotice}</span>
              </div>
              <button
                type="button"
                className="dictation-error-dismiss"
                onClick={() => setAttachmentNotice(null)}
                aria-label="Dismiss attachment alert"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* Voice Dictation High-Accuracy / Fallback Notification (Phase 5.3) */}
          {transcriptionNotice && !isRecordingActive && (
            <div
              className={`composer-dictation-notice notice-${transcriptionNotice.type} ${transcriptionNotice.type}`}
              role="status"
            >
              <div className="notice-left dictation-notice-content">
                {transcriptionNotice.type === 'success' ? (
                  <Sparkles size={13} className="notice-icon success" aria-hidden="true" />
                ) : (
                  <AlertCircle size={13} className="notice-icon fallback" aria-hidden="true" />
                )}
                <span className="notice-text">{transcriptionNotice.message}</span>
              </div>
              <div className="notice-actions dictation-notice-actions">
                {transcriptionNotice.canRetry && hasRecordedAudio && (
                  <button
                    type="button"
                    className="notice-retry-btn"
                    onClick={retryTranscription}
                    title="Retry Whisper transcription on the captured audio recording"
                  >
                    Retry Whisper
                  </button>
                )}
                <button
                  type="button"
                  className="notice-dismiss-btn"
                  onClick={clearTranscriptionNotice}
                  aria-label="Dismiss notice"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Visually-hidden live region for screen-reader dictation announcements */}
          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {srAnnouncement}
          </div>

          {/* Modern Recording & Waveform Dictation Bar */}
          {isRecordingActive && (
            <div
              className={`composer-listening-bar state-${recordingState}`}
              role="region"
              aria-label="Voice dictation controls"
            >
              <div className="listening-left-group">
                <div className="listening-indicator-content">
                  <div className={`listening-mic-badge ${recordingState}`} aria-hidden="true">
                    {recordingState === 'requesting' ||
                    recordingState === 'stopping' ||
                    recordingState === 'transcribing' ||
                    recordingState === 'finalizing' ? (
                      <Loader2 size={13} className="spin-icon" />
                    ) : recordingState === 'listening' ? (
                      <span className="recording-dot-pulse" />
                    ) : recordingState === 'success' ? (
                      <Check size={13} strokeWidth={2.5} className="badge-icon success" />
                    ) : recordingState === 'cancelled' ? (
                      <X size={13} className="badge-icon cancelled" />
                    ) : (
                      <Mic size={13} />
                    )}
                  </div>
                  <span className="listening-text">
                    {recordingState === 'requesting'
                      ? 'Connecting...'
                      : recordingState === 'paused'
                      ? 'Paused'
                      : recordingState === 'stopping'
                      ? 'Stopping...'
                      : recordingState === 'transcribing'
                      ? 'Transcribing...'
                      : recordingState === 'finalizing'
                      ? 'Finishing...'
                      : recordingState === 'success'
                      ? 'Transcript ready'
                      : recordingState === 'cancelled'
                      ? 'Cancelled'
                      : 'Recording'}
                  </span>
                  <span className="listening-timer" aria-label={`Recording duration: ${formattedDuration}`}>
                    {formattedDuration}
                  </span>
                </div>

                {/* Recognition Language Selector Pill */}
                <div className="dictation-lang-wrapper" ref={isRecordingActive ? langMenuRef : undefined}>
                  <button
                    type="button"
                    className="dictation-lang-btn"
                    onClick={() => setLangMenuOpen((prev) => !prev)}
                    title={`Dictation language: ${activeLang.label}. Click to switch.`}
                    aria-label={`Select dictation language, currently ${activeLang.label}`}
                    aria-expanded={langMenuOpen}
                    aria-haspopup="menu"
                  >
                    <span className="lang-flag">{activeLang.flag}</span>
                    <span className="lang-code">{activeLang.code.split('-')[0].toUpperCase()}</span>
                    <ChevronDown size={11} className={`lang-chevron ${langMenuOpen ? 'open' : ''}`} />
                  </button>

                  {langMenuOpen && (
                    <div className="dictation-lang-dropdown" role="menu" aria-label="Recognition Language">
                      <div className="lang-dropdown-header">Recognition Language</div>
                      {supportedLanguages.map((lang) => (
                        <button
                          key={lang.code}
                          type="button"
                          role="menuitem"
                          className={`dictation-lang-option ${lang.code === selectedLanguage ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedLanguage(lang.code);
                            setLangMenuOpen(false);
                          }}
                        >
                          <span className="lang-opt-flag">{lang.flag}</span>
                          <div className="lang-opt-info">
                            <span className="lang-opt-label">{lang.label}</span>
                            <span className="lang-opt-native">{lang.native}</span>
                          </div>
                          {lang.code === selectedLanguage && <Check size={14} className="lang-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Real Waveform Visualizer (driven by Web Audio API frequency spectrum) */}
              <div
                className="listening-waveform-area"
                aria-hidden="true"
                title={isListening ? `Microphone audio level: ${audioLevel}%` : 'Microphone audio visualizer'}
              >
                <div className="waveform-visualizer">
                  {waveformBars.map((barVal, idx) => (
                    <span
                      key={idx}
                      className={`waveform-bar ${isListening ? 'active' : ''}`}
                      style={{
                        height: isListening ? `${Math.max(4, Math.round(barVal * 24))}px` : '4px',
                        opacity: isListening ? Math.max(0.35, Math.min(1, barVal * 1.5)) : 0.25
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Action Buttons: Pause/Resume, Stop, Cancel */}
              <div className="listening-actions-group">
                {recordingState === 'stopping' || recordingState === 'transcribing' || recordingState === 'finalizing' ? (
                  <button
                    type="button"
                    className="dictation-strip-btn cancel-btn"
                    onClick={handleCancelListening}
                    title="Cancel transcription and discard audio"
                    aria-label="Cancel transcription and discard audio"
                  >
                    <X size={13} className="btn-icon" aria-hidden="true" />
                    <span className="btn-label">Cancel</span>
                  </button>
                ) : recordingState === 'success' ? (
                  <div className="dictation-status-pill success" aria-hidden="true">
                    <Check size={12} strokeWidth={2.5} className="btn-icon" />
                    <span className="btn-label">Inserted</span>
                  </div>
                ) : recordingState === 'cancelled' ? (
                  <div className="dictation-status-pill cancelled" aria-hidden="true">
                    <X size={12} className="btn-icon" />
                    <span className="btn-label">Discarded</span>
                  </div>
                ) : (
                  <>
                    {recordingState === 'listening' ? (
                      <button
                        type="button"
                        className="dictation-strip-btn pause-btn"
                        onClick={pauseListening}
                        title="Pause recording"
                        aria-label="Pause recording"
                      >
                        <Pause size={12} className="btn-icon" aria-hidden="true" />
                        <span className="btn-label">Pause</span>
                      </button>
                    ) : recordingState === 'paused' ? (
                      <button
                        type="button"
                        className="dictation-strip-btn resume-btn"
                        onClick={resumeListening}
                        title="Resume recording"
                        aria-label="Resume recording"
                      >
                        <Play size={12} fill="currentColor" className="btn-icon" aria-hidden="true" />
                        <span className="btn-label">Resume</span>
                      </button>
                    ) : null}

                    <button
                      type="button"
                      className="dictation-strip-btn stop-btn"
                      onClick={handleStopListening}
                      title="Stop recording and insert transcript into composer"
                      aria-label="Stop recording and insert transcript into composer"
                    >
                      <Square size={11} fill="currentColor" className="btn-icon" aria-hidden="true" />
                      <span className="btn-label">Stop</span>
                    </button>

                    <button
                      type="button"
                      className="dictation-strip-btn cancel-btn"
                      onClick={handleCancelListening}
                      title="Cancel recording (discard audio and keep existing text)"
                      aria-label="Cancel recording and discard audio"
                    >
                      <X size={13} className="btn-icon" aria-hidden="true" />
                      <span className="btn-label">Cancel</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Optional AI Transcript Refinement Notification (Phase 4) */}
          {lastSessionTranscript && !isRecordingActive && !suggestedRefinement && (
            <div className="transcript-cleanup-banner" role="region" aria-label="Transcript helper">
              <div className="cleanup-banner-left">
                <Sparkles size={13} className="cleanup-icon" />
                <span className="cleanup-hint">Dictated speech:</span>
                <span className="cleanup-snippet">
                  "{lastSessionTranscript.length > 52 ? lastSessionTranscript.slice(0, 52) + '...' : lastSessionTranscript}"
                </span>
              </div>
              <div className="cleanup-banner-actions">
                <button
                  type="button"
                  className="cleanup-action-trigger"
                  onClick={handleImproveTranscript}
                  disabled={isCleaningTranscript}
                  title="Polish punctuation and capitalization without changing words"
                >
                  {isCleaningTranscript ? (
                    <Loader2 size={12} className="spin-icon" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>{isCleaningTranscript ? 'Polishing...' : 'Polish text'}</span>
                </button>
                <button
                  type="button"
                  className="cleanup-dismiss-btn"
                  onClick={clearLastSessionTranscript}
                  title="Dismiss helper"
                  aria-label="Dismiss transcript helper"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )}

          {/* AI Refinement Comparison Card (Phase 4) */}
          {suggestedRefinement && (
            <div className="transcript-review-card" role="dialog" aria-labelledby="review-card-title">
              <div className="review-card-header">
                <div className="review-header-left">
                  <Sparkles size={14} className="review-icon" />
                  <span id="review-card-title" className="review-title">Review Transcript Polish</span>
                </div>
                <button
                  type="button"
                  className="review-close-btn"
                  onClick={() => setSuggestedRefinement(null)}
                  aria-label="Close review"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="review-card-body">
                <div className="review-field">
                  <span className="field-label">Original:</span>
                  <p className="field-content original-text">{lastSessionTranscript}</p>
                </div>
                <div className="review-field">
                  <span className="field-label">Suggested Polish:</span>
                  <p className="field-content suggested-text">{suggestedRefinement}</p>
                </div>
              </div>

              <div className="review-card-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSuggestedRefinement(null);
                    clearLastSessionTranscript();
                  }}
                >
                  Keep original
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleApplyRefinement}
                  icon={<Check size={13} />}
                >
                  Apply Polish
                </Button>
              </div>
            </div>
          )}

          {/* Mode Change Feedback Notification Banner */}
          {modeChangeNotice && (
            <div className="mode-change-notification-banner" role="status">
              <Sparkles size={13} className="mode-notice-icon" aria-hidden="true" />
              <span className="mode-notice-text">{modeChangeNotice}</span>
              {onDismissModeNotice && (
                <button
                  type="button"
                  className="mode-notice-dismiss"
                  onClick={onDismissModeNotice}
                  title="Dismiss notification"
                  aria-label="Dismiss mode notice"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

          {/* Non-blocking Browser AI (WebLLM) Status & Progress Strip */}
          <BrowserAIStatusBar
            visible={
              selectedProvider === 'webllm' ||
              webllmState?.status === 'downloading' ||
              webllmState?.status === 'loading'
            }
            isSelectedProvider={selectedProvider === 'webllm'}
            webllmState={webllmState}
            gpuCheck={webllmGpuCheck}
            selectedModelId={webllmModelId}
            onSelectModel={onSelectWebLLMModel}
            onLoadModel={onLoadWebLLMModel}
            onCancelLoad={onCancelWebLLMLoad}
            onUnloadModel={onUnloadWebLLMModel}
            isOffline={isOffline}
          />

          {/* Drag and Drop Visual Feedback Indicator */}
          {isDraggingOver && (
            <div className="composer-drop-banner" role="status" aria-live="polite">
              <div className="composer-drop-content">
                <Paperclip size={15} className="composer-drop-icon" aria-hidden="true" />
                <span className="composer-drop-text">Drop file or image to attach</span>
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            onPaste={handlePaste}
            className={`composer-form ${isDraggingOver ? 'is-drag-over' : ''} ${isRecordingActive && !isCompactViewport ? 'is-recording' : ''} ${isExpandedInput ? 'is-expanded' : ''}`}
            aria-label="Message composer"
          >
            {/* Native file input strictly supporting one document or image at a time */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              multiple={false}
              accept=".jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.heif,image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif,image/*,.pdf,.docx,.doc,.txt,.md,.markdown,.ppt,.pptx,.csv,.tsv,.json,.xml,.xlsx,.xls,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv,application/json"
              className="composer-file-input"
              tabIndex={-1}
              aria-hidden="true"
            />

            {/* Selected attachment preview strip */}
            {attachments.length > 0 && (
              <div className="composer-attachments-preview" role="region" aria-label="Selected attachment">
                {attachments.map((att) =>
                  att.isImage ? (
                    <div
                      key={att.id}
                      className="composer-attachment-chip composer-image-chip is-previewable"
                      title={`Click to preview ${att.name} (${att.extension || 'IMG'} • ${att.formattedSize})`}
                      onClick={() => setPreviewingComposerAttachment(att)}
                    >
                      <div className="composer-image-thumb-wrap">
                        {att.previewUrl ? (
                          <img
                            src={att.previewUrl}
                            alt={att.name}
                            className="composer-image-thumb"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              const fallback = e.currentTarget.parentElement?.querySelector(
                                '.composer-image-fallback-icon'
                              );
                              if (fallback) fallback.style.display = 'flex';
                            }}
                          />
                        ) : null}
                        <div
                          className="composer-image-fallback-icon"
                          style={{ display: att.previewUrl ? 'none' : 'flex' }}
                          aria-hidden="true"
                        >
                          <FileImage size={16} />
                        </div>
                      </div>
                      <div className="composer-image-meta">
                        <span className="attachment-chip-name" title={att.name}>
                          {att.name}
                        </span>
                        <div className="attachment-chip-submeta">
                          <span className="attachment-chip-badge">{att.extension || 'IMG'}</span>
                          <span className="attachment-chip-size">{att.formattedSize}</span>
                        </div>
                      </div>
                      <div className="composer-chip-actions">
                        <button
                          type="button"
                          className="attachment-chip-preview"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewingComposerAttachment(att);
                          }}
                          title={`Preview ${att.name}`}
                          aria-label={`Preview attachment ${att.name}`}
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          type="button"
                          className="attachment-chip-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveAttachment(att.id);
                          }}
                          title={`Remove ${att.name}`}
                          aria-label={`Remove attachment ${att.name}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={att.id}
                      className="composer-attachment-chip is-previewable"
                      title={`Click to preview ${att.name} (${att.extension || 'FILE'} • ${att.formattedSize})`}
                      onClick={() => setPreviewingComposerAttachment(att)}
                    >
                      <span className="attachment-chip-badge">{att.extension || 'FILE'}</span>
                      <span className="attachment-chip-name" title={att.name}>
                        {att.name}
                      </span>
                      <span className="attachment-chip-size">{att.formattedSize}</span>
                      <div className="composer-chip-actions">
                        <button
                          type="button"
                          className="attachment-chip-preview"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewingComposerAttachment(att);
                          }}
                          title={`Preview ${att.name}`}
                          aria-label={`Preview attachment ${att.name}`}
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          type="button"
                          className="attachment-chip-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveAttachment(att.id);
                          }}
                          title={`Remove ${att.name}`}
                          aria-label={`Remove attachment ${att.name}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}

            <div className="composer-input-row">
              {/* Attachment Button */}
              <Button
                type="button"
                variant="ghost"
                size="icon-round"
                disabled={isLoading}
                onClick={handleAttachClick}
                title={
                  attachments.length > 0
                    ? `Attached: ${attachments[0].name} (1 file max per message)`
                    : 'Attach file or image (PDF, DOCX, TXT, CSV, PNG, JPG — max 25MB)'
                }
                ariaLabel={
                  attachments.length > 0
                    ? `Attachment selected: ${attachments[0].name}. Maximum one attachment per message.`
                    : 'Attach document or image'
                }
                className={`composer-attach-btn ${attachments.length > 0 ? 'has-attachment' : ''}`}
                icon={<Paperclip size={18} />}
              />

              <textarea
                ref={textareaRef}
                className="composer-textarea"
                placeholder={composerPlaceholder}
                value={inputValue}
                rows={1}
                onChange={(e) => onInputChange && onInputChange(e.target.value)}
                onFocus={() => {
                  if (scrollViewportRef.current && messagesLengthRef.current > 0) {
                    const sc = scrollViewportRef.current;
                    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
                    if (dist <= 96) {
                      isUserFollowingBottomRef.current = true;
                    }
                  }
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                aria-label="Message input"
              />

              <div className="composer-actions">
                {/* Recognition Language Selector (pre-recording) */}
                {isSupported && !isRecordingActive && (
                  <div className="dictation-lang-wrapper composer-pre-lang" ref={!isRecordingActive ? langMenuRef : undefined}>
                    <button
                      type="button"
                      className="dictation-lang-btn composer-lang-btn"
                      onClick={() => setLangMenuOpen((prev) => !prev)}
                      title={`Dictation language: ${activeLang.label}. Click to change.`}
                      aria-label={`Dictation language: ${activeLang.label}`}
                      aria-expanded={langMenuOpen}
                      aria-haspopup="menu"
                    >
                      <span className="lang-flag">{activeLang.flag}</span>
                      <span className="lang-code">{activeLang.code.split('-')[0].toUpperCase()}</span>
                      <ChevronDown size={11} className={`lang-chevron ${langMenuOpen ? 'open' : ''}`} />
                    </button>

                    {langMenuOpen && (
                      <div className="dictation-lang-dropdown" role="menu" aria-label="Dictation recognition language">
                        <div className="lang-dropdown-header">Dictation Language</div>
                        {supportedLanguages.map((lang) => (
                          <button
                            key={lang.code}
                            type="button"
                            role="menuitem"
                            className={`dictation-lang-option ${lang.code === selectedLanguage ? 'active' : ''}`}
                            onClick={() => {
                              setSelectedLanguage(lang.code);
                              setLangMenuOpen(false);
                              if (textareaRef.current) {
                                textareaRef.current.focus();
                              }
                            }}
                          >
                            <span className="lang-opt-flag">{lang.flag}</span>
                            <div className="lang-opt-info">
                              <span className="lang-opt-label">{lang.label}</span>
                              <span className="lang-opt-native">{lang.native}</span>
                            </div>
                            {lang.code === selectedLanguage && <Check size={14} className="lang-check" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Voice Dictation Microphone Button (on mobile, suppressed during active recording to prevent duplicate controls) */}
                {(!isRecordingActive || !isCompactViewport) && (
                  <Button
                    type="button"
                    variant={isListening ? 'primary' : (isRequesting || isTranscribing || recordingState === 'stopping') ? 'outline' : 'ghost'}
                    size="icon-round"
                    disabled={isLoading || isTranscribing || isFinalizing || recordingState === 'stopping' || recordingState === 'success'}
                    onClick={handleToggleListening}
                    title={
                      !isSupported
                        ? 'Voice dictation is not supported in this browser.'
                        : isTranscribing || recordingState === 'stopping'
                        ? 'Processing dictation...'
                        : isListening
                        ? 'Stop dictation and insert transcript'
                        : isRequesting
                        ? 'Connecting microphone... Click to cancel'
                        : isPaused
                        ? 'Resume voice dictation'
                        : `Voice dictation (${activeLang.label})`
                    }
                    ariaLabel={
                      !isSupported
                        ? 'Voice dictation not supported'
                        : isTranscribing || recordingState === 'stopping'
                        ? 'Processing dictation'
                        : isListening
                        ? 'Stop dictation'
                        : isRequesting
                        ? 'Connecting microphone'
                        : isPaused
                        ? 'Resume dictation'
                        : 'Start voice dictation'
                    }
                    className={`composer-mic-btn ${isListening ? 'listening' : isPaused ? 'paused' : isRequesting ? 'requesting' : isTranscribing || recordingState === 'stopping' ? 'transcribing' : ''}`}
                    icon={
                      isListening ? (
                        <Square size={13} fill="currentColor" />
                      ) : (isRequesting || isTranscribing || recordingState === 'stopping') ? (
                        <Loader2 size={16} className="spin-icon" />
                      ) : isPaused ? (
                        <Play size={13} fill="currentColor" />
                      ) : (
                        <Mic size={18} />
                      )
                    }
                  />
                )}

                {/* Message Submission or Stop Generating Button */}
                {isLoading ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={onStopGenerating}
                    title="Stop generating response (Esc)"
                    ariaLabel="Stop generating response"
                    className="composer-stop-btn"
                    icon={<Square size={11} fill="currentColor" />}
                  >
                    <span className="composer-stop-label">Stop</span>
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant={hasContent ? 'primary' : 'ghost'}
                    size="icon-round"
                    disabled={!hasContent}
                    title={
                      !hasContent
                        ? 'Type a message or attach a file to send'
                        : enterToSend
                        ? 'Send message (Enter)'
                        : 'Send message (Ctrl+Enter / ⌘+Enter)'
                    }
                    ariaLabel="Send message"
                    className={`composer-send-btn ${hasContent ? 'is-ready' : 'is-empty'}`}
                    icon={<ArrowUp size={18} strokeWidth={2.25} />}
                  />
                )}
              </div>
            </div>
          </form>

          <p className="composer-footnote">
            {getProviderFootnote(selectedProvider, webllmModelId)}
          </p>
        </div>
      </div>

      {/* Pre-Send Composer Attachment Preview Modal */}
      {previewingComposerAttachment && (
        <React.Suspense fallback={null}>
          <DocumentPreviewModal
            isOpen={Boolean(previewingComposerAttachment)}
            onClose={() => setPreviewingComposerAttachment(null)}
            attachment={previewingComposerAttachment}
          />
        </React.Suspense>
      )}
    </main>
  );
}
