import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  signupWithEmail,
  loginWithEmail,
  logout as authLogout,
  onAuthChange,
  formatAuthError
} from '../services/authService.js';
import { isFirebaseConfigured } from '../config/firebaseConfig.js';

const AuthContext = createContext(null);

/**
 * Custom hook to consume the AuthContext
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

/**
 * AuthProvider Component
 * Manages the authenticated user state, loading states, and auth actions.
 */
export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);

  const isConfigured = isFirebaseConfigured();

  // Subscribe to Firebase Auth state listener and clean up on unmount
  useEffect(() => {
    // Check if guest mode session was active
    try {
      const savedGuest =
        sessionStorage.getItem('orvix_guest_session') ||
        sessionStorage.getItem('chatora_guest_session');
      if (savedGuest) {
        setCurrentUser(JSON.parse(savedGuest));
        setInitialLoading(false);
        return;
      }
    } catch (_) {}

    const unsubscribe = onAuthChange((user) => {
      if (user) {
        try {
          sessionStorage.removeItem('orvix_guest_session');
          sessionStorage.removeItem('chatora_guest_session');
        } catch (_) {}
      }
      setCurrentUser(user);
      setInitialLoading(false);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const clearError = () => setError(null);

  /**
   * Enter guest / demo mode without requiring Firebase credentials
   */
  const continueAsGuest = () => {
    const guestUser = {
      uid: 'guest-' + Math.random().toString(36).substring(2, 9),
      email: 'guest@orvix.ai',
      displayName: 'Guest Explorer',
      isAnonymous: true
    };
    setCurrentUser(guestUser);
    try {
      sessionStorage.setItem('chatora_guest_session', JSON.stringify(guestUser));
      sessionStorage.setItem('orvix_guest_session', JSON.stringify(guestUser));
    } catch (_) {}
  };

  /**
   * Register a new user
   * @param {string} email
   * @param {string} password
   */
  const signup = async (email, password) => {
    setError(null);
    setActionLoading(true);
    try {
      const userCredential = await signupWithEmail(email, password);
      return userCredential.user;
    } catch (err) {
      const formatted = formatAuthError(err);
      setError(formatted);
      throw new Error(formatted);
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Log in an existing user
   * @param {string} email
   * @param {string} password
   */
  const login = async (email, password) => {
    setError(null);
    setActionLoading(true);
    try {
      const userCredential = await loginWithEmail(email, password);
      return userCredential.user;
    } catch (err) {
      const formatted = formatAuthError(err);
      setError(formatted);
      throw new Error(formatted);
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Log out the active user
   */
  const logout = async () => {
    setError(null);
    setActionLoading(true);
    try {
      try {
        sessionStorage.removeItem('orvix_guest_session');
        sessionStorage.removeItem('chatora_guest_session');
      } catch (_) {}
      await authLogout();
      setCurrentUser(null);
    } catch (err) {
      const formatted = formatAuthError(err);
      setError(formatted);
      throw new Error(formatted);
    } finally {
      setActionLoading(false);
    }
  };

  const value = {
    currentUser,
    initialLoading,
    actionLoading,
    error,
    clearError,
    signup,
    login,
    logout,
    continueAsGuest,
    isConfigured
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
