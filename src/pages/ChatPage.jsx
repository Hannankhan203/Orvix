
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
  toggleChatPinned,
  subscribeToUserChats,
  loadConversationMessages,
  generateChatTitle
} from '../services/chatStorageService.js';
import { isFirebaseConfigured } from '../config/firebaseConfig.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AlertCircle, X } from 'lucide-react';

export default function ChatPage() {
  const { currentUser, username } = useAuth();
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

  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [persistenceError, setPersistenceError] = useState(null);

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

  // Stop any running animation and network request when the page unmounts.
  useEffect(() => {
    return () => {
      if (activeAbortControllerRef.current) {
        try {
          activeAbortControllerRef.current.abort();
        } catch (_) {}
      }
      if (activeAnimationRef.current) {
        activeAnimationRef.current();
      }
    };
  }, []);

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
      sessionStorage.removeItem('orvix_active_chat');
      sessionStorage.removeItem('chatora_active_chat');
      return undefined;
    }

    sessionStorage.setItem('orvix_active_chat', activeChatId);
    sessionStorage.setItem('chatora_active_chat', activeChatId);

    // Demo conversations.
    const sample = SAMPLE_CHATS.find(
      (chat) => chat.id === activeChatId
    );

    if (sample) {
      setMessages([...sample.messages]);
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
    setIsLoading(false);
    setMessagesLoading(false);
    isSubmittingRef.current = false;

    sessionStorage.removeItem('orvix_active_chat');
    sessionStorage.removeItem('chatora_active_chat');
  };

  // Switch conversations without allowing old history to overwrite new messages.
  const handleSelectChat = (chatId) => {
    if (chatId === activeChatIdRef.current) return;

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
    assistantMessageId
  ) => {
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
    let finalProvider = selectedProvider;
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
      providerToUse,
      isStopped = false
    ) => {
      if (isCancelled || isFinalized) return;

      isFinalized = true;

      const completedMessage = {
        id: assistantMessageId,
        sender: 'assistant',
        provider: providerToUse || finalProvider || selectedProvider,
        modelUsed: modelToUse || activeModel,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        content: contentToSave,
        isStreaming: false,
        isStopped: Boolean(isStopped)
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
                  isStreaming: true
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
        provider: selectedProvider,
        prompt: promptText,
        history: historyContext,
        username:
          username || currentUser?.displayName || null,
        signal: abortController.signal,

        onStart: ({ modelUsed, provider } = {}) => {
          if (modelUsed) activeModel = modelUsed;
          if (provider) finalProvider = provider;

          if (activeChatIdRef.current === targetChatId) {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      modelUsed: activeModel,
                      provider: finalProvider
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
          provider: finalProvider || selectedProvider,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: resolvedText,
          isStreaming: false
        };

        if (targetChatId) {
          await persistMessageSafe(targetChatId, completedMessage);
        }

        setIsLoading(false);
        isSubmittingRef.current = false;
        return;
      }

      // FIX: Do not cancel the animation before finalizing. Cancellation
      // sets isCancelled, which would cause finalization to return early.
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
                  isStreaming: false
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
          provider: finalProvider || selectedProvider,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: stoppedText,
          isStreaming: false,
          isStopped: true
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

      if (activeChatIdRef.current === targetChatId) {
        if (targetText.trim().length > 0) {
          const partialMessage = {
            id: assistantMessageId,
            sender: 'assistant',
            provider: finalProvider || selectedProvider,
            modelUsed: activeModel,
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            content: `${targetText}\n\n*[Response interrupted: ${
              error?.message || 'Connection lost'
            }]*`,
            isStreaming: false
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
            timestamp: new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit'
            }),
            content:
              error?.message ||
              `An unexpected error occurred while communicating with ${selectedProvider}.`
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
          provider: finalProvider || selectedProvider,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
          }),
          content: `${targetText}\n\n*[Response interrupted]*`,
          isStreaming: false
        };

        await persistMessageSafe(targetChatId, partialMessage);
      }

      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Submit a new message.
  const handleSubmit = async () => {
    const trimmed = inputValue
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    if (!trimmed || isLoading || isSubmittingRef.current) return;

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    let currentChatId = activeChatIdRef.current;

    try {
      // Create a conversation only when the user sends their first message.
      if (!currentChatId) {
        const titleSnippet = generateChatTitle(trimmed);

        if (isCloudEnabled && currentUser?.uid) {
          try {
            currentChatId = await createChatDocument(
              currentUser.uid,
              titleSnippet
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
        content: trimmed
      };

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
        isStreaming: true
      };

      const validHistory = messages.filter(
        (message) => !message.isError
      );

      setMessages((previous) => [
        ...previous,
        userMessage,
        initialAssistantMessage
      ]);

      setInputValue('');

      if (currentChatId) {
        void persistMessageSafe(currentChatId, userMessage);
      }

      await executePrompt(
        trimmed,
        validHistory,
        currentChatId,
        assistantMessageId
      );
    } catch (error) {
      console.error('Submission error:', error);
      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Retry a failed AI response.
  const handleRetry = (failedMessage) => {
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

    const updatedMessages = messages.filter(
      (message) => message.id !== failedMessage.id
    );

    const assistantMessageId =
      `${selectedProvider}-${Date.now()}-retry`;

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
      isStreaming: true
    };

    setMessages([
      ...updatedMessages,
      initialAssistantMessage
    ]);

    const validHistory = updatedMessages.filter(
      (message) => !message.isError
    );

    void executePrompt(
      failedMessage.failedPrompt,
      validHistory,
      currentChatId,
      assistantMessageId
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
              isStopped: false
            }
          : m
      )
    );

    await executePrompt(
      userPromptText,
      validHistory,
      currentChatId,
      targetAssistantId
    );
  };

  // Stop active AI response generation
  const handleStopGenerating = () => {
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
    >
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
        onRestorePrompt={handleRestorePrompt}
        onRegenerate={handleRegenerate}
        onStopGenerating={handleStopGenerating}
        selectedProvider={selectedProvider}
      />
    </Layout>
  );
}
