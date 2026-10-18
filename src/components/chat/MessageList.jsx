import React, { useEffect, useRef } from 'react';
import ChatMessage from './ChatMessage.jsx';
import TypingIndicator from './TypingIndicator.jsx';

/**
 * MessageList Component
 * Renders the sequence of user and AI messages with automatic scroll pinning
 * and error action callbacks.
 *
 * @param {Object} props
 * @param {Array} props.messages
 * @param {boolean} [props.isLoading=false]
 * @param {(failedMessage: Object) => void} [props.onRetry]
 * @param {(promptText: string) => void} [props.onRestorePrompt]
 */
export default function MessageList({
  messages = [],
  isLoading = false,
  onRetry,
  onRestorePrompt
}) {
  const bottomAnchorRef = useRef(null);
  const prevMessagesLengthRef = useRef(messages.length);

  useEffect(() => {
    if (!bottomAnchorRef.current) return;

    const scrollContainer = bottomAnchorRef.current.closest('.chat-scroll-viewport');
    const isNewMessage = messages.length > prevMessagesLengthRef.current;
    prevMessagesLengthRef.current = messages.length;

    if (!scrollContainer) {
      bottomAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
      return;
    }

    // Check if user is near the bottom (within 140px threshold)
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    const isNearBottom = distanceFromBottom < 140;

    // Auto-scroll if new message was sent, or if user is actively following near bottom.
    // Preserves position if user deliberately scrolled up to read earlier content.
    if (isNewMessage || isNearBottom) {
      bottomAnchorRef.current.scrollIntoView({ behavior: isNewMessage ? 'smooth' : 'auto', block: 'end' });
    }
  }, [messages, isLoading]);

  const hasStreamingMessage = messages.some((m) => m.isStreaming);

  return (
    <div className="messages-stream" role="log" aria-live="polite">
      {messages.map((msg) => (
        <ChatMessage
          key={msg.id}
          message={msg}
          onRetry={onRetry}
          onRestorePrompt={onRestorePrompt}
        />
      ))}

      {isLoading && !hasStreamingMessage && <TypingIndicator />}

      <div ref={bottomAnchorRef} className="messages-bottom-anchor" />
    </div>
  );
}
