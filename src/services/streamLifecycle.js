import { PROVIDER_OPTIONS } from './aiRouter.js';
import {
  normalizeAssistantMessage,
  updateActiveAlternativeInMessage,
  finalizeStoppedAssistantMessage
} from './alternativeResponseService.js';

/**
 * Formats friendly provider error messages identically to ChatPage's existing behavior.
 */
function formatFriendlyStreamError(error, effectiveProvider) {
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

  const currentProviderConfig = Array.isArray(PROVIDER_OPTIONS)
    ? PROVIDER_OPTIONS.find((p) => p.id === effectiveProvider)
    : null;
  const providerDisplayName =
    currentProviderConfig?.name ||
    (effectiveProvider
      ? effectiveProvider.charAt(0).toUpperCase() + effectiveProvider.slice(1)
      : 'AI Provider');

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
  const isNotFound =
    error?.code === 404 ||
    error?.status === 'NOT_FOUND' ||
    rawMsg.toLowerCase().includes('not found') ||
    rawMsg.toLowerCase().includes('does not exist') ||
    rawMsg.toLowerCase().includes('access to it') ||
    rawMsg.toLowerCase().includes('decommissioned') ||
    rawMsg.toLowerCase().includes('retired');

  let friendlyMsg = rawMsg;
  if (isOllama) {
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
    friendlyMsg =
      rawMsg ||
      'Browser AI (WebLLM) encountered a local initialization or generation error on this device.';
  } else if (is503) {
    if (isGemini) {
      friendlyMsg =
        'Google Gemini is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments, or switch to Groq, OpenRouter, or Local AI below.';
    } else {
      friendlyMsg = `${providerDisplayName} is currently experiencing high demand. Spikes in demand are usually temporary. Please try again in a few moments, or switch to another provider below.`;
    }
  } else if (isNotFound) {
    friendlyMsg =
      rawMsg ||
      `The requested model for ${providerDisplayName} is unavailable or retired. Please choose another model or provider below.`;
  } else if (is500) {
    friendlyMsg =
      rawMsg &&
      !rawMsg.includes('Server request failed') &&
      !rawMsg.includes('Internal Server Error')
        ? `${providerDisplayName} encountered an internal error: ${rawMsg}. You can retry or switch to another provider below.`
        : `${providerDisplayName} encountered an internal error (HTTP 500). Please try again in a moment, or switch to another provider below.`;
  } else if (isAuthError) {
    friendlyMsg = `Authentication or permission error with ${providerDisplayName}. Please check your API key configuration or switch providers below.`;
  } else if (isRateLimit) {
    friendlyMsg = `${providerDisplayName} rate limit or quota exceeded. Please wait a moment before trying again, or switch providers below.`;
  } else if (!friendlyMsg) {
    friendlyMsg = `An unexpected error occurred while communicating with ${providerDisplayName}.`;
  }

  return { friendlyMsg, isLocalProvider };
}

/**
 * Stops the active generation session deterministically across BOTH:
 * 1. In-flight network/local model streaming, AND
 * 2. Post-network progressive animation reveal (`displayedText.length < targetText.length`).
 *
 * Ensures no assistant message ever remains stuck with `isStreaming: true`.
 */
export function stopActiveGenerationSession({
  refs,
  selectedProvider,
  webllmStatus,
  stopWebLLMGeneration,
  commitMessages,
  persistMessageSafe,
  setIsLoading
}) {
  const {
    activeStopHandlerRef,
    activeAbortControllerRef,
    activeAnimationRef,
    activeChatIdRef,
    messagesRef,
    generationIdRef,
    isSubmittingRef,
    isUserStoppedRef
  } = refs;

  if (isUserStoppedRef) {
    isUserStoppedRef.current = true;
  }

  if (
    selectedProvider === 'webllm' ||
    webllmStatus === 'generating' ||
    webllmStatus === 'downloading' ||
    webllmStatus === 'loading'
  ) {
    stopWebLLMGeneration?.();
  }

  let handledByActiveSession = false;
  if (typeof activeStopHandlerRef?.current === 'function') {
    const stopFn = activeStopHandlerRef.current;
    activeStopHandlerRef.current = null;
    handledByActiveSession = true;
    stopFn();
  }

  if (activeAbortControllerRef?.current) {
    try {
      activeAbortControllerRef.current.abort();
    } catch (_) {}
    activeAbortControllerRef.current = null;
  }

  if (typeof activeAnimationRef?.current === 'function') {
    activeAnimationRef.current();
    activeAnimationRef.current = null;
  }

  // Defensive safety net: if any assistant message in the active chat still has `isStreaming: true`
  // (e.g. stopped before stream session handler bound), finalize and persist it immediately.
  const currentList = Array.isArray(messagesRef?.current) ? messagesRef.current : [];
  if (!handledByActiveSession && currentList.some((m) => m?.sender === 'assistant' && m?.isStreaming)) {
    const finalizedToPersist = [];
    commitMessages((previous) =>
      previous.map((msg) => {
        if (msg?.sender !== 'assistant' || !msg?.isStreaming) return msg;
        const stoppedMsg = finalizeStoppedAssistantMessage(msg, {
          partialContent: msg.content
        });
        finalizedToPersist.push(stoppedMsg);
        return stoppedMsg;
      })
    );

    const chatId = activeChatIdRef?.current;
    if (chatId) {
      for (const stoppedMsg of finalizedToPersist) {
        void persistMessageSafe(chatId, stoppedMsg, true);
      }
    }
  }

  if (generationIdRef) {
    generationIdRef.current += 1;
  }

  setIsLoading(false);
  if (isSubmittingRef) {
    isSubmittingRef.current = false;
  }
}

/**
 * Runs an AI streaming prompt session with progressive text reveal, deterministic Stop handling,
 * synchronous message state finalization (immune to React 19 deferred updater batching),
 * and generation-ID isolation so stale callbacks from stopped/aborted streams never clobber newer prompts.
 */
export async function executeStreamPromptSession({
  promptText,
  historyContext,
  targetChatId,
  assistantMessageId,
  providerToUse,
  effectiveModelOverride,
  activeMode,
  username,
  preferences,
  currentAttachments,
  multiPartParams = {},
  customStartTime = null,
  prefersReducedMotion = false,
  streamAIMessageFn,
  stopWebLLMGeneration,
  getWebLLMStatus,
  refs,
  commitMessages,
  findMessageInUserChats,
  persistMessageSafe,
  setIsLoading,
  setPersistenceError
}) {
  const {
    activeAbortControllerRef,
    activeAnimationRef,
    activeStopHandlerRef,
    activeChatIdRef,
    messagesRef,
    generationIdRef,
    isSubmittingRef,
    isUserStoppedRef
  } = refs;

  // Terminate any prior generation before starting this one
  if (activeStopHandlerRef) {
    activeStopHandlerRef.current = null;
  }
  if (activeAbortControllerRef?.current) {
    try {
      activeAbortControllerRef.current.abort();
    } catch (_) {}
    activeAbortControllerRef.current = null;
  }
  if (typeof activeAnimationRef?.current === 'function') {
    activeAnimationRef.current();
    activeAnimationRef.current = null;
  }

  const generationId = ++generationIdRef.current;
  const isCurrentGeneration = () => generationIdRef.current === generationId;

  setIsLoading(true);
  if (isUserStoppedRef) {
    isUserStoppedRef.current = false;
  }

  const abortController = new AbortController();
  activeAbortControllerRef.current = abortController;

  const requestStartTime =
    typeof customStartTime === 'number' && customStartTime > 0
      ? customStartTime
      : performance.now();
  let measuredResponseTimeMs = null;

  let targetText = '';
  let displayedText = '';
  let activeModel = effectiveModelOverride || null;
  let finalProvider = providerToUse;
  let isStreamDone = false;
  let timerId = null;
  let isCancelled = false;
  let isFinalized = false;
  let isStoppedByUser = false;

  let latestAssistantMessage =
    (Array.isArray(messagesRef?.current)
      ? messagesRef.current.find((m) => m.id === assistantMessageId)
      : null) || null;

  const clearSessionRefs = () => {
    if (activeStopHandlerRef?.current === stopThisGeneration) {
      activeStopHandlerRef.current = null;
    }
    if (activeAnimationRef?.current === cancelCurrentAnimation) {
      activeAnimationRef.current = null;
    }
    if (activeAbortControllerRef?.current === abortController) {
      activeAbortControllerRef.current = null;
    }
  };

  const clearLoadingIfCurrent = () => {
    if (isCurrentGeneration()) {
      setIsLoading(false);
      if (isSubmittingRef) {
        isSubmittingRef.current = false;
      }
    }
  };

  const cancelCurrentAnimation = () => {
    isCancelled = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  activeAnimationRef.current = cancelCurrentAnimation;

  const buildFallbackBaseMessage = (fallbackContent = '') => {
    const fromChats = findMessageInUserChats?.(targetChatId, assistantMessageId) || null;
    return (
      latestAssistantMessage ||
      fromChats || {
        id: assistantMessageId,
        sender: 'assistant',
        provider: finalProvider || providerToUse,
        modelUsed: activeModel,
        mode: activeMode || 'general',
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        }),
        content: fallbackContent
      }
    );
  };

  /**
   * Synchronous, idempotent user-stop finalizer.
   * Works identically whether the network stream is still open OR already finished
   * while `pumpAnimation` is revealing buffered tokens.
   */
  function stopThisGeneration() {
    if (isFinalized) return null;

    isStoppedByUser = true;
    isFinalized = true;
    cancelCurrentAnimation();

    const webllmStatus = getWebLLMStatus?.() || null;
    if (
      providerToUse === 'webllm' ||
      finalProvider === 'webllm' ||
      webllmStatus === 'generating' ||
      webllmStatus === 'downloading' ||
      webllmStatus === 'loading'
    ) {
      stopWebLLMGeneration?.();
    }

    try {
      abortController.abort();
    } catch (_) {}

    // Freeze at the exact text already visible to the user (or received chunk if first frame hasn't painted yet)
    const partialVisible =
      displayedText.length > 0 ? displayedText : targetText;

    let stoppedMessage = null;

    if (activeChatIdRef.current === targetChatId) {
      const nextList = commitMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const finalized = finalizeStoppedAssistantMessage(message, {
            partialContent: partialVisible,
            modelUsed: activeModel || message.modelUsed,
            provider: finalProvider || providerToUse || message.provider
          });
          latestAssistantMessage = finalized;
          return finalized;
        })
      );
      stoppedMessage =
        nextList.find((m) => m.id === assistantMessageId) || null;
    }

    if (!stoppedMessage) {
      const baseMsg = buildFallbackBaseMessage(partialVisible);
      stoppedMessage = finalizeStoppedAssistantMessage(baseMsg, {
        partialContent: partialVisible,
        modelUsed: activeModel || baseMsg.modelUsed,
        provider: finalProvider || providerToUse || baseMsg.provider
      });
      latestAssistantMessage = stoppedMessage;
    }

    clearSessionRefs();

    if (isCurrentGeneration()) {
      generationIdRef.current += 1;
      setIsLoading(false);
      if (isSubmittingRef) {
        isSubmittingRef.current = false;
      }
    }

    const persistPromise =
      targetChatId && stoppedMessage
        ? persistMessageSafe(targetChatId, stoppedMessage, true)
        : Promise.resolve();

    return persistPromise;
  }

  activeStopHandlerRef.current = stopThisGeneration;

  // Normal completion finalizer (runs once when stream + animation both complete without cancellation).
  const finalizeAssistantMessage = async (
    contentToSave,
    modelToUse,
    providerToFinalize,
    isStopped = false,
    responseTime = null
  ) => {
    if (isCancelled || isFinalized || isStoppedByUser) return;

    isFinalized = true;

    const finalResponseTime = !isStopped
      ? (responseTime ?? measuredResponseTimeMs)
      : null;

    let completedMessage = null;

    if (activeChatIdRef.current === targetChatId) {
      const nextList = commitMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const normalized = normalizeAssistantMessage(message);
          const updated = updateActiveAlternativeInMessage(normalized, {
            content: contentToSave,
            modelUsed: modelToUse || activeModel || normalized.modelUsed,
            provider:
              providerToFinalize ||
              finalProvider ||
              providerToUse ||
              normalized.provider,
            responseTimeMs:
              typeof finalResponseTime === 'number'
                ? finalResponseTime
                : normalized.responseTimeMs,
            isStreaming: false,
            isStopped: Boolean(isStopped),
            isError: false,
            isInterrupted: false,
            referencedAttachments: undefined
          });
          const { requestStartTime: _ignoreStart, ...finalized } = updated;
          latestAssistantMessage = finalized;
          return finalized;
        })
      );
      completedMessage =
        nextList.find((m) => m.id === assistantMessageId) || null;
    }

    if (!completedMessage) {
      const baseMsg = buildFallbackBaseMessage(contentToSave);
      const normalized = normalizeAssistantMessage(baseMsg);
      const updated = updateActiveAlternativeInMessage(normalized, {
        content: contentToSave,
        modelUsed: modelToUse || activeModel || normalized.modelUsed,
        provider:
          providerToFinalize ||
          finalProvider ||
          providerToUse ||
          normalized.provider,
        responseTimeMs:
          typeof finalResponseTime === 'number'
            ? finalResponseTime
            : normalized.responseTimeMs,
        isStreaming: false,
        isStopped: Boolean(isStopped),
        isError: false,
        isInterrupted: false,
        referencedAttachments: undefined
      });
      const { requestStartTime: _ignoreStart, ...finalized } = updated;
      completedMessage = finalized;
      latestAssistantMessage = finalized;
    }

    if (targetChatId) {
      await persistMessageSafe(targetChatId, completedMessage, true);
    }

    clearSessionRefs();
    clearLoadingIfCurrent();
  };

  // Gradually reveal received tokens into displayedText.
  const pumpAnimation = () => {
    timerId = null;

    if (isCancelled || isFinalized || isStoppedByUser || abortController.signal.aborted) {
      return;
    }

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

      commitMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const normalized = normalizeAssistantMessage(message);
          const updated = updateActiveAlternativeInMessage(normalized, {
            content: displayedText,
            modelUsed: activeModel || message.modelUsed,
            provider: finalProvider || message.provider,
            isStreaming: true,
            referencedAttachments: undefined
          });
          latestAssistantMessage = updated;
          return updated;
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
    if (
      isCancelled ||
      isFinalized ||
      isStoppedByUser ||
      abortController.signal.aborted ||
      timerId !== null
    ) {
      return;
    }

    timerId = setTimeout(pumpAnimation, 10);
  };

  if (activeChatIdRef.current === targetChatId) {
    commitMessages((previous) =>
      previous.map((message) => {
        if (message.id !== assistantMessageId) return message;
        const nextMsg = { ...message, requestStartTime, isStreaming: true };
        latestAssistantMessage = nextMsg;
        return nextMsg;
      })
    );
  }

  try {
    const result = await streamAIMessageFn({
      provider: providerToUse,
      model: effectiveModelOverride,
      mode: activeMode,
      prompt: promptText,
      history: historyContext,
      username,
      preferences,
      signal: abortController.signal,
      conversationId: targetChatId,
      attachments: currentAttachments,
      isContinuation: multiPartParams.isContinuation,
      partNumber: multiPartParams.partNumber,
      originalPrompt: multiPartParams.originalPrompt,
      previousContentSummary: multiPartParams.previousContentSummary,

      onStart: ({ modelUsed, provider: reportedProvider } = {}) => {
        if (isCancelled || isFinalized || isStoppedByUser || abortController.signal.aborted) {
          return;
        }
        if (modelUsed) activeModel = modelUsed;
        if (reportedProvider) finalProvider = reportedProvider;

        if (activeChatIdRef.current === targetChatId) {
          commitMessages((previous) =>
            previous.map((message) => {
              if (message.id !== assistantMessageId) return message;
              const normalized = normalizeAssistantMessage(message);
              const updated = updateActiveAlternativeInMessage(normalized, {
                modelUsed: activeModel,
                provider: finalProvider,
                referencedAttachments: undefined
              });
              latestAssistantMessage = updated;
              return updated;
            })
          );
        }
      },

      onChunk: (_chunkText, currentAccumulated) => {
        if (isCancelled || isFinalized || isStoppedByUser || abortController.signal.aborted) {
          return;
        }
        if (typeof currentAccumulated === 'string') {
          targetText = currentAccumulated;
        }
        triggerPump();
      }
    });

    // If user stopped or session was cancelled while streamAIMessage was resolving, exit without overwriting
    if (isStoppedByUser || isFinalized || isCancelled || abortController.signal.aborted) {
      if (!isFinalized && abortController.signal.aborted) {
        await stopThisGeneration();
      }
      return;
    }

    measuredResponseTimeMs = Math.max(
      1,
      Math.round(performance.now() - requestStartTime)
    );

    const resolvedText =
      typeof result?.text === 'string' ? result.text : targetText;

    targetText = resolvedText;

    if (result?.modelUsed) activeModel = result.modelUsed;
    if (result?.provider) finalProvider = result.provider;

    isStreamDone = true;

    // Immediately record responseTimeMs once network stream finishes (unless later stopped during reveal)
    if (activeChatIdRef.current === targetChatId) {
      commitMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const normalized = normalizeAssistantMessage(message);
          const updated = updateActiveAlternativeInMessage(normalized, {
            responseTimeMs: measuredResponseTimeMs,
            modelUsed: activeModel || message.modelUsed,
            provider: finalProvider || message.provider
          });
          latestAssistantMessage = updated;
          return updated;
        })
      );
    }

    // If user switched to another chat while stream was running, persist directly to original chat
    if (activeChatIdRef.current !== targetChatId) {
      cancelCurrentAnimation();
      isFinalized = true;

      const baseMsg = buildFallbackBaseMessage(resolvedText);
      const normalized = normalizeAssistantMessage(baseMsg);
      const updated = updateActiveAlternativeInMessage(normalized, {
        content: resolvedText,
        modelUsed: activeModel,
        provider: finalProvider || providerToUse,
        isStreaming: false,
        isStopped: false,
        isError: false,
        responseTimeMs: measuredResponseTimeMs,
        referencedAttachments: undefined
      });
      const { requestStartTime: _ignoreStart, ...completedMessage } = updated;

      if (targetChatId) {
        await persistMessageSafe(targetChatId, completedMessage, true);
      }

      clearSessionRefs();
      clearLoadingIfCurrent();
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

    const isAborted =
      isStoppedByUser ||
      abortController.signal.aborted ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (isAborted) {
      // If `stopThisGeneration()` already ran synchronously via `handleStopGenerating`, do not duplicate or clobber newer streams.
      if (!isFinalized) {
        await stopThisGeneration();
      } else {
        clearSessionRefs();
        clearLoadingIfCurrent();
      }
      return;
    }

    cancelCurrentAnimation();
    clearSessionRefs();

    if (isFinalized) {
      clearLoadingIfCurrent();
      return;
    }

    isFinalized = true;
    console.error('Streaming prompt execution error:', error);

    const effectiveProvider = error?.provider || finalProvider || providerToUse;
    const { friendlyMsg, isLocalProvider } = formatFriendlyStreamError(
      error,
      effectiveProvider
    );

    const isInterrupted = targetText.trim().length > 0;
    const errorContent = isInterrupted
      ? `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`
      : friendlyMsg;

    if (activeChatIdRef.current === targetChatId) {
      const nextList = commitMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const normalized = normalizeAssistantMessage(message);
          const updated = updateActiveAlternativeInMessage(normalized, {
            content: errorContent,
            modelUsed: activeModel || normalized.modelUsed,
            provider:
              effectiveProvider ||
              finalProvider ||
              providerToUse ||
              normalized.provider,
            isStreaming: false,
            isStopped: false,
            isError: !isInterrupted,
            isInterrupted,
            failedPrompt: promptText,
            failedProvider: effectiveProvider || finalProvider || providerToUse,
            canSwitchProvider:
              error?.canFallback === false ? false : !isLocalProvider,
            referencedAttachments: undefined
          });
          const { requestStartTime: _ignoreStart, ...cleanErrMsg } = updated;
          latestAssistantMessage = cleanErrMsg;
          return cleanErrMsg;
        })
      );

      const finalizedErrorMessage =
        nextList.find((m) => m.id === assistantMessageId) || null;

      if (targetChatId && finalizedErrorMessage) {
        await persistMessageSafe(targetChatId, finalizedErrorMessage, true);
      }

      if (isCurrentGeneration()) {
        setPersistenceError(friendlyMsg);
      }
    } else if (targetChatId) {
      const baseMsg = buildFallbackBaseMessage(errorContent);
      const normalized = normalizeAssistantMessage(baseMsg);
      const updated = updateActiveAlternativeInMessage(normalized, {
        content: errorContent,
        modelUsed: activeModel || normalized.modelUsed,
        provider:
          effectiveProvider ||
          finalProvider ||
          providerToUse ||
          normalized.provider,
        isStreaming: false,
        isStopped: false,
        isError: !isInterrupted,
        isInterrupted,
        failedPrompt: promptText,
        failedProvider: effectiveProvider || finalProvider || providerToUse,
        canSwitchProvider:
          error?.canFallback === false ? false : !isLocalProvider,
        referencedAttachments: undefined
      });
      const { requestStartTime: _ignoreStart, ...cleanErrMsg } = updated;
      await persistMessageSafe(targetChatId, cleanErrMsg, true);
    }

    clearLoadingIfCurrent();
  }
}
