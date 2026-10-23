import React, { useRef, useEffect, useState } from 'react';
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
  FileImage
} from 'lucide-react';
import WelcomeScreen from './WelcomeScreen.jsx';
import MessageList from './MessageList.jsx';
import Button from '../ui/Button.jsx';
import { useVoiceDictation } from '../../hooks/useVoiceDictation.js';
import { sendAIMessage } from '../../services/aiRouter.js';
import { responseHasContinuationNotice } from '../../services/multiPartResponseService.js';

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
  onDismissModeNotice
}) {
  const textareaRef = useRef(null);
  const langMenuRef = useRef(null);
  const scrollViewportRef = useRef(null);
  const fileInputRef = useRef(null);

  // Selected file attachments state (strictly capped at 1 attachment per user message)
  const [attachments, setAttachments] = useState([]);
  const [attachmentNotice, setAttachmentNotice] = useState(null);

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

  // Revoke object URLs on component unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      attachments.forEach((att) => {
        if (att.previewUrl) {
          try {
            URL.revokeObjectURL(att.previewUrl);
          } catch (_) {}
        }
      });
    };
  }, [attachments]);

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

    setAttachmentNotice(null);
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
  };

  // Floating scroll-to-bottom button visibility
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // References to track scroll position and conversation switching lifecycle
  const pendingTopScrollChatIdRef = useRef(activeChatId || null);
  const prevActiveChatIdRef = useRef(activeChatId || null);
  const prevMessagesCountRef = useRef(messages.length);
  const isUserFollowingBottomRef = useRef(false);

  // Language dropdown toggle state
  const [langMenuOpen, setLangMenuOpen] = useState(false);

  // AI Transcript Refinement (Phase 4) state
  const [isCleaningTranscript, setIsCleaningTranscript] = useState(false);
  const [suggestedRefinement, setSuggestedRefinement] = useState(null);

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
  const updateScrollButtonVisibility = () => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;

    // Within 120px threshold is considered "at or near the bottom"
    if (distanceFromBottom <= 120) {
      isUserFollowingBottomRef.current = true;
    } else {
      isUserFollowingBottomRef.current = false;
    }

    // Show button only if there are messages and user is sufficiently far (> 120px) from bottom
    const shouldShow = messages.length > 0 && distanceFromBottom > 120;
    setShowScrollBottom(shouldShow);
  };

  // Smoothly scrolls viewport to bottom
  const handleScrollToBottom = () => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    isUserFollowingBottomRef.current = true;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: 'smooth'
    });
  };

  // Passive scroll event handler
  const handleScroll = () => {
    updateScrollButtonVisibility();
  };

  // Window resize listener to keep button visibility updated
  useEffect(() => {
    const handleResize = () => {
      updateScrollButtonVisibility();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [messages.length]);

  // Handle conversation switching / opening:
  // Starts each opened conversation at the top (scrollTop = 0)
  useEffect(() => {
    if (activeChatId !== prevActiveChatIdRef.current) {
      const prevChatId = prevActiveChatIdRef.current;
      prevActiveChatIdRef.current = activeChatId;
      isUserFollowingBottomRef.current = false;

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
          }
          requestAnimationFrame(() => {
            if (scrollContainer && pendingTopScrollChatIdRef.current === activeChatId) {
              scrollContainer.scrollTop = 0;
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
        requestAnimationFrame(() => {
          if (scrollContainer) {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: 'smooth'
            });
            updateScrollButtonVisibility();
          }
        });
        return;
      }
    }

    // 3. AI response streaming: follow bottom ONLY if user is already at bottom or following
    if (lastMessage?.isStreaming) {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      const isNearBottom = distanceFromBottom < 140;

      if (isUserFollowingBottomRef.current || isNearBottom) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
      updateScrollButtonVisibility();
      return;
    }

    // Normal re-renders: update button state without changing scroll position
    updateScrollButtonVisibility();
  }, [messages, messagesLoading, activeChatId]);

  // Hook into upgraded speech recognition engine
  const {
    recordingState,
    isListening,
    isPaused,
    isRequesting,
    isFinalizing,
    isSupported,
    dictationError,
    interimTranscript,
    lastSessionTranscript,
    selectedLanguage,
    setSelectedLanguage,
    supportedLanguages,
    audioLevel,
    audioFrequencies,
    startListening,
    pauseListening,
    resumeListening,
    stopListening,
    cancelListening,
    toggleListening,
    clearDictationError,
    clearLastSessionTranscript
  } = useVoiceDictation({
    inputValue,
    onInputChange
  });

  const activeLang =
    supportedLanguages.find((l) => l.code === selectedLanguage) || supportedLanguages[0];

  // Close language menu when clicking outside
  useEffect(() => {
    if (!langMenuOpen) return;
    const handleClickOutside = (e) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target)) {
        setLangMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [langMenuOpen]);

  // Auto-resize textarea according to text length
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaRef.current.scrollHeight, 180);
      textareaRef.current.style.height = `${Math.max(newHeight, 44)}px`;
    }
  }, [inputValue]);
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
        const isInteractive =
          tagName === 'button' ||
          tagName === 'a' ||
          activeEl.getAttribute?.('role') === 'button' ||
          activeEl.getAttribute?.('role') === 'menuitem' ||
          activeEl.getAttribute?.('role') === 'option';

        if (isInteractive && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab' || e.key === 'Escape')) {
          return;
        }
      }

      // 6. Check if any modal or dialog is currently open
      if (
        document.querySelector(
          '[role="dialog"], .modal-backdrop, .settings-modal-backdrop, .document-preview-overlay, .auth-modal-backdrop'
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
        textareaRef.current.style.height = `${Math.max(newHeight, 44)}px`;
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

  const handlePromptSelect = (promptText) => {
    if (onInputChange) {
      onInputChange(promptText);
    }
    if (textareaRef.current) {
      textareaRef.current.focus();
      try {
        const len = (promptText || '').length;
        textareaRef.current.setSelectionRange(len, len);
      } catch (_) {}
    }
  };

  const handleKeyDown = (e) => {
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
      if (isListening || isPaused || isRequesting) {
        stopListening();
      }
      clearLastSessionTranscript();
      setSuggestedRefinement(null);
      if (onSubmit && (inputValue.trim() || attachments.length > 0) && !isLoading) {
        const currentAttachments = [...attachments];
        setAttachments([]);
        onSubmit(currentAttachments);
      }
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (isListening || isPaused || isRequesting) {
      stopListening();
    }
    clearLastSessionTranscript();
    setSuggestedRefinement(null);
    if (onSubmit && (inputValue.trim() || attachments.length > 0) && !isLoading) {
      const currentAttachments = [...attachments];
      setAttachments([]);
      onSubmit(currentAttachments);
    }
  };

  // Optional AI Transcript Refinement Handler (Phase 4)
  const handleImproveTranscript = async () => {
    if (!lastSessionTranscript || isCleaningTranscript) return;
    setIsCleaningTranscript(true);

    try {
      const cleanPrompt = `You are a specialized speech-to-text transcript polisher.
Improve punctuation, capitalization, and obvious speech recognition phonetic glitches in the provided spoken transcript.

STRICT CONSTRAINTS:
1. Preserve the speaker's exact meaning, words, names, and technical terms.
2. DO NOT summarize, rewrite, or add any commentary.
3. DO NOT translate (if Urdu, keep Urdu; if English, keep English).
4. Return ONLY the refined transcript text and nothing else.

Transcript:
"${lastSessionTranscript}"`;

      const res = await sendAIMessage({
        provider: selectedProvider || 'gemini',
        prompt: cleanPrompt,
        history: [],
        username: null
      });

      if (res && res.text) {
        const polished = res.text.replace(/^["']|["']$/g, '').trim();
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
  // Dictation dock is only active when actively requesting, listening, paused, or finalizing
  const isRecordingActive =
    recordingState === 'listening' ||
    recordingState === 'paused' ||
    recordingState === 'requesting' ||
    recordingState === 'finalizing';

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
      >
        <div className="chat-content-constrained">
          {isNewChat && !hasMessages ? (
            <WelcomeScreen
              onSelectPrompt={handlePromptSelect}
              username={username}
              activeMode={activeMode}
              onSelectMode={onSelectMode}
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
              onRetry={onRetry}
              onSwitchProvider={onSwitchProvider}
              onRestorePrompt={onRestorePrompt}
              onRegenerate={onRegenerate}
              onGenerateAlternative={onGenerateAlternative}
              onSwitchAlternative={onSwitchAlternative}
              onStopGenerating={onStopGenerating}
              onEditResend={onEditResend}
              editingMessageId={editingMessageId}
              onStartEdit={onStartEdit}
              onCancelEdit={onCancelEdit}
              showTimestamps={showTimestamps}
              selectedProvider={selectedProvider}
              activeMode={activeMode}
            />
          )}
        </div>
      </div>

      {/* Message Composer Dock */}
      <div className="chat-composer-dock">
        <div className="chat-composer-inner">
          {/* ChatGPT-style Floating Scroll-to-Bottom Button */}
          {showScrollBottom && (
            <div className="scroll-to-bottom-dock">
              <button
                type="button"
                className="scroll-to-bottom-btn"
                onClick={handleScrollToBottom}
                aria-label="Scroll to bottom"
                title="Scroll to bottom"
              >
                <ArrowDown size={18} aria-hidden="true" />
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

          {/* Professional Active Dictation Strip */}
          {isRecordingActive && (
            <div
              className={`composer-listening-bar state-${recordingState}`}
              role="status"
              aria-live="polite"
            >
              <div className="listening-left-group">
                <div className="listening-indicator-content">
                  <div className={`listening-mic-badge ${recordingState}`} aria-hidden="true">
                    {recordingState === 'requesting' ? (
                      <Loader2 size={13} className="spin-icon" />
                    ) : (
                      <Mic size={13} />
                    )}
                  </div>
                  <div
                    className="listening-soundwave"
                    aria-hidden="true"
                    title={isListening ? `Microphone audio level: ${audioLevel}%` : 'Connecting microphone'}
                  >
                    {audioFrequencies.map((freq, idx) => (
                      <span
                        key={idx}
                        className={`soundwave-bar dynamic ${isListening ? 'active' : ''}`}
                        style={{
                          height: isListening ? `${Math.max(5, Math.round(freq * 18))}px` : '4px',
                          opacity: isListening ? Math.max(0.4, Math.min(1, freq * 1.2)) : 0.35
                        }}
                      />
                    ))}
                  </div>
                  <span className="listening-text">
                    {recordingState === 'requesting'
                      ? 'Connecting...'
                      : recordingState === 'paused'
                      ? 'Paused'
                      : recordingState === 'finalizing'
                      ? 'Finishing...'
                      : 'Dictating...'}
                  </span>
                </div>

                {/* Recognition Language Selector Pill */}
                <div className="dictation-lang-wrapper" ref={langMenuRef}>
                  <button
                    type="button"
                    className="dictation-lang-btn"
                    onClick={() => setLangMenuOpen((prev) => !prev)}
                    title={`Dictation language: ${activeLang.label}. Click to switch.`}
                    aria-label="Select dictation language"
                    aria-expanded={langMenuOpen}
                  >
                    <span className="lang-flag">{activeLang.flag}</span>
                    <span className="lang-code">{activeLang.code.split('-')[0].toUpperCase()}</span>
                    <ChevronDown size={11} className={`lang-chevron ${langMenuOpen ? 'open' : ''}`} />
                  </button>

                  {langMenuOpen && (
                    <div className="dictation-lang-dropdown" role="menu">
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

              {/* Interim Transcript Live Preview */}
              <div className="listening-preview-area" title={interimTranscript || 'Live speech preview'}>
                {interimTranscript ? (
                  <span className="live-speech-bubble">"{interimTranscript}"</span>
                ) : (
                  <span className="live-speech-placeholder">
                    {recordingState === 'requesting'
                      ? 'Connecting to microphone...'
                      : recordingState === 'paused'
                      ? 'Speech paused'
                      : recordingState === 'finalizing'
                      ? 'Finishing...'
                      : 'Speak to dictate...'}
                  </span>
                )}
              </div>

              {/* Action Buttons: Pause/Resume, Stop, Cancel (✕) */}
              <div className="listening-actions-group">
                {recordingState === 'listening' ? (
                  <button
                    type="button"
                    className="dictation-strip-btn pause-btn"
                    onClick={pauseListening}
                    title="Pause dictation"
                    aria-label="Pause dictation"
                  >
                    <Pause size={12} />
                    <span className="btn-label">Pause</span>
                  </button>
                ) : recordingState === 'paused' ? (
                  <button
                    type="button"
                    className="dictation-strip-btn resume-btn"
                    onClick={resumeListening}
                    title="Resume dictation"
                    aria-label="Resume dictation"
                  >
                    <Play size={12} fill="currentColor" />
                    <span className="btn-label">Resume</span>
                  </button>
                ) : null}

                <button
                  type="button"
                  className="dictation-strip-btn stop-btn"
                  onClick={stopListening}
                  title="Stop dictation and keep message"
                  aria-label="Stop dictation"
                >
                  <Square size={10} fill="currentColor" />
                  <span className="btn-label">Stop</span>
                </button>

                <button
                  type="button"
                  className="dictation-strip-btn cancel-btn"
                  onClick={cancelListening}
                  title="Cancel dictation (discard session)"
                  aria-label="Cancel dictation"
                >
                  <X size={14} />
                  <span className="btn-label-sr">Cancel</span>
                </button>
              </div>
            </div>
          )}

          {/* Optional AI Transcript Refinement Notification (Phase 4) */}
          {lastSessionTranscript && !isRecordingActive && !suggestedRefinement && (
            <div className="transcript-cleanup-banner" role="region" aria-label="Transcript helper">
              <div className="cleanup-banner-left">
                <Sparkles size={13} className="cleanup-icon" />
                <span className="cleanup-hint">Dictated speech recorded:</span>
                <span className="cleanup-snippet">
                  "{lastSessionTranscript.length > 46 ? lastSessionTranscript.slice(0, 46) + '...' : lastSessionTranscript}"
                </span>
              </div>
              <div className="cleanup-banner-actions">
                <button
                  type="button"
                  className="cleanup-action-trigger"
                  onClick={handleImproveTranscript}
                  disabled={isCleaningTranscript}
                  title="Use AI to polish punctuation and capitalization without changing words or translating"
                >
                  {isCleaningTranscript ? (
                    <Loader2 size={12} className="spin-icon" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>{isCleaningTranscript ? 'Polishing...' : 'Improve transcript'}</span>
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

          {/* Drag and Drop Visual Feedback Indicator */}
          {isDraggingOver && (
            <div className="composer-drop-banner" role="status" aria-live="polite">
              <div className="composer-drop-content">
                <Paperclip size={15} className="composer-drop-icon" aria-hidden="true" />
                <span className="composer-drop-text">Drop file to attach</span>
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            onPaste={handlePaste}
            className={`composer-form ${isDraggingOver ? 'is-drag-over' : ''}`}
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

            {/* Selected attachment preview strip with explicit "One attachment maximum per message" badge */}
            {attachments.length > 0 && (
              <div className="composer-attachments-preview" role="region" aria-label="Attached file or image">
                <div className="attachment-limit-banner">
                  <Paperclip size={12} className="attachment-limit-icon" aria-hidden="true" />
                  <span className="attachment-limit-text">One attachment maximum per message</span>
                </div>
                {attachments.map((att) =>
                  att.isImage ? (
                    <div
                      key={att.id}
                      className="composer-attachment-chip composer-image-chip"
                      title={`${att.name} (${att.formattedSize})`}
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
                        <span className="attachment-chip-size">{att.formattedSize}</span>
                      </div>
                      <button
                        type="button"
                        className="attachment-chip-remove"
                        onClick={() => handleRemoveAttachment(att.id)}
                        title={`Remove ${att.name}`}
                        aria-label={`Remove ${att.name}`}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={att.id}
                      className="composer-attachment-chip"
                      title={`${att.name} (${att.formattedSize})`}
                    >
                      <span className="attachment-chip-badge">{att.extension || 'FILE'}</span>
                      <span className="attachment-chip-name">{att.name}</span>
                      <span className="attachment-chip-size">{att.formattedSize}</span>
                      <button
                        type="button"
                        className="attachment-chip-remove"
                        onClick={() => handleRemoveAttachment(att.id)}
                        title={`Remove ${att.name}`}
                        aria-label={`Remove ${att.name}`}
                      >
                        <X size={12} />
                      </button>
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
                    ? 'Only one attachment can be added per message. Click to view notification.'
                    : 'Attach document or image — One attachment maximum per message (PDF, DOCX, TXT, PPTX, JPG, PNG, etc.)'
                }
                ariaLabel="Attach document or image (One attachment maximum per message)"
                className={`composer-attach-btn ${attachments.length > 0 ? 'has-attachment' : ''}`}
                icon={<Paperclip size={18} />}
              />

              <textarea
                ref={textareaRef}
                className="composer-textarea"
                placeholder={
                  isListening
                    ? 'Listening to speech...'
                    : isPaused
                    ? 'Dictation paused — speak or type...'
                    : isRequesting
                    ? 'Connecting microphone...'
                    : isLoading
                    ? 'Orvix is responding...'
                    : activeMode === 'coding'
                    ? 'Ask a coding question, debug an error, or request code...'
                    : activeMode === 'writing'
                    ? 'Draft an email, polish prose, or rewrite content...'
                    : activeMode === 'learning'
                    ? 'Ask to explain a concept, break down a topic, or quiz you...'
                    : 'Ask Orvix anything...'
                }
                value={inputValue}
                rows={1}
                onChange={(e) => onInputChange && onInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                aria-label="Message input text"
              />

              <div className="composer-actions">
                {/* Voice Dictation Microphone Button */}
                <Button
                  type="button"
                  variant={isListening ? 'primary' : isRequesting ? 'outline' : 'ghost'}
                  size="icon-round"
                  disabled={isLoading}
                  onClick={toggleListening}
                  title={
                    !isSupported
                      ? 'Voice dictation is not supported in this browser. Please use Chrome, Edge, or Safari.'
                      : isListening
                      ? 'Stop listening (Voice dictation active)'
                      : isRequesting
                      ? 'Connecting microphone... Click to cancel'
                      : isPaused
                      ? 'Resume listening (Voice dictation paused)'
                      : `Dictate message (${activeLang.label})`
                  }
                  ariaLabel={
                    !isSupported
                      ? 'Voice dictation not supported'
                      : isListening
                      ? 'Stop listening'
                      : isRequesting
                      ? 'Connecting microphone'
                      : isPaused
                      ? 'Resume dictation'
                      : 'Start voice dictation'
                  }
                  className={`composer-mic-btn ${isListening ? 'listening' : isPaused ? 'paused' : isRequesting ? 'requesting' : ''}`}
                  icon={
                    isListening ? (
                      <Square size={13} fill="currentColor" />
                    ) : isRequesting ? (
                      <Loader2 size={16} className="spin-icon" />
                    ) : isPaused ? (
                      <Play size={13} fill="currentColor" />
                    ) : (
                      <Mic size={18} />
                    )
                  }
                />

                {/* Message Submission or Stop Generating Button */}
                {isLoading ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-round"
                    onClick={onStopGenerating}
                    title="Stop generating response (Esc)"
                    ariaLabel="Stop generating response"
                    className="composer-stop-btn"
                    icon={<Square size={13} fill="currentColor" />}
                  />
                ) : (
                  <Button
                    type="submit"
                    variant={hasContent ? 'primary' : 'ghost'}
                    size="icon-round"
                    disabled={!hasContent}
                    title={enterToSend ? 'Send message (Enter)' : 'Send message (⌘/Ctrl+Enter)'}
                    ariaLabel="Send message"
                    className="composer-send-btn"
                    icon={<ArrowUp size={18} />}
                  />
                )}
              </div>
            </div>
          </form>

          <p className="composer-footnote">
            {selectedProvider === 'groq'
              ? 'Orvix is powered by Groq (GPT OSS 120B). Ultra-fast inference — verify important facts independently.'
              : selectedProvider === 'openrouter'
              ? 'Orvix is powered by OpenRouter (Llama 3.3 70B Free). Multi-model gateway — verify important facts independently.'
              : selectedProvider === 'cloudflare'
              ? 'Orvix is powered by Cloudflare Workers AI (Llama 3.1 8B). Serverless inference — verify important facts independently.'
              : 'Orvix is powered by Google Gemini (Gemini 3.1 Flash Lite). Client integration — verify important facts independently.'}
          </p>
        </div>
      </div>
    </main>
  );
}
