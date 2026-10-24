import React from 'react';
import OrvixLogo from '../ui/OrvixLogo.jsx';

/**
 * TypingIndicator Component
 * Subtle loading state displayed while AI response is generating
 */
export default function TypingIndicator() {
  return (
    <div className="message-wrapper assistant-wrapper loading-wrapper" role="status" aria-label="Orvix is thinking">
      <div className="message-avatar assistant-avatar" aria-hidden="true">
        <OrvixLogo size={18} />
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
