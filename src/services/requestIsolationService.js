/**
 * Orvix Request Isolation & Cancellation Coordinator
 *
 * Guarantees that at most one prompt request generation is active at any time
 * for a chat session view, and that cancelled, stopped, provider-switched,
 * conversation-switched, or superseded requests can never mutate visible UI
 * state, overwrite newer responses, trigger error banners, or auto-continue.
 */

import {
  normalizeAssistantMessage,
  updateActiveAlternativeInMessage
} from './alternativeResponseService.js';

/**
 * Creates a standardized AbortError instance across browser and Node runtimes.
 * @param {string} [message='Generation cancelled by user.']
 * @returns {Error}
 */
export function createAbortError(message = 'Generation cancelled by user.') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Determines whether an error or signal represents an intentional request abort.
 * @param {any} error
 * @param {AbortSignal | null} [signal=null]
 * @returns {boolean}
 */
export function isAbortLikeError(error, signal = null) {
  if (signal?.aborted) return true;
  if (!error) return false;
  if (error?.name === 'AbortError') return true;
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('aborted') ||
    msg.includes('generation cancelled by user') ||
    msg.includes('stopped by user')
  );
}

/**
 * Builds a finalized stopped assistant message preserving any partial streamed text
 * without appending unrevealed trailing buffer text after Stop.
 *
 * @param {Object | null} existingMessage
 * @param {Object} entry
 * @param {string | null} [overrideText=null]
 * @returns {Object}
 */
export function buildStoppedAssistantMessage(existingMessage, entry, overrideText = null) {
  const visiblePartial =
    typeof overrideText === 'string'
      ? overrideText
      : entry?.displayedText && entry.displayedText.trim().length > 0
        ? entry.displayedText
        : entry?.partialText || '';

  const stoppedContent =
    visiblePartial && visiblePartial.trim().length > 0
      ? visiblePartial
      : 'Response generation stopped.';

  const baseMessage = existingMessage || {
    id: entry?.assistantMessageId || `stopped-${Date.now()}`,
    sender: 'assistant',
    provider: entry?.finalProvider || entry?.provider || 'gemini',
    modelUsed: entry?.modelUsed || null,
    timestamp: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    }),
    content: stoppedContent,
    isStreaming: false,
    isStopped: true
  };

  const normalized = normalizeAssistantMessage(baseMessage);
  return updateActiveAlternativeInMessage(normalized, {
    content: stoppedContent,
    modelUsed: entry?.modelUsed || normalized.modelUsed || null,
    provider: entry?.finalProvider || entry?.provider || normalized.provider || 'gemini',
    isStreaming: false,
    isError: false,
    isStopped: true,
    referencedAttachments: undefined
  });
}

/**
 * Creates a monotonic request-isolation controller instance.
 * Each prompt execution receives a unique monotonic `requestId` and dedicated `AbortController`.
 */
export function createRequestIsolationController() {
  let sequence = 0;
  /** @type {any} */
  let activeEntry = null;

  /**
   * Internal helper to detach and abort an entry without mutating external UI directly.
   * @param {any} entry
   * @param {string} reason
   */
  function abortEntryInternal(entry, reason) {
    if (!entry || entry.cancelled) return entry;
    entry.cancelled = true;
    entry.cancelReason = reason;
    entry.stoppedByUser = reason === 'stopped';

    if (typeof entry.cancelAnimation === 'function') {
      try {
        entry.cancelAnimation();
      } catch (_) {}
      entry.cancelAnimation = null;
    }

    try {
      entry.controller.abort(createAbortError(`Request cancelled (${reason}).`));
    } catch (_) {
      try {
        entry.controller.abort();
      } catch (_ignore) {}
    }

    return entry;
  }

  return {
    /**
     * Allocates a new monotonic request token and AbortController, automatically
     * superseding and aborting any prior active request.
     *
     * @param {Object} [params]
     * @param {string | null} [params.chatId=null]
     * @param {string | null} [params.assistantMessageId=null]
     * @param {string | null} [params.provider=null]
     * @param {string | null} [params.modelUsed=null]
     * @param {'preflight' | 'streaming'} [params.phase='streaming']
     */
    beginRequest({
      chatId = null,
      assistantMessageId = null,
      provider = null,
      modelUsed = null,
      phase = 'streaming'
    } = {}) {
      if (activeEntry) {
        const previous = activeEntry;
        activeEntry = null;
        abortEntryInternal(previous, 'superseded');
      }

      const requestId = ++sequence;
      const controller = new AbortController();

      const entry = {
        requestId,
        chatId: chatId || null,
        assistantMessageId: assistantMessageId || null,
        provider: provider || null,
        finalProvider: provider || null,
        modelUsed: modelUsed || null,
        phase,
        controller,
        signal: controller.signal,
        cancelled: false,
        cancelReason: null,
        stoppedByUser: false,
        isFinalized: false,
        partialText: '',
        displayedText: '',
        cancelAnimation: null
      };

      activeEntry = entry;
      return entry;
    },

    /**
     * Promotes a preflight request (e.g. after attachment upload / chat doc creation)
     * into the streaming phase while preserving its monotonic requestId and AbortSignal.
     * Returns null if the preflight request was already cancelled or superseded.
     *
     * @param {number} requestId
     * @param {Object} target
     * @param {string | null} target.chatId
     * @param {string} target.assistantMessageId
     * @param {string} target.provider
     * @param {string | null} [target.modelUsed=null]
     */
    attachStreamTarget(requestId, { chatId, assistantMessageId, provider, modelUsed = null }) {
      if (
        !requestId ||
        !activeEntry ||
        activeEntry.requestId !== requestId ||
        activeEntry.cancelled ||
        activeEntry.controller.signal.aborted
      ) {
        return null;
      }

      activeEntry.phase = 'streaming';
      activeEntry.chatId = chatId || null;
      activeEntry.assistantMessageId = assistantMessageId;
      activeEntry.provider = provider || activeEntry.provider;
      activeEntry.finalProvider = provider || activeEntry.finalProvider;
      if (modelUsed !== undefined) {
        activeEntry.modelUsed = modelUsed;
      }
      return activeEntry;
    },

    /**
     * Returns true strictly when `requestId` is the current uncancelled active request.
     * @param {number | null | undefined} requestId
     * @returns {boolean}
     */
    isRequestActive(requestId) {
      return Boolean(
        requestId &&
          activeEntry &&
          activeEntry.requestId === requestId &&
          !activeEntry.cancelled &&
          !activeEntry.isFinalized &&
          !activeEntry.controller.signal.aborted
      );
    },

    /**
     * Returns true strictly when `requestId` is active AND `currentActiveChatId` matches `targetChatId`.
     * @param {number | null | undefined} requestId
     * @param {string | null} targetChatId
     * @param {string | null} currentActiveChatId
     * @returns {boolean}
     */
    canMutateChatUI(requestId, targetChatId, currentActiveChatId) {
      if (!this.isRequestActive(requestId)) return false;
      return currentActiveChatId === targetChatId;
    },

    /**
     * Registers an animation-pump cleanup callback for `requestId`.
     * If `requestId` is already inactive, invokes `cancelFn` immediately.
     * @param {number} requestId
     * @param {(() => void) | null} cancelFn
     */
    setAnimationCanceller(requestId, cancelFn) {
      if (!this.isRequestActive(requestId)) {
        if (typeof cancelFn === 'function') {
          try {
            cancelFn();
          } catch (_) {}
        }
        return;
      }
      activeEntry.cancelAnimation = cancelFn;
    },

    /**
     * Updates tracked partial/displayed text and model metadata for `requestId` if active.
     * @param {number} requestId
     * @param {Object} patch
     * @param {string} [patch.partialText]
     * @param {string} [patch.displayedText]
     * @param {string | null} [patch.modelUsed]
     * @param {string | null} [patch.finalProvider]
     * @returns {boolean}
     */
    recordProgress(requestId, patch = {}) {
      if (!this.isRequestActive(requestId)) return false;
      if (typeof patch.partialText === 'string') {
        activeEntry.partialText = patch.partialText;
      }
      if (typeof patch.displayedText === 'string') {
        activeEntry.displayedText = patch.displayedText;
      }
      if (patch.modelUsed) {
        activeEntry.modelUsed = patch.modelUsed;
      }
      if (patch.finalProvider) {
        activeEntry.finalProvider = patch.finalProvider;
      }
      return true;
    },

    /**
     * Atomically marks `requestId` finalized and clears it as the active request.
     * Returns true only for the single winning finalizer of the currently active request.
     * @param {number} requestId
     * @returns {boolean}
     */
    markFinalized(requestId) {
      if (!this.isRequestActive(requestId)) {
        return false;
      }
      const entry = activeEntry;
      activeEntry = null;
      entry.isFinalized = true;
      entry.cancelAnimation = null;
      return true;
    },

    /**
     * Cancels and detaches the currently active request (if any) with an explicit reason.
     * @param {'stopped' | 'superseded' | 'provider_switched' | 'conversation_switched' | 'unmounted'} [reason='stopped']
     */
    cancelActiveRequest(reason = 'stopped') {
      if (!activeEntry) return null;
      const entry = activeEntry;
      activeEntry = null;
      return abortEntryInternal(entry, reason);
    },

    /**
     * @returns {boolean}
     */
    hasActiveRequest() {
      return Boolean(
        activeEntry &&
          !activeEntry.cancelled &&
          !activeEntry.isFinalized &&
          !activeEntry.controller.signal.aborted
      );
    },

    /**
     * @returns {any}
     */
    getActiveRequest() {
      return activeEntry;
    },

    /**
     * Current monotonic counter (useful for diagnostics and tests).
     * @returns {number}
     */
    getCurrentSequence() {
      return sequence;
    }
  };
}

/**
 * Cancels the active request on `controller`, stops any local engine if needed,
 * deterministically finalizes the interrupted assistant message once (without
 * polluting any newly selected conversation), and resets loading state if idle.
 *
 * @param {ReturnType<typeof createRequestIsolationController>} controller
 * @param {'stopped' | 'superseded' | 'provider_switched' | 'conversation_switched' | 'unmounted'} reason
 * @param {Object} callbacks
 * @param {() => string | null} callbacks.getActiveChatId
 * @param {(updater: (prev: any[]) => any[]) => void} callbacks.onUpdateMessages
 * @param {(chatId: string, message: any, force?: boolean) => Promise<any> | void} [callbacks.onPersistMessage]
 * @param {(loading: boolean) => void} callbacks.onSetLoadingState
 * @param {(chatId: string | null, assistantMessageId: string) => any} [callbacks.findExistingAssistantMessage]
 * @param {() => void} [callbacks.stopLocalEngine]
 * @param {boolean} [callbacks.forceStopLocalEngine=false]
 */
export function cancelActiveChatRequest(controller, reason, callbacks) {
  const {
    getActiveChatId,
    onUpdateMessages,
    onPersistMessage,
    onSetLoadingState,
    findExistingAssistantMessage,
    stopLocalEngine,
    forceStopLocalEngine = false
  } = callbacks;

  const entry = controller.cancelActiveRequest(reason);

  if ((entry && entry.provider === 'webllm') || forceStopLocalEngine) {
    if (typeof stopLocalEngine === 'function') {
      try {
        stopLocalEngine();
      } catch (_) {}
    }
  }

  if (
    entry &&
    reason !== 'unmounted' &&
    entry.phase === 'streaming' &&
    entry.assistantMessageId &&
    !entry.isFinalized
  ) {
    entry.isFinalized = true;
    const currentVisibleChatId = getActiveChatId();
    const existingMsg = findExistingAssistantMessage
      ? findExistingAssistantMessage(entry.chatId, entry.assistantMessageId)
      : null;

    let finalizedStoppedMsg = buildStoppedAssistantMessage(existingMsg, entry);

    if (currentVisibleChatId === entry.chatId) {
      onUpdateMessages((previous) =>
        previous.map((msg) => {
          if (msg.id !== entry.assistantMessageId) return msg;
          finalizedStoppedMsg = buildStoppedAssistantMessage(msg, entry);
          return finalizedStoppedMsg;
        })
      );
    }

    if (entry.chatId && typeof onPersistMessage === 'function') {
      void Promise.resolve(onPersistMessage(entry.chatId, finalizedStoppedMsg, true)).catch(
        () => {}
      );
    }
  }

  if (reason !== 'unmounted' && !controller.hasActiveRequest()) {
    onSetLoadingState(false);
  }

  return entry;
}

/**
 * Executes a single isolated AI prompt stream, guaranteeing that every callback,
 * animation frame, completion, persistence call, error handler, and loading-flag
 * transition is strictly gated by `requestId` ownership and conversation identity.
 *
 * @param {Object} params
 * @param {ReturnType<typeof createRequestIsolationController>} params.controller
 * @param {number | null} [params.existingRequestId=null]
 * @param {string | null} params.targetChatId
 * @param {string} params.assistantMessageId
 * @param {string} params.providerToUse
 * @param {string | null} [params.effectiveModelOverride=null]
 * @param {string} params.promptText
 * @param {Array<any>} [params.currentAttachments=[]]
 * @param {number | null} [params.customStartTime=null]
 * @param {boolean} [params.prefersReducedMotion=false]
 * @param {() => string | null} params.getActiveChatId
 * @param {(updater: (prev: any[]) => any[]) => void} params.onUpdateMessages
 * @param {(chatId: string, message: any, force?: boolean) => Promise<any> | void} [params.onPersistMessage]
 * @param {(loading: boolean) => void} params.onSetLoadingState
 * @param {(errMsg: string | null) => void} [params.onSetPersistenceError]
 * @param {(chatId: string | null, assistantMessageId: string) => any} [params.findExistingAssistantMessage]
 * @param {(attachments: any[], ctx: { provider: string, model: string | null, signal: AbortSignal }) => Promise<any[]>} [params.prepareAttachments]
 * @param {(ctx: { signal: AbortSignal, isRequestActive: () => boolean, attachments: any[], onStart: (info?: any) => void, onChunk: (chunkText: string, accumulated: string) => void }) => Promise<any>} params.streamRequest
 * @param {(error: any, ctx: { finalProvider: string, providerToUse: string, activeModel: string | null, targetText: string, promptText: string }) => { friendlyMsg: string, effectiveProvider: string, canSwitchProvider: boolean }} params.classifyError
 */
export async function runIsolatedPromptStream({
  controller,
  existingRequestId = null,
  targetChatId,
  assistantMessageId,
  providerToUse,
  effectiveModelOverride = null,
  promptText,
  currentAttachments = [],
  customStartTime = null,
  prefersReducedMotion = false,
  getActiveChatId,
  onUpdateMessages,
  onPersistMessage,
  onSetLoadingState,
  onSetPersistenceError,
  findExistingAssistantMessage,
  prepareAttachments,
  streamRequest,
  classifyError
}) {
  const entry = existingRequestId
    ? controller.attachStreamTarget(existingRequestId, {
        chatId: targetChatId,
        assistantMessageId,
        provider: providerToUse,
        modelUsed: effectiveModelOverride
      })
    : controller.beginRequest({
        chatId: targetChatId,
        assistantMessageId,
        provider: providerToUse,
        modelUsed: effectiveModelOverride,
        phase: 'streaming'
      });

  // If a preflight request was cancelled or superseded before reaching stream phase, abort silently.
  if (!entry) {
    return { status: 'cancelled_before_stream', requestId: existingRequestId };
  }

  const requestId = entry.requestId;
  onSetLoadingState(true);

  const nowFn =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();

  const requestStartTime =
    typeof customStartTime === 'number' && customStartTime > 0 ? customStartTime : nowFn();
  let measuredResponseTimeMs = null;

  let targetText = '';
  let displayedText = '';
  let activeModel = effectiveModelOverride;
  let finalProvider = providerToUse;
  let isStreamDone = false;
  /** @type {any} */
  let timerId = null;
  let isCancelled = false;
  let isFinalized = false;

  /** @type {(() => void) | null} */
  let resolveDrainWait = null;

  const cancelCurrentAnimation = () => {
    isCancelled = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (resolveDrainWait) {
      const r = resolveDrainWait;
      resolveDrainWait = null;
      r();
    }
  };

  controller.setAnimationCanceller(requestId, cancelCurrentAnimation);

  const finalizeAssistantMessage = async (
    contentToSave,
    modelToUse,
    providerToFinalize,
    isStopped = false,
    responseTime = null
  ) => {
    if (isCancelled || isFinalized || !controller.isRequestActive(requestId)) {
      if (resolveDrainWait) {
        const r = resolveDrainWait;
        resolveDrainWait = null;
        r();
      }
      return;
    }

    if (!controller.markFinalized(requestId)) {
      if (resolveDrainWait) {
        const r = resolveDrainWait;
        resolveDrainWait = null;
        r();
      }
      return;
    }

    isFinalized = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    const finalResponseTime = !isStopped ? (responseTime ?? measuredResponseTimeMs) : null;
    const baseExisting = findExistingAssistantMessage
      ? findExistingAssistantMessage(targetChatId, assistantMessageId)
      : null;

    let completedMessage = updateActiveAlternativeInMessage(
      normalizeAssistantMessage(
        baseExisting || {
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
          responseTimeMs: typeof finalResponseTime === 'number' ? finalResponseTime : undefined
        }
      ),
      {
        content: contentToSave,
        modelUsed: modelToUse || activeModel || baseExisting?.modelUsed || null,
        provider: providerToFinalize || finalProvider || providerToUse || baseExisting?.provider,
        responseTimeMs:
          typeof finalResponseTime === 'number' ? finalResponseTime : baseExisting?.responseTimeMs,
        isStreaming: false,
        isStopped: Boolean(isStopped),
        referencedAttachments: undefined
      }
    );

    if (getActiveChatId() === targetChatId) {
      onUpdateMessages((previous) =>
        previous.map((message) => {
          if (message.id !== assistantMessageId) return message;
          const normalized = normalizeAssistantMessage(message);
          const finalized = updateActiveAlternativeInMessage(normalized, {
            content: contentToSave,
            modelUsed: modelToUse || activeModel || normalized.modelUsed,
            provider: providerToFinalize || finalProvider || providerToUse || normalized.provider,
            responseTimeMs:
              typeof finalResponseTime === 'number'
                ? finalResponseTime
                : normalized.responseTimeMs,
            isStreaming: false,
            isStopped: Boolean(isStopped),
            referencedAttachments: undefined
          });
          completedMessage = finalized;
          return finalized;
        })
      );
    }

    // Release loading state immediately once active request ownership is finalized
    // so subsequent requests started during async persistence are never clobbered.
    if (!controller.hasActiveRequest()) {
      onSetLoadingState(false);
    }

    if (targetChatId && typeof onPersistMessage === 'function') {
      await onPersistMessage(targetChatId, completedMessage, true);
    }

    if (resolveDrainWait) {
      const r = resolveDrainWait;
      resolveDrainWait = null;
      r();
    }
  };

  const pumpAnimation = () => {
    timerId = null;

    if (
      isCancelled ||
      isFinalized ||
      !controller.canMutateChatUI(requestId, targetChatId, getActiveChatId())
    ) {
      if (resolveDrainWait) {
        const r = resolveDrainWait;
        resolveDrainWait = null;
        r();
      }
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

      controller.recordProgress(requestId, {
        displayedText,
        modelUsed: activeModel,
        finalProvider
      });

      onUpdateMessages((previous) =>
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
    if (
      isCancelled ||
      isFinalized ||
      timerId !== null ||
      !controller.canMutateChatUI(requestId, targetChatId, getActiveChatId())
    ) {
      return;
    }
    timerId = setTimeout(pumpAnimation, 10);
  };

  if (controller.canMutateChatUI(requestId, targetChatId, getActiveChatId())) {
    onUpdateMessages((previous) =>
      previous.map((message) =>
        message.id === assistantMessageId
          ? { ...message, requestStartTime, isStreaming: true }
          : message
      )
    );
  }

  try {
    let requestAttachments = currentAttachments;
    if (typeof prepareAttachments === 'function') {
      requestAttachments = await prepareAttachments(currentAttachments, {
        provider: providerToUse,
        model: effectiveModelOverride,
        signal: entry.signal
      });
    }

    // Re-check ownership after async IndexedDB hydration before launching network stream
    if (!controller.isRequestActive(requestId)) {
      cancelCurrentAnimation();
      return { status: 'cancelled', requestId };
    }

    const result = await streamRequest({
      signal: entry.signal,
      isRequestActive: () => controller.isRequestActive(requestId),
      attachments: requestAttachments,
      onStart: ({ modelUsed, provider: reportedProvider } = {}) => {
        if (!controller.isRequestActive(requestId)) return;
        if (modelUsed) activeModel = modelUsed;
        if (reportedProvider) finalProvider = reportedProvider;
        controller.recordProgress(requestId, {
          modelUsed: activeModel,
          finalProvider
        });

        if (controller.canMutateChatUI(requestId, targetChatId, getActiveChatId())) {
          onUpdateMessages((previous) =>
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
        if (!controller.isRequestActive(requestId)) return;
        if (typeof currentAccumulated === 'string') {
          targetText = currentAccumulated;
        }
        controller.recordProgress(requestId, {
          partialText: targetText,
          modelUsed: activeModel,
          finalProvider
        });
        triggerPump();
      }
    });

    if (!controller.isRequestActive(requestId)) {
      cancelCurrentAnimation();
      return { status: 'cancelled', requestId };
    }

    measuredResponseTimeMs = Math.max(1, Math.round(nowFn() - requestStartTime));

    const resolvedText = typeof result?.text === 'string' ? result.text : targetText;
    targetText = resolvedText;

    if (result?.modelUsed) activeModel = result.modelUsed;
    if (result?.provider) finalProvider = result.provider;

    controller.recordProgress(requestId, {
      partialText: targetText,
      modelUsed: activeModel,
      finalProvider
    });

    isStreamDone = true;

    if (controller.canMutateChatUI(requestId, targetChatId, getActiveChatId())) {
      onUpdateMessages((previous) =>
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

    // If the user switched conversations without cancelling (defensive), persist to original chat only
    if (getActiveChatId() !== targetChatId) {
      cancelCurrentAnimation();
      if (!controller.markFinalized(requestId)) {
        return { status: 'cancelled', requestId };
      }

      const existingTargetMsg = findExistingAssistantMessage
        ? findExistingAssistantMessage(targetChatId, assistantMessageId)
        : null;

      const normalized = normalizeAssistantMessage(
        existingTargetMsg || {
          id: assistantMessageId,
          sender: 'assistant',
          provider: finalProvider || providerToUse,
          modelUsed: activeModel,
          content: resolvedText
        }
      );

      const completedMessage = updateActiveAlternativeInMessage(normalized, {
        content: resolvedText,
        modelUsed: activeModel,
        provider: finalProvider || providerToUse,
        isStreaming: false,
        responseTimeMs: measuredResponseTimeMs,
        referencedAttachments: undefined
      });

      if (!controller.hasActiveRequest()) {
        onSetLoadingState(false);
      }

      if (targetChatId && typeof onPersistMessage === 'function') {
        await onPersistMessage(targetChatId, completedMessage, true);
      }
      return { status: 'completed_background', requestId };
    }

    if (!prefersReducedMotion && displayedText.length < targetText.length) {
      await new Promise((resolve) => {
        resolveDrainWait = resolve;
        triggerPump();
        // Safety check if pump couldn't schedule because request became inactive
        if (timerId === null && !isFinalized) {
          resolveDrainWait = null;
          resolve(undefined);
        }
      });
    } else {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      displayedText = targetText;
      controller.recordProgress(requestId, { displayedText });
      await finalizeAssistantMessage(
        targetText,
        activeModel,
        finalProvider,
        false,
        measuredResponseTimeMs
      );
    }

    return { status: 'completed', requestId };
  } catch (error) {
    isStreamDone = true;
    cancelCurrentAnimation();

    // If this request was ALREADY cancelled/superseded via Stop, Provider Switch,
    // Conversation Switch, or a newer Request B, exit with ZERO side effects.
    if (!controller.isRequestActive(requestId)) {
      return { status: 'cancelled', requestId };
    }

    if (isAbortLikeError(error, entry.signal)) {
      if (!controller.markFinalized(requestId)) {
        return { status: 'cancelled', requestId };
      }

      const existingMsg = findExistingAssistantMessage
        ? findExistingAssistantMessage(targetChatId, assistantMessageId)
        : null;
      let stoppedMessage = buildStoppedAssistantMessage(existingMsg, entry);

      if (getActiveChatId() === targetChatId) {
        onUpdateMessages((previous) =>
          previous.map((message) => {
            if (message.id !== assistantMessageId) return message;
            stoppedMessage = buildStoppedAssistantMessage(message, entry);
            return stoppedMessage;
          })
        );
      }

      if (!controller.hasActiveRequest()) {
        onSetLoadingState(false);
      }

      if (targetChatId && typeof onPersistMessage === 'function') {
        await onPersistMessage(targetChatId, stoppedMessage, true);
      }

      return { status: 'stopped', requestId };
    }

    if (!controller.markFinalized(requestId)) {
      return { status: 'cancelled', requestId };
    }

    const { friendlyMsg, effectiveProvider, canSwitchProvider } = classifyError(error, {
      finalProvider,
      providerToUse,
      activeModel,
      targetText,
      promptText
    });

    const isInterrupted = targetText.trim().length > 0;
    const errorContent = isInterrupted
      ? `${targetText}\n\n*[Response interrupted: ${friendlyMsg}]*`
      : friendlyMsg;

    const existingMsg = findExistingAssistantMessage
      ? findExistingAssistantMessage(targetChatId, assistantMessageId)
      : null;

    let finalizedErrorMessage = updateActiveAlternativeInMessage(
      normalizeAssistantMessage(
        existingMsg || {
          id: assistantMessageId,
          sender: 'assistant',
          provider: effectiveProvider || finalProvider || providerToUse,
          modelUsed: activeModel,
          content: errorContent
        }
      ),
      {
        content: errorContent,
        modelUsed: activeModel || existingMsg?.modelUsed || null,
        provider: effectiveProvider || finalProvider || providerToUse || existingMsg?.provider,
        isStreaming: false,
        isError: !isInterrupted,
        isInterrupted,
        failedPrompt: promptText,
        failedProvider: effectiveProvider || finalProvider || providerToUse,
        canSwitchProvider,
        referencedAttachments: undefined
      }
    );

    if (getActiveChatId() === targetChatId) {
      onUpdateMessages((previous) =>
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
            canSwitchProvider,
            referencedAttachments: undefined
          });
          finalizedErrorMessage = updated;
          return updated;
        })
      );

      if (typeof onSetPersistenceError === 'function') {
        onSetPersistenceError(friendlyMsg);
      }
    }

    if (!controller.hasActiveRequest()) {
      onSetLoadingState(false);
    }

    if (targetChatId && typeof onPersistMessage === 'function') {
      await onPersistMessage(targetChatId, finalizedErrorMessage, true);
    }

    return { status: 'error', requestId, error };
  }
}
