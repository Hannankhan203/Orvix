import React, { lazy, Suspense, useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { SettingsProvider, useSettings } from './context/SettingsContext.jsx';
import { Bot } from 'lucide-react';
import { APP_CONFIG } from './config/appConfig.js';
import { SpeechProvider } from './context/SpeechContext.jsx';
import { getShareRouteDetails } from './services/shareChatService.js';

const SettingsModal = lazy(() => import('./components/settings/SettingsModal.jsx'));
const AuthScreen = lazy(() => import('./components/auth/AuthScreen.jsx'));
const ChatPage = lazy(() => import('./pages/ChatPage.jsx'));

/**
 * Global navigation helper to change URL and notify router listeners
 */
export function navigateTo(url) {
  if (typeof window === 'undefined') return;
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

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
  const [routeInfo, setRouteInfo] = useState(() =>
    typeof window !== 'undefined'
      ? getShareRouteDetails(window.location.pathname)
      : { isShareRoute: false, shareId: null, isValid: false, isMalformed: false }
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleLocationChange = () => {
      setRouteInfo(getShareRouteDetails(window.location.pathname));
    };

    window.addEventListener('popstate', handleLocationChange);
    return () => window.removeEventListener('popstate', handleLocationChange);
  }, []);

  // Show loading splash while verifying persistent auth state
  if (initialLoading) {
    return <AuthLoadingSplash />;
  }

  // Public Shared Route (/share/{shareId}):
  // Accessible to visitors who are not logged in, logged out, or authenticated.
  // Never forces unauthenticated visitors to login screen before reading.
  if (routeInfo.isShareRoute) {
    return (
      <Suspense fallback={<AuthLoadingSplash />}>
        <ChatPage
          isSharedView={true}
          sharedShareId={routeInfo.shareId}
          rawShareId={routeInfo.rawShareId}
          isMalformedShareId={routeInfo.isMalformed}
          onNavigateHome={() => navigateTo('/')}
        />
      </Suspense>
    );
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
