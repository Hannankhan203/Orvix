import React, { useState, useRef, useEffect } from "react";
import Layout from "../components/layout/Layout.jsx";
import ChatArea from "../components/chat/ChatArea.jsx";
import { SAMPLE_CHATS } from "../config/sampleData.js";
import { streamAIMessage, DEFAULT_PROVIDER } from "../services/aiRouter.js";
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
} from "../services/chatStorageService.js";
import {
  exportAsMarkdown,
  exportAsPlainText,
} from "../utils/exportConversation.js";
import { isFirebaseConfigured } from "../config/firebaseConfig.js";
import { getChatMode } from "../config/chatModes.js";
import { useAuth } from "../context/AuthContext.jsx";
import { useSettings } from "../context/SettingsContext.jsx";
import { useSpeech } from "../context/SpeechContext.jsx";
import { AlertCircle, X, Check } from "lucide-react";
import {
  extractDocumentContent,
  validateAttachmentFile,
  formatFileSize,
} from "../utils/documentExtractor.js";
import {
  decodeAndProcessImage,
  validateImageFile,
  revokeImageUrl,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
} from "../utils/imageValidator.js";

export default function ChatPage() {
  const { currentUser, username } = useAuth();
  const { settings } = useSettings();
  const { stopSpeech } = useSpeech();

  const isCloudEnabled = isFirebaseConfigured() && Boolean(currentUser?.uid);

  const [userChats, setUserChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(isCloudEnabled);

  const [activeChatId, setActiveChatId] = useState(() => {
    if (typeof window !== "undefined") {
      return (
        sessionStorage.getItem("orvix_active_chat") ||
        sessionStorage.getItem("chatora_active_chat") ||
        null
      );
    }

    return null;
  });

  const [activeMode, setActiveMode] = useState(
    () => settings?.defaultMode || "general",
  );

  const [modeChangeNotice, setModeChangeNotice] = useState(null);

  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [persistenceError, setPersistenceError] = useState(null);
  const [exportNotice, setExportNotice] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);

  // Document and Image attachment states
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState(null);
  const [isExtractingAttachments, setIsExtractingAttachments] = useState(false);
  const [isProcessingImages, setIsProcessingImages] = useState(false);
  const createdObjectUrlsRef = useRef(new Set());

  // Read and extract uploaded documents.
  const handleAttachFiles = async (files = []) => {
    if (!files.length) return;

    setAttachmentError(null);
    setIsExtractingAttachments(true);

    try {
      const newAttachments = [];

      for (const file of files) {
        const validationError = validateAttachmentFile(file);

        if (validationError) {
          setAttachmentError(`${file.name}: ${validationError}`);
          continue;
        }

        try {
          const document = await extractDocumentContent(file);

          newAttachments.push({
            ...document,
            status: "ready",
            displaySize: formatFileSize(file.size),
          });
        } catch (error) {
          setAttachmentError(
            `${file.name}: ${error?.message || "Failed to read this file."}`,
          );
        }
      }

      if (newAttachments.length > 0) {
        setAttachments((previous) => [...previous, ...newAttachments]);
      }
    } finally {
      setIsExtractingAttachments(false);
    }
  };

  // Read, decode, and validate uploaded images.
  const handleAttachImages = async (files = []) => {
    if (!files.length) return;

    setAttachmentError(null);
    setIsProcessingImages(true);

    try {
      const currentImages = attachments.filter(
        (a) => a.category === "image" || Boolean(a.previewUrl),
      );
      const currentImageCount = currentImages.length;
      let runningTotalBytes = currentImages.reduce(
        (sum, a) => sum + (Number(a.size) || 0),
        0,
      );

      const newImageAttachments = [];

      for (const file of files) {
        const existingCount = currentImageCount + newImageAttachments.length;
        const validationError = validateImageFile(file, existingCount);

        if (validationError) {
          setAttachmentError(validationError);
          continue;
        }

        if (runningTotalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
          setAttachmentError(
            `File "${file.name}" (${formatFileSize(file.size)}) would exceed the total image batch limit of ${formatFileSize(MAX_TOTAL_IMAGE_BYTES)}.`,
          );
          continue;
        }

        try {
          const imageObj = await decodeAndProcessImage(file);
          if (imageObj?.previewUrl) {
            createdObjectUrlsRef.current.add(imageObj.previewUrl);
          }
          newImageAttachments.push(imageObj);
          runningTotalBytes += file.size;
        } catch (error) {
          setAttachmentError(
            `${file.name}: ${error?.message || "Failed to process image."}`,
          );
        }
      }

      if (newImageAttachments.length > 0) {
        setAttachments((previous) => [...previous, ...newImageAttachments]);
      }
    } finally {
      setIsProcessingImages(false);
    }
  };

  const handleRemoveAttachment = (attachmentId) => {
    setAttachments((previous) => {
      const target = previous.find((a) => a.id === attachmentId);
      if (target?.previewUrl) {
        revokeImageUrl(target.previewUrl);
        createdObjectUrlsRef.current.delete(target.previewUrl);
      }
      return previous.filter((attachment) => attachment.id !== attachmentId);
    });

    setAttachmentError(null);
  };

  const handleClearAttachmentError = () => {
    setAttachmentError(null);
  };

  const [selectedProvider, setSelectedProvider] = useState(() => {
    if (typeof window !== "undefined") {
      return (
        localStorage.getItem("orvix_selected_provider") ||
        localStorage.getItem("chatora_selected_provider") ||
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

    if (typeof window !== "undefined") {
      localStorage.setItem("orvix_selected_provider", provider);
      localStorage.setItem("chatora_selected_provider", provider);
    }
  };

  // Clean up speech, animation, network requests, and object URLs on unmount.
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

      // Revoke any created preview object URLs on unmount
      createdObjectUrlsRef.current.forEach((url) => {
        revokeImageUrl(url);
      });
      createdObjectUrlsRef.current.clear();
    };
  }, [stopSpeech]);

  // Auto-dismiss export notifications.
  useEffect(() => {
    if (!exportNotice) return undefined;

    const timer = setTimeout(() => {
      setExportNotice(null);
    }, 4500);

    return () => clearTimeout(timer);
  }, [exportNotice]);

  // Auto-dismiss mode-change notifications.
  useEffect(() => {
    if (!modeChangeNotice) return undefined;

    const timer = setTimeout(() => {
      setModeChangeNotice(null);
    }, 4500);

    return () => clearTimeout(timer);
  }, [modeChangeNotice]);

  // Synchronize the configured default mode on a new conversation.
  useEffect(() => {
    if (!activeChatId && settings?.defaultMode) {
      setActiveMode(settings.defaultMode);
    }
  }, [settings?.defaultMode, activeChatId]);

  // Guest storage helpers.
  const getGuestPinnedIds = () => {
    try {
      if (typeof window !== "undefined") {
        const stored =
          localStorage.getItem("orvix_guest_pins") ||
          localStorage.getItem("chatora_guest_pins");

        return stored ? JSON.parse(stored) : [];
      }
    } catch (error) {
      console.warn("Could not read guest pins:", error);
    }

    return [];
  };

  const saveGuestPinnedIds = (pinnedIds) => {
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("orvix_guest_pins", JSON.stringify(pinnedIds));

        localStorage.setItem("chatora_guest_pins", JSON.stringify(pinnedIds));
      }
    } catch (error) {
      console.warn("Could not save guest pins:", error);
    }
  };

  const getGuestChats = () => {
    try {
      if (typeof window !== "undefined") {
        const stored =
          localStorage.getItem("orvix_guest_chats") ||
          localStorage.getItem("chatora_guest_chats");

        if (stored) {
          const parsed = JSON.parse(stored);
          return Array.isArray(parsed) ? parsed : null;
        }
      }
    } catch (error) {
      console.warn("Could not read guest chats:", error);
    }

    return null;
  };

  const saveGuestChats = (chats) => {
    try {
      if (typeof window !== "undefined") {
        // Strip large dataUrls or transient blob URLs before saving to localStorage
        const sanitized = (chats || []).map((chat) => ({
          ...chat,
          messages: (chat.messages || []).map((msg) => {
            if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) {
              return msg;
            }
            return {
              ...msg,
              attachments: msg.attachments.map((att) => ({
                id: att.id,
                category:
                  att.category ||
                  (att.width || att.type?.startsWith("image/")
                    ? "image"
                    : "document"),
                name: att.name,
                size: att.size,
                type: att.type,
                ...(att.pageCount ? { pageCount: att.pageCount } : {}),
                ...(att.slideCount ? { slideCount: att.slideCount } : {}),
                ...(att.rowCount ? { rowCount: att.rowCount } : {}),
                ...(att.width ? { width: att.width } : {}),
                ...(att.height ? { height: att.height } : {}),
              })),
            };
          }),
        }));

        localStorage.setItem("orvix_guest_chats", JSON.stringify(sanitized));
        localStorage.setItem("chatora_guest_chats", JSON.stringify(sanitized));
      }
    } catch (error) {
      console.warn("Could not save guest chats:", error);
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
        isPinned: guestPinned.includes(chat.id) || Boolean(chat.isPinned),
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
        console.warn("Firestore subscription error:", error);

        setPersistenceError(
          "Unable to sync conversation list from Cloud Firestore.",
        );

        setChatsLoading(false);
      },
    );

    return () => unsubscribe();
  }, [isCloudEnabled, currentUser?.uid]);

  // 2. Restore conversation messages safely.
  useEffect(() => {
    stopSpeech();

    const currentRequestId = ++fetchRequestIdRef.current;

    // A new chat may already contain messages in component state.
    if (activeChatId && skipNextChatLoadRef.current === activeChatId) {
      skipNextChatLoadRef.current = null;

      sessionStorage.setItem("orvix_active_chat", activeChatId);
      sessionStorage.setItem("chatora_active_chat", activeChatId);

      setMessagesLoading(false);
      return undefined;
    }

    if (!activeChatId) {
      setMessages([]);
      setMessagesLoading(false);
      setActiveMode(settings?.defaultMode || "general");

      sessionStorage.removeItem("orvix_active_chat");
      sessionStorage.removeItem("chatora_active_chat");

      return undefined;
    }

    sessionStorage.setItem("orvix_active_chat", activeChatId);
    sessionStorage.setItem("chatora_active_chat", activeChatId);

    const matchingChat =
      userChats.find((chat) => chat.id === activeChatId) ||
      SAMPLE_CHATS.find((chat) => chat.id === activeChatId);

    if (matchingChat) {
      setActiveMode(matchingChat.mode || "general");
    }

    // Demo conversations.
    const sample = SAMPLE_CHATS.find((chat) => chat.id === activeChatId);

    if (sample) {
      setMessages([...sample.messages]);
      setActiveMode(sample.mode || "general");
      setMessagesLoading(false);

      return undefined;
    }

    // Guest conversations.
    const guestChat = userChats.find((chat) => chat.id === activeChatId);

    if (!isCloudEnabled && guestChat && Array.isArray(guestChat.messages)) {
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
          if (cancelled || fetchRequestIdRef.current !== currentRequestId) {
            return;
          }

          console.error("Failed to load conversation messages:", error);

          setPersistenceError(
            "Failed to load conversation history from Cloud Firestore.",
          );
        })
        .finally(() => {
          if (!cancelled && fetchRequestIdRef.current === currentRequestId) {
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

  const currentChat = userChats.find((chat) => chat.id === activeChatId);

  const activeTitle = currentChat
    ? currentChat.title
    : messages.length > 0
      ? "Current Conversation"
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

    fetchRequestIdRef.current += 1;
    activeChatIdRef.current = null;

    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setEditingMessageId(null);
    setIsLoading(false);
    setMessagesLoading(false);

    // Revoke any pending preview object URLs
    createdObjectUrlsRef.current.forEach((url) => {
      revokeImageUrl(url);
    });
    createdObjectUrlsRef.current.clear();
    setAttachments([]);
    setAttachmentError(null);
    setIsExtractingAttachments(false);
    setIsProcessingImages(false);

    isSubmittingRef.current = false;

    setModeChangeNotice(null);
    setActiveMode(settings?.defaultMode || "general");

    sessionStorage.removeItem("orvix_active_chat");
    sessionStorage.removeItem("chatora_active_chat");
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

    // Revoke pending composer preview URLs
    createdObjectUrlsRef.current.forEach((url) => {
      revokeImageUrl(url);
    });
    createdObjectUrlsRef.current.clear();
    setAttachments([]);
    setAttachmentError(null);
    setIsProcessingImages(false);

    fetchRequestIdRef.current += 1;
    activeChatIdRef.current = chatId;

    setActiveChatId(chatId);
    setInputValue("");
    setMessages([]);
    setMessagesLoading(Boolean(isCloudEnabled));
  };

  // Rename a conversation.
  const handleRenameChat = async (chatId, newTitle) => {
    const sanitized = (newTitle || "").trim();

    if (!sanitized) return;

    try {
      if (isCloudEnabled && currentUser?.uid) {
        await renameConversation(currentUser.uid, chatId, sanitized);
      } else {
        setUserChats((previous) => {
          const next = previous.map((chat) =>
            chat.id === chatId ? { ...chat, title: sanitized } : chat,
          );

          saveGuestChats(next);

          return next;
        });
      }
    } catch (error) {
      console.error("Failed to rename conversation:", error);
      setPersistenceError("Failed to rename conversation.");
    }
  };

  // Delete a conversation.
  const handleDeleteChat = async (chatId) => {
    try {
      if (isCloudEnabled && currentUser?.uid) {
        await deleteConversation(currentUser.uid, chatId);
      } else {
        setUserChats((previous) => {
          const next = previous.filter((chat) => chat.id !== chatId);

          saveGuestChats(next);

          return next;
        });
      }

      if (activeChatIdRef.current === chatId) {
        handleNewChat();
      }

      if (!isCloudEnabled || !currentUser?.uid) {
        const remainingPins = getGuestPinnedIds().filter((id) => id !== chatId);

        saveGuestPinnedIds(remainingPins);
      }
    } catch (error) {
      console.error("Failed to delete conversation:", error);

      setPersistenceError(
        "Failed to delete conversation from Cloud Firestore.",
      );
    }
  };

  // Pin/unpin conversations, with a maximum of five pinned chats.
  const handleTogglePin = async (chatId) => {
    const targetChat = userChats.find((chat) => chat.id === chatId);

    if (!targetChat) return;

    const willPin = !targetChat.isPinned;

    if (willPin && userChats.filter((chat) => chat.isPinned).length >= 5) {
      setPersistenceError(
        "You can pin up to 5 chats. Unpin a chat before pinning another.",
      );

      return;
    }

    setPersistenceError(null);

    if (isCloudEnabled && currentUser?.uid) {
      try {
        await toggleChatPinned(currentUser.uid, chatId, willPin);
      } catch (error) {
        console.error("Failed to toggle pin in Firestore:", error);

        setPersistenceError(
          error.message || "Failed to update pin status in Cloud Firestore.",
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
              pinnedAt: willPin ? Date.now() : null,
            }
          : chat,
      );

      saveGuestChats(next);

      saveGuestPinnedIds(
        next.filter((chat) => chat.isPinned).map((chat) => chat.id),
      );

      return next;
    });
  };

  // Handle mode selection.
  const handleSelectMode = async (newMode) => {
    const modeObj = getChatMode(newMode);

    setActiveMode(newMode);

    if (activeChatIdRef.current) {
      const currentChatId = activeChatIdRef.current;

      setModeChangeNotice(
        `Switched to ${modeObj.name} mode. Subsequent responses will follow ${modeObj.shortName} guidelines, preserving existing message history.`,
      );

      if (isCloudEnabled && currentUser?.uid) {
        updateChatMode(currentUser.uid, currentChatId, newMode).catch(
          (error) => {
            console.warn(
              "Could not update conversation mode in Cloud Firestore:",
              error,
            );
          },
        );
      } else {
        setUserChats((previous) => {
          const next = previous.map((chat) =>
            chat.id === currentChatId
              ? {
                  ...chat,
                  mode: newMode,
                  rawUpdatedAt: Date.now(),
                }
              : chat,
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

    persistedMessageIdsRef.current.add(message.id);

    if (isCloudEnabled && currentUser?.uid) {
      try {
        await saveChatMessage(currentUser.uid, chatId, message);
      } catch (error) {
        persistedMessageIdsRef.current.delete(message.id);

        console.warn("Firestore write warning:", error);

        setPersistenceError(
          "Notice: Could not save message to Cloud Firestore. Kept in memory.",
        );
      }

      return;
    }

    setUserChats((previous) => {
      const next = previous.map((chat) => {
        if (chat.id !== chatId) return chat;

        const existingMessages = chat.messages || [];

        const hasExisting = existingMessages.some(
          (item) => item.id === message.id,
        );

        const updatedMessages = hasExisting
          ? existingMessages.map((item) =>
              item.id === message.id ? message : item,
            )
          : [...existingMessages, message];

        return {
          ...chat,
          rawUpdatedAt: Date.now(),
          messages: updatedMessages,
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
    documents = [],
    images = [],
  ) => {
    const providerToUse = overrideProvider || selectedProvider;

    setIsLoading(true);
    isUserStoppedRef.current = false;

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

    let targetText = "";
    let displayedText = "";
    let activeModel = null;
    let finalProvider = providerToUse;
    let isStreamDone = false;
    let timerId = null;
    let isCancelled = false;
    let isFinalized = false;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    const cancelCurrentAnimation = () => {
      isCancelled = true;

      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };

    activeAnimationRef.current = cancelCurrentAnimation;

    const finalizeAssistantMessage = async (
      contentToSave,
      modelToUse,
      providerToFinalize,
      isStopped = false,
    ) => {
      if (isCancelled || isFinalized) return;

      isFinalized = true;

      const completedMessage = {
        id: assistantMessageId,
        sender: "assistant",
        provider: providerToFinalize || finalProvider || providerToUse,
        modelUsed: modelToUse || activeModel,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        content: contentToSave,
        isStreaming: false,
        isStopped: Boolean(isStopped),
      };

      if (activeChatIdRef.current === targetChatId) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId ? completedMessage : message,
          ),
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

          displayedText = targetText.slice(0, displayedText.length + stepSize);
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
                }
              : message,
          ),
        );

        timerId = setTimeout(pumpAnimation, 18);

        return;
      }

      if (isStreamDone) {
        void finalizeAssistantMessage(targetText, activeModel, finalProvider);
      }
    };

    const triggerPump = () => {
      if (isCancelled || isFinalized || timerId !== null) {
        return;
      }

      timerId = setTimeout(pumpAnimation, 10);
    };

    const abortController = new AbortController();

    activeAbortControllerRef.current = abortController;

    try {
      const result = await streamAIMessage({
        provider: providerToUse,
        mode: activeMode,
        prompt: promptText,
        history: historyContext,
        documents,
        images,
        username: username || currentUser?.displayName || null,
        preferences: {
          responseLength: settings?.responseLength || "balanced",
          beginnerFriendly: Boolean(settings?.beginnerFriendly),
        },
        signal: abortController.signal,

        onStart: ({ modelUsed, provider: reportedProvider } = {}) => {
          if (modelUsed) activeModel = modelUsed;
          if (reportedProvider) {
            finalProvider = reportedProvider;
          }

          if (activeChatIdRef.current === targetChatId) {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === assistantMessageId
                  ? {
                      ...message,
                      modelUsed: activeModel,
                      provider: finalProvider,
                    }
                  : message,
              ),
            );
          }
        },

        onChunk: (_chunkText, currentAccumulated) => {
          if (typeof currentAccumulated === "string") {
            targetText = currentAccumulated;
          }

          triggerPump();
        },
      });

      const resolvedText =
        typeof result?.text === "string" ? result.text : targetText;

      targetText = resolvedText;

      if (result?.modelUsed) {
        activeModel = result.modelUsed;
      }

      if (result?.provider) {
        finalProvider = result.provider;
      }

      isStreamDone = true;

      // Persist the answer in the original conversation if the user switched chats.
      if (activeChatIdRef.current !== targetChatId) {
        cancelCurrentAnimation();

        const completedMessage = {
          id: assistantMessageId,
          sender: "assistant",
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          content: resolvedText,
          isStreaming: false,
        };

        if (targetChatId) {
          await persistMessageSafe(targetChatId, completedMessage);
        }

        setIsLoading(false);
        isSubmittingRef.current = false;

        return;
      }

      if (!prefersReducedMotion && displayedText.length < targetText.length) {
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
                }
              : message,
          ),
        );

        await finalizeAssistantMessage(targetText, activeModel, finalProvider);
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
        error?.name === "AbortError" ||
        String(error?.message || "")
          .toLowerCase()
          .includes("aborted");

      if (isAbortedByUser) {
        const stoppedText =
          targetText.trim().length > 0
            ? targetText
            : "Response generation stopped.";

        const stoppedMessage = {
          id: assistantMessageId,
          sender: "assistant",
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          content: stoppedText,
          isStreaming: false,
          isStopped: true,
        };

        if (activeChatIdRef.current === targetChatId) {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId ? stoppedMessage : message,
            ),
          );
        }

        if (targetChatId) {
          await persistMessageSafe(targetChatId, stoppedMessage);
        }

        setIsLoading(false);
        isSubmittingRef.current = false;

        return;
      }

      console.error("Streaming prompt execution error:", error);

      let rawMsg = String(error?.message || "");

      if (rawMsg.includes("{") && rawMsg.includes("}")) {
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
          error?.status === "UNAVAILABLE" ||
          rawMsg.toLowerCase().includes("high demand") ||
          rawMsg.toLowerCase().includes("spikes in demand") ||
          rawMsg.toLowerCase().includes("overloaded")) &&
        error?.code !== 500;

      const is500 = error?.code === 500 || error?.status === "INTERNAL";

      const isAuthError =
        error?.code === 401 ||
        error?.code === 403 ||
        error?.status === "UNAUTHENTICATED" ||
        error?.status === "PERMISSION_DENIED";

      const isRateLimit =
        error?.code === 429 || error?.status === "RESOURCE_EXHAUSTED";

      let friendlyMsg = rawMsg;

      if (is503) {
        friendlyMsg =
          "Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments, or switch to Groq or OpenRouter below.";
      } else if (is500) {
        friendlyMsg =
          rawMsg &&
          !rawMsg.includes("Server request failed") &&
          !rawMsg.includes("Internal Server Error")
            ? `The AI service encountered an internal error: ${rawMsg}. You can retry or switch to another provider below.`
            : "The AI service encountered an internal error (HTTP 500). Please try again in a moment, or switch to Groq or OpenRouter below.";
      } else if (isAuthError) {
        friendlyMsg = `Authentication or permission error with ${providerToUse}. Please check your API key configuration or switch providers below.`;
      } else if (isRateLimit) {
        friendlyMsg =
          "AI rate limit or quota exceeded. Please wait a moment before trying again, or switch providers below.";
      } else if (!friendlyMsg) {
        friendlyMsg = `An unexpected error occurred while communicating with ${providerToUse}.`;
      }

      if (activeChatIdRef.current === targetChatId) {
        if (targetText.trim().length > 0) {
          const partialMessage = {
            id: assistantMessageId,
            sender: "assistant",
            provider: finalProvider || providerToUse,
            modelUsed: activeModel,
            timestamp: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            content: `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`,
            isStreaming: false,
            isInterrupted: true,
            failedPrompt: promptText,
            failedProvider: finalProvider || providerToUse,
            failedDocuments: documents,
            failedImages: images,
            canSwitchProvider: true,
          };

          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId ? partialMessage : message,
            ),
          );

          if (targetChatId) {
            await persistMessageSafe(targetChatId, partialMessage);
          }
        } else {
          const errorMessage = {
            id: `error-${Date.now()}`,
            sender: "assistant",
            isError: true,
            failedPrompt: promptText,
            failedProvider: finalProvider || providerToUse,
            failedDocuments: documents,
            failedImages: images,
            canSwitchProvider: true,
            timestamp: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            content: friendlyMsg,
          };

          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessageId ? errorMessage : message,
            ),
          );
        }
      } else if (targetChatId && targetText.trim().length > 0) {
        const partialMessage = {
          id: assistantMessageId,
          sender: "assistant",
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          content: `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`,
          isStreaming: false,
          isInterrupted: true,
          failedPrompt: promptText,
          failedProvider: finalProvider || providerToUse,
          failedDocuments: documents,
          failedImages: images,
          canSwitchProvider: true,
        };

        await persistMessageSafe(targetChatId, partialMessage);
      }

      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Submit a new message, with optional extracted document attachments and image uploads.
  const handleSubmit = async () => {
    stopSpeech();

    const trimmed = inputValue.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

    // Separate ready documents and ready images
    const readyDocAttachments = attachments.filter(
      (attachment) =>
        attachment?.category !== "image" &&
        !attachment?.previewUrl &&
        (attachment?.status === "ready" ||
          (!attachment?.status &&
            typeof attachment?.text === "string" &&
            attachment.text.trim().length > 0)),
    );

    const readyImageAttachments = attachments.filter(
      (attachment) =>
        (attachment?.category === "image" || Boolean(attachment?.previewUrl)) &&
        (attachment?.status === "ready" || !attachment?.status),
    );

    const totalReadyAttachments = [
      ...readyDocAttachments,
      ...readyImageAttachments,
    ];

    // Allow document-only, image-only, or text+attachment messages, but prevent empty submissions.
    if (
      (!trimmed && totalReadyAttachments.length === 0) ||
      isLoading ||
      isSubmittingRef.current ||
      isExtractingAttachments ||
      isProcessingImages
    ) {
      return;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    let defaultPrompt = "";
    if (readyImageAttachments.length > 0 && readyDocAttachments.length > 0) {
      defaultPrompt = "Please analyze the attached image and document.";
    } else if (readyImageAttachments.length > 0) {
      defaultPrompt =
        readyImageAttachments.length === 1
          ? "Please analyze this image and describe what you see."
          : "Please analyze these attached images.";
    } else if (readyDocAttachments.length > 0) {
      defaultPrompt =
        "Please analyze the attached document and help me understand it.";
    }

    const promptForAI = trimmed || defaultPrompt;

    let currentChatId = activeChatIdRef.current;

    try {
      // Create a conversation if one does not already exist.
      if (!currentChatId) {
        const titleSnippet = generateChatTitle(promptForAI);

        if (isCloudEnabled && currentUser?.uid) {
          try {
            currentChatId = await createChatDocument(
              currentUser.uid,
              titleSnippet,
              activeMode,
            );

            skipNextChatLoadRef.current = currentChatId;
          } catch (error) {
            console.warn("Could not create Firestore chat document:", error);

            setPersistenceError(
              "Failed to initialize conversation in Cloud Firestore.",
            );

            setIsLoading(false);
            isSubmittingRef.current = false;
            return;
          }
        } else {
          currentChatId = `guest-${Date.now()}`;

          skipNextChatLoadRef.current = currentChatId;

          const newGuestChat = {
            id: currentChatId,
            title: titleSnippet,
            mode: activeMode || "general",
            timestamp: "Just now",
            rawUpdatedAt: Date.now(),
            isPinned: false,
            pinnedAt: null,
            messages: [],
          };

          setUserChats((previous) => {
            const next = [newGuestChat, ...previous];
            saveGuestChats(next);
            return next;
          });
        }

        // Update the active conversation immediately.
        activeChatIdRef.current = currentChatId;
        setActiveChatId(currentChatId);

        sessionStorage.setItem("orvix_active_chat", currentChatId);

        sessionStorage.setItem("chatora_active_chat", currentChatId);
      }

      const now = Date.now();

      /*
       * Store display-only attachment metadata in the user message.
       * Do not put extracted document text or large base64 strings here.
       * For images in the active session, keep previewUrl in memory for rendering.
       */
      const messageDocAttachments = readyDocAttachments.map(
        (attachment, index) => {
          const name =
            attachment.name ||
            attachment.filename ||
            attachment.fileName ||
            attachment.originalName ||
            `Attached document ${index + 1}`;

          const rawSize = attachment.size ?? attachment.fileSize ?? 0;
          const parsedSize = Number(rawSize);
          const size = Number.isFinite(parsedSize) ? parsedSize : 0;

          return {
            id: attachment.id || `${name}-${index}`,
            category: "document",
            name,
            size,
            type: attachment.type || attachment.mimeType || "",
            pageCount: attachment.pageCount,
            slideCount: attachment.slideCount,
            rowCount: attachment.rowCount,
          };
        },
      );

      const messageImageAttachments = readyImageAttachments.map(
        (img, index) => {
          const name = img.name || `image-${index + 1}.png`;
          const rawSize = img.size ?? 0;
          const size = Number.isFinite(Number(rawSize)) ? Number(rawSize) : 0;

          return {
            id: img.id || `img-${index}`,
            category: "image",
            name,
            size,
            type: img.type || img.mimeType || "image/png",
            mimeType: img.mimeType || img.type || "image/png",
            width: img.width,
            height: img.height,
            previewUrl: img.previewUrl,
            base64: img.base64 || "",
          };
        },
      );

      const messageAttachments = [
        ...messageImageAttachments,
        ...messageDocAttachments,
      ];

      // Create the user message with its attachment metadata.
      const userMessage = {
        id: `user-${now}`,
        sender: "user",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        content: promptForAI,
        ...(messageAttachments.length > 0
          ? { attachments: messageAttachments }
          : {}),
      };

      const assistantMessageId = `${selectedProvider}-${now}-assistant`;

      const initialAssistantMessage = {
        id: assistantMessageId,
        sender: "assistant",
        provider: selectedProvider,
        modelUsed: null,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        content: "",
        isStreaming: true,
      };

      const validHistory = messages.filter((message) => !message.isError);

      // Immediately display the user message and assistant placeholder.
      setMessages((previous) => [
        ...previous,
        userMessage,
        initialAssistantMessage,
      ]);

      setInputValue("");

      // Clear the composer attachments after capturing them above.
      setAttachments([]);
      setAttachmentError(null);

      // Persist the user message with its attachment metadata.
      if (currentChatId) {
        void persistMessageSafe(currentChatId, userMessage);
      }

      /*
       * Pass the extracted documents and images to the AI router.
       */
      await executePrompt(
        promptForAI,
        validHistory,
        currentChatId,
        assistantMessageId,
        null,
        readyDocAttachments,
        readyImageAttachments,
      );
    } catch (error) {
      console.error("Submission error:", error);

      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  // Retry a failed AI response with the same provider.
  const handleRetry = (failedMessage) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current || !failedMessage?.failedPrompt) {
      return;
    }

    isSubmittingRef.current = true;
    setIsLoading(true);

    const currentChatId = activeChatIdRef.current;

    const providerToUse = failedMessage.failedProvider || selectedProvider;

    const updatedMessages = messages.filter(
      (message) => message.id !== failedMessage.id,
    );

    const assistantMessageId = `${providerToUse}-${Date.now()}-retry`;

    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: "assistant",
      provider: providerToUse,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      content: "",
      isStreaming: true,
    };

    setMessages([...updatedMessages, initialAssistantMessage]);

    const validHistory = updatedMessages.filter(
      (message) => !message.isError && !message.isInterrupted,
    );

    void executePrompt(
      failedMessage.failedPrompt,
      validHistory,
      currentChatId,
      assistantMessageId,
      providerToUse,
      failedMessage.failedDocuments || [],
      failedMessage.failedImages || [],
    );
  };

  // Switch provider and retry without duplicating conversation messages.
  const handleSwitchProviderAndRetry = (failedMessage, newProviderId) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current || !failedMessage?.failedPrompt) {
      return;
    }

    // FIX: Removed the stray, invalid standalone "setAttachments" line.
    handleSelectProvider(newProviderId);

    isSubmittingRef.current = true;
    setIsLoading(true);

    const currentChatId = activeChatIdRef.current;

    const updatedMessages = messages.filter(
      (message) => message.id !== failedMessage.id,
    );

    const assistantMessageId = `${newProviderId}-${Date.now()}-fallback`;

    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: "assistant",
      provider: newProviderId,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      content: "",
      isStreaming: true,
    };

    setMessages([...updatedMessages, initialAssistantMessage]);

    const validHistory = updatedMessages.filter(
      (message) => !message.isError && !message.isInterrupted,
    );

    void executePrompt(
      failedMessage.failedPrompt,
      validHistory,
      currentChatId,
      assistantMessageId,
      newProviderId,
      failedMessage.failedDocuments || [],
      failedMessage.failedImages || [],
    );
  };

  // Restore a failed prompt to the input field.
  const handleRestorePrompt = (promptText) => {
    setInputValue(promptText);

    setMessages((previous) =>
      previous.filter((message) => message.failedPrompt !== promptText),
    );
  };

  // Regenerate an assistant response in place.
  const handleRegenerate = async (assistantMessage) => {
    stopSpeech();

    if (isLoading || isSubmittingRef.current || !assistantMessage?.id) {
      return;
    }

    const currentChatId = activeChatIdRef.current;

    const msgIndex = messages.findIndex(
      (message) => message.id === assistantMessage.id,
    );

    if (msgIndex === -1) return;

    const precedingUserMessage = [...messages.slice(0, msgIndex)]
      .reverse()
      .find((message) => message.sender === "user");

    if (!precedingUserMessage || !precedingUserMessage.content) {
      console.warn("Cannot regenerate: preceding user prompt not found.");
      return;
    }

    const userPromptText = precedingUserMessage.content;

    const userMsgIndex = messages.findIndex(
      (message) => message.id === precedingUserMessage.id,
    );

    const validHistory = messages
      .slice(0, userMsgIndex)
      .filter((message) => !message.isError);

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    const targetAssistantId = assistantMessage.id;

    persistedMessageIdsRef.current.delete(targetAssistantId);

    setMessages((previous) =>
      previous.map((message) =>
        message.id === targetAssistantId
          ? {
              ...message,
              content: "",
              modelUsed: null,
              provider: selectedProvider,
              timestamp: new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
              isStreaming: true,
              isError: false,
              isStopped: false,
            }
          : message,
      ),
    );

    const userDocs = (precedingUserMessage.attachments || []).filter(
      (a) => a.category !== "image" && a.text,
    );
    const userImgs = (precedingUserMessage.attachments || []).filter(
      (a) =>
        (a.category === "image" || a.previewUrl) && (a.base64 || a.dataUrl),
    );

    await executePrompt(
      userPromptText,
      validHistory,
      currentChatId,
      targetAssistantId,
      null,
      userDocs,
      userImgs,
    );
  };

  // Stop active AI response generation.
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

  // Start inline editing mode.
  const handleStartEdit = (messageId) => {
    if (isLoading || isSubmittingRef.current) return;

    setEditingMessageId(messageId);
  };

  // Cancel inline editing mode.
  const handleCancelEdit = () => {
    setEditingMessageId(null);
  };

  // Edit and resend a user message, truncating the later conversation branch.
  const handleEditResend = async (userMessageId, newPromptText) => {
    stopSpeech();

    const trimmed = (newPromptText || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();

    if (!trimmed || isLoading || isSubmittingRef.current) {
      return;
    }

    const userMsgIndex = messages.findIndex(
      (message) => message.id === userMessageId,
    );

    if (userMsgIndex === -1) return;

    setEditingMessageId(null);

    isSubmittingRef.current = true;
    setIsLoading(true);
    setPersistenceError(null);

    let currentChatId = activeChatIdRef.current;

    if (!currentChatId) {
      const titleSnippet = generateChatTitle(trimmed);

      if (isCloudEnabled && currentUser?.uid) {
        try {
          currentChatId = await createChatDocument(
            currentUser.uid,
            titleSnippet,
          );

          skipNextChatLoadRef.current = currentChatId;
        } catch (error) {
          console.warn("Could not create Firestore chat doc for edit:", error);

          setPersistenceError(
            "Failed to initialize conversation in Cloud Firestore.",
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
          timestamp: "Just now",
          rawUpdatedAt: Date.now(),
          isPinned: false,
          pinnedAt: null,
          messages: [],
        };

        setUserChats((previous) => {
          const next = [newGuestChat, ...previous];

          saveGuestChats(next);

          return next;
        });
      }

      activeChatIdRef.current = currentChatId;
      setActiveChatId(currentChatId);

      sessionStorage.setItem("orvix_active_chat", currentChatId);

      sessionStorage.setItem("chatora_active_chat", currentChatId);
    }

    const earlierMessages = messages.slice(0, userMsgIndex);

    const validHistory = earlierMessages.filter((message) => !message.isError);

    const laterMessages = messages.slice(userMsgIndex + 1);

    const laterMessageIds = laterMessages
      .map((message) => message.id)
      .filter(Boolean);

    laterMessageIds.forEach((id) => {
      persistedMessageIdsRef.current.delete(id);
    });

    const updatedUserMessage = {
      ...messages[userMsgIndex],
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    persistedMessageIdsRef.current.delete(updatedUserMessage.id);

    const now = Date.now();

    const assistantMessageId = `${selectedProvider}-${now}-assistant`;

    const initialAssistantMessage = {
      id: assistantMessageId,
      sender: "assistant",
      provider: selectedProvider,
      modelUsed: null,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      content: "",
      isStreaming: true,
    };

    const nextMessages = [
      ...earlierMessages,
      updatedUserMessage,
      initialAssistantMessage,
    ];

    setMessages(nextMessages);

    if (isCloudEnabled && currentUser?.uid) {
      if (laterMessageIds.length > 0) {
        deleteChatMessages(
          currentUser.uid,
          currentChatId,
          laterMessageIds,
        ).catch((error) => {
          console.warn(
            "Could not delete truncated messages from Cloud Firestore:",
            error,
          );
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
            messages: nextMessages,
          };
        });

        saveGuestChats(next);

        return next;
      });
    }

    if (userMsgIndex === 0) {
      const refreshedTitle = generateChatTitle(trimmed);

      void handleRenameChat(currentChatId, refreshedTitle);
    }

    const editedDocs = (messages[userMsgIndex]?.attachments || []).filter(
      (a) => a.category !== "image" && a.text,
    );
    const editedImgs = (messages[userMsgIndex]?.attachments || []).filter(
      (a) =>
        (a.category === "image" || a.previewUrl) && (a.base64 || a.dataUrl),
    );

    await executePrompt(
      trimmed,
      validHistory,
      currentChatId,
      assistantMessageId,
      null,
      editedDocs,
      editedImgs,
    );
  };

  // Export handlers for the active conversation.
  const hasExportableMessages = messages.some(
    (message) =>
      !message.isError &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
  );

  const handleExportMarkdown = () => {
    if (messagesLoading) {
      setExportNotice({
        type: "warning",
        message:
          "Please wait until the conversation finishes loading before exporting.",
      });

      return;
    }

    const result = exportAsMarkdown({
      title: activeTitle || "Conversation",
      messages,
      username,
    });

    if (result.success) {
      setExportNotice({
        type: "success",
        message: `Exported conversation as Markdown (${result.filename}).`,
      });
    } else {
      setExportNotice({
        type: "warning",
        message: result.error || "This conversation has no messages to export.",
      });
    }
  };

  const handleExportText = () => {
    if (messagesLoading) {
      setExportNotice({
        type: "warning",
        message:
          "Please wait until the conversation finishes loading before exporting.",
      });

      return;
    }

    const result = exportAsPlainText({
      title: activeTitle || "Conversation",
      messages,
      username,
    });

    if (result.success) {
      setExportNotice({
        type: "success",
        message: `Exported conversation as Plain Text (${result.filename}).`,
      });
    } else {
      setExportNotice({
        type: "warning",
        message: result.error || "This conversation has no messages to export.",
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
          {exportNotice.type === "success" ? (
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

          <span className="persistence-alert-text">{exportNotice.message}</span>

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
        attachments={attachments}
        onAttachFiles={handleAttachFiles}
        onAttachImages={handleAttachImages}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentError={attachmentError}
        onClearAttachmentError={handleClearAttachmentError}
        isExtractingAttachments={isExtractingAttachments}
        isProcessingImages={isProcessingImages}
      />
    </Layout>
  );
}
