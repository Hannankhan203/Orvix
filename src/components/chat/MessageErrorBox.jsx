import React from 'react';
import { AlertCircle, RotateCcw, Cpu, Edit3, Paperclip } from 'lucide-react';
import Button from '../ui/Button.jsx';
import AttachmentCard from './AttachmentCard.jsx';

/**
 * Generates a clean, user-friendly title for the error banner based on error text
 */
export function getErrorTitle(content = '', providerId = '', errorCode = '') {
  const text = String(content || '').toLowerCase();
  const normalizedCode = String(errorCode || '').toUpperCase();
  const normalizedProvider = String(providerId || '').toLowerCase();
  const isWebLLM = normalizedProvider === 'webllm';

  if (
    normalizedCode === 'PROVIDER_NOT_CONFIGURED' ||
    text.includes('not configured on this server')
  ) {
    return 'Provider Not Configured';
  }
  if (
    normalizedCode === 'INVALID_MODEL' ||
    (text.includes('model identifier') && text.includes('not valid'))
  ) {
    return 'Invalid Model Identifier';
  }
  if (
    normalizedCode === 'DEADLINE_EXCEEDED' ||
    text.includes('timed out waiting for') ||
    text.includes('timed out')
  ) {
    return 'Provider Request Timed Out';
  }
  if (isWebLLM || text.includes('webgpu') || text.includes('browser ai')) {
    if (text.includes('webgpu') || text.includes('adapter') || text.includes('secure context') || text.includes('shader-f16')) {
      return 'Browser Compatibility Issue';
    }
    if (text.includes('not been downloaded') || text.includes('not cached') || text.includes('connect to the internet once')) {
      return 'Model Not Cached Offline';
    }
    if (text.includes('storage') || text.includes('quota')) {
      return 'Insufficient Browser Storage';
    }
    if (text.includes('gpu memory') || text.includes('out of memory') || text.includes('device was lost')) {
      return 'GPU Memory Limit Reached';
    }
    if (text.includes('interrupted while downloading') || text.includes('downloading')) {
      return 'Model Download Interrupted';
    }
    return 'Browser AI Error';
  }
  if (text.includes('rate limit') || text.includes('quota') || text.includes('429') || text.includes('resource_exhausted')) {
    return 'Rate Limit or Quota Exceeded';
  }
  if (text.includes('not found') || text.includes('does not exist') || text.includes('decommissioned') || text.includes('retired')) {
    return 'Model Unavailable';
  }
  if (text.includes('high demand') || text.includes('503') || text.includes('spikes in demand') || text.includes('overloaded') || text.includes('unavailable')) {
    return 'Service Temporarily Busy';
  }
  if (text.includes('auth') || text.includes('permission') || text.includes('api key') || text.includes('401') || text.includes('403')) {
    return 'Authentication or Permission Issue';
  }
  if (text.includes('internal error') || text.includes('500') || text.includes('service error')) {
    return 'AI Provider Service Error';
  }
  if (text.includes('network') || text.includes('fetch') || text.includes('connection') || text.includes('offline')) {
    return 'Network Connection Error';
  }
  return 'Request Failed';
}

/**
 * MessageErrorBox Component
 * Handles rendering the error notification box, referenced attachments, and retry/switch actions.
 */
export default function MessageErrorBox({
  message,
  currentProviderId,
  currentProviderObj,
  fallbackProviders = [],
  onRetry,
  onSwitchProvider,
  onRestorePrompt
}) {
  return (
    <div className="error-message-box" role="alert" aria-live="assertive">
      <div className="error-message-header">
        <div className="error-header-title-wrap">
          <span className="error-icon-badge" aria-hidden="true">
            <AlertCircle size={14} />
          </span>
          <span className="error-header-title">
            {getErrorTitle(message.content, currentProviderId, message.errorCode)}
          </span>
        </div>
        {currentProviderObj?.name && (
          <span className="error-provider-tag" title={`Request failed on ${currentProviderObj.name}`}>
            {currentProviderObj.name}
          </span>
        )}
      </div>

      {message.referencedAttachments && message.referencedAttachments.length > 0 && (
        <div className="assistant-referenced-attachments error-referenced-attachments" aria-label="Referenced files">
          <div className="referenced-attachments-header">
            <Paperclip size={11} className="referenced-icon" />
            <span>Referenced file{message.referencedAttachments.length > 1 ? 's' : ''}:</span>
          </div>
          <div className="referenced-attachments-list">
            {message.referencedAttachments.map((att, idx) => (
              <AttachmentCard key={att.id || idx} attachment={att} compact={true} />
            ))}
          </div>
        </div>
      )}

      <div className="error-message-body">
        <p className="error-text">{message.content || 'An error occurred while communicating with the AI service.'}</p>
      </div>

      <div className="error-actions" role="group" aria-label="Error recovery options">
        {onRetry && message.errorCode !== 'PROVIDER_NOT_CONFIGURED' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRetry(message)}
            icon={<RotateCcw size={13} />}
            title={`Retry this request with ${currentProviderObj.name}`}
            className="error-action-btn error-retry-btn"
          >
            Retry with {currentProviderObj.name}
          </Button>
        )}
        {onSwitchProvider &&
          message.canSwitchProvider !== false &&
          currentProviderId !== 'webllm' &&
          fallbackProviders.map((p) => (
            <Button
              key={p.id}
              variant="secondary"
              size="sm"
              onClick={() => onSwitchProvider(message, p.id)}
              icon={<Cpu size={13} />}
              title={`Switch to ${p.name} and send prompt`}
              className="fallback-provider-btn error-action-btn error-fallback-btn"
            >
              Try with {p.name}
            </Button>
          ))}
        {onRestorePrompt && message.failedPrompt && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRestorePrompt(message.failedPrompt)}
            icon={<Edit3 size={13} />}
            title="Restore prompt into composer"
            className="error-action-btn error-restore-btn"
          >
            Edit prompt
          </Button>
        )}
      </div>
    </div>
  );
}
