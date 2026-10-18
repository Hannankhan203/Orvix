import React, { useState, useRef, useEffect } from 'react';
import Layout from '../components/layout/Layout.jsx';
import ChatArea from '../components/chat/ChatArea.jsx';
import { SAMPLE_CHATS } from '../config/sampleData.js';
import { sendAIMessage, streamAIMessage, DEFAULT_PROVIDER } from '../services/aiRouter.js';
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

/**
 * ChatPage Component
 * Orchestrates live Gemini interactions with Cloud Firestore persistence,
 * conversation switching, title generation, renaming, atomic deletion,
 * and rock-solid error/race-condition mitigation.
 */
export default function ChatPage() {
  const { currentUser, username } = useAuth();
  const isCloudEnabled = isFirebaseConfigured() && Boolean(currentUser?.uid);

  // Conversation list & active chat state
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

  // Active conversation messages & composer state
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [persistenceError, setPersistenceError] = useState(null);

  // AI Provider State (Gemini, Groq, OpenRouter) with local storage persistence
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

  const handleSelectProvider = (provider) => {
    setSelectedProvider(provider);
    if (typeof window !== 'undefined') {
      localStorage.setItem('orvix_selected_provider', provider);
      localStorage.setItem('chatora_selected_provider', provider);
    }
  };

  // Synchronous submission lock to prevent duplicate async submissions
  const isSubmittingRef = useRef(false);
  // Set of message IDs already persisted to Firestore to prevent duplicate writes
  const persistedMessageIdsRef = useRef(new Set());
  // Active chat ID ref for cross-turn race-condition checks
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  // Request sequence counter for rapid chat switching
  const fetchRequestIdRef = useRef(0);
  // Active animation cancellation ref to clean up timers across unmounts or chat transitions
  const activeAnimationRef = useRef(null);

  useEffect(() => {
    return () => {
      if (activeAnimationRef.current) {
        activeAnimationRef.current();
      }
    };
  }, []);

  // Helper for guest mode pin and conversation persistence
  const getGuestPinnedIds = () => {
    try {
      if (typeof window !== 'undefined') {
        const stored =
          localStorage.getItem('orvix_guest_pins') ||
          localStorage.getItem('chatora_guest_pins');
        return stored ? JSON.parse(stored) : [];
      }
    } catch (_) {}
    return [];
  };

  const saveGuestPinnedIds = (pinnedIds) => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('orvix_guest_pins', JSON.stringify(pinnedIds));
        localStorage.setItem('chatora_guest_pins', JSON.stringify(pinnedIds));
      }
    } catch (_) {}
  };

  const getGuestChats = () => {
    try {
      if (typeof window !== 'undefined') {
        const stored =
          localStorage.getItem('orvix_guest_chats') ||
          localStorage.getItem('chatora_guest_chats');
        if (stored) return JSON.parse(stored);
      }
    } catch (_) {}
    return null;
  };

  const saveGuestChats = (chats) => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('orvix_guest_chats', JSON.stringify(chats));
        localStorage.setItem('chatora_guest_chats', JSON.stringify(chats));
      }
    } catch (_) {}
  };

  // 1. Subscribe to real-time conversation list in Firestore (or load guest demo chats)
  useEffect(() => {
    if (!isCloudEnabled || !currentUser?.uid) {
      const guestPinned = getGuestPinnedIds();
      const savedGuestChats = getGuestChats();
      const baseChats = savedGuestChats || SAMPLE_CHATS;
      const initialGuestChats = baseChats.map((c) => ({
        ...c,
        isPinned: guestPinned.includes(c.id) || Boolean(c.isPinned)
      }));
      setUserChats(initialGuestChats);
      setChatsLoading(false);
      return;
    }

    setChatsLoading(true);
    const unsubscribe = subscribeToUserChats(
      currentUser.uid,
      (chats) => {
        setUserChats(chats);
        setChatsLoading(false);
      },
      (err) => {
        console.warn('Firestore subscription error:', err);
        setPersistenceError('Unable to sync conversation list from Cloud Firestore.');
        setChatsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [isCloudEnabled, currentUser?.uid]);

  // 2. Restore active conversation messages after refresh or when activeChatId changes
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      sessionStorage.removeItem('orvix_active_chat');
      sessionStorage.removeItem('chatora_active_chat');
      return;
    }

    sessionStorage.setItem('orvix_active_chat', activeChatId);
    sessionStorage.setItem('chatora_active_chat', activeChatId);

    // If it's one of the demo sample chats
    const sample = SAMPLE_CHATS.find((c) => c.id === activeChatId);
    if (sample) {
      setMessages([...sample.messages]);
      return;
    }

    // If it's a guest conversation stored in state or local storage
    const guestChat = userChats.find((c) => c.id === activeChatId);
    if (!isCloudEnabled && guestChat && guestChat.messages) {
      setMessages([...guestChat.messages]);
      return;
    }

    // Load from Firestore if cloud is enabled
    if (isCloudEnabled && currentUser?.uid) {
      fetchRequestIdRef.current += 1;
      const currentRequestId = fetchRequestIdRef.current;
      setMessagesLoading(true);

      loadConversationMessages(currentUser.uid, activeChatId)
        .then((loadedMessages) => {
          // Race-condition guard: Only apply if this request is still the active one
          if (fetchRequestIdRef.current === currentRequestId && activeChatIdRef.current === activeChatId) {
            setMessages(loadedMessages);
            loadedMessages.forEach((m) => persistedMessageIdsRef.current.add(m.id));
          }
        })
        .catch((err) => {
          console.error('Failed to load conversation messages:', err);
          if (fetchRequestIdRef.current === currentRequestId) {
            setPersistenceError('Failed to load conversation history from Cloud Firestore.');
          }
        })
        .finally(() => {
          if (fetchRequestIdRef.current === currentRequestId) {
            setMessagesLoading(false);
          }
        });
    }
  }, [activeChatId, isCloudEnabled, currentUser?.uid]);

  // Active chat title for header breadcrumb
  const currentChat = userChats.find((c) => c.id === activeChatId);
  const activeTitle = currentChat
    ? currentChat.title
    : messages.length > 0
    ? 'Current Conversation'
    : null;

  // New Chat: Resets active view cleanly without creating an empty document
  const handleNewChat = () => {
    if (activeAnimationRef.current) {
      activeAnimationRef.current();
    }
    setActiveChatId(null);
    setMessages([]);
    setInputValue('');
    setIsLoading(false);
    isSubmittingRef.current = false;
    sessionStorage.removeItem('orvix_active_chat');
    sessionStorage.removeItem('chatora_active_chat');
  };

  // Switch to an existing conversation
  const handleSelectChat = (chatId) => {
    if (chatId === activeChatId) return;
    setActiveChatId(chatId);
    setInputValue('');
    // Do not abort pending in-flight Gemini generation for previous chat,
    // but the response will be saved to its own collection without leaking into this chat!
  };

  // Rename a conversation
  const handleRenameChat = async (chatId, newTitle) => {
    const sanitized = (newTitle || '').trim();
    if (!sanitized) return;

    try {
      if (isCloudEnabled && currentUser?.uid) {
        await renameConversation(currentUser.uid, chatId, sanitized);
      } else {
        setUserChats((prev) => {
          const next = prev.map((c) => (c.id === chatId ? { ...c, title: sanitized } : c));
          saveGuestChats(next);
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to rename conversation:', err);
      setPersistenceError('Failed to rename conversation.');
    }
  };

  // Delete a conversation and its messages
  const handleDeleteChat = async (chatId) => {
    try {
      if (isCloudEnabled && currentUser?.uid) {
        await deleteConversation(currentUser.uid, chatId);
      } else {
        setUserChats((prev) => {
          const next = prev.filter((c) => c.id !== chatId);
          saveGuestChats(next);
          return next;
        });
      }

      // If the deleted chat was currently open, return to new chat empty state
      if (activeChatIdRef.current === chatId) {
        handleNewChat();
      }

      // If guest mode, clean up guest pinned IDs
      if (!isCloudEnabled || !currentUser?.uid) {
        const guestPinned = getGuestPinnedIds().filter((id) => id !== chatId);
        saveGuestPinnedIds(guestPinned);
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
      setPersistenceError('Failed to delete conversation from Cloud Firestore.');
    }
  };

  // Pin or unpin a conversation with strict 5-chat limit per user
  const handleTogglePin = async (chatId) => {
    const targetChat = userChats.find((c) => c.id === chatId);
    if (!targetChat) return;

    const willPin = !targetChat.isPinned;

    if (willPin) {
      const currentPinnedCount = userChats.filter((c) => c.isPinned).length;
      if (currentPinnedCount >= 5) {
        setPersistenceError('You can pin up to 5 chats. Unpin a chat before pinning another.');
        return;
      }
    }

    // Clear any previous error banner
    setPersistenceError(null);

    if (isCloudEnabled && currentUser?.uid) {
      try {
        await toggleChatPinned(currentUser.uid, chatId, willPin);
        // Real-time Firestore snapshot listener updates userChats automatically
      } catch (err) {
        console.error('Failed to toggle pin in Firestore:', err);
        setPersistenceError(err.message || 'Failed to update pin status in Cloud Firestore.');
      }
    } else {
      // Guest mode local persistence
      const now = Date.now();
      setUserChats((prev) => {
        const next = prev.map((c) =>
          c.id === chatId ? { ...c, isPinned: willPin, pinnedAt: willPin ? now : null } : c
        );
        saveGuestChats(next);
        const guestPinnedIds = next.filter((c) => c.isPinned).map((c) => c.id);
        saveGuestPinnedIds(guestPinnedIds);
        return next;
      });
    }
  };

  /**
   * Helper to persist a message to Firestore or guest storage with duplicate prevention
   */
  const persistMessageSafe = async (chatId, messageObj) => {
    if (!chatId || !messageObj) return;
    if (persistedMessageIdsRef.current.has(messageObj.id)) return;

    if (isCloudEnabled && currentUser?.uid) {
      try {
        persistedMessageIdsRef.current.add(messageObj.id);
        await saveChatMessage(currentUser.uid, chatId, messageObj);
      } catch (err) {
        console.warn('Firestore write warning:', err);
        setPersistenceError('Notice: Could not save message to Cloud Firestore. Kept in memory.');
      }
    } else {
      persistedMessageIdsRef.current.add(messageObj.id);
      setUserChats((prev) => {
        const next = prev.map((c) =>
          c.id === chatId
            ? {
                ...c,
                rawUpdatedAt: Date.now(),
                messages: [...(c.messages || []), messageObj]
              }
            : c
        );
        saveGuestChats(next);
        return next;
      });
    }
  };

  /**
   * Dispatches a prompt with progressive streaming animation and persists results upon completion.
   * Protects against cross-chat state pollution during rapid chat switching.
   */
  const executePrompt = async (promptText, historyContext, targetChatId, assistantMessageId) => {
    setIsLoading(true);

    let targetText = '';
    let displayedText = '';
    let activeModel = null;
    let finalProvider = selectedProvider;
    let isStreamDone = false;
    let timerId = null;
    let isCancelled = false;

    // Check accessibility settings for reduced motion
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    // Clean up any previously running animation
    if (activeAnimationRef.current) {
      activeAnimationRef.current();
    }

    const cancelCurrentAnimation = () => {
      isCancelled = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
    activeAnimationRef.current = cancelCurrentAnimation;

    // Finalizes the assistant message once the animation has caught up to the complete response
    const finalizeAssistantMessage = async (contentToSave, modelToUse, providerToUse) => {
      if (isCancelled) return;

      const completedMessage = {
        id: assistantMessageId,
        sender: 'assistant',
        provider: providerToUse || selectedProvider,
        modelUsed: modelToUse || activeModel,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        content: contentToSave,
        isStreaming: false
      };

      // Only update active UI if user is STILL viewing targetChatId
      if (activeChatIdRef.current === targetChatId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMessageId ? completedMessage : m))
        );
      }

      // Safely persist completed message to Firestore or guest storage
      if (targetChatId) {
        await persistMessageSafe(targetChatId, completedMessage);
      }

      setIsLoading(false);
      isSubmittingRef.current = false;
    };

    // Progressive animation pump loop
    const pumpAnimation = () => {
      if (isCancelled) return;

      // If user navigated away from target chat, stop UI pump
      if (activeChatIdRef.current !== targetChatId) {
        return;
      }

      const backlog = targetText.length - displayedText.length;

      if (backlog > 0) {
        if (prefersReducedMotion) {
          displayedText = targetText;
        } else {
          // Adaptive pacing:
          // Smooth 1-2 chars at a time when backlog is small (~50 chars/sec).
          // Automatically scales up for larger chunks so responses finish promptly.
          let stepSize = 1;
          if (backlog > 500) {
            stepSize = Math.min(backlog, Math.ceil(backlog / 16));
          } else if (backlog > 200) {
            stepSize = Math.min(backlog, Math.ceil(backlog / 12));
          } else if (backlog > 80) {
            stepSize = Math.min(backlog, Math.ceil(backlog / 8));
          } else if (backlog > 30) {
            stepSize = Math.min(backlog, Math.ceil(backlog / 5));
          } else if (backlog > 8) {
            stepSize = Math.min(backlog, 2);
          } else {
            stepSize = 1;
          }

          displayedText = targetText.slice(0, displayedText.length + stepSize);
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  content: displayedText,
                  modelUsed: activeModel || m.modelUsed,
                  provider: finalProvider || m.provider,
                  isStreaming: true
                }
              : m
          )
        );

        // Schedule next character tick (18ms provides smooth ~55fps typing cadence)
        timerId = setTimeout(pumpAnimation, 18);
      } else {
        // Backlog is 0 (displayedText has caught up to targetText)
        if (isStreamDone) {
          // Provider stream has finished, and animation has revealed all characters!
          finalizeAssistantMessage(targetText, activeModel, finalProvider);
        } else {
          // Waiting for more chunks from the provider; pump pauses until onChunk triggers it
          timerId = null;
        }
      }
    };

    // Ensure the animation loop is running if there is text in the buffer
    const triggerPump = () => {
      if (isCancelled) return;
      if (!timerId) {
        timerId = setTimeout(pumpAnimation, 10);
      }
    };

    try {
      // Call selected AI provider API with streaming chunks and personalized username
      const result = await streamAIMessage({
        provider: selectedProvider,
        prompt: promptText,
        history: historyContext,
        username: username || currentUser?.displayName || null,
        onStart: ({ modelUsed, provider }) => {
          if (modelUsed) activeModel = modelUsed;
          if (provider) finalProvider = provider;
          if (activeChatIdRef.current === targetChatId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, modelUsed: activeModel, provider: finalProvider }
                  : m
              )
            );
          }
        },
        onChunk: (_chunkText, currentAccumulated) => {
          targetText = currentAccumulated;
          triggerPump();
        }
      });

      // Stream reception finished
      const resolvedText = result.text || targetText;
      targetText = resolvedText;
      if (result.modelUsed) activeModel = result.modelUsed;
      if (result.provider) finalProvider = result.provider;
      isStreamDone = true;

      // If user switched away, finish up and persist directly to target conversation
      if (activeChatIdRef.current !== targetChatId) {
        cancelCurrentAnimation();
        const completedMessage = {
          id: assistantMessageId,
          sender: 'assistant',
          provider: finalProvider,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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

      // If there is still backlog to animate, let the pump finish typing the remaining text;
      // otherwise, finalize immediately.
      if (displayedText.length < targetText.length && !prefersReducedMotion) {
        triggerPump();
      } else {
        cancelCurrentAnimation();
        await finalizeAssistantMessage(targetText, activeModel, finalProvider);
      }
    } catch (err) {
      console.error('Streaming prompt execution error:', err);
      isStreamDone = true;
      cancelCurrentAnimation();

      if (activeChatIdRef.current === targetChatId) {
        if (targetText.trim().length > 0) {
          // Display whatever was received plus interrupted notice
          const partialMessage = {
            id: assistantMessageId,
            sender: 'assistant',
            provider: selectedProvider,
            modelUsed: activeModel,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            content: `${targetText}\n\n*[Response interrupted: ${err.message || 'Connection lost'}]*`,
            isStreaming: false
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessageId ? partialMessage : m))
          );
          if (targetChatId) {
            await persistMessageSafe(targetChatId, partialMessage);
          }
        } else {
          // Replace with clean error bubble
          const errorMessage = {
            id: `error-${Date.now()}`,
            sender: 'assistant',
            isError: true,
            failedPrompt: promptText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            content: err.message || `An unexpected error occurred while communicating with ${selectedProvider}.`
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMessageId ? errorMessage : m))
          );
        }
      } else if (targetChatId && targetText.trim().length > 0) {
        // Save partial response to background chat
        const partialMessage = {
          id: assistantMessageId,
          sender: 'assistant',
          provider: selectedProvider,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          content: `${targetText}\n\n*[Response interrupted]*`,
          isStreaming: false
        };
        await persistMessageSafe(targetChatId, partialMessage);
      }

      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Message submission handler with immediate assistant message & streaming dispatch
  const handleSubmit = async () => {
    // Strip standard whitespace and invisible zero-width spaces
    const trimmed = inputValue.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!trimmed || isLoading || isSubmittingRef.current) return;

    // Immediate lock before any async operations begin
    isSubmittingRef.current = true;
    setIsLoading(true);

    let currentChatId = activeChatId;

    try {
      // If starting a fresh chat, initialize new chat in Firestore first (or in-memory for guest mode)
      if (!currentChatId) {
        const titleSnippet = generateChatTitle(trimmed);
        if (isCloudEnabled && currentUser?.uid) {
          try {
            currentChatId = await createChatDocument(currentUser.uid, titleSnippet);
            setActiveChatId(currentChatId);
            sessionStorage.setItem('orvix_active_chat', currentChatId);
            sessionStorage.setItem('chatora_active_chat', currentChatId);
          } catch (err) {
            console.warn('Could not create Firestore chat doc:', err);
            setPersistenceError('Failed to initialize conversation in Cloud Firestore.');
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
          setUserChats((prev) => {
            const next = [newGuestChat, ...prev];
            saveGuestChats(next);
            return next;
          });
          setActiveChatId(currentChatId);
          sessionStorage.setItem('orvix_active_chat', currentChatId);
          sessionStorage.setItem('chatora_active_chat', currentChatId);
        }
      }

      const userMessage = {
        id: `user-${Date.now()}`,
        sender: 'user',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        content: trimmed
      };

      // Create immediate assistant message placeholder
      const assistantMessageId = `${selectedProvider}-${Date.now()}`;
      const initialAssistantMessage = {
        id: assistantMessageId,
        sender: 'assistant',
        provider: selectedProvider,
        modelUsed: null,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        content: '',
        isStreaming: true
      };

      // Filter out temporary error bubbles from multi-turn context
      const validHistory = messages.filter((m) => !m.isError);

      // Immediately render both user message and streaming assistant placeholder
      setMessages((prev) => [...prev, userMessage, initialAssistantMessage]);
      setInputValue('');

      // Persist user message to Firestore
      if (currentChatId) {
        persistMessageSafe(currentChatId, userMessage);
      }

      // Execute AI streaming dispatch
      executePrompt(trimmed, validHistory, currentChatId, assistantMessageId);
    } catch (unexpectedErr) {
      console.error('Submission error:', unexpectedErr);
      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Retry handler for failed messages
  const handleRetry = (failedMessage) => {
    if (isLoading || isSubmittingRef.current || !failedMessage?.failedPrompt) return;

    const currentChatId = activeChatIdRef.current;
    const updatedMessages = messages.filter((m) => m.id !== failedMessage.id);

    const assistantMessageId = `${selectedProvider}-${Date.now()}`;
    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: 'assistant',
      provider: selectedProvider,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      content: '',
      isStreaming: true
    };

    setMessages([...updatedMessages, initialAssistantMessage]);
    const validHistory = updatedMessages.filter((m) => !m.isError);
    executePrompt(failedMessage.failedPrompt, validHistory, currentChatId, assistantMessageId);
  };

  // Restore prompt text to the composer for editing
  const handleRestorePrompt = (promptText) => {
    setInputValue(promptText);
    setMessages((prev) => prev.filter((m) => m.failedPrompt !== promptText));
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
      {/* Persistence Error / Offline Alert Banner */}
      {persistenceError && (
        <div className="persistence-alert-banner" role="status">
          <AlertCircle size={15} className="persistence-alert-icon" />
          <span className="persistence-alert-text">{persistenceError}</span>
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
        isLoading={isLoading || messagesLoading}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onSubmit={handleSubmit}
        activeTitle={activeTitle}
        onRetry={handleRetry}
        onRestorePrompt={handleRestorePrompt}
        selectedProvider={selectedProvider}
      />
    </Layout>
  );
}
