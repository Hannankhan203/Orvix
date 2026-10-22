
import React, { useState, useRef, useEffect } from 'react';
import Layout from '../components/layout/Layout.jsx';
import ChatArea from '../components/chat/ChatArea.jsx';
import { SAMPLE_CHATS } from '../config/sampleData.js';
import { streamAIMessage, DEFAULT_PROVIDER } from '../services/aiRouter.js';
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
  updateChatMode
} from '../services/chatStorageService.js';
import { exportAsMarkdown, exportAsPlainText } from '../utils/exportConversation.js';
import { isFirebaseConfigured } from '../config/firebaseConfig.js';
import { getChatMode } from '../config/chatModes.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useSettings } from '../context/SettingsContext.jsx';
import { useSpeech } from '../context/SpeechContext.jsx';
import { saveAttachmentBlob } from '../services/attachmentStorageService.js';
import {
  isContinuationRequest,
  resolveMultiPartContext,
  responseHasContinuationNotice
} from '../services/multiPartResponseService.js';
import { AlertCircle, X, Check } from 'lucide-react';

export default function ChatPage() {
  const { currentUser, username } = useAuth();
  const { settings } = useSettings();
  const { stopSpeech } = useSpeech();
  const isCloudEnabled =
    isFirebaseConfigured() && Boolean(currentUser?.uid);

  const [userChats, setUserChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(isCloudEnabled);

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
      if (typeof window !== 'undefined') {
        localStorage.setItem(
          'orvix_guest_chats',
          JSON.stringify(chats)
        );
        localStorage.setItem(
          'chatora_guest_chats',
          JSON.stringify(chats)
        );
      }
    } catch (error) {
      console.warn('Could not save guest chats:', error);
    }
  };

  // 1. Subscribe to the conversation list.
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

    setChatsLoading(true);

    const unsubscribe = subscribeToUserChats(
      currentUser.uid,
      (chats) => {
        setUserChats(chats);
        setChatsLoading(false);
      },
      (error) => {
        console.warn('Firestore subscription error:', error);
        setPersistenceError(
          'Unable to sync conversation list from Cloud Firestore.'
        );
        setChatsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [isCloudEnabled, currentUser?.uid]);

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
      setMessages([...sample.messages]);
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
      setMessages([...guestChat.messages]);
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
            ? loadedMessages
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

          setPersistenceError(
            'Failed to load conversation history from Cloud Firestore.'
          );
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

  // Persist messages without duplicate writes.
  const persistMessageSafe = async (chatId, message) => {
    if (!chatId || !message?.id) return;

    if (persistedMessageIdsRef.current.has(message.id)) {
      return;
    }

    // Reserve the ID before starting the asynchronous write.
    persistedMessageIdsRef.current.add(message.id);

    if (isCloudEnabled && currentUser?.uid) {
      try {
        await saveChatMessage(
          currentUser.uid,
          chatId,
          message
        );
      } catch (error) {
        // Allow a future retry if this write failed.
        persistedMessageIdsRef.current.delete(message.id);

        console.warn('Firestore write warning:', error);
        setPersistenceError(
          'Notice: Could not save message to Cloud Firestore. Kept in memory.'
        );
      }

      return;
    }

    setUserChats((previous) => {
      const next = previous.map((chat) => {
        if (chat.id !== chatId) return chat;

        const hasExisting = (chat.messages || []).some(
          (item) => item.id === message.id
        );

        const updatedMessages = hasExisting
          ? (chat.messages || []).map((item) => (item.id === message.id ? message : item))
          : [...(chat.messages || []), message];

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
    multiPartParams = {}
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

    let targetText = '';
    let displayedText = '';
    let activeModel = null;
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
      isStopped = false
    ) => {
      if (isCancelled || isFinalized) return;

      isFinalized = true;

      const completedMessage = {
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
        referencedAttachments:
          currentAttachments && currentAttachments.length > 0
            ? currentAttachments
            : undefined
      };

      if (activeChatIdRef.current === targetChatId) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? completedMessage
              : message
          )
        );
      }

      if (targetChatId) {
        await persistMessageSafe(targetChatId, completedMessage);
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
          previous.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: displayedText,
                  modelUsed: activeModel || message.modelUsed,
                  provider: finalProvider || message.provider,
                  isStreaming: true,
                  referencedAttachments:
                    currentAttachments && currentAttachments.length > 0
                      ? currentAttachments
                      : message.referencedAttachments
                }
              : message
          )
        );

        timerId = setTimeout(pumpAnimation, 18);
        return;
      }

      if (isStreamDone) {
        void finalizeAssistantMessage(
          targetText,
          activeModel,
          finalProvider
        );
      }
    };

    const triggerPump = () => {
      if (isCancelled || isFinalized || timerId !== null) return;

      timerId = setTimeout(pumpAnimation, 10);
    };

    try {
      const result = await streamAIMessage({
        provider: providerToUse,
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
        attachments: currentAttachments,
        isContinuation: multiPartParams.isContinuation,
        partNumber: multiPartParams.partNumber,
        originalPrompt: multiPartParams.originalPrompt,
        previousContentSummary: multiPartParams.previousContentSummary,

        onStart: ({ modelUsed, provider: reportedProvider } = {}) => {
          if (modelUsed) activeModel = modelUsed;
          if (reportedProvider) finalProvider = reportedProvider;

          if (activeChatIdRef.current === targetChatId) {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      modelUsed: activeModel,
                      provider: finalProvider,
                      referencedAttachments:
                        currentAttachments && currentAttachments.length > 0
                          ? currentAttachments
                          : message.referencedAttachments
                    }
                  : message
              )
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

      const resolvedText =
        typeof result?.text === 'string'
          ? result.text
          : targetText;

      targetText = resolvedText;

      if (result?.modelUsed) activeModel = result.modelUsed;
      if (result?.provider) finalProvider = result.provider;

      isStreamDone = true;

      // If the user has switched chats, persist this answer in the
      // original conversation without touching the currently visible chat.
      if (activeChatIdRef.current !== targetChatId) {
        cancelCurrentAnimation();

        const completedMessage = {
          id: assistantMessageId,
          sender: 'assistant',
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: resolvedText,
          isStreaming: false,
          referencedAttachments:
            currentAttachments && currentAttachments.length > 0
              ? currentAttachments
              : undefined
        };

        if (targetChatId) {
          await persistMessageSafe(targetChatId, completedMessage);
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

        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  content: targetText,
                  modelUsed: activeModel || message.modelUsed,
                  provider: finalProvider || message.provider,
                  isStreaming: false,
                  referencedAttachments:
                    currentAttachments && currentAttachments.length > 0
                      ? currentAttachments
                      : message.referencedAttachments
                }
              : message
          )
        );

        await finalizeAssistantMessage(
          targetText,
          activeModel,
          finalProvider
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

        const stoppedMessage = {
          id: assistantMessageId,
          sender: 'assistant',
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: stoppedText,
          isStreaming: false,
          isStopped: true,
          referencedAttachments:
            currentAttachments && currentAttachments.length > 0
              ? currentAttachments
              : undefined
        };

        if (activeChatIdRef.current === targetChatId) {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? stoppedMessage
                : message
            )
          );
        }

        if (targetChatId) {
          await persistMessageSafe(targetChatId, stoppedMessage);
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

      let friendlyMsg = rawMsg;
      if (is503) {
        friendlyMsg =
          'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments, or switch to Groq or OpenRouter below.';
      } else if (is500) {
        friendlyMsg =
          rawMsg && !rawMsg.includes('Server request failed') && !rawMsg.includes('Internal Server Error')
            ? `The AI service encountered an internal error: ${rawMsg}. You can retry or switch to another provider below.`
            : `The AI service encountered an internal error (HTTP 500). Please try again in a moment, or switch to Groq or OpenRouter below.`;
      } else if (isAuthError) {
        friendlyMsg =
          `Authentication or permission error with ${providerToUse}. Please check your API key configuration or switch providers below.`;
      } else if (isRateLimit) {
        friendlyMsg =
          'AI rate limit or quota exceeded. Please wait a moment before trying again, or switch providers below.';
      } else if (!friendlyMsg) {
        friendlyMsg = `An unexpected error occurred while communicating with ${providerToUse}.`;
      }

      if (activeChatIdRef.current === targetChatId) {
        if (targetText.trim().length > 0) {
          const partialMessage = {
            id: assistantMessageId,
            sender: 'assistant',
            provider: finalProvider || providerToUse,
            modelUsed: activeModel,
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            content: `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`,
            isStreaming: false,
            isInterrupted: true,
            failedPrompt: promptText,
            failedProvider: finalProvider || providerToUse,
            canSwitchProvider: true,
            referencedAttachments:
              currentAttachments && currentAttachments.length > 0
                ? currentAttachments
                : undefined
          };

          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? partialMessage
                : message
            )
          );

          if (targetChatId) {
            await persistMessageSafe(targetChatId, partialMessage);
          }
        } else {
          const errorMessage = {
            id: `error-${Date.now()}`,
            sender: 'assistant',
            isError: true,
            failedPrompt: promptText,
            failedProvider: finalProvider || providerToUse,
            canSwitchProvider: true,
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            content: friendlyMsg,
            referencedAttachments:
              currentAttachments && currentAttachments.length > 0
                ? currentAttachments
                : undefined
          };

          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId
                ? errorMessage
                : message
            )
          );
        }
      } else if (targetChatId && targetText.trim().length > 0) {
        const partialMessage = {
          id: assistantMessageId,
          sender: 'assistant',
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`,
          isStreaming: false,
          isInterrupted: true,
          failedPrompt: promptText,
          failedProvider: finalProvider || providerToUse,
          canSwitchProvider: true,
          referencedAttachments:
            currentAttachments && currentAttachments.length > 0
              ? currentAttachments
              : undefined
        };

        await persistMessageSafe(targetChatId, partialMessage);
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

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    let processedAttachments = [];

    // Step 1: Upload raw file attachments securely via multipart/form-data
    if (hasAttachments) {
      const filesToUpload = attachments.filter((att) => att.file);
      if (filesToUpload.length > 0) {
        // Enforce maximum single file size client-side before network transmission
        const MAX_PER_FILE_BYTES = 25 * 1024 * 1024;
        const oversized = filesToUpload.find((f) => f.file && f.file.size > MAX_PER_FILE_BYTES);
        if (oversized) {
          setPersistenceError(`File '${oversized.name}' exceeds the maximum allowed size of 25MB.`);
          setIsLoading(false);
          isSubmittingRef.current = false;
          return false;
        }

        const uploadController = new AbortController();
        const UPLOAD_TIMEOUT_MS = 60000;
        let isTimeout = false;
        const uploadTimeoutId = setTimeout(() => {
          isTimeout = true;
          try {
            uploadController.abort(new DOMException('Upload timed out after 60 seconds.', 'TimeoutError'));
          } catch (_) {
            uploadController.abort();
          }
        }, UPLOAD_TIMEOUT_MS);

        try {
          const formData = new FormData();
          if (activeChatIdRef.current) {
            formData.append('conversationId', activeChatIdRef.current);
          }
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

            setPersistenceError(errorMsg);
            setIsLoading(false);
            isSubmittingRef.current = false;
            return false;
          }

          const uploadData = await uploadRes.json();
          processedAttachments = Array.isArray(uploadData?.attachments)
            ? uploadData.attachments.map((proc, idx) => {
                const orig =
                  filesToUpload[idx] ||
                  filesToUpload.find(
                    (f) => f.name === (proc.originalName || proc.name)
                  );
                return {
                  ...proc,
                  file: orig?.file,
                  previewUrl: orig?.previewUrl || proc.dataUrl,
                  dataUrl: proc.dataUrl,
                  base64: proc.base64 || orig?.base64,
                  isImage: Boolean(proc.isImage || orig?.isImage)
                };
              })
            : [];

          // Persist file blobs into IndexedDB for robust local preview/download across reloads
          await Promise.all(
            filesToUpload.map(async (attItem, i) => {
              const proc =
                processedAttachments[i] ||
                processedAttachments.find(
                  (p) => (p.originalName || p.name) === attItem.name
                );
              if (proc && proc.id && attItem.file) {
                try {
                  await saveAttachmentBlob(proc.id, attItem.file, {
                    name: proc.name || attItem.name,
                    originalName: proc.originalName || attItem.name,
                    mimeType: proc.type || attItem.file.type,
                    size: proc.size || attItem.file.size,
                    formattedSize: proc.formattedSize || attItem.formattedSize,
                    extension: proc.extension || attItem.extension,
                    isImage: Boolean(attItem.isImage),
                    conversationId: activeChatIdRef.current || null
                  });
                } catch (e) {
                  console.warn('Could not cache blob in IndexedDB:', e);
                }

                // Attach base64 data for images under 3MB so stateless serverless environments have direct multimodal access
                if (attItem.isImage && attItem.file.size <= 3 * 1024 * 1024 && !proc.base64) {
                  try {
                    const b64 = await new Promise((resolve) => {
                      const reader = new FileReader();
                      reader.onload = () => resolve(reader.result);
                      reader.onerror = () => resolve(null);
                      reader.readAsDataURL(attItem.file);
                    });
                    if (b64) {
                      proc.base64 = b64;
                      if (!proc.dataUrl) proc.dataUrl = b64;
                      if (!proc.previewUrl) proc.previewUrl = b64;
                    }
                  } catch (_) {}
                }
              }
            })
          );
        } catch (uploadErr) {
          console.error('File upload network error:', uploadErr);
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
            userMsg = 'Network error while connecting to upload server. Please verify your internet connection.';
          }

          setPersistenceError(
            `Failed to upload attachments: ${userMsg}`
          );
          setIsLoading(false);
          isSubmittingRef.current = false;
          return false;
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

            // Prevent the history effect from replacing the new chat's
            // messages with an empty database result.
            skipNextChatLoadRef.current = currentChatId;
          } catch (error) {
            console.warn('Could not create Firestore chat doc:', error);

            setPersistenceError(
              'Failed to initialize conversation in Cloud Firestore.'
            );

            setIsLoading(false);
            isSubmittingRef.current = false;
            return false;
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
          activeAttachments = found.reverse();
        }
      }

      const assistantMessageId =
        `${selectedProvider}-${now}-assistant`;

      const initialAssistantMessage = {
        id: assistantMessageId,
        sender: 'assistant',
        provider: selectedProvider,
        modelUsed: null,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        content: '',
        isStreaming: true,
        referencedAttachments:
          activeAttachments && activeAttachments.length > 0
            ? activeAttachments
            : undefined
      };

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
        multiPartContext
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
      referencedAttachments:
        retryAttachments && retryAttachments.length > 0
          ? retryAttachments
          : undefined
    };

    setMessages([
      ...updatedMessages,
      initialAssistantMessage
    ]);

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
      retryMultiPart
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
      referencedAttachments:
        switchAttachments && switchAttachments.length > 0
          ? switchAttachments
          : undefined
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
      switchMultiPart
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

  // Regenerate an assistant response in-place using current model & preserved conversation context
  const handleRegenerate = async (assistantMessage) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current || !assistantMessage?.id) return;

    const currentChatId = activeChatIdRef.current;
    const msgIndex = messages.findIndex((m) => m.id === assistantMessage.id);
    if (msgIndex === -1) return;

    // Find the user prompt preceding this assistant message
    const precedingUserMessage = [...messages.slice(0, msgIndex)]
      .reverse()
      .find((m) => m.sender === 'user');

    if (!precedingUserMessage || !precedingUserMessage.content) {
      console.warn('Cannot regenerate: preceding user prompt not found.');
      return;
    }

    const userPromptText = precedingUserMessage.content;
    const userMsgIndex = messages.findIndex((m) => m.id === precedingUserMessage.id);
    const validHistory = messages.slice(0, userMsgIndex).filter((m) => !m.isError);

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

    // Update in-place to streaming state without creating duplicate messages
    setMessages((previous) =>
      previous.map((m) =>
        m.id === targetAssistantId
          ? {
              ...m,
              content: '',
              modelUsed: null,
              provider: selectedProvider,
              timestamp: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit'
              }),
              isStreaming: true,
              isError: false,
              isStopped: false,
              referencedAttachments:
                precedingAttachments.length > 0
                  ? precedingAttachments
                  : m.referencedAttachments
            }
          : m
      )
    );

    await executePrompt(
      userPromptText,
      validHistory,
      currentChatId,
      targetAssistantId,
      null,
      precedingAttachments
    );
  };

  // Stop active AI response generation
  const handleStopGenerating = () => {
    stopSpeech();
    isUserStoppedRef.current = true;

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
          currentChatId = await createChatDocument(currentUser.uid, titleSnippet);
          skipNextChatLoadRef.current = currentChatId;
        } catch (error) {
          console.warn('Could not create Firestore chat doc for edit:', error);
          setPersistenceError('Failed to initialize conversation in Cloud Firestore.');
          setIsLoading(false);
          isSubmittingRef.current = false;
          return;
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
    const updatedUserMessage = {
      ...messages[userMsgIndex],
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
    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: 'assistant',
      provider: selectedProvider,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      }),
      content: '',
      isStreaming: true,
      referencedAttachments:
        updatedUserMessage.attachments && updatedUserMessage.attachments.length > 0
          ? updatedUserMessage.attachments
          : undefined
    };

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
      updatedUserMessage.attachments || []
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
      selectedProvider={selectedProvider}
      onSelectProvider={handleSelectProvider}
      activeMode={activeMode}
      onSelectMode={handleSelectMode}
      onExportMarkdown={handleExportMarkdown}
      onExportText={handleExportText}
      hasExportableMessages={hasExportableMessages}
    >
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
      />
    </Layout>
  );
}
