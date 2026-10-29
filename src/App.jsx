import React, { lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { SettingsProvider, useSettings } from './context/SettingsContext.jsx';
import { Bot } from 'lucide-react';
import { APP_CONFIG } from './config/appConfig.js';
import { SpeechProvider } from './context/SpeechContext.jsx';

const SettingsModal = lazy(() => import('./components/settings/SettingsModal.jsx'));
const AuthScreen = lazy(() => import('./components/auth/AuthScreen.jsx'));
const ChatPage = lazy(() => import('./pages/ChatPage.jsx'));

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
    return (
      <Suspense fallback={<AuthLoadingSplash />}>
        <AuthScreen />
      </Suspense>
    );
  }

  // Authenticated users access the full Orvix chatbot interface
  return (
    <Suspense fallback={<AuthLoadingSplash />}>
      <ChatPage />
    </Suspense>
  );
}

/**
 * Lazy settings modal wrapper: only mounts Suspense when modal is open
 */
function LazySettingsModal() {
  const { isSettingsModalOpen } = useSettings();
  if (!isSettingsModalOpen) return null;

  return (
    <Suspense fallback={null}>
      <SettingsModal />
    </Suspense>
  );
}

/**
 * Root Application Component
 */
export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <SpeechProvider>
          <AppContent />
          <LazySettingsModal />
        </SpeechProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
