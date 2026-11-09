import React, { useState, useMemo, useEffect } from 'react';
import {
  User,
  Copy,
  Check,
  AlertCircle,
  RotateCcw,
  Edit3,
  Square,
  Volume2,
  VolumeX,
  Cpu,
  Pause,
  Play,
  Paperclip,
  Timer,
  Share2,
  Loader2
} from 'lucide-react';
import Button from '../ui/Button.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';
import AttachmentCard from './AttachmentCard.jsx';
import ImageAttachmentCard from './ImageAttachmentCard.jsx';
import LiveResponseTimer from './LiveResponseTimer.jsx';
import MarkdownContent from './MarkdownContent.jsx';
import MessageErrorBox from './MessageErrorBox.jsx';
import UserInlineEditor from './UserInlineEditor.jsx';
import AlternativeResponseNav from './AlternativeResponseNav.jsx';
import GeneratedImageCard from './GeneratedImageCard.jsx';
import { isImageAttachment } from '../../services/documentContextService.js';
import { useSpeech } from '../../context/SpeechContext.jsx';
import { PROVIDER_OPTIONS } from '../../services/aiRouter.js';
import { formatResponseTime, formatLiveElapsed } from '../../utils/formatResponseTime.js';
export { formatLiveElapsed };
import { getAlternativeMetrics, getActiveAlternative } from '../../services/alternativeResponseService.js';
import { copyFormattedMessage } from '../../utils/clipboardFormatter.js';
import { filterAvailableFallbackProviders } from '../../services/providerModelSanitizer.js';

/**
 * ChatMessage Component
 * Visually distinct user and AI messages with Markdown & Code rendering,
 * error handling, and assistant message controls: Copy, Regenerate, Speech, and Alternatives.
 */
function ChatMessage({
  message,
  onRetry,
  onSwitchProvider,
  onRestorePrompt,
  onRegenerate,
  onGenerateAlternative,
  onSwitchAlternative,
  onStopGenerating,
  isLoading = false,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onEditResend,
  showTimestamps = true,
  selectedProvider = 'gemini',
  activeMode = 'general',
  providerConfig = null,
  onShareChat,
  canShareChat = false,
  shareChatDisabledReason = '',
  isSharingChat = false,
  isReadOnly = false
}) {
  const effectiveMode = message?.mode || activeMode || 'general';
  const isUser = message?.sender === 'user';
  const isError = Boolean(message?.isError);
  const isStreaming = Boolean(message?.isStreaming);
  const isStopped = Boolean(message?.isStopped);
  const hasContent = Boolean(message?.content && message.content.length > 0);

  const altMetrics = useMemo(() => getAlternativeMetrics(message), [message]);

  const {
    isSupported: isSpeechSupported,
    speakingState,
    currentMessageId,
    speechError,
    playMessage,
    pauseSpeech,
    resumeSpeech,
    stopSpeech,
    resetMessageSpeech,
    hasSavedPosition
  } = useSpeech();

  const isCurrentActive = Boolean(message?.id && currentMessageId === message.id);
  const isSpeakingThis = isCurrentActive && (speakingState === 'speaking' || speakingState === 'playing');
  const isCurrentSpeaking = isSpeakingThis;
  const isPausedThis = isCurrentActive && speakingState === 'paused';
  const isCompletedThis = isCurrentActive && speakingState === 'completed';
  const isErrorThis = isCurrentActive && speakingState === 'error';
  const hasSavedThis = Boolean(message?.id && hasSavedPosition(message.id));
  const isResumableThis = isPausedThis || (!isCurrentActive && hasSavedThis);

  const handleStartSpeech = () => {
    if (!hasContent || !message?.content || !message?.id) return;
    playMessage(message.id, message.content, false);
  };

  const handlePauseSpeech = () => {
    pauseSpeech();
  };

  const handleResumeSpeech = () => {
    if (!hasContent || !message?.content || !message?.id) return;
    if (isPausedThis) {
      resumeSpeech();
    } else {
      playMessage(message.id, message.content, false);
    }
  };

  const handleStopSpeech = () => {
    if (!message?.id) return;
    if (isCurrentActive) {
      stopSpeech(false);
    } else {
      resetMessageSpeech(message.id);
    }
  };

  const handleResetSpeech = () => {
    if (!message?.id) return;
    resetMessageSpeech(message.id);
  };

  // Safely pause speech if this message is unmounted while speaking
  useEffect(() => {
    return () => {
      if (isSpeakingThis) {
        pauseSpeech();
      }
    };
  }, [isSpeakingThis, pauseSpeech]);

  const activeAlt = useMemo(() => {
    if (!message) return null;
    return getActiveAlternative(message);
  }, [message]);

  const currentProviderId = message.failedProvider || activeAlt?.provider || message.provider || selectedProvider;
  const currentProviderObj =
    PROVIDER_OPTIONS.find((p) => p.id === currentProviderId) || {
      id: currentProviderId,
      name: currentProviderId.charAt(0).toUpperCase() + currentProviderId.slice(1)
    };
  const fallbackProviders = useMemo(() => {
    const filtered = filterAvailableFallbackProviders(
      PROVIDER_OPTIONS,
      currentProviderId,
      providerConfig
    );
    if (Array.isArray(message?.suggestedProviders) && message.suggestedProviders.length > 0) {
      const suggestedSet = new Set(message.suggestedProviders.map((id) => String(id).toLowerCase()));
      const matchingSuggested = filtered.filter((p) => suggestedSet.has(p.id));
      if (matchingSuggested.length > 0) {
        return matchingSuggested;
      }
    }
    return filtered;
  }, [currentProviderId, providerConfig, message?.suggestedProviders]);

  const activeAlternativeModelName = useMemo(() => {
    if (activeAlt?.modelUsed) return activeAlt.modelUsed;
    if (message?.modelUsed) return message.modelUsed;
    return currentProviderObj?.name || 'AI Model';
  }, [activeAlt, message?.modelUsed, currentProviderObj]);

  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('Copy');

  const formattedResponseTime = useMemo(
    () =>
      !isUser && !isError && !isStopped && !message?.isInterrupted && typeof message?.responseTimeMs === 'number'
        ? formatResponseTime(message?.responseTimeMs)
        : null,
    [isUser, isError, isStopped, message?.isInterrupted, message?.responseTimeMs]
  );

  const handleCopyMessage = async () => {
    if (!message?.content) return;

    try {
      const success = await copyFormattedMessage(message.content);
      if (success) {
        setCopied(true);
        setCopyFeedback('Copied');
        setTimeout(() => {
          setCopied(false);
          setCopyFeedback('Copy');
        }, 2000);
        return;
      }
      throw new Error('All clipboard writing strategies failed');
    } catch (err) {
      console.warn('Clipboard write failed:', err);
      setCopyFeedback('Failed to copy');
      setTimeout(() => setCopyFeedback('Copy'), 2500);
    }
  };

  if (!message) return null;

  return (
    <article
      className={`message-wrapper ${isUser ? 'user-wrapper' : 'assistant-wrapper'} ${isError ? 'error-wrapper' : ''} ${isStreaming ? 'streaming-wrapper' : ''} ${isStopped ? 'stopped-wrapper' : ''} ${isEditing ? 'is-editing' : ''} ${isCurrentSpeaking ? 'is-speaking-message' : ''}`}
      aria-label={`${isUser ? 'User' : 'Orvix AI'} message`}
    >
      <div
        className={`message-avatar ${isUser ? 'user-avatar' : 'assistant-avatar'} ${isError ? 'error-avatar' : ''}`}
        aria-hidden="true"
      >
        {isUser ? <User size={16} /> : isError ? <AlertCircle size={16} /> : <OrvixLogo size={18} />}
      </div>

      <div className={`message-body ${isUser ? 'user-body' : 'assistant-body'} ${isError ? 'error-body' : ''}`}>
        <div className="message-sender-line">
          <span className="sender-name">{isUser ? 'You' : 'Orvix'}</span>

          {isStreaming && !hasContent && (
            <span className="sender-status">thinking...</span>
          )}

          {isStopped && (
            <span className="message-stopped-badge" title="Response generation stopped">
              Stopped
            </span>
          )}

          {isCurrentActive && (isSpeakingThis || isPausedThis || isErrorThis) && (
            <span
              className={`message-speaking-badge ${isSpeakingThis ? 'playing' : isPausedThis ? 'paused' : 'error'}`}
              role="status"
              aria-label={
                isSpeakingThis
                  ? 'Currently reading aloud'
                  : isPausedThis
                  ? 'Speech playback paused'
                  : 'Speech playback error'
              }
            >
              {isSpeakingThis ? (
                <Volume2 size={11} className="speaking-badge-icon pulse" />
              ) : isPausedThis ? (
                <Pause size={11} />
              ) : (
                <AlertCircle size={11} />
              )}
              <span>
                {isSpeakingThis
                  ? 'Reading Aloud'
                  : isPausedThis
                  ? 'Speech Paused'
                  : 'Speech Error'}
              </span>
            </span>
          )}

          {message.modelUsed && (
            <span
              className="model-badge"
              title={`Model: ${message.modelUsed}${message.provider ? ` • Provider: ${message.provider}` : ''}`}
            >
              {message.provider === 'webllm'
                ? 'Browser AI: '
                : message.provider
                  ? `${message.provider.charAt(0).toUpperCase() + message.provider.slice(1)}: `
                  : ''}
              {message.modelUsed}
            </span>
          )}

          {/* Response Time Badge */}
          {!isUser && !isError && !isStopped && !message?.isInterrupted && (
            <>
              {isStreaming && !message?.responseTimeMs && typeof message?.requestStartTime === 'number' && (
                <LiveResponseTimer
                  startTime={message.requestStartTime}
                  isLocalGpu={currentProviderId === 'webllm'}
                />
              )}
              {formattedResponseTime && (
                <span
                  className="response-time-badge"
                  title={`Response time: ${formattedResponseTime}`}
                  aria-label={`Response time: ${formattedResponseTime}`}
                >
                  <Timer size={11} className="response-time-icon" aria-hidden="true" />
                  <span>Response time: {formattedResponseTime}</span>
                </span>
              )}
            </>
          )}

          {showTimestamps && message.timestamp && (
            <span className="message-timestamp">{message.timestamp}</span>
          )}
        </div>

        <div className="message-content">
          {isError ? (
            <MessageErrorBox
              message={message}
              currentProviderId={currentProviderId}
              currentProviderObj={currentProviderObj}
              fallbackProviders={fallbackProviders}
              onRetry={onRetry}
              onSwitchProvider={onSwitchProvider}
              onRestorePrompt={onRestorePrompt}
            />
          ) : isUser ? (
            isEditing ? (
              <UserInlineEditor
                messageId={message.id}
                initialContent={message.content || ''}
                isLoading={isLoading}
                onCancelEdit={onCancelEdit}
                onEditResend={onEditResend}
              />
            ) : (
              <div className="user-message-content-wrapper">
                {(() => {
                  const allAtts = Array.isArray(message.attachments) ? message.attachments : [];
                  const imageAtts = allAtts.filter(isImageAttachment);
                  const docAtts = allAtts.filter((a) => !isImageAttachment(a));

                  return (
                    <>
                      {imageAtts.length > 0 && (
                        <div
                          className={`message-image-attachments-grid ${imageAtts.length > 1 ? 'is-multi' : 'is-single'}`}
                          role="group"
                          aria-label="Attached images"
                        >
                          {imageAtts.map((att, idx) => (
                            <ImageAttachmentCard
                              key={att.id || idx}
                              attachment={{
                                ...att,
                                chatId: att.chatId || att.conversationId || message.conversationId || message.chatId,
                                conversationId: att.conversationId || att.chatId || message.conversationId || message.chatId
                              }}
                            />
                          ))}
                        </div>
                      )}
                      {docAtts.length > 0 && (
                        <div className="message-attachments-list" role="region" aria-label="Attached documents">
                          {docAtts.map((att, idx) => (
                            <AttachmentCard
                              key={att.id || idx}
                              attachment={{
                                ...att,
                                chatId: att.chatId || att.conversationId || message.conversationId || message.chatId,
                                conversationId: att.conversationId || att.chatId || message.conversationId || message.chatId
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
                {message.content ? (
                  <p className="user-text-content">{message.content}</p>
                ) : null}
              </div>
            )
          ) : (
            <div className={`ai-markdown-container mode-${effectiveMode} ${isStreaming ? 'is-streaming' : ''}`}>
              {message.referencedAttachments && message.referencedAttachments.length > 0 && (
                <div className="assistant-referenced-attachments" aria-label="Referenced files">
                  <div className="referenced-attachments-header">
                    <Paperclip size={11} className="referenced-icon" />
                    <span>Referenced file{message.referencedAttachments.length > 1 ? 's' : ''}:</span>
                  </div>
                  <div className="referenced-attachments-list">
                    {message.referencedAttachments.map((att, idx) => (
                      <AttachmentCard
                        key={att.id || idx}
                        attachment={{
                          ...att,
                          chatId: att.chatId || att.conversationId || message.conversationId || message.chatId,
                          conversationId: att.conversationId || att.chatId || message.conversationId || message.chatId
                        }}
                        compact={true}
                      />
                    ))}
                  </div>
                </div>
              )}

              {message.isImageGeneration || message.imageResult ? (
                <GeneratedImageCard
                  imageResult={message.imageResult}
                  prompt={message.prompt || message.imagePrompt || message.content}
                  status={message.imageStatus || (message.isError ? 'error' : (message.isGenerating || isStreaming) ? 'generating' : 'ready')}
                  error={message.error || message.errorMessage}
                  provider={message.provider}
                  model={message.modelUsed || message.model}
                  aspectRatio={message.aspectRatio}
                  elapsedSec={message.elapsedSec || 0}
                  onRetry={onRetry ? () => onRetry(message) : null}
                />
              ) : isStreaming && !hasContent ? (
                <div className="streaming-thinking-state" role="status" aria-label="Thinking">
                  <span className="typing-dot dot-1" />
                  <span className="typing-dot dot-2" />
                  <span className="typing-dot dot-3" />
                </div>
              ) : (
                <MarkdownContent
                  content={message.content || ''}
                  isStreaming={isStreaming}
                  effectiveMode={effectiveMode}
                />
              )}

              {message.isInterrupted && message.failedPrompt && (
                <div className="interrupted-retry-actions" role="group" aria-label="Interrupted response recovery options">
                  {onRetry && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRetry(message)}
                      icon={<RotateCcw size={13} />}
                      title={`Retry this request with ${currentProviderObj.name}`}
                      className="error-action-btn error-retry-btn"
                    >
                      Retry with {currentProviderObj.name}
                    </Button>
                  )}
                  {onSwitchProvider &&
                    fallbackProviders.map((p) => (
                      <Button
                        key={p.id}
                        variant="secondary"
                        size="sm"
                        onClick={() => onSwitchProvider(message, p.id)}
                        icon={<Cpu size={13} />}
                        title={`Switch to ${p.name} and send prompt`}
                        className="fallback-provider-btn error-action-btn error-fallback-btn"
                      >
                        Try with {p.name}
                      </Button>
                    ))}
                  {onRestorePrompt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRestorePrompt(message.failedPrompt)}
                      icon={<Edit3 size={13} />}
                      title="Restore prompt into composer"
                      className="error-action-btn error-restore-btn"
                    >
                      Edit prompt
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* User Message Actions: Copy, Edit and Resend */}
        {isUser && !isEditing && !isError && (
          <div className="message-action-bar user-action-bar">
            {hasContent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyMessage}
                className={`message-action-btn ${copied ? 'copied' : ''}`}
                title="Copy message"
                ariaLabel="Copy message text"
                icon={copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              >
                {copyFeedback}
              </Button>
            )}

            {onStartEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onStartEdit(message.id)}
                disabled={isLoading || isReadOnly}
                className="message-action-btn edit-message-btn"
                title={
                  isReadOnly
                    ? 'This is a read-only shared conversation.'
                    : isLoading
                    ? 'Generation in progress...'
                    : 'Edit and resend this message'
                }
                ariaLabel="Edit message"
                icon={<Edit3 size={13} />}
              >
                Edit
              </Button>
            )}
          </div>
        )}

        {/* Assistant Message Actions: Copy, Speech, Regenerate, Alternatives, Share */}
        {!isUser && !isError && (
          <div className="message-action-bar">
            {isStreaming ? (
              onStopGenerating && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onStopGenerating}
                  className="message-action-btn stop-generating-btn"
                  title="Stop generating response (Esc)"
                  ariaLabel="Stop generating response"
                  icon={<Square size={11} fill="currentColor" />}
                >
                  Stop
                </Button>
              )
            ) : (
              <>
                {/* Copy Response Button */}
                {hasContent && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyMessage}
                    className={`message-action-btn ${copied ? 'copied' : ''}`}
                    title="Copy response text"
                    ariaLabel="Copy response text"
                    icon={copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  >
                    {copyFeedback}
                  </Button>
                )}

                {/* Speech Controls */}
                {hasContent && (
                  <div className="read-aloud-active-controls inline-flex items-center gap-1.5">
                    {isSpeakingThis ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handlePauseSpeech}
                          className="message-action-btn speech-pause-btn active"
                          title="Pause reading aloud"
                          ariaLabel="Pause reading message aloud"
                          icon={<Pause size={12} />}
                        >
                          Pause
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleStopSpeech}
                          className="message-action-btn speech-stop-btn"
                          title="Stop reading and reset to beginning"
                          ariaLabel="Stop reading and reset to beginning"
                          icon={<Square size={11} fill="currentColor" />}
                        >
                          Stop
                        </Button>

                        <span className="speech-soundwave-mini" aria-hidden="true" title="Reading aloud">
                          <span className="mini-wave-bar bar-1" />
                          <span className="mini-wave-bar bar-2" />
                          <span className="mini-wave-bar bar-3" />
                        </span>
                      </>
                    ) : isResumableThis ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleResumeSpeech}
                          disabled={!isSpeechSupported}
                          className="message-action-btn speech-resume-btn"
                          title="Resume reading from paused position"
                          ariaLabel="Resume reading message aloud"
                          icon={<Play size={12} fill="currentColor" />}
                        >
                          Resume
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleStopSpeech}
                          disabled={!isSpeechSupported}
                          className="message-action-btn speech-stop-btn"
                          title="Stop reading and reset to beginning"
                          ariaLabel="Stop reading and reset to beginning"
                          icon={<Square size={11} fill="currentColor" />}
                        >
                          Stop
                        </Button>
                      </>
                    ) : isErrorThis ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleStartSpeech}
                          className="message-action-btn"
                          title="Retry reading aloud"
                          ariaLabel="Retry reading aloud"
                          icon={<RotateCcw size={12} />}
                        >
                          Retry
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleResetSpeech}
                          className="message-action-btn speech-stop-btn"
                          title="Dismiss speech error"
                          ariaLabel="Dismiss speech error"
                          icon={<Square size={11} fill="currentColor" />}
                        >
                          Dismiss
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleStartSpeech}
                        disabled={!isSpeechSupported}
                        className="message-action-btn read-aloud-btn"
                        title={
                          !isSpeechSupported
                            ? 'Read aloud is not supported in this browser'
                            : 'Read aloud'
                        }
                        ariaLabel={
                          !isSpeechSupported
                            ? 'Read aloud not supported'
                            : 'Read message aloud'
                        }
                        icon={
                          !isSpeechSupported ? (
                            <VolumeX size={13} />
                          ) : (
                            <Volume2 size={13} />
                          )
                        }
                      >
                        Read aloud
                      </Button>
                    )}
                  </div>
                )}

                {/* Regenerate Response Button */}
                {onRegenerate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (isReadOnly) return;
                      if (isCurrentSpeaking) stopSpeech(false);
                      if (message?.id) resetMessageSpeech(message.id);
                      onRegenerate(message);
                    }}
                    disabled={isLoading || isReadOnly}
                    className="message-action-btn regenerate-btn"
                    title={
                      isReadOnly
                        ? 'This is a read-only shared conversation.'
                        : isLoading
                        ? 'Generation in progress...'
                        : 'Regenerate response'
                    }
                    ariaLabel="Regenerate response"
                    icon={<RotateCcw size={13} />}
                  >
                    Regenerate
                  </Button>
                )}

                {/* Alternative Responses Navigation and Multi-model Regeneration */}
                <AlternativeResponseNav
                  message={message}
                  altMetrics={altMetrics}
                  activeAlternativeModelName={activeAlternativeModelName}
                  selectableModels={PROVIDER_OPTIONS}
                  currentProviderId={currentProviderId}
                  providerConfig={providerConfig}
                  isLoading={isLoading}
                  isReadOnly={isReadOnly}
                  onSwitchAlternative={onSwitchAlternative}
                  onGenerateAlternative={onGenerateAlternative}
                />

                {/* Share Chat Action */}
                {onShareChat && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (isReadOnly) return;
                      onShareChat(message);
                    }}
                    disabled={isLoading || isSharingChat || !canShareChat || isReadOnly}
                    className={`message-action-btn share-chat-btn ${isSharingChat ? 'is-sharing' : ''}`}
                    title={
                      isReadOnly
                        ? 'Shared conversation previews cannot be re-shared.'
                        : isSharingChat
                        ? 'Creating share link...'
                        : !canShareChat && shareChatDisabledReason
                        ? shareChatDisabledReason
                        : isLoading
                        ? 'Generation in progress...'
                        : 'Share entire conversation'
                    }
                    ariaLabel={
                      isSharingChat
                        ? 'Creating share link'
                        : 'Share Chat'
                    }
                    icon={
                      isSharingChat ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Share2 size={13} />
                      )
                    }
                  >
                    {isSharingChat ? 'Sharing...' : 'Share Chat'}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default React.memo(ChatMessage);
