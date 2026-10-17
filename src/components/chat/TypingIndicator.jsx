import React from 'react';
import { Bot } from 'lucide-react';

/**
 * TypingIndicator Component
 * Subtle loading state displayed while AI response is generating
 */
export default function TypingIndicator() {
  return (
    <div className="message-wrapper assistant-wrapper loading-wrapper" role="status" aria-label="Orvix is thinking">
      <div className="message-avatar assistant-avatar" aria-hidden="true">
        <Bot size={16} />
      </div>

      <div className="message-body assistant-body">
        <div className="message-sender-line">
          <span className="sender-name">Orvix</span>
          <span className="sender-status">thinking...</span>
        </div>

        <div className="typing-indicator-dots" aria-hidden="true">
          <span className="typing-dot dot-1" />
          <span className="typing-dot dot-2" />
          <span className="typing-dot dot-3" />
        </div>
      </div>
    </div>
  );
}
