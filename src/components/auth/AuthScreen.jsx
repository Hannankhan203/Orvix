import React, { useState, useEffect } from 'react';
import { Bot, Mail, Lock, Eye, EyeOff, AlertCircle, Sparkles, User, WifiOff } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import Button from '../ui/Button.jsx';
import OrvixLogo from '../ui/OrvixLogo.jsx';
import { APP_CONFIG } from '../../config/appConfig.js';
import { USERNAME_CONSTRAINTS } from '../../services/userProfileService.js';
import { isBrowserOnline, subscribeToNetworkStatus } from '../../config/firebaseConfig.js';

/**
 * AuthScreen Component
 * Authentication view providing Email/Password signup with required Username,
 * existing user login, and guest demo mode.
 */
export default function AuthScreen() {
  const { login, signup, actionLoading, error, clearError, isConfigured, continueAsGuest } = useAuth();

  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localValidation, setLocalValidation] = useState('');
  const [isOffline, setIsOffline] = useState(() => !isBrowserOnline());

  useEffect(() => {
    return subscribeToNetworkStatus((online) => {
      setIsOffline(!online);
    });
  }, []);

  const switchMode = (newMode) => {
    setMode(newMode);
    clearError();
    setLocalValidation('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalValidation('');
    clearError();

    if (isOffline) {
      setLocalValidation('Cloud sign-in requires an internet connection. Use Continue as Guest below to chat offline with Browser AI (WebLLM).');
      return;
    }

    // Sign-up specific validations: Username
    if (mode === 'signup') {
      const trimmedUsername = username.trim();
      if (!trimmedUsername) {
        setLocalValidation('Please enter a username.');
        return;
      }

      if (trimmedUsername.length < USERNAME_CONSTRAINTS.MIN_LENGTH) {
        setLocalValidation(`Username must be at least ${USERNAME_CONSTRAINTS.MIN_LENGTH} characters long.`);
        return;
      }

      if (trimmedUsername.length > USERNAME_CONSTRAINTS.MAX_LENGTH) {
        setLocalValidation(`Username cannot exceed ${USERNAME_CONSTRAINTS.MAX_LENGTH} characters.`);
        return;
      }

      if (!USERNAME_CONSTRAINTS.PATTERN.test(trimmedUsername)) {
        setLocalValidation('Username can only contain letters, numbers, spaces, hyphens, underscores, and periods.');
        return;
      }
    }

    // Common validations: Email & Password
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setLocalValidation('Please enter your email address.');
      return;
    }

    if (!trimmedEmail.includes('@') || !trimmedEmail.includes('.')) {
      setLocalValidation('Please provide a valid email address.');
      return;
    }

    if (!password) {
      setLocalValidation('Please enter your password.');
      return;
    }

    if (password.length < 6) {
      setLocalValidation('Password must be at least 6 characters long.');
      return;
    }

    try {
      if (mode === 'signup') {
        await signup(trimmedEmail, password, username.trim());
      } else {
        await login(trimmedEmail, password);
      }
    } catch (_) {
      // Error handled by AuthContext and displayed in the alert box
    }
  };

  const displayedError = localValidation || error;

  return (
    <div className="auth-screen-container">
      <div className="auth-content-wrap">
        {/* Brand Header */}
        <header className="auth-brand-header">
          <div className="auth-logo-badge" aria-hidden="true">
            <OrvixLogo size={42} />
          </div>
          <span className="auth-brand-kicker">{APP_CONFIG.name}</span>
          <h1 className="auth-brand-title">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="auth-brand-subtitle">
            {mode === 'login'
              ? 'Sign in to access your intelligent chat workspace'
              : 'Get started with fast multimodal AI conversations'}
          </p>
        </header>

        {/* Offline Notice */}
        {isOffline && (
          <div className="auth-notice-card" role="status">
            <div className="notice-icon">
              <WifiOff size={16} />
            </div>
            <div className="notice-content">
              <strong>Offline Mode</strong>
              <p>
                Cloud authentication requires an internet connection. Click <strong>Continue as Guest</strong> below to use Browser AI (WebLLM) with local chat storage.
              </p>
            </div>
          </div>
        )}

        {/* Configuration Notice (if Firebase environment variables are not set) */}
        {!isConfigured && !isOffline && (
          <div className="auth-notice-card" role="status">
            <div className="notice-icon">
              <AlertCircle size={16} />
            </div>
            <div className="notice-content">
              <strong>Guest / Demo Mode Ready</strong>
              <p>
                Firebase is not configured in this environment. Click <strong>Continue as Guest</strong> below to explore and use the app immediately!
              </p>
            </div>
          </div>
        )}

        {/* Mode Selector Tabs */}
        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => switchMode('login')}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className={`auth-tab ${mode === 'signup' ? 'active' : ''}`}
            onClick={() => switchMode('signup')}
          >
            Create Account
          </button>
        </div>

        {/* Error Alert Box */}
        {displayedError && (
          <div className="auth-error-alert" role="alert">
            <AlertCircle size={16} className="error-alert-icon" />
            <span className="error-alert-text">{displayedError}</span>
          </div>
        )}

        {/* Authentication Form */}
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {/* Username Input (Only for Sign Up) */}
          {mode === 'signup' && (
            <div className="form-group">
              <div className="form-label-row">
                <label htmlFor="auth-username" className="form-label">
                  Username
                </label>
                <span className="form-hint">2-30 characters</span>
              </div>
              <div className="form-input-wrapper">
                <User size={16} className="input-adornment-icon" aria-hidden="true" />
                <input
                  id="auth-username"
                  type="text"
                  className="form-input"
                  placeholder="e.g. John Doe"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="nickname"
                  disabled={actionLoading}
                  required
                  maxLength={30}
                />
              </div>
            </div>
          )}

          {/* Email Input */}
          <div className="form-group">
            <label htmlFor="auth-email" className="form-label">
              Email Address
            </label>
            <div className="form-input-wrapper">
              <Mail size={16} className="input-adornment-icon" aria-hidden="true" />
              <input
                id="auth-email"
                type="email"
                className="form-input"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                disabled={actionLoading}
                required
              />
            </div>
          </div>

          {/* Password Input */}
          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="auth-password" className="form-label">
                Password
              </label>
              {mode === 'signup' && (
                <span className="form-hint">Min 6 characters</span>
              )}
            </div>
            <div className="form-input-wrapper">
              <Lock size={16} className="input-adornment-icon" aria-hidden="true" />
              <input
                id="auth-password"
                type={showPassword ? 'text' : 'password'}
                className="form-input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                disabled={actionLoading}
                required
              />
              <button
                type="button"
                className="input-toggle-btn"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {/* Submit Action */}
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={actionLoading || !isConfigured}
            className="auth-submit-btn"
          >
            {actionLoading ? (
              <span className="auth-btn-loading">
                <span className="auth-spinner" aria-hidden="true" />
                {mode === 'login' ? 'Signing in...' : 'Creating account...'}
              </span>
            ) : mode === 'login' ? (
              'Sign In'
            ) : (
              'Create Account'
            )}
          </Button>
        </form>

        {/* Subtle Divider */}
        <div className="auth-divider" role="separator" aria-label="Alternative sign-in method">
          <span className="auth-divider-line" />
          <span className="auth-divider-text">or</span>
          <span className="auth-divider-line" />
        </div>

        {/* Guest Mode Alternative */}
        <div className="auth-guest-section">
          <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={() => continueAsGuest()}
            className="auth-guest-btn w-full"
            icon={<Sparkles size={16} />}
          >
            Continue as Guest (Demo Mode)
          </Button>
        </div>

        {/* Footer Switcher */}
        <footer className="auth-footer">
          {mode === 'login' ? (
            <p>
              Don't have an account?{' '}
              <button
                type="button"
                className="auth-link-btn"
                onClick={() => switchMode('signup')}
              >
                Sign up
              </button>
            </p>
          ) : (
            <p>
              Already have an account?{' '}
              <button
                type="button"
                className="auth-link-btn"
                onClick={() => switchMode('login')}
              >
                Sign in
              </button>
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
