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

  useEffect(() => {
    if (bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, isLoading]);

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

      {isLoading && <TypingIndicator />}

      <div ref={bottomAnchorRef} className="messages-bottom-anchor" />
    </div>
  );
}
