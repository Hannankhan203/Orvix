import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  signupWithEmail,
  loginWithEmail,
  logout as authLogout,
  onAuthChange,
  formatAuthError,
  getUserProfile,
  saveUserProfile,
  validateUsername
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
 * Manages authenticated user state, Firestore user profile persistence,
 * username validation/editing, and guest demo sessions.
 */
export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);

  const isConfigured = isFirebaseConfigured();

  // Load Firestore profile for an authenticated Firebase user
  const loadProfileForUser = async (user) => {
    if (!user || user.isAnonymous) {
      return null;
    }

    try {
      const profile = await getUserProfile(user.uid);
      if (profile && profile.username) {
        setUserProfile(profile);
        return profile;
      } else if (user.displayName) {
        // Fallback to Firebase Auth displayName if Firestore doc not yet created
        const fallbackProfile = {
          uid: user.uid,
          username: user.displayName,
          email: user.email || ''
        };
        setUserProfile(fallbackProfile);
        return fallbackProfile;
      } else {
        // User has no username set yet
        const emptyProfile = {
          uid: user.uid,
          username: '',
          email: user.email || ''
        };
        setUserProfile(emptyProfile);
        return emptyProfile;
      }
    } catch (err) {
      console.warn('Could not load user profile on auth change:', err);
      return null;
    }
  };

  // Subscribe to Firebase Auth state listener and clean up on unmount
  useEffect(() => {
    // Check if guest mode session was active
    try {
      const savedGuest =
        sessionStorage.getItem('orvix_guest_session') ||
        sessionStorage.getItem('chatora_guest_session');
      if (savedGuest) {
        const parsedGuest = JSON.parse(savedGuest);
        setCurrentUser(parsedGuest);
        setUserProfile({
          uid: parsedGuest.uid,
          username: parsedGuest.username || parsedGuest.displayName || 'Guest Explorer',
          email: parsedGuest.email || 'guest@orvix.ai'
        });
        setInitialLoading(false);
        return;
      }
    } catch (_) {}

    const unsubscribe = onAuthChange(async (user) => {
      if (user) {
        try {
          sessionStorage.removeItem('orvix_guest_session');
          sessionStorage.removeItem('chatora_guest_session');
        } catch (_) {}
        setCurrentUser(user);
        await loadProfileForUser(user);
      } else {
        setCurrentUser(null);
        setUserProfile(null);
      }
      setInitialLoading(false);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const clearError = () => setError(null);

  /**
   * Enter guest / demo mode without requiring Firebase credentials
   * @param {string} [preferredName] - Optional preferred name for guest exploration
   */
  const continueAsGuest = (preferredName = null) => {
    const cleanName =
      typeof preferredName === 'string' && preferredName.trim()
        ? preferredName.trim().slice(0, 30)
        : 'Guest Explorer';

    const guestUser = {
      uid: 'guest-' + Math.random().toString(36).substring(2, 9),
      email: 'guest@orvix.ai',
      displayName: cleanName,
      username: cleanName,
      isAnonymous: true
    };

    setCurrentUser(guestUser);
    setUserProfile({
      uid: guestUser.uid,
      username: cleanName,
      email: guestUser.email
    });

    try {
      sessionStorage.setItem('chatora_guest_session', JSON.stringify(guestUser));
      sessionStorage.setItem('orvix_guest_session', JSON.stringify(guestUser));
    } catch (_) {}
  };

  /**
   * Register a new user with required username, email, and password
   * @param {string} email
   * @param {string} password
   * @param {string} username
   */
  const signup = async (email, password, username) => {
    setError(null);
    setActionLoading(true);

    const validation = validateUsername(username);
    if (!validation.isValid) {
      setError(validation.error);
      setActionLoading(false);
      throw new Error(validation.error);
    }

    try {
      const userCredential = await signupWithEmail(email, password);
      const user = userCredential.user;

      // Persist username to Firestore user profile & sync with Firebase Auth
      await saveUserProfile(user.uid, {
        username: validation.sanitized,
        email: email.trim()
      });

      setUserProfile({
        uid: user.uid,
        username: validation.sanitized,
        email: email.trim()
      });

      return user;
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
      const user = userCredential.user;
      await loadProfileForUser(user);
      return user;
    } catch (err) {
      const formatted = formatAuthError(err);
      setError(formatted);
      throw new Error(formatted);
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Updates the username for either an authenticated user (persisted to Firestore)
   * or a guest session (persisted to session storage).
   * @param {string} newUsername
   */
  const updateUsername = async (newUsername) => {
    const validation = validateUsername(newUsername);
    if (!validation.isValid) {
      throw new Error(validation.error);
    }

    const sanitized = validation.sanitized;

    if (currentUser?.isAnonymous) {
      // Guest mode session update
      const updatedGuest = {
        ...currentUser,
        displayName: sanitized,
        username: sanitized
      };
      setCurrentUser(updatedGuest);
      setUserProfile({
        uid: currentUser.uid,
        username: sanitized,
        email: currentUser.email || 'guest@orvix.ai'
      });
      try {
        sessionStorage.setItem('chatora_guest_session', JSON.stringify(updatedGuest));
        sessionStorage.setItem('orvix_guest_session', JSON.stringify(updatedGuest));
      } catch (_) {}
      return;
    }

    if (!currentUser?.uid) {
      throw new Error('No active user session to update.');
    }

    setActionLoading(true);
    try {
      await saveUserProfile(currentUser.uid, {
        username: sanitized,
        email: currentUser.email || ''
      });

      setUserProfile({
        uid: currentUser.uid,
        username: sanitized,
        email: currentUser.email || ''
      });

      // Update local displayName representation
      setCurrentUser((prev) => (prev ? { ...prev, displayName: sanitized } : prev));
    } catch (err) {
      console.error('Failed to update username:', err);
      throw err;
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
      setUserProfile(null);
    } catch (err) {
      const formatted = formatAuthError(err);
      setError(formatted);
      throw new Error(formatted);
    } finally {
      setActionLoading(false);
    }
  };

  // Resolved preferred username
  const effectiveUsername =
    userProfile?.username ||
    currentUser?.displayName ||
    (currentUser?.isAnonymous ? currentUser?.username || 'Guest Explorer' : '') ||
    '';

  const value = {
    currentUser,
    userProfile,
    username: effectiveUsername,
    updateUsername,
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
