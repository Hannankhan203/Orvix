import React from 'react';
import OrvixLogo from '../ui/OrvixLogo.jsx';

/**
 * WelcomeScreen Component
 * Displays the refined empty state with the Orvix logo and personalized greeting.
 * Serves as an intentional, polished centerpiece across all screen sizes.
 *
 * @param {Object} props
 * @param {string|null} [props.username=null]
 */
export default function WelcomeScreen({ username = null }) {
  const cleanName =
    typeof username === 'string' &&
    username.trim() &&
    username !== 'Guest Explorer' &&
    !username.startsWith('guest-')
      ? username.trim()
      : null;

  return (
    <div className="welcome-screen" role="region" aria-label="Welcome screen">
      <div className="welcome-hero">
        <div className="welcome-logo-wrap" aria-hidden="true">
          <OrvixLogo size="100%" className="welcome-hero-logo" />
        </div>

        <h1 className="welcome-heading">
          {cleanName ? `What can I help you with, ${cleanName}?` : 'What can I help you with today?'}
        </h1>
      </div>
    </div>
  );
}
