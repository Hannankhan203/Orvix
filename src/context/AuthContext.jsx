import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
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
import { getCachedUserProfile } from '../services/userProfileService.js';
import { isFirebaseConfigured, isBrowserOnline } from '../config/firebaseConfig.js';

const AuthContext = createContext(null);

function readStoredGuestSession() {
  try {
    const raw =
      (typeof sessionStorage !== 'undefined' &&
        (sessionStorage.getItem('orvix_guest_session') ||
          sessionStorage.getItem('chatora_guest_session'))) ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('orvix_guest_session')) ||
      null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.uid) {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeStoredGuestSession(guestUser) {
  const serialized = JSON.stringify(guestUser);
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('orvix_guest_session', serialized);
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('orvix_guest_session', serialized);
    }
  } catch (_) {}
}

function clearStoredGuestSession() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('orvix_guest_session');
      sessionStorage.removeItem('chatora_guest_session');
    }
  } catch (_) {}
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('orvix_guest_session');
    }
  } catch (_) {}
}

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
export function AuthProvider({ children, authDeps = null }) {
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);

  const depsRef = useRef(null);
  depsRef.current = {
    signupWithEmail,
    loginWithEmail,
    logout: authLogout,
    onAuthChange,
    getUserProfile,
    saveUserProfile,
    isFirebaseConfigured,
    isBrowserOnline,
    ...authDeps
  };

  const isMountedRef = useRef(true);
  const isGuestSessionActiveRef = useRef(false);
  const activeUserUidRef = useRef(null);
  const profileMutationSeqRef = useRef(0);

  const isConfigured = depsRef.current.isFirebaseConfigured();

  // Load Firestore profile for an authenticated Firebase user (hydrating local cache first)
  const loadProfileForUser = async (user) => {
    if (!user || user.isAnonymous) {
      return null;
    }

    const targetUid = user.uid;
    const startMutationSeq = profileMutationSeqRef.current;

    const canApplyProfileUpdate = () =>
      isMountedRef.current &&
      !isGuestSessionActiveRef.current &&
      activeUserUidRef.current === targetUid &&
      profileMutationSeqRef.current === startMutationSeq;

    const cachedProfile = getCachedUserProfile(targetUid);
    if (cachedProfile && cachedProfile.username) {
      if (canApplyProfileUpdate()) {
        setUserProfile(cachedProfile);
      }
    } else if (user.displayName) {
      if (canApplyProfileUpdate()) {
        setUserProfile({
          uid: targetUid,
          username: user.displayName,
          email: user.email || ''
        });
      }
    }

    try {
      const profile = await depsRef.current.getUserProfile(targetUid);
      if (!canApplyProfileUpdate()) {
        return null;
      }

      if (profile && profile.username) {
        setUserProfile(profile);
        return profile;
      } else if (user.displayName) {
        // Fallback to Firebase Auth displayName if Firestore doc not yet created
        const fallbackProfile = {
          uid: targetUid,
          username: user.displayName,
          email: user.email || ''
        };
        setUserProfile(fallbackProfile);
        return fallbackProfile;
      } else {
        // User has no username set yet
        const emptyProfile = {
          uid: targetUid,
          username: '',
          email: user.email || ''
        };
        setUserProfile(emptyProfile);
        return emptyProfile;
      }
    } catch (err) {
      console.warn('Could not load user profile on auth change:', err);
      return cachedProfile || null;
    }
  };

  // Subscribe to Firebase Auth state listener and clean up on unmount
  useEffect(() => {
    isMountedRef.current = true;
    let isEffectActive = true;
    let resolved = false;

    const finishInitialLoading = () => {
      if (!isEffectActive) return;
      if (!resolved) {
        resolved = true;
        setInitialLoading(false);
      }
    };

    // Check if guest mode session was active (sessionStorage or localStorage for offline reload continuity).
    // Even when restoring a guest session, do NOT return early before subscribing to onAuthChange(),
    // otherwise logging out of Guest Mode and authenticating with Firebase leaves currentUser un-updated.
    const savedGuest = readStoredGuestSession();
    if (savedGuest) {
      isGuestSessionActiveRef.current = true;
      activeUserUidRef.current = savedGuest.uid;
      profileMutationSeqRef.current += 1;
      setCurrentUser(savedGuest);
      setUserProfile({
        uid: savedGuest.uid,
        username: savedGuest.username || savedGuest.displayName || 'Guest Explorer',
        email: savedGuest.email || 'guest@orvix.ai'
      });
      finishInitialLoading();
    }

    // Safety guard: never hang on splash screen if Firebase Auth token refresh stalls while offline
    const fallbackTimer = resolved
      ? null
      : setTimeout(
          finishInitialLoading,
          depsRef.current.isBrowserOnline() ? 4500 : 1200
        );

    const unsubscribe = depsRef.current.onAuthChange((user) => {
      if (!isEffectActive) return;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }

      if (user) {
        const isUserChanged = activeUserUidRef.current !== user.uid;
        isGuestSessionActiveRef.current = false;
        clearStoredGuestSession();
        activeUserUidRef.current = user.uid;
        if (isUserChanged) {
          profileMutationSeqRef.current += 1;
        }
        setCurrentUser(user);
        finishInitialLoading();
        void loadProfileForUser(user);
      } else {
        // Preserve active Guest Mode session when Firebase reports no signed-in user
        if (isGuestSessionActiveRef.current) {
          finishInitialLoading();
          return;
        }
        activeUserUidRef.current = null;
        profileMutationSeqRef.current += 1;
        setCurrentUser(null);
        setUserProfile(null);
        finishInitialLoading();
      }
    });

    return () => {
      isEffectActive = false;
      isMountedRef.current = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
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

    isGuestSessionActiveRef.current = true;
    activeUserUidRef.current = guestUser.uid;
    profileMutationSeqRef.current += 1;
    setCurrentUser(guestUser);
    setUserProfile({
      uid: guestUser.uid,
      username: cleanName,
      email: guestUser.email
    });

    writeStoredGuestSession(guestUser);
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
      const userCredential = await depsRef.current.signupWithEmail(email, password);
      const user = userCredential.user;

      isGuestSessionActiveRef.current = false;
      clearStoredGuestSession();
      activeUserUidRef.current = user.uid;
      if (isMountedRef.current) {
        setCurrentUser(user);
      }

      // Persist username to Firestore user profile & sync with Firebase Auth
      await depsRef.current.saveUserProfile(user.uid, {
        username: validation.sanitized,
        email: email.trim()
      });

      profileMutationSeqRef.current += 1;
      if (isMountedRef.current && activeUserUidRef.current === user.uid) {
        setUserProfile({
          uid: user.uid,
          username: validation.sanitized,
          email: email.trim()
        });
      }

      return user;
    } catch (err) {
      const formatted = formatAuthError(err);
      if (isMountedRef.current) {
        setError(formatted);
      }
      throw new Error(formatted);
    } finally {
      if (isMountedRef.current) {
        setActionLoading(false);
      }
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
      const userCredential = await depsRef.current.loginWithEmail(email, password);
      const user = userCredential.user;
      const isUserChanged = activeUserUidRef.current !== user.uid;
      isGuestSessionActiveRef.current = false;
      clearStoredGuestSession();
      activeUserUidRef.current = user.uid;
      if (isUserChanged) {
        profileMutationSeqRef.current += 1;
      }
      if (isMountedRef.current) {
        setCurrentUser(user);
      }
      await loadProfileForUser(user);
      return user;
    } catch (err) {
      const formatted = formatAuthError(err);
      if (isMountedRef.current) {
        setError(formatted);
      }
      throw new Error(formatted);
    } finally {
      if (isMountedRef.current) {
        setActionLoading(false);
      }
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
      profileMutationSeqRef.current += 1;
      setCurrentUser(updatedGuest);
      setUserProfile({
        uid: currentUser.uid,
        username: sanitized,
        email: currentUser.email || 'guest@orvix.ai'
      });
      writeStoredGuestSession(updatedGuest);
      return;
    }

    if (!currentUser?.uid) {
      throw new Error('No active user session to update.');
    }

    setActionLoading(true);
    try {
      await depsRef.current.saveUserProfile(currentUser.uid, {
        username: sanitized,
        email: currentUser.email || ''
      });

      profileMutationSeqRef.current += 1;
      if (isMountedRef.current && activeUserUidRef.current === currentUser.uid) {
        setUserProfile({
          uid: currentUser.uid,
          username: sanitized,
          email: currentUser.email || ''
        });

        // Update local displayName representation
        setCurrentUser((prev) => (prev ? { ...prev, displayName: sanitized } : prev));
      }
    } catch (err) {
      console.error('Failed to update username:', err);
      throw err;
    } finally {
      if (isMountedRef.current) {
        setActionLoading(false);
      }
    }
  };

  /**
   * Log out the active user
   */
  const logout = async () => {
    setError(null);
    setActionLoading(true);
    try {
      isGuestSessionActiveRef.current = false;
      activeUserUidRef.current = null;
      profileMutationSeqRef.current += 1;
      clearStoredGuestSession();
      try {
        await depsRef.current.logout();
      } catch (logoutErr) {
        // Allow sign-out to clear local state even if offline
        console.warn('Auth logout notice:', logoutErr);
      }
      if (isMountedRef.current && !isGuestSessionActiveRef.current && !activeUserUidRef.current) {
        setCurrentUser(null);
        setUserProfile(null);
      }
    } catch (err) {
      const formatted = formatAuthError(err);
      if (isMountedRef.current) {
        setError(formatted);
      }
      throw new Error(formatted);
    } finally {
      if (isMountedRef.current) {
        setActionLoading(false);
      }
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
