import React, { useRef } from 'react';
import ChatMessage from './ChatMessage.jsx';
import TypingIndicator from './TypingIndicator.jsx';

/**
 * MessageList Component
 * Renders the sequence of user and AI messages with automatic scroll pinning,
 * error action callbacks, and assistant message controls (Copy, Regenerate, Stop).
 *
 * @param {Object} props
 * @param {Array} props.messages
 * @param {boolean} [props.isLoading=false]
 * @param {(failedMessage: Object) => void} [props.onRetry]
 * @param {(promptText: string) => void} [props.onRestorePrompt]
 * @param {(assistantMessage: Object) => void} [props.onRegenerate]
 * @param {() => void} [props.onStopGenerating]
 */
export default function MessageList({
  messages = [],
  isLoading = false,
  onRetry,
  onSwitchProvider,
  onRestorePrompt,
  onRegenerate,
  onStopGenerating,
  onEditResend,
  editingMessageId = null,
  onStartEdit,
  onCancelEdit,
  showTimestamps = true,
  selectedProvider = 'gemini'
}) {
  const bottomAnchorRef = useRef(null);

  const hasStreamingMessage = messages.some((m) => m.isStreaming);

  return (
    <div className="messages-stream" role="log" aria-live="polite">
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          message={msg}
          onRetry={onRetry}
          onSwitchProvider={onSwitchProvider}
          onRestorePrompt={onRestorePrompt}
          onRegenerate={onRegenerate}
          onStopGenerating={onStopGenerating}
          isLoading={isLoading}
          isEditing={editingMessageId === msg.id}
          onStartEdit={onStartEdit ? () => onStartEdit(msg.id) : undefined}
          onCancelEdit={onCancelEdit}
          onEditResend={onEditResend}
          showTimestamps={showTimestamps}
          selectedProvider={selectedProvider}
        />
      ))}

      {isLoading && !hasStreamingMessage && <TypingIndicator />}

      <div ref={bottomAnchorRef} className="messages-bottom-anchor" />
    </div>
  );
}
