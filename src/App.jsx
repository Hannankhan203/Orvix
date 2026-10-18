import React from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { SettingsProvider } from './context/SettingsContext.jsx';
import SettingsModal from './components/settings/SettingsModal.jsx';
import AuthScreen from './components/auth/AuthScreen.jsx';
import ChatPage from './pages/ChatPage.jsx';
import { Bot } from 'lucide-react';
import { APP_CONFIG } from './config/appConfig.js';

/**
 * Splash screen displayed during initial Firebase authentication state check
 */
function AuthLoadingSplash() {
  return (
    <div className="auth-splash-screen" role="status" aria-label="Loading Orvix">
      <div className="auth-splash-content">
        <div className="auth-splash-icon">
          <Bot size={32} />
        </div>
        <h2 className="auth-splash-title">{APP_CONFIG.name}</h2>
        <div className="auth-splash-spinner" aria-hidden="true" />
        <p className="auth-splash-text">Verifying authentication...</p>
      </div>
    </div>
  );
}

/**
 * Main application router / gatekeeper
 */
function AppContent() {
  const { currentUser, initialLoading } = useAuth();

  // Show loading splash while verifying persistent auth state
  if (initialLoading) {
    return <AuthLoadingSplash />;
  }

  // Protected experience: Unauthenticated users are directed to the login/signup screen
  if (!currentUser) {
    return <AuthScreen />;
  }

  // Authenticated users access the full Orvix chatbot interface
  return <ChatPage />;
}

/**
 * Root Application Component
 */
export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <AppContent />
        <SettingsModal />
      </SettingsProvider>
    </AuthProvider>
  );
}
