
import React, { useState, useRef, useEffect } from 'react';
import Layout from '../components/layout/Layout.jsx';
import ChatArea from '../components/chat/ChatArea.jsx';
import { SAMPLE_CHATS } from '../config/sampleData.js';
import { streamAIMessage, DEFAULT_PROVIDER, PROVIDER_OPTIONS } from '../services/aiRouter.js';
import {
  createChatDocument,
  saveChatMessage,
  renameConversation,
  deleteConversation,
  deleteChatMessages,
  toggleChatPinned,
  subscribeToUserChats,
  loadConversationMessages,
  generateChatTitle,
  updateChatMode,
  getCachedUserChats,
  saveCachedChatMessages,
  sanitizeMessageForStorage,
  syncOfflineUserChatsToFirestore
} from '../services/chatStorageService.js';
import { exportAsMarkdown, exportAsPlainText } from '../utils/exportConversation.js';
import {
  isFirebaseConfigured,
  isBrowserOnline,
  subscribeToNetworkStatus
} from '../config/firebaseConfig.js';
import { getChatMode } from '../config/chatModes.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { useSpeech } from '../context/SpeechContext.jsx';
import {
  saveAttachmentBlob,
  hydrateAttachmentsWithImageBytes,
  sanitizeAttachmentForNetwork
} from '../services/attachmentStorageService.js';
import { isVisionCapableProvider } from '../services/documentContextService.js';
import {
  isContinuationRequest,
  resolveMultiPartContext,
  responseHasContinuationNotice
} from '../services/multiPartResponseService.js';
import {
  normalizeAssistantMessage,
  addAlternativeToAssistantMessage,
  switchActiveAlternativeInMessage,
  updateActiveAlternativeInMessage,
  ensureConversationAlternatives,
  createAlternativeRecord,
  getActiveAlternative
} from '../services/alternativeResponseService.js';
import {
  DEFAULT_WEBLLM_MODEL_ID,
  WEBLLM_MODEL_CATALOG,
  getWebLLMState,
  subscribeWebLLMState,
  checkWebGPUSupport,
  inspectWebLLMReadiness,
  ensureWebLLMEngine,
  stopWebLLMGeneration,
  unloadWebLLMEngine
} from '../services/webllmService.js';
import {
  extractBrowserDocument,
  isBrowserExtractable
} from '../services/browserDocumentExtractor.js';
import {
  getAppShellState,
  subscribeAppShellState
} from '../services/serviceWorkerManager.js';
import { AlertCircle, X, Check, WifiOff } from 'lucide-react';

export default function ChatPage() {
  const { currentUser, username } = useAuth();
  const { settings } = useSettings();
  const { stopSpeech } = useSpeech();

  const isGuestUser = Boolean(
    !currentUser?.uid ||
    currentUser?.isAnonymous ||
    String(currentUser.uid).startsWith('guest-')
  );
  const isCloudEnabled = isFirebaseConfigured() && !isGuestUser;

  const [isOffline, setIsOffline] = useState(() => !isBrowserOnline());
  const [offlineBannerDismissed, setOfflineBannerDismissed] = useState(false);
  const [userChats, setUserChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(isCloudEnabled && isBrowserOnline());

  const [activeChatId, setActiveChatId] = useState(() => {
    if (typeof window !== 'undefined') {
      return (
        sessionStorage.getItem('orvix_active_chat') ||
        sessionStorage.getItem('chatora_active_chat') ||
        null
      );
    }
    return null;
  });

  const [activeMode, setActiveMode] = useState(() => {
    return settings?.defaultMode || 'general';
  });
  const [modeChangeNotice, setModeChangeNotice] = useState(null);

  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [persistenceError, setPersistenceError] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);

  const [selectedProvider, setSelectedProvider] = useState(() => {
    if (typeof window !== 'undefined') {
      return (
        localStorage.getItem('orvix_selected_provider') ||
        localStorage.getItem('chatora_selected_provider') ||
        DEFAULT_PROVIDER
      );
    }
    return DEFAULT_PROVIDER;
  });

  const [webllmModelId, setWebllmModelId] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('orvix_webllm_model_id');
      if (saved && WEBLLM_MODEL_CATALOG[saved]) {
        return saved;
      }
    }
    return DEFAULT_WEBLLM_MODEL_ID;
  });
  const [webllmState, setWebllmState] = useState(() => getWebLLMState());
  const [appShellState, setAppShellState] = useState(() => getAppShellState());
  const [webllmGpuCheck, setWebllmGpuCheck] = useState({
    checking: false,
    supported: null,
    message: null
  });

  const isSubmittingRef = useRef(false);
  const persistedMessageIdsRef = useRef(new Set());
  const activeChatIdRef = useRef(activeChatId);
  const fetchRequestIdRef = useRef(0);
  const skipNextChatLoadRef = useRef(null);
  const activeAnimationRef = useRef(null);
  const activeAbortControllerRef = useRef(null);
  const isUserStoppedRef = useRef(false);

  // Keep the active conversation ref synchronized with React state.
  activeChatIdRef.current = activeChatId;

  const handleSelectProvider = (provider) => {
    setSelectedProvider(provider);

    if (typeof window !== 'undefined') {
      localStorage.setItem('orvix_selected_provider', provider);
      localStorage.setItem('chatora_selected_provider', provider);
    }
  };

  const handleSelectWebLLMModel = (nextModelId) => {
    if (!nextModelId || !WEBLLM_MODEL_CATALOG[nextModelId]) return;
    setWebllmModelId(nextModelId);
    if (typeof window !== 'undefined') {
      localStorage.setItem('orvix_webllm_model_id', nextModelId);
    }
    void inspectWebLLMReadiness(nextModelId).catch(() => {});
  };

  // Subscribe to real Browser AI engine state updates
  useEffect(() => {
    return subscribeWebLLMState((snapshot) => {
      setWebllmState(snapshot);
    });
  }, []);

  // Subscribe to service worker app-shell offline readiness updates
  useEffect(() => {
    return subscribeAppShellState((state) => {
      setAppShellState(state);
    });
  }, []);

  // Inspect WebGPU compatibility & local model cache status when Browser AI is active
  useEffect(() => {
    if (selectedProvider !== 'webllm') {
      return undefined;
    }
    let cancelled = false;
    setWebllmGpuCheck((prev) => ({ ...prev, checking: true }));
    inspectWebLLMReadiness(webllmModelId)
      .then((res) => {
        if (cancelled) return;
        setWebllmGpuCheck({
          checking: false,
          supported: Boolean(res?.gpuSupport?.supported),
          message: res?.gpuSupport?.message || null
        });
      })
      .catch(() => {
        if (cancelled) return;
        setWebllmGpuCheck({
          checking: false,
          supported: false,
          message: 'Unable to verify WebGPU support in this browser.'
        });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProvider, webllmModelId]);

  const handleLoadWebLLMModel = () => {
    if (
      webllmState.status === 'checking' ||
      webllmState.status === 'downloading' ||
      webllmState.status === 'loading' ||
      webllmState.status === 'generating'
    ) {
      return;
    }
    void ensureWebLLMEngine({ modelId: webllmModelId }).catch((err) => {
      if (err?.name !== 'AbortError') {
        console.warn('[Orvix Browser AI] Initialization failed:', err?.message || err);
      }
    });
  };

  const handleCancelWebLLMLoad = () => {
    stopWebLLMGeneration();
  };

  const handleUnloadWebLLMModel = () => {
    if (isLoading || webllmState.status === 'generating') return;
    void unloadWebLLMEngine();
  };

  // Stop any running animation, speech synthesis, and network request when the page unmounts.
  useEffect(() => {
    return () => {
      stopSpeech();
      if (activeAbortControllerRef.current) {
        try {
          activeAbortControllerRef.current.abort();
        } catch (_) {}
      }
      if (activeAnimationRef.current) {
        activeAnimationRef.current();
      }
    };
  }, [stopSpeech]);

  // Auto-dismiss export notification banner
  useEffect(() => {
    if (!exportNotice) return;
    const timer = setTimeout(() => {
      setExportNotice(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [exportNotice]);

  // Auto-dismiss mode change notification banner
  useEffect(() => {
    if (!modeChangeNotice) return;
    const timer = setTimeout(() => {
      setModeChangeNotice(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [modeChangeNotice]);

  // Synchronize starting mode with user's configured default mode on empty new chat
  useEffect(() => {
    if (!activeChatId && settings?.defaultMode) {
      setActiveMode(settings.defaultMode);
    }
  }, [settings?.defaultMode, activeChatId]);

  // Guest storage helpers.
  const getGuestPinnedIds = () => {
    try {
      if (typeof window !== 'undefined') {
        const stored =
          localStorage.getItem('orvix_guest_pins') ||
          localStorage.getItem('chatora_guest_pins');

        return stored ? JSON.parse(stored) : [];
      }
    } catch (error) {
      console.warn('Could not read guest pins:', error);
    }

    return [];
  };

  const saveGuestPinnedIds = (pinnedIds) => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(
          'orvix_guest_pins',
          JSON.stringify(pinnedIds)
        );
        localStorage.setItem(
          'chatora_guest_pins',
          JSON.stringify(pinnedIds)
        );
      }
    } catch (error) {
      console.warn('Could not save guest pins:', error);
    }
  };

  const getGuestChats = () => {
    try {
      if (typeof window !== 'undefined') {
        const stored =
          localStorage.getItem('orvix_guest_chats') ||
          localStorage.getItem('chatora_guest_chats');

        if (stored) {
          const parsed = JSON.parse(stored);
          return Array.isArray(parsed) ? parsed : null;
        }
      }
    } catch (error) {
      console.warn('Could not read guest chats:', error);
    }

    return null;
  };

  const saveGuestChats = (chats) => {
    try {
      if (typeof window !== 'undefined' && Array.isArray(chats)) {
        // Strip heavy raw File/base64/dataUrl payloads before saving to 5MB localStorage
        // (full image blobs are already persisted in IndexedDB via saveAttachmentBlob, and OCR text lives in extraction)
        const sanitizedChats = chats.map((chat) => {
          if (!chat || !Array.isArray(chat.messages)) return chat;
          return {
            ...chat,
            messages: chat.messages.map((msg) => sanitizeMessageForStorage(msg))
          };
        });
        const serialized = JSON.stringify(sanitizedChats);
        localStorage.setItem('orvix_guest_chats', serialized);
        localStorage.setItem('chatora_guest_chats', serialized);
      }
    } catch (error) {
      console.warn('Could not save guest chats:', error);
    }
  };

  // Listen for browser online/offline transitions and reconcile pending chats when connectivity returns
  useEffect(() => {
    return subscribeToNetworkStatus((online) => {
      setIsOffline(!online);
      if (!online) {
        setOfflineBannerDismissed(false);
      } else {
        // Clear stale offline Firestore errors upon reconnecting
        setPersistenceError((prev) =>
          prev && prev.toLowerCase().includes('firestore') ? null : prev
        );
        if (isCloudEnabled && currentUser?.uid) {
          syncOfflineUserChatsToFirestore(currentUser.uid)
            .then(() => {
              const refreshed = getCachedUserChats(currentUser.uid);
              if (refreshed.length > 0) {
                setUserChats(refreshed);
              }
            })
            .catch((err) => {
              console.warn('Background offline chat sync warning:', err);
            });
        }
      }
    });
  }, [isCloudEnabled, currentUser?.uid]);

  // 1. Subscribe to the conversation list (re-subscribes cleanly when transitioning back online).
  useEffect(() => {
    if (!isCloudEnabled || !currentUser?.uid) {
      const guestPinned = getGuestPinnedIds();
      const savedGuestChats = getGuestChats();
      const baseChats = savedGuestChats || SAMPLE_CHATS;

      const initialGuestChats = baseChats.map((chat) => ({
        ...chat,
        isPinned:
          guestPinned.includes(chat.id) || Boolean(chat.isPinned)
      }));

      setUserChats(initialGuestChats);
      setChatsLoading(false);
      return undefined;
    }

    if (isOffline) {
      const cached = getCachedUserChats(currentUser.uid);
      setUserChats(cached);
      setChatsLoading(false);
      return undefined;
    }

    // Reconcile any pending offline chats when mounting online
    void syncOfflineUserChatsToFirestore(currentUser.uid);

    const cachedInitial = getCachedUserChats(currentUser.uid);
    if (cachedInitial.length > 0) {
      setUserChats(cachedInitial);
      setChatsLoading(false);
    } else {
      setChatsLoading(true);
    }

    const unsubscribe = subscribeToUserChats(
      currentUser.uid,
      (chats) => {
        setUserChats(chats);
        setChatsLoading(false);
      },
      (error) => {
        console.warn('Firestore subscription error:', error);
        if (isBrowserOnline()) {
          setPersistenceError(
            'Unable to sync conversation list from Cloud Firestore.'
          );
        }
        setChatsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [isCloudEnabled, currentUser?.uid, isOffline]);

  // 2. Restore conversation messages safely.
  useEffect(() => {
    stopSpeech();
    const currentRequestId = ++fetchRequestIdRef.current;

    // A newly created chat already has messages in component state.
    // Do not load an empty Firestore document over those messages.
    if (
      activeChatId &&
      skipNextChatLoadRef.current === activeChatId
    ) {
      skipNextChatLoadRef.current = null;

      sessionStorage.setItem('orvix_active_chat', activeChatId);
      sessionStorage.setItem('chatora_active_chat', activeChatId);

      setMessagesLoading(false);
      return undefined;
    }

    if (!activeChatId) {
      setMessages([]);
      setMessagesLoading(false);
      setActiveMode(settings?.defaultMode || 'general');
      sessionStorage.removeItem('orvix_active_chat');
      sessionStorage.removeItem('chatora_active_chat');
      return undefined;
    }

    sessionStorage.setItem('orvix_active_chat', activeChatId);
    sessionStorage.setItem('chatora_active_chat', activeChatId);

    // Sync active mode from chat metadata (default to 'general' for legacy chats)
    const matchingChat =
      userChats.find((chat) => chat.id === activeChatId) ||
      SAMPLE_CHATS.find((chat) => chat.id === activeChatId);
    if (matchingChat) {
      setActiveMode(matchingChat.mode || 'general');
    }

    // Demo conversations.
    const sample = SAMPLE_CHATS.find(
      (chat) => chat.id === activeChatId
    );

    if (sample) {
      setMessages(ensureConversationAlternatives(sample.messages));
      setActiveMode(sample.mode || 'general');
      setMessagesLoading(false);
      return undefined;
    }

    // Guest conversations.
    const guestChat = userChats.find(
      (chat) => chat.id === activeChatId
    );

    if (
      !isCloudEnabled &&
      guestChat &&
      Array.isArray(guestChat.messages)
    ) {
      setMessages(ensureConversationAlternatives(guestChat.messages));
      setMessagesLoading(false);
      return undefined;
    }

    // Cloud conversations.
    if (isCloudEnabled && currentUser?.uid) {
      let cancelled = false;

      setMessagesLoading(true);

      loadConversationMessages(currentUser.uid, activeChatId)
        .then((loadedMessages) => {
          if (
            cancelled ||
            fetchRequestIdRef.current !== currentRequestId ||
            activeChatIdRef.current !== activeChatId
          ) {
            return;
          }

          const safeMessages = Array.isArray(loadedMessages)
            ? ensureConversationAlternatives(loadedMessages)
            : [];

          setMessages(safeMessages);

          safeMessages.forEach((message) => {
            if (message.id) {
              persistedMessageIdsRef.current.add(message.id);
            }
          });
        })
        .catch((error) => {
          if (
            cancelled ||
            fetchRequestIdRef.current !== currentRequestId
          ) {
            return;
          }

          console.error(
            'Failed to load conversation messages:',
            error
          );

          if (isBrowserOnline()) {
            setPersistenceError(
              'Failed to load conversation history from Cloud Firestore.'
            );
          }
        })
        .finally(() => {
          if (
            !cancelled &&
            fetchRequestIdRef.current === currentRequestId
          ) {
            setMessagesLoading(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }

    setMessagesLoading(false);
    return undefined;
  }, [activeChatId, isCloudEnabled, currentUser?.uid]);

  const currentChat = userChats.find(
    (chat) => chat.id === activeChatId
  );

  const activeTitle = currentChat
    ? currentChat.title
    : messages.length > 0
      ? 'Current Conversation'
      : null;

  // Start a fresh conversation.
  const handleNewChat = () => {
    stopSpeech();

    if (activeAbortControllerRef.current) {
      try {
        activeAbortControllerRef.current.abort();
      } catch (_) {}
      activeAbortControllerRef.current = null;
    }

    if (activeAnimationRef.current) {
      activeAnimationRef.current();
      activeAnimationRef.current = null;
    }

    // Invalidate any outstanding history load.
    fetchRequestIdRef.current += 1;
    activeChatIdRef.current = null;

    setActiveChatId(null);
    setMessages([]);
    setInputValue('');
    setEditingMessageId(null);
    setIsLoading(false);
    setMessagesLoading(false);
    isSubmittingRef.current = false;
    setModeChangeNotice(null);
    setActiveMode(settings?.defaultMode || 'general');

    sessionStorage.removeItem('orvix_active_chat');
    sessionStorage.removeItem('chatora_active_chat');
  };

  // Switch conversations without allowing old history to overwrite new messages.
  const handleSelectChat = (chatId) => {
    if (chatId === activeChatIdRef.current) return;

    stopSpeech();

    if (activeAbortControllerRef.current) {
      try {
        activeAbortControllerRef.current.abort();
      } catch (_) {}
      activeAbortControllerRef.current = null;
    }

    if (activeAnimationRef.current) {
      activeAnimationRef.current();
      activeAnimationRef.current = null;
    }

    setIsLoading(false);
    isSubmittingRef.current = false;
    setEditingMessageId(null);

    fetchRequestIdRef.current += 1;
    activeChatIdRef.current = chatId;

    setActiveChatId(chatId);
    setInputValue('');
    setMessages([]);
    setMessagesLoading(Boolean(isCloudEnabled));
  };

  // Rename a conversation.
  const handleRenameChat = async (chatId, newTitle) => {
    const sanitized = (newTitle || '').trim();
    if (!sanitized) return;

    try {
      if (isCloudEnabled && currentUser?.uid) {
        await renameConversation(
          currentUser.uid,
          chatId,
          sanitized
        );
        setUserChats((previous) =>
          previous.map((chat) =>
            chat.id === chatId ? { ...chat, title: sanitized } : chat
          )
        );
      } else {
        setUserChats((previous) => {
          const next = previous.map((chat) =>
            chat.id === chatId
              ? { ...chat, title: sanitized }
              : chat
          );

          saveGuestChats(next);
          return next;
        });
      }
    } catch (error) {
      console.error('Failed to rename conversation:', error);
      setPersistenceError('Failed to rename conversation.');
    }
  };

  // Delete a conversation.
  const handleDeleteChat = async (chatId) => {
    try {
      if (isCloudEnabled && currentUser?.uid) {
        await deleteConversation(currentUser.uid, chatId);
        setUserChats((previous) =>
          previous.filter((chat) => chat.id !== chatId)
        );
      } else {
        setUserChats((previous) => {
          const next = previous.filter(
            (chat) => chat.id !== chatId
          );

          saveGuestChats(next);
          return next;
        });
      }

      if (activeChatIdRef.current === chatId) {
        handleNewChat();
      }

      if (!isCloudEnabled || !currentUser?.uid) {
        const remainingPins = getGuestPinnedIds().filter(
          (id) => id !== chatId
        );

        saveGuestPinnedIds(remainingPins);
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      setPersistenceError(
        'Failed to delete conversation from Cloud Firestore.'
      );
    }
  };

  // Pin/unpin conversations, with a maximum of five pinned chats.
  const handleTogglePin = async (chatId) => {
    const targetChat = userChats.find(
      (chat) => chat.id === chatId
    );

    if (!targetChat) return;

    const willPin = !targetChat.isPinned;

    if (
      willPin &&
      userChats.filter((chat) => chat.isPinned).length >= 5
    ) {
      setPersistenceError(
        'You can pin up to 5 chats. Unpin a chat before pinning another.'
      );
      return;
    }

    setPersistenceError(null);

    if (isCloudEnabled && currentUser?.uid) {
      try {
        await toggleChatPinned(
          currentUser.uid,
          chatId,
          willPin
        );
        setUserChats((previous) =>
          previous.map((chat) =>
            chat.id === chatId
              ? {
                  ...chat,
                  isPinned: willPin,
                  pinnedAt: willPin ? Date.now() : null
                }
              : chat
          )
        );
      } catch (error) {
        console.error('Failed to toggle pin in Firestore:', error);
        setPersistenceError(
          error.message ||
            'Failed to update pin status in Cloud Firestore.'
        );
      }

      return;
    }

    setUserChats((previous) => {
      const next = previous.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              isPinned: willPin,
              pinnedAt: willPin ? Date.now() : null
            }
          : chat
      );

      saveGuestChats(next);
      saveGuestPinnedIds(
        next.filter((chat) => chat.isPinned).map((chat) => chat.id)
      );

      return next;
    });
  };

  // Handle mode selection (both on New Chat and in active conversations)
  const handleSelectMode = async (newMode) => {
    const modeObj = getChatMode(newMode);
    setActiveMode(newMode);

    // If there is an active conversation, persist the mode change to that conversation
    if (activeChatIdRef.current) {
      const currentChatId = activeChatIdRef.current;
      setModeChangeNotice(
        `Switched to ${modeObj.name} mode. Subsequent responses will follow ${modeObj.shortName} guidelines, preserving existing message history.`
      );

      // Persist to Cloud Firestore or Guest Storage
      if (isCloudEnabled && currentUser?.uid) {
        updateChatMode(currentUser.uid, currentChatId, newMode).catch((err) => {
          console.warn('Could not update conversation mode in Cloud Firestore:', err);
        });
      } else {
        setUserChats((previous) => {
          const next = previous.map((chat) =>
            chat.id === currentChatId
              ? {
                  ...chat,
                  mode: newMode,
                  rawUpdatedAt: Date.now()
                }
              : chat
          );
          saveGuestChats(next);
          return next;
        });
      }
    }
  };

  // Persist messages without duplicate writes (unless forced update).
  const persistMessageSafe = async (chatId, message, force = false) => {
    if (!chatId || !message?.id) return;

    if (force) {
      persistedMessageIdsRef.current.delete(message.id);
    } else if (persistedMessageIdsRef.current.has(message.id)) {
      return;
    }

    // Reserve the ID before starting the asynchronous write.
    persistedMessageIdsRef.current.add(message.id);

    const normalizedMessage =
      message.sender === 'assistant'
        ? normalizeAssistantMessage(message)
        : message;

    if (isCloudEnabled && currentUser?.uid) {
      try {
        await saveChatMessage(
          currentUser.uid,
          chatId,
          normalizedMessage
        );
        // Keep sidebar conversation list updated immediately while offline
        if (!isBrowserOnline()) {
          const cached = getCachedUserChats(currentUser.uid);
          if (cached.length > 0) {
            setUserChats(cached);
          }
        }
      } catch (error) {
        // Allow a future retry if this write failed.
        persistedMessageIdsRef.current.delete(message.id);

        console.warn('Firestore write warning:', error);
        if (isBrowserOnline()) {
          setPersistenceError(
            'Notice: Could not save message to Cloud Firestore. Saved locally on this device.'
          );
        }
      }

      return;
    }

    setUserChats((previous) => {
      const next = previous.map((chat) => {
        if (chat.id !== chatId) return chat;

        const hasExisting = (chat.messages || []).some(
          (item) => item.id === normalizedMessage.id
        );

        const updatedMessages = hasExisting
          ? (chat.messages || []).map((item) => (item.id === normalizedMessage.id ? normalizedMessage : item))
          : [...(chat.messages || []), normalizedMessage];

        return {
          ...chat,
          rawUpdatedAt: Date.now(),
          messages: updatedMessages
        };
      });

      saveGuestChats(next);
      return next;
    });
  };

  /**
   * Run the AI request and animate its response.
   */
  const executePrompt = async (
    promptText,
    historyContext,
    targetChatId,
    assistantMessageId,
    overrideProvider = null,
    currentAttachments = [],
    multiPartParams = {},
    customStartTime = null,
    overrideModel = null
  ) => {
    const providerToUse = overrideProvider || selectedProvider;
    setIsLoading(true);
    isUserStoppedRef.current = false;

    // Stop any existing network request and animation pump.
    if (activeAbortControllerRef.current) {
      try {
        activeAbortControllerRef.current.abort();
      } catch (_) {}
      activeAbortControllerRef.current = null;
    }

    if (activeAnimationRef.current) {
      activeAnimationRef.current();
      activeAnimationRef.current = null;
    }

    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;

    let requestStartTime =
      typeof customStartTime === 'number' && customStartTime > 0
        ? customStartTime
        : performance.now();
    let measuredResponseTimeMs = null;

    let targetText = '';
    let displayedText = '';
    const effectiveModelOverride =
      overrideModel || (providerToUse === 'webllm' ? webllmModelId : null);
    let activeModel = effectiveModelOverride;
    let finalProvider = providerToUse;
    let isStreamDone = false;
    let timerId = null;
    let isCancelled = false;
    let isFinalized = false;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')
        ?.matches;

    const cancelCurrentAnimation = () => {
      isCancelled = true;

      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };

    activeAnimationRef.current = cancelCurrentAnimation;

    // Finalize exactly once. Do not call cancelCurrentAnimation first:
    // cancellation intentionally prevents this function from running.
    const finalizeAssistantMessage = async (
      contentToSave,
      modelToUse,
      providerToFinalize,
      isStopped = false,
      responseTime = null
    ) => {
      if (isCancelled || isFinalized) return;

      isFinalized = true;

      const finalResponseTime = !isStopped
        ? (responseTime ?? measuredResponseTimeMs)
        : null;

      let completedMessage = null;

      if (activeChatIdRef.current === targetChatId) {
        setMessages((previous) => {
          return previous.map((message) => {
            if (message.id !== assistantMessageId) return message;
            const normalized = normalizeAssistantMessage(message);
            const finalized = updateActiveAlternativeInMessage(normalized, {
              content: contentToSave,
              modelUsed: modelToUse || activeModel || normalized.modelUsed,
              provider: providerToFinalize || finalProvider || providerToUse || normalized.provider,
              responseTimeMs: typeof finalResponseTime === 'number' ? finalResponseTime : normalized.responseTimeMs,
              isStreaming: false,
              isStopped: Boolean(isStopped),
              referencedAttachments: undefined
            });
            completedMessage = finalized;
            return finalized;
          });
        });
      }

      if (!completedMessage) {
        completedMessage = normalizeAssistantMessage({
          id: assistantMessageId,
          sender: 'assistant',
          provider: providerToFinalize || finalProvider || providerToUse,
          modelUsed: modelToUse || activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: contentToSave,
          isStreaming: false,
          isStopped: Boolean(isStopped),
          responseTimeMs: typeof finalResponseTime === 'number' ? finalResponseTime : undefined,
          referencedAttachments: undefined
        });
      }

      if (targetChatId) {
        await persistMessageSafe(targetChatId, completedMessage, true);
      }

      if (activeAnimationRef.current === cancelCurrentAnimation) {
        activeAnimationRef.current = null;
      }

      if (activeAbortControllerRef.current === abortController) {
        activeAbortControllerRef.current = null;
      }

      setIsLoading(false);
      isSubmittingRef.current = false;
    };

    // Gradually reveal the received response.
    const pumpAnimation = () => {
      timerId = null;

      if (isCancelled || isFinalized) return;

      if (activeChatIdRef.current !== targetChatId) {
        return;
      }

      const backlog = targetText.length - displayedText.length;

      if (backlog > 0) {
        if (prefersReducedMotion) {
          displayedText = targetText;
        } else {
          let stepSize = 1;

          if (backlog > 500) {
            stepSize = Math.ceil(backlog / 16);
          } else if (backlog > 200) {
            stepSize = Math.ceil(backlog / 12);
          } else if (backlog > 80) {
            stepSize = Math.ceil(backlog / 8);
          } else if (backlog > 30) {
            stepSize = Math.ceil(backlog / 5);
          } else if (backlog > 8) {
            stepSize = 2;
          }

          displayedText = targetText.slice(
            0,
            displayedText.length + stepSize
          );
        }

        setMessages((previous) =>
          previous.map((message) => {
            if (message.id !== assistantMessageId) return message;
            const normalized = normalizeAssistantMessage(message);
            return updateActiveAlternativeInMessage(normalized, {
              content: displayedText,
              modelUsed: activeModel || message.modelUsed,
              provider: finalProvider || message.provider,
              isStreaming: true,
              referencedAttachments: undefined
            });
          })
        );

        timerId = setTimeout(pumpAnimation, 18);
        return;
      }

      if (isStreamDone) {
        void finalizeAssistantMessage(
          targetText,
          activeModel,
          finalProvider,
          false,
          measuredResponseTimeMs
        );
      }
    };

    const triggerPump = () => {
      if (isCancelled || isFinalized || timerId !== null) return;

      timerId = setTimeout(pumpAnimation, 10);
    };

    if (!requestStartTime) {
      requestStartTime =
        typeof customStartTime === 'number' && customStartTime > 0
          ? customStartTime
          : performance.now();
    }
    if (activeChatIdRef.current === targetChatId) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessageId
            ? { ...message, requestStartTime, isStreaming: true }
            : message
        )
      );
    }
    try {
      let requestAttachments = currentAttachments;
      if (Array.isArray(currentAttachments) && currentAttachments.length > 0) {
        if (isVisionCapableProvider(providerToUse, effectiveModelOverride)) {
          try {
            requestAttachments = await hydrateAttachmentsWithImageBytes(currentAttachments, {
              provider: providerToUse,
              model: effectiveModelOverride
            });
          } catch (hydrateErr) {
            if (
              hydrateErr?.isPayloadError ||
              hydrateErr?.name === 'ImagePayloadLimitError' ||
              hydrateErr?.name === 'ImagePayloadValidationError' ||
              hydrateErr?.code === 413 ||
              hydrateErr?.code === 400 ||
              hydrateErr?.status === 'PAYLOAD_TOO_LARGE'
            ) {
              throw hydrateErr;
            }
            console.warn('[Chat] Failed to hydrate image attachments from IndexedDB:', hydrateErr);
          }
        } else {
          requestAttachments = currentAttachments.map((att) =>
            sanitizeAttachmentForNetwork(att, { includeImageBytes: false })
          );
        }
      }

      const result = await streamAIMessage({
        provider: providerToUse,
        model: effectiveModelOverride,
        mode: activeMode,
        prompt: promptText,
        history: historyContext,
        username:
          username || currentUser?.displayName || null,
        preferences: {
          responseLength: settings?.responseLength || 'balanced',
          beginnerFriendly: Boolean(settings?.beginnerFriendly)
        },
        signal: abortController.signal,
        conversationId: targetChatId,
        attachments: requestAttachments,
        isContinuation: multiPartParams.isContinuation,
        partNumber: multiPartParams.partNumber,
        originalPrompt: multiPartParams.originalPrompt,
        previousContentSummary: multiPartParams.previousContentSummary,

        onStart: ({ modelUsed, provider: reportedProvider } = {}) => {
          if (modelUsed) activeModel = modelUsed;
          if (reportedProvider) finalProvider = reportedProvider;

          if (activeChatIdRef.current === targetChatId) {
            setMessages((previous) =>
              previous.map((message) => {
                if (message.id !== assistantMessageId) return message;
                const normalized = normalizeAssistantMessage(message);
                return updateActiveAlternativeInMessage(normalized, {
                  modelUsed: activeModel,
                  provider: finalProvider,
                  referencedAttachments: undefined
                });
              })
            );
          }
        },

        onChunk: (_chunkText, currentAccumulated) => {
          // Accept the cumulative text supplied by the router.
          if (typeof currentAccumulated === 'string') {
            targetText = currentAccumulated;
          }

          triggerPump();
        }
      });

      // Stop timing when the AI response stream genuinely completes
      measuredResponseTimeMs = Math.max(1, Math.round(performance.now() - requestStartTime));

      const resolvedText =
        typeof result?.text === 'string'
          ? result.text
          : targetText;

      targetText = resolvedText;

      if (result?.modelUsed) activeModel = result.modelUsed;
      if (result?.provider) finalProvider = result.provider;

      isStreamDone = true;

      // Immediately set responseTimeMs on the active message so the live timer
      // stops and the final response time is displayed at the exact stream completion point
      if (activeChatIdRef.current === targetChatId) {
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id !== assistantMessageId) return message;
            const normalized = normalizeAssistantMessage(message);
            return updateActiveAlternativeInMessage(normalized, {
              responseTimeMs: measuredResponseTimeMs,
              modelUsed: activeModel || message.modelUsed,
              provider: finalProvider || message.provider
            });
          })
        );
      }

      // If the user has switched chats, persist this answer in the
      // original conversation without touching the currently visible chat.
      if (activeChatIdRef.current !== targetChatId) {
        cancelCurrentAnimation();

        let existingTargetMsg = null;
        setUserChats((chats) => {
          const chat = chats.find((c) => c.id === targetChatId);
          existingTargetMsg = chat?.messages?.find((m) => m.id === assistantMessageId);
          return chats;
        });

        const normalized = normalizeAssistantMessage(existingTargetMsg || {
          id: assistantMessageId,
          sender: 'assistant',
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          content: resolvedText
        });

        const completedMessage = updateActiveAlternativeInMessage(normalized, {
          content: resolvedText,
          modelUsed: activeModel,
          provider: finalProvider || providerToUse,
          isStreaming: false,
          responseTimeMs: measuredResponseTimeMs,
          referencedAttachments: undefined
        });

        if (targetChatId) {
          await persistMessageSafe(targetChatId, completedMessage, true);
        }

        setIsLoading(false);
        isSubmittingRef.current = false;
        return;
      }

      if (
        !prefersReducedMotion &&
        displayedText.length < targetText.length
      ) {
        triggerPump();
      } else {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }

        displayedText = targetText;

        await finalizeAssistantMessage(
          targetText,
          activeModel,
          finalProvider,
          false,
          measuredResponseTimeMs
        );
      }
    } catch (error) {
      isStreamDone = true;
      cancelCurrentAnimation();

      if (activeAnimationRef.current === cancelCurrentAnimation) {
        activeAnimationRef.current = null;
      }

      if (activeAbortControllerRef.current === abortController) {
        activeAbortControllerRef.current = null;
      }

      const isAbortedByUser =
        isUserStoppedRef.current ||
        abortController.signal.aborted ||
        error?.name === 'AbortError' ||
        String(error?.message || '').toLowerCase().includes('aborted');

      if (isAbortedByUser) {
        // Distinguish intentional stop from genuine error: preserve partial response
        const stoppedText =
          targetText.trim().length > 0 ? targetText : 'Response generation stopped.';

        let stoppedMessage = null;

        if (activeChatIdRef.current === targetChatId) {
          setMessages((previous) => {
            return previous.map((message) => {
              if (message.id !== assistantMessageId) return message;
              const normalized = normalizeAssistantMessage(message);
              const finalized = updateActiveAlternativeInMessage(normalized, {
                content: stoppedText,
                modelUsed: activeModel,
                provider: finalProvider || providerToUse,
                isStreaming: false,
                isStopped: true,
                referencedAttachments: undefined
              });
              stoppedMessage = finalized;
              return finalized;
            });
          });
        }

        if (targetChatId && stoppedMessage) {
          await persistMessageSafe(targetChatId, stoppedMessage, true);
        }

        setIsLoading(false);
        isSubmittingRef.current = false;
        return;
      }

      console.error('Streaming prompt execution error:', error);

      isStreamDone = true;
      cancelCurrentAnimation();

      if (activeAnimationRef.current === cancelCurrentAnimation) {
        activeAnimationRef.current = null;
      }

      // Parse error message and extract JSON if stringified
      let rawMsg = String(error?.message || '');
      if (rawMsg.includes('{') && rawMsg.includes('}')) {
        try {
          const match = rawMsg.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.error?.message) {
              rawMsg = parsed.error.message;
            }
          }
        } catch (_) {}
      }

      const effectiveProvider = error?.provider || finalProvider || providerToUse;
      const currentProviderConfig = Array.isArray(PROVIDER_OPTIONS)
        ? PROVIDER_OPTIONS.find((p) => p.id === effectiveProvider)
        : null;
      const providerDisplayName =
        currentProviderConfig?.name ||
        (effectiveProvider ? effectiveProvider.charAt(0).toUpperCase() + effectiveProvider.slice(1) : 'AI Provider');

      const isOllama = effectiveProvider === 'ollama';
      const isWebLLM = effectiveProvider === 'webllm';
      const isLocalProvider = isOllama || isWebLLM;
      const isGemini = effectiveProvider === 'gemini';

      const is503 =
        (error?.code === 503 ||
          error?.status === 'UNAVAILABLE' ||
          rawMsg.toLowerCase().includes('high demand') ||
          rawMsg.toLowerCase().includes('spikes in demand') ||
          rawMsg.toLowerCase().includes('overloaded')) &&
        error?.code !== 500;

      const is500 = error?.code === 500 || error?.status === 'INTERNAL';
      const isAuthError =
        error?.code === 401 ||
        error?.code === 403 ||
        error?.status === 'UNAUTHENTICATED' ||
        error?.status === 'PERMISSION_DENIED';
      const isRateLimit =
        error?.code === 429 || error?.status === 'RESOURCE_EXHAUSTED';
      const isPayloadError = Boolean(
        error?.isPayloadError ||
        error?.code === 413 ||
        error?.status === 'PAYLOAD_TOO_LARGE'
      );
      const isNotFound =
        !isPayloadError &&
        (error?.code === 404 ||
          error?.status === 'NOT_FOUND' ||
          rawMsg.toLowerCase().includes('not found') ||
          rawMsg.toLowerCase().includes('does not exist') ||
          rawMsg.toLowerCase().includes('access to it') ||
          rawMsg.toLowerCase().includes('decommissioned') ||
          rawMsg.toLowerCase().includes('retired'));

      let friendlyMsg = rawMsg;
      if (isPayloadError) {
        friendlyMsg =
          rawMsg ||
          'The attached image payload exceeds the supported request budget (3.0 MB max per image, 4.2 MB max total request). Please resize or compress the image and try again.';
      } else if (isOllama) {
        // Ollama errors are local, specific, and actionable. Never rewrite into cloud provider demand errors.
        if (rawMsg) {
          friendlyMsg = rawMsg;
        } else if (isNotFound) {
          friendlyMsg = `Local AI (Ollama) model 'qwen2.5:1.5b' was not found. Please pull the model locally using 'ollama pull qwen2.5:1.5b'.`;
        } else if (is503) {
          friendlyMsg = `Local AI (Ollama) is unavailable: could not connect to Ollama at http://127.0.0.1:11434. Make sure Ollama is running locally ('ollama serve').`;
        } else {
          friendlyMsg = `An error occurred with Local AI (Ollama). Please make sure Ollama is running locally and model 'qwen2.5:1.5b' is installed.`;
        }
      } else if (isWebLLM) {
        // Browser AI (WebLLM) errors are local device/WebGPU/cache messages — preserve them verbatim without cloud demand rewrites.
        friendlyMsg =
          rawMsg ||
          'Browser AI (WebLLM) encountered a local initialization or generation error on this device.';
      } else if (is503) {
        if (isGemini) {
          friendlyMsg =
            'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments, or switch to Groq, OpenRouter, or Local AI below.';
        } else {
          friendlyMsg =
            `${providerDisplayName} is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments, or switch to another provider below.`;
        }
      } else if (isNotFound) {
        friendlyMsg =
          rawMsg ||
          `The requested model for ${providerDisplayName} is unavailable or retired. Please choose another model or provider below.`;
      } else if (is500) {
        friendlyMsg =
          rawMsg && !rawMsg.includes('Server request failed') && !rawMsg.includes('Internal Server Error')
            ? `${providerDisplayName} encountered an internal error: ${rawMsg}. You can retry or switch to another provider below.`
            : `${providerDisplayName} encountered an internal error (HTTP 500). Please try again in a moment, or switch to another provider below.`;
      } else if (isAuthError) {
        friendlyMsg =
          `Authentication or permission error with ${providerDisplayName}. Please check your API key configuration or switch providers below.`;
      } else if (isRateLimit) {
        friendlyMsg =
          `${providerDisplayName} rate limit or quota exceeded. Please wait a moment before trying again, or switch providers below.`;
      } else if (!friendlyMsg) {
        friendlyMsg = `An unexpected error occurred while communicating with ${providerDisplayName}.`;
      }

      const isInterrupted = targetText.trim().length > 0;
      const errorContent = isInterrupted
        ? `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`
        : friendlyMsg;

      if (activeChatIdRef.current === targetChatId) {
        let finalizedErrorMessage = null;
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id !== assistantMessageId) return message;
            const normalized = normalizeAssistantMessage(message);
            const updated = updateActiveAlternativeInMessage(normalized, {
              content: errorContent,
              modelUsed: activeModel || normalized.modelUsed,
              provider: effectiveProvider || finalProvider || providerToUse || normalized.provider,
              isStreaming: false,
              isError: !isInterrupted,
              isInterrupted,
              failedPrompt: promptText,
              failedProvider: effectiveProvider || finalProvider || providerToUse,
              canSwitchProvider: error?.canFallback === false ? false : !isLocalProvider,
              referencedAttachments: undefined
            });
            finalizedErrorMessage = updated;
            return updated;
          })
        );

        if (targetChatId && finalizedErrorMessage) {
          await persistMessageSafe(targetChatId, finalizedErrorMessage, true);
        }
        setPersistenceError(friendlyMsg);
      } else if (targetChatId) {
        let existingTargetMsg = null;
        setUserChats((chats) => {
          const chat = chats.find((c) => c.id === targetChatId);
          existingTargetMsg = chat?.messages?.find((m) => m.id === assistantMessageId);
          return chats;
        });

        const normalized = normalizeAssistantMessage(existingTargetMsg || {
          id: assistantMessageId,
          sender: 'assistant',
          provider: effectiveProvider || finalProvider || providerToUse,
          modelUsed: activeModel,
          content: errorContent
        });

        const updated = updateActiveAlternativeInMessage(normalized, {
          content: errorContent,
          modelUsed: activeModel || normalized.modelUsed,
          provider: effectiveProvider || finalProvider || providerToUse || normalized.provider,
          isStreaming: false,
          isError: !isInterrupted,
          isInterrupted,
          failedPrompt: promptText,
          failedProvider: effectiveProvider || finalProvider || providerToUse,
          canSwitchProvider: error?.canFallback === false ? false : !isLocalProvider,
          referencedAttachments: undefined
        });

        await persistMessageSafe(targetChatId, updated, true);
      }

      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Submit a new message.
  const handleSubmit = async (attachments = [], promptOverride = null) => {
    stopSpeech();

    const rawText = promptOverride !== null ? promptOverride : inputValue;
    const trimmed = rawText
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    // Strictly enforce maximum 1 attachment per user message
    if (Array.isArray(attachments) && attachments.length > 1) {
      setPersistenceError('Only one attachment can be added per message. Remove the current attachment first to select a different one.');
      return false;
    }

    if ((!trimmed && !hasAttachments) || isLoading || isSubmittingRef.current) return false;

    // Reject offline requests for cloud providers immediately with actionable feedback
    if (!isBrowserOnline() && selectedProvider !== 'webllm' && selectedProvider !== 'ollama') {
      const providerConfig = Array.isArray(PROVIDER_OPTIONS)
        ? PROVIDER_OPTIONS.find((p) => p.id === selectedProvider)
        : null;
      const provName = providerConfig?.name || 'Cloud AI';
      setPersistenceError(
        `${provName} requires an internet connection. Switch to Browser AI (WebLLM) to chat offline on this device.`
      );
      return false;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    let processedAttachments = [];

    // Step 1: Upload or locally extract file attachments
    if (hasAttachments) {
      const filesToUpload = attachments.filter((att) => att.file);
      if (filesToUpload.length > 0) {
        // Enforce maximum single file size client-side before processing/network transmission
        const MAX_PER_FILE_BYTES = 25 * 1024 * 1024;
        const oversized = filesToUpload.find((f) => f.file && f.file.size > MAX_PER_FILE_BYTES);
        if (oversized) {
          setPersistenceError(`File '${oversized.name}' exceeds the maximum allowed size of 25MB.`);
          setIsLoading(false);
          isSubmittingRef.current = false;
          return false;
        }

        const isWebLLM = selectedProvider === 'webllm';
        const clientOnline = isBrowserOnline();

        // Safe browser-local path for Browser AI (WebLLM) when offline
        if (isWebLLM && !clientOnline) {
          const localExtractedAttachments = [];
          for (const att of filesToUpload) {
            // If already extracted, reuse existing extraction
            if (att.extraction?.status === 'ready' && att.extraction?.text) {
              await saveAttachmentBlob(att.id, att.file, {
                name: att.name,
                originalName: att.originalName || att.name,
                mimeType: att.type || att.file.type,
                size: att.size || att.file.size,
                formattedSize: att.formattedSize,
                extension: att.extension,
                isImage: Boolean(att.isImage),
                conversationId: activeChatIdRef.current || null
              });
              localExtractedAttachments.push({
                ...att,
                status: 'ready',
                extraction: att.extraction
              });
              continue;
            }

            // Perform browser-side extraction
            const extResult = await extractBrowserDocument(att.file, {
              id: att.id,
              name: att.name,
              originalName: att.originalName || att.name,
              mimeType: att.type || att.file.type,
              extension: att.extension
            });

            if (extResult.isImage || extResult.status === 'unsupported_offline') {
              setPersistenceError(
                'Image text recognition (OCR) requires an internet connection. Connect to the internet to process image text, or attach a text document (PDF, DOCX, PPTX, TXT, MD, CSV, JSON, XML).'
              );
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }

            if (extResult.status === 'scanned_or_image_only') {
              setPersistenceError(
                extResult.warning ||
                  'No readable text could be extracted from this PDF. This document appears to be scanned or contains rasterized pages without a text layer. Please attach a text-based document or connect to the internet.'
              );
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }

            if (extResult.status === 'empty') {
              setPersistenceError(`The attached file '${att.name}' is empty (0 bytes). Please attach a file with content.`);
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }

            if (extResult.status === 'encrypted') {
              setPersistenceError(
                extResult.error || `The attached document '${att.name}' is password-protected or encrypted.`
              );
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }

            if (!extResult.success || extResult.status === 'unsupported_format' || extResult.status === 'corrupted' || extResult.status === 'error') {
              setPersistenceError(
                extResult.error || extResult.warning || `Cannot extract text locally from '${att.name}'. Supported offline formats: PDF, DOCX, PPTX, TXT, MD, CSV, TSV, JSON, XML.`
              );
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }

            if (!extResult.text || !extResult.text.trim()) {
              setPersistenceError(
                `No readable text content was found in '${att.name}'. Please attach a document containing text.`
              );
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }

            // Save binary to IndexedDB
            await saveAttachmentBlob(att.id || extResult.fileId, att.file, {
              name: att.name,
              originalName: att.originalName || att.name,
              mimeType: att.type || att.file.type,
              size: att.size || att.file.size,
              formattedSize: att.formattedSize,
              extension: att.extension,
              isImage: Boolean(att.isImage),
              conversationId: activeChatIdRef.current || null
            });

            localExtractedAttachments.push({
              id: att.id || extResult.fileId,
              name: att.name || extResult.originalName,
              originalName: att.originalName || att.name,
              size: att.size || att.file.size,
              formattedSize: att.formattedSize,
              type: att.type || att.file.type,
              extension: att.extension,
              isImage: Boolean(att.isImage),
              status: extResult.status,
              file: att.file,
              previewUrl: att.previewUrl,
              extraction: extResult
            });
          }

          processedAttachments = localExtractedAttachments;
        } else {
          // Online upload path (or cloud / Ollama provider)
          const uploadController = new AbortController();
          const UPLOAD_TIMEOUT_MS = 300000;
          let isTimeout = false;
          const uploadTimeoutId = setTimeout(() => {
            isTimeout = true;
            try {
              uploadController.abort(new DOMException('Upload timed out after 5 minutes.', 'TimeoutError'));
            } catch (_) {
              uploadController.abort();
            }
          }, UPLOAD_TIMEOUT_MS);

          try {
            const formData = new FormData();
            if (activeChatIdRef.current) {
              formData.append('conversationId', activeChatIdRef.current);
            }
            formData.append('provider', selectedProvider || DEFAULT_PROVIDER);
            formData.append('offline', String(!isBrowserOnline()));
            filesToUpload.forEach((att) => {
              formData.append('files', att.file, att.name);
            });

            let uploadRes;
            try {
              uploadRes = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
                signal: uploadController.signal
              });
            } finally {
              clearTimeout(uploadTimeoutId);
            }

            if (!uploadRes.ok) {
              let errorMsg = `Upload failed (${uploadRes.status})`;
              try {
                const errData = await uploadRes.json();
                if (errData?.error) {
                  errorMsg = errData.error;
                }
              } catch (_) {}

              // If Browser AI is selected and upload returned an error, attempt browser extraction fallback!
              if (isWebLLM) {
                console.warn('Server upload endpoint failed for Browser AI, attempting local browser extraction fallback...');
                const fallbackLocalAttachments = [];
                for (const att of filesToUpload) {
                  const extResult = await extractBrowserDocument(att.file, {
                    id: att.id,
                    name: att.name,
                    originalName: att.originalName || att.name,
                    mimeType: att.type || att.file.type,
                    extension: att.extension
                  });
                  if (!extResult.success || !extResult.text) {
                    throw new Error(extResult.error || extResult.warning || `Cannot extract text locally from '${att.name}'.`);
                  }
                  await saveAttachmentBlob(att.id || extResult.fileId, att.file, {
                    name: att.name,
                    originalName: att.originalName || att.name,
                    mimeType: att.type || att.file.type,
                    size: att.size || att.file.size,
                    formattedSize: att.formattedSize,
                    extension: att.extension,
                    isImage: Boolean(att.isImage),
                    conversationId: activeChatIdRef.current || null
                  });
                  fallbackLocalAttachments.push({
                    id: att.id || extResult.fileId,
                    name: att.name || extResult.originalName,
                    originalName: att.originalName || att.name,
                    size: att.size || att.file.size,
                    formattedSize: att.formattedSize,
                    type: att.type || att.file.type,
                    extension: att.extension,
                    isImage: Boolean(att.isImage),
                    status: extResult.status,
                    file: att.file,
                    previewUrl: att.previewUrl,
                    extraction: extResult
                  });
                }
                processedAttachments = fallbackLocalAttachments;
              } else {
                setPersistenceError(errorMsg);
                setIsLoading(false);
                isSubmittingRef.current = false;
                return false;
              }
            } else {
              const uploadData = await uploadRes.json();
              const rawUploaded = Array.isArray(uploadData?.attachments)
                ? uploadData.attachments
                : [];

              // Persist file blobs into IndexedDB first so React message state never needs large base64/dataUrl strings
              processedAttachments = await Promise.all(
                rawUploaded.map(async (proc, idx) => {
                  const orig =
                    filesToUpload[idx] ||
                    filesToUpload.find(
                      (f) => f.name === (proc.originalName || proc.name)
                    );
                  const { base64: _b64, dataUrl: _dUrl, data: _rawData, ...cleanProc } = proc || {};
                  let savedInIdb = false;

                  if (cleanProc.id && orig?.file) {
                    try {
                      savedInIdb = await saveAttachmentBlob(cleanProc.id, orig.file, {
                        name: cleanProc.name || orig.name,
                        originalName: cleanProc.originalName || orig.name,
                        mimeType: cleanProc.type || cleanProc.mimeType || orig.file.type,
                        size: cleanProc.size || orig.file.size,
                        formattedSize: cleanProc.formattedSize || orig.formattedSize,
                        extension: cleanProc.extension || orig.extension,
                        isImage: Boolean(cleanProc.isImage || orig.isImage),
                        conversationId: activeChatIdRef.current || null
                      });
                    } catch (e) {
                      console.warn('Could not cache blob in IndexedDB:', e);
                    }
                  }

                  const safePreviewUrl =
                    typeof orig?.previewUrl === 'string' && orig.previewUrl.startsWith('blob:')
                      ? orig.previewUrl
                      : undefined;

                  return {
                    ...cleanProc,
                    ...(savedInIdb ? {} : orig?.file ? { file: orig.file } : {}),
                    ...(safePreviewUrl ? { previewUrl: safePreviewUrl } : {}),
                    isImage: Boolean(cleanProc.isImage || orig?.isImage)
                  };
                })
              );
            }
          } catch (uploadErr) {
            console.error('File upload network error:', uploadErr);

            // If selectedProvider is Browser AI, gracefully fallback to browser-side text extraction!
            if (isWebLLM) {
              try {
                console.warn('Network upload failed for Browser AI, attempting local browser extraction fallback...');
                const fallbackLocalAttachments = [];
                for (const att of filesToUpload) {
                  if (att.extraction?.status === 'ready' && att.extraction?.text) {
                    fallbackLocalAttachments.push({ ...att, status: 'ready' });
                    continue;
                  }

                  const extResult = await extractBrowserDocument(att.file, {
                    id: att.id,
                    name: att.name,
                    originalName: att.originalName || att.name,
                    mimeType: att.type || att.file.type,
                    extension: att.extension
                  });

                  if (extResult.isImage || extResult.status === 'unsupported_offline') {
                    throw new Error('Image text recognition (OCR) requires an internet connection. Connect to the internet to process image text, or attach a text document (PDF, DOCX, PPTX, TXT, MD, CSV, JSON, XML).');
                  }
                  if (extResult.status === 'scanned_or_image_only') {
                    throw new Error(extResult.warning || 'No readable text could be extracted from this PDF. This document appears to be scanned without a text layer.');
                  }
                  if (extResult.status === 'empty') {
                    throw new Error(`The attached file '${att.name}' is empty (0 bytes).`);
                  }
                  if (extResult.status === 'encrypted') {
                    throw new Error(extResult.error || `The attached document '${att.name}' is password-protected or encrypted.`);
                  }
                  if (!extResult.success || !extResult.text || !extResult.text.trim()) {
                    throw new Error(extResult.error || extResult.warning || `Cannot extract text locally from '${att.name}'.`);
                  }

                  await saveAttachmentBlob(att.id || extResult.fileId, att.file, {
                    name: att.name,
                    originalName: att.originalName || att.name,
                    mimeType: att.type || att.file.type,
                    size: att.size || att.file.size,
                    formattedSize: att.formattedSize,
                    extension: att.extension,
                    isImage: Boolean(att.isImage),
                    conversationId: activeChatIdRef.current || null
                  });

                  fallbackLocalAttachments.push({
                    id: att.id || extResult.fileId,
                    name: att.name || extResult.originalName,
                    originalName: att.originalName || att.name,
                    size: att.size || att.file.size,
                    formattedSize: att.formattedSize,
                    type: att.type || att.file.type,
                    extension: att.extension,
                    isImage: Boolean(att.isImage),
                    status: extResult.status,
                    file: att.file,
                    previewUrl: att.previewUrl,
                    extraction: extResult
                  });
                }

                processedAttachments = fallbackLocalAttachments;
              } catch (fallbackErr) {
                setPersistenceError(`Failed to process attachment: ${fallbackErr?.message || 'Local extraction failed.'}`);
                setIsLoading(false);
                isSubmittingRef.current = false;
                return false;
              }
            } else {
              let userMsg = uploadErr?.message || 'Network request failed';
              if (isTimeout || uploadErr?.name === 'TimeoutError') {
                userMsg = 'Attachment upload timed out. The file may be too large or the server is busy. Please try uploading a smaller image or retry.';
              } else if (uploadErr?.name === 'AbortError' || uploadController.signal.aborted) {
                const reason = uploadController.signal.reason;
                const reasonMsg = reason?.message || (typeof reason === 'string' ? reason : null);
                if (reasonMsg && !reasonMsg.includes('without reason')) {
                  userMsg = reasonMsg;
                } else {
                  userMsg = 'Attachment upload was cancelled or timed out. Please try again.';
                }
              } else if (userMsg.toLowerCase().includes('failed to fetch') || userMsg.toLowerCase().includes('networkerror')) {
                userMsg = !isBrowserOnline() || selectedProvider === 'ollama'
                  ? 'Could not reach the local Orvix backend server (/api/upload). Please verify the local server is running.'
                  : 'Network error while connecting to upload server. Please verify the server is running and check your connection.';
              }

              setPersistenceError(`Failed to upload attachments: ${userMsg}`);
              setIsLoading(false);
              isSubmittingRef.current = false;
              return false;
            }
          }
        }
      } else {
        processedAttachments = attachments.map((att) => ({
          id: att.id,
          name: att.name || att.originalName,
          originalName: att.originalName || att.name,
          size: att.size,
          formattedSize: att.formattedSize,
          type: att.type || att.mimeType,
          extension: att.extension,
          isImage: Boolean(att.isImage),
          status: att.status || 'uploaded',
          extraction: att.extraction
        }));
      }
    }

    let currentChatId = activeChatIdRef.current;

    try {
      // Create a conversation only when the user sends their first message.
      if (!currentChatId) {
        const titleSnippet = generateChatTitle(
          trimmed ||
            (processedAttachments.length > 0
              ? `Files: ${processedAttachments.map((a) => a.name || a.originalName).join(', ')}`
              : 'New Conversation')
        );

        if (isCloudEnabled && currentUser?.uid) {
          try {
            currentChatId = await createChatDocument(
              currentUser.uid,
              titleSnippet,
              activeMode
            );
            skipNextChatLoadRef.current = currentChatId;
            // Ensure offline-created conversations appear immediately in the sidebar
            const cachedList = getCachedUserChats(currentUser.uid);
            if (cachedList.length > 0) {
              setUserChats(cachedList);
            }
          } catch (error) {
            console.warn('Could not create Firestore chat doc, falling back to local conversation:', error);
            currentChatId = `local-${Date.now()}`;
            skipNextChatLoadRef.current = currentChatId;
            const fallbackChat = {
              id: currentChatId,
              title: titleSnippet,
              mode: activeMode || 'general',
              timestamp: 'Just now',
              rawUpdatedAt: Date.now(),
              isPinned: false,
              pinnedAt: null,
              pendingSync: true
            };
            setUserChats((previous) => [fallbackChat, ...previous]);
          }
        } else {
          currentChatId = `guest-${Date.now()}`;

          // Prevent the history effect from replacing the new chat's
          // messages with an empty guest list before they are persisted.
          skipNextChatLoadRef.current = currentChatId;

          const newGuestChat = {
            id: currentChatId,
            title: titleSnippet,
            mode: activeMode || 'general',
            timestamp: 'Just now',
            rawUpdatedAt: Date.now(),
            isPinned: false,
            pinnedAt: null,
            messages: []
          };

          setUserChats((previous) => {
            const next = [newGuestChat, ...previous];
            saveGuestChats(next);
            return next;
          });
        }

        // Update the ref immediately; setState alone does not do this
        // synchronously, and the first AI chunks may arrive before rerender.
        activeChatIdRef.current = currentChatId;
        setActiveChatId(currentChatId);

        sessionStorage.setItem(
          'orvix_active_chat',
          currentChatId
        );
        sessionStorage.setItem(
          'chatora_active_chat',
          currentChatId
        );
      }

      const now = Date.now();

      const userMessage = {
        id: `user-${now}`,
        sender: 'user',
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        content: trimmed,
        attachments: processedAttachments
      };

      // Detect if user sent a continuation request (e.g., 'Continue', 'Send the rest', 'Next', 'Part 2')
      const isContinuation = isContinuationRequest(trimmed);
      const multiPartContext = isContinuation
        ? resolveMultiPartContext(messages, trimmed)
        : { isContinuation: false, partNumber: 1, originalPrompt: trimmed, previousContentSummary: '', referencedAttachments: [] };

      // Check if current message has attachments, or if we should carry forward attachments from the conversation
      // or from the multi-part sequence so follow-up questions and continuations maintain context
      let activeAttachments = processedAttachments;
      if ((!activeAttachments || activeAttachments.length === 0) && isContinuation && Array.isArray(multiPartContext.referencedAttachments) && multiPartContext.referencedAttachments.length > 0) {
        activeAttachments = multiPartContext.referencedAttachments;
      } else if ((!activeAttachments || activeAttachments.length === 0) && messages.length > 0) {
        const found = [];
        const seenIds = new Set();
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          const atts = Array.isArray(m.attachments) && m.attachments.length > 0
            ? m.attachments
            : Array.isArray(m.referencedAttachments) && m.referencedAttachments.length > 0
            ? m.referencedAttachments
            : [];
          for (const a of atts) {
            const key = a.id || a.name || a.originalName;
            if (key && !seenIds.has(key)) {
              seenIds.add(key);
              found.push(a);
            }
          }
        }
        if (found.length > 0) {
          // Keep newest attachments first (do not reverse to oldest)
          activeAttachments = found;
        }
      }

      const assistantMessageId =
        `${selectedProvider}-${now}-assistant`;

      const requestStartTime = performance.now();
      const initialAssistantMessage = normalizeAssistantMessage(
        {
          id: assistantMessageId,
          sender: 'assistant',
          parentMessageId: userMessage.id,
          provider: selectedProvider,
          modelUsed: null,
          mode: activeMode || 'general',
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: '',
          isStreaming: true,
          requestStartTime,
          referencedAttachments: undefined
        },
        userMessage
      );

      const validHistory = messages.filter(
        (message) => !message.isError
      );

      setMessages((previous) => [
        ...previous,
        userMessage,
        initialAssistantMessage
      ]);

      if (promptOverride === null) {
        setInputValue('');
      }

      if (currentChatId) {
        void persistMessageSafe(currentChatId, userMessage);
      }

      const promptText =
        trimmed ||
        (processedAttachments.length > 0
          ? `[User attached ${processedAttachments.length} file${processedAttachments.length > 1 ? 's' : ''}: ${processedAttachments.map((a) => `${a.name || a.originalName} (${a.formattedSize})`).join(', ')}]`
          : '');

      await executePrompt(
        promptText,
        validHistory,
        currentChatId,
        assistantMessageId,
        null,
        activeAttachments,
        multiPartContext,
        requestStartTime
      );
      return true;
    } catch (error) {
      console.error('Submission error:', error);
      setIsLoading(false);
      isSubmittingRef.current = false;
      return false;
    }
  };

  // Retry a failed AI response with the same provider.
  const handleRetry = (failedMessage) => {
    stopSpeech();

    if (
      isLoading ||
      isSubmittingRef.current ||
      !failedMessage?.failedPrompt
    ) {
      return;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);

    const currentChatId = activeChatIdRef.current;
    const providerToUse = failedMessage.failedProvider || selectedProvider;

    const updatedMessages = messages.filter(
      (message) => message.id !== failedMessage.id
    );

    const failedIdx = messages.findIndex((m) => m.id === failedMessage.id);
    const precedingUser = failedIdx > 0 ? messages[failedIdx - 1] : null;
    let retryAttachments =
      failedMessage.referencedAttachments ||
      precedingUser?.attachments ||
      [];
    if ((!retryAttachments || retryAttachments.length === 0) && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          retryAttachments = m.attachments;
          break;
        }
        if (Array.isArray(m.referencedAttachments) && m.referencedAttachments.length > 0) {
          retryAttachments = m.referencedAttachments;
          break;
        }
      }
    }

    const requestStartTime = performance.now();

    const assistantMessageId =
      `${providerToUse}-${Date.now()}-retry`;

    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: 'assistant',
      provider: providerToUse,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }),
      content: '',
      isStreaming: true,
      requestStartTime,
      referencedAttachments: undefined
    };

    setMessages([
      ...updatedMessages,
      initialAssistantMessage
    ]);

    const validHistory = updatedMessages.filter(
      (message) => !message.isError && !message.isInterrupted
    );

    const isRetryContinuation = isContinuationRequest(failedMessage.failedPrompt);
    const retryMultiPart = isRetryContinuation
      ? resolveMultiPartContext(validHistory, failedMessage.failedPrompt)
      : { isContinuation: false, partNumber: 1, originalPrompt: failedMessage.failedPrompt, previousContentSummary: '' };

    void executePrompt(
      failedMessage.failedPrompt,
      validHistory,
      currentChatId,
      assistantMessageId,
      providerToUse,
      retryAttachments,
      retryMultiPart,
      requestStartTime
    );
  };

  // User-controlled provider switch & retry without duplicating conversation messages
  const handleSwitchProviderAndRetry = (failedMessage, newProviderId) => {
    stopSpeech();

    if (
      isLoading ||
      isSubmittingRef.current ||
      !failedMessage?.failedPrompt
    ) {
      return;
    }

    handleSelectProvider(newProviderId);

    const requestStartTime = performance.now();

    isSubmittingRef.current = true;
    setIsLoading(true);

    const currentChatId = activeChatIdRef.current;

    const updatedMessages = messages.filter(
      (message) => message.id !== failedMessage.id
    );

    const failedSwitchIdx = messages.findIndex((m) => m.id === failedMessage.id);
    const precedingSwitchUser = failedSwitchIdx > 0 ? messages[failedSwitchIdx - 1] : null;
    let switchAttachments =
      failedMessage.referencedAttachments ||
      precedingSwitchUser?.attachments ||
      [];
    if ((!switchAttachments || switchAttachments.length === 0) && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          switchAttachments = m.attachments;
          break;
        }
        if (Array.isArray(m.referencedAttachments) && m.referencedAttachments.length > 0) {
          switchAttachments = m.referencedAttachments;
          break;
        }
      }
    }

    const assistantMessageId =
      `${newProviderId}-${Date.now()}-fallback`;

    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: 'assistant',
      provider: newProviderId,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }),
      content: '',
      isStreaming: true,
      requestStartTime,
      referencedAttachments: undefined
    };

    setMessages([
      ...updatedMessages,
      initialAssistantMessage
    ]);

    const validHistory = updatedMessages.filter(
      (message) => !message.isError && !message.isInterrupted
    );

    const isSwitchContinuation = isContinuationRequest(failedMessage.failedPrompt);
    const switchMultiPart = isSwitchContinuation
      ? resolveMultiPartContext(validHistory, failedMessage.failedPrompt)
      : { isContinuation: false, partNumber: 1, originalPrompt: failedMessage.failedPrompt, previousContentSummary: '' };

    void executePrompt(
      failedMessage.failedPrompt,
      validHistory,
      currentChatId,
      assistantMessageId,
      newProviderId,
      switchAttachments,
      switchMultiPart,
      requestStartTime
    );
  };

  // Restore a failed prompt to the input field.
  const handleRestorePrompt = (promptText) => {
    setInputValue(promptText);

    setMessages((previous) =>
      previous.filter(
        (message) => message.failedPrompt !== promptText
      )
    );
  };

  // Regenerate an assistant response in-place using the model of the response currently being viewed
  const handleRegenerate = async (assistantMessage) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current || !assistantMessage?.id) return;

    const currentChatId = activeChatIdRef.current;
    const msgIndex = messages.findIndex((m) => m.id === assistantMessage.id);
    if (msgIndex === -1) return;

    // Find the user prompt preceding this assistant message
    const precedingUserMessage = assistantMessage.parentMessageId
      ? messages.find((m) => m.id === assistantMessage.parentMessageId)
      : [...messages.slice(0, msgIndex)].reverse().find((m) => m.sender === 'user');

    if (!precedingUserMessage || (!precedingUserMessage.content && (!precedingUserMessage.attachments || precedingUserMessage.attachments.length === 0))) {
      console.warn('Cannot regenerate: preceding user prompt not found.');
      return;
    }

    const userPromptText =
      precedingUserMessage.content ||
      (Array.isArray(precedingUserMessage.attachments) && precedingUserMessage.attachments.length > 0
        ? `[User attached ${precedingUserMessage.attachments.length} file: ${precedingUserMessage.attachments.map((a) => a.name || a.originalName).join(', ')}]`
        : '');
    const userMsgIndex = messages.findIndex((m) => m.id === precedingUserMessage.id);
    const validHistory = messages.slice(0, userMsgIndex).filter((m) => !m.isError);

    // Identify the provider/model of the response currently being viewed
    const normalizedTarget = normalizeAssistantMessage(assistantMessage, precedingUserMessage);
    const activeAlt = getActiveAlternative(normalizedTarget);
    const providerToUse = activeAlt?.provider || assistantMessage.provider || selectedProvider;
    const modelToUse = activeAlt?.modelUsed || assistantMessage.modelUsed || null;

    const requestStartTime = performance.now();

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    const targetAssistantId = assistantMessage.id;

    // Allow cache/Firestore overwrite for this message ID
    persistedMessageIdsRef.current.delete(targetAssistantId);

    let precedingAttachments =
      assistantMessage.referencedAttachments ||
      precedingUserMessage?.attachments ||
      [];
    if ((!precedingAttachments || precedingAttachments.length === 0) && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          precedingAttachments = m.attachments;
          break;
        }
        if (Array.isArray(m.referencedAttachments) && m.referencedAttachments.length > 0) {
          precedingAttachments = m.referencedAttachments;
          break;
        }
      }
    }

    // Update active alternative in-place to streaming state using its own provider without replacing other alternatives
    setMessages((previous) =>
      previous.map((m) => {
        if (m.id !== targetAssistantId) return m;
        const normalized = normalizeAssistantMessage(m, precedingUserMessage);
        const updated = updateActiveAlternativeInMessage(normalized, {
          content: '',
          modelUsed: modelToUse,
          provider: providerToUse,
          responseTimeMs: null,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          isStreaming: true,
          isError: false,
          isStopped: false,
          referencedAttachments: undefined
        });
        return {
          ...updated,
          requestStartTime
        };
      })
    );

    await executePrompt(
      userPromptText,
      validHistory,
      currentChatId,
      targetAssistantId,
      providerToUse,
      precedingAttachments,
      {},
      requestStartTime,
      modelToUse
    );
  };

  // Generate an alternative response for an existing assistant message using another provider/model
  const handleGenerateAlternative = async (assistantMessage, targetProvider) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current || !assistantMessage?.id || !targetProvider) return;

    const currentChatId = activeChatIdRef.current;
    const msgIndex = messages.findIndex((m) => m.id === assistantMessage.id);
    if (msgIndex === -1) return;

    const precedingUserMessage = assistantMessage.parentMessageId
      ? messages.find((m) => m.id === assistantMessage.parentMessageId)
      : [...messages.slice(0, msgIndex)].reverse().find((m) => m.sender === 'user');

    if (!precedingUserMessage || (!precedingUserMessage.content && (!precedingUserMessage.attachments || precedingUserMessage.attachments.length === 0))) {
      console.warn('Cannot generate alternative: preceding user prompt not found.');
      return;
    }

    const userPromptText =
      precedingUserMessage.content ||
      (Array.isArray(precedingUserMessage.attachments) && precedingUserMessage.attachments.length > 0
        ? `[User attached ${precedingUserMessage.attachments.length} file: ${precedingUserMessage.attachments.map((a) => a.name || a.originalName).join(', ')}]`
        : '');
    const userMsgIndex = messages.findIndex((m) => m.id === precedingUserMessage.id);
    const validHistory = messages.slice(0, userMsgIndex).filter((m) => !m.isError);

    const chosenProvider = typeof targetProvider === 'object' && targetProvider?.provider
      ? targetProvider.provider
      : targetProvider;
    const chosenModel = typeof targetProvider === 'object' && targetProvider?.model
      ? targetProvider.model
      : (chosenProvider === 'ollama'
          ? 'qwen2.5:1.5b'
          : chosenProvider === 'webllm'
          ? webllmModelId
          : chosenProvider === 'groq'
          ? 'openai/gpt-oss-120b'
          : chosenProvider === 'openrouter'
          ? 'openrouter/free'
          : chosenProvider === 'cloudflare'
          ? '@cf/meta/llama-3.1-8b-instruct'
          : 'gemini-3.1-flash-lite');

    const targetAssistantId = assistantMessage.id;
    const requestStartTime = performance.now();

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    // Allow cache/Firestore overwrite for this message ID
    persistedMessageIdsRef.current.delete(targetAssistantId);

    let precedingAttachments =
      assistantMessage.referencedAttachments ||
      precedingUserMessage?.attachments ||
      [];
    if ((!precedingAttachments || precedingAttachments.length === 0) && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (Array.isArray(m.attachments) && m.attachments.length > 0) {
          precedingAttachments = m.attachments;
          break;
        }
        if (Array.isArray(m.referencedAttachments) && m.referencedAttachments.length > 0) {
          precedingAttachments = m.referencedAttachments;
          break;
        }
      }
    }

    const newAlternative = createAlternativeRecord({
      parentMessageId: precedingUserMessage.id,
      provider: chosenProvider,
      modelUsed: chosenModel,
      content: '',
      isStreaming: true,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }),
      referencedAttachments: undefined
    });

    setMessages((previous) =>
      previous.map((m) => {
        if (m.id !== targetAssistantId) return m;
        const normalized = normalizeAssistantMessage(m, precedingUserMessage);
        const updated = addAlternativeToAssistantMessage(normalized, newAlternative);
        return {
          ...updated,
          requestStartTime,
          isStreaming: true,
          isError: false,
          isStopped: false
        };
      })
    );

    await executePrompt(
      userPromptText,
      validHistory,
      currentChatId,
      targetAssistantId,
      chosenProvider,
      precedingAttachments,
      {},
      requestStartTime,
      chosenModel
    );
  };

  // Switch the active alternative response for an assistant message
  const handleSwitchAlternative = (assistantMessageId, targetAlternativeId) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current) return;

    setMessages((previous) => {
      const next = previous.map((m) => {
        if (m.id !== assistantMessageId) return m;
        return switchActiveAlternativeInMessage(m, targetAlternativeId);
      });

      const updatedMsg = next.find((m) => m.id === assistantMessageId);
      if (updatedMsg && activeChatIdRef.current) {
        void persistMessageSafe(activeChatIdRef.current, updatedMsg, true);
      }

      return next;
    });
  };

  // Stop active AI response generation
  const handleStopGenerating = () => {
    stopSpeech();
    isUserStoppedRef.current = true;

    if (
      selectedProvider === 'webllm' ||
      webllmState.status === 'generating' ||
      webllmState.status === 'downloading' ||
      webllmState.status === 'loading'
    ) {
      stopWebLLMGeneration();
    }

    if (activeAbortControllerRef.current) {
      try {
        activeAbortControllerRef.current.abort();
      } catch (_) {}
      activeAbortControllerRef.current = null;
    }

    if (activeAnimationRef.current) {
      activeAnimationRef.current();
      activeAnimationRef.current = null;
    }

    setIsLoading(false);
    isSubmittingRef.current = false;
  };

  // Start inline editing mode for a user message
  const handleStartEdit = (messageId) => {
    if (isLoading || isSubmittingRef.current) return;
    setEditingMessageId(messageId);
  };

  // Cancel inline editing mode
  const handleCancelEdit = () => {
    setEditingMessageId(null);
  };

  // Edit and resend an eligible user message with contextual branch truncation
  const handleEditResend = async (userMessageId, newPromptText) => {
    stopSpeech();

    const trimmed = (newPromptText || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    if (!trimmed || isLoading || isSubmittingRef.current) return;

    const requestStartTime = performance.now();

    const userMsgIndex = messages.findIndex((m) => m.id === userMessageId);
    if (userMsgIndex === -1) return;

    // Reset inline edit mode
    setEditingMessageId(null);

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    let currentChatId = activeChatIdRef.current;

    // Ensure we have an active chat ID
    if (!currentChatId) {
      const titleSnippet = generateChatTitle(trimmed);
      if (isCloudEnabled && currentUser?.uid) {
        try {
          currentChatId = await createChatDocument(currentUser.uid, titleSnippet, activeMode);
          skipNextChatLoadRef.current = currentChatId;
          const cachedList = getCachedUserChats(currentUser.uid);
          if (cachedList.length > 0) {
            setUserChats(cachedList);
          }
        } catch (error) {
          console.warn('Could not create Firestore chat doc for edit, using local fallback:', error);
          currentChatId = `local-${Date.now()}`;
          skipNextChatLoadRef.current = currentChatId;
          setUserChats((previous) => [
            {
              id: currentChatId,
              title: titleSnippet,
              mode: activeMode || 'general',
              timestamp: 'Just now',
              rawUpdatedAt: Date.now(),
              isPinned: false,
              pinnedAt: null,
              pendingSync: true
            },
            ...previous
          ]);
        }
      } else {
        currentChatId = `guest-${Date.now()}`;
        const newGuestChat = {
          id: currentChatId,
          title: titleSnippet,
          timestamp: 'Just now',
          rawUpdatedAt: Date.now(),
          isPinned: false,
          pinnedAt: null,
          messages: []
        };
        setUserChats((previous) => {
          const next = [newGuestChat, ...previous];
          saveGuestChats(next);
          return next;
        });
      }

      activeChatIdRef.current = currentChatId;
      setActiveChatId(currentChatId);
      sessionStorage.setItem('orvix_active_chat', currentChatId);
      sessionStorage.setItem('chatora_active_chat', currentChatId);
    }

    // 1. Context: identify all previous non-error messages strictly before this message
    const earlierMessages = messages.slice(0, userMsgIndex);
    const validHistory = earlierMessages.filter((m) => !m.isError);

    // 2. Truncation: identify all contradictory later messages to be removed from the thread
    const laterMessages = messages.slice(userMsgIndex + 1);
    const laterMessageIds = laterMessages.map((m) => m.id).filter(Boolean);

    // 3. Invalidate persistence cache for truncated message IDs
    laterMessageIds.forEach((id) => {
      persistedMessageIdsRef.current.delete(id);
    });

    // 4. Update the user message in-place with the edited prompt and current timestamp
    //    (ensure transient base64/dataUrl fields cannot linger in React state or localStorage)
    const updatedUserMessage = {
      ...messages[userMsgIndex],
      attachments: Array.isArray(messages[userMsgIndex]?.attachments)
        ? messages[userMsgIndex].attachments.map((att) => {
            if (!att || typeof att !== 'object') return att;
            const { base64: _b64, dataUrl: _dUrl, data: _rawData, ...cleanAtt } = att;
            if (typeof cleanAtt.previewUrl === 'string' && cleanAtt.previewUrl.startsWith('data:')) {
              delete cleanAtt.previewUrl;
            }
            return cleanAtt;
          })
        : messages[userMsgIndex]?.attachments,
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    };

    // Remove user message ID from persistence cache to allow fresh write
    persistedMessageIdsRef.current.delete(updatedUserMessage.id);

    // 5. Create fresh assistant response placeholder
    const now = Date.now();
    const assistantMessageId = `${selectedProvider}-${now}-assistant`;
    const initialAssistantMessage = normalizeAssistantMessage(
      {
        id: assistantMessageId,
        sender: 'assistant',
        parentMessageId: updatedUserMessage.id,
        provider: selectedProvider,
        modelUsed: null,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        content: '',
        isStreaming: true,
        requestStartTime,
        referencedAttachments: undefined
      },
      updatedUserMessage
    );

    // 6. Truncate conversation state to: earlier + updatedUserMessage + initialAssistantMessage
    const nextMessages = [
      ...earlierMessages,
      updatedUserMessage,
      initialAssistantMessage
    ];
    setMessages(nextMessages);

    // 7. Persist changes to Cloud Firestore or Guest Storage
    if (isCloudEnabled && currentUser?.uid) {
      if (laterMessageIds.length > 0) {
        deleteChatMessages(currentUser.uid, currentChatId, laterMessageIds).catch((err) => {
          console.warn('Could not delete truncated messages from Cloud Firestore:', err);
        });
      } else {
        saveCachedChatMessages(
          currentUser.uid,
          currentChatId,
          [...earlierMessages, updatedUserMessage]
        );
      }
      void persistMessageSafe(currentChatId, updatedUserMessage);
    } else {
      setUserChats((previous) => {
        const next = previous.map((chat) => {
          if (chat.id !== currentChatId) return chat;
          return {
            ...chat,
            rawUpdatedAt: Date.now(),
            messages: nextMessages
          };
        });
        saveGuestChats(next);
        return next;
      });
    }

    // 8. If editing the initial message of the conversation, update the conversation title
    if (userMsgIndex === 0) {
      const refreshedTitle = generateChatTitle(trimmed);
      void handleRenameChat(currentChatId, refreshedTitle);
    }

    // 9. Execute AI stream with correct earlier history and edited prompt
    await executePrompt(
      trimmed,
      validHistory,
      currentChatId,
      assistantMessageId,
      null,
      updatedUserMessage.attachments || [],
      {},
      requestStartTime
    );
  };

  // Export handlers for active conversation
  const hasExportableMessages = messages.some(
    (m) => !m.isError && typeof m.content === 'string' && m.content.trim().length > 0
  );

  const handleExportMarkdown = () => {
    if (messagesLoading) {
      setExportNotice({
        type: 'warning',
        message: 'Please wait until the conversation finishes loading before exporting.'
      });
      return;
    }

    const result = exportAsMarkdown({
      title: activeTitle || 'Conversation',
      messages,
      username
    });

    if (result.success) {
      setExportNotice({
        type: 'success',
        message: `Exported conversation as Markdown (${result.filename}).`
      });
    } else {
      setExportNotice({
        type: 'warning',
        message: result.error || 'This conversation has no messages to export.'
      });
    }
  };

  const handleExportText = () => {
    if (messagesLoading) {
      setExportNotice({
        type: 'warning',
        message: 'Please wait until the conversation finishes loading before exporting.'
      });
      return;
    }

    const result = exportAsPlainText({
      title: activeTitle || 'Conversation',
      messages,
      username
    });

    if (result.success) {
      setExportNotice({
        type: 'success',
        message: `Exported conversation as Plain Text (${result.filename}).`
      });
    } else {
      setExportNotice({
        type: 'warning',
        message: result.error || 'This conversation has no messages to export.'
      });
    }
  };

  return (
    <Layout
      onNewChat={handleNewChat}
      recentChats={userChats}
      activeChatId={activeChatId}
      onSelectChat={handleSelectChat}
      onRenameChat={handleRenameChat}
      onDeleteChat={handleDeleteChat}
      onTogglePin={handleTogglePin}
      activeTitle={activeTitle}
      chatsLoading={chatsLoading}
      isCloudSynced={isCloudEnabled}
      isOffline={isOffline}
      selectedProvider={selectedProvider}
      onSelectProvider={handleSelectProvider}
      activeMode={activeMode}
      onSelectMode={handleSelectMode}
      onExportMarkdown={handleExportMarkdown}
      onExportText={handleExportText}
      hasExportableMessages={hasExportableMessages}
    >
      {isOffline && !offlineBannerDismissed && (
        <div
          className="offline-status-banner"
          role="status"
          aria-live="polite"
        >
          <WifiOff
            size={15}
            className="offline-status-icon"
          />

          <span className="persistence-alert-text">
            {selectedProvider === 'ollama'
              ? isCloudEnabled
                ? 'Offline mode — Local AI (Ollama) is ready. Messages are saved locally and will sync to Cloud Firestore when internet reconnects.'
                : 'Offline mode — Local AI (Ollama) and local conversation history are active.'
              : selectedProvider === 'webllm'
              ? (webllmState.status === 'ready' || webllmState.isCached)
                ? (appShellState.isAppShellCached
                    ? `Offline mode — App shell & ${webllmState.modelId ? (WEBLLM_MODEL_CATALOG[webllmState.modelId]?.shortLabel || 'Browser AI') : 'Browser AI'} are cached on this device. Supported documents (PDF, DOCX, PPTX, TXT, MD, CSV, JSON, XML) can be extracted locally.`
                    : `Offline mode — ${webllmState.modelId ? (WEBLLM_MODEL_CATALOG[webllmState.modelId]?.shortLabel || 'Browser AI') : 'Browser AI'} is cached on this device. Supported documents can be extracted locally.`)
                : (appShellState.isAppShellCached
                    ? `Offline mode — App shell is cached, but ${webllmState.modelId ? (WEBLLM_MODEL_CATALOG[webllmState.modelId]?.shortLabel || 'Browser AI') : 'Browser AI'} model weights have not been downloaded yet. Connect to the internet once to download and cache the model for offline use.`
                    : 'You are offline — Connect to the internet once to download and cache Browser AI for offline use.')
              : appShellState.isAppShellCached
              ? 'Offline mode — App shell is available offline. Cloud AI providers require internet. Switch to Browser AI (WebLLM) to chat locally.'
              : 'You are offline — Cloud AI providers and Firebase require internet. Switch to Browser AI (WebLLM) to chat locally.'}
          </span>

          {selectedProvider !== 'ollama' && selectedProvider !== 'webllm' && (
            <div className="offline-switch-actions">
              <button
                type="button"
                className="offline-switch-btn"
                onClick={() => handleSelectProvider('webllm')}
              >
                Switch to Browser AI
              </button>
              <button
                type="button"
                className="offline-switch-btn"
                onClick={() => handleSelectProvider('ollama')}
              >
                Switch to Ollama
              </button>
            </div>
          )}

          <button
            type="button"
            className="persistence-alert-close"
            onClick={() => setOfflineBannerDismissed(true)}
            aria-label="Dismiss offline status banner"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {exportNotice && (
        <div
          className={`persistence-alert-banner export-status-banner ${exportNotice.type}`}
          role="status"
          aria-live="polite"
        >
          {exportNotice.type === 'success' ? (
            <Check
              size={15}
              className="persistence-alert-icon text-emerald-400"
            />
          ) : (
            <AlertCircle
              size={15}
              className="persistence-alert-icon text-amber-400"
            />
          )}

          <span className="persistence-alert-text">
            {exportNotice.message}
          </span>

          <button
            type="button"
            className="persistence-alert-close"
            onClick={() => setExportNotice(null)}
            aria-label="Dismiss export banner"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {persistenceError && (
        <div
          className="persistence-alert-banner"
          role="status"
        >
          <AlertCircle
            size={15}
            className="persistence-alert-icon"
          />

          <span className="persistence-alert-text">
            {persistenceError}
          </span>

          <button
            type="button"
            className="persistence-alert-close"
            onClick={() => setPersistenceError(null)}
            aria-label="Dismiss banner"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <ChatArea
        activeChatId={activeChatId}
        messages={messages}
        isLoading={isLoading}
        messagesLoading={messagesLoading}
        isNewChat={!activeChatId}
        username={username}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onSubmit={handleSubmit}
        activeTitle={activeTitle}
        onRetry={handleRetry}
        onSwitchProvider={handleSwitchProviderAndRetry}
        onRestorePrompt={handleRestorePrompt}
        onRegenerate={handleRegenerate}
        onGenerateAlternative={handleGenerateAlternative}
        onSwitchAlternative={handleSwitchAlternative}
        onStopGenerating={handleStopGenerating}
        onEditResend={handleEditResend}
        editingMessageId={editingMessageId}
        onStartEdit={handleStartEdit}
        onCancelEdit={handleCancelEdit}
        selectedProvider={selectedProvider}
        enterToSend={settings?.enterToSend ?? true}
        showTimestamps={settings?.showTimestamps ?? true}
        activeMode={activeMode}
        onSelectMode={handleSelectMode}
        modeChangeNotice={modeChangeNotice}
        onDismissModeNotice={() => setModeChangeNotice(null)}
        isOffline={isOffline}
        webllmState={webllmState}
        webllmGpuCheck={webllmGpuCheck}
        webllmModelId={webllmModelId}
        onSelectWebLLMModel={handleSelectWebLLMModel}
        onLoadWebLLMModel={handleLoadWebLLMModel}
        onCancelWebLLMLoad={handleCancelWebLLMLoad}
        onUnloadWebLLMModel={handleUnloadWebLLMModel}
      />
    </Layout>
  );
}
