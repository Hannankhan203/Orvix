import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Mic,
  Square,
  AlertCircle,
  X,
  Sparkles,
  Loader2,
  Paperclip,
  ChevronDown,
  Check,
  ImagePlus
} from 'lucide-react';
import WelcomeScreen from './WelcomeScreen.jsx';
import MessageList from './MessageList.jsx';
import BrowserAIStatusBar from './BrowserAIStatusBar.jsx';
const DocumentPreviewModal = React.lazy(() => import('./DocumentPreviewModal.jsx'));
import ImagePromptModal from './ImagePromptModal.jsx';
import Button from '../ui/Button.jsx';
import VoiceDictationDock from './VoiceDictationDock.jsx';
import TranscriptPolishReview from './TranscriptPolishReview.jsx';
import ComposerAttachmentTray from './ComposerAttachmentTray.jsx';
import SharedConversationBanner from './SharedConversationBanner.jsx';
import { useVoiceDictation } from '../../hooks/useVoiceDictation.js';
import { sendAIMessage, PROVIDER_OPTIONS } from '../../services/aiRouter.js';
import { PROVIDER_DEFAULT_MODELS } from '../../services/providerModelSanitizer.js';
import { WEBLLM_MODEL_CATALOG, DEFAULT_WEBLLM_MODEL_ID } from '../../services/webllmService.js';
import { responseHasContinuationNotice } from '../../services/multiPartResponseService.js';
import { polishSpokenTranscript } from '../../utils/speechTextCleaner.js';
import {
  getProviderFootnote,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  getExtensionFromMime,
  resolvePastedFileName,
  isFileDragEvent,
  formatFileSize
} from './chatAreaUtils.js';
import { formatDailyUploadQuotaText } from '../../services/uploadQuotaClientService.js';

export { getProviderFootnote };

/**
 * ChatArea Component
 * Coordinates the scrollable message stream / welcome state,
 * error retries, and the fixed bottom message composer with professional voice dictation.
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
  providerConfig = null,
  onShareChat,
  canShareChat = false,
  shareChatDisabledReason = '',
  isSharingChat = false,
  shareErrorNotice = null,
  onDismissShareError,
  isReadOnly = false,
  isSharedView = false,
  isAuthenticatedSharedPreview = false,
  isPublicSharedViewer = false,
  hasSharedPreviewFirstMessageBeenSent = false,
  isSubmittingFirstSharedMessage = false,
  firstSharedMessageSubmissionFailed = false,
  sharedPreviewSubmissionState = 'idle',
  sharedSnapshot = null,
  sharedError = null,
  sharedLoading = false,
  onSignInClick = undefined,
  onNavigateHome = undefined,
  onGenerateImage = undefined,
  uploadQuota = null
}) {
  const isComposerDisabled = isPublicSharedViewer || (isReadOnly && !isAuthenticatedSharedPreview);
  const uploadQuotaText = !isReadOnly && !isSharedView ? formatDailyUploadQuotaText(uploadQuota) : null;
  const isUploadQuotaLoading =
    !isReadOnly &&
    !isSharedView &&
    uploadQuota?.status === 'loading' &&
    uploadQuota?.remaining === null &&
    Boolean(uploadQuota?.userId);

  const textareaRef = useRef(null);
  const langMenuRef = useRef(null);
  const scrollViewportRef = useRef(null);
  const fileInputRef = useRef(null);

  // Multimodal AI Image Generation dialog state
  const [imageModalOpen, setImageModalOpen] = useState(false);

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
    if (isReadOnly || isSharedView) return;
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
    if (isSharedView) return;
    if (!rawFile) return;

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

    const resolvedName = (isPaste || isDrop) ? resolvePastedFileName(rawFile) : rawFile.name;

    const MAX_FILE_SIZE = 25 * 1024 * 1024;
    if (rawFile.size > MAX_FILE_SIZE) {
      setAttachmentNotice(`File '${resolvedName}' exceeds the maximum allowed size of 25MB.`);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    let ext = resolvedName.includes('.')
      ? resolvedName.split('.').pop().toUpperCase()
      : (getExtensionFromMime(rawFile.type) || 'FILE');

    const isImage =
      SUPPORTED_IMAGE_EXTENSIONS.has(ext) ||
      Boolean(rawFile.type && rawFile.type.startsWith('image/'));

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

  const handlePaste = (e) => {
    if (isComposerDisabled) {
      e.preventDefault();
      return;
    }
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    const files = clipboardData.files;

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

    if (candidateFiles.length === 0) {
      return;
    }

    if (isSharedView) {
      e.preventDefault();
      setAttachmentNotice('Attachments are disabled in shared conversation preview.');
      return;
    }

    e.preventDefault();

    if (attachments.length > 0) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Remove the current attachment before pasting another file.'
      );
      return;
    }

    if (candidateFiles.length > 1) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Please paste a single file or image.'
      );
      return;
    }

    processAttachment(candidateFiles[0], { isPaste: true, isDrop: false });
  };

  const handleDragEnter = (e) => {
    if (isReadOnly || isSharedView || !isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDraggingOver(true);
  };

  const handleDragOver = (e) => {
    if (isReadOnly || isSharedView || !isFileDragEvent(e)) return;
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
    if (isReadOnly || isSharedView || !isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDraggingOver(false);
    }
  };

  const handleDrop = (e) => {
    if (isReadOnly || isSharedView || !isFileDragEvent(e)) return;
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

    if (attachments.length > 0) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Remove the current attachment before adding another file.'
      );
      return;
    }

    if (candidateFiles.length > 1) {
      setAttachmentNotice(
        'Only one attachment can be added per message. Please drop one file at a time.'
      );
      return;
    }

    processAttachment(candidateFiles[0], { isPaste: false, isDrop: true });
  };

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

  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const pendingTopScrollChatIdRef = useRef(activeChatId || null);
  const prevActiveChatIdRef = useRef(activeChatId || null);
  const prevMessagesCountRef = useRef(messages.length);
  const isUserFollowingBottomRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const isAutoScrollingRef = useRef(false);
  const isTouchScrollingRef = useRef(false);

  const [langMenuOpen, setLangMenuOpen] = useState(false);

  const [isCleaningTranscript, setIsCleaningTranscript] = useState(false);
  const [suggestedRefinement, setSuggestedRefinement] = useState(null);

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
    onEditResend,
    onShareChat
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
    onEditResend,
    onShareChat
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
  const stableOnShareChat = useCallback((...args) => messageCallbacksRef.current.onShareChat?.(...args), []);

  const messagesLengthRef = useRef(messages.length);
  messagesLengthRef.current = messages.length;

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const canContinueLastMessage =
    !isLoading &&
    lastMessage &&
    lastMessage.sender === 'assistant' &&
    !lastMessage.isError &&
    !lastMessage.isStopped &&
    responseHasContinuationNotice(lastMessage.content);

  const updateScrollButtonVisibility = useCallback(() => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;

    const shouldShow = messagesLengthRef.current > 0 && distanceFromBottom > 110;
    setShowScrollBottom((prev) => (prev === shouldShow ? prev : shouldShow));
  }, []);

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

  const handleScroll = () => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

    const currentScrollTop = scrollContainer.scrollTop;
    const distanceFromBottom =
      scrollContainer.scrollHeight - currentScrollTop - scrollContainer.clientHeight;

    if (!isAutoScrollingRef.current) {
      if (currentScrollTop < lastScrollTopRef.current - 5) {
        isUserFollowingBottomRef.current = false;
      } else if (distanceFromBottom <= 56) {
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

  useEffect(() => {
    if (activeChatId !== prevActiveChatIdRef.current) {
      prevActiveChatIdRef.current = activeChatId;
      isUserFollowingBottomRef.current = false;
      lastScrollTopRef.current = 0;

      if (activeChatId) {
        pendingTopScrollChatIdRef.current = activeChatId;
        if (scrollViewportRef.current) {
          scrollViewportRef.current.scrollTop = 0;
        }
      } else {
        pendingTopScrollChatIdRef.current = null;
        if (scrollViewportRef.current) {
          scrollViewportRef.current.scrollTop = 0;
        }
        setShowScrollBottom(false);
      }
    }
  }, [activeChatId]);

  useEffect(() => {
    const scrollContainer = scrollViewportRef.current;
    if (!scrollContainer) return;

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

    const isNewMessage = messages.length > prevMessagesCountRef.current;
    const lastMsg = messages[messages.length - 1];
    prevMessagesCountRef.current = messages.length;

    if (isNewMessage) {
      if (lastMsg?.sender === 'user' || lastMsg?.isStreaming) {
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

    if (lastMsg?.isStreaming) {
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

    updateScrollButtonVisibility();
  }, [messages, messagesLoading, activeChatId, updateScrollButtonVisibility]);

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
    retryTranscription,
    isStreamingWebSocket
  } = useVoiceDictation({
    inputValue,
    onInputChange,
    disabled: isPublicSharedViewer
  });

  const activeLang =
    supportedLanguages.find((l) => l.code === selectedLanguage) || supportedLanguages[0];

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
  }, [activeChatId, isPublicSharedViewer, cancelListening]);

  useEffect(() => {
    if (isPublicSharedViewer && langMenuOpen) {
      setLangMenuOpen(false);
    }
  }, [isPublicSharedViewer, langMenuOpen]);

  const handleToggleLangMenu = () => {
    if (isPublicSharedViewer || isReadOnly) return;
    setLangMenuOpen((prev) => !prev);
  };

  const handleSelectLanguage = (langCode) => {
    if (isPublicSharedViewer || isReadOnly) return;
    setSelectedLanguage(langCode);
    setLangMenuOpen(false);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleStopListening = async () => {
    if (isPublicSharedViewer) return;
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
    if (isPublicSharedViewer && recordingState === 'idle') return;
    cancelListening();
    setSuggestedRefinement(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    });
  };

  const handleToggleListening = () => {
    if (isPublicSharedViewer || isReadOnly || isSharedView) return;
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
      return;
    } else {
      startListening();
    }
  };

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

  const inputValueRef = useRef(inputValue);
  useEffect(() => {
    inputValueRef.current = inputValue;
  }, [inputValue]);

  const onInputChangeRef = useRef(onInputChange);
  useEffect(() => {
    onInputChangeRef.current = onInputChange;
  }, [onInputChange]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleGlobalKeyDown = (e) => {
      if (isReadOnly) return;
      if (!textareaRef.current || document.activeElement === textareaRef.current) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!e.key || e.key.length !== 1 || e.key === ' ') return;
      if (e.isComposing || e.keyCode === 229) return;

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

      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], .modal-backdrop, .settings-modal-backdrop, .document-preview-overlay, .auth-modal-backdrop'
        )
      ) {
        return;
      }

      e.preventDefault();

      const currentVal = inputValueRef.current || '';
      const start = textareaRef.current.selectionStart ?? currentVal.length;
      const end = textareaRef.current.selectionEnd ?? start;
      const before = currentVal.slice(0, start);
      const after = currentVal.slice(end);
      const newVal = before + e.key + after;
      const newCursorPos = before.length + e.key.length;

      if (onInputChangeRef.current) {
        onInputChangeRef.current(newVal);
      }
      textareaRef.current.value = newVal;

      try {
        textareaRef.current.style.height = 'auto';
        const newHeight = Math.min(textareaRef.current.scrollHeight, 180);
        textareaRef.current.style.height = `${Math.max(newHeight, 36)}px`;
      } catch (_) {}

      textareaRef.current.focus();
      try {
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      } catch (_) {}
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isReadOnly]);

  const submitComposerMessage = async (textToSend) => {
    if (isComposerDisabled || (!textToSend.trim() && attachments.length === 0) || isLoading) {
      return;
    }

    const trimmedText = textToSend.trim();
    if ((trimmedText.startsWith('/image ') || trimmedText.startsWith('/imagine ')) && onGenerateImage) {
      const promptOnly = trimmedText.replace(/^\/(?:image|imagine)\s+/, '').trim();
      if (promptOnly) {
        if (onInputChange) onInputChange('');
        setAttachments([]);
        setPreviewingComposerAttachment(null);
        void onGenerateImage({ prompt: promptOnly });
        return;
      }
    }

    if (!onSubmit) return;
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
    if (isComposerDisabled) return;

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

    if (e.nativeEvent?.isComposing) return;

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
    if (isComposerDisabled) return;
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
          if (text.startsWith('```')) {
            text = text.replace(/^```[a-zA-Z0-9_-]*\n?/i, '').replace(/\n?```$/i, '').trim();
          }
          text = text.replace(/^(?:here(?:'s| is) (?:the )?(?:polished|refined|corrected) transcript:?\s*)/i, '').trim();
          text = text.replace(/^["'«»“](.*)["'«»”]$/s, '$1').trim();

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

  const composerPlaceholder = isPublicSharedViewer
    ? 'This is a read-only shared conversation.'
    : isAuthenticatedSharedPreview
    ? isLoading
      ? isCompactViewport
        ? 'Generating response...'
        : 'Generating response — press Esc to stop...'
      : 'Send a message to continue this conversation...'
    : isReadOnly
    ? 'This is a read-only shared conversation.'
    : isLoading
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
      className={`chat-area-container ${isDraggingOver ? 'is-drag-over' : ''} ${isReadOnly ? 'is-read-only-view' : ''}`}
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
          {sharedLoading ? (
            <div className="shared-chat-loading-view" role="status" aria-label="Loading shared conversation">
              <Loader2 size={26} className="spin-icon" />
              <span className="shared-loading-text">Loading shared conversation...</span>
            </div>
          ) : sharedError ? (
            <div className="shared-chat-error-view" role="alert">
              <div className="shared-chat-error-card">
                <AlertCircle size={32} className="shared-error-icon" />
                <h2 className="shared-error-title">
                  {sharedError.code === 'INVALID_SHARE_ID' || sharedError.code === 'SNAPSHOT_NOT_FOUND' || sharedError.code === 'MALFORMED_SHARE_URL'
                    ? 'Conversation Unavailable'
                    : 'Unable to Load Shared Conversation'}
                </h2>
                <p className="shared-error-message">
                  {sharedError.message || 'This shared conversation link may have expired or is unavailable.'}
                </p>
                <div className="shared-error-actions">
                  <button
                    type="button"
                    className="shared-error-home-btn"
                    onClick={onNavigateHome}
                  >
                    Go to Orvix Home
                  </button>
                </div>
              </div>
            </div>
          ) : isNewChat && !hasMessages ? (
            <WelcomeScreen
              username={username}
            />
          ) : messagesLoading && !hasMessages ? (
            <div className="messages-loading-state" role="status" aria-label="Loading conversation">
              <Loader2 size={24} className="spin-icon" />
              <span>Loading conversation...</span>
            </div>
          ) : (
            <>
              <SharedConversationBanner
                isSharedView={isSharedView}
                sharedSnapshot={sharedSnapshot}
                isAuthenticatedSharedPreview={isAuthenticatedSharedPreview}
                onSignInClick={onSignInClick}
              />
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
                onShareChat={onShareChat ? stableOnShareChat : undefined}
                canShareChat={canShareChat}
                shareChatDisabledReason={shareChatDisabledReason}
                isSharingChat={isSharingChat}
                isReadOnly={isReadOnly}
              />
            </>
          )}
        </div>
      </div>

      {/* Message Composer Dock */}
      <div className={`chat-composer-dock ${isRecordingActive ? 'is-recording-active' : ''}`}>
        <div className="chat-composer-inner">
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

          {!isReadOnly && canContinueLastMessage && (
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

          {shareErrorNotice && (
            <div className="composer-dictation-error share-chat-error-alert" role="alert">
              <div className="dictation-error-content">
                <AlertCircle size={14} className="dictation-error-icon" aria-hidden="true" />
                <span>{shareErrorNotice}</span>
              </div>
              {onDismissShareError && (
                <button
                  type="button"
                  className="dictation-error-dismiss"
                  onClick={onDismissShareError}
                  aria-label="Dismiss share error alert"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

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

          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {srAnnouncement}
          </div>

          {isRecordingActive && (
            <VoiceDictationDock
              recordingState={recordingState}
              isListening={isListening}
              isPaused={isPaused}
              isRequesting={isRequesting}
              isStreamingWebSocket={isStreamingWebSocket}
              formattedDuration={formattedDuration}
              audioLevel={audioLevel}
              waveformBars={waveformBars}
              activeLang={activeLang}
              supportedLanguages={supportedLanguages}
              selectedLanguage={selectedLanguage}
              langMenuOpen={langMenuOpen}
              langMenuRef={langMenuRef}
              isPublicSharedViewer={isPublicSharedViewer}
              onToggleLangMenu={handleToggleLangMenu}
              onSelectLanguage={handleSelectLanguage}
              onPauseListening={pauseListening}
              onResumeListening={resumeListening}
              onStopListening={handleStopListening}
              onCancelListening={handleCancelListening}
            />
          )}

          <TranscriptPolishReview
            lastSessionTranscript={lastSessionTranscript}
            suggestedRefinement={suggestedRefinement}
            isCleaningTranscript={isCleaningTranscript}
            onImproveTranscript={handleImproveTranscript}
            onApplyRefinement={handleApplyRefinement}
            onDismissReview={() => setSuggestedRefinement(null)}
            onDismissTranscript={clearLastSessionTranscript}
          />

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

            <ComposerAttachmentTray
              attachments={attachments}
              onPreview={(att) => setPreviewingComposerAttachment(att)}
              onRemove={handleRemoveAttachment}
              uploadQuotaText={uploadQuotaText}
            />

            {(uploadQuotaText || isUploadQuotaLoading) && (
              <div
                className={`composer-upload-quota-bar ${
                  typeof uploadQuota?.remaining === 'number'
                    ? uploadQuota.remaining === 0
                      ? 'is-exhausted'
                      : uploadQuota.remaining === 1
                      ? 'is-low'
                      : 'is-available'
                    : 'is-loading'
                }`}
                data-testid="upload-quota-indicator"
                data-remaining={typeof uploadQuota?.remaining === 'number' ? String(uploadQuota.remaining) : undefined}
                data-limit={typeof uploadQuota?.limit === 'number' ? String(uploadQuota.limit) : undefined}
                role="status"
                aria-live="polite"
                aria-label={uploadQuotaText || 'Loading daily upload quota'}
              >
                <Paperclip size={11} className="composer-upload-quota-icon" aria-hidden="true" />
                <span className="composer-upload-quota-text">
                  {uploadQuotaText || 'Loading upload quota...'}
                </span>
              </div>
            )}

            <div className="composer-input-row">
              <Button
                type="button"
                variant="ghost"
                size="icon-round"
                disabled={isLoading || isReadOnly || isSharedView || isComposerDisabled}
                onClick={handleAttachClick}
                title={
                  isSharedView
                    ? 'Attachments are disabled in shared preview mode'
                    : isReadOnly
                    ? 'Attachments are disabled in read-only shared mode'
                    : attachments.length > 0
                    ? `Attached: ${attachments[0].name} (1 file max per message)${uploadQuotaText ? ` • ${uploadQuotaText}` : ''}`
                    : `Attach file or image (PDF, DOCX, TXT, CSV, PNG, JPG — max 25MB)${uploadQuotaText ? ` • ${uploadQuotaText}` : ''}`
                }
                ariaLabel={
                  isSharedView
                    ? 'Attachments are disabled in shared preview mode'
                    : isReadOnly
                    ? 'Attachments are disabled in read-only shared mode'
                    : attachments.length > 0
                    ? `Attachment selected: ${attachments[0].name}. Maximum one attachment per message.${uploadQuotaText ? ` ${uploadQuotaText}.` : ''}`
                    : `Attach document or image.${uploadQuotaText ? ` ${uploadQuotaText}.` : ''}`
                }
                className={`composer-attach-btn ${attachments.length > 0 ? 'has-attachment' : ''}`}
                icon={<Paperclip size={18} />}
              />

              <Button
                type="button"
                variant="ghost"
                size="icon-round"
                disabled={isLoading || isReadOnly || isSharedView || isComposerDisabled}
                onClick={() => setImageModalOpen(true)}
                title="Generate AI image from descriptive prompt"
                ariaLabel="Generate AI image"
                className="composer-image-gen-btn"
                icon={<ImagePlus size={18} />}
              />

              <textarea
                ref={textareaRef}
                className="composer-textarea"
                placeholder={composerPlaceholder}
                value={inputValue}
                rows={1}
                disabled={isComposerDisabled || isLoading}
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
                {isSupported && !isRecordingActive && (
                  <div
                    className={`dictation-lang-wrapper composer-pre-lang ${isPublicSharedViewer ? 'disabled' : ''}`}
                    ref={!isRecordingActive ? langMenuRef : undefined}
                    title={
                      isPublicSharedViewer
                        ? 'Voice dictation language selection is disabled in public read-only mode'
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      disabled={isPublicSharedViewer}
                      className={`dictation-lang-btn composer-lang-btn ${isPublicSharedViewer ? 'disabled' : ''}`}
                      onClick={handleToggleLangMenu}
                      title={
                        isPublicSharedViewer
                          ? 'Voice dictation language selection is disabled in public read-only mode'
                          : `Dictation language: ${activeLang.label}. Click to change.`
                      }
                      aria-label={
                        isPublicSharedViewer
                          ? 'Voice dictation language selection is disabled in public read-only mode'
                          : `Dictation language: ${activeLang.label}`
                      }
                      aria-disabled={isPublicSharedViewer}
                      aria-expanded={!isPublicSharedViewer && langMenuOpen}
                      aria-haspopup="menu"
                    >
                      <span className="lang-flag">{activeLang.flag}</span>
                      <span className="lang-code">{activeLang.code.split('-')[0].toUpperCase()}</span>
                      <ChevronDown size={11} className={`lang-chevron ${!isPublicSharedViewer && langMenuOpen ? 'open' : ''}`} />
                    </button>

                    {!isPublicSharedViewer && langMenuOpen && (
                      <div className="dictation-lang-dropdown" role="menu" aria-label="Dictation recognition language">
                        <div className="lang-dropdown-header">Dictation Language</div>
                        {supportedLanguages.map((lang) => (
                          <button
                            key={lang.code}
                            type="button"
                            role="menuitem"
                            className={`dictation-lang-option ${lang.code === selectedLanguage ? 'active' : ''}`}
                            onClick={() => handleSelectLanguage(lang.code)}
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

                {(!isRecordingActive || !isCompactViewport) && (
                  <Button
                    type="button"
                    variant={isListening ? 'primary' : (isRequesting || isTranscribing || recordingState === 'stopping') ? 'outline' : 'ghost'}
                    size="icon-round"
                    disabled={isPublicSharedViewer || isLoading || isTranscribing || isFinalizing || recordingState === 'stopping' || recordingState === 'success' || isReadOnly || isSharedView || isComposerDisabled}
                    onClick={handleToggleListening}
                    title={
                      isPublicSharedViewer
                        ? 'Voice dictation is disabled in public read-only mode'
                        : isSharedView
                        ? 'Voice dictation is disabled in shared preview mode'
                        : isReadOnly
                        ? 'Voice dictation is disabled in read-only shared mode'
                        : !isSupported
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
                      isPublicSharedViewer
                        ? 'Voice dictation is disabled in public read-only mode'
                        : isSharedView
                        ? 'Voice dictation is disabled in shared preview mode'
                        : isReadOnly
                        ? 'Voice dictation is disabled in read-only shared mode'
                        : !isSupported
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
                    className={`composer-mic-btn ${isListening ? 'listening' : isPaused ? 'paused' : isRequesting ? 'requesting' : isTranscribing || recordingState === 'stopping' ? 'transcribing' : ''} ${isPublicSharedViewer ? 'disabled' : ''}`}
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
                    variant={hasContent && !isComposerDisabled ? 'primary' : 'ghost'}
                    size="icon-round"
                    disabled={!hasContent || isComposerDisabled}
                    title={
                      isComposerDisabled
                        ? 'Messaging is disabled in read-only shared mode'
                        : !hasContent
                        ? 'Type a message to send'
                        : enterToSend
                        ? 'Send message (Enter)'
                        : 'Send message (Ctrl+Enter / ⌘+Enter)'
                    }
                    ariaLabel={isReadOnly ? 'Messaging disabled in read-only mode' : 'Send message'}
                    className={`composer-send-btn ${hasContent && !isReadOnly ? 'is-ready' : 'is-empty'}`}
                    icon={<ArrowUp size={18} strokeWidth={2.25} />}
                  />
                )}
              </div>
            </div>
          </form>

          <p className="composer-footnote">
            {getProviderFootnote(
              selectedProvider,
              selectedProvider === 'webllm'
                ? webllmState?.loadedModelId &&
                  (webllmState.loadedModelId === webllmModelId ||
                    WEBLLM_MODEL_CATALOG[webllmModelId]?.f32FallbackModelId ===
                      webllmState.loadedModelId)
                  ? webllmState.loadedModelId
                  : webllmState?.hasShaderF16 === false &&
                      WEBLLM_MODEL_CATALOG[webllmModelId]?.f32FallbackModelId
                    ? WEBLLM_MODEL_CATALOG[webllmModelId].f32FallbackModelId
                    : webllmModelId
                : webllmModelId
            )}
          </p>
        </div>
      </div>

      {previewingComposerAttachment && (
        <React.Suspense fallback={null}>
          <DocumentPreviewModal
            isOpen={Boolean(previewingComposerAttachment)}
            onClose={() => setPreviewingComposerAttachment(null)}
            attachment={previewingComposerAttachment}
          />
        </React.Suspense>
      )}

      {imageModalOpen && (
        <ImagePromptModal
          isOpen={imageModalOpen}
          onClose={() => setImageModalOpen(false)}
          onSubmit={(options) => {
            if (onInputChange && inputValue.trim()) {
              onInputChange('');
            }
            if (onGenerateImage) {
              onGenerateImage(options);
            }
          }}
          initialPrompt={inputValue.trim()}
          providerConfig={providerConfig}
        />
      )}
    </main>
  );
}
